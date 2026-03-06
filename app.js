const CCAA = [
  { vpd:'GE',     name:'Estado (AGE)',       flag:'🇪🇸' },
  { vpd:'AN',     name:'Andalucía',          flag:'🌻' },
  { vpd:'AR',     name:'Aragón',             flag:'⚜️' },
  { vpd:'AS',     name:'Asturias',           flag:'🏔️' },
  { vpd:'IB',     name:'Baleares',           flag:'🏝️' },
  { vpd:'CN',     name:'Canarias',           flag:'🌋' },
  { vpd:'CB',     name:'Cantabria',          flag:'⚓' },
  { vpd:'CL',     name:'Castilla y León',    flag:'🏰' },
  { vpd:'CM',     name:'Castilla-La Mancha', flag:'🌾' },
  { vpd:'CT',     name:'Cataluña',           flag:'🔴' },
  { vpd:'EX',     name:'Extremadura',        flag:'🐂' },
  { vpd:'GA',     name:'Galicia',            flag:'🐚' },
  { vpd:'MD',     name:'Madrid',             flag:'🐻' },
  { vpd:'MC',     name:'Murcia',             flag:'☀️' },
  { vpd:'NA',     name:'Navarra',            flag:'⛪' },
  { vpd:'PV',     name:'País Vasco',         flag:'🌿' },
  { vpd:'RI',     name:'La Rioja',           flag:'🍷' },
  { vpd:'VC',     name:'C. Valenciana',      flag:'🍊' },
  { vpd:'CE',     name:'Ceuta',              flag:'🏛️' },
  { vpd:'ML',     name:'Melilla',            flag:'🏛️' },
  { vpd:'POCTEP', name:'POCTEP',             flag:'🇪🇺' },
];

const VPD_NUTS_CODIGO = {
  GE: null,
  AN: 'ES61', AR: 'ES24', AS: 'ES12', IB: 'ES53', CN: 'ES70',
  CB: 'ES13', CL: 'ES41', CM: 'ES42', CT: 'ES51', EX: 'ES43',
  GA: 'ES11', MD: 'ES30', MC: 'ES62', NA: 'ES22', PV: 'ES21',
  RI: 'ES23', VC: 'ES52', CE: 'ES63', ML: 'ES64',
};

const VPD_NUTS = { GE: [] };

let selVpd = 'AN';
let selFechaDesde = '';
let selEstado = '';
let datos = [], total = 0, paginas = 0, errores = 0;
let running = false, stopped = false;

// ── Build CCAA chips ──────────────────────────────────────
const grid = document.getElementById('ccaaGrid');
CCAA.forEach(cc => {
  const d = document.createElement('div');
  d.className = 'ccaa-chip' + (cc.vpd === selVpd ? ' active' : '');
  d.dataset.vpd = cc.vpd;
  d.innerHTML = `<span class="flag">${cc.flag}</span><span class="name">${cc.name}</span>`;
  d.onclick = () => {
    document.querySelectorAll('.ccaa-chip').forEach(c => c.classList.remove('active'));
    d.classList.add('active');
    selVpd = cc.vpd;
  };
  grid.appendChild(d);
});

// ── Estado filter — permite deseleccionar volviendo a "Todas" ──
function setEstado(el, val) {
  const yaActivo = el.classList.contains('active');
  document.querySelectorAll('#estadoChips .f-chip').forEach(c => c.classList.remove('active'));

  if (yaActivo && val !== '') {
    // Deseleccionar → volver a "Todas"
    selEstado = '';
    const todas = document.querySelector('#estadoChips .f-chip[data-val=""]');
    if (todas) todas.classList.add('active');
  } else {
    el.classList.add('active');
    selEstado = val;
  }

  if (datos.length > 0) {
    if (!selEstado) {
      document.querySelectorAll('#tbody tr').forEach(tr => tr.style.display = '');
      const noteEl = $('estadoFiltroNote');
      if (noteEl) noteEl.textContent = '';
    } else {
      filtrarPorEstado();
    }
  }
}

