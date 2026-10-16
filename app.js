const LOCAL_KEY = 'juego_retos_state_v3';
const COLA_RETOS = 22;
const RETO_POR_ID = Object.fromEntries(RETOS.map(r => [r.id, r]));

let db = null, auth = null, unsub = null;
let spinning = false, firstSnap = false, audioCtx = null;

const newStudent = name => ({ name, score: 0, antiShameUses: 0, absent: false, history: [] });
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nowLabel = () => new Date().toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const rand = arr => arr[Math.floor(Math.random() * arr.length)];

const state = {
  students: ALUMNOS.map(newStudent),
  studentDeck: [...ALUMNOS],
  blockedChallenges: [],
  currentStudentName: null,
  currentChallengeId: null,
  pending: false,
  message: '',
  updatedAt: 0
};

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

function startData() {
  try { const raw = localStorage.getItem(LOCAL_KEY); if (raw) applyData(JSON.parse(raw)); } catch (e) {}
  firstSnap = false;
  renderAll();
  if (unsub) unsub();
  const ref = db.collection('clases').doc('4ESO_A');
  unsub = ref.onSnapshot(doc => {
    if (doc.metadata.hasPendingWrites || spinning) return;
    if (!doc.exists) { firstSnap = true; saveState(); return; }
    const data = doc.data();
    if (!firstSnap && state.updatedAt > (data.updatedAt || 0)) { firstSnap = true; saveState(); return; }
    firstSnap = true;
    applyData(data);
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(serialize())); } catch (e) {}
    setCloudStatus('ok');
    renderAll();
  }, err => { console.error('Error leyendo Firestore:', err); setCloudStatus('error', err && err.code); });
}

function saveState() {
  const data = serialize();
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(data)); } catch (e) {}
  renderAll();
  if (!auth.currentUser) return;
  setCloudStatus('saving');
  db.collection('clases').doc('4ESO_A').set(data)
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
  let disp = RETOS.filter(r => !state.blockedChallenges.includes(r.id));
  if (!disp.length) { state.blockedChallenges = []; disp = RETOS; }
  const r = rand(disp);
  state.blockedChallenges.push(r.id);
  if (state.blockedChallenges.length > COLA_RETOS) state.blockedChallenges.shift();
  return r;
}

function playTickSound() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(800, audioCtx.currentTime);
  gain.gain.setValueAtTime(0.03, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.04);
  osc.connect(gain); gain.connect(audioCtx.destination);
  osc.start(); osc.stop(audioCtx.currentTime + 0.04);
}

function startSpin() {
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
    if (reto.auto) applyResult(reto.pts, 'Recompensa', `🎁 ${name}: +${reto.pts} automático. ${reto.text}`);
    else saveState();
  })();
}

// ---------- Resultados ----------
function addHistory(student, type, points, retoId) {
  const r = RETO_POR_ID[retoId];
  student.history.unshift({ type, points, challenge: r ? r.text : '', date: nowLabel() });
}

function applyResult(points, type, message) {
  const s = findStudent(state.currentStudentName);
  if (!s) return;
  s.score += points;
  addHistory(s, type, points, state.currentChallengeId);
  state.pending = false;
  state.message = message;
  saveState();
}

function recordResult(ok) {
  const r = RETO_POR_ID[state.currentChallengeId];
  if (!r || !state.pending) return;
  const pts = ok ? r.pts : -r.pen;
  applyResult(pts, ok ? 'Cumplido' : 'No cumplido', `Resultado registrado: ${state.currentStudentName} (${pts > 0 ? '+' + pts : pts})`);
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
  s.antiShameUses++;
  const original = state.currentChallengeId;
  if (op === 1) {
    const r = rand(RETOS.filter(x => x.cat === 'pizarra' && x.id !== original));
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
  if (!state.currentStudentName) {
    slot.textContent = '¿Quién empieza?';
    box.textContent = 'Presiona el botón para seleccionar a un alumno y un reto al azar...';
    live.style.display = 'none';
    return;
  }
  slot.textContent = state.currentStudentName;
  if (state.pending && r) {
    box.textContent = r.text;
    document.getElementById('btn-ok').textContent = `✅ Cumplido (+${r.pts})`;
    document.getElementById('btn-ko').textContent = `❌ No Realizado (-${r.pen})`;
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

window.onload = initApp;
