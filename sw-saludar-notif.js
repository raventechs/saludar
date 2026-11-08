// sw-saludar-notif.js — SaludAR v2.11 (08/11/2026: red primero, hora h23, ventana de 30 min en los avisos)
// Notificaciones locales sin FCM — Timezone: America/Argentina/Buenos_Aires
// Lógica:
//   - Tomas: notificación puntual a la hora exacta
//   - 12:00: resumen de tomas de la mañana no realizadas
//   - 22:00: resumen de todas las tomas pendientes del día
//   - Turnos/Estudios: día anterior a la misma hora + día del evento a las 08:00

const CACHE_NAME = 'saludar-v2.11';
const ESTADO_CACHE = 'saludar-notif-estado';
const SHELL = [
  '/',
  '/index.html',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js',
];

// ── Cache / offline ────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME && k !== ESTADO_CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.hostname.includes('firestore.googleapis.com') ||
      url.hostname.includes('identitytoolkit.googleapis.com') ||
      url.hostname.includes('securetoken.googleapis.com')) return;
  if (e.request.method !== 'GET') return;
  // RED PRIMERO (estándar RavenTechs): las actualizaciones llegan siempre; sin conexión se usa la copia guardada
  e.respondWith(
    fetch(e.request).then(res => {
      if (res && res.status === 200 &&
          (url.origin === self.location.origin ||
           url.hostname.includes('googleapis.com') ||
           url.hostname.includes('gstatic.com'))) {
        const copia = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, copia));
      }
      return res;
    }).catch(() =>
      caches.match(e.request).then(cached => cached || (e.request.mode === 'navigate' ? caches.match('/index.html') : undefined))
    )
  );
});

// ── Estado interno ─────────────────────────────────────────────
let medicamentos  = []; // [{ id, nombre, dosis, horarios:"08:00,20:00", activo }]
let tomasHoy      = {}; // { "med-id_08:00": true } — sincronizado desde la app
let turnos        = []; // [{ id, titulo, fecha:"2026-07-10", hora:"16:00", tipo }]
let yaNotificados = {}; // { clave: true } — evita duplicados por día
let notifPorToma  = false; // feature plus — configurable desde el perfil

// ── Helpers de fecha/hora Argentina ───────────────────────────
function ahoraAR() {
  const fmt = new Intl.DateTimeFormat('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  const parts = fmt.formatToParts(new Date());
  const get = t => parts.find(p => p.type === t)?.value || '00';
  const dia   = get('day').padStart(2,'0');
  const mes   = get('month').padStart(2,'0');
  const anio  = get('year');
  const hora  = get('hour').padStart(2,'0');
  const min   = get('minute').padStart(2,'0');
  return {
    fecha:  `${anio}-${mes}-${dia}`,   // YYYY-MM-DD
    hora:   `${hora}:${min}`,           // HH:MM
    horaH:  parseInt(hora),
    horaM:  parseInt(min),
  };
}

function fechaMananaAR() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d).split('/').reverse().join('-');
}

// Ventana de 30 min: si el sistema demora o despierta tarde al service worker, el aviso igual sale una sola vez (el tag evita repetirlo)
const VENTANA_MIN = 30;
function aMin(hhmm) { const [h, m] = String(hhmm).split(':').map(Number); return (h || 0) * 60 + (m || 0); }
function enVentana(objetivo, ahora) { const d = aMin(ahora) - aMin(objetivo); return d >= 0 && d < VENTANA_MIN; }

// ── Estado persistente ─────────────────────────────────────────
// El sistema detiene el service worker cuando está inactivo y pierde lo que tenía en memoria.
// Guardamos medicamentos, turnos, tomas del día y avisos ya enviados para que, al despertar, no avise
// una toma ya hecha ni repita un aviso. Las tomas y los avisos son del día: si cambió la fecha se descartan.
function guardarEstado() {
  try {
    const cuerpo = JSON.stringify({ fecha: ahoraAR().fecha, medicamentos, turnos, tomasHoy, yaNotificados, notifPorToma });
    caches.open(ESTADO_CACHE).then(c => c.put('/__estado', new Response(cuerpo))).catch(() => {});
  } catch (e) {}
}
const estadoListo = (async () => {
  try {
    const c = await caches.open(ESTADO_CACHE);
    const r = await c.match('/__estado');
    if (!r) return;
    const j = await r.json();
    medicamentos = j.medicamentos || medicamentos;
    turnos = j.turnos || turnos;
    notifPorToma = !!j.notifPorToma;
    if (j.fecha === ahoraAR().fecha) { tomasHoy = j.tomasHoy || {}; yaNotificados = j.yaNotificados || {}; }
  } catch (e) {}
})();

// ── Dispatcher de notificaciones ──────────────────────────────
function notificar(tag, titulo, cuerpo, opciones = {}) {
  if (yaNotificados[tag]) return;
  yaNotificados[tag] = true;
  guardarEstado();
  self.registration.showNotification(titulo, {
    body: cuerpo,
    icon:  '/icon-192.png',
    badge: '/icon-192.png',
    tag,
    data:  { url: '/' },
    requireInteraction: true,
    vibrate: [200, 100, 200],
    ...opciones
  });
}