// ── Fecha filter — permite deseleccionar volviendo a "Todas" ──
function setFecha(el, val) {
  const yaActivo = el.classList.contains('active');
  document.querySelectorAll('.fecha-chip').forEach(c => c.classList.remove('active'));

  if (yaActivo && val !== '') {
    // Deseleccionar → volver a "Todas"
    selFechaDesde = '';
    const todas = document.querySelector('.fecha-chip[data-val=""]');
    if (todas) todas.classList.add('active');
  } else {
    el.classList.add('active');
    selFechaDesde = val;
  }
}

// ── Helpers ───────────────────────────────────────────────
const $ = id => document.getElementById(id);
const fmt = n => (n == null || n === '') ? '—' : Number(n).toLocaleString('es-ES');
const fmtF = s => {
  if (!s) return '—';
  if (s.includes('T')) s = s.split('T')[0];
  const [y, m, d] = s.split('-');
  return d ? `${d}/${m}/${y}` : s;
};
const badge = e => {
  if (!e) return '<span class="bx">—</span>';
  const l = e.toLowerCase();
  if (l.includes('abiert')) return `<span class="bo">${e}</span>`;
  if (l.includes('cerrad') || l.includes('finaliz')) return `<span class="bc">${e}</span>`;
  return `<span class="bx">${e}</span>`;
};

function updateUI() {
  const pct = total > 0 ? Math.min(100, Math.round(datos.length / total * 100)) : 0;
  $('progNum').textContent = pct + '%';
  $('fill').style.width = pct + '%';
  $('kTotal').textContent = total > 0 ? fmt(total) : '—';
  $('kExtr').textContent  = fmt(datos.length);
  $('kPags').textContent  = paginas;
  $('kErrs').textContent  = errores;
  $('tbarR').textContent  = fmt(datos.length) + ' registros';
}

function log(msg) { $('logLine').innerHTML = msg; }

function addRows(rows) {
  const tb = $('tbody');
  rows.forEach(r => {
    const num    = r.numeroConvocatoria || r.id || '—';
    const titulo = r.descripcion || '—';
    const tituloL = r.descripcionLeng || '';
    const tipoAdmin = r.nivel1 || '—';
    const ccaa      = r.nivel2 || '—';
    const organo    = r.nivel3 || '—';
    const importe = r.presupuestoTotal ?? r.importeTotal ?? r.importe ?? null;
    const fecha  = fmtF(r.fechaRecepcion || r.fechaRegistro || '');
    const estado = r.descripcionEstado || r.estado || '';
    const tr = document.createElement('tr');
    const convId = r.id;
    tr.dataset.convId = convId;
    tr.innerHTML = `
      <td class="tn"><a class="conv-link" href="https://www.infosubvenciones.es/bdnstrans/GE/es/convocatorias/${num}" target="_blank">${num}</a></td>
      <td>
        <div class="tnivel1">${ccaa}</div>
        <div class="to">${organo}</div>
      </td>
      <td class="tregiones" id="regiones-${convId}"><span class="reg-nivel2">${ccaa !== '—' ? ccaa : '—'}</span></td>
      <td class="tt">${titulo}${tituloL ? `<span class="titulol">${tituloL}</span>` : ''}</td>
      <td class="tf">${fecha}</td>
      <td class="tplazo" id="plazo-${convId}"><span class="bases-loading">···</span></td>
      <td class="tbases" id="bases-${convId}"><span class="bases-loading">···</span></td>`;
    tb.appendChild(tr);
  });
}

