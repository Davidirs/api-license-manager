// Horario de "no molestar" de WhatsApp por usuario.
//
//   preferences.whatsappQuietHours = { enabled, start: "22:00", end: "07:00" }
//
// Se evalúa en la zona horaria del usuario (preferences.timezone). Lo que llega
// dentro del rango se retiene hasta que termina.

const DEFAULT_QUIET_HOURS = { enabled: false, start: "22:00", end: "07:00" };

function parseMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

/** Minutos transcurridos del día en la zona horaria indicada. */
function localMinutes(timezone, now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    return h * 60 + m;
  } catch {
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
}

/** Valida y completa la configuración que llega del dashboard. */
function sanitizeQuietHours(input) {
  if (!input || typeof input !== "object") return { ...DEFAULT_QUIET_HOURS };
  const start = parseMinutes(input.start) !== null ? String(input.start).trim() : DEFAULT_QUIET_HOURS.start;
  const end = parseMinutes(input.end) !== null ? String(input.end).trim() : DEFAULT_QUIET_HOURS.end;
  return { enabled: input.enabled === true, start, end };
}

/**
 * Milisegundos que hay que esperar para salir del horario de no molestar.
 * 0 si no aplica o si ahora mismo no se está dentro del rango.
 */
function quietHoursDelayMs(quietHours, timezone, now = new Date()) {
  if (!quietHours || quietHours.enabled !== true) return 0;
  const start = parseMinutes(quietHours.start);
  const end = parseMinutes(quietHours.end);
  if (start === null || end === null || start === end) return 0;

  const current = localMinutes(timezone, now);
  // Rango que cruza la medianoche (22:00 → 07:00) o dentro del mismo día.
  const inside = start < end ? current >= start && current < end : current >= start || current < end;
  if (!inside) return 0;

  const minutesLeft = (end - current + 24 * 60) % (24 * 60);
  // Se resta lo que va del minuto actual para salir justo a la hora de fin.
  return minutesLeft * 60 * 1000 - now.getSeconds() * 1000;
}

module.exports = { DEFAULT_QUIET_HOURS, sanitizeQuietHours, quietHoursDelayMs, parseMinutes };
