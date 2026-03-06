const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT     = 3000;
const API_HOST = 'www.infosubvenciones.es';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
};

// ── Proxy helper (infosubvenciones) ──────────────────────
function proxyGet(apiPath) {
  const options = {
    hostname: API_HOST,
    path: apiPath,
    method: 'GET',
    headers: {
      'Host': API_HOST,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'es-ES,es;q=0.9',
      'Accept-Encoding': 'identity',
      'Referer': `https://${API_HOST}/bdnstrans/GE/es/convocatorias`,
      'Origin': `https://${API_HOST}`,
      'Connection': 'keep-alive',
    }
  };
  console.log(`[PROXY GET] ${apiPath}`);
  return new Promise((resolve, reject) => {
    const req = https.request(options, (apiRes) => {
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

// ── Fetch genérico HTTPS ──────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'es-ES,es;q=0.9',
        'Accept-Encoding': 'identity',
      }
    };
    const req = https.request(options, (res) => {
      // Seguir redirecciones
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, data }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Scraper POCTEP ────────────────────────────────────────
let poctepCache = null;
let poctepCacheTime = 0;
const POCTEP_TTL = 1000 * 60 * 60; // 1 hora

async function scrapePoctep() {
  const now = Date.now();
  if (poctepCache && (now - poctepCacheTime) < POCTEP_TTL) {
    console.log('[POCTEP] Usando caché');
    return poctepCache;
  }

  console.log('[POCTEP] Descargando página...');
  const { data: html } = await fetchUrl('https://www.poctep.eu/convocatorias/');

  const convocatorias = [];
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
  if (!tableMatch) throw new Error('No se encontró tabla en POCTEP');

  const tableHtml = tableMatch[0];
  const rowRegex = /<tr[\s\S]*?<\/tr>/gi;
  const rows = tableHtml.match(rowRegex) || [];

  rows.forEach((row, i) => {
    if (i === 0) return; // saltar cabecera
    const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    const cells = [];
    let m;
    while ((m = cellRegex.exec(row)) !== null) {
      const text = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      cells.push(text);
    }
    if (cells.length < 4) return;

    const titulo     = cells[0] || '';
    const prioridad  = cells[1] || '';
    const fse        = cells[2] || '';
    const abierta    = cells[3] || '';
    const cierre     = cells[4] || '';
    const resolucion = cells[5] || '';

    if (!titulo) return;

    const tituloUp = titulo.toUpperCase();
    let estado = 'desconocido';
    if (tituloUp.includes('CERRADA'))     estado = 'cerrada';
    else if (abierta.toLowerCase().includes('pendiente')) estado = 'proxima';
    else if (abierta)                     estado = 'abierta';

    convocatorias.push({
      fuente:        'POCTEP',
      titulo:        titulo.replace(/\(CERRADA\)|\(ABIERTA\)/gi, '').trim(),
      prioridad,
      fse,
      fechaApertura: abierta,
      fechaCierre:   cierre,
      resolucion,
      estado,
      url:           'https://www.poctep.eu/convocatorias/',
    });
  });

  console.log(`[POCTEP] ${convocatorias.length} convocatorias extraídas`);
  poctepCache = convocatorias;
  poctepCacheTime = now;
  return convocatorias;
}

// ── NUTS España (fallback) ────────────────────────────────
const NUTS_ES = [
  { id:2,  codigo:'ES11',  nombre:'Galicia' },
  { id:3,  codigo:'ES111', nombre:'A Coruña' },
  { id:7,  codigo:'ES12',  nombre:'Asturias' },
  { id:9,  codigo:'ES13',  nombre:'Cantabria' },
  { id:12, codigo:'ES21',  nombre:'País Vasco' },
  { id:16, codigo:'ES22',  nombre:'Navarra' },
  { id:18, codigo:'ES23',  nombre:'La Rioja' },
  { id:20, codigo:'ES24',  nombre:'Aragón' },
  { id:25, codigo:'ES30',  nombre:'Comunidad de Madrid' },
  { id:28, codigo:'ES41',  nombre:'Castilla y León' },
  { id:38, codigo:'ES42',  nombre:'Castilla-La Mancha' },
  { id:44, codigo:'ES43',  nombre:'Extremadura' },
  { id:48, codigo:'ES51',  nombre:'Cataluña' },
  { id:53, codigo:'ES52',  nombre:'C. Valenciana' },
  { id:57, codigo:'ES53',  nombre:'Illes Balears' },
  { id:60, codigo:'ES61',  nombre:'Andalucía' },
  { id:69, codigo:'ES62',  nombre:'Murcia' },
  { id:71, codigo:'ES63',  nombre:'Ceuta' },
  { id:73, codigo:'ES64',  nombre:'Melilla' },
  { id:76, codigo:'ES70',  nombre:'Canarias' },
];

// ── Servidor ─────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const rawUrl   = req.url;
  const qIndex   = rawUrl.indexOf('?');
  const pathname = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
  const query    = qIndex >= 0 ? rawUrl.slice(qIndex) : '';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  const sendJSON = (statusCode, obj) => {
    const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(body);
  };

  // ── /api/poctep ──────────────────────────────────────────
  if (pathname === '/api/poctep') {
    try {
      const data = await scrapePoctep();
      sendJSON(200, data);
    } catch(e) {
      console.error('[POCTEP] Error:', e.message);
      sendJSON(502, { error: e.message });
    }
    return;
  }

  // ── /api/regiones ────────────────────────────────────────
  if (pathname === '/api/regiones') {
    try {
      const { statusCode, data } = await proxyGet('/bdnstrans/api/regiones');
      if (statusCode === 200) {
        try { JSON.parse(data); sendJSON(200, data); return; } catch(e) {}
      }
    } catch(e) {
      console.log(`[REGIONES] Error: ${e.message}, usando fallback NUTS`);
    }
    sendJSON(200, NUTS_ES);
    return;
  }

  // ── /api/convocatorias/busqueda ──────────────────────────
  if (pathname === '/api/convocatorias/busqueda') {
    try {
      const apiPath = `/bdnstrans/api/convocatorias/busqueda${query}`;
      const { statusCode, data } = await proxyGet(apiPath);
      sendJSON(statusCode, data);
    } catch(e) {
      sendJSON(502, { error: e.message });
    }
    return;
  }

  // ── /api/convocatorias* y /api/concesiones* ──────────────
  if (pathname.startsWith('/api/convocatorias') || pathname.startsWith('/api/concesiones')) {
    const rest = pathname.slice('/api/'.length);
    const apiPath = `/bdnstrans/api/${rest}${query}`;
    try {
      const { statusCode, data } = await proxyGet(apiPath);
      sendJSON(statusCode, data);
    } catch(e) {
      sendJSON(502, { error: e.message });
    }
    return;
  }

  // ── /api/* legacy ────────────────────────────────────────
  if (pathname.startsWith('/api/')) {
    const segments = pathname.slice('/api/'.length).split('/');
    const rest = segments.slice(1).join('/');
    const apiPath = `/bdnstrans/api/${rest}${query}`;
    try {
      const { statusCode, data } = await proxyGet(apiPath);
      sendJSON(statusCode, data);
    } catch(e) {
      sendJSON(502, { error: e.message });
    }
    return;
  }

  // ── Ficheros estáticos ───────────────────────────────────
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end(`No encontrado: ${pathname}`); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`\n✅ Servidor BDNS + POCTEP arrancado`);
  console.log(`   Abre en el navegador: http://localhost:${PORT}\n`);
  console.log(`   POCTEP endpoint: http://localhost:${PORT}/api/poctep\n`);
});