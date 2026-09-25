// Restablecimiento de contraseña por enlace de un solo uso.
//
// El enlace lo pide el propio usuario desde el login ("¿Olvidaste tu
// contraseña?") o el administrador desde /settings. En ambos casos se envía al
// correo del usuario (el username de esta aplicación ES su correo) un enlace a
// /reset-password con un token aleatorio.
//
// En Firestore sólo se guarda el SHA-256 del token, nunca el token en claro: si
// alguien lee la colección no puede usar los enlaces pendientes.

const crypto = require("crypto");
const { db } = require("../firebase");

const COLLECTION = "passwordResets";

/** Vigencia del enlace. */
const RESET_TTL_MINUTES = Number(process.env.PASSWORD_RESET_TTL_MINUTES) || 60;

/** Longitud mínima de la nueva contraseña. */
const MIN_PASSWORD_LENGTH = 8;

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

/**
 * Anula los enlaces pendientes de un usuario. Se llama al emitir uno nuevo
 * (sólo vale el último correo recibido) y al completar el cambio.
 */
async function invalidatePending(username) {
  const snapshot = await db
    .collection(COLLECTION)
    .where("username", "==", username)
    .get();

  const batch = db.batch();
  let pending = 0;
  snapshot.docs.forEach((doc) => {
    if (!doc.data().usedAt) {
      batch.set(doc.ref, { usedAt: Date.now(), invalidated: true }, { merge: true });
      pending += 1;
    }
  });
  if (pending > 0) await batch.commit();
}

/**
 * Crea un token nuevo para `username` y devuelve el valor en claro, que sólo
 * viaja en el correo.
 *
 * @param {string} username
 * @param {string} requestedBy  "self" o el username del administrador.
 */
async function createResetToken(username, requestedBy = "self") {
  await invalidatePending(username);

  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  const expiresAt = now + RESET_TTL_MINUTES * 60 * 1000;

  await db.collection(COLLECTION).doc(hashToken(token)).set({
    username,
    requestedBy,
    createdAt: now,
    expiresAt,
    usedAt: null,
  });

  return { token, expiresAt, expiresInMinutes: RESET_TTL_MINUTES };
}

/**
 * Devuelve `{ ref, data }` si el token existe, no se ha usado y no ha caducado;
 * `null` en cualquier otro caso. No distingue el motivo a propósito.
 */
async function findValidReset(token) {
  if (!token || typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
    return null;
  }
  const ref = db.collection(COLLECTION).doc(hashToken(token));
  const doc = await ref.get();
  if (!doc.exists) return null;

  const data = doc.data();
  if (data.usedAt || !data.expiresAt || data.expiresAt < Date.now()) return null;
  return { ref, data };
}

/** Mensaje de error si la contraseña no cumple la política; `null` si es válida. */
function passwordPolicyError(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  }
  return null;
}

module.exports = {
  RESET_TTL_MINUTES,
  MIN_PASSWORD_LENGTH,
  createResetToken,
  findValidReset,
  invalidatePending,
  passwordPolicyError,
};
