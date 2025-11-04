/* Inicialización */
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db   = firebase.firestore();

/* Estado de sesión y verificación de rol */
const userEmailEl = document.getElementById('userEmail');
const btnLogout   = document.getElementById('btnLogout');
auth.onAuthStateChanged(async (user) => {
  if (!user) {
    location.replace('admin-login.html');
    return;
  }
  userEmailEl.textContent = user.email || '';

  // Verificar rol "manager" en /roles/{uid}.role == "manager"
  try {
    const roleDoc = await db.collection('roles').doc(user.uid).get();
    const role = roleDoc.exists ? roleDoc.data().role : null;
    if (role !== 'manager') {
      alert('No tienes permisos para ver este panel. Contacta a Sistemas.');
      await auth.signOut();
      return;
    }
  } catch (e) {
    console.error(e);
    alert('Error verificando permisos.');
    await auth.signOut();
    return;
  }
  // Si todo bien, carga la tabla
  loadPage();
});

btnLogout?.addEventListener('click', () => auth.signOut());

/* UI Filtros */
const qEl        = document.getElementById('q');
const fromEl     = document.getElementById('from');
const toEl       = document.getElementById('to');
const bmonthEl   = document.getElementById('bmonth');
const btnApply   = document.getElementById('btnApply');
const mergeDupEl = document.getElementById('mergeDup');
const onlyFreqEl = document.getElementById('onlyFreq');
const freqNEl    = document.getElementById('freqN');

const tbody      = document.getElementById('tbody');
const btnPrev    = document.getElementById('prevPage');
const btnNext    = document.getElementById('nextPage');
const pageInfo   = document.getElementById('pageInfo');
const btnExport  = document.getElementById('btnExport');

/* KPIs */
const kpiTotal   = document.getElementById('kpiTotal');
const kpiNuevos  = document.getElementById('kpiNuevos');
const kpiRecur   = document.getElementById('kpiRecurrentes');
const kpiVisitas = document.getElementById('kpiVisitas');
const kpiStay    = document.getElementById('kpiStay');

/* Charts (instancias) */
let chVisitsByDay, chSources, chNewVsReturn, chBirthMonths;

let page = 1;
let pageSize = 50;
let lastDoc = null;
let prevStack = []; // para retroceder páginas
let currentRows = []; // filas mostradas (tras filtros/merge)

/* Re-aplicar filtros */
btnApply?.addEventListener('click', () => {
  page = 1; lastDoc = null; prevStack = [];
  loadPage();
});

/* Construir consulta base con filtros de fecha */
function buildQuery(){
  let ref = db.collection('leads').orderBy('createdAt','desc');

  // Rango de fechas sobre createdAt (timestamp)
  const fromVal = fromEl.value ? new Date(fromEl.value + 'T00:00:00') : null;
  const toVal   = toEl.value   ? new Date(toEl.value   + 'T23:59:59') : null;
  if (fromVal) ref = ref.where('createdAt','>=', fromVal);
  if (toVal)   ref = ref.where('createdAt','<=', toVal);

  return ref.limit(pageSize);
}

