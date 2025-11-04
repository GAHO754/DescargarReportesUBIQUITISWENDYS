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
    if (mergeDupEl.checked){
      filtered = mergeDuplicates(filtered);
    }

    // Solo frecuentes (visitCount >= N)
    if (onlyFreqEl.checked){
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

/* Exportar CSV (filas mostradas) */
btnExport?.addEventListener('click', () => {
  if (!currentRows.length){
    alert('No hay datos para exportar.');
    return;
  }
  const header = ['Nombre','Correo','Teléfono','Cumpleaños','Creado','Fuente','Visitas','Última visita','Min. última sesión'];
  const lines = [header.join(',')];
  for (const r of currentRows){
    const row = [
      csvCell(r.fullName),
      csvCell(r.email),
      csvCell(r.phone),
      csvCell(r.birthday),
      csvCell(r.createdAt ? fmtDateTime(r.createdAt) : ''),
      csvCell(r.source || 'webform'),
      csvCell(r.visitCount ?? ''),
      csvCell(r.lastVisit ? fmtDateTime(r.lastVisit) : ''),
      csvCell(r.lastSessionMinutes != null ? String(r.lastSessionMinutes) : ''),
    ].join(',');
    lines.push(row);
  }
  const blob = new Blob([lines.join('\n')], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const ts = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
  a.download = `leads_${ts}.csv`;
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(url);
  a.remove();
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
function csvCell(s){
  const v = String(s ?? '');
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g,'""')}"`;
  return v;
}
function setLoading(x){
  document.body.style.cursor = x ? 'progress' : 'default';
}
