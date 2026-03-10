const CCAA = [
  { vpd:'GE',          name:'Estado (AGE)',       img:'ESTADO' },
  { vpd:'AN',          name:'Andalucía',          img:'ANDALUCIA' },
  { vpd:'AR',          name:'Aragón',             img:'ARAGON' },
  { vpd:'AS',          name:'Asturias',           img:'AUSTRIAS' },
  { vpd:'IB',          name:'Baleares',           img:'BALEARES' },
  { vpd:'CN',          name:'Canarias',           img:'ISLASCANARIAS' },
  { vpd:'CB',          name:'Cantabria',          img:'CANTABRIA' },
  { vpd:'CL',          name:'Castilla y León',    img:'CASTILLAYLEON' },
  { vpd:'CM',          name:'Castilla-La Mancha', img:'CASTILLALAMANCHA' },
  { vpd:'CT',          name:'Cataluña',           img:'CATALUNA' },
  { vpd:'EX',          name:'Extremadura',        img:'EXTREMADURA' },
  { vpd:'GA',          name:'Galicia',            img:'GALICIA' },
  { vpd:'MD',          name:'Madrid',             img:'MADRID' },
  { vpd:'MC',          name:'Murcia',             img:'MURCIA' },
  { vpd:'NA',          name:'Navarra',            img:'NAVARRA' },
  { vpd:'PV',          name:'País Vasco',         img:'PAISVASCO' },
  { vpd:'RI',          name:'La Rioja',           img:'LARIOJA' },
  { vpd:'VC',          name:'C. Valenciana',      img:'C.VALENCIANA' },
  { vpd:'CE',          name:'Ceuta',              img:'CEUTA' },
  { vpd:'ML',          name:'Melilla',            img:'MELILLA' },
  { vpd:'POCTEP',      name:'POCTEP',             img:'ESTADO' },
  { vpd:'SOCIALPOWER', name:'Social Power',       img:'ESTADO' },
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
  d.innerHTML = `<span class="flag"><img src="banderas/${cc.img}.png" alt="${cc.name}"></span><span class="name">${cc.name}</span>`;
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
      <td class="tf" id="fecha-${convId}"><span class="bases-loading">···</span></td>
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

        // Actualizar celda de fechas de solicitud
        const fechaCell = document.getElementById(`fecha-${r.id}`);
        if (fechaCell) {
          const ini = r.fechaInicioSolicitud ? `<div class="fecha-row"><span class="fecha-label">Apertura</span><span class="fecha-val">${fmtF(r.fechaInicioSolicitud)}</span></div>` : '';
          const fin = r.fechaFinSolicitud    ? `<div class="fecha-row"><span class="fecha-label">Cierre</span><span class="fecha-val">${fmtF(r.fechaFinSolicitud)}</span></div>`    : '';
          fechaCell.innerHTML = ini || fin ? ini + fin : `<span class="bases-none">${fmtF(r.fechaRecepcion || r.fechaRegistro || '')}</span>`;
        }
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

        // Guardar datos del detalle en el tr para el modal de proyecto
        const trEl = document.querySelector(`tr[data-conv-id="${r.id}"]`);
        if (trEl) {
          trEl.dataset.convTitulo     = r.descripcion || '';
          trEl.dataset.convOrgano     = r.nivel3 || r.nivel2 || '';
          trEl.dataset.convImporte    = r.presupuestoTotal ?? r.importeTotal ?? r.importe ?? '';
          trEl.dataset.convFechaInicio = d.fechaInicioSolicitud || r.fechaRecepcion || '';
          trEl.dataset.convFechaFin    = d.fechaFinSolicitud || '';
          trEl.dataset.convNum         = r.numeroConvocatoria || r.id || '';
        }

        const proyBtn = (sessionStorage.getItem('bdns_rol') === 'admin')
          ? `<button class="bases-link proy-btn" onclick="abrirModalProyectoConv('${r.id}')">📁 Crear proyecto</button>`
          : '';

        cell.innerHTML = `
          <div class="det-estado">${estadoHtml}</div>
          <div class="det-links">${basesHtml}${sedeHtml ? ' ' + sedeHtml : ''}${boeHtml ? ' ' + boeHtml : ''}</div>
          ${d.fechaFinSolicitud ? `<div class="det-plazo">📅 hasta ${fmtF(d.fechaFinSolicitud)}</div>` : d.textFin ? `<div class="det-plazo">⏱ ${d.textFin}</div>` : ''}
          ${d.tiposBeneficiarios?.length ? `<div class="det-ben" title="${r.tiposBeneficiarios}">👥 ${(d.tiposBeneficiarios[0]?.descripcion||'').slice(0,40)}${r.tiposBeneficiarios.length > 40 ? '…' : ''}</div>` : ''}
          ${proyBtn}
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

  // ── Modo SocialPower exclusivo ───────────────────────────
  if (selVpd === 'SOCIALPOWER') {
    try {
      log(`<b>→</b> Cargando convocatorias <b>Social Power</b>...`);
      await cargarSocialPower();
      $('progLabel').textContent = '✓ Completado · Social Power';
      $('fill').style.width = '100%';
      $('progNum').textContent = '100%';
      log(`<b>✓</b> Convocatorias Social Power cargadas`);
    } catch(e) {
      $('err').textContent = `Error Social Power: ${e.message}`;
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
        ${sessionStorage.getItem('bdns_rol')==='admin' ? `<button class="proy-btn" onclick="abrirModalProyectoConvDirect('${r.titulo.replace(/'/g,'')}','POCTEP','','','${r.fechaCierre||''}','POCTEP-${i+1}')">📁 Crear proyecto</button>` : ''}
      </td>`;
    tb.appendChild(tr);
  });
}


