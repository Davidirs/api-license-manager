// Integración con WhaiBot (WhatsApp).
//
// La configuración vive en `integrations/whaibot`:
//   { botId, apiKey, enabled, templates: { alert, recovered, current, previous } }
//
// Tres llaves deciden si un usuario recibe un WhatsApp:
//  1. La integración global (`enabled` + credenciales).
//  2. La organización (`organizations.whatsappEnabled`). A diferencia de
//     `active` y `aiEnabled`, aquí la falta del campo significa DESACTIVADO:
//     WhatsApp es opt-in por organización.
//  3. La plantilla (`templates[tipo]`): el admin decide qué envíos se notifican
//     también por WhatsApp. Afecta a todos los usuarios.

const { db } = require("../firebase");

const BASE_URL = process.env.WHAIBOT_API_URL || "https://whaibot.com";

/** Plantillas de monitoreo que pueden salir también por WhatsApp. */
const WHATSAPP_TEMPLATES = ["alert", "recovered", "current", "previous"];

/** Por defecto sólo la alerta crítica se notifica por WhatsApp. */
const DEFAULT_TEMPLATES = {
  alert: true,
  recovered: false,
  current: false,
  previous: false,
};

/** Un único número de WhatsApp (verificado) por usuario. */
const MAX_NUMBERS_PER_USER = 1;

/**
 * Tope de WhatsApp por organización y día (UTC). Protege el número del bot de
 * un bloqueo por volumen si algo se descontrola (por ejemplo, alertas en bucle).
 */
const DEFAULT_DAILY_LIMIT_PER_ORG = Number(process.env.WHATSAPP_DAILY_LIMIT_PER_ORG) || 100;

// El worker consulta la configuración en cada envío; una caché corta evita una
// lectura de Firestore por mensaje sin retrasar mucho los cambios del admin.
const CACHE_TTL_MS = 30 * 1000;
let cache = { value: null, at: 0 };

async function getWhaibotConfig({ force = false } = {}) {
  if (!force && cache.value && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.value;
  }
  const doc = await db.collection("integrations").doc("whaibot").get();
  const value = doc.exists ? doc.data() : null;
  cache = { value, at: Date.now() };
  return value;
}

function invalidateWhaibotCache() {
  cache = { value: null, at: 0 };
}

function isConfigured(cfg) {
  return !!(cfg && cfg.botId && cfg.apiKey);
}

/** Integración global utilizable: configurada y no deshabilitada. */
function isIntegrationEnabled(cfg) {
  return isConfigured(cfg) && cfg.enabled !== false;
}

/** Mapa completo plantilla → boolean, con los valores por defecto aplicados. */
function resolveTemplates(cfg) {
  const saved = (cfg && cfg.templates) || {};
  const result = {};
  for (const key of WHATSAPP_TEMPLATES) {
    result[key] = typeof saved[key] === "boolean" ? saved[key] : DEFAULT_TEMPLATES[key];
  }
  return result;
}

/** Sólo se aceptan claves conocidas con valor boolean. */
function sanitizeTemplates(input) {
  if (!input || typeof input !== "object") return null;
  const result = {};
  for (const key of WHATSAPP_TEMPLATES) {
    if (typeof input[key] === "boolean") result[key] = input[key];
  }
  return result;
}

function isTemplateEnabled(cfg, tipo) {
  return resolveTemplates(cfg)[tipo] === true;
}

function resolveDailyLimit(cfg) {
  const value = Number(cfg?.dailyLimitPerOrg);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_DAILY_LIMIT_PER_ORG;
}

/**
 * Reserva un envío del cupo diario de la organización (transacción en
 * `whatsappUsage/{orgId}_{YYYY-MM-DD}`).
 * Devuelve { allowed, count, limit, firstBlocked }: `firstBlocked` es true sólo
 * la primera vez que se alcanza el tope ese día, para avisar una sola vez.
 */
async function reserveOrgDailySlot(orgId, limit) {
  const day = new Date().toISOString().slice(0, 10);
  const ref = db.collection("whatsappUsage").doc(`${orgId}_${day}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : { count: 0, blockedNotified: false };
    if ((data.count || 0) >= limit) {
      const firstBlocked = !data.blockedNotified;
      if (firstBlocked) tx.set(ref, { blockedNotified: true }, { merge: true });
      return { allowed: false, count: data.count || 0, limit, firstBlocked };
    }
    tx.set(ref, { orgId, day, count: (data.count || 0) + 1, updatedAt: Date.now() }, { merge: true });
    return { allowed: true, count: (data.count || 0) + 1, limit, firstBlocked: false };
  });
}

/** WhatsApp habilitado en una organización (opt-in: falta = desactivado). */
function isOrgWhatsappEnabled(org) {
  return org?.whatsappEnabled === true;
}

/** Sólo dígitos, formato internacional sin '+', sin duplicados. */
function normalizeNumbers(numbers) {
  const list = Array.isArray(numbers) ? numbers : [numbers];
  return [
    ...new Set(
      list.map((n) => String(n ?? "").replace(/\D/g, "")).filter((n) => n.length >= 8),
    ),
  ];
}

/** Envía un mensaje a un número. Devuelve { to, success, message }. */
async function sendWhaibotMessage(cfg, to, message) {
  try {
    const r = await fetch(`${BASE_URL}/api/send-message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-client-key": String(cfg.apiKey).trim(),
        "x-client-botid": String(cfg.botId).trim(),
      },
      body: JSON.stringify({ to, message, fromMe: "License Manager" }),
    });
    const data = await r.json().catch(() => ({}));
    return {
      to,
      success: !!(r.ok && data.success),
      status: r.status,
      message: data.message || data.error || `HTTP ${r.status}`,
    };
  } catch (err) {
    return { to, success: false, status: 0, message: "Error de red: " + err.message };
  }
}

module.exports = {
  BASE_URL,
  WHATSAPP_TEMPLATES,
  DEFAULT_TEMPLATES,
  MAX_NUMBERS_PER_USER,
  DEFAULT_DAILY_LIMIT_PER_ORG,
  resolveDailyLimit,
  reserveOrgDailySlot,
  getWhaibotConfig,
  invalidateWhaibotCache,
  isConfigured,
  isIntegrationEnabled,
  resolveTemplates,
  sanitizeTemplates,
  isTemplateEnabled,
  isOrgWhatsappEnabled,
  normalizeNumbers,
  sendWhaibotMessage,
};
