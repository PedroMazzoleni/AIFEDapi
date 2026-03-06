const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const mysql  = require('mysql2/promise');
const crypto = require('crypto');

const PORT     = 3001;
const API_HOST = 'www.infosubvenciones.es';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
};

// AUTH
const dbConfig = { host:'localhost', user:'root', password:'1234', database:'apitest', waitForConnections:true, connectionLimit:10 };
let pool;
async function getDB() { if (!pool) pool = mysql.createPool(dbConfig); return pool; }

const sesiones = new Map();
function crearSesion(userId, usuario) {
  const token = crypto.randomBytes(32).toString('hex');
  sesiones.set(token, { userId, usuario, expira: Date.now() + 8*60*60*1000 });
  return token;
}
function validarSesion(token) {
  if (!token) return null;
  const s = sesiones.get(token);
  if (!s || Date.now() > s.expira) { sesiones.delete(token); return null; }
  return s;
}
setInterval(() => { const n=Date.now(); for(const[t,s] of sesiones) if(n>s.expira) sesiones.delete(t); }, 60*60*1000);
function hashPassword(pw, salt) { return crypto.createHmac('sha256', salt).update(pw).digest('hex'); }
function generarSalt() { return crypto.randomBytes(16).toString('hex'); }

async function inicializarTablas() {
  const db = await getDB();
  await db.execute(`CREATE TABLE IF NOT EXISTS usuarios (
    id INT AUTO_INCREMENT PRIMARY KEY, usuario VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(64) NOT NULL, salt VARCHAR(32) NOT NULL,
    nombre VARCHAR(200), rol VARCHAR(20) DEFAULT 'usuario', activo TINYINT(1) DEFAULT 1,
    creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP, ultimo_login TIMESTAMP NULL)`);
  try { await db.execute(`ALTER TABLE usuarios ADD COLUMN rol VARCHAR(20) DEFAULT 'usuario'`); } catch(e) {}
  const [[{ count }]] = await db.execute('SELECT COUNT(*) as count FROM usuarios');
  if (count === 0) {
    const salt = generarSalt();
    await db.execute('INSERT INTO usuarios (usuario,password_hash,salt,nombre,rol) VALUES (?,?,?,?,?)',
      ['admin', hashPassword('admin123', salt), salt, 'Administrador', 'admin']);
    console.log('\n   Usuario por defecto: admin / admin123\n');
  }
  await db.execute(`UPDATE usuarios SET rol='admin' WHERE usuario='admin' AND (rol IS NULL OR rol='')`);
  console.log('[DB] Tablas listas');
}

