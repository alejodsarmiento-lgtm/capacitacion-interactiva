/**
 * ENSAYO GENERAL COMPLETO
 * Simula N participantes que se quedan conectados durante todo el recorrido
 * y responden LAS 14 ACTIVIDADES, con ritmo humano (respuestas escalonadas),
 * semáforo cambiante y preguntas/votos durante toda la sesión.
 *
 * Uso:  ADMIN_TOKEN=xxx node test/load-test-full.js [N] [URL]
 * Ej.:  ADMIN_TOKEN=xxx node test/load-test-full.js 300 https://firmared.tech
 * Modo rápido (para probar el script): RAPIDO=1 ADMIN_TOKEN=xxx node ...
 */
const path = require('path');
const { io } = require('socket.io-client');
const ACTIVITIES = require(path.join(__dirname, '..', 'data', 'activities.json')).activities;

const N = parseInt(process.argv[2] || '300', 10);
const URL = process.argv[3] || 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'mtpba2026';
const RAPIDO = !!process.env.RAPIDO;
const VENTANA = RAPIDO ? 1500 : 9000;   // ms en que la sala termina de responder cada actividad
const PAUSA = RAPIDO ? 400 : 2500;      // ms con resultados revelados antes de la siguiente

const nombres = ['Juan','María','Pedro','Lucía','Carlos','Ana','Diego','Sofía','Luis','Carmen','Byron','Alejandra','Marvin','Claudia','Estuardo','Wendy','Jorge','Elena'];
const roles = ['inspector','inspector','inspector','funcionario','abogado','otro'];
const palabras = ['derechos','trabajo','dignidad','registración','inspección','protección','ley','justicia','cuidado','igualdad'];

const lat = { join: [], resp: [] };
let joined = 0, errores = 0, respuestasOk = 0, revealsRecibidos = 0, desconexiones = 0;

function pct(a, p) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * p)] || 0; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitFor(fn, timeout) { const t = Date.now(); while (!fn() && Date.now() - t < timeout) await sleep(150); return fn(); }

function respuestaPara(act, i) {
  if (act.type === 'quiz' || act.type === 'poll') {
    // 60% elige la correcta si existe (sala que viene aprendiendo), resto se reparte
    if (act.correct !== undefined && i % 10 < 6) return act.correct;
    return i % act.options.length;
  }
  if (act.type === 'classify') {
    const v = {};
    for (const c of act.cards) v[c.id] = (i % 10 < 7) ? c.correct : (c.correct + 1) % act.categories.length;
    return v;
  }
  if (act.type === 'wordcloud') return palabras[i % palabras.length];
  return 0;
}

