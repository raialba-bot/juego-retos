const localKey = () => 'juego_retos_state_v4_' + grupoId;
const COLA_RETOS = 22;
let grupos = [{ id: '4ESO_A', nombre: '4º ESO A' }];
let grupoId = localStorage.getItem('juego_retos_grupo') || '4ESO_A';
let retos = RETOS.map(r => ({ ...r }));
let RETO_POR_ID = {};
const reindex = () => { RETO_POR_ID = Object.fromEntries(retos.map(r => [r.id, r])); };
reindex();
let timerId = null, timerLeft = 0;

let db = null, auth = null, unsub = null;
let spinning = false, firstSnap = false, audioCtx = null;

const newStudent = name => ({ name, score: 0, antiShameUses: 0, absent: false, history: [] });
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nowLabel = () => new Date().toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const signo = n => (n > 0 ? '+' + n : n < 0 ? '−' + Math.abs(n) : '0');
const rand = arr => arr[Math.floor(Math.random() * arr.length)];

function estadoInicial() {
  const nombres = grupoId === '4ESO_A' ? ALUMNOS : [];
  return { students: nombres.map(newStudent), studentDeck: [...nombres], blockedChallenges: [], currentStudentName: null,
    currentChallengeId: null, pending: false, message: '', updatedAt: 0 };
}
const state = estadoInicial();

const renombrar = n => (RENOMBRAR[n] || n);
const presentes = () => state.students.filter(s => !s.absent).map(s => s.name);
const findStudent = name => state.students.find(s => s.name === name);

// ---------- Login ----------
function login() {
  document.getElementById('login-msg').textContent = '';
  auth.signInWithPopup(new firebase.auth.GoogleAuthProvider())
    .catch(e => { document.getElementById('login-msg').textContent = 'No se pudo entrar: ' + (e.code || e.message); });
}
function logout() { auth.signOut(); closeModal('config-modal'); }

function initApp() {
  firebase.initializeApp(firebaseConfig);
  auth = firebase.auth();
  db = firebase.firestore();
  auth.onAuthStateChanged(user => {
    const overlay = document.getElementById('login-overlay');
    if (user && user.email && user.email.toLowerCase() === PROFE_EMAIL.toLowerCase()) {
      overlay.style.display = 'none';
      startData();
    } else {
      if (unsub) { unsub(); unsub = null; }
      overlay.style.display = 'flex';
      if (user) {
        document.getElementById('login-msg').textContent = 'La cuenta ' + user.email + ' no tiene acceso.';
        auth.signOut();
      }
    }
  });
}

// ---------- Datos: local + Firestore ----------
function serialize() {
  state.updatedAt = Date.now();
  return JSON.parse(JSON.stringify(state));
}

function applyData(d) {
  if (!d) return;
  if (Array.isArray(d.students)) {
    state.students = d.students.map(s => ({
      name: renombrar(s.name), score: s.score || 0, antiShameUses: s.antiShameUses || 0,
      absent: !!s.absent, history: Array.isArray(s.history) ? s.history : []
    }));
  }
  if (Array.isArray(d.studentDeck)) state.studentDeck = d.studentDeck.map(renombrar);
  if (Array.isArray(d.blockedChallenges)) state.blockedChallenges = d.blockedChallenges.filter(id => RETO_POR_ID[id]);
  state.currentStudentName = d.currentStudentName ? renombrar(d.currentStudentName) : null;
  state.currentChallengeId = RETO_POR_ID[d.currentChallengeId] ? d.currentChallengeId : null;
  state.pending = !!d.pending && !!state.currentChallengeId;
  state.message = d.message || '';
  state.updatedAt = d.updatedAt || 0;
}

function setCloudStatus(kind, detail) {
  const el = document.getElementById('cloud-status');
  el.classList.remove('status-online', 'status-error');
  if (kind === 'ok') { el.textContent = '☁️ Guardado en la nube'; el.classList.add('status-online'); }
  else if (kind === 'saving') el.textContent = '⏳ Guardando...';
  else {
    el.textContent = detail === 'permission-denied' ? '⚠️ Sin permiso en Firestore (revisar reglas)' : '⚠️ NO se guarda en la nube' + (detail ? ' (' + detail + ')' : '');
    el.classList.add('status-error');
  }
}

