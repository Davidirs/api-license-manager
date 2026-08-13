// Registro de conexión y acceso.
//
// Deja rastro de dos cosas:
//  1. Autenticación: quién entró, quién falló y por qué (contraseña incorrecta,
//     usuario o organización desactivados, sin permisos sobre la organización).
//  2. Acciones sensibles: altas y cambios de usuarios y organizaciones,
//     activaciones y bajas, cambios de configuración y envíos de correo.
//
// Escribe en la colección Firestore `accessLogs`. El registro NUNCA puede
// tumbar la petición que lo origina: si Firestore falla, se avisa por consola
// y la petición sigue su curso.

const { db } = require("../firebase");

const COLLECTION = "accessLogs";

/** Días que se conservan los registros antes de purgarlos. */
const RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS) || 90;

/** Tipos de evento. Se usan tal cual como filtro en la UI del administrador. */
const EVENT = {
  // Autenticación
  LOGIN_SUCCESS: "login_success",
  LOGIN_FAILED: "login_failed",
  LOGIN_USER_NOT_FOUND: "login_user_not_found",
  LOGIN_USER_DISABLED: "login_user_disabled",
  LOGIN_ORG_DISABLED: "login_org_disabled",
  LOGIN_NO_ACCESS: "login_no_access",
  LOGIN_ERROR: "login_error",
  LOGOUT: "logout",
  SESSION_EXPIRED: "session_expired",
  SESSION_INVALID: "session_invalid",
  ACCESS_DENIED: "access_denied",

  // Acciones sensibles
  USER_CREATED: "user_created",
  USER_UPDATED: "user_updated",
  USER_STATUS_CHANGED: "user_status_changed",
  ORG_CREATED: "org_created",
  ORG_UPDATED: "org_updated",
  ORG_STATUS_CHANGED: "org_status_changed",
  EMAIL_SETTINGS_UPDATED: "email_settings_updated",
  INTEGRATION_UPDATED: "integration_updated",
  EMAIL_SENT: "email_sent",
  MONITOR_RUN: "monitor_run",
};

/** Categoría de cada evento; permite filtrar "sólo conexiones" en la UI. */
const AUTH_EVENTS = new Set([
  EVENT.LOGIN_SUCCESS,
  EVENT.LOGIN_FAILED,
  EVENT.LOGIN_USER_NOT_FOUND,
  EVENT.LOGIN_USER_DISABLED,
  EVENT.LOGIN_ORG_DISABLED,
  EVENT.LOGIN_NO_ACCESS,
  EVENT.LOGIN_ERROR,
  EVENT.LOGOUT,
  EVENT.SESSION_EXPIRED,
  EVENT.SESSION_INVALID,
  EVENT.ACCESS_DENIED,
]);

function categoryOf(type) {
  return AUTH_EVENTS.has(type) ? "auth" : "action";
}

/**
 * IP real del cliente. Detrás de un balanceador, `req.ip` es la del propio
 * balanceador; el primer valor de X-Forwarded-For es el del navegador.
 */
function clientIp(req) {
  const forwarded = req?.headers?.["x-forwarded-for"];
  if (forwarded) {
    return String(forwarded).split(",")[0].trim();
  }
  return (
    req?.headers?.["x-real-ip"] ||
    req?.socket?.remoteAddress ||
    req?.ip ||
    "desconocida"
  );
}

function userAgentOf(req) {
  // Se recorta: hay agentes de cientos de caracteres y el documento no debe
  // crecer por un dato que sólo se muestra como referencia.
  return String(req?.headers?.["user-agent"] || "").slice(0, 300) || null;
}

/** Quita del detalle cualquier cosa que no deba quedar escrita en el log. */
const FORBIDDEN_DETAIL_KEYS = new Set([
  "password",
  "passwordhash",
  "clientsecret",
  "clientid",
  "token",
  "sessiontoken",
  "apikey",
  "clientkey",
  "accesstoken",
]);

