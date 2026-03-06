const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const mysql = require('mysql2/promise');

const PORT     = 3000;
const API_HOST = 'www.infosubvenciones.es';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
};

// ── Configuración MySQL ───────────────────────────────────
// ⚠️ CAMBIA 'TU_CONTRASEÑA' por la contraseña que pusiste al instalar MySQL
const dbConfig = {
  host:     'localhost',
  user:     'root',
  password: '1234',
  database: 'apitest',
  waitForConnections: true,
  connectionLimit: 10,
};

let pool;

async function getDB() {
  if (!pool) pool = mysql.createPool(dbConfig);
  return pool;
}

// ── Guardar convocatorias en MySQL ────────────────────────
async function guardarConvocatorias(rows, vpd) {
  if (!rows || !rows.length) return;
  const db = await getDB();

  const sql = `
    INSERT INTO convocatorias
      (id, num_conv, vpd, titulo, organo_nivel1, organo_nivel2, organo_nivel3,
       fecha_inicio, fecha_fin, importe, url_bases, datos_raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      titulo       = VALUES(titulo),
      importe      = VALUES(importe),
      url_bases    = VALUES(url_bases),
      datos_raw    = VALUES(datos_raw)
  `;

  let guardadas = 0;
  for (const r of rows) {
    try {
      await db.execute(sql, [
        r.id                    || null,
        r.numeroConvocatoria    || null,
        vpd                     || 'GE',
        r.descripcion           || null,
        r.nivel1                || null,
        r.nivel2                || null,
        r.nivel3                || null,
        r.fechaInicioSolicitud  || r.fechaRecepcion || null,
        r.fechaFinSolicitud     || null,
        r.presupuestoTotal      ?? r.importeTotal ?? null,
        r.urlBasesReguladoras   || null,
        JSON.stringify(r),
      ]);
      guardadas++;
    } catch(e) {
      console.error(`[DB] Error guardando id=${r.id}: ${e.message}`);
    }
  }
  console.log(`[DB] ${guardadas}/${rows.length} convocatorias guardadas en MySQL`);
}

// ── Proxy helper ─────────────────────────────────────────
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

