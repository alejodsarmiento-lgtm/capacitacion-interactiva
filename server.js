/**
 * Capacitación interactiva — Inspección del trabajo en casas particulares
 * MTPBA — Argentina · Guatemala
 * Node.js + Express + Socket.io — estado en memoria, todo async.
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 30000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'mtpba2026';

// ---------- Estado en memoria ----------
const ACTIVITIES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'activities.json'), 'utf8')
).activities;

const state = {
  participants: new Map(),      // socketId -> {nombre, pais, rol, joinedAt}
  currentActivityId: null,
  revealed: false,
  responses: new Map(),         // activityId -> Map(participantKey -> answer)
  scores: { AR: 0, GT: 0 },     // duelo por país
  scoreEvents: [],              // detalle para export
  semaforo: new Map(),          // socketId -> 'verde'|'amarillo'|'rojo'
  questions: [],                // {id, text, autor, pais, votes:Set, answered, ts}
  log: []                       // export: cada respuesta con metadata
};
let questionSeq = 1;

// ---------- Helpers ----------
function participantKey(socket) {
  const p = state.participants.get(socket.id);
  return p ? `${p.nombre}|${p.pais}|${p.rol}` : socket.id;
}

function getActivity(id) {
  return ACTIVITIES.find(a => a.id === id) || null;
}

function actMeta(id) {
  const idx = ACTIVITIES.findIndex(a => a.id === id);
  return { idx: idx + 1, total: ACTIVITIES.length };
}

function publicStats() {
  let ar = 0, gt = 0;
  for (const p of state.participants.values()) {
    if (p.pais === 'AR') ar++; else if (p.pais === 'GT') gt++;
  }
  return { total: state.participants.size, ar, gt, scores: state.scores };
}

function semaforoStats() {
  const c = { verde: 0, amarillo: 0, rojo: 0 };
  const byRol = {};
  for (const [sid, color] of state.semaforo) {
    if (!state.participants.has(sid)) continue;
    c[color] = (c[color] || 0) + 1;
    const rol = state.participants.get(sid).rol;
    byRol[rol] = byRol[rol] || { verde: 0, amarillo: 0, rojo: 0 };
    byRol[rol][color]++;
  }
  return { colors: c, byRol };
}

function aggregate(activityId) {
  const act = getActivity(activityId);
  if (!act) return null;
  const resp = state.responses.get(activityId) || new Map();
  const paisOf = k => k.split('|')[1] || '??';

  if (act.type === 'quiz' || (act.type === 'poll' && !act.byCountry)) {
    const counts = act.options.map(() => 0);
    for (const ans of resp.values()) if (counts[ans.value] !== undefined) counts[ans.value]++;
    return { type: act.type, counts, total: resp.size, correct: act.correct, explain: act.explain };
  }
  if (act.type === 'poll' && act.byCountry) {
    const AR = act.options.map(() => 0), GT = act.options.map(() => 0);
    for (const [k, ans] of resp) {
      const arr = paisOf(k) === 'GT' ? GT : AR;
      if (arr[ans.value] !== undefined) arr[ans.value]++;
    }
    return { type: 'pollCountry', AR, GT, total: resp.size };
  }
  if (act.type === 'classify') {
    // heat[cardId] = [countCat0, countCat1, countCat2]
    const heat = {};
    for (const card of act.cards) heat[card.id] = act.categories.map(() => 0);
    for (const ans of resp.values()) {
      for (const [cardId, cat] of Object.entries(ans.value || {})) {
        if (heat[cardId] && heat[cardId][cat] !== undefined) heat[cardId][cat]++;
      }
    }
    return { type: 'classify', heat, total: resp.size, cards: act.cards, categories: act.categories, explain: act.explain };
  }
  if (act.type === 'wordcloud') {
    const words = {};
    for (const ans of resp.values()) {
      const w = String(ans.value || '').trim().toLowerCase().slice(0, 24);
      if (!w) continue;
      words[w] = (words[w] || 0) + 1;
    }
    const top = Object.entries(words).sort((a, b) => b[1] - a[1]).slice(0, 60);
    return { type: 'wordcloud', words: top, total: resp.size };
  }
  return null;
}

// Broadcast de resultados con throttle (máx. cada 400 ms) hacia admin + pantalla
let dirty = false;
setInterval(() => {
  if (!dirty || !state.currentActivityId) return;
  dirty = false;
  const agg = aggregate(state.currentActivityId);
  io.to('staff').emit('results', { activityId: state.currentActivityId, agg, revealed: state.revealed });
  if (state.revealed) io.to('sala').emit('results', { activityId: state.currentActivityId, agg, revealed: true });
}, 400);

setInterval(() => {
  io.to('staff').emit('stats', publicStats());
  io.to('staff').emit('semaforo', semaforoStats());
}, 1500);

function questionsPayload() {
  return state.questions
    .map(q => ({ id: q.id, text: q.text, autor: q.autor, pais: q.pais, votes: q.votes.size, answered: q.answered }))
    .sort((a, b) => (a.answered - b.answered) || (b.votes - a.votes))
    .slice(0, 100);
}
let qDirty = false;
setInterval(() => {
  if (!qDirty) return;
  qDirty = false;
  io.emit('questions', questionsPayload());
}, 800);

// ---------- Socket.io ----------
io.on('connection', socket => {
  // --- Participante ---
  socket.on('join', (data, cb) => {
    const nombre = String(data?.nombre || '').trim().slice(0, 40);
    const pais = ['AR', 'GT'].includes(data?.pais) ? data.pais : 'AR';
    const rol = ['inspector', 'funcionario', 'abogado', 'otro'].includes(data?.rol) ? data.rol : 'otro';
    if (!nombre) return cb && cb({ ok: false, error: 'Falta el nombre' });
    state.participants.set(socket.id, { nombre, pais, rol, joinedAt: Date.now() });
    socket.join('sala');
    const act = state.currentActivityId ? getActivity(state.currentActivityId) : null;
    cb && cb({
      ok: true,
      current: act ? sanitizeActivity(act) : null,
      meta: act ? actMeta(act.id) : null,
      revealed: state.revealed,
      agg: state.revealed && act ? aggregate(act.id) : null,
      questions: questionsPayload(),
      stats: publicStats()
    });
    io.to('staff').emit('stats', publicStats());
  });

  socket.on('respond', (data, cb) => {
    const p = state.participants.get(socket.id);
    if (!p) return cb && cb({ ok: false, error: 'No registrado' });
    const actId = data?.activityId;
    if (actId !== state.currentActivityId || state.revealed) {
      return cb && cb({ ok: false, error: 'La actividad no está abierta' });
    }
    const act = getActivity(actId);
    if (!act) return cb && cb({ ok: false });

    if (!state.responses.has(actId)) state.responses.set(actId, new Map());
    const resp = state.responses.get(actId);
    const key = participantKey(socket);
    const already = resp.has(key);
    resp.set(key, { value: data.value, ts: Date.now() });

    // puntaje del duelo por país (solo quiz, solo primera respuesta)
    if (act.type === 'quiz' && !already && data.value === act.correct) {
      state.scores[p.pais] = (state.scores[p.pais] || 0) + 1;
      state.scoreEvents.push({ actId, pais: p.pais, ts: Date.now() });
    }
    // classify: puntaje por tarjetas correctas, primera respuesta
    if (act.type === 'classify' && !already) {
      let pts = 0;
      for (const card of act.cards) {
        if ((data.value || {})[card.id] === card.correct) pts++;
      }
      if (pts > 0) {
        state.scores[p.pais] = (state.scores[p.pais] || 0) + pts;
        state.scoreEvents.push({ actId, pais: p.pais, pts, ts: Date.now() });
      }
    }

    state.log.push({
      ts: new Date().toISOString(), activityId: actId, tipo: act.type,
      nombre: p.nombre, pais: p.pais, rol: p.rol, valor: JSON.stringify(data.value)
    });
    dirty = true;
    cb && cb({ ok: true });
  });

  socket.on('semaforo', color => {
    if (!state.participants.has(socket.id)) return;
    if (!['verde', 'amarillo', 'rojo'].includes(color)) return;
    state.semaforo.set(socket.id, color);
  });

  socket.on('question', (data, cb) => {
    const p = state.participants.get(socket.id);
    if (!p) return cb && cb({ ok: false });
    const text = String(data?.text || '').trim().slice(0, 240);
    if (text.length < 5) return cb && cb({ ok: false, error: 'Muy corta' });
    if (state.questions.filter(q => q.autorId === socket.id && !q.answered).length >= 5) {
      return cb && cb({ ok: false, error: 'Máximo 5 preguntas pendientes' });
    }
    state.questions.push({
      id: questionSeq++, text, autor: p.nombre, autorId: socket.id,
      pais: p.pais, votes: new Set(), answered: false, ts: Date.now()
    });
    qDirty = true;
    cb && cb({ ok: true });
  });

  socket.on('voteQuestion', qid => {
    if (!state.participants.has(socket.id)) return;
    const q = state.questions.find(x => x.id === qid);
    if (!q) return;
    if (q.votes.has(socket.id)) q.votes.delete(socket.id); else q.votes.add(socket.id);
    qDirty = true;
  });

  // --- Staff (admin + pantalla) ---
  socket.on('staffJoin', (data, cb) => {
    if (data?.token !== ADMIN_TOKEN) return cb && cb({ ok: false, error: 'Token inválido' });
    socket.join('staff');
    socket.data.isAdmin = data.role === 'admin';
    const act = state.currentActivityId ? getActivity(state.currentActivityId) : null;
    cb && cb({
      ok: true,
      activities: ACTIVITIES.map(a => ({ id: a.id, type: a.type, bloque: a.bloque, title: a.title })),
      current: act ? sanitizeActivity(act) : null,
      revealed: state.revealed,
      agg: act ? aggregate(act.id) : null,
      stats: publicStats(),
      semaforo: semaforoStats(),
      questions: questionsPayload()
    });
  });

  socket.on('admin:start', (actId, cb) => {
    if (!socket.data.isAdmin) return;
    const act = getActivity(actId);
    if (!act) return cb && cb({ ok: false });
    state.currentActivityId = actId;
    state.revealed = false;
    if (!state.responses.has(actId)) state.responses.set(actId, new Map());
    io.to('sala').emit('activity', { activity: sanitizeActivity(act), revealed: false, meta: actMeta(actId) });
    io.to('staff').emit('activity', { activity: sanitizeActivity(act), revealed: false, meta: actMeta(actId) });
    dirty = true;
    cb && cb({ ok: true });
  });

  socket.on('admin:reveal', cb => {
    if (!socket.data.isAdmin || !state.currentActivityId) return;
    state.revealed = true;
    const act = getActivity(state.currentActivityId);
    const agg = aggregate(state.currentActivityId);
    io.emit('revealed', { activityId: act.id, agg, activity: fullActivity(act), scores: state.scores });
    cb && cb({ ok: true });
  });

  socket.on('admin:idle', cb => {
    if (!socket.data.isAdmin) return;
    state.currentActivityId = null;
    state.revealed = false;
    io.emit('idle', { scores: state.scores });
    cb && cb({ ok: true });
  });

  socket.on('admin:answerQuestion', qid => {
    if (!socket.data.isAdmin) return;
    const q = state.questions.find(x => x.id === qid);
    if (q) { q.answered = true; qDirty = true; }
  });

  socket.on('disconnect', () => {
    state.participants.delete(socket.id);
    state.semaforo.delete(socket.id);
  });
});

// El participante no debe recibir la respuesta correcta antes del reveal
function sanitizeActivity(act) {
  const { correct, explain, cards, ...rest } = act;
  const out = { ...rest };
  if (cards) out.cards = cards.map(({ id, text }) => ({ id, text }));
  return out;
}
function fullActivity(act) {
  const out = { ...act };
  return out;
}

// ---------- HTTP ----------
app.use(express.static(path.join(__dirname, 'public')));

app.get('/salud', (req, res) => res.json({ ok: true, ...publicStats() }));

app.get('/export.csv', (req, res) => {
  if (req.query.token !== ADMIN_TOKEN) return res.status(403).send('Token inválido');
  const header = 'timestamp,actividad,tipo,nombre,pais,rol,respuesta\n';
  const rows = state.log.map(r =>
    [r.ts, r.activityId, r.tipo, csv(r.nombre), r.pais, r.rol, csv(r.valor)].join(',')
  ).join('\n');
  const qHeader = '\n\npregunta_id,texto,autor,pais,votos,respondida\n';
  const qRows = state.questions.map(q =>
    [q.id, csv(q.text), csv(q.autor), q.pais, q.votes.size, q.answered ? 'si' : 'no'].join(',')
  ).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="capacitacion_resultados.csv"');
  res.send('\uFEFF' + header + rows + qHeader + qRows);
});
function csv(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }

server.listen(PORT, () => {
  console.log(`Capacitación MTPBA escuchando en puerto ${PORT}`);
  console.log(`Participantes: /  ·  Admin: /admin.html  ·  Pantalla: /pantalla.html`);
});