function sanitizeDetail(detail) {
  if (!detail || typeof detail !== "object") return null;
  const clean = {};
  for (const [key, value] of Object.entries(detail)) {
    if (FORBIDDEN_DETAIL_KEYS.has(key.toLowerCase())) continue;
    if (value === undefined || value === null) continue;
    clean[key] =
      typeof value === "string" ? value.slice(0, 500) :
      typeof value === "object" ? JSON.stringify(value).slice(0, 500) :
      value;
  }
  return Object.keys(clean).length > 0 ? clean : null;
}

/**
 * Escribe una entrada en el log.
 *
 * No se hace `await` desde los endpoints: el registro es un efecto secundario y
 * no debe añadir latencia ni provocar un 500 si Firestore va lento.
 */
function logEvent({
  type,
  req = null,
  username = null,
  orgname = null,
  orgId = null,
  role = null,
  success = true,
  message = null,
  target = null,
  detail = null,
}) {
  const now = new Date();
  const entry = {
    type,
    category: categoryOf(type),
    success: Boolean(success),
    username: username || req?.auth?.sub || null,
    role: role || req?.auth?.role || null,
    orgname: orgname || req?.auth?.orgname || null,
    orgId: orgId || req?.auth?.orgId || null,
    // Sobre quién se actuó, cuando no es el propio autor (p. ej. el admin
    // desactivando a otro usuario).
    target: target || null,
    message: message ? String(message).slice(0, 500) : null,
    ip: req ? clientIp(req) : null,
    userAgent: req ? userAgentOf(req) : null,
    method: req?.method || null,
    path: req?.originalUrl ? String(req.originalUrl).split("?")[0] : req?.path || null,
    detail: sanitizeDetail(detail),
    // Se guarda el epoch además de la fecha: ordenar y filtrar por rango con un
    // número es directo y no depende de la conversión de Timestamps.
    timestamp: now.getTime(),
    createdAt: now.toISOString(),
  };

  return db
    .collection(COLLECTION)
    .add(entry)
    .catch((error) => {
      console.error(`⚠️ [AuditLog] No se pudo registrar '${type}': ${error.message}`);
    });
}

/**
 * Consulta paginada del log.
 *
 * Los filtros de igualdad combinados con `orderBy` exigen índices compuestos en
 * Firestore. Si el índice no existe, en vez de devolver un 500 se repite la
 * consulta sólo por rango de fechas y se filtra en memoria: la auditoría sigue
 * funcionando aunque no se hayan creado los índices.
 */