async function main() {
  console.log(`\n=== ENSAYO GENERAL: ${N} participantes · ${ACTIVITIES.length} actividades · ${URL} ===`);
  console.log(RAPIDO ? '(modo rápido de verificación)\n' : '(ritmo humano: ~9 s de respuestas por actividad)\n');

  const admin = io(URL, { transports: ['websocket'] });
  await new Promise((res, rej) => {
    admin.on('connect', () => admin.emit('staffJoin', { token: ADMIN_TOKEN, role: 'admin' }, r => r.ok ? res() : rej(new Error('Token de admin inválido'))));
    admin.on('connect_error', e => rej(new Error('No conecta: ' + e.message)));
  });
  console.log('✓ Admin conectado');

  // --- Ingreso en oleadas realistas (como QR proyectado 2-3 minutos) ---
  const clients = [];
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const c = io(URL, { transports: ['websocket'], reconnection: true, reconnectionAttempts: 3 });
    c._i = i;
    clients.push(c);
    c.on('connect', () => {
      if (c._joined) return;
      const ts = Date.now();
      c.emit('join', {
        nombre: nombres[i % nombres.length] + ' ' + i,
        pais: i % 2 ? 'GT' : 'AR',
        rol: roles[i % roles.length]
      }, r => { lat.join.push(Date.now() - ts); if (r && r.ok) { joined++; c._joined = true; } else errores++; });
    });
    c.on('disconnect', () => { desconexiones++; });
    c.on('revealed', () => { revealsRecibidos++; });
    if (i % 20 === 19) await sleep(RAPIDO ? 60 : 400);
  }
  await waitFor(() => joined + errores >= N, 90000);
  console.log(`✓ Ingreso: ${joined}/${N} en ${((Date.now() - t0) / 1000).toFixed(1)}s (errores: ${errores})`);
  console.log(`  Latencia join — p50: ${pct(lat.join, .5)}ms · p95: ${pct(lat.join, .95)}ms · p99: ${pct(lat.join, .99)}ms\n`);

  // --- Recorrido completo por las 14 actividades ---
  for (let a = 0; a < ACTIVITIES.length; a++) {
    const act = ACTIVITIES[a];
    await new Promise(r => admin.emit('admin:start', act.id, r));
    const t = Date.now();
    let done = 0;
    const rl = [];
    clients.forEach((c, i) => {
      if (!c.connected) { done++; return; }
      // cada uno responde en un momento distinto dentro de la ventana (ritmo humano)
      const delay = Math.floor((i / N) * VENTANA) + Math.floor(Math.random() * 500);
      setTimeout(() => {
        const ts = Date.now();
        c.emit('respond', { activityId: act.id, value: respuestaPara(act, i) }, r => {
          rl.push(Date.now() - ts); done++;
          if (r && r.ok) respuestasOk++;
        });
      }, delay);
    });
    // mientras responden: semáforo y preguntas de fondo (como en la sala real)
    clients.forEach((c, i) => {
      if (!c.connected) return;
      if (i % 4 === a % 4) setTimeout(() => c.emit('semaforo', ['verde','verde','amarillo','rojo'][(i + a) % 4]), Math.random() * VENTANA);
      if (i % 40 === a % 40) setTimeout(() => c.emit('question', { text: `Pregunta de ensayo ${a}-${i}: ¿cómo se documenta este supuesto en el acta?` }, () => {}), Math.random() * VENTANA);
      if (i % 15 === 0) setTimeout(() => c.emit('voteQuestion', 1 + ((i + a) % 8)), Math.random() * VENTANA);
    });
    await waitFor(() => done >= clients.length * 0.99, VENTANA + 20000);
    lat.resp.push(...rl);
    await new Promise(r => admin.emit('admin:reveal', r));
    console.log(`✓ ${String(a + 1).padStart(2)}/${ACTIVITIES.length} ${act.id.padEnd(3)} [${act.type.padEnd(9)}] ${rl.length} resp en ${((Date.now() - t) / 1000).toFixed(1)}s — p95: ${pct(rl, .95)}ms · ${esc(act.title)}`);
    await sleep(PAUSA);
  }
  await new Promise(r => admin.emit('admin:idle', r));

  // --- Cierre y verificación ---
  await sleep(1500);
  const res = await fetch(`${URL}/export.csv?token=${ADMIN_TOKEN}`);
  const csv = await res.text();
  const filas = csv.split('\n').length;
  const salud = await (await fetch(`${URL}/salud`)).json();

  console.log(`\n————— RESUMEN DEL ENSAYO —————`);
  console.log(`Participantes que completaron ingreso: ${joined}/${N}`);
  console.log(`Respuestas aceptadas: ${respuestasOk} (esperado ≈ ${joined * ACTIVITIES.length})`);
  console.log(`Latencia de respuesta global — p50: ${pct(lat.resp, .5)}ms · p95: ${pct(lat.resp, .95)}ms · p99: ${pct(lat.resp, .99)}ms`);
  console.log(`Broadcasts de reveal recibidos: ${revealsRecibidos} (esperado ≈ ${joined * ACTIVITIES.length})`);
  console.log(`Reconexiones/caídas durante la sesión: ${desconexiones}`);
  console.log(`Export CSV: ${(csv.length / 1024).toFixed(1)} KB · ${filas} filas`);
  console.log(`Conectados al cierre según /salud: ${salud.total}`);
  const ok = errores === 0 && respuestasOk >= joined * ACTIVITIES.length * 0.97;
  console.log(`\n=== ${ok ? 'ENSAYO COMPLETO: TODO OK ✓' : 'REVISAR: hubo pérdidas por encima del 3%'} ===`);
  console.log(`No olvidar la limpieza:  curl "${URL}/reset?token=TU-TOKEN"\n`);
  clients.forEach(c => c.close());
  admin.close();
  process.exit(ok ? 0 : 1);
}

function esc(s) { return String(s).slice(0, 48); }
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