// ── Detalle convocatoria ─────────────────────────────────
async function fetchDetalles(rows) {
  const LOTE = 5;
  for (let i = 0; i < rows.length; i += LOTE) {
    const lote = rows.slice(i, i + LOTE);
    await Promise.all(lote.map(async r => {
      const cell = document.getElementById(`bases-${r.id}`);
      if (!cell) return;
      try {
        const res = await fetch(`/api/convocatorias?numConv=${r.numeroConvocatoria}&vpd=GE`);
        if (!res.ok) { cell.innerHTML = '<span class="bases-none">—</span>'; return; }
        const d = await res.json();

        r.presupuestoTotal        = d.presupuestoTotal ?? null;
        r.abierto                 = d.abierto ?? null;
        r.tipoConvocatoria        = d.tipoConvocatoria || '';
        r.fechaInicioSolicitud    = d.fechaInicioSolicitud || '';
        r.fechaFinSolicitud       = d.fechaFinSolicitud || '';
        r.textInicio              = d.textInicio || '';
        r.textFin                 = d.textFin || '';
        r.descripcionFinalidad    = d.descripcionFinalidad || '';
        r.descripcionBasesReg     = d.descripcionBasesReguladoras || '';
        r.urlBasesReguladoras     = d.urlBasesReguladoras || '';
        r.sedeElectronica         = d.sedeElectronica || '';
        r.sePublicaDiarioOficial  = d.sePublicaDiarioOficial ?? null;
        r.instrumentos            = (d.instrumentos||[]).map(x=>x.descripcion).join(' | ');
        r.tiposBeneficiarios      = (d.tiposBeneficiarios||[]).map(x=>x.descripcion).join(' | ');
        r.sectores                = (d.sectores||[]).map(x=>x.descripcion).join(' | ');
        r.regionesDetalle         = (d.regiones||[]).map(x=>x.descripcion).join(' | ');
        r.urlBOE                  = (d.anuncios||[])[0]?.url || '';
        r.cveBOE                  = (d.anuncios||[])[0]?.cve || '';
        r.documentos              = (d.documentos||[]).map(x=>
          `https://www.infosubvenciones.es/bdnstrans/api/documentos/${x.id}`).join(' | ');

        const regionesCell = document.getElementById(`regiones-${r.id}`);
        if (regionesCell) {
          const ccaaNivel2 = r.nivel2 && r.nivel2 !== '—' ? `<span class="reg-nivel2">${r.nivel2}</span>` : '';
          const regsDetalle = r.regionesDetalle
            ? r.regionesDetalle.split(' | ').map(reg => `<span class="reg-tag">${reg}</span>`).join('')
            : '';
          regionesCell.innerHTML = ccaaNivel2 + (regsDetalle ? `<div class="reg-detalle">${regsDetalle}</div>` : '');
        }

        const plazoCell = document.getElementById(`plazo-${r.id}`);
        if (plazoCell) {
          if (d.abierto === false) {
            plazoCell.innerHTML = '<span class="bc">Cerrada</span>';
          } else if (d.fechaFinSolicitud) {
            plazoCell.innerHTML = `<span class="bo">Abierta</span><div class="det-plazo">📅 hasta ${fmtF(d.fechaFinSolicitud)}</div>`;
          } else if (d.abierto === true) {
            plazoCell.innerHTML = '<span class="bo">Abierta</span><div class="det-plazo">⏳ Plazo indefinido</div>';
          } else {
            plazoCell.innerHTML = '<span class="bx">—</span>';
          }
        }

        const estadoHtml = d.abierto === true
          ? '<span class="bo">ABIERTA</span>'
          : d.abierto === false
            ? '<span class="bc">CERRADA</span>'
            : '<span class="bx">—</span>';

        const basesHtml = d.urlBasesReguladoras
          ? `<a class="bases-link" href="${d.urlBasesReguladoras}" target="_blank">📄 Bases</a>`
          : '<span class="bases-none">—</span>';

        const sedeHtml = d.sedeElectronica
          ? `<a class="bases-link" href="${d.sedeElectronica}" target="_blank">🖥 Solicitar</a>`
          : '';

        const boeHtml = r.urlBOE
          ? `<a class="bases-link" href="${r.urlBOE}" target="_blank">📰 BOE</a>`
          : '';

        cell.innerHTML = `
          <div class="det-estado">${estadoHtml}</div>
          <div class="det-links">${basesHtml}${sedeHtml ? ' ' + sedeHtml : ''}${boeHtml ? ' ' + boeHtml : ''}</div>
          ${d.fechaFinSolicitud ? `<div class="det-plazo">📅 hasta ${fmtF(d.fechaFinSolicitud)}</div>` : d.textFin ? `<div class="det-plazo">⏱ ${d.textFin}</div>` : ''}
          ${d.tiposBeneficiarios?.length ? `<div class="det-ben" title="${r.tiposBeneficiarios}">👥 ${(d.tiposBeneficiarios[0]?.descripcion||'').slice(0,40)}${r.tiposBeneficiarios.length > 40 ? '…' : ''}</div>` : ''}
        `;
      } catch(e) {
        cell.innerHTML = '<span class="bases-none">—</span>';
      }
    }));
    filtrarPorEstado();
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

function filtrarPorEstado() {
  if (!selEstado) return;
  const mostrar = selEstado === 'true';
  document.querySelectorAll('#tbody tr').forEach(tr => {
    const id = parseInt(tr.dataset.convId);
    const r = datos.find(x => x.id === id);
    if (!r || r.abierto === null || r.abierto === undefined) return;
    tr.style.display = (r.abierto === mostrar) ? '' : 'none';
  });
  const visibles = document.querySelectorAll('#tbody tr:not([style*="none"])').length;
  const nota = selEstado === 'true' ? '· mostrando abiertas' : '· mostrando cerradas';
  const noteEl = $('estadoFiltroNote');
  if (noteEl) noteEl.textContent = nota + ` (${visibles})`;
}

// ── Cargar regiones (solo para mapear VPD → NUTS id) ─────
async function cargarRegiones() {
  try {
    const r = await fetch('/api/regiones');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const todas = await r.json();
    function findNode(nodes, keyword) {
      for (const n of nodes) {
        if ((n.descripcion || '').toUpperCase().includes(keyword.toUpperCase())) return n;
        if (n.children?.length) { const f = findNode(n.children, keyword); if (f) return f; }
      }
      return null;
    }
    Object.entries(VPD_NUTS_CODIGO).forEach(([vpd, codigo]) => {
      if (!codigo) return;
      const node = findNode(todas, codigo + ' -');
      if (node) VPD_NUTS[vpd] = [node.id];
    });
  } catch(e) {
    console.warn('No se pudieron cargar regiones:', e.message);
  }
}

// ── API ───────────────────────────────────────────────────
async function fetchPage(page) {
  const regionIds = VPD_NUTS[selVpd] || [];
  const buildQS = (pageKey, sizeKey, pageVal) => {
    let base = `${pageKey}=${pageVal}&${sizeKey}=200&order=numeroConvocatoria&direccion=desc`;
    for (const id of regionIds) base += `&regiones=${id}`;
    if (selFechaDesde) base += `&fechaDesde=${selFechaDesde.split('-').reverse().join('/')}`;
    return base;
  };

  const combos = [
    buildQS('page', 'pageSize', page),
    buildQS('numPagina', 'tamanoPagina', page),
    buildQS('pagina', 'tamanyo', page),
  ];

  let lastErr = '';
  for (const qs of combos) {
    const res = await fetch(`/api/convocatorias/busqueda?${qs}`);
    if (res.ok) return res.json();
    const txt = await res.text();
    lastErr = txt;
    if (res.status === 400) {
      try {
        const j = JSON.parse(txt);
        if (j.errores && j.errores.some(e => e.includes('parámetro') && !e.includes('valor'))) continue;
      } catch(e) {}
      continue;
    }
    throw new Error(`HTTP ${res.status}: ${txt.slice(0,150)}`);
  }
  throw new Error(`API error: ${lastErr.slice(0,200)}`);
}

// ── Main ──────────────────────────────────────────────────
async function iniciar() {
  if (running) return;
  datos = []; total = 0; paginas = 0; errores = 0;
  running = true; stopped = false;

  $('tbody').innerHTML = '';
  $('err').classList.remove('on');
  $('progPanel').classList.add('on');
  $('resultsBar').classList.add('on');
  $('tablePanel').classList.add('on');
  const sc = document.getElementById('searchCard'); if(sc) sc.style.display='block';
  const si = document.getElementById('searchInput'); if(si) si.value='';
  const sinfo = document.getElementById('searchInfo'); if(sinfo) sinfo.textContent='';
  $('btnRun').disabled = true;
  $('btnStop').style.display = 'inline-block';

  const ccNombre = CCAA.find(c => c.vpd === selVpd)?.name || selVpd;
  $('progLabel').textContent = `Consultando ${ccNombre}...`;
  updateUI();

  // ── Modo POCTEP exclusivo ────────────────────────────────
  if (selVpd === 'POCTEP') {
    try {
      log(`<b>→</b> Cargando convocatorias <b>POCTEP</b>...`);
      await cargarPoctep();
      $('progLabel').textContent = '✓ Completado · POCTEP';
      $('fill').style.width = '100%';
      $('progNum').textContent = '100%';
      log(`<b>✓</b> Convocatorias POCTEP cargadas`);
    } catch(e) {
      $('err').textContent = `Error POCTEP: ${e.message}`;
      $('err').classList.add('on');
    }
    running = false; $('btnRun').disabled = false;
    $('btnStop').style.display = 'none';
    return;
  }

  try {
    log(`<b>→</b> Conectando — ámbito: <b>${ccNombre}</b> (vpd=${selVpd})`);
    const first = await fetchPage(0);
    const extractRows  = d => d.content || d.rows || d.data || [];
    const extractTotal = (d, rows) => parseInt(d.totalElements ?? d.records ?? d.total ?? rows.length, 10) || 0;
    const extractPages = (d, tot) => Math.ceil(tot / 200);

    const rows0 = extractRows(first);
    total = extractTotal(first, rows0);
    paginas++;
    datos.push(...rows0);
    addRows(rows0);
    fetchDetalles(rows0);
    updateUI();

    if (total === 0) {
      $('progLabel').textContent = 'Sin resultados';
      log('No se encontraron convocatorias.');
      running = false; $('btnRun').disabled = false;
      return;
    }

    const totalPags = extractPages(first, total);
    log(`<b>→</b> ${fmt(total)} convocatorias · ${totalPags} páginas...`);

    for (let p = 1; p < totalPags && !stopped; p++) {
      $('progLabel').textContent = `Página ${p + 1} / ${totalPags}…`;
      try {
        const d = await fetchPage(p);
        const rows = extractRows(d);
        if (!rows.length) break;
        datos.push(...rows); addRows(rows); fetchDetalles(rows); paginas++;
      } catch (e) {
        errores++;
        log(`<b>⚠</b> Error pág ${p + 1}: ${e.message}`);
        await new Promise(r => setTimeout(r, 1200));
      }
      updateUI();
      await new Promise(r => setTimeout(r, 120));
    }

    $('progLabel').textContent = stopped
      ? `Detenido · ${fmt(datos.length)} extraídas`
      : `✓ Completado · ${fmt(datos.length)} convocatorias de ${ccNombre}`;
    if (!stopped) { $('fill').style.width = '100%'; $('progNum').textContent = '100%'; }
    log(`<b>✓</b> ${fmt(datos.length)} convocatorias descargadas`);

  } catch (e) {
    $('err').textContent = `Error: ${e.message}`;
    $('err').classList.add('on');
    $('progLabel').textContent = 'Error';
    log(`<b>✗</b> ${e.message}`);
  }

  running = false; $('btnRun').disabled = false;
  $('btnStop').style.display = 'none';
  updateUI();
}

function parar() { stopped = true; }

// ── POCTEP ────────────────────────────────────────────────
async function cargarPoctep() {
  try {
    const res = await fetch('/api/poctep');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const convs = await res.json();
    if (!convs.length) return;
    addRowsPoctep(convs);
    $('tbarR').textContent = fmt(datos.length + convs.length) + ' registros';
  } catch(e) {
    console.warn('[POCTEP] Error cargando:', e.message);
  }
}

function addRowsPoctep(convs) {
  const tb = $('tbody');
  convs.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.className = 'row-poctep';
    const estadoHtml = r.estado === 'abierta'
      ? '<span class="bo">ABIERTA</span>'
      : r.estado === 'cerrada'
        ? '<span class="bc">CERRADA</span>'
        : '<span class="bx">PRÓXIMA</span>';

    const plazoHtml = r.estado === 'cerrada'
      ? '<span class="bc">Cerrada</span>'
      : r.fechaCierre
        ? `<span class="bo">Abierta</span><div class="det-plazo">📅 hasta ${r.fechaCierre}</div>`
        : r.estado === 'proxima'
          ? '<span class="bx">⏳ Pendiente confirmar</span>'
          : '<span class="bo">Abierta</span><div class="det-plazo">⏳ Plazo indefinido</div>';

    tr.innerHTML = `
      <td class="tn"><a class="conv-link poctep-link" href="${r.url}" target="_blank">POCTEP-${i+1}</a></td>
      <td>
        <div class="tnivel1 poctep-badge">POCTEP</div>
        <div class="to">Interreg VI-A España-Portugal</div>
      </td>
      <td class="tregiones"><span class="reg-nivel2">España · Portugal</span></td>
      <td class="tt">${r.titulo}${r.prioridad ? `<span class="titulol">${r.prioridad}</span>` : ''}</td>
      <td class="tf">—</td>
      <td class="tplazo">${plazoHtml}</td>
      <td class="tbases">
        <div class="det-estado">${estadoHtml}</div>
        <div class="det-links"><a class="bases-link" href="${r.url}" target="_blank">🔗 Ver convocatoria</a></div>
        ${r.fse ? `<div class="det-plazo">💰 ${r.fse}</div>` : ''}
        ${r.resolucion ? `<div class="det-plazo" style="font-size:10px">📋 ${r.resolucion}</div>` : ''}
      </td>`;
    tb.appendChild(tr);
  });
}


