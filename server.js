require('dotenv').config();

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');

// ── Dependencias de auth ──────────────────────────────────
let bcrypt;
try { bcrypt = require('bcrypt'); } catch(e) {
  console.error('❌ Falta instalar bcrypt: npm install bcrypt');
  process.exit(1);
}

// ── Config ────────────────────────────────────────────────
const PORT    = process.env.PORT          || 3000;
const API_HOST = 'www.infosubvenciones.es';
const SB_HOST  = process.env.SUPABASE_HOST;
const SB_KEY   = process.env.SUPABASE_KEY;

if (!SB_HOST || !SB_KEY) {
  console.error('❌ Faltan SUPABASE_HOST y SUPABASE_KEY en el entorno / .env');
  process.exit(1);
}

// ── Token store en memoria: token → { id, usuario, rol, exp } ──
const tokens  = new Map();
const TOKEN_TTL = 1000 * 60 * 60 * 8; // 8 h

function genToken() {
  return require('crypto').randomBytes(32).toString('hex');
}

// ── Supabase REST helper ──────────────────────────────────
function supabase(method, table, opts = {}) {
  return new Promise((resolve, reject) => {
    let qs = '';
    if (opts.filter) qs += (qs ? '&' : '?') + opts.filter;
    if (opts.select) qs += (qs ? '&' : '?') + 'select=' + opts.select;

    const reqPath = `/rest/v1/${table}${qs}`;
    const bodyStr = opts.body ? JSON.stringify(opts.body) : null;

    const headers = {
      'apikey':        SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY,
      'Content-Type':  'application/json',
      'Prefer':        'return=representation',
    };
    if (opts.single) headers['Accept'] = 'application/vnd.pgrst.object+json';

    const req = https.request({ hostname: SB_HOST, path: reqPath, method, headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null }); }
        catch(e) { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}


// ── Supabase Storage helper ───────────────────────────────
function supabaseStorage(method, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const reqPath = `/storage/v1/object/${path}`;
    const headers = {
      'apikey':        SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY,
    };
    if (opts.contentType) headers['Content-Type'] = opts.contentType;
    if (opts.upsert)      headers['x-upsert'] = 'true';

    const options = { hostname: SB_HOST, path: reqPath, method, headers };
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        try { resolve({ status: res.statusCode, data: JSON.parse(buf.toString()) }); }
        catch(e) { resolve({ status: res.statusCode, data: buf }); }
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function supabaseStorageSignedUrl(storagePath, expiresIn = 3600) {
  return new Promise((resolve, reject) => {
    const reqPath = `/storage/v1/object/sign/${storagePath}`;
    const body    = JSON.stringify({ expiresIn });
    const headers = {
      'apikey':        SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY,
      'Content-Type':  'application/json',
    };
    const req = https.request({ hostname: SB_HOST, path: reqPath, method: 'POST', headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.signedURL || parsed.signedUrl || null);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Multipart parser (para subida de archivos) ────────────
function parseMultipart(buffer, boundary) {
  const sep    = Buffer.from('--' + boundary);
  const sepEnd = Buffer.from('--' + boundary + '--');
  const parts  = [];
  let pos = 0;

  while (pos < buffer.length) {
    const start = bufIndexOf(buffer, sep, pos);
    if (start === -1) break;
    pos = start + sep.length + 2; // skip \r\n
    if (buffer.slice(start, start + sepEnd.length).equals(sepEnd)) break;

    // Headers de la parte
    const headEnd = bufIndexOf(buffer, Buffer.from('\r\n\r\n'), pos);
    if (headEnd === -1) break;
    const headStr = buffer.slice(pos, headEnd).toString();
    pos = headEnd + 4;

    // Body de la parte (hasta el siguiente sep)
    const nextSep = bufIndexOf(buffer, sep, pos);
    const bodyEnd = nextSep === -1 ? buffer.length : nextSep - 2; // -2 for \r\n
    const body    = buffer.slice(pos, bodyEnd);
    pos = nextSep === -1 ? buffer.length : nextSep;

    // Parsear headers
    const part = { headers: {}, body };
    headStr.split('\r\n').forEach(line => {
      const idx = line.indexOf(':');
      if (idx > -1) part.headers[line.slice(0, idx).toLowerCase().trim()] = line.slice(idx + 1).trim();
    });
    // Extraer name y filename del Content-Disposition
    const cd = part.headers['content-disposition'] || '';
    const nameMatch     = cd.match(/name="([^"]+)"/);
    const filenameMatch = cd.match(/filename="([^"]+)"/);
    if (nameMatch)     part.name     = nameMatch[1];
    if (filenameMatch) part.filename = filenameMatch[1];
    part.contentType = part.headers['content-type'] || 'application/octet-stream';
    parts.push(part);
  }
  return parts;
}

function bufIndexOf(buf, search, start = 0) {
  for (let i = start; i <= buf.length - search.length; i++) {
    let found = true;
    for (let j = 0; j < search.length; j++) {
      if (buf[i + j] !== search[j]) { found = false; break; }
    }
    if (found) return i;
  }
  return -1;
}

function readBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── Helpers HTTP ──────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
};

function sendJSON(res, code, obj) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch(e) { resolve({}); } });
    req.on('error', reject);
  });
}

// ── Auth middleware ───────────────────────────────────────
function getSession(req) {
  const token = (req.headers['x-token'] || '').trim();
  if (!token) return null;
  const s = tokens.get(token);
  if (!s) return null;
  if (Date.now() > s.exp) { tokens.delete(token); return null; }
  return s;
}
function requireAuth(req, res) {
  const s = getSession(req);
  if (!s) { sendJSON(res, 401, { error: 'No autenticado' }); return null; }
  return s;
}
function requireAdmin(req, res) {
  const s = requireAuth(req, res);
  if (!s) return null;
  if (s.rol !== 'admin') { sendJSON(res, 403, { error: 'Solo administradores' }); return null; }
  return s;
}

