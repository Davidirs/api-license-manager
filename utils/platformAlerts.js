// Alertas de la plataforma para el equipo que opera License Manager.
//
// Cualquier error relevante (respuestas 500 de la API, jobs que agotan sus
// reintentos, límite diario de WhatsApp alcanzado, excepciones no capturadas)
// se notifica por correo al contacto configurado por el administrador. Si el
// correo falla, se intenta por WhatsApp (WhaiBot) al número de respaldo.
//
//   settings/platformAlerts → { enabled, email, whatsapp, updatedAt }
//
// Nunca lanza: notificar un error no debe provocar otro.

const crypto = require("crypto");
const { db } = require("../firebase");
const { sendMail, isConfigured: isSmtpConfigured } = require("./mailer");
const { getEmailSettings, isValidEmail } = require("./appSettings");
const { currentEnv } = require("./environment");
const {
  getWhaibotConfig,
  isIntegrationEnabled,
  normalizeNumbers,
  sendWhaibotMessage,
} = require("./whaibot");

const SETTINGS_DOC = "platformAlerts";

const DEFAULT_PLATFORM_ALERTS = {
  enabled: true,
  email: "david.reyes@esmtconsulting.com",
  whatsapp: "584245435637",
};

// El mismo error (misma clave) se notifica como mucho una vez por ventana, y
// hay un techo global por hora: una caída de Firestore genera cientos de 500.
const THROTTLE_MS = (Number(process.env.PLATFORM_ALERT_THROTTLE_MINUTES) || 30) * 60 * 1000;
const MAX_PER_HOUR = Number(process.env.PLATFORM_ALERT_MAX_PER_HOUR) || 20;

const CACHE_TTL_MS = 60 * 1000;
let cache = { value: null, at: 0 };
const lastSentByKey = new Map();
let hourWindow = { start: 0, count: 0 };