/* Cargar página */
async function loadPage(direction = 'forward'){
  setLoading(true);
  try{
    let ref = buildQuery();

    if (direction === 'forward' && lastDoc){
      ref = ref.startAfter(lastDoc);
    }
    if (direction === 'back'){
      const pop = prevStack.pop();
      if (!pop){ page = 1; lastDoc = null; }
      else {
        ref = buildQuery().startAt(pop);
        page = Math.max(1, page - 1);
      }
    }

    const snap = await ref.get();
    const rows = [];
    if (snap.empty){
      renderRows([]);
      updatePager(false, false);
      renderKPIsAndCharts([]);
      return;
    }

    // Si vamos adelante, guardamos el primer doc de esta página para poder regresar luego
    if (direction === 'forward'){
      const first = snap.docs[0];
      if (first) prevStack.push(first);
      page = page === 1 ? 1 : page + 1;
    }

    snap.forEach(doc => {
      const d = doc.data();
      rows.push({
        id: doc.id,
        fullName: d.fullName || '',
        email: (d.email || '').trim().toLowerCase(),
        phone: (d.phone || '').replace(/\s+/g,''),
        birthday: d.birthday || '',
        createdAt: d.createdAt?.toDate ? d.createdAt.toDate() : null,
        source: d.source || '',
        visitCount: typeof d.visitCount === 'number' ? d.visitCount : (d.visitHistory?.length || 1),
        lastVisit: d.lastVisit?.toDate ? d.lastVisit.toDate() : (d.createdAt?.toDate ? d.createdAt.toDate() : null),
        lastSessionMinutes: typeof d.lastSessionMinutes === 'number' ? d.lastSessionMinutes : null,
        totalMinutes: typeof d.totalMinutes === 'number' ? d.totalMinutes : null,
        visitHistory: Array.isArray(d.visitHistory) ? d.visitHistory : []
      });
    });

    // Búsqueda cliente (front) q en nombre/correo/teléfono
    const q = (qEl.value || '').trim().toLowerCase();
    let filtered = rows;
    if (q){
      filtered = rows.filter(r =>
        r.fullName.toLowerCase().includes(q) ||
        r.email.includes(q) ||
        r.phone.includes(q)
      );
    }

    // Filtro por mes de cumpleaños
    const m = bmonthEl.value;
    if (m){
      filtered = filtered.filter(r => (r.birthday || '').split('-')[1] === m);
    }

    // Unificar duplicados por email/teléfono (opcional)
    if (mergeDupEl?.checked){
      filtered = mergeDuplicates(filtered);
    }

    // Solo frecuentes (visitCount >= N)
    if (onlyFreqEl?.checked){
      const N = Math.max(2, parseInt(freqNEl.value || '2', 10));
      filtered = filtered.filter(r => (r.visitCount || 1) >= N);
    }

    renderRows(filtered);
    lastDoc = snap.docs[snap.docs.length - 1] || null;
    updatePager(prevStack.length > 1, snap.size === pageSize);

    // KPIs + Gráficas
    renderKPIsAndCharts(filtered);

  } catch(e){
    console.error(e);
    alert('Error al cargar datos.');
  } finally{
    setLoading(false);
  }
}

/* Unifica por email o, si está vacío, por teléfono */
function mergeDuplicates(list){
  const byKey = new Map();
  for (const r of list){
    const key = r.email || r.phone;
    if (!key){ 
      // sin email ni phone => entra como único
      byKey.set(r.id, r);
      continue;
    }
    if (!byKey.has(key)){
      byKey.set(key, {...r});
    } else {
      const a = byKey.get(key);
      // combinar: conservar nombre no vacío, source primero, sumar visitas/minutos y tomar últimas fechas
      a.fullName = a.fullName || r.fullName;
      a.source = a.source || r.source;
      a.visitCount = (a.visitCount || 0) + (r.visitCount || 0);
      a.totalMinutes = (a.totalMinutes || 0) + (r.totalMinutes || 0);
      // última visita más reciente
      const av = a.lastVisit ? a.lastVisit.getTime() : 0;
      const rv = r.lastVisit ? r.lastVisit.getTime() : 0;
      a.lastVisit = av > rv ? a.lastVisit : r.lastVisit;
      // última sesión minutos: tomamos la del registro más reciente que la tenga
      if (rv >= av && r.lastSessionMinutes != null) a.lastSessionMinutes = r.lastSessionMinutes;
      // merge de historial
      a.visitHistory = [...(a.visitHistory||[]), ...(r.visitHistory||[])];
    }
  }
  return Array.from(byKey.values());
}