async function startData() {
  try {
    const doc = await db.collection('ajustes').doc('general').get();
    if (doc.exists) {
      const d = doc.data();
      if (Array.isArray(d.grupos) && d.grupos.length) grupos = d.grupos;
      if (Array.isArray(d.retos) && d.retos.length) retos = d.retos;
    }
  } catch (e) { console.warn('No se pudieron leer los ajustes (¿reglas sin actualizar?):', e); }
  if (!grupos.some(g => g.id === grupoId)) grupoId = grupos[0].id;
  reindex();
  renderGrupos();
  cargarGrupo();
}

function cargarGrupo() {
  if (unsub) { unsub(); unsub = null; }
  stopTimer();
  Object.assign(state, estadoInicial());
  try { const raw = localStorage.getItem(localKey()); if (raw) applyData(JSON.parse(raw)); } catch (e) {}
  firstSnap = false;
  renderAll();
  if (unsub) unsub();
  const ref = db.collection('clases').doc(grupoId);
  unsub = ref.onSnapshot(doc => {
    if (doc.metadata.hasPendingWrites || spinning) return;
    if (!doc.exists) { firstSnap = true; saveState(); return; }
    const data = doc.data();
    if (!firstSnap && state.updatedAt > (data.updatedAt || 0)) { firstSnap = true; saveState(); return; }
    firstSnap = true;
    applyData(data);
    try { localStorage.setItem(localKey(), JSON.stringify(serialize())); } catch (e) {}
    setCloudStatus('ok');
    renderAll();
  }, err => { console.error('Error leyendo Firestore:', err); setCloudStatus('error', err && err.code); });
}

function saveState() {
  const data = serialize();
  try { localStorage.setItem(localKey(), JSON.stringify(data)); } catch (e) {}
  renderAll();
  if (!auth.currentUser) return;
  setCloudStatus('saving');
  db.collection('clases').doc(grupoId).set(data)
    .then(() => setCloudStatus('ok'))
    .catch(err => { console.error('Error guardando en Firestore:', err); setCloudStatus('error', err && err.code); });
}

// ---------- Sorteo ----------
function getNextStudent() {
  const pres = new Set(presentes());
  state.studentDeck = state.studentDeck.filter(n => pres.has(n));
  if (!state.studentDeck.length) state.studentDeck = [...pres];
  if (!state.studentDeck.length) return null;
  return state.studentDeck.splice(Math.floor(Math.random() * state.studentDeck.length), 1)[0];
}

function getNextChallenge() {
  let disp = retos.filter(r => !state.blockedChallenges.includes(r.id));
  if (!disp.length) { state.blockedChallenges = []; disp = retos; }
  const r = rand(disp);
  state.blockedChallenges.push(r.id);
  if (state.blockedChallenges.length > COLA_RETOS) state.blockedChallenges.shift();
  return r;
}