async function queryLogs({
  from = null,
  to = null,
  type = null,
  category = null,
  username = null,
  orgname = null,
  success = null,
  limit = 50,
  cursor = null,
} = {}) {
  const pageSize = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const filters = { type, category, username, orgname, success };

  const applyRange = (query) => {
    let q = query;
    if (from !== null) q = q.where("timestamp", ">=", from);
    if (to !== null) q = q.where("timestamp", "<=", to);
    return q;
  };

  const matchesFilters = (row) =>
    (!filters.type || row.type === filters.type) &&
    (!filters.category || row.category === filters.category) &&
    (!filters.username ||
      String(row.username || "").toLowerCase().includes(String(filters.username).toLowerCase())) &&
    (!filters.orgname ||
      String(row.orgname || "").toLowerCase().includes(String(filters.orgname).toLowerCase())) &&
    (filters.success === null || row.success === filters.success);

  // El cursor lleva timestamp e id del documento ("<epoch>_<docId>"). Con sólo
  // el timestamp, dos eventos registrados en el mismo milisegundo harían que la
  // página siguiente se saltara uno: `startAfter(ts)` descarta todos los que
  // empatan.
  //
  // Por eso las consultas ordenan explícitamente por `__name__` además de por
  // `timestamp`: Firestore exige que el número de valores del cursor coincida
  // con el de cláusulas `orderBy` explícitas — el orden implícito por id no
  // cuenta y la consulta fallaría con "Too many cursor values specified".
  const parseCursor = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const raw = String(value);
    const separator = raw.indexOf("_");
    if (separator === -1) return { timestamp: Number(raw), id: null };
    return { timestamp: Number(raw.slice(0, separator)), id: raw.slice(separator + 1) };
  };

  const startCursor = parseCursor(cursor);
  const applyCursor = (query) => {
    if (!startCursor || !Number.isFinite(startCursor.timestamp)) return query;
    return startCursor.id
      ? query.startAfter(startCursor.timestamp, startCursor.id)
      : query.startAfter(startCursor.timestamp);
  };

  // `username`/`orgname` se filtran en memoria: son búsquedas por coincidencia
  // parcial, que Firestore no sabe hacer. Se leen más documentos de los que se
  // devuelven para que la página salga completa aun descartando muchos.
  const needsMemoryFilter = Boolean(filters.username || filters.orgname);

  // Ruta rápida: los filtros que Firestore puede resolver por índice.
  const buildIndexedQuery = (scanLimit) => {
    let q = db.collection(COLLECTION);
    if (filters.type) q = q.where("type", "==", filters.type);
    else if (filters.category) q = q.where("category", "==", filters.category);
    if (filters.success !== null) q = q.where("success", "==", filters.success);
    q = applyCursor(applyRange(q).orderBy("timestamp", "desc").orderBy("__name__", "desc"));
    return q.limit(scanLimit);
  };

  let docs;
  let scanLimit = needsMemoryFilter ? pageSize * 5 : pageSize;

  try {
    const snapshot = await buildIndexedQuery(scanLimit).get();
    docs = snapshot.docs;
  } catch (error) {
    console.warn(
      `[AuditLog] Consulta con índice no disponible (${error.message}). Se recurre al filtrado en memoria.`,
    );
    scanLimit = pageSize * 10;
    const q = applyCursor(applyRange(db.collection(COLLECTION)).orderBy("timestamp", "desc").orderBy("__name__", "desc"));
    const snapshot = await q.limit(scanLimit).get();
    docs = snapshot.docs;
  }

  const rows = docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter(matchesFilters);

  const items = rows.slice(0, pageSize);

  // Se puede seguir paginando en dos casos distintos:
  //  - Se recortaron filas que ya coincidían → seguir desde la última devuelta.
  //  - Se leyó una página entera de Firestore → puede haber más coincidencias
  //    más abajo aunque esta página devolviera pocas (o ninguna) tras filtrar;
  //    hay que continuar desde el último documento LEÍDO, no desde el último
  //    devuelto, o "Cargar más" se detendría antes de tiempo.
  let nextCursor = null;
  if (rows.length > pageSize) {
    const last = items[items.length - 1];
    nextCursor = `${last.timestamp}_${last.id}`;
  } else if (docs.length >= scanLimit) {
    const lastDoc = docs[docs.length - 1];
    nextCursor = `${lastDoc.data().timestamp}_${lastDoc.id}`;
  }

  return {
    items,
    nextCursor,
    scanned: docs.length,
  };
}

/** Borra los registros anteriores a la ventana de retención. */
async function purgeOldLogs(retentionDays = RETENTION_DAYS) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let deleted = 0;

  for (;;) {
    const snapshot = await db
      .collection(COLLECTION)
      .where("timestamp", "<", cutoff)
      .limit(400)
      .get();

    if (snapshot.empty) break;

    const batch = db.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    deleted += snapshot.size;

    if (snapshot.size < 400) break;
  }

  if (deleted > 0) {
    console.log(`🧹 [AuditLog] Purgados ${deleted} registros con más de ${retentionDays} días.`);
  }
  return { deleted, retentionDays };
}

module.exports = {
  EVENT,
  COLLECTION,
  RETENTION_DAYS,
  logEvent,
  queryLogs,
  purgeOldLogs,
  clientIp,
};