// PROXY (original)
function proxyGet(apiPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: API_HOST, path: apiPath, method: 'GET',
      headers: {
        'Host': API_HOST,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'es-ES,es;q=0.9',
        'Accept-Encoding': 'identity', 'Referer': `https://${API_HOST}/bdnstrans/GE/es/convocatorias`,
        'Origin': `https://${API_HOST}`, 'Connection': 'keep-alive',
      }
    }, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => resolve({ statusCode: apiRes.statusCode, data }));
    });
    req.on('error', reject); req.end();
  });
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html,*/*', 'Accept-Language': 'es-ES,es;q=0.9', 'Accept-Encoding': 'identity' }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ statusCode: res.statusCode, data }));
    });
    req.on('error', reject); req.end();
  });
}

let poctepCache = null, poctepCacheTime = 0;
const POCTEP_TTL = 1000*60*60;
async function scrapePoctep() {
  const now = Date.now();
  if (poctepCache && (now-poctepCacheTime) < POCTEP_TTL) return poctepCache;
  const { data: html } = await fetchUrl('https://www.poctep.eu/convocatorias/');
  const convocatorias = [];
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
  if (!tableMatch) throw new Error('No se encontró tabla en POCTEP');
  (tableMatch[0].match(/<tr[\s\S]*?<\/tr>/gi)||[]).forEach((row,i) => {
    if (i===0) return;
    const cells=[]; let m; const re=/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    while((m=re.exec(row))!==null) cells.push(m[1].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim());
    if (cells.length<4||!cells[0]) return;
    const t=cells[0].toUpperCase();
    convocatorias.push({ fuente:'POCTEP', titulo:cells[0].replace(/\(CERRADA\)|\(ABIERTA\)/gi,'').trim(),
      prioridad:cells[1]||'', fse:cells[2]||'', fechaApertura:cells[3]||'', fechaCierre:cells[4]||'', resolucion:cells[5]||'',
      estado: t.includes('CERRADA')?'cerrada': cells[3]?.toLowerCase().includes('pendiente')?'proxima': cells[3]?'abierta':'desconocido',
      url:'https://www.poctep.eu/convocatorias/' });
  });
  poctepCache = convocatorias; poctepCacheTime = now;
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

// SERVIDOR
const server = http.createServer(async (req, res) => {
  const rawUrl=req.url, qi=rawUrl.indexOf('?');
  const pathname=qi>=0?rawUrl.slice(0,qi):rawUrl;
  const query=qi>=0?rawUrl.slice(qi):'';

  if (req.method==='OPTIONS') {
    res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type,X-Token'});
    res.end(); return;
  }
  const sendJSON=(code,obj)=>{ const body=typeof obj==='string'?obj:JSON.stringify(obj); res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*'}); res.end(body); };
  const readBody=()=>new Promise(r=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>r(b));});
  const getToken=()=>req.headers['x-token']||null;

  // LOGIN
  if (pathname==='/api/login' && req.method==='POST') {
    try {
      const body=await readBody(); console.log('[LOGIN]',body);
      const{usuario,password}=JSON.parse(body);
      if(!usuario||!password){sendJSON(400,{error:'Faltan datos'});return;}
      const db=await getDB();
      const[[user]]=await db.execute('SELECT * FROM usuarios WHERE usuario=? AND activo=1',[usuario]);
      console.log('[LOGIN] usuario:',(user?user.usuario:'NO ENCONTRADO'));
      if(!user||hashPassword(password,user.salt)!==user.password_hash){sendJSON(401,{error:'Usuario o contraseña incorrectos'});return;}
      const token=crearSesion(user.id,user.usuario);
      await db.execute('UPDATE usuarios SET ultimo_login=NOW() WHERE id=?',[user.id]);
      sendJSON(200,{ok:true,token,usuario:user.usuario,nombre:user.nombre,rol:user.rol||'usuario'});
    } catch(e){console.error('[LOGIN]',e.message);sendJSON(500,{error:e.message});}
    return;
  }

  // LOGOUT
  if (pathname==='/api/logout'&&req.method==='POST'){sesiones.delete(getToken());sendJSON(200,{ok:true});return;}

  // USUARIOS listar
  if (pathname==='/api/usuarios'&&req.method==='GET'){
    try{const db=await getDB();const[r]=await db.execute('SELECT id,usuario,nombre,rol,activo,creado_en,ultimo_login FROM usuarios ORDER BY creado_en DESC');sendJSON(200,r);}
    catch(e){sendJSON(500,{error:e.message});}return;
  }
  // USUARIOS crear
  if (pathname==='/api/usuarios'&&req.method==='POST'){
    try{
      const{usuario,password,nombre,rol}=JSON.parse(await readBody());
      if(!usuario||!password){sendJSON(400,{error:'Faltan datos'});return;}
      const salt=generarSalt(),db=await getDB();
      await db.execute('INSERT INTO usuarios (usuario,password_hash,salt,nombre,rol) VALUES (?,?,?,?,?)',[usuario,hashPassword(password,salt),salt,nombre||usuario,rol||'usuario']);
      sendJSON(200,{ok:true});
    }catch(e){sendJSON(e.code==='ER_DUP_ENTRY'?400:500,{error:e.code==='ER_DUP_ENTRY'?'El usuario ya existe':e.message});}return;
  }
  // USUARIOS cambiar rol
  if (pathname.match(/^\/api\/usuarios\/\d+\/rol$/)&&req.method==='POST'){
    try{
      const id=parseInt(pathname.split('/')[3]);
      const{rol}=JSON.parse(await readBody());
      if(!['admin','gestor','usuario'].includes(rol)){sendJSON(400,{error:'Rol inválido'});return;}
      await(await getDB()).execute('UPDATE usuarios SET rol=? WHERE id=?',[rol,id]);
      sendJSON(200,{ok:true});
    }catch(e){sendJSON(500,{error:e.message});}return;
  }
  // USUARIOS eliminar
  if (pathname.startsWith('/api/usuarios/')&&req.method==='DELETE'){
    try{await(await getDB()).execute('DELETE FROM usuarios WHERE id=?',[parseInt(pathname.split('/').pop())]);sendJSON(200,{ok:true});}
    catch(e){sendJSON(500,{error:e.message});}return;
  }
  // USUARIOS cambiar password
  if (pathname==='/api/usuarios/cambiar-password'&&req.method==='POST'){
    try{
      const{passwordActual,passwordNueva}=JSON.parse(await readBody());
      const sesion=validarSesion(getToken());
      if(!sesion){sendJSON(401,{error:'Sin sesión'});return;}
      const db=await getDB();
      const[[u]]=await db.execute('SELECT * FROM usuarios WHERE id=?',[sesion.userId]);
      if(hashPassword(passwordActual,u.salt)!==u.password_hash){sendJSON(401,{error:'Contraseña actual incorrecta'});return;}
      const salt=generarSalt();
      await db.execute('UPDATE usuarios SET password_hash=?,salt=? WHERE id=?',[hashPassword(passwordNueva,salt),salt,sesion.userId]);
      sendJSON(200,{ok:true});
    }catch(e){sendJSON(500,{error:e.message});}return;
  }

  // API ORIGINAL (sin tocar)
  if (pathname==='/api/poctep'){
    try{sendJSON(200,await scrapePoctep());}catch(e){sendJSON(502,{error:e.message});}return;
  }
  if (pathname==='/api/regiones'){
    try{const{statusCode,data}=await proxyGet('/bdnstrans/api/regiones');if(statusCode===200){try{JSON.parse(data);sendJSON(200,data);return;}catch(e){}}
    }catch(e){}sendJSON(200,NUTS_ES);return;
  }
  if (pathname==='/api/convocatorias/busqueda'){
    try{const{statusCode,data}=await proxyGet(`/bdnstrans/api/convocatorias/busqueda${query}`);sendJSON(statusCode,data);}
    catch(e){sendJSON(502,{error:e.message});}return;
  }
  if (pathname.startsWith('/api/convocatorias')||pathname.startsWith('/api/concesiones')){
    const rest=pathname.slice('/api/'.length);
    try{const{statusCode,data}=await proxyGet(`/bdnstrans/api/${rest}${query}`);sendJSON(statusCode,data);}
    catch(e){sendJSON(502,{error:e.message});}return;
  }
  if (pathname.startsWith('/api/')){
    const rest=pathname.slice('/api/'.length).split('/').slice(1).join('/');
    try{const{statusCode,data}=await proxyGet(`/bdnstrans/api/${rest}${query}`);sendJSON(statusCode,data);}
    catch(e){sendJSON(502,{error:e.message});}return;
  }

  // Estáticos
  let filePath=pathname==='/'?'/index.html':pathname;
  filePath=path.join(__dirname,filePath);
  fs.readFile(filePath,(err,content)=>{
    if(err){res.writeHead(404);res.end(`No encontrado: ${pathname}`);return;}
    res.writeHead(200,{'Content-Type':MIME[path.extname(filePath)]||'text/plain'});
    res.end(content);
  });
});

server.listen(PORT, async () => {
  console.log(`\n✅ Servidor BDNS + POCTEP arrancado`);
  console.log(`   🌐 App:   http://localhost:${PORT}`);
  console.log(`   🔐 Login: http://localhost:${PORT}/login.html\n`);
  try {
    await inicializarTablas();
    await (await getDB()).execute('SELECT 1');
    console.log('   ✅ MySQL conectado\n');
  } catch(e) { console.error(`   ❌ Error MySQL: ${e.message}\n`); }
});