// ── NUTS España (fallback) ────────────────────────────────
const NUTS_ES = [
  { id:2,  codigo:'ES11',  nombre:'Galicia' },
  { id:3,  codigo:'ES111', nombre:'A Coruña' },
  { id:4,  codigo:'ES112', nombre:'Lugo' },
  { id:5,  codigo:'ES113', nombre:'Ourense' },
  { id:6,  codigo:'ES114', nombre:'Pontevedra' },
  { id:7,  codigo:'ES12',  nombre:'Asturias' },
  { id:8,  codigo:'ES120', nombre:'Asturias' },
  { id:9,  codigo:'ES13',  nombre:'Cantabria' },
  { id:10, codigo:'ES130', nombre:'Cantabria' },
  { id:12, codigo:'ES21',  nombre:'País Vasco' },
  { id:13, codigo:'ES211', nombre:'Álava' },
  { id:14, codigo:'ES212', nombre:'Guipúzcoa' },
  { id:15, codigo:'ES213', nombre:'Vizcaya' },
  { id:16, codigo:'ES22',  nombre:'Navarra' },
  { id:17, codigo:'ES220', nombre:'Navarra' },
  { id:18, codigo:'ES23',  nombre:'La Rioja' },
  { id:19, codigo:'ES230', nombre:'La Rioja' },
  { id:20, codigo:'ES24',  nombre:'Aragón' },
  { id:21, codigo:'ES241', nombre:'Huesca' },
  { id:22, codigo:'ES242', nombre:'Teruel' },
  { id:23, codigo:'ES243', nombre:'Zaragoza' },
  { id:25, codigo:'ES30',  nombre:'Comunidad de Madrid' },
  { id:26, codigo:'ES300', nombre:'Madrid' },
  { id:28, codigo:'ES41',  nombre:'Castilla y León' },
  { id:29, codigo:'ES411', nombre:'Ávila' },
  { id:30, codigo:'ES412', nombre:'Burgos' },
  { id:31, codigo:'ES413', nombre:'León' },
  { id:32, codigo:'ES414', nombre:'Palencia' },
  { id:33, codigo:'ES415', nombre:'Salamanca' },
  { id:34, codigo:'ES416', nombre:'Segovia' },
  { id:35, codigo:'ES417', nombre:'Soria' },
  { id:36, codigo:'ES418', nombre:'Valladolid' },
  { id:37, codigo:'ES419', nombre:'Zamora' },
  { id:38, codigo:'ES42',  nombre:'Castilla-La Mancha' },
  { id:39, codigo:'ES421', nombre:'Albacete' },
  { id:40, codigo:'ES422', nombre:'Ciudad Real' },
  { id:41, codigo:'ES423', nombre:'Cuenca' },
  { id:42, codigo:'ES424', nombre:'Guadalajara' },
  { id:43, codigo:'ES425', nombre:'Toledo' },
  { id:44, codigo:'ES43',  nombre:'Extremadura' },
  { id:45, codigo:'ES431', nombre:'Badajoz' },
  { id:46, codigo:'ES432', nombre:'Cáceres' },
  { id:48, codigo:'ES51',  nombre:'Cataluña' },
  { id:49, codigo:'ES511', nombre:'Barcelona' },
  { id:50, codigo:'ES512', nombre:'Girona' },
  { id:51, codigo:'ES513', nombre:'Lleida' },
  { id:52, codigo:'ES514', nombre:'Tarragona' },
  { id:53, codigo:'ES52',  nombre:'C. Valenciana' },
  { id:54, codigo:'ES521', nombre:'Alicante' },
  { id:55, codigo:'ES522', nombre:'Castellón' },
  { id:56, codigo:'ES523', nombre:'Valencia' },
  { id:57, codigo:'ES53',  nombre:'Illes Balears' },
  { id:58, codigo:'ES530', nombre:'Illes Balears' },
  { id:60, codigo:'ES61',  nombre:'Andalucía' },
  { id:61, codigo:'ES611', nombre:'Almería' },
  { id:62, codigo:'ES612', nombre:'Cádiz' },
  { id:63, codigo:'ES613', nombre:'Córdoba' },
  { id:64, codigo:'ES614', nombre:'Granada' },
  { id:65, codigo:'ES615', nombre:'Huelva' },
  { id:66, codigo:'ES616', nombre:'Jaén' },
  { id:67, codigo:'ES617', nombre:'Málaga' },
  { id:68, codigo:'ES618', nombre:'Sevilla' },
  { id:69, codigo:'ES62',  nombre:'Murcia' },
  { id:70, codigo:'ES620', nombre:'Murcia' },
  { id:71, codigo:'ES63',  nombre:'Ceuta' },
  { id:72, codigo:'ES630', nombre:'Ceuta' },
  { id:73, codigo:'ES64',  nombre:'Melilla' },
  { id:74, codigo:'ES640', nombre:'Melilla' },
  { id:76, codigo:'ES70',  nombre:'Canarias' },
  { id:77, codigo:'ES703', nombre:'El Hierro' },
  { id:78, codigo:'ES704', nombre:'Fuerteventura' },
  { id:79, codigo:'ES705', nombre:'Gran Canaria' },
  { id:80, codigo:'ES706', nombre:'La Gomera' },
  { id:81, codigo:'ES707', nombre:'La Palma' },
  { id:82, codigo:'ES708', nombre:'Lanzarote' },
  { id:83, codigo:'ES709', nombre:'Tenerife' },
];

const server = http.createServer(async (req, res) => {
  const rawUrl   = req.url;
  const qIndex   = rawUrl.indexOf('?');
  const pathname = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
  const query    = qIndex >= 0 ? rawUrl.slice(qIndex) : '';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  const sendJSON = (statusCode, obj) => {
    const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(body);
  };

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

  // ── /api/convocatorias/busqueda → guardar en DB ──────────
  if (pathname === '/api/convocatorias/busqueda') {
    try {
      const apiPath = `/bdnstrans/api/convocatorias/busqueda${query}`;
      const { statusCode, data } = await proxyGet(apiPath);

      // Intentar guardar en MySQL en segundo plano
      try {
        const parsed = JSON.parse(data);
        const rows = parsed.content || parsed.rows || parsed.data || [];

        // Extraer el vpd del query string para registrarlo
        const params = new URLSearchParams(query.slice(1));
        const vpd = params.get('vpd') || 'GE';

        if (rows.length > 0) {
          guardarConvocatorias(rows, vpd).catch(e =>
            console.error('[DB] Error al guardar lote:', e.message)
          );
        }
      } catch(e) {
        console.warn('[DB] No se pudo parsear respuesta para guardar:', e.message);
      }

      sendJSON(statusCode, data);
    } catch(e) {
      sendJSON(502, { error: e.message });
    }
    return;
  }

  // ── /api/convocatorias* → proxy normal ──────────────────
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

server.listen(PORT, async () => {
  console.log(`\n✅ Servidor BDNS arrancado`);
  console.log(`   Abre en el navegador: http://localhost:${PORT}\n`);
  console.log(`   API real: https://www.infosubvenciones.es/bdnstrans/api/\n`);

  // Verificar conexión a MySQL al arrancar
  try {
    const db = await getDB();
    await db.execute('SELECT 1');
    console.log(`   ✅ MySQL conectado → base de datos: apitest\n`);
  } catch(e) {
    console.error(`   ❌ Error conectando a MySQL: ${e.message}`);
    console.error(`      Revisa usuario, contraseña y que MySQL esté arrancado.\n`);
  }
});