/* Render tabla */
function renderRows(rows){
  currentRows = rows || [];
  tbody.innerHTML = '';
  if (!rows.length){
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 9;
    td.className = 'muted';
    td.textContent = 'Sin datos';
    tr.appendChild(td);
    tbody.appendChild(tr);
    pageInfo.textContent = `Página ${page}`;
    return;
  }
  for (const r of rows){
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(r.fullName)}</td>
      <td>${escapeHtml(r.email)}</td>
      <td>${escapeHtml(r.phone)}</td>
      <td>${escapeHtml(r.birthday)}</td>
      <td>${r.createdAt ? fmtDateTime(r.createdAt) : ''}</td>
      <td><span class="badge">${escapeHtml(r.source || 'webform')}</span></td>
      <td>${r.visitCount ?? ''}</td>
      <td>${r.lastVisit ? fmtDateTime(r.lastVisit) : ''}</td>
      <td>${r.lastSessionMinutes != null ? Number(r.lastSessionMinutes).toFixed(0) : ''}</td>
    `;
    tbody.appendChild(tr);
  }
  pageInfo.textContent = `Página ${page}`;
}

/* Pager */
function updatePager(hasPrev, hasNext){
  btnPrev.disabled = !hasPrev;
  btnNext.disabled = !hasNext;
}
btnNext?.addEventListener('click', () => loadPage('forward'));
btnPrev?.addEventListener('click', () => loadPage('back'));

/* Exportar Excel (.xlsx) con estilo (filas mostradas) */
btnExport?.addEventListener('click', () => {
  if (!currentRows.length){
    alert('No hay datos para exportar.');
    return;
  }

  // ---------- UTILIDADES ----------
  const toExcelDate = (jsDate) => {
    if (!jsDate) return null;
    // Excel date serial number
    return (jsDate - new Date(Date.UTC(1899, 11, 30))) / (24*60*60*1000);
  };
  const safe = (v) => (v == null ? '' : String(v));
  const phoneFmt = (s) => s.replace(/[^\d]/g,''); // solo dígitos para formato personalizado

  // KPIs rápidos (igual que en panel):
  const total = currentRows.length;
  const nuevos = currentRows.filter(r => (r.visitCount || 1) <= 1).length;
  const recurrentes = total - nuevos;
  const visitasTotales = currentRows.reduce((s, r) => s + (r.visitCount || 1), 0);
  const withMinutes = currentRows.filter(r => typeof r.totalMinutes === 'number' && r.totalMinutes > 0);
  const stayProm = withMinutes.length 
    ? Math.round(withMinutes.reduce((s,r)=>s+(r.totalMinutes||0),0) / withMinutes.length)
    : null;

  // Series para Resumen:
  const byDay = new Map(); // yyyy-mm-dd -> visitas (sumar visitCount)
  const bySource = new Map();
  for (const r of currentRows){
    const day = r.createdAt ? r.createdAt.toISOString().slice(0,10) : null;
    if (day) byDay.set(day, (byDay.get(day)||0) + (r.visitCount || 1));
    const src = (r.source || 'webform').toLowerCase();
    bySource.set(src, (bySource.get(src)||0) + 1);
  }
  const dayEntries = Array.from(byDay.entries()).sort((a,b)=> a[0].localeCompare(b[0]));
  const srcEntries = Array.from(bySource.entries()).sort((a,b)=> b[1]-a[1]);

  // ---------- HOJA "Leads" ----------
  const HEAD = [
    'Nombre','Correo','Teléfono','Cumpleaños','Creado','Fuente',
    'Visitas','Última visita','Min. última sesión'
  ];

  // Construimos los datos en formato SheetJS con estilos:
  const wsData = [HEAD, ...currentRows.map(r => ([
    safe(r.fullName),
    safe(r.email),
    phoneFmt(safe(r.phone)),
    safe(r.birthday),
    r.createdAt ? toExcelDate(r.createdAt) : '',
    safe(r.source || 'webform'),
    r.visitCount ?? '',
    r.lastVisit ? toExcelDate(r.lastVisit) : '',
    (r.lastSessionMinutes != null ? Number(r.lastSessionMinutes) : '')
  ]))];

  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // Estilos generales
  const headerStyle = {
    font: { bold: true, color: { rgb: "FFFFFFFF" } },
    fill: { patternType: "solid", fgColor: { rgb: "FFE2202A" } }, // brand red
    alignment: { horizontal: "center", vertical: "center" }
  };
  const zebra1 = { fill: { patternType: "solid", fgColor: { rgb: "FFF6F7F9" } } };
  const zebra2 = { fill: { patternType: "solid", fgColor: { rgb: "FFFFFFFF" } } };
  const borderThin = { 
    top:{style:"thin", color:{rgb:"FFE6EAF2"}},
    bottom:{style:"thin", color:{rgb:"FFE6EAF2"}},
    left:{style:"thin", color:{rgb:"FFE6EAF2"}},
    right:{style:"thin", color:{rgb:"FFE6EAF2"}}
  };

  // Anchos de columna
  ws['!cols'] = [
    { wch: 28 }, // Nombre
    { wch: 28 }, // Correo
    { wch: 14 }, // Teléfono
    { wch: 12 }, // Cumpleaños
    { wch: 18 }, // Creado
    { wch: 14 }, // Fuente
    { wch: 10 }, // Visitas
    { wch: 18 }, // Última visita
    { wch: 18 }  // Min. última sesión
  ];

  // Altura de encabezado + freeze top row
  ws['!rows'] = [{ hpt: 24 }];
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };

  // Auto-filtro
  const endRow = wsData.length;
  const endCol = HEAD.length - 1;
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s:{r:0,c:0}, e:{r:endRow-1, c:endCol} }) };

  // Aplicar estilos celda por celda
  // Encabezado
  for (let c = 0; c < HEAD.length; c++){
    const addr = XLSX.utils.encode_cell({r:0, c});
    ws[addr].s = { ...headerStyle, border: borderThin };
  }

  // Cuerpo
  for (let r = 1; r < wsData.length; r++){
    const rowStyle = (r % 2 === 1) ? zebra1 : zebra2;
    for (let c = 0; c < HEAD.length; c++){
      const addr = XLSX.utils.encode_cell({r, c});
      ws[addr] = ws[addr] || { t:'s', v:'' };
      ws[addr].s = { ...rowStyle, border: borderThin };
      // Formatos por columna
      if (c === 2) { // Teléfono
        ws[addr].z = '00000000000'; // 11 dígitos; ajusta según tu país
      }
      if (c === 4 || c === 7) { // Fechas Excel
        if (typeof ws[addr].v === 'number') {
          ws[addr].t = 'n';
          ws[addr].z = 'yyyy-mm-dd hh:mm';
        }
      }
      if (c === 6 || c === 8) { // numéricos
        if (ws[addr].v !== '') {
          ws[addr].t = 'n';
        }
      }
      if (c === 1 && ws[addr].v) { // Email con estilo subrayado (simulación de link)
        ws[addr].s = { 
          ...ws[addr].s, 
          font: { underline: true, color: { rgb: "FF1264D1" } }
        };
        // Hyperlink (mailto)
        ws[addr].l = { Target: `mailto:${ws[addr].v}` };
      }
    }
  }

  // ---------- HOJA "Resumen" ----------
  const res = [
    ['REPORTE DE LEADS', null, null, null],
    [null,null,null,null],
    ['KPI', 'Valor', null, null],
    ['Leads (filtrados)', total, null, null],
    ['Nuevos', nuevos, null, null],
    ['Recurrentes', recurrentes, null, null],
    ['Visitas totales', visitasTotales, null, null],
    ['Permanencia prom. (min)', (stayProm != null ? stayProm : '—'), null, null],
    [null,null,null,null],
    ['Visitas por día', null, null, null],
    ...Array.from(dayEntries, ([d,v]) => [d, v, null, null]),
    [null,null,null,null],
    ['Leads por fuente', null, null, null],
    ...Array.from(srcEntries, ([src, n]) => [src, n, null, null]),
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(res);

  // Estilos Resumen
  ws2['!cols'] = [{wch:28},{wch:16},{wch:12},{wch:12}];
  ws2['!rows'] = [
    { hpt: 28 }, // título
  ];

  const borderThin = { 
    top:{style:"thin", color:{rgb:"FFE6EAF2"}},
    bottom:{style:"thin", color:{rgb:"FFE6EAF2"}},
    left:{style:"thin", color:{rgb:"FFE6EAF2"}},
    right:{style:"thin", color:{rgb:"FFE6EAF2"}}
  };
  const zebra1 = { fill: { patternType: "solid", fgColor: { rgb: "FFF6F7F9" } } };
  const zebra2 = { fill: { patternType: "solid", fgColor: { rgb: "FFFFFFFF" } } };

  const titleCell = 'A1';
  ws2[titleCell].s = {
    font: { bold: true, sz: 16, color: {rgb:"FFFFFFFF"} },
    fill: { patternType: "solid", fgColor: { rgb: "FF131A2A" } },
    alignment: { horizontal: "left", vertical: "center" }
  };
  // Encabezados KPI
  ws2['A3'].s = {
    font: { bold: true, color: { rgb: "FFFFFFFF" } },
    fill: { patternType: "solid", fgColor: { rgb: "FFE2202A" } },
    alignment: { horizontal: "center" },
    border: borderThin
  };
  ws2['B3'].s = ws2['A3'].s;

  // Zebra en KPI
  for (let r = 4; r <= 7; r++){
    const zebra = (r % 2 === 0) ? zebra1 : zebra2;
    ws2[`A${r}`].s = { ...zebra, border: borderThin };
    ws2[`B${r}`].s = { ...zebra, border: borderThin };
    if (r !== 7) ws2[`B${r}`].t = 'n';
  }

  // “Visitas por día”
  const startVisitsRow = 10; // A10
  ws2[`A9`] = ws2[`A9`] || { t:'s', v:'Visitas por día' };
  ws2[`A9`].s = {
    font: { bold: true }, fill: { patternType:"solid", fgColor:{rgb:"FFF0F2F7"} }, border: borderThin
  };
  if (dayEntries.length){
    ws2[`A${startVisitsRow}`] = { t:'s', v:'Día', s:{
      font:{bold:true, color:{rgb:"FFFFFFFF"}}, fill:{patternType:"solid", fgColor:{rgb:"FFE2202A"}}, alignment:{horizontal:"center"}, border:borderThin
    }};
    ws2[`B${startVisitsRow}`] = { t:'s', v:'Visitas', s:{
      font:{bold:true, color:{rgb:"FFFFFFFF"}}, fill:{patternType:"solid", fgColor:{rgb:"FFE2202A"}}, alignment:{horizontal:"center"}, border:borderThin
    }};
    for (let i=0;i<dayEntries.length;i++){
      const r = startVisitsRow + 1 + i;
      const zebra = (i % 2 === 0) ? zebra1 : zebra2;
      ws2[`A${r}`] = ws2[`A${r}`] || { t:'s', v:dayEntries[i][0] };
      ws2[`B${r}`] = ws2[`B${r}`] || { t:'n', v:dayEntries[i][1] };
      ws2[`A${r}`].s = { ...zebra, border: borderThin };
      ws2[`B${r}`].s = { ...zebra, border: borderThin };
    }
  }

  // “Leads por fuente”
  const startSrcRow = startVisitsRow + Math.max(2, dayEntries.length + 3);
  ws2[`A${startSrcRow-1}`] = { t:'s', v:'Leads por fuente', s:{
    font:{bold:true}, fill:{patternType:"solid", fgColor:{rgb:"FFF0F2F7"}}, border:borderThin
  }};
  ws2[`A${startSrcRow}`] = { t:'s', v:'Fuente', s:{
    font:{bold:true, color:{rgb:"FFFFFFFF"}}, fill:{patternType:"solid", fgColor:{rgb:"FFE2202A"}}, alignment:{horizontal:"center"}, border:borderThin
  }};
  ws2[`B${startSrcRow}`] = { t:'s', v:'Leads', s:{
    font:{bold:true, color:{rgb:"FFFFFFFF"}}, fill:{patternType:"solid", fgColor:{rgb:"FFE2202A"}}, alignment:{horizontal:"center"}, border:borderThin
  }};
  for (let i=0;i<srcEntries.length;i++){
    const r = startSrcRow + 1 + i;
    const zebra = (i % 2 === 0) ? zebra1 : zebra2;
    ws2[`A${r}`] = { t:'s', v:srcEntries[i][0], s:{ ...zebra, border: borderThin } };
    ws2[`B${r}`] = { t:'n', v:srcEntries[i][1], s:{ ...zebra, border: borderThin } };
  }

  // ---------- LIBRO Y DESCARGA ----------
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws2, 'Resumen');
  XLSX.utils.book_append_sheet(wb, ws,  'Leads');

  const ts = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
  XLSX.writeFile(wb, `Leads_${ts}.xlsx`, { compression: true });
});

/* KPIs + Charts */
function renderKPIsAndCharts(rows){
  // KPIs
  const total = rows.length;
  const nuevos = rows.filter(r => (r.visitCount || 1) <= 1).length;
  const recurrentes = total - nuevos;
  const visitasTotales = rows.reduce((s, r) => s + (r.visitCount || 1), 0);
  const withMinutes = rows.filter(r => typeof r.totalMinutes === 'number' && r.totalMinutes > 0);
  const stayProm = withMinutes.length 
    ? Math.round(withMinutes.reduce((s,r)=>s+(r.totalMinutes||0),0) / withMinutes.length)
    : null;

  kpiTotal.textContent = total;
  kpiNuevos.textContent = nuevos;
  kpiRecur.textContent = recurrentes;
  kpiVisitas.textContent = visitasTotales;
  kpiStay.textContent = stayProm != null ? stayProm : '—';

  // Series
  const byDay = new Map(); // yyyy-mm-dd -> visitas (sumar visitCount)
  const bySource = new Map();
  const birthMonths = new Array(12).fill(0);

  for (const r of rows){
    const day = r.createdAt ? r.createdAt.toISOString().slice(0,10) : null;
    if (day) byDay.set(day, (byDay.get(day)||0) + (r.visitCount || 1));

    const src = (r.source || 'webform').toLowerCase();
    bySource.set(src, (bySource.get(src)||0) + 1);

    if (r.birthday){
      const mm = parseInt(r.birthday.split('-')[1] || '0', 10);
      if (mm>=1 && mm<=12) birthMonths[mm-1] += 1;
    }
  }

  drawOrUpdateChart('chVisitsByDay', 'Visitas por día', mapToSortedArrays(byDay), (c)=> chVisitsByDay = c);
  drawOrUpdateChart('chSources', 'Leads por fuente', mapToArrays(bySource), (c)=> chSources = c, 'bar');
  drawOrUpdateChart('chNewVsReturn', 'Nuevos vs Recurrentes', [
    ['Nuevos','Recurrentes'],
    [nuevos, recurrentes]
  ], (c)=> chNewVsReturn = c, 'doughnut');
  drawOrUpdateChart('chBirthMonths', 'Cumpleaños por mes', [
    ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'],
    birthMonths
  ], (c)=> chBirthMonths = c, 'bar');
}

function mapToArrays(m){
  const labels = [], data = [];
  for (const [k,v] of m.entries()){ labels.push(k); data.push(v); }
  return [labels, data];
}
function mapToSortedArrays(m){
  const entries = Array.from(m.entries()).sort((a,b)=> a[0].localeCompare(b[0]));
  const labels = entries.map(e=>e[0]);
  const data   = entries.map(e=>e[1]);
  return [labels, data];
}

/* Chart helper: no colores explícitos (Chart.js autopalette) */
function drawOrUpdateChart(canvasId, title, [labels, data], setRef, type='line'){
  const ctx = document.getElementById(canvasId).getContext('2d');
  const existing = { chVisitsByDay, chSources, chNewVsReturn, chBirthMonths }[canvasId];
  if (existing){
    existing.data.labels = labels;
    existing.data.datasets[0].data = data;
    existing.update();
    return;
  }
  const chart = new Chart(ctx, {
    type,
    data: {
      labels,
      datasets: [{
        label: title,
        data,
        tension: 0.3
      }]
    },
    options: {
      plugins: { legend: { display: type !== 'line' } },
      scales: type === 'doughnut' ? {} : { y: { beginAtZero: true } },
      maintainAspectRatio: false
    }
  });
  setRef(chart);
}

/* Utilidades */
function fmtDateTime(d){
  const pad = (n)=> String(n).padStart(2,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function escapeHtml(s){
  return String(s||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}
function setLoading(x){
  document.body.style.cursor = x ? 'progress' : 'default';
}