function playTickSound(freq = 800, vol = 0.03, dur = 0.04) {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
  gain.gain.setValueAtTime(vol, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
  osc.connect(gain); gain.connect(audioCtx.destination);
  osc.start(); osc.stop(audioCtx.currentTime + dur);
}

function startSpin() {
  stopTimer();
  const name = getNextStudent();
  if (!name) { alert('No hay alumnos presentes.'); return; }
  const reto = getNextChallenge();
  const slot = document.getElementById('slot-name');
  const btn = document.getElementById('btn-spin');
  spinning = true;
  btn.disabled = true;
  document.getElementById('live-controls').style.display = 'none';
  slot.classList.add('blur');

  const pool = presentes();
  let speed = 50, counter = 0;
  const total = 35;
  (function step() {
    slot.textContent = rand(pool);
    playTickSound();
    if (++counter < total) {
      if (counter > total - 10) speed += 25;
      setTimeout(step, speed);
      return;
    }
    slot.classList.remove('blur');
    state.currentStudentName = name;
    state.currentChallengeId = reto.id;
    state.pending = true;
    state.message = '';
    spinning = false;
    btn.disabled = false;
    confetti({ particleCount: 50, spread: 50, origin: { y: 0.7 } });
    if (reto.auto) applyResult(reto.pts, 'Recompensa', `🎁 ${name}: ${signo(reto.pts)} automático.` + (reto.claseOk ? ` Resto de la clase: ${signo(reto.claseOk)}.` : '') + ` ${reto.text}`, reto.claseOk || 0);
    else saveState();
  })();
}

// ---------- Resultados ----------
function addHistory(student, type, points, retoId) {
  const r = RETO_POR_ID[retoId];
  student.history.unshift({ type, points, challenge: r ? r.text : '', date: nowLabel() });
}

function applyResult(points, type, message, clase = 0) {
  const s = findStudent(state.currentStudentName);
  if (!s) return;
  s.score += points;
  addHistory(s, type, points, state.currentChallengeId);
  if (clase) {
    const r = RETO_POR_ID[state.currentChallengeId];
    const titulo = r ? r.text.split(':')[0].trim() : 'Reto';
    // Solo afecta al resto de alumnos presentes
    state.students.forEach(o => {
      if (o.absent || o.name === s.name) return;
      o.score += clase;
      addHistory(o, 'Clase: ' + titulo, clase, state.currentChallengeId);
    });
  }
  state.pending = false;
  state.message = message;
  saveState();
}

function recordResult(ok) {
  const r = RETO_POR_ID[state.currentChallengeId];
  if (!r || !state.pending) return;
  const pts = ok ? r.pts : -r.pen;
  const clase = (ok ? r.claseOk : r.claseKo) || 0;
  applyResult(pts, ok ? 'Cumplido' : 'No cumplido',
    `Resultado registrado: ${state.currentStudentName} (${signo(pts)})` + (clase ? ` · resto de la clase (${signo(clase)})` : ''), clase);
}

// ---------- Protocolo Anti-Vergüenza ----------
function openShame() {
  const s = findStudent(state.currentStudentName);
  if (!s || !state.pending) return;
  if (s.antiShameUses >= 2) { alert(`⚠️ ${s.name} ya ha agotado sus 2 usos del Protocolo Anti-Vergüenza.`); return; }
  document.getElementById('shame-info').textContent = `${s.name} (usos: ${s.antiShameUses}/2)`;
  openModal('shame-modal');
}

function shame(op) {
  const s = findStudent(state.currentStudentName);
  if (!s || !state.pending) return;
  closeModal('shame-modal');
  stopTimer();
  s.antiShameUses++;
  const original = state.currentChallengeId;
  if (op === 1) {
    const faciles = retos.filter(x => x.cat === 'pizarra' && x.facil && x.id !== original);
    const r = rand(faciles.length ? faciles : retos.filter(x => x.cat === 'pizarra' && x.id !== original));
    state.currentChallengeId = r.id;
    addHistory(s, 'Anti-Vergüenza: rescate matemático', 0, original);
  } else if (op === 2) {
    const otros = presentes().filter(n => n !== s.name);
    if (!otros.length) { s.antiShameUses--; alert('No hay otro alumno presente.'); return; }
    const nuevo = rand(otros);
    state.studentDeck = state.studentDeck.filter(n => n !== nuevo);
    state.currentStudentName = nuevo;
    addHistory(s, `Anti-Vergüenza: reto transferido a ${nuevo}`, 0, original);
  } else {
    state.pending = false;
    state.message = `🛡️ Paso silencioso para ${s.name} (uso ${s.antiShameUses}/2). Sin penalización.`;
    addHistory(s, 'Anti-Vergüenza: paso silencioso', 0, original);
  }
  saveState();
}

// ---------- Panel de alumnos ----------
function adjustScore(i, points) {
  const s = state.students[i];
  if (!s) return;
  s.score += points;
  s.history.unshift({ type: 'Manual', points, challenge: 'Ajuste manual', date: nowLabel() });
  saveState();
}

function undoLast(i) {
  const s = state.students[i];
  if (!s || !s.history.length) return;
  const last = s.history.shift();
  s.score -= last.points || 0;
  if (last.type.startsWith('Anti-Vergüenza') && s.antiShameUses > 0) s.antiShameUses--;
  saveState();
}

function toggleAbsent(i) {
  const s = state.students[i];
  if (!s) return;
  s.absent = !s.absent;
  saveState();
}

function openConfig() {
  document.getElementById('students-text').value = state.students.map(s => s.name).join('\n');
  openModal('config-modal');
}

function saveStudentList() {
  const nombres = [...new Set(document.getElementById('students-text').value.split('\n').map(n => n.trim()).filter(Boolean))];
  if (!nombres.length) { alert('La lista no puede estar vacía.'); return; }
  const quitados = state.students.filter(s => !nombres.includes(s.name)).map(s => s.name);
  if (quitados.length && !confirm(`Se eliminarán con todos sus puntos: ${quitados.join(', ')}. ¿Continuar?`)) return;
  state.students = nombres.map(n => findStudent(n) || newStudent(n));
  state.studentDeck = state.studentDeck.filter(n => nombres.includes(n));
  if (!nombres.includes(state.currentStudentName)) { state.currentStudentName = null; state.currentChallengeId = null; state.pending = false; }
  saveState();
  closeModal('config-modal');
}

function resetDatabase() {
  if (!confirm('⚠ ¿Confirmas reiniciar todos los puntos y registros a 0?')) return;
  state.students = state.students.map(s => newStudent(s.name));
  state.studentDeck = presentes();
  state.blockedChallenges = [];
  state.currentStudentName = null;
  state.currentChallengeId = null;
  state.pending = false;
  state.message = '';
  saveState();
  closeModal('config-modal');
}

// ---------- Pintado ----------
function renderCurrent() {
  if (spinning) return;
  const slot = document.getElementById('slot-name');
  const box = document.getElementById('challenge-display');
  const live = document.getElementById('live-controls');
  const r = RETO_POR_ID[state.currentChallengeId];
  const seg = state.pending && r ? tiempoReto(r.text) : 0;
  const tb = document.getElementById('timer-box');
  if (!seg) { stopTimer(); tb.style.display = 'none'; }
  else {
    tb.style.display = 'flex';
    if (!timerId) {
      document.getElementById('btn-timer').textContent = `⏱️ Cuenta atrás (${fmtT(seg)})`;
      document.getElementById('timer-display').textContent = '';
    }
  }
  if (!state.currentStudentName) {
    slot.textContent = '¿Quién empieza?';
    box.textContent = 'Presiona el botón para seleccionar a un alumno y un reto al azar...';
    live.style.display = 'none';
    return;
  }
  slot.textContent = state.currentStudentName;
  if (state.pending && r) {
    box.textContent = r.text;
    const extra = n => (n ? ` · clase ${signo(n)}` : '');
    document.getElementById('btn-ok').textContent = `✅ Cumplido (${signo(r.pts)}${extra(r.claseOk)})`;
    document.getElementById('btn-ko').textContent = `❌ No Realizado (${signo(-r.pen)}${extra(r.claseKo)})`;
    live.style.display = 'grid';
  } else {
    box.textContent = state.message || (r ? r.text : '');
    live.style.display = 'none';
  }
}

function renderStudents() {
  document.getElementById('students-grid').innerHTML = state.students.map((s, i) => {
    const pos = s.history.reduce((a, h) => a + (h.points > 0 ? h.points : 0), 0);
    const neg = s.history.reduce((a, h) => a + (h.points < 0 ? -h.points : 0), 0);
    const ult = s.history.slice(0, 6).map(h =>
      `<li>${esc(h.date)} · ${esc(h.type)}${h.points ? ' (' + (h.points > 0 ? '+' : '') + h.points + ')' : ''}</li>`).join('');
    return `
    <div class="student-card ${s.absent ? 'absent' : ''}">
      <div class="student-card-header">
        <strong>${esc(s.name)}</strong>
        <span class="student-score ${s.score >= 0 ? 'score-pos' : 'score-neg'}">${s.score > 0 ? '+' + s.score : s.score} pts</span>
      </div>
      <div class="antishame-tracker">👍 ${pos} positivos · 👎 ${neg} negativos · 🛡️ ${s.antiShameUses}/2</div>
      <div class="manual-row">
        <button class="btn-success btn-mini" onclick="adjustScore(${i}, 1)">+1</button>
        <button class="btn-danger btn-mini" onclick="adjustScore(${i}, -1)">−1</button>
        <button class="btn-mini btn-ghost" onclick="undoLast(${i})" ${s.history.length ? '' : 'disabled'}>↩ Deshacer</button>
      </div>
      <label class="ausente"><input type="checkbox" ${s.absent ? 'checked' : ''} onchange="toggleAbsent(${i})"> Ausente</label>
      ${ult ? `<details class="hist"><summary>Historial</summary><ul>${ult}</ul></details>` : ''}
    </div>`;
  }).join('');
}

function renderDeck() {
  const pres = presentes().length;
  const pend = state.studentDeck.filter(n => presentes().includes(n)).length;
  document.getElementById('deck-counter').textContent = `Alumnos pendientes en ronda: ${pend}/${pres} presentes`;
  document.getElementById('blocked-challenges-counter').textContent = `🔒 Retos en lista de espera (últimos ${COLA_RETOS} turnos): ${state.blockedChallenges.length}/${COLA_RETOS}`;
}

function renderAll() { renderStudents(); renderDeck(); renderCurrent(); }
function openModal(id) { document.getElementById(id).style.display = 'flex'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }

// ---------- Cuenta atrás ----------
function tiempoReto(text) {
  const m = text.match(/(\d+)\s*(segundos?|minutos?)/i);
  return m ? parseInt(m[1], 10) * (/^min/i.test(m[2]) ? 60 : 1) : 0;
}
const fmtT = s => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
function stopTimer() { if (timerId) clearInterval(timerId); timerId = null; }

function toggleTimer() {
  const r = RETO_POR_ID[state.currentChallengeId];
  if (!r) return;
  const total = tiempoReto(r.text);
  const disp = document.getElementById('timer-display'), btn = document.getElementById('btn-timer');
  if (timerId) { stopTimer(); disp.textContent = ''; btn.textContent = `⏱️ Cuenta atrás (${fmtT(total)})`; return; }
  timerLeft = total;
  disp.textContent = fmtT(timerLeft);
  btn.textContent = '⏹ Parar';
  timerId = setInterval(() => {
    timerLeft--;
    disp.textContent = fmtT(Math.max(timerLeft, 0));
    if (timerLeft <= 0) {
      stopTimer();
      disp.textContent = '¡Tiempo!';
      btn.textContent = '⏱️ Repetir';
      [0, 300, 600].forEach(t => setTimeout(() => playTickSound(1000, 0.15, 0.25), t));
    }
  }, 1000);
}

// ---------- Grupos ----------
function renderGrupos() {
  document.getElementById('grupo-select').innerHTML = grupos.map(g =>
    `<option value="${esc(g.id)}" ${g.id === grupoId ? 'selected' : ''}>${esc(g.nombre)}</option>`).join('');
}

function guardarAjustes() {
  return db.collection('ajustes').doc('general').set({ grupos, retos })
    .then(() => setCloudStatus('ok'))
    .catch(err => { console.error('Error guardando ajustes:', err); setCloudStatus('error', err && err.code); });
}

function cambiarGrupo(id) {
  grupoId = id;
  localStorage.setItem('juego_retos_grupo', id);
  renderGrupos();
  cargarGrupo();
}

function nuevoGrupo() {
  const nombre = (prompt('Nombre del nuevo grupo (por ejemplo, 3º ESO B):') || '').trim();
  if (!nombre) return;
  const id = 'g' + Date.now();
  grupos.push({ id, nombre });
  guardarAjustes();
  closeModal('config-modal');
  cambiarGrupo(id);
}

function renombrarGrupo() {
  const g = grupos.find(x => x.id === grupoId);
  const nombre = (prompt('Nuevo nombre del grupo:', g.nombre) || '').trim();
  if (!nombre) return;
  g.nombre = nombre;
  guardarAjustes();
  renderGrupos();
}

function eliminarGrupo() {
  if (grupos.length < 2) { alert('Tiene que quedar al menos un grupo.'); return; }
  const g = grupos.find(x => x.id === grupoId);
  if (!confirm(`¿Eliminar el grupo «${g.nombre}» con todos sus puntos?`)) return;
  grupos = grupos.filter(x => x.id !== g.id);
  guardarAjustes();
  closeModal('config-modal');
  cambiarGrupo(grupos[0].id);          // primero se deja de escuchar el grupo viejo
  db.collection('clases').doc(g.id).delete().catch(console.error);
}

// ---------- Editor de retos ----------
function openRetos() { renderRetosEditor(); openModal('retos-modal'); }

function renderRetosEditor() {
  document.getElementById('retos-list').innerHTML = retos.map((r, i) => `
    <div class="reto-row">
      <textarea data-i="${i}" data-f="text">${esc(r.text)}</textarea>
      <select data-i="${i}" data-f="cat">${['pizarra', 'general', 'alumnado', 'clase'].map(c => `<option ${r.cat === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
      <input type="number" data-i="${i}" data-f="pts" value="${r.pts}">
      <input type="number" min="0" data-i="${i}" data-f="pen" value="${r.pen}">
      <input type="number" data-i="${i}" data-f="claseOk" value="${r.claseOk || 0}">
      <input type="number" data-i="${i}" data-f="claseKo" value="${r.claseKo || 0}">
      <button class="btn-danger btn-mini" onclick="borrarReto(${i})">🗑</button>
    </div>`).join('');
}

function leerRetos() {
  document.querySelectorAll('#retos-list [data-f]').forEach(el => {
    const r = retos[el.dataset.i], f = el.dataset.f;
    if (r) r[f] = el.type === 'number' ? (parseInt(el.value, 10) || 0) : el.value.trim();
  });
}

function anadirReto() {
  leerRetos();
  retos.push({ id: 'u' + Date.now(), cat: 'general', text: 'Nuevo reto: ', pts: 1, pen: 1 });
  renderRetosEditor();
  const l = document.getElementById('retos-list');
  l.lastElementChild.scrollIntoView();
}

function borrarReto(i) {
  leerRetos();
  if (!confirm('¿Borrar este reto?')) return;
  retos.splice(i, 1);
  renderRetosEditor();
}

function restaurarRetos() {
  if (!confirm('¿Volver a los retos originales? Se pierden tus cambios en los retos.')) return;
  retos = RETOS.map(r => ({ ...r }));
  renderRetosEditor();
}

function guardarRetos() {
  leerRetos();
  retos = retos.filter(r => r.text);
  retos.forEach(r => {
    r.pen = Math.abs(r.pen);
    if (!r.claseOk) delete r.claseOk;
    if (!r.claseKo) delete r.claseKo;
  });
  if (!retos.length) { alert('Tiene que haber al menos un reto.'); return; }
  reindex();
  state.blockedChallenges = state.blockedChallenges.filter(id => RETO_POR_ID[id]);
  if (!RETO_POR_ID[state.currentChallengeId]) { state.currentChallengeId = null; state.pending = false; }
  guardarAjustes();
  saveState();
  closeModal('retos-modal');
}

// ---------- Exportar a Excel (CSV) ----------
function exportarCSV(tipo) {
  const q = v => { v = String(v == null ? '' : v); return /[;"\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const filas = [];
  if (tipo === 'resumen') {
    filas.push(['Alumno', 'Puntos', 'Positivos', 'Negativos', 'Usos protocolo', 'Ausente']);
    state.students.forEach(s => filas.push([s.name, s.score,
      s.history.reduce((t, h) => t + (h.points > 0 ? h.points : 0), 0),
      s.history.reduce((t, h) => t + (h.points < 0 ? -h.points : 0), 0),
      s.antiShameUses, s.absent ? 'Sí' : 'No']));
  } else {
    filas.push(['Alumno', 'Fecha', 'Tipo', 'Puntos', 'Reto']);
    state.students.forEach(s => s.history.slice().reverse().forEach(h => filas.push([s.name, h.date, h.type, h.points, h.challenge])));
  }
  const csv = '\ufeff' + filas.map(f => f.map(q).join(';')).join('\r\n');
  const g = grupos.find(x => x.id === grupoId);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  link.download = `${(g ? g.nombre : 'grupo').replace(/\s+/g, '_')}_${tipo}_${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// ---------- Copia completa (para migrar a la versión Hoja de cálculo) ----------
async function exportarCopia() {
  try {
    const snap = await db.collection('clases').get();
    const gr = {};
    snap.forEach(d => { gr[d.id] = d.data(); });
    let ajustes = { grupos };
    try { const aj = await db.collection('ajustes').doc('general').get(); if (aj.exists) ajustes = aj.data(); } catch (e) {}
    const copia = { version: 1, fecha: new Date().toISOString(), ajustes, grupos: gr };
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(copia)], { type: 'application/json' }));
    link.download = `copia_juego_retos_${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  } catch (e) { alert('No se pudo exportar: ' + (e.code || e.message)); }
}

window.onload = initApp;