// ── Chequeo principal — se ejecuta cada 60 seg ─────────────────
async function chequear() {
  await estadoListo;
  const { fecha, hora, horaH } = ahoraAR();

  // ── 1. TOMAS PUNTUALES (solo si notifPorToma = true — feature plus) ────
  if (notifPorToma) {
    medicamentos.forEach(m => {
      if (!m.activo) return;
      const horarios = (m.horarios || '').split(',').map(h => h.trim()).filter(Boolean);
      horarios.forEach(h => {
        if (!enVentana(h, hora)) return;
        const clave = `toma_${m.id}_${h}_${fecha}`;
        if (tomasHoy[`${m.id}_${h}`]) return;
        notificar(clave, '💊 Recordatorio de medicación',
          `Es hora de tomar ${m.nombre}${m.dosis ? ' — ' + m.dosis : ''}`);
      });
    });
  }

  // ── 2. RESUMEN MEDIODÍA (12:00) ───────────────────────────
  if (enVentana('12:00', hora)) {
    const pendientesMañana = medicamentos.filter(m => {
      if (!m.activo) return false;
      const horarios = (m.horarios || '').split(',').map(h => h.trim()).filter(Boolean);
      return horarios.some(h => {
        const hNum = parseInt(h.split(':')[0]);
        return hNum < 12 && !tomasHoy[`${m.id}_${h}`];
      });
    });
    if (pendientesMañana.length > 0) {
      const nombres = pendientesMañana.map(m => m.nombre).join(', ');
      notificar(`resumen_mañana_${fecha}`, '⚠️ Tomas pendientes de la mañana',
        `No se tomaron: ${nombres}`);
    }
  }

  // ── 3. RESUMEN NOCTURNO (22:00) ───────────────────────────
  if (enVentana('22:00', hora)) {
    const pendientesNoche = medicamentos.filter(m => {
      if (!m.activo) return false;
      const horarios = (m.horarios || '').split(',').map(h => h.trim()).filter(Boolean);
      return horarios.some(h => !tomasHoy[`${m.id}_${h}`]);
    });
    if (pendientesNoche.length > 0) {
      const nombres = pendientesNoche.map(m => m.nombre).join(', ');
      notificar(`resumen_noche_${fecha}`, '🌙 Resumen del día — Tomas pendientes',
        `Todavía falta tomar: ${nombres}`);
    } else {
      notificar(`resumen_noche_ok_${fecha}`, '✅ ¡Excelente!',
        'Tomaste todos los medicamentos del día. ¡Bien hecho!');
    }
  }

  // ── 4. TURNOS Y ESTUDIOS ──────────────────────────────────
  const mañana = fechaMananaAR();

  turnos.forEach(t => {
    const horaEvento = t.hora || '09:00';
    const tipo = t.tipo || 'Turno';
    const titulo = t.titulo || t.especialidad || tipo;

    // Día anterior a la misma hora del evento
    if (t.fecha === mañana && enVentana(horaEvento, hora)) {
      notificar(`turno_previo_${t.id}_${fecha}`,
        `📅 Recordatorio — ${tipo} mañana`,
        `Mañana a las ${horaEvento} tenés: ${titulo}`);
    }

    // Mismo día del evento a las 08:00
    if (t.fecha === fecha && enVentana('08:00', hora)) {
      notificar(`turno_hoy_${t.id}_${fecha}`,
        `📅 ${tipo} hoy`,
        `Hoy a las ${horaEvento} tenés: ${titulo}`);
    }
  });
}

// ── Mensajes desde la app ──────────────────────────────────────
self.addEventListener('message', e => {
  switch (e.data?.type) {
    case 'SET_RECORDATORIOS':
      medicamentos = e.data.medicamentos || [];
      turnos       = e.data.turnos       || [];
      guardarEstado();
      break;
    case 'SET_TOMAS_HOY':
      tomasHoy = e.data.tomasHoy || {};
      guardarEstado();
      break;
    case 'RESET_NOTIFICADOS':
      yaNotificados = {};
      tomasHoy = {};
      guardarEstado();
      break;
    case 'SET_CONFIG':
      notifPorToma = e.data.notifPorToma || false;
      guardarEstado();
      break;
  }
});

// Chequear cada 60 segundos
setInterval(chequear, 60000);

// ── Tap en notificación → abrir app ───────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
      const url = e.notification.data?.url || '/';
      const existing = cs.find(c => c.url.includes('/'));
      if (existing) return existing.focus();
      return clients.openWindow(url);
    })
  );
});

// ── Periodic Background Sync ───────────────────────────────────
// Se activa cuando la app está instalada como PWA
// Chrome Android lo ejecuta cada ~hora aunque la app esté cerrada
self.addEventListener('periodicsync', e => {
  if (e.tag === 'saludar-check') {
    e.waitUntil(chequear());
  }
});
