// Motor de notificaciones dentro de la interfaz (campana del dashboard).
//
// Dos fuentes, una misma forma de salida:
//  1. Reglas del sistema (`SYSTEM_RULES`): se evalúan en cada consulta con el
//     estado actual del usuario y su organización, así que aparecen y
//     desaparecen solas (p. ej. "WhatsApp disponible" deja de mostrarse en
//     cuanto el usuario lo configura). Su texto vive en las traducciones del
//     dashboard: la regla devuelve claves, no frases.
//  2. Avisos del administrador (colección `announcements`): texto en es/en/pt,
//     segmentados por rol y organización, con ventana de fechas.
//
// Estado por usuario en `users/{username}.notificationState`:
//   { read: { [id]: timestamp }, dismissed: { [id]: timestamp } }
// Un aviso descartado no vuelve a mostrarse.
//
// Para añadir una notificación automática nueva basta con sumar una regla a
// SYSTEM_RULES; para una puntual, el admin la crea desde Configuración > Avisos.

const { db } = require("../firebase");
const { normalizeLanguage } = require("./emailI18n");
const { getWhaibotConfig, isIntegrationEnabled, isOrgWhatsappEnabled } = require("./whaibot");

const SEVERITIES = ["info", "success", "warning", "critical"];
const ROLES = ["client", "supervisor", "administrator"];
const LANGS = ["es", "en", "pt"];
const ANNOUNCEMENTS = "announcements";

/**
 * Reglas del sistema. Cada una:
 *   id        identificador estable (no cambiarlo: el estado leído/descartado
 *             de los usuarios se guarda con él)
 *   roles     a quién puede aplicar
 *   applies   async (ctx) → boolean
 *   build     (ctx) → { severity, icon, titleKey, bodyKey, action, popup }
 *
 * ctx = { username, role, user, org, lang }
 */
const SYSTEM_RULES = [
  {
    id: "system_whatsapp_available",
    roles: ["client", "supervisor"],
    async applies({ user, org }) {
      if (!isOrgWhatsappEnabled(org)) return false;
      const prefs = user?.preferences || {};
      // Ya lo configuró: número verificado y notificaciones activas.
      if (prefs.whatsappVerifiedAt && prefs.whatsappNotifications) return false;
      return isIntegrationEnabled(await getWhaibotConfig());
    },
    build() {
      return {
        severity: "info",
        icon: "whatsapp",
        titleKey: "notifications.system.whatsapp_available.title",
        bodyKey: "notifications.system.whatsapp_available.body",
        action: { labelKey: "notifications.system.whatsapp_available.action", href: "/settings#whatsapp" },
        // Se muestra como aviso emergente al iniciar sesión.
        popup: true,
      };
    },
  },
];

/** Texto localizado de un aviso: { es, en, pt } → idioma pedido, o español. */
function pickLang(value, lang) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value[lang] || value.es || value.en || value.pt || "";
}

function announcementApplies(a, { role, orgId, now }) {
  if (a.active === false) return false;
  if (a.startsAt && now < a.startsAt) return false;
  if (a.endsAt && now > a.endsAt) return false;
  const roles = Array.isArray(a.roles) && a.roles.length > 0 ? a.roles : ["client", "supervisor"];
  if (!roles.includes(role)) return false;
  if (Array.isArray(a.orgIds) && a.orgIds.length > 0 && !a.orgIds.includes(orgId)) return false;
  return true;
}

/**
 * Notificaciones visibles para un usuario, de la más reciente a la más antigua.
 * @param {object} p { username, role, user, org, orgId }
 */
async function collectNotifications({ username, role, user, org, orgId }) {
  const lang = normalizeLanguage(user?.preferences?.language);
  const state = user?.notificationState || {};
  const read = state.read || {};
  const dismissed = state.dismissed || {};
  const now = Date.now();
  const ctx = { username, role, user, org, lang };
  const result = [];

  for (const rule of SYSTEM_RULES) {
    if (dismissed[rule.id] || !rule.roles.includes(role)) continue;
    try {
      if (!(await rule.applies(ctx))) continue;
      result.push({
        id: rule.id,
        kind: "system",
        createdAt: 0,
        ...rule.build(ctx),
        read: Boolean(read[rule.id]),
      });
    } catch (error) {
      // Una regla rota no debe tumbar la campana entera.
      console.error(`❌ [Notificaciones] Regla ${rule.id} falló:`, error.message);
    }
  }

  const snapshot = await db.collection(ANNOUNCEMENTS).where("active", "==", true).get();
  for (const doc of snapshot.docs) {
    const a = doc.data();
    const id = `ann_${doc.id}`;
    if (dismissed[id] || !announcementApplies(a, { role, orgId, now })) continue;
    result.push({
      id,
      kind: "announcement",
      severity: a.severity || "info",
      icon: a.icon || null,
      title: pickLang(a.title, lang),
      body: pickLang(a.body, lang),
      action: a.action?.href
        ? { label: pickLang(a.action.label, lang) || null, href: a.action.href }
        : null,
      popup: a.popup === true,
      createdAt: a.startsAt || a.createdAt || 0,
      read: Boolean(read[id]),
    });
  }

  // Las del sistema primero (son accionables), luego los avisos por fecha.
  return result.sort((x, y) => {
    if (x.kind !== y.kind) return x.kind === "system" ? -1 : 1;
    return (y.createdAt || 0) - (x.createdAt || 0);
  });
}