function dlCSV() {
  if (!datos.length) return;
  const cabeceras = [
    'Nº Convocatoria','Tipo Admin','CCAA','Órgano','Descripción','Desc. Cooficial',
    'Fecha Recepción','Estado (Abierta)','Presupuesto Total',
    'Tipo Convocatoria','Fecha Inicio Solicitud','Fecha Fin Solicitud','Plazo (texto)',
    'Finalidad','Instrumentos','Tipos Beneficiarios','Sectores','Regiones',
    'Desc. Bases Reguladoras','URL Bases Reguladoras','Sede Electrónica',
    'URL BOE','CVE BOE','Documentos','Publica Diario Oficial','Código INVENTE','MRR'
  ];
  const campos = [
    'numeroConvocatoria','nivel1','nivel2','nivel3','descripcion','descripcionLeng',
    'fechaRecepcion','abierto','presupuestoTotal',
    'tipoConvocatoria','fechaInicioSolicitud','fechaFinSolicitud','textFin',
    'descripcionFinalidad','instrumentos','tiposBeneficiarios','sectores','regionesDetalle',
    'descripcionBasesReg','urlBasesReguladoras','sedeElectronica',
    'urlBOE','cveBOE','documentos','sePublicaDiarioOficial','codigoInvente','mrr'
  ];
  const lines = ['\uFEFF' + cabeceras.join(';')];
  datos.forEach(r => lines.push(campos.map(c => `"${String(r[c]??'').replace(/"/g,'""')}"`).join(';')));
  dl(lines.join('\n'), `bdns_${selVpd}_${hoy()}.csv`, 'text/csv;charset=utf-8;');
}

function dlJSON() {
  if (!datos.length) return;
  dl(JSON.stringify(datos, null, 2), `bdns_${selVpd}_${hoy()}.json`, 'application/json');
}

function dl(content, name, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name; a.click();
}

function hoy() { return new Date().toISOString().split('T')[0]; }

// ── Init ─────────────────────────────────────────────────
cargarRegiones();

// ── Buscador en resultados ─────────────────────────────
function filtrarTexto() {
  const q = (document.getElementById('searchInput')?.value || '').toLowerCase().trim();
  const rows = document.querySelectorAll('#tbody tr');
  let visibles = 0;
  rows.forEach(tr => {
    if (!q) {
      tr.style.display = '';
      visibles++;
    } else {
      const texto = tr.textContent.toLowerCase();
      if (texto.includes(q)) {
        tr.style.display = '';
        visibles++;
      } else {
        tr.style.display = 'none';
      }
    }
  });
  const info = document.getElementById('searchInfo');
  if (info) {
    info.textContent = q
      ? `${visibles} de ${rows.length} resultados coinciden con "${q}"`
      : `${rows.length} resultados totales`;
  }
}