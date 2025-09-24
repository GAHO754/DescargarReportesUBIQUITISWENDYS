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
const qEl      = document.getElementById('q');
const fromEl   = document.getElementById('from');
const toEl     = document.getElementById('to');
const bmonthEl = document.getElementById('bmonth');
const btnApply = document.getElementById('btnApply');

const tbody    = document.getElementById('tbody');
const btnPrev  = document.getElementById('prevPage');
const btnNext  = document.getElementById('nextPage');
const pageInfo = document.getElementById('pageInfo');
const btnExport= document.getElementById('btnExport');

let page = 1;
let pageSize = 50;
let lastDoc = null;
let prevStack = []; // para retroceder páginas
let currentRows = []; // para exportar

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
      // Volver una página: usamos el stack de "inicios"
      const pop = prevStack.pop();
      if (!pop){ page = 1; lastDoc = null; }
      else {
        // Reinicia consulta hasta el doc de inicio de la página anterior
        ref = buildQuery().startAt(pop);
        page = Math.max(1, page - 1);
      }
    }

    const snap = await ref.get();
    const rows = [];
    if (snap.empty){
      renderRows([]);
      updatePager(false, false);
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
        fullName: d.fullName || '',
        email: d.email || '',
        phone: d.phone || '',
        birthday: d.birthday || '',
        createdAt: d.createdAt?.toDate ? d.createdAt.toDate() : null,
        source: d.source || ''
      });
    });

    // Búsqueda cliente (front) q en nombre/correo/teléfono
    const q = (qEl.value || '').trim().toLowerCase();
    let filtered = rows;
    if (q){
      filtered = rows.filter(r =>
        r.fullName.toLowerCase().includes(q) ||
        r.email.toLowerCase().includes(q) ||
        r.phone.toLowerCase().includes(q)
      );
    }

    // Filtro por mes de cumpleaños
    const m = bmonthEl.value;
    if (m){
      filtered = filtered.filter(r => {
        // r.birthday es YYYY-MM-DD string
        const mm = (r.birthday || '').split('-')[1];
        return mm === m;
      });
    }

    renderRows(filtered);
    lastDoc = snap.docs[snap.docs.length - 1] || null;
    // pager
    updatePager(prevStack.length > 1, snap.size === pageSize);
  } catch(e){
    console.error(e);
    alert('Error al cargar datos.');
  } finally{
    setLoading(false);
  }
}

function renderRows(rows){
  currentRows = rows || [];
  tbody.innerHTML = '';
  if (!rows.length){
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
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
    `;
    tbody.appendChild(tr);
  }
  pageInfo.textContent = `Página ${page}`;
}

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
  const header = ['Nombre','Correo','Teléfono','Cumpleaños','Creado','Fuente'];
  const lines = [header.join(',')];
  for (const r of currentRows){
    const row = [
      csvCell(r.fullName),
      csvCell(r.email),
      csvCell(r.phone),
      csvCell(r.birthday),
      csvCell(r.createdAt ? fmtDateTime(r.createdAt) : ''),
      csvCell(r.source || 'webform'),
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
  // Encierra en comillas si contiene coma o comillas
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g,'""')}"`;
  return v;
}
function setLoading(x){
  document.body.style.cursor = x ? 'progress' : 'default';
}