// ── Proxy helper (infosubvenciones) ──────────────────────
function proxyGet(apiPath) {
  const options = {
    hostname: API_HOST, path: apiPath, method: 'GET',
    headers: {
      'Host': API_HOST,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'es-ES,es;q=0.9', 'Accept-Encoding': 'identity',
      'Referer': `https://${API_HOST}/bdnstrans/GE/es/convocatorias`,
      'Origin': `https://${API_HOST}`, 'Connection': 'keep-alive',
    }
  };
  console.log(`[PROXY GET] ${apiPath}`);
  return new Promise((resolve, reject) => {
    const req = https.request(options, apiRes => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        console.log(`[RESP] status=${apiRes.statusCode} len=${data.length} preview=${data.slice(0,120)}`);
        resolve({ statusCode: apiRes.statusCode, data });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html,*/*', 'Accept-Language': 'es-ES,es;q=0.9', 'Accept-Encoding': 'identity' }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, data }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Scrapers con caché ────────────────────────────────────
let poctepCache = null, poctepCacheTime = 0;
let socialCache = null, socialCacheTime = 0;
const CACHE_TTL = 1000 * 60 * 60;

async function scrapePoctep() {
  if (poctepCache && Date.now() - poctepCacheTime < CACHE_TTL) return poctepCache;
  console.log('[POCTEP] Descargando...');
  const { data: html } = await fetchUrl('https://www.poctep.eu/convocatorias/');
  const convocatorias = [];
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
  if (!tableMatch) throw new Error('No se encontró tabla en POCTEP');
  const rows = tableMatch[0].match(/<tr[\s\S]*?<\/tr>/gi) || [];
  rows.forEach((row, i) => {
    if (i === 0) return;
    const cells = []; let m;
    const re = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    while ((m = re.exec(row)) !== null) cells.push(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (cells.length < 4 || !cells[0]) return;
    const titulo = cells[0], abierta = cells[3] || '';
    let estado = 'desconocido';
    if (titulo.toUpperCase().includes('CERRADA')) estado = 'cerrada';
    else if (abierta.toLowerCase().includes('pendiente')) estado = 'proxima';
    else if (abierta) estado = 'abierta';
    convocatorias.push({ fuente:'POCTEP', titulo:titulo.replace(/\(CERRADA\)|\(ABIERTA\)/gi,'').trim(), prioridad:cells[1]||'', fse:cells[2]||'', fechaApertura:abierta, fechaCierre:cells[4]||'', resolucion:cells[5]||'', estado, url:'https://www.poctep.eu/convocatorias/' });
  });
  poctepCache = convocatorias; poctepCacheTime = Date.now();
  return convocatorias;
}

async function scrapeSocialPower() {
  if (socialCache && Date.now() - socialCacheTime < CACHE_TTL) return socialCache;
  console.log('[SOCIALPOWER] Descargando...');
  const { data: html } = await fetchUrl('https://socialpower.es/es/solicita-financiacion');
  const lineas = html.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,'\n').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/\n{3,}/g,'\n\n').trim().split('\n').map(l=>l.trim()).filter(Boolean);
  const convocatorias = [];
  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i].toLowerCase();
    if (!['cerrada','próximamente','abierta'].includes(linea)) continue;
    let titulo='', fechaApertura='', fechaCierre='', fechasTexto='';
    for (let j=i+1; j<Math.min(i+5,lineas.length); j++) {
      if (/convocatoria\s+\d+/i.test(lineas[j])) {
        titulo=lineas[j];
        for (let k=j+1; k<Math.min(j+4,lineas.length); k++) {
          if (/del?\s+\d/i.test(lineas[k])) { fechasTexto=lineas[k]; const fm=lineas[k].match(/Del?\s+(.+?)\s+al\s+(.+)/i); if(fm){fechaApertura=fm[1].trim();fechaCierre=fm[2].trim();} break; }
        }
        break;
      }
    }
    if (!titulo) continue;
    let estado = linea==='cerrada'?'cerrada':linea==='abierta'?'abierta':'proxima';
    convocatorias.push({ fuente:'SocialPower', titulo, fechaApertura, fechaCierre, fechasTexto, estado, url:'https://socialpower.es/es/solicita-financiacion' });
  }
  socialCache = convocatorias; socialCacheTime = Date.now();
  return convocatorias;
}

const NUTS_ES = [
  {id:2,codigo:'ES11',nombre:'Galicia'},{id:3,codigo:'ES111',nombre:'A Coruña'},{id:7,codigo:'ES12',nombre:'Asturias'},
  {id:9,codigo:'ES13',nombre:'Cantabria'},{id:12,codigo:'ES21',nombre:'País Vasco'},{id:16,codigo:'ES22',nombre:'Navarra'},
  {id:18,codigo:'ES23',nombre:'La Rioja'},{id:20,codigo:'ES24',nombre:'Aragón'},{id:25,codigo:'ES30',nombre:'Comunidad de Madrid'},
  {id:28,codigo:'ES41',nombre:'Castilla y León'},{id:38,codigo:'ES42',nombre:'Castilla-La Mancha'},{id:44,codigo:'ES43',nombre:'Extremadura'},
  {id:48,codigo:'ES51',nombre:'Cataluña'},{id:53,codigo:'ES52',nombre:'C. Valenciana'},{id:57,codigo:'ES53',nombre:'Illes Balears'},
  {id:60,codigo:'ES61',nombre:'Andalucía'},{id:69,codigo:'ES62',nombre:'Murcia'},{id:71,codigo:'ES63',nombre:'Ceuta'},
  {id:73,codigo:'ES64',nombre:'Melilla'},{id:76,codigo:'ES70',nombre:'Canarias'},
];

// ════════════════════════════════════════════════════════════
// SERVIDOR
// ════════════════════════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  const rawUrl   = req.url;
  const qIndex   = rawUrl.indexOf('?');
  const pathname = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
  const query    = qIndex >= 0 ? rawUrl.slice(qIndex) : '';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers':'Content-Type,X-Token' });
    res.end(); return;
  }

  // ─────────────────────────────────────────────────────────
  // AUTH ENDPOINTS
  // ─────────────────────────────────────────────────────────

  // POST /api/login
  if (pathname === '/api/login' && req.method === 'POST') {
    try {
      const { usuario, password } = await readBody(req);
      if (!usuario || !password) return sendJSON(res, 400, { error: 'Faltan credenciales' });

      const { status, data } = await supabase('GET', 'usuarios', {
        filter: `usuario=eq.${encodeURIComponent(usuario)}&activo=eq.true`,
        single: true,
      });

      if (status !== 200 || !data || !data.password_hash)
        return sendJSON(res, 401, { error: 'Usuario o contraseña incorrectos' });

      const ok = await bcrypt.compare(password, data.password_hash);
      if (!ok) return sendJSON(res, 401, { error: 'Usuario o contraseña incorrectos' });

      await supabase('PATCH', 'usuarios', { filter: `id=eq.${data.id}`, body: { ultimo_login: new Date().toISOString() } });

      const token = genToken();
      tokens.set(token, { id: data.id, usuario: data.usuario, rol: data.rol || 'usuario', exp: Date.now() + TOKEN_TTL });

      console.log(`[LOGIN] ${usuario} (${data.rol}) ✓`);
      sendJSON(res, 200, { ok: true, token, usuario: data.usuario, rol: data.rol || 'usuario' });
    } catch(e) {
      console.error('[LOGIN]', e.message);
      sendJSON(res, 500, { error: 'Error interno' });
    }
    return;
  }

  // POST /api/logout
  if (pathname === '/api/logout' && req.method === 'POST') {
    const token = (req.headers['x-token'] || '').trim();
    if (token) tokens.delete(token);
    sendJSON(res, 200, { ok: true });
    return;
  }

  // GET /api/usuarios
  if (pathname === '/api/usuarios' && req.method === 'GET') {
    const s = requireAuth(req, res); if (!s) return;
    if (s.rol !== 'admin' && s.rol !== 'gestor') return sendJSON(res, 403, { error: 'Sin permisos' });
    const { status, data } = await supabase('GET', 'usuarios', { select: 'id,usuario,nombre,rol,ultimo_login,activo' });
    sendJSON(res, status === 200 ? 200 : 502, status === 200 ? data : { error: 'Error Supabase' });
    return;
  }

  // POST /api/usuarios — crear (solo admin)
  if (pathname === '/api/usuarios' && req.method === 'POST') {
    const s = requireAdmin(req, res); if (!s) return;
    try {
      const { usuario, password, nombre, rol } = await readBody(req);
      if (!usuario || !password) return sendJSON(res, 400, { error: 'Usuario y contraseña obligatorios' });
      if (password.length < 6) return sendJSON(res, 400, { error: 'Contraseña: mínimo 6 caracteres' });
      const rolFinal = ['usuario','gestor','admin'].includes(rol) ? rol : 'usuario';
      const hash = await bcrypt.hash(password, 10);
      const { status, data } = await supabase('POST', 'usuarios', {
        body: { usuario, password_hash: hash, nombre: nombre || null, rol: rolFinal, activo: true },
      });
      if (status === 201 || status === 200) {
        console.log(`[USUARIOS] Creado: ${usuario} (${rolFinal}) por ${s.usuario}`);
        sendJSON(res, 201, { ok: true });
      } else {
        const msg = (typeof data === 'object' ? JSON.stringify(data) : String(data));
        sendJSON(res, 400, { error: msg.includes('duplicate') || msg.includes('unique') ? 'Ese nombre de usuario ya existe' : 'Error al crear usuario' });
      }
    } catch(e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  // POST /api/usuarios/:id/rol
  const rolMatch = pathname.match(/^\/api\/usuarios\/(\d+)\/rol$/);
  if (rolMatch && req.method === 'POST') {
    const s = requireAdmin(req, res); if (!s) return;
    const { rol } = await readBody(req);
    if (!['usuario','gestor','admin'].includes(rol)) return sendJSON(res, 400, { error: 'Rol inválido' });
    const { status } = await supabase('PATCH', 'usuarios', { filter: `id=eq.${rolMatch[1]}`, body: { rol } });
    sendJSON(res, status < 300 ? 200 : 502, status < 300 ? { ok: true } : { error: 'Error al cambiar rol' });
    return;
  }

  // DELETE /api/usuarios/:id
  const delMatch = pathname.match(/^\/api\/usuarios\/(\d+)$/);
  if (delMatch && req.method === 'DELETE') {
    const s = requireAdmin(req, res); if (!s) return;
    if (String(s.id) === delMatch[1]) return sendJSON(res, 400, { error: 'No puedes eliminarte a ti mismo' });
    const { status } = await supabase('DELETE', 'usuarios', { filter: `id=eq.${delMatch[1]}` });
    sendJSON(res, status < 300 ? 200 : 502, status < 300 ? { ok: true } : { error: 'Error al eliminar' });
    return;
  }

  // POST /api/usuarios/cambiar-password
  if (pathname === '/api/usuarios/cambiar-password' && req.method === 'POST') {
    const s = requireAuth(req, res); if (!s) return;
    try {
      const { passwordActual, passwordNueva } = await readBody(req);
      if (!passwordActual || !passwordNueva) return sendJSON(res, 400, { error: 'Faltan campos' });
      if (passwordNueva.length < 6) return sendJSON(res, 400, { error: 'Mínimo 6 caracteres' });
      const { status, data } = await supabase('GET', 'usuarios', { filter: `id=eq.${s.id}`, single: true });
      if (status !== 200 || !data) return sendJSON(res, 404, { error: 'Usuario no encontrado' });
      if (!await bcrypt.compare(passwordActual, data.password_hash)) return sendJSON(res, 401, { error: 'Contraseña actual incorrecta' });
      await supabase('PATCH', 'usuarios', { filter: `id=eq.${s.id}`, body: { password_hash: await bcrypt.hash(passwordNueva, 10) } });
      sendJSON(res, 200, { ok: true });
    } catch(e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  // ─────────────────────────────────────────────────────────
  // PERFIL ENDPOINTS
  // ─────────────────────────────────────────────────────────

  // GET /api/perfil — perfil propio
  if (pathname === '/api/perfil' && req.method === 'GET') {
    const s = requireAuth(req, res); if (!s) return;
    const { status, data } = await supabase('GET', 'usuarios', {
      filter: `id=eq.${s.id}`,
      select: 'id,usuario,nombre,apellidos,documento,telefono,cargo,departamento,rol,activo,ultimo_login',
      single: true,
    });
    sendJSON(res, status === 200 ? 200 : 502, status === 200 ? data : { error: 'Error al cargar perfil' });
    return;
  }

  // GET /api/perfil/:id — perfil de otro usuario (admin ve todos, usuario solo el suyo)
  const perfilGetMatch = pathname.match(/^\/api\/perfil\/(\d+)$/);
  if (perfilGetMatch && req.method === 'GET') {
    const s = requireAuth(req, res); if (!s) return;
    const id = perfilGetMatch[1];
    if (s.rol !== 'admin' && String(s.id) !== id) return sendJSON(res, 403, { error: 'Sin permisos' });
    const { status, data } = await supabase('GET', 'usuarios', {
      filter: `id=eq.${id}`,
      select: 'id,usuario,nombre,apellidos,documento,telefono,cargo,departamento,rol,activo,ultimo_login',
      single: true,
    });
    sendJSON(res, status === 200 ? 200 : 502, status === 200 ? data : { error: 'No encontrado' });
    return;
  }

  // PATCH /api/perfil/:id — editar perfil (solo admin)
  const perfilPatchMatch = pathname.match(/^\/api\/perfil\/(\d+)$/);
  if (perfilPatchMatch && req.method === 'PATCH') {
    const s = requireAdmin(req, res); if (!s) return;
    const id = perfilPatchMatch[1];
    const body = await readBody(req);
    const allowed = ['nombre','apellidos','documento','telefono','cargo','departamento'];
    const update = {};
    allowed.forEach(k => { if (k in body) update[k] = body[k]; });
    const { status } = await supabase('PATCH', 'usuarios', { filter: `id=eq.${id}`, body: update });
    sendJSON(res, status < 300 ? 200 : 502, status < 300 ? { ok: true } : { error: 'Error al guardar' });
    return;
  }

  // ── Helpers para sub-recursos (anotaciones, proyectos, tareas, archivos) ──
  async function getSubrecurso(tabla, usuarioId) {
    const { status, data } = await supabase('GET', tabla, {
      filter: `usuario_id=eq.${usuarioId}`,
    });
    return { status, data: Array.isArray(data) ? data : [] };
  }

  async function createSubrecurso(tabla, usuarioId, campos, body) {
    const record = { usuario_id: parseInt(usuarioId) };
    campos.forEach(k => { if (k in body) record[k] = body[k]; });
    const { status, data } = await supabase('POST', tabla, { body: record });
    return { status, data };
  }

  async function deleteSubrecurso(tabla, itemId, usuarioId, session) {
    // Verificar que el item pertenece al usuario (o admin puede borrar todo)
    const { status: st, data: item } = await supabase('GET', tabla, {
      filter: `id=eq.${itemId}`,
      single: true,
    });
    if (st !== 200 || !item) return { ok: false, error: 'No encontrado' };
    if (session.rol !== 'admin' && String(item.usuario_id) !== String(usuarioId))
      return { ok: false, error: 'Sin permisos' };
    const { status } = await supabase('DELETE', tabla, { filter: `id=eq.${itemId}` });
    return status < 300 ? { ok: true } : { ok: false, error: 'Error al eliminar' };
  }

  // Comprueba si el solicitante puede acceder a los datos del usuarioId
  function canAccessUser(session, usuarioId) {
    return session.rol === 'admin' || String(session.id) === String(usuarioId);
  }

  // ── ANOTACIONES ────────────────────────────────────────
  const anotListMatch = pathname.match(/^\/api\/perfil\/(\d+)\/anotaciones$/);
  if (anotListMatch) {
    const s = requireAuth(req, res); if (!s) return;
    const uid = anotListMatch[1];
    if (!canAccessUser(s, uid)) return sendJSON(res, 403, { error: 'Sin permisos' });

    if (req.method === 'GET') {
      const { data } = await getSubrecurso('anotaciones', uid);
      sendJSON(res, 200, data.sort((a,b) => new Date(b.created_at) - new Date(a.created_at)));
      return;
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!body.texto?.trim()) return sendJSON(res, 400, { error: 'El texto es obligatorio' });
      const { status } = await createSubrecurso('anotaciones', uid, ['texto'], body);
      sendJSON(res, status < 300 ? 201 : 502, status < 300 ? { ok: true } : { error: 'Error al crear' });
      return;
    }
  }

  const anotDelMatch = pathname.match(/^\/api\/perfil\/(\d+)\/anotaciones\/(\d+)$/);
  if (anotDelMatch && req.method === 'DELETE') {
    const s = requireAuth(req, res); if (!s) return;
    const result = await deleteSubrecurso('anotaciones', anotDelMatch[2], anotDelMatch[1], s);
    sendJSON(res, result.ok ? 200 : 400, result);
    return;
  }

  // ── PROYECTOS ──────────────────────────────────────────
  const proyListMatch = pathname.match(/^\/api\/perfil\/(\d+)\/proyectos$/);
  if (proyListMatch) {
    const s = requireAuth(req, res); if (!s) return;
    const uid = proyListMatch[1];
    if (!canAccessUser(s, uid)) return sendJSON(res, 403, { error: 'Sin permisos' });

    if (req.method === 'GET') {
      const { data } = await getSubrecurso('proyectos', uid);
      sendJSON(res, 200, data.sort((a,b) => new Date(b.created_at) - new Date(a.created_at)));
      return;
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!body.nombre?.trim()) return sendJSON(res, 400, { error: 'El nombre es obligatorio' });
      const { status } = await createSubrecurso('proyectos', uid, ['nombre','descripcion','estado','fecha_inicio','fecha_fin'], body);
      sendJSON(res, status < 300 ? 201 : 502, status < 300 ? { ok: true } : { error: 'Error al crear' });
      return;
    }
  }

  const proyDelMatch = pathname.match(/^\/api\/perfil\/(\d+)\/proyectos\/(\d+)$/);
  if (proyDelMatch && req.method === 'DELETE') {
    const s = requireAuth(req, res); if (!s) return;
    const result = await deleteSubrecurso('proyectos', proyDelMatch[2], proyDelMatch[1], s);
    sendJSON(res, result.ok ? 200 : 400, result);
    return;
  }

  // ── TAREAS ─────────────────────────────────────────────
  const tarListMatch = pathname.match(/^\/api\/perfil\/(\d+)\/tareas$/);
  if (tarListMatch) {
    const s = requireAuth(req, res); if (!s) return;
    const uid = tarListMatch[1];
    if (!canAccessUser(s, uid)) return sendJSON(res, 403, { error: 'Sin permisos' });

    if (req.method === 'GET') {
      const { data } = await getSubrecurso('tareas', uid);
      sendJSON(res, 200, data.sort((a,b) => new Date(b.created_at) - new Date(a.created_at)));
      return;
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!body.titulo?.trim()) return sendJSON(res, 400, { error: 'El título es obligatorio' });
      const { status } = await createSubrecurso('tareas', uid, ['titulo','descripcion','estado','prioridad','fecha_limite'], body);
      sendJSON(res, status < 300 ? 201 : 502, status < 300 ? { ok: true } : { error: 'Error al crear' });
      return;
    }
  }

  const tarDelMatch = pathname.match(/^\/api\/perfil\/(\d+)\/tareas\/(\d+)$/);
  if (tarDelMatch && req.method === 'DELETE') {
    const s = requireAuth(req, res); if (!s) return;
    const result = await deleteSubrecurso('tareas', tarDelMatch[2], tarDelMatch[1], s);
    sendJSON(res, result.ok ? 200 : 400, result);
    return;
  }

  // ── ARCHIVOS ───────────────────────────────────────────
  const archListMatch = pathname.match(/^\/api\/perfil\/(\d+)\/archivos$/);
  if (archListMatch) {
    const s = requireAuth(req, res); if (!s) return;
    const uid = archListMatch[1];
    if (!canAccessUser(s, uid)) return sendJSON(res, 403, { error: 'Sin permisos' });

    if (req.method === 'GET') {
      const { data } = await getSubrecurso('archivos', uid);
      sendJSON(res, 200, data.sort((a,b) => new Date(b.created_at) - new Date(a.created_at)));
      return;
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!body.nombre?.trim() || !body.url?.trim()) return sendJSON(res, 400, { error: 'Nombre y URL obligatorios' });
      const { status } = await createSubrecurso('archivos', uid, ['nombre','url','tipo'], body);
      sendJSON(res, status < 300 ? 201 : 502, status < 300 ? { ok: true } : { error: 'Error al crear' });
      return;
    }
  }

  const archDelMatch = pathname.match(/^\/api\/perfil\/(\d+)\/archivos\/(\d+)$/);
  if (archDelMatch && req.method === 'DELETE') {
    const s = requireAuth(req, res); if (!s) return;
    const result = await deleteSubrecurso('archivos', archDelMatch[2], archDelMatch[1], s);
    sendJSON(res, result.ok ? 200 : 400, result);
    return;
  }

  // ─────────────────────────────────────────────────────────
  // PROYECTOS (globales de empresa)
  // ─────────────────────────────────────────────────────────

  // GET /api/proyectos — todos (con miembros embebidos)
  if (pathname === '/api/proyectos' && req.method === 'GET') {
    const s = requireAuth(req, res); if (!s) return;
    // 1. Traer proyectos
    const { status: st1, data: proyectos } = await supabase('GET', 'proyectos', {
      select: 'id,nombre,descripcion,estado,prioridad,cliente,presupuesto,fecha_inicio,fecha_fin,etiquetas,creador_id,created_at',
    });
    if (st1 !== 200) return sendJSON(res, 502, { error: 'Error al obtener proyectos' });
    const lista = Array.isArray(proyectos) ? proyectos : [];

    // 2. Traer todas las asignaciones con datos de usuario
    const { data: asigs } = await supabase('GET', 'proyecto_usuarios', {
      select: 'id,proyecto_id,usuario_id,rol_proyecto',
    });
    const asigsList = Array.isArray(asigs) ? asigs : [];

    // 3. Traer usuarios (para nombres)
    const { data: usuarios } = await supabase('GET', 'usuarios', {
      select: 'id,usuario,nombre',
    });
    const usuMap = {};
    (Array.isArray(usuarios) ? usuarios : []).forEach(u => { usuMap[u.id] = u; });

    // 4. Combinar
    lista.forEach(p => {
      p.miembros = asigsList
        .filter(a => a.proyecto_id === p.id)
        .map(a => ({
          asignacion_id: a.id,
          usuario_id:    a.usuario_id,
          rol_proyecto:  a.rol_proyecto,
          usuario:       usuMap[a.usuario_id]?.usuario || '?',
          nombre:        usuMap[a.usuario_id]?.nombre  || null,
        }));
    });

    sendJSON(res, 200, lista);
    return;
  }

  // POST /api/proyectos — crear (solo admin)
  if (pathname === '/api/proyectos' && req.method === 'POST') {
    const s = requireAdmin(req, res); if (!s) return;
    const body = await readBody(req);
    if (!body.nombre?.trim()) return sendJSON(res, 400, { error: 'El nombre es obligatorio' });
    const campos = ['nombre','descripcion','estado','prioridad','cliente','presupuesto','fecha_inicio','fecha_fin','etiquetas'];
    const record = { creador_id: s.id };
    campos.forEach(k => { if (body[k] !== undefined) record[k] = body[k]; });
    const { status } = await supabase('POST', 'proyectos', { body: record });
    sendJSON(res, status < 300 ? 201 : 502, status < 300 ? { ok: true } : { error: 'Error al crear proyecto' });
    return;
  }

  // PATCH /api/proyectos/:id — editar (solo admin)
  const proyEditMatch = pathname.match(/^\/api\/proyectos\/(\d+)$/);
  if (proyEditMatch && req.method === 'PATCH') {
    const s = requireAdmin(req, res); if (!s) return;
    const body = await readBody(req);
    const campos = ['nombre','descripcion','estado','prioridad','cliente','presupuesto','fecha_inicio','fecha_fin','etiquetas'];
    const record = { updated_at: new Date().toISOString() };
    campos.forEach(k => { if (body[k] !== undefined) record[k] = body[k]; });
    const { status } = await supabase('PATCH', 'proyectos', { filter: `id=eq.${proyEditMatch[1]}`, body: record });
    sendJSON(res, status < 300 ? 200 : 502, status < 300 ? { ok: true } : { error: 'Error al actualizar' });
    return;
  }

  // DELETE /api/proyectos/:id (solo admin)
  const proyDelGlobalMatch = pathname.match(/^\/api\/proyectos\/(\d+)$/);
  if (proyDelGlobalMatch && req.method === 'DELETE') {
    const s = requireAdmin(req, res); if (!s) return;
    const { status } = await supabase('DELETE', 'proyectos', { filter: `id=eq.${proyDelGlobalMatch[1]}` });
    sendJSON(res, status < 300 ? 200 : 502, status < 300 ? { ok: true } : { error: 'Error al eliminar' });
    return;
  }

  // GET /api/proyectos/:id/miembros
  const miembrosListMatch = pathname.match(/^\/api\/proyectos\/(\d+)\/miembros$/);
  if (miembrosListMatch && req.method === 'GET') {
    const s = requireAuth(req, res); if (!s) return;
    const pid = miembrosListMatch[1];
    const { status, data: asigs } = await supabase('GET', 'proyecto_usuarios', {
      filter: `proyecto_id=eq.${pid}`,
      select: 'id,usuario_id,rol_proyecto',
    });
    if (status !== 200) return sendJSON(res, 502, { error: 'Error al obtener miembros' });
    const lista = Array.isArray(asigs) ? asigs : [];
    // Enriquecer con datos de usuario
    const { data: usuarios } = await supabase('GET', 'usuarios', { select: 'id,usuario,nombre' });
    const usuMap = {};
    (Array.isArray(usuarios) ? usuarios : []).forEach(u => { usuMap[u.id] = u; });
    const result = lista.map(a => ({
      asignacion_id: a.id,
      usuario_id:    a.usuario_id,
      rol_proyecto:  a.rol_proyecto,
      usuario:       usuMap[a.usuario_id]?.usuario || '?',
      nombre:        usuMap[a.usuario_id]?.nombre  || null,
    }));
    sendJSON(res, 200, result);
    return;
  }

  // POST /api/proyectos/:id/miembros — asignar usuario (solo admin)
  if (miembrosListMatch && req.method === 'POST') {
    const s = requireAdmin(req, res); if (!s) return;
    const pid = miembrosListMatch[1];
    const { usuario_id, rol_proyecto } = await readBody(req);
    if (!usuario_id) return sendJSON(res, 400, { error: 'usuario_id es obligatorio' });
    const rolFinal = ['miembro','responsable'].includes(rol_proyecto) ? rol_proyecto : 'miembro';
    const { status, data } = await supabase('POST', 'proyecto_usuarios', {
      body: { proyecto_id: parseInt(pid), usuario_id: parseInt(usuario_id), rol_proyecto: rolFinal },
    });
    if (status < 300) return sendJSON(res, 201, { ok: true });
    const msg = typeof data === 'object' ? JSON.stringify(data) : String(data);
    sendJSON(res, 400, { error: msg.includes('duplicate') || msg.includes('unique') ? 'Este usuario ya está en el proyecto' : 'Error al asignar' });
    return;
  }

  // DELETE /api/proyectos/:id/miembros/:asignId (solo admin)
  const miembrosDelMatch = pathname.match(/^\/api\/proyectos\/(\d+)\/miembros\/(\d+)$/);
  if (miembrosDelMatch && req.method === 'DELETE') {
    const s = requireAdmin(req, res); if (!s) return;
    const { status } = await supabase('DELETE', 'proyecto_usuarios', { filter: `id=eq.${miembrosDelMatch[2]}` });
    sendJSON(res, status < 300 ? 200 : 502, status < 300 ? { ok: true } : { error: 'Error al quitar miembro' });
    return;
  }

  // ── ARCHIVOS DE PROYECTOS ─────────────────────────────────

  // GET /api/proyectos/:id/archivos
  const archPrListMatch = pathname.match(/^\/api\/proyectos\/(\d+)\/archivos$/);
  if (archPrListMatch && req.method === 'GET') {
    const s = requireAuth(req, res); if (!s) return;
    const pid = archPrListMatch[1];

    // Verificar membresía o admin
    if (s.rol !== 'admin') {
      const { data: memb } = await supabase('GET', 'proyecto_usuarios', {
        filter: `proyecto_id=eq.${pid}&usuario_id=eq.${s.id}`, single: true,
      });
      if (!memb) return sendJSON(res, 403, { error: 'No eres miembro de este proyecto' });
    }

    const { data: archivos } = await supabase('GET', 'proyecto_archivos', {
      filter: `proyecto_id=eq.${pid}`,
      select: 'id,nombre,tipo,tamanyo,storage_path,created_at,usuario_id',
    });
    const lista = Array.isArray(archivos) ? archivos : [];

    // Generar URLs firmadas (1h de validez)
    for (const a of lista) {
      a.url = await supabaseStorageSignedUrl(`proyecto-archivos/${a.storage_path}`, 3600);
    }

    // Enriquecer con nombre de usuario
    const { data: usuarios } = await supabase('GET', 'usuarios', { select: 'id,usuario' });
    const usuMap = {};
    (Array.isArray(usuarios) ? usuarios : []).forEach(u => { usuMap[u.id] = u.usuario; });
    lista.forEach(a => { a.usuario = usuMap[a.usuario_id] || '?'; });

    lista.sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
    sendJSON(res, 200, lista);
    return;
  }

  // POST /api/proyectos/:id/archivos — subir archivo
  if (archPrListMatch && req.method === 'POST') {
    const s = requireAuth(req, res); if (!s) return;
    const pid = archPrListMatch[1];

    // Verificar membresía o admin
    if (s.rol !== 'admin') {
      const { data: memb } = await supabase('GET', 'proyecto_usuarios', {
        filter: `proyecto_id=eq.${pid}&usuario_id=eq.${s.id}`, single: true,
      });
      if (!memb) return sendJSON(res, 403, { error: 'No eres miembro de este proyecto' });
    }

    const ct = req.headers['content-type'] || '';
    const boundaryMatch = ct.match(/boundary=(.+)/);
    if (!boundaryMatch) return sendJSON(res, 400, { error: 'Content-Type multipart requerido' });
    const boundary = boundaryMatch[1].trim();

    const buf   = await readBodyBuffer(req);
    const parts = parseMultipart(buf, boundary);
    const file  = parts.find(p => p.filename);
    if (!file) return sendJSON(res, 400, { error: 'No se encontró archivo en la petición' });

    // Validar tipo
    const ext = (file.filename.split('.').pop() || '').toLowerCase();
    const allowedExt  = ['pdf','doc','docx'];
    const allowedMime = ['application/pdf','application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    if (!allowedExt.includes(ext) && !allowedMime.includes(file.contentType)) {
      return sendJSON(res, 400, { error: 'Solo se permiten archivos PDF y Word (.doc, .docx)' });
    }

    // Límite 20MB
    if (file.body.length > 20 * 1024 * 1024) {
      return sendJSON(res, 400, { error: 'El archivo supera el límite de 20 MB' });
    }

    // Nombre único en Storage
    const unique    = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const safeName  = file.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `proyecto_${pid}/${unique}_${safeName}`;

    // Subir a Supabase Storage
    const { status: stUpload } = await supabaseStorage(
      'POST',
      `proyecto-archivos/${storagePath}`,
      { contentType: file.contentType, body: file.body, upsert: true }
    );

    if (stUpload >= 300) {
      return sendJSON(res, 502, { error: 'Error al subir a Storage' });
    }

    // Determinar tipo legible
    let tipo = 'otro';
    if (ext === 'pdf' || file.contentType === 'application/pdf') tipo = 'PDF';
    else if (['doc','docx'].includes(ext)) tipo = 'Word';

    // Guardar en BD
    const { status: stDB, data: newArch } = await supabase('POST', 'proyecto_archivos', {
      body: {
        proyecto_id:  parseInt(pid),
        usuario_id:   s.id,
        nombre:       file.filename,
        tipo,
        tamanyo:      file.body.length,
        storage_path: storagePath,
      },
    });

    if (stDB >= 300) return sendJSON(res, 502, { error: 'Error al guardar en base de datos' });

    console.log(`[STORAGE] Archivo subido: ${storagePath} por ${s.usuario}`);
    sendJSON(res, 201, { ok: true });
    return;
  }

  // DELETE /api/proyectos/:id/archivos/:archId
  const archPrDelMatch = pathname.match(/^\/api\/proyectos\/(\d+)\/archivos\/(\d+)$/);
  if (archPrDelMatch && req.method === 'DELETE') {
    const s = requireAdmin(req, res); if (!s) return;
    const archId = archPrDelMatch[2];

    // Obtener path para borrar de Storage también
    const { data: arch } = await supabase('GET', 'proyecto_archivos', {
      filter: `id=eq.${archId}`, single: true,
    });
    if (arch?.storage_path) {
      await supabaseStorage('DELETE', `proyecto-archivos/${arch.storage_path}`);
    }
    const { status } = await supabase('DELETE', 'proyecto_archivos', { filter: `id=eq.${archId}` });
    sendJSON(res, status < 300 ? 200 : 502, status < 300 ? { ok: true } : { error: 'Error al eliminar' });
    return;
  }

  // ─────────────────────────────────────────────────────────
  // CHAT ENDPOINTS
  // ─────────────────────────────────────────────────────────

  // GET /api/chat/conversaciones — mis conversaciones
  if (pathname === '/api/chat/conversaciones' && req.method === 'GET') {
    const s = requireAuth(req, res); if (!s) return;
    // Chats donde soy miembro
    const { data: membs } = await supabase('GET', 'chat_miembros', {
      filter: `usuario_id=eq.${s.id}`, select: 'chat_id',
    });
    const chatIds = (Array.isArray(membs) ? membs : []).map(m => m.chat_id);
    if (!chatIds.length) return sendJSON(res, 200, []);

    const { data: chats } = await supabase('GET', 'chats', {
      filter: `id=in.(${chatIds.join(',')})`,
      select: 'id,tipo,nombre,creador_id,created_at',
    });
    const lista = Array.isArray(chats) ? chats : [];

    // Último mensaje de cada chat
    for (const chat of lista) {
      const { data: msgs } = await supabase('GET', 'mensajes', {
        filter: `chat_id=eq.${chat.id}`,
        select: 'texto,created_at,usuario_id',
      });
      const msgList = Array.isArray(msgs) ? msgs : [];
      const last = msgList.sort((a,b) => new Date(b.created_at) - new Date(a.created_at))[0];
      chat.ultimo_mensaje = last?.texto || null;
      chat.ultimo_at      = last?.created_at || chat.created_at;

      // Para chats privados, usar nombre del otro usuario
      if (chat.tipo === 'privado') {
        const { data: otros } = await supabase('GET', 'chat_miembros', {
          filter: `chat_id=eq.${chat.id}&usuario_id=neq.${s.id}`,
          select: 'usuario_id',
        });
        const otroId = otros?.[0]?.usuario_id;
        if (otroId) {
          const { data: u } = await supabase('GET', 'usuarios', {
            filter: `id=eq.${otroId}`, select: 'usuario,nombre', single: true,
          });
          chat.nombre = u?.nombre || u?.usuario || 'Usuario';
        }
      }
    }

    lista.sort((a,b) => new Date(b.ultimo_at) - new Date(a.ultimo_at));
    sendJSON(res, 200, lista);
    return;
  }

  // POST /api/chat/conversaciones — crear chat
  if (pathname === '/api/chat/conversaciones' && req.method === 'POST') {
    const s = requireAuth(req, res); if (!s) return;
    const { tipo, nombre, usuarios } = await readBody(req);
    if (!Array.isArray(usuarios) || !usuarios.length)
      return sendJSON(res, 400, { error: 'Indica al menos un usuario' });

    // Para privado, verificar que no existe ya
    if (tipo === 'privado') {
      const otroId = usuarios[0];
      const { data: misChats } = await supabase('GET', 'chat_miembros', {
        filter: `usuario_id=eq.${s.id}`, select: 'chat_id',
      });
      for (const mc of (misChats || [])) {
        const { data: otroMiembro } = await supabase('GET', 'chat_miembros', {
          filter: `chat_id=eq.${mc.chat_id}&usuario_id=eq.${otroId}`, select: 'id',
        });
        if (otroMiembro?.length) {
          // Ya existe, devolver ese chat
          return sendJSON(res, 200, { ok: true, chat_id: mc.chat_id });
        }
      }
    }

    // Crear chat
    const { status: st, data: newChat } = await supabase('POST', 'chats', {
      body: { tipo: tipo || 'privado', nombre: nombre || null, creador_id: s.id },
    });
    if (st >= 300) return sendJSON(res, 502, { error: 'Error al crear chat' });

    const chatId = Array.isArray(newChat) ? newChat[0].id : newChat.id;

    // Añadir miembros (yo + los seleccionados)
    const miembros = [s.id, ...usuarios.map(Number)].filter((v,i,a) => a.indexOf(v) === i);
    for (const uid of miembros) {
      await supabase('POST', 'chat_miembros', { body: { chat_id: chatId, usuario_id: uid } });
    }

    sendJSON(res, 201, { ok: true, chat_id: chatId });
    return;
  }

  // GET /api/chat/:id/mensajes
  const chatMsgsMatch = pathname.match(/^\/api\/chat\/(\d+)\/mensajes$/);
  if (chatMsgsMatch && req.method === 'GET') {
    const s = requireAuth(req, res); if (!s) return;
    const chatId = chatMsgsMatch[1];
    // Verificar que soy miembro
    const { data: memb } = await supabase('GET', 'chat_miembros', {
      filter: `chat_id=eq.${chatId}&usuario_id=eq.${s.id}`, single: true,
    });
    if (!memb) return sendJSON(res, 403, { error: 'No eres miembro de este chat' });

    const { data: msgs } = await supabase('GET', 'mensajes', {
      filter: `chat_id=eq.${chatId}`,
      select: 'id,chat_id,usuario_id,texto,created_at',
    });
    const lista = Array.isArray(msgs) ? msgs : [];

    // Enriquecer con nombre de usuario
    const { data: usuarios } = await supabase('GET', 'usuarios', { select: 'id,usuario' });
    const usuMap = {};
    (Array.isArray(usuarios) ? usuarios : []).forEach(u => { usuMap[u.id] = u.usuario; });
    lista.forEach(m => { m.usuario = usuMap[m.usuario_id] || '?'; });
    lista.sort((a,b) => new Date(a.created_at) - new Date(b.created_at));

    sendJSON(res, 200, lista);
    return;
  }

  // POST /api/chat/:id/mensajes — enviar mensaje
  if (chatMsgsMatch && req.method === 'POST') {
    const s = requireAuth(req, res); if (!s) return;
    const chatId = chatMsgsMatch[1];
    // Verificar membresía
    const { data: memb } = await supabase('GET', 'chat_miembros', {
      filter: `chat_id=eq.${chatId}&usuario_id=eq.${s.id}`, single: true,
    });
    if (!memb) return sendJSON(res, 403, { error: 'No eres miembro de este chat' });

    const { texto } = await readBody(req);
    if (!texto?.trim()) return sendJSON(res, 400, { error: 'Mensaje vacío' });

    const { status, data: msg } = await supabase('POST', 'mensajes', {
      body: { chat_id: parseInt(chatId), usuario_id: s.id, texto: texto.trim() },
    });
    if (status >= 300) return sendJSON(res, 502, { error: 'Error al guardar mensaje' });

    const mensaje = Array.isArray(msg) ? msg[0] : msg;
    mensaje.usuario = s.usuario;

    // Notificar por WS a los demás miembros del chat
    // Obtener miembros del chat
    const { data: miembros } = await supabase('GET', 'chat_miembros', {
      filter: `chat_id=eq.${chatId}`, select: 'usuario_id',
    });
    (Array.isArray(miembros) ? miembros : []).forEach(m => {
      if (m.usuario_id === s.id) return;
      const sockets = wsClients.get(m.usuario_id);
      if (sockets) {
        sockets.forEach(ws => {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ tipo: 'nuevo_mensaje', mensaje }));
          }
        });
      }
    });

    sendJSON(res, 201, { ok: true, mensaje });
    return;
  }

  // ─────────────────────────────────────────────────────────
  // PROXY / SCRAPERS
  // ─────────────────────────────────────────────────────────

  if (pathname === '/api/socialpower') {
    try { sendJSON(res, 200, await scrapeSocialPower()); } catch(e) { sendJSON(res, 502, { error: e.message }); }
    return;
  }
  if (pathname === '/api/poctep') {
    try { sendJSON(res, 200, await scrapePoctep()); } catch(e) { sendJSON(res, 502, { error: e.message }); }
    return;
  }
  if (pathname === '/api/regiones') {
    try {
      const { statusCode, data } = await proxyGet('/bdnstrans/api/regiones');
      if (statusCode === 200) { try { JSON.parse(data); sendJSON(res, 200, data); return; } catch(e){} }
    } catch(e) {}
    sendJSON(res, 200, NUTS_ES);
    return;
  }
  if (pathname === '/api/convocatorias/busqueda') {
    try { const {statusCode,data} = await proxyGet(`/bdnstrans/api/convocatorias/busqueda${query}`); sendJSON(res, statusCode, data); }
    catch(e) { sendJSON(res, 502, { error: e.message }); }
    return;
  }
  if (pathname.startsWith('/api/convocatorias') || pathname.startsWith('/api/concesiones')) {
    const rest = pathname.slice('/api/'.length);
    try { const {statusCode,data} = await proxyGet(`/bdnstrans/api/${rest}${query}`); sendJSON(res, statusCode, data); }
    catch(e) { sendJSON(res, 502, { error: e.message }); }
    return;
  }
  if (pathname.startsWith('/api/')) {
    const rest = pathname.slice('/api/'.length).split('/').slice(1).join('/');
    try { const {statusCode,data} = await proxyGet(`/bdnstrans/api/${rest}${query}`); sendJSON(res, statusCode, data); }
    catch(e) { sendJSON(res, 502, { error: e.message }); }
    return;
  }

  // ─────────────────────────────────────────────────────────
  // FICHEROS ESTÁTICOS
  // ─────────────────────────────────────────────────────────
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end(`No encontrado: ${pathname}`); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});


server.listen(PORT, () => {
  console.log(`\n✅ Servidor BDNS arrancado en http://localhost:${PORT}`);
  console.log(`   Supabase: ${SB_HOST}\n`);
});