// sw-saludar-notif.js — SaludAR v2.4
// Notificaciones locales sin FCM — Timezone: America/Argentina/Buenos_Aires
// Lógica:
//   - Tomas: notificación puntual a la hora exacta
//   - 12:00: resumen de tomas de la mañana no realizadas
//   - 22:00: resumen de todas las tomas pendientes del día
//   - Turnos/Estudios: día anterior a la misma hora + día del evento a las 08:00

const CACHE_NAME = 'saludar-v2.3';
const SHELL = [
  '/saludar/',
  '/saludar/index.html',
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
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.hostname.includes('firestore.googleapis.com') ||
      url.hostname.includes('identitytoolkit.googleapis.com') ||
      url.hostname.includes('securetoken.googleapis.com')) return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.status === 200 &&
            (url.origin === self.location.origin ||
             url.hostname.includes('googleapis.com') ||
             url.hostname.includes('gstatic.com'))) {
          caches.open(CACHE_NAME).then(c => c.put(e.request, res.clone()));
        }
        return res;
      }).catch(() => {
        if (e.request.mode === 'navigate') return caches.match('/saludar/index.html');
      });
    })
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
    hour: '2-digit', minute: '2-digit', hour12: false
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

// ── Dispatcher de notificaciones ──────────────────────────────
function notificar(tag, titulo, cuerpo, opciones = {}) {
  if (yaNotificados[tag]) return;
  yaNotificados[tag] = true;
  self.registration.showNotification(titulo, {
    body: cuerpo,
    icon:  '/saludar/icon-192.png',
    badge: '/saludar/icon-192.png',
    tag,
    data:  { url: '/saludar/' },
    requireInteraction: true,
    vibrate: [200, 100, 200],
    ...opciones
  });
}

// ── Chequeo principal — se ejecuta cada 60 seg ─────────────────
function chequear() {
  const { fecha, hora, horaH } = ahoraAR();

  // ── 1. TOMAS PUNTUALES (solo si notifPorToma = true — feature plus) ────
  if (notifPorToma) {
    medicamentos.forEach(m => {
      if (!m.activo) return;
      const horarios = (m.horarios || '').split(',').map(h => h.trim()).filter(Boolean);
      horarios.forEach(h => {
        if (h !== hora) return;
        const clave = `toma_${m.id}_${h}_${fecha}`;
        if (tomasHoy[`${m.id}_${h}`]) return;
        notificar(clave, '💊 Recordatorio de medicación',
          `Es hora de tomar ${m.nombre}${m.dosis ? ' — ' + m.dosis : ''}`);
      });
    });
  }

  // ── 2. RESUMEN MEDIODÍA (12:00) ───────────────────────────
  if (hora === '12:00') {
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
  if (hora === '22:00') {
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
    if (t.fecha === mañana && horaEvento === hora) {
      notificar(`turno_previo_${t.id}_${fecha}`,
        `📅 Recordatorio — ${tipo} mañana`,
        `Mañana a las ${horaEvento} tenés: ${titulo}`);
    }

    // Mismo día del evento a las 08:00
    if (t.fecha === fecha && hora === '08:00') {
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
      break;
    case 'SET_TOMAS_HOY':
      tomasHoy = e.data.tomasHoy || {};
      break;
    case 'RESET_NOTIFICADOS':
      yaNotificados = {};
      tomasHoy = {};
      break;
    case 'SET_CONFIG':
      notifPorToma = e.data.notifPorToma || false;
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
      const url = e.notification.data?.url || '/saludar/';
      const existing = cs.find(c => c.url.includes('/saludar/'));
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
