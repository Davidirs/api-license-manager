// Configuración global de la aplicación, editable por el administrador desde
// /settings. Se guarda en la colección Firestore 'settings'.
//
//   settings/email → { fromName, fromEmail, replyTo, enabled, updatedAt }

const { db } = require("../firebase");

const EMAIL_SETTINGS_DOC = "email";

// Valores por defecto. El remitente sale de la cuenta SMTP configurada en el
// entorno; el administrador puede sobrescribirlo desde /settings.
const DEFAULT_EMAIL_SETTINGS = {
  fromName: "License Manager",
  fromEmail: process.env.SMTP_FROM || process.env.SMTP_USER || "licensemanager@esmtcx.solutions",
  replyTo: process.env.SMTP_FROM || process.env.SMTP_USER || "licensemanager@esmtcx.solutions",
  supportEmail: process.env.SMTP_FROM || process.env.SMTP_USER || "licensemanager@esmtcx.solutions",
  enabled: true,
};

// Cache en memoria: el worker de correos lee esto en cada job y no queremos
// una lectura de Firestore por cada envío cuando salgan miles.
const CACHE_TTL_MS = 60 * 1000;
let cache = null;
let cachedAt = 0;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(value) {
  return typeof value === "string" && EMAIL_RE.test(value.trim());
}

/**
 * Cabecera `from` de Resend: "Nombre <correo@dominio>".
 * Si el nombre trae comillas o corchetes, se limpian para no romper el header.
 */
function buildFromHeader(settings) {
  const name = String(settings.fromName || DEFAULT_EMAIL_SETTINGS.fromName)
    .replace(/[<>"]/g, "")
    .trim();
  const email = String(settings.fromEmail || DEFAULT_EMAIL_SETTINGS.fromEmail).trim();
  return name ? `${name} <${email}>` : email;
}

async function getEmailSettings({ force = false } = {}) {
  if (!force && cache && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cache;
  }

  try {
    const doc = await db.collection("settings").doc(EMAIL_SETTINGS_DOC).get();
    const stored = doc.exists ? doc.data() : {};

    const merged = {
      ...DEFAULT_EMAIL_SETTINGS,
      ...stored,
    };

    // Un remitente inválido guardado por error dejaría al sistema sin correos:
    // caemos al default en vez de fallar todos los envíos.
    if (!isValidEmail(merged.fromEmail)) {
      console.warn(
        `[Settings] fromEmail inválido ("${merged.fromEmail}"), usando el valor por defecto.`,
      );
      merged.fromEmail = DEFAULT_EMAIL_SETTINGS.fromEmail;
    }
    if (merged.replyTo && !isValidEmail(merged.replyTo)) {
      merged.replyTo = DEFAULT_EMAIL_SETTINGS.replyTo;
    }

    merged.from = buildFromHeader(merged);
    cache = merged;
    cachedAt = Date.now();
    return merged;
  } catch (error) {
    console.error("❌ [Settings] Error leyendo settings/email:", error.message);
    // Nunca bloqueamos el envío por un fallo de lectura de configuración.
    return { ...DEFAULT_EMAIL_SETTINGS, from: buildFromHeader(DEFAULT_EMAIL_SETTINGS) };
  }
}

async function saveEmailSettings(partial) {
  const payload = { updatedAt: Date.now() };

  if (partial.fromName !== undefined) payload.fromName = String(partial.fromName).trim();
  if (partial.fromEmail !== undefined) payload.fromEmail = String(partial.fromEmail).trim();
  if (partial.replyTo !== undefined) payload.replyTo = String(partial.replyTo).trim();
  if (partial.supportEmail !== undefined) {
    payload.supportEmail = String(partial.supportEmail).trim();
  }
  if (typeof partial.enabled === "boolean") payload.enabled = partial.enabled;

  if (payload.fromEmail !== undefined && !isValidEmail(payload.fromEmail)) {
    throw new Error("fromEmail no es una dirección de correo válida");
  }
  if (payload.replyTo && !isValidEmail(payload.replyTo)) {
    throw new Error("replyTo no es una dirección de correo válida");
  }
  if (payload.supportEmail && !isValidEmail(payload.supportEmail)) {
    throw new Error("supportEmail no es una dirección de correo válida");
  }

  await db.collection("settings").doc(EMAIL_SETTINGS_DOC).set(payload, { merge: true });
  invalidateEmailSettingsCache();
  return getEmailSettings({ force: true });
}

function invalidateEmailSettingsCache() {
  cache = null;
  cachedAt = 0;
}

module.exports = {
  DEFAULT_EMAIL_SETTINGS,
  getEmailSettings,
  saveEmailSettings,
  invalidateEmailSettingsCache,
  buildFromHeader,
  isValidEmail,
};