// ── SocialPower ───────────────────────────────────────────
async function cargarSocialPower() {
  try {
    const res = await fetch('/api/socialpower');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const convs = await res.json();
    if (!convs.length) return;
    addRowsSocialPower(convs);
    $('tbarR').textContent = fmt(convs.length) + ' registros';
  } catch(e) {
    console.warn('[SOCIALPOWER] Error cargando:', e.message);
  }
}

function addRowsSocialPower(convs) {
  const tb = $('tbody');
  convs.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.className = 'row-socialpower';

    const estadoHtml = r.estado === 'abierta'
      ? '<span class="bo">ABIERTA</span>'
      : r.estado === 'cerrada'
        ? '<span class="bc">CERRADA</span>'
        : '<span class="bx">PRÓXIMA</span>';

    const plazoHtml = r.estado === 'cerrada'
      ? '<span class="bc">Cerrada</span>'
      : r.fechaCierre
        ? `<span class="bo">Abierta</span><div class="det-plazo">📅 hasta ${r.fechaCierre}</div>`
        : '<span class="bx">⏳ Próximamente</span>';

    tr.innerHTML = `
      <td class="tn"><a class="conv-link socialpower-link" href="${r.url}" target="_blank">SP-${i+1}</a></td>
      <td>
        <div class="tnivel1 socialpower-badge">Social Power</div>
        <div class="to">Financiación de proyectos sociales</div>
      </td>
      <td class="tregiones"><span class="reg-nivel2">España</span></td>
      <td class="tt">${r.titulo}${r.fechasTexto ? `<span class="titulol">${r.fechasTexto}</span>` : ''}</td>
      <td class="tf">—</td>
      <td class="tplazo">${plazoHtml}</td>
      <td class="tbases">
        <div class="det-estado">${estadoHtml}</div>
        <div class="det-links"><a class="bases-link" href="${r.url}" target="_blank">🔗 Ver convocatoria</a></div>
        ${sessionStorage.getItem('bdns_rol')==='admin' ? `<button class="proy-btn" onclick="abrirModalProyectoConvDirect('${r.titulo.replace(/'/g,"")}','SocialPower','','','${r.fechaCierre||""}','SP-${i+1}')">📁 Crear proyecto</button>` : ''}
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

// ── Modal: Crear proyecto desde convocatoria ─────────────

(function injectProyModal() {

  // HTML del modal
  const modalHTML = `
  <style>
    .proy-modal-backdrop {
      display: none; position: fixed; inset: 0;
      background: rgba(22,33,62,0.55); z-index: 200;
      align-items: center; justify-content: center; padding: 20px;
    }
    .proy-modal-backdrop.open { display: flex; }
    .proy-modal {
      background: white; border-radius: 8px; width: 100%; max-width: 560px;
      max-height: 90vh; overflow-y: auto;
      box-shadow: 0 24px 64px rgba(0,0,0,0.25);
      font-family: var(--sans, 'DM Sans', sans-serif);
    }
    .proy-modal-head {
      padding: 18px 22px 14px; border-bottom: 1px solid #e8e4dc;
      display: flex; align-items: center; justify-content: space-between;
      position: sticky; top: 0; background: white; z-index: 1;
    }
    .proy-modal-title { font-family: var(--serif, 'Fraunces', serif); font-size: 17px; font-weight: 300; color: #16213e; }
    .proy-modal-close { background: none; border: none; font-size: 18px; cursor: pointer; color: #aaa; padding: 4px 8px; border-radius: 4px; }
    .proy-modal-close:hover { background: #f5f2ec; }
    .proy-modal-body { padding: 18px 22px; display: flex; flex-direction: column; gap: 12px; }
    .proy-modal-footer { padding: 12px 22px; border-top: 1px solid #e8e4dc; display: flex; gap: 8px; justify-content: flex-end; background: #f5f2ec; border-radius: 0 0 8px 8px; }
    .proy-form-row { display: flex; gap: 10px; flex-wrap: wrap; }
    .proy-form-group { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 150px; }
    .proy-form-group label { font-family: var(--mono,'DM Mono',monospace); font-size: 9px; letter-spacing: 0.12em; text-transform: uppercase; color: #8a8076; }
    .proy-form-group input, .proy-form-group select, .proy-form-group textarea {
      padding: 7px 10px; border: 1.5px solid #e8e4dc; border-radius: 4px;
      font-family: var(--sans,'DM Sans',sans-serif); font-size: 13px; color: #16213e;
      background: white; outline: none; width: 100%;
    }
    .proy-form-group input:focus, .proy-form-group select:focus, .proy-form-group textarea:focus { border-color: #1a3f7a; }
    .proy-form-group textarea { resize: vertical; min-height: 64px; }
    .proy-conv-tag {
      display: inline-flex; align-items: center; gap: 6px;
      background: #eef2f8; border: 1px solid #c4d0e8; border-radius: 4px;
      padding: 5px 10px; font-family: var(--mono,'DM Mono',monospace); font-size: 10px; color: #1a3f7a;
    }
    .proy-btn-primary { padding: 8px 18px; background: #16213e; color: white; border: none; border-radius: 4px; font-family: var(--sans,'DM Sans',sans-serif); font-size: 12px; font-weight: 500; cursor: pointer; }
    .proy-btn-primary:hover { background: #1a3f7a; }
    .proy-btn-ghost { padding: 8px 18px; background: transparent; color: #6b6460; border: 1px solid #e8e4dc; border-radius: 4px; font-family: var(--sans,'DM Sans',sans-serif); font-size: 12px; cursor: pointer; }
    .proy-btn-ghost:hover { border-color: #6b6460; }
    .proy-msg { font-family: var(--mono,'DM Mono',monospace); font-size: 11px; padding: 6px 10px; border-radius: 4px; display: none; }
    .proy-msg.ok  { background: #e8f5e9; color: #2e7d32; border: 1px solid #2e7d32; display: block; }
    .proy-msg.err { background: #fce8e6; color: #7a1a1a; border: 1px solid #7a1a1a; display: block; }

  </style>
  <div class="proy-modal-backdrop" id="pmBackdrop">
    <div class="proy-modal">
      <div class="proy-modal-head">
        <span class="proy-modal-title">📁 Crear proyecto desde convocatoria</span>
        <button class="proy-modal-close" onclick="cerrarPM()">✕</button>
      </div>
      <div class="proy-modal-body">
        <div class="proy-conv-tag" id="pmConvTag">📋 Convocatoria: <span id="pmConvNum"></span></div>
        <div class="proy-form-group">
          <label>Nombre del proyecto *</label>
          <input type="text" id="pmNombre" placeholder="Nombre del proyecto">
        </div>
        <div class="proy-form-group">
          <label>Descripción</label>
          <textarea id="pmDesc" placeholder="Descripción…"></textarea>
        </div>
        <div class="proy-form-row">
          <div class="proy-form-group">
            <label>Cliente / Organismo</label>
            <input type="text" id="pmCliente">
          </div>
          <div class="proy-form-group">
            <label>Presupuesto (€)</label>
            <input type="number" id="pmPresupuesto" min="0" step="0.01">
          </div>
        </div>
        <div class="proy-form-row">
          <div class="proy-form-group">
            <label>Estado</label>
            <select id="pmEstado">
              <option value="activo">Activo</option>
              <option value="pausado">Pausado</option>
              <option value="completado">Completado</option>
            </select>
          </div>
          <div class="proy-form-group">
            <label>Prioridad</label>
            <select id="pmPrioridad">
              <option value="baja">Baja</option>
              <option value="media" selected>Media</option>
              <option value="alta">Alta</option>
            </select>
          </div>
        </div>
        <div class="proy-form-row">
          <div class="proy-form-group">
            <label>Fecha inicio</label>
            <input type="date" id="pmInicio">
          </div>
          <div class="proy-form-group">
            <label>Fecha fin (plazo conv.)</label>
            <input type="date" id="pmFin">
          </div>
        </div>
        <div class="proy-msg" id="pmMsg"></div>
      </div>
      <div class="proy-modal-footer">
        <button class="proy-btn-ghost" onclick="cerrarPM()">Cancelar</button>
        <button class="proy-btn-primary" onclick="guardarPM()">💾 Crear proyecto</button>
      </div>
    </div>
  </div>`;

  const div = document.createElement('div');
  div.innerHTML = modalHTML;
  document.body.appendChild(div);

  // Cerrar al clicar backdrop
  document.getElementById('pmBackdrop').addEventListener('click', e => {
    if (e.target.id === 'pmBackdrop') cerrarPM();
  });
})();

function abrirModalProyectoConv(convId) {
  const tr = document.querySelector(`tr[data-conv-id="${convId}"]`);
  if (!tr) return;
  const titulo   = tr.dataset.convTitulo    || '';
  const organo   = tr.dataset.convOrgano    || '';
  const importe  = tr.dataset.convImporte   || '';
  const fechaFin = tr.dataset.convFechaFin  || '';
  const num      = tr.dataset.convNum       || convId;
  abrirModalProyectoConvDirect(titulo, organo, importe, '', fechaFin, num);
}

function abrirModalProyectoConvDirect(titulo, organo, importe, fechaInicio, fechaFin, num) {
  document.getElementById('pmConvNum').textContent = num || '—';
  document.getElementById('pmNombre').value      = titulo.substring(0, 120) || '';
  document.getElementById('pmCliente').value     = organo || '';
  document.getElementById('pmPresupuesto').value = importe || '';
  document.getElementById('pmInicio').value      = fechaFin ? '' : '';
  document.getElementById('pmFin').value         = fechaFin ? isoDate(fechaFin) : '';
  document.getElementById('pmEstado').value      = 'activo';
  document.getElementById('pmPrioridad').value   = 'media';
  document.getElementById('pmDesc').value        = titulo ? `Proyecto basado en la convocatoria: ${titulo}` : '';
  document.getElementById('pmMsg').className     = 'proy-msg';
  document.getElementById('pmBackdrop').classList.add('open');
  document.getElementById('pmNombre').focus();
}

function cerrarPM() {
  document.getElementById('pmBackdrop').classList.remove('open');
}

async function guardarPM() {
  const nombre = document.getElementById('pmNombre').value.trim();
  if (!nombre) {
    const msg = document.getElementById('pmMsg');
    msg.textContent = 'El nombre es obligatorio'; msg.className = 'proy-msg err'; return;
  }

  const body = {
    nombre,
    descripcion:  document.getElementById('pmDesc').value.trim() || null,
    cliente:      document.getElementById('pmCliente').value.trim() || null,
    presupuesto:  parseFloat(document.getElementById('pmPresupuesto').value) || null,
    fecha_inicio: document.getElementById('pmInicio').value || null,
    fecha_fin:    document.getElementById('pmFin').value || null,
    estado:       document.getElementById('pmEstado').value,
    prioridad:    document.getElementById('pmPrioridad').value,
    etiquetas:    'BDNS,' + document.getElementById('pmConvNum').textContent,
  };

  try {
    const res  = await fetch('/api/proyectos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    const msg  = document.getElementById('pmMsg');

    if (data.ok) {
      msg.textContent = '✓ Proyecto creado correctamente';
      msg.className   = 'proy-msg ok';
      setTimeout(() => {
        cerrarPM();
      }, 1800);
    } else {
      msg.textContent = data.error || 'Error al crear el proyecto';
      msg.className   = 'proy-msg err';
    }
  } catch(e) {
    const msg = document.getElementById('pmMsg');
    msg.textContent = 'Error de conexión'; msg.className = 'proy-msg err';
  }
}

// Convierte fechas dd/mm/yyyy o yyyy-mm-dd a yyyy-mm-dd para inputs date
function isoDate(str) {
  if (!str) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const parts = str.split('/');
  if (parts.length === 3) return `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
  return '';
}