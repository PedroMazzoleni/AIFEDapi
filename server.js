const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
require('dotenv').config();
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

// ── Helpers HTTP ──────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
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
      console.log('[LOGIN DEBUG] status:', status, 'data:', JSON.stringify(data)); 
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
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end(`No encontrado: ${pathname}`); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`\n✅ Servidor BDNS arrancado en http://localhost:${PORT}`);
  console.log(`   Supabase: ${SB_HOST}\n`);
});