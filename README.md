# Capacitación interactiva — Inspección del trabajo en casas particulares
Ministerio de Trabajo PBA · Argentina — Guatemala · Cisco Webex + sala interactiva

## Qué es
Plataforma de interacción en tiempo real para 200+ participantes conectados por celular
mientras siguen la conferencia en Webex. Node.js + Express + Socket.io, estado en memoria.

## Las tres pantallas
- `/` — **Participante** (mobile): registro (nombre, país AR/GT, rol), actividades, semáforo de ritmo, muro de preguntas con votos.
- `/admin.html` — **Panel del disertante**: guion de actividades, resultados en vivo, semáforo agregado (con corte por rol), preguntas ordenadas por votos, export CSV. Requiere token.
- `/pantalla.html?token=TOKEN` — **Proyección** para compartir en Webex: contador de respuestas antes del reveal, barras animadas, mapa de calor de clasificación, comparativa por país, nube de palabras, duelo AR–GT en el pie.

## Actividades precargadas (data/activities.json)
10 actividades mapeadas al manual: quiz con puntaje por país, encuestas espejo AR/GT,
clasificador de infracciones (leve/grave/muy grave) y nubes de palabras de apertura y cierre.
Editables sin tocar código.

## Correr local
```
npm install
ADMIN_TOKEN=mi-token node server.js     # sin variable usa "mtpba2026"
```

## Test de carga (simula el evento real)
```
node test/load-test.js 250 http://localhost:3000
```
Simula registro masivo en oleadas, quiz, clasificación de 9 tarjetas, nube de palabras,
semáforo, preguntas, reveal broadcast y export.

## Deploy en Railway (plan Hobby, USD 5/mes)
1. Subir este repo a GitHub (privado).
2. Railway → New Project → Deploy from GitHub repo.
3. Variables → agregar `ADMIN_TOKEN` (elegir uno propio, no el default).
4. Settings → Networking → Generate Domain (o dominio propio).
5. Verificar `https://TU-URL/salud` → `{"ok":true,...}`.
6. Correr el test de carga contra la URL real: `node test/load-test.js 250 https://TU-URL`.

## Día del evento
- QR en el primer slide apuntando a la URL raíz.
- Disertante abre `/admin.html` en una ventana y comparte `/pantalla.html?token=…` en Webex.
- Al cierre: botón "Exportar resultados (CSV)" desde el panel (respuestas con país, rol
  y timestamp + todas las preguntas con votos) para el informe institucional.

## Notas técnicas
- Estado en memoria: si el proceso se reinicia se pierde la sesión en curso (aceptable
  para un evento de 3 h; no usar restart durante el evento).
- Broadcast de resultados con throttle de 400 ms: 200 conexiones no estresan el event loop.
- Los participantes no ven resultados parciales hasta el "Revelar" (evita sesgo de respuesta).
- Reconexión automática: si a alguien se le corta el 4G, vuelve a entrar con su identidad.