/** Marca ids como leídos o descartados para un usuario. */
async function markNotifications(username, ids, field) {
  const clean = [...new Set((Array.isArray(ids) ? ids : [ids]).map(String))].filter((id) =>
    /^[A-Za-z0-9_-]{1,120}$/.test(id),
  );
  if (clean.length === 0) return 0;
  const now = Date.now();
  const patch = {};
  for (const id of clean) patch[id] = now;
  // Descartar implica leído.
  const state = field === "dismissed" ? { dismissed: patch, read: patch } : { read: patch };
  await db
    .collection("users")
    .doc(String(username))
    .set({ notificationState: state }, { merge: true });
  return clean.length;
}

// ── Avisos del administrador ────────────────────────────────────────────────

function cleanLangMap(value, maxLength) {
  const out = {};
  for (const lang of LANGS) {
    const text = String(value?.[lang] ?? "").trim().slice(0, maxLength);
    if (text) out[lang] = text;
  }
  return out;
}

function toTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

/** Valida lo que manda el formulario del admin. Lanza Error con mensaje legible. */
function sanitizeAnnouncement(input = {}) {
  const title = cleanLangMap(input.title, 120);
  const body = cleanLangMap(input.body, 1000);
  if (!title.es && !title.en && !title.pt) throw new Error("El aviso necesita un título en al menos un idioma.");
  if (!body.es && !body.en && !body.pt) throw new Error("El aviso necesita un texto en al menos un idioma.");

  const href = String(input.action?.href || "").trim();
  // Sólo rutas internas o https: un aviso no debe poder enlazar a javascript:.
  if (href && !/^\/[^/]/.test(href) && !/^https:\/\//i.test(href)) {
    throw new Error("El enlace debe ser una ruta interna (/settings) o una URL https.");
  }

  const startsAt = toTimestamp(input.startsAt);
  const endsAt = toTimestamp(input.endsAt);
  if (startsAt && endsAt && endsAt <= startsAt) throw new Error("La fecha de fin debe ser posterior a la de inicio.");

  const roles = (Array.isArray(input.roles) ? input.roles : []).filter((r) => ROLES.includes(r));
  return {
    title,
    body,
    severity: SEVERITIES.includes(input.severity) ? input.severity : "info",
    roles: roles.length > 0 ? roles : ["client", "supervisor"],
    orgIds: (Array.isArray(input.orgIds) ? input.orgIds : []).map((o) => String(o).trim()).filter(Boolean),
    startsAt,
    endsAt,
    popup: input.popup === true,
    active: input.active !== false,
    action: href ? { href, label: cleanLangMap(input.action?.label, 40) } : null,
  };
}

async function listAnnouncements() {
  const snapshot = await db.collection(ANNOUNCEMENTS).get();
  return snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

async function saveAnnouncement(id, input, author) {
  const data = sanitizeAnnouncement(input);
  const now = Date.now();
  if (id) {
    const ref = db.collection(ANNOUNCEMENTS).doc(String(id));
    if (!(await ref.get()).exists) throw new Error("Aviso no encontrado.");
    await ref.set({ ...data, updatedAt: now, updatedBy: author || null }, { merge: true });
    return { id: ref.id, ...data };
  }
  const ref = await db
    .collection(ANNOUNCEMENTS)
    .add({ ...data, createdAt: now, createdBy: author || null, updatedAt: now });
  return { id: ref.id, ...data };
}

async function deleteAnnouncement(id) {
  await db.collection(ANNOUNCEMENTS).doc(String(id)).delete();
}

module.exports = {
  SYSTEM_RULES,
  collectNotifications,
  markNotifications,
  listAnnouncements,
  saveAnnouncement,
  deleteAnnouncement,
  sanitizeAnnouncement,
};
