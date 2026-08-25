/**
 * ENSAYO GENERAL MASIVO — 6 países, comportamiento humano, recorrido completo
 * Simula la jornada real: ingreso escalonado, respuestas con ritmo humano en las 14
 * actividades, nube de palabras EN VIVO (gate: enviar primero), semáforo cambiante,
 * preguntas y votos de fondo. Cubre AR, US, GT, NI, RD, EC.
 *
 * Uso:  ADMIN_TOKEN=xxx node test/ensayo-general.js [N] [URL]
 */
const path = require('path');
const { io } = require('socket.io-client');
const ACTIVITIES = require(path.join(__dirname, '..', 'data', 'activities.json')).activities;

const N = parseInt(process.argv[2] || '240', 10);
const URL = process.argv[3] || 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'mtpba2026';
const RAPIDO = !!process.env.RAPIDO;
const VENTANA = RAPIDO ? 1500 : 8000;
const PAUSA = RAPIDO ? 300 : 2200;

// --- 6 países: AR y GT como banderas nativas, el resto como "Otro" con texto ---
const PAISES = [
  { code: 'AR', label: 'Argentina', native: true, peso: 3 },
  { code: 'GT', label: 'Guatemala', native: true, peso: 3 },
  { code: 'OT', label: 'Estados Unidos', native: false, peso: 1 },
  { code: 'OT', label: 'Nicaragua', native: false, peso: 1 },
  { code: 'OT', label: 'República Dominicana', native: false, peso: 1 },
  { code: 'OT', label: 'Ecuador', native: false, peso: 1 }
];
// pool ponderado (AR y GT más numerosos, como en el evento real)
const POOL = [];
PAISES.forEach(p => { for (let i = 0; i < p.peso; i++) POOL.push(p); });

const ROLES = ['inspector', 'inspector', 'funcionario', 'abogado', 'trabajador', 'otro'];
const NOMBRES = ['María', 'Juan', 'Carlos', 'Ana', 'Byron', 'Wendy', 'Estuardo', 'Claudia', 'John', 'Rosa',
  'Diego', 'Sofía', 'Luis', 'Carmen', 'Marvin', 'Alejandra', 'José', 'Elena', 'Franklin', 'Yamileth'];
const PALABRAS = ['derechos', 'dignidad', 'trabajo', 'registración', 'inspección', 'protección',
  'ley', 'justicia', 'cuidado', 'igualdad', 'respeto', 'compromiso'];

const lat = { join: [], resp: [] };
const motivos = {};
let joined = 0, errores = 0, okResp = 0, reveals = 0, desconexiones = 0, semaforos = 0, preguntas = 0, votos = 0;

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * p)] || 0; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = arr => arr[Math.floor(Math.random() * arr.length)];
async function waitFor(fn, timeout) { const t = Date.now(); while (!fn() && Date.now() - t < timeout) await sleep(120); return fn(); }

function respuestaPara(act, i) {
  if (act.type === 'quiz' || act.type === 'poll') {
    if (act.correct !== undefined && Math.random() < 0.62) return act.correct;
    return Math.floor(Math.random() * act.options.length);
  }
  if (act.type === 'classify') {
    const v = {};
    for (const c of act.cards) v[c.id] = Math.random() < 0.7 ? c.correct : (c.correct + 1) % act.categories.length;
    return v;
  }
  if (act.type === 'wordcloud') return rnd(PALABRAS);
  return 0;
}

