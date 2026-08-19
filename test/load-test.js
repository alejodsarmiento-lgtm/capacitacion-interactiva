/**
 * Test de carga: simula N participantes reales (AR + GT) contra el servidor.
 * Uso: node test/load-test.js [N] [URL]
 */
const { io } = require('socket.io-client');

const N = parseInt(process.argv[2] || '250', 10);
const URL = process.argv[3] || 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'mtpba2026';

const nombres = ['Juan','María','Pedro','Lucía','Carlos','Ana','Diego','Sofía','Luis','Carmen','Jorge','Elena','Miguel','Rosa','Raúl'];
const roles = ['inspector','inspector','inspector','funcionario','abogado','otro'];
const lat = [];
let joined = 0, respuestas = 0, errores = 0;

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length * p)] || 0;
}

async function main() {
  console.log(`\n=== TEST DE CARGA: ${N} participantes contra ${URL} ===\n`);

  // 1. Admin se conecta
  const admin = io(URL, { transports: ['websocket'] });
  await new Promise((res, rej) => {
    admin.on('connect', () => admin.emit('staffJoin', { token: ADMIN_TOKEN, role: 'admin' }, r => r.ok ? res() : rej(new Error('token'))));
    admin.on('connect_error', rej);
  });
  console.log('✓ Admin conectado');

  // 2. Conectar N participantes en oleadas (como escaneo masivo de QR)
  const clients = [];
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const c = io(URL, { transports: ['websocket'], reconnection: false });
    clients.push(c);
    const pais = i % 2 === 0 ? 'AR' : 'GT';
    c.on('connect', () => {
      const ts = Date.now();
      c.emit('join', {
        nombre: nombres[i % nombres.length] + ' ' + i,
        pais, rol: roles[i % roles.length]
      }, res => {
        lat.push(Date.now() - ts);
        if (res && res.ok) joined++; else errores++;
      });
    });
    c.on('connect_error', () => errores++);
    if (i % 50 === 49) await sleep(200); // oleadas de 50
  }
  await waitFor(() => joined + errores >= N, 15000);
  console.log(`✓ Registro masivo: ${joined}/${N} en ${((Date.now() - t0) / 1000).toFixed(1)}s  (errores: ${errores})`);
  console.log(`  Latencia join — p50: ${pct(lat, .5)}ms · p95: ${pct(lat, .95)}ms · p99: ${pct(lat, .99)}ms`);

  // 3. Quiz: admin abre a2, todos responden casi a la vez
  await startAndRespond(admin, clients, 'a2', (c, i) => i % 4, 'Quiz a2 (encuadre)');

  // 4. Clasificación: la actividad más pesada (9 tarjetas por persona)
  await startAndRespond(admin, clients, 'a6', () => ({
    c1: 0, c2: 0, c3: 1, c4: 1, c5: 1, c6: 2, c7: 2, c8: 2, c9: 0
  }), 'Clasificación a6 (9 tarjetas × persona)');

  // 5. Nube de palabras
  const palabras = ['derechos','trabajo','dignidad','registración','inspección','protección','ley','justicia'];
  await startAndRespond(admin, clients, 'a1', (c, i) => palabras[i % palabras.length], 'Nube de palabras a1');

  // 6. Semáforo + preguntas simultáneas
  const t5 = Date.now();
  clients.forEach((c, i) => {
    c.emit('semaforo', ['verde', 'verde', 'amarillo', 'rojo'][i % 4]);
    if (i % 10 === 0) c.emit('question', { text: `¿Pregunta de prueba número ${i} sobre la orden de inspección?` }, () => {});
    if (i % 3 === 0) c.emit('voteQuestion', 1 + (i % 5));
  });
  await sleep(1500);
  console.log(`✓ Semáforo (${N}) + ${Math.ceil(N / 10)} preguntas + votos en ${((Date.now() - t5) / 1000).toFixed(1)}s`);

  // 7. Reveal masivo (broadcast a todos)
  const t6 = Date.now();
  let recibieron = 0;
  clients.forEach(c => c.once('revealed', () => recibieron++));
  admin.emit('admin:reveal', () => {});
  await waitFor(() => recibieron >= joined * 0.98, 8000);
  console.log(`✓ Reveal broadcast: ${recibieron}/${joined} lo recibieron en ${((Date.now() - t6) / 1000).toFixed(1)}s`);

  // 8. Export
  const res = await fetch(`${URL}/export.csv?token=${ADMIN_TOKEN}`);
  const csvText = await res.text();
  console.log(`✓ Export CSV: ${(csvText.length / 1024).toFixed(1)} KB, ${csvText.split('\n').length} filas`);

  console.log(`\n=== RESULTADO: ${errores === 0 && joined === N ? 'TODO OK ✓' : 'REVISAR — errores: ' + errores} ===\n`);
  clients.forEach(c => c.close());
  admin.close();
  process.exit(errores === 0 ? 0 : 1);
}

async function startAndRespond(admin, clients, actId, valueFn, label) {
  await new Promise(r => admin.emit('admin:start', actId, r));
  const t = Date.now();
  const rlat = [];
  let done = 0;
  clients.forEach((c, i) => {
    if (!c.connected) { done++; return; }
    const ts = Date.now();
    c.emit('respond', { activityId: actId, value: typeof valueFn === 'function' ? valueFn(c, i) : valueFn }, res => {
      rlat.push(Date.now() - ts);
      done++;
      if (res && res.ok) respuestas++;
    });
  });
  await waitFor(() => done >= clients.length, 15000);
  console.log(`✓ ${label}: ${rlat.length} respuestas en ${((Date.now() - t) / 1000).toFixed(1)}s — p50: ${pct(rlat, .5)}ms · p95: ${pct(rlat, .95)}ms · p99: ${pct(rlat, .99)}ms`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitFor(fn, timeout) {
  const t0 = Date.now();
  while (!fn() && Date.now() - t0 < timeout) await sleep(100);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
