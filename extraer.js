// ── Extractor BDNS ────────────────────────────────────────
// Uso: node extraer.js AN
// Resultado: bdns_AN_2025-01-01.csv y bdns_AN_2025-01-01.json
//
// Comunidades: GE AN AR AS IB CN CB CL CM CT EX GA MD MC NA PV RI VC CE ML

const https = require('https');
const fs    = require('fs');

const VPD      = process.argv[2] || 'AN';
const PAGE_SIZE = 200;
const DELAY_MS  = 300;

const NOMBRES = {
  GE:'Estado (AGE)', AN:'Andalucía', AR:'Aragón', AS:'Asturias',
  IB:'Baleares', CN:'Canarias', CB:'Cantabria', CL:'Castilla y León',
  CM:'Castilla-La Mancha', CT:'Cataluña', EX:'Extremadura', GA:'Galicia',
  MD:'Madrid', MC:'Murcia', NA:'Navarra', PV:'País Vasco',
  RI:'La Rioja', VC:'C. Valenciana', CE:'Ceuta', ML:'Melilla',
};

console.log(`\n🔍 Extrayendo convocatorias de ${NOMBRES[VPD] || VPD} (vpd=${VPD})\n`);

function get(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.infosubvenciones.es',
      path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'es-ES,es;q=0.9',
        'Accept-Encoding': 'identity',
        'Referer': `https://www.infosubvenciones.es/bdnstrans/${VPD}/es/convocatorias`,
        'Connection': 'keep-alive',
      }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch(e) {
          reject(new Error(`JSON parse error: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function toCSV(rows) {
  const cabeceras = ['Nº Convocatoria','Descripción','Organismo','Importe Total','Fecha Registro','Estado','Tipo Administración','MRR'];
  const campos    = ['numeroConvocatoria','descripcion','descripcionOrgano','importeTotal','fechaRegistro','descripcionEstado','descripcionTipoAdministracion','mrr'];
  const lines = ['\uFEFF' + cabeceras.join(';')];
  rows.forEach(r => {
    lines.push(campos.map(c => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(';'));
  });
  return lines.join('\n');
}

async function main() {
  const todos = [];
  let total = 0;
  let page = 0;

  // Prueba distintas combinaciones de parámetros
  // Mapa VPD → ID NUTS de nivel CCAA (para filtrar en la API global)
  const VPD_NUTS = {
    GE: null, AN: 60, AR: 20, AS: 7, IB: 57, CN: 76, CB: 9,
    CL: 28, CM: 38, CT: 48, EX: 44, GA: 2, MD: 25, MC: 69,
    NA: 16, PV: 12, RI: 18, VC: 53, CE: 71, ML: 73,
  };
  const regionId = VPD_NUTS[VPD];
  const regionParam = regionId ? `&regiones=${regionId}` : '';

  const paramCombos = [
    p => `page=${p}&pageSize=${PAGE_SIZE}${regionParam}&order=numeroConvocatoria&direccion=desc`,
    p => `numPagina=${p}&tamanoPagina=${PAGE_SIZE}${regionParam}`,
  ];

  let workingCombo = null;
  let firstData = null;

  for (const combo of paramCombos) {
    const path = `/bdnstrans/api/convocatorias/busqueda?${combo(0)}`;
    process.stdout.write(`Probando: ${path} ... `);
    try {
      const data = await get(path);
      if (data && (data.rows || data.convocatorias || data.data || data.records !== undefined)) {
        console.log('✅ OK');
        workingCombo = combo;
        firstData = data;
        break;
      } else {
        console.log(`❌ respuesta inesperada: ${JSON.stringify(data).slice(0,100)}`);
      }
    } catch(e) {
      console.log(`❌ ${e.message.slice(0,100)}`);
    }
    await sleep(300);
  }

  if (!workingCombo) {
    console.error('\n❌ No se encontró ninguna combinación de parámetros válida.');
    console.error('   La API puede estar bloqueando peticiones externas.');
    process.exit(1);
  }

  const rows0 = firstData.rows || firstData.convocatorias || firstData.data || [];
  total = parseInt(firstData.records || firstData.total || firstData.totalRegistros || rows0.length, 10) || 0;
  todos.push(...rows0);

  console.log(`\n📊 Total convocatorias: ${total.toLocaleString('es-ES')}`);
  const totalPags = Math.ceil(total / PAGE_SIZE);
  console.log(`📄 Páginas a descargar: ${totalPags}\n`);

  for (let p = 1; p < totalPags; p++) {
    const pct = Math.round(todos.length / total * 100);
    process.stdout.write(`\r[${pct}%] Página ${p + 1}/${totalPags} — ${todos.length.toLocaleString('es-ES')} extraídas`);
    try {
      const path = `/bdnstrans/api/convocatorias/busqueda?${workingCombo(p)}`;
      const data = await get(path);
      const rows = data.rows || data.convocatorias || data.data || [];
      if (!rows.length) break;
      todos.push(...rows);
    } catch(e) {
      console.log(`\n⚠ Error pág ${p + 1}: ${e.message}`);
      await sleep(1000);
    }
    await sleep(DELAY_MS);
  }

  const fecha = new Date().toISOString().split('T')[0];
  const csvFile  = `bdns_${VPD}_${fecha}.csv`;
  const jsonFile = `bdns_${VPD}_${fecha}.json`;

  fs.writeFileSync(csvFile,  toCSV(todos));
  fs.writeFileSync(jsonFile, JSON.stringify(todos, null, 2));

  console.log(`\n\n✅ Completado: ${todos.length.toLocaleString('es-ES')} convocatorias`);
  console.log(`   📁 CSV:  ${csvFile}`);
  console.log(`   📁 JSON: ${jsonFile}\n`);
}

main().catch(e => { console.error('\n❌ Error fatal:', e.message); process.exit(1); });