async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`  ENSAYO GENERAL — ${N} participantes · 6 países · ${ACTIVITIES.length} actividades`);
  console.log(`  ${URL}`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);

  // --- Admin + pantalla de proyección ---
  const admin = io(URL, { transports: ['websocket'] });
  const pantalla = io(URL, { transports: ['websocket'] });
  await new Promise((res, rej) => {
    admin.on('connect', () => admin.emit('staffJoin', { token: ADMIN_TOKEN, role: 'admin' }, r => r.ok ? res() : rej(new Error('Token admin inválido'))));
    admin.on('connect_error', e => rej(new Error('No conecta: ' + e.message)));
  });
  await new Promise(res => pantalla.on('connect', () => pantalla.emit('staffJoin', { token: ADMIN_TOKEN, role: 'pantalla' }, res)));
  let pantallaTicks = 0;
  pantalla.on('results', d => { if (d.liveWC || d.revealed) pantallaTicks++; });
  console.log('✓ Admin y pantalla de proyección conectados');

  // --- Ingreso escalonado (como QR proyectado durante 2-3 min) ---
  const clients = [];
  const paisCount = {};
  const rolCount = {};
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const pais = rnd(POOL);
    const rol = rnd(ROLES);
    paisCount[pais.label] = (paisCount[pais.label] || 0) + 1;
    rolCount[rol] = (rolCount[rol] || 0) + 1;
    const c = io(URL, { transports: ['websocket'], reconnection: true, reconnectionAttempts: 3 });
    c._i = i; c._pais = pais; c._sent = false; c._liveWC = false;
    clients.push(c);
    c.on('connect', () => {
      if (c._joined) return;
      const ts = Date.now();
      const payload = { nombre: rnd(NOMBRES) + ' ' + i, pais: pais.code, rol };
      if (pais.code === 'OT') payload.paisOtro = pais.label;
      c.emit('join', payload, r => {
        lat.join.push(Date.now() - ts);
        if (r && r.ok) { joined++; c._joined = true; c._liveWC = !!r.liveWC; } else { errores++; motivos['join:' + ((r && r.error) || '?')] = (motivos['join:' + ((r && r.error) || '?')] || 0) + 1; }
      });
    });
    c.on('disconnect', () => desconexiones++);
    c.on('revealed', () => { reveals++; });
    c.on('liveWC', () => { c._liveWC = true; });
    if (i % 15 === 14) await sleep(RAPIDO ? 40 : 320);
  }
  await waitFor(() => joined + errores >= N, 90000);
  console.log(`✓ Ingreso: ${joined}/${N} en ${((Date.now() - t0) / 1000).toFixed(1)}s (errores: ${errores})`);
  console.log(`  Latencia join — p50: ${pct(lat.join, .5)}ms · p95: ${pct(lat.join, .95)}ms · p99: ${pct(lat.join, .99)}ms`);
  console.log(`  Por país: ${Object.entries(paisCount).map(([k, v]) => `${k}:${v}`).join(' · ')}`);
  console.log(`  Por rol:  ${Object.entries(rolCount).map(([k, v]) => `${k}:${v}`).join(' · ')}\n`);

  // --- Recorrido por las 14 actividades ---
  for (let a = 0; a < ACTIVITIES.length; a++) {
    const act = ACTIVITIES[a];
    const esNube = act.type === 'wordcloud';
    await new Promise(r => admin.emit('admin:start', act.id, r));
    const t = Date.now();
    let done = 0;
    const rl = [];

    // cada participante responde en un momento distinto (ritmo humano)
    clients.forEach((c, i) => {
      if (!c.connected || !c._joined) { done++; return; }
      const delay = Math.floor((i / N) * VENTANA) + Math.floor(Math.random() * 600);
      setTimeout(() => {
        const ts = Date.now();
        c.emit('respond', { activityId: act.id, value: respuestaPara(act, i) }, r => {
          rl.push(Date.now() - ts); done++;
          if (r && r.ok) { okResp++; c._sent = true; }
          else { const e = r ? (r.error || 'error') : 'ack_vacío'; motivos[e] = (motivos[e] || 0) + 1; }
        });
      }, delay);
    });

    // vida de fondo: semáforo, preguntas, votos
    clients.forEach((c, i) => {
      if (!c.connected) return;
      if (i % 3 === a % 3) setTimeout(() => { c.emit('semaforo', rnd(['verde', 'verde', 'amarillo', 'rojo'])); semaforos++; }, Math.random() * VENTANA);
      if (i % 35 === a % 35) setTimeout(() => { c.emit('question', { text: `Consulta ${a}-${i}: ¿cómo se documenta este punto en el acta?` }, () => { preguntas++; }); }, Math.random() * VENTANA);
      if (i % 12 === 0) setTimeout(() => { c.emit('voteQuestion', 1 + ((i + a) % 8)); votos++; }, Math.random() * VENTANA);
    });

    // si es nube de palabras: el admin la lanza EN VIVO tras un momento de escritura
    if (esNube) {
      await sleep(RAPIDO ? 500 : 2500); // deja que varios envíen su palabra
      await new Promise(r => admin.emit('admin:liveWC', r));
    }

    await waitFor(() => done >= clients.length, VENTANA + 22000);
    lat.resp.push(...rl);
    await new Promise(r => admin.emit('admin:reveal', r));
    const marca = esNube ? '🌥  nube en vivo' : '';
    console.log(`✓ ${String(a + 1).padStart(2)}/${ACTIVITIES.length} ${act.id.padEnd(3)} [${act.type.padEnd(9)}] ${rl.length} resp · p95 ${pct(rl, .95)}ms ${marca}`);
    await sleep(PAUSA);
  }
  await new Promise(r => admin.emit('admin:idle', r));

  // --- Cierre y verificación ---
  await sleep(1500);
  const csv = await (await fetch(`${URL}/export.csv?token=${ADMIN_TOKEN}`)).text();
  const salud = await (await fetch(`${URL}/salud`)).json();
  const filas = csv.split('\n').filter(l => l.trim()).length;
  // verificar que aparecen los 6 países: nativos por código (AR/GT), otros por su texto
  const paisesEnCsv = PAISES.filter(p => {
    if (p.native) return new RegExp(',' + p.code + ',').test(csv) || csv.includes(',' + p.code + ',');
    return csv.includes(p.label);
  }).map(p => p.label);

  console.log(`\n────────────────── RESUMEN DEL ENSAYO ──────────────────`);
  console.log(`Ingresaron:            ${joined}/${N}`);
  console.log(`Respuestas aceptadas:  ${okResp}  (esperado ≈ ${joined * ACTIVITIES.length})`);
  console.log(`Reveals recibidos:     ${reveals}`);
  console.log(`Semáforos · preguntas · votos:  ${semaforos} · ${preguntas} · ${votos}`);
  console.log(`Caídas/reconexiones:   ${desconexiones}`);
  console.log(`Latencia respuesta —   p50: ${pct(lat.resp, .5)}ms · p95: ${pct(lat.resp, .95)}ms · p99: ${pct(lat.resp, .99)}ms`);
  console.log(`Proyección (ticks live): ${pantallaTicks}`);
  console.log(`Export CSV:            ${(csv.length / 1024).toFixed(1)} KB · ${filas} filas`);
  console.log(`Conectados al cierre:  ${salud.total}  (AR:${salud.ar} GT:${salud.gt} Otros:${salud.ot})`);
  console.log(`Países en el CSV:      ${paisesEnCsv.length}/6 → ${paisesEnCsv.join(', ')}`);
  if (Object.keys(motivos).length) console.log(`Motivos de rechazo:    ${JSON.stringify(motivos)}`);
  const ok = errores === 0 && okResp >= joined * ACTIVITIES.length * 0.97 && paisesEnCsv.length === 6;
  console.log(`\n${ok ? '✅  ENSAYO GENERAL: TODO OK — plataforma lista para mañana' : '⚠️  REVISAR (ver métricas arriba)'}`);
  console.log(`────────────────────────────────────────────────────────\n`);

  clients.forEach(c => c.close());
  admin.close(); pantalla.close();
  process.exit(ok ? 0 : 1);
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