async function getPlatformAlertSettings({ force = false } = {}) {
  if (!force && cache.value && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  try {
    const doc = await db.collection("settings").doc(SETTINGS_DOC).get();
    const value = { ...DEFAULT_PLATFORM_ALERTS, ...(doc.exists ? doc.data() : {}) };
    cache = { value, at: Date.now() };
    return value;
  } catch (error) {
    console.error("❌ [PlatformAlerts] No se pudo leer la configuración:", error.message);
    return { ...DEFAULT_PLATFORM_ALERTS };
  }
}

async function savePlatformAlertSettings(partial) {
  const payload = { updatedAt: Date.now() };
  if (typeof partial.enabled === "boolean") payload.enabled = partial.enabled;
  if (partial.email !== undefined) {
    const email = String(partial.email || "").trim();
    if (email && !isValidEmail(email)) throw new Error("El correo de alertas no es válido.");
    payload.email = email;
  }
  if (partial.whatsapp !== undefined) {
    const raw = String(partial.whatsapp || "").trim();
    const [number] = normalizeNumbers(raw);
    if (raw && !number) throw new Error("El número de WhatsApp de respaldo no es válido.");
    payload.whatsapp = number || "";
  }
  await db.collection("settings").doc(SETTINGS_DOC).set(payload, { merge: true });
  cache = { value: null, at: 0 };
  return getPlatformAlertSettings({ force: true });
}

/** En DEV sólo se registra en consola, salvo que se fuerce por entorno. */
function alertsAllowedInEnv() {
  return currentEnv() !== "DEV" || process.env.PLATFORM_ALERTS_FORCE === "true";
}

function throttled(key) {
  const now = Date.now();
  if (now - hourWindow.start > 60 * 60 * 1000) hourWindow = { start: now, count: 0 };
  if (hourWindow.count >= MAX_PER_HOUR) return true;
  const last = lastSentByKey.get(key) || 0;
  if (now - last < THROTTLE_MS) return true;
  lastSentByKey.set(key, now);
  hourWindow.count += 1;
  return false;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatDetail(detail) {
  if (detail === undefined || detail === null) return "";
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
}

async function sendAlertEmail(settings, alert) {
  if (!settings.email) throw new Error("Sin correo de alertas configurado.");
  if (!isSmtpConfigured()) throw new Error("SMTP no configurado.");
  const emailSettings = await getEmailSettings();
  const env = currentEnv();
  const detail = formatDetail(alert.detail);
  const when = new Date(alert.at).toISOString();
  await sendMail({
    from: emailSettings.from,
    to: [settings.email],
    subject: `[License Manager][${env}] ${alert.title}`,
    text: [alert.title, "", alert.message, detail ? `\n${detail}` : "", "", `Origen: ${alert.source}`, `Entorno: ${env}`, `Fecha: ${when}`]
      .filter((l) => l !== undefined)
      .join("\n"),
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 640px;">
        <h2 style="color:#dc2626; margin:0 0 12px 0;">⚠️ ${escapeHtml(alert.title)}</h2>
        <p style="font-size:14px; color:#334155;">${escapeHtml(alert.message)}</p>
        ${detail ? `<pre style="background:#f1f5f9; padding:12px; border-radius:6px; font-size:12px; white-space:pre-wrap;">${escapeHtml(detail)}</pre>` : ""}
        <p style="font-size:12px; color:#64748b;">Origen: ${escapeHtml(alert.source)} · Entorno: ${escapeHtml(env)} · ${escapeHtml(when)}</p>
      </div>`,
  });
}

async function sendAlertWhatsapp(settings, alert) {
  const [number] = normalizeNumbers(settings.whatsapp || "");
  if (!number) throw new Error("Sin número de WhatsApp de respaldo configurado.");
  const cfg = await getWhaibotConfig();
  if (!isIntegrationEnabled(cfg)) throw new Error("WhaiBot no está activo.");
  const message =
    `⚠️ *License Manager [${currentEnv()}]*\n${alert.title}\n\n` +
    `${String(alert.message).slice(0, 500)}\n\n` +
    "No se pudo enviar el aviso por correo; revisa los logs de la plataforma.";
  const result = await sendWhaibotMessage(cfg, number, message);
  if (!result.success) throw new Error(result.message);
}

/**
 * Envía la alerta: correo y, si falla, WhatsApp. Devuelve el canal usado.
 * `force` ignora la limitación de ritmo y el corte de DEV (botón de prueba).
 */
async function deliverAlert(alert, { force = false, channel } = {}) {
  const settings = await getPlatformAlertSettings();
  if (!force && settings.enabled === false) return { delivered: false, reason: "disabled" };

  if (channel === "whatsapp") {
    await sendAlertWhatsapp(settings, alert);
    return { delivered: true, channel: "whatsapp" };
  }

  try {
    await sendAlertEmail(settings, alert);
    return { delivered: true, channel: "email" };
  } catch (emailError) {
    if (channel === "email") throw emailError;
    console.error("❌ [PlatformAlerts] Falló el correo de alerta:", emailError.message);
    try {
      await sendAlertWhatsapp(settings, {
        ...alert,
        message: `${alert.message}\n(Correo fallido: ${emailError.message})`,
      });
      return { delivered: true, channel: "whatsapp" };
    } catch (waError) {
      console.error("❌ [PlatformAlerts] También falló el WhatsApp de respaldo:", waError.message);
      return { delivered: false, reason: "all_channels_failed" };
    }
  }
}

/**
 * Notifica un error de la plataforma. No espera ni lanza: se puede llamar desde
 * cualquier `catch` sin cambiar su flujo.
 *
 * @param {object} p { source, title, message, detail, key }
 *   key: agrupa errores repetidos para la limitación de ritmo (por defecto
 *   source + title).
 */
function notifyPlatformError({ source = "api", title, message, detail, key } = {}) {
  const alert = {
    source,
    title: title || "Error en la plataforma",
    message: message || "Error sin mensaje.",
    detail,
    at: Date.now(),
  };
  const throttleKey = crypto
    .createHash("sha1")
    .update(String(key || `${source}|${alert.title}`))
    .digest("hex");

  if (!alertsAllowedInEnv()) {
    console.warn(`🔕 [PlatformAlerts] (${currentEnv()}) ${alert.title}: ${alert.message}`);
    return;
  }
  if (throttled(throttleKey)) return;

  deliverAlert(alert).catch((error) =>
    console.error("❌ [PlatformAlerts] Error inesperado notificando:", error.message),
  );
}

/**
 * Middleware: avisa de toda respuesta 5xx de la API sin tener que tocar cada
 * ruta. Lee el `message` del cuerpo JSON para que el aviso sea útil.
 */
function serverErrorMonitor(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    res.locals.errorBody = body;
    return originalJson(body);
  };
  res.on("finish", () => {
    if (res.statusCode < 500) return;
    const route = `${req.method} ${req.baseUrl || ""}${req.route?.path || req.path}`;
    const body = res.locals.errorBody || {};
    notifyPlatformError({
      source: "api",
      title: `HTTP ${res.statusCode} en ${route}`,
      message: body.message || body.error || "Respuesta de error del servidor.",
      detail: {
        detalle: body.detail || null,
        usuario: req.auth?.sub || null,
        organizacion: req.auth?.orgname || req.auth?.orgId || null,
      },
      key: `api|${route}|${res.statusCode}`,
    });
  });
  next();
}

module.exports = {
  DEFAULT_PLATFORM_ALERTS,
  getPlatformAlertSettings,
  savePlatformAlertSettings,
  notifyPlatformError,
  deliverAlert,
  serverErrorMonitor,
};
