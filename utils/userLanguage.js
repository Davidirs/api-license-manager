// Resolución del idioma de un destinatario de correo.
//
// El monitor ya conoce al usuario y manda el idioma explícito en el payload.
// Esto cubre el resto de casos (envíos sueltos desde /api/sendmail) buscando en
// Firestore a quién pertenece la dirección. Sin resultado, español.

const { db } = require("../firebase");
const { normalizeLanguage, DEFAULT_LANGUAGE } = require("./emailI18n");

// Una consulta a Firestore por correo enviado sería un coste fijo por cada uno
// de los miles de correos por hora; el idioma de un usuario casi nunca cambia.
const CACHE_TTL_MS = Number(process.env.USER_LANGUAGE_CACHE_TTL_MS) || 5 * 60 * 1000;
const cache = new Map();

function cached(email) {
  const hit = cache.get(email);
  if (hit && hit.expiresAt > Date.now()) return hit.language;
  return null;
}

function remember(email, language) {
  cache.set(email, { language, expiresAt: Date.now() + CACHE_TTL_MS });
  return language;
}

/**
 * Idioma configurado para una dirección de correo.
 *
 * Busca, en este orden:
 *  1. Un usuario cuyo `username` sea la propia dirección (es el caso normal:
 *     el username de esta aplicación es el correo).
 *  2. Un usuario que tenga la dirección en `preferences.recipients`.
 *
 * Nunca lanza: si Firestore falla, se devuelve el idioma por defecto para no
 * tumbar un envío por no saber en qué idioma mandarlo.
 */
async function languageForRecipient(email) {
  const address = String(email || "").trim();
  if (!address) return DEFAULT_LANGUAGE;

  const hit = cached(address);
  if (hit) return hit;

  try {
    const doc = await db.collection("users").doc(address).get();
    if (doc.exists) {
      return remember(address, normalizeLanguage(doc.data()?.preferences?.language));
    }

    const snapshot = await db
      .collection("users")
      .where("preferences.recipients", "array-contains", address)
      .limit(1)
      .get();

    if (!snapshot.empty) {
      return remember(
        address,
        normalizeLanguage(snapshot.docs[0].data()?.preferences?.language),
      );
    }
  } catch (error) {
    console.warn(
      `[i18n] No se pudo resolver el idioma de "${address}": ${error.message}. Se usa ${DEFAULT_LANGUAGE}.`,
    );
    return DEFAULT_LANGUAGE;
  }

  return remember(address, DEFAULT_LANGUAGE);
}

/** Idioma común de una lista de destinatarios (el del primero que se resuelva). */
async function languageForRecipients(recipients) {
  const list = (Array.isArray(recipients) ? recipients : [recipients]).filter(Boolean);
  if (list.length === 0) return DEFAULT_LANGUAGE;
  return languageForRecipient(list[0]);
}

/** Invalida la caché (tras cambiar el idioma de un usuario). */
function forgetRecipient(email) {
  if (email) cache.delete(String(email).trim());
  else cache.clear();
}

module.exports = {
  languageForRecipient,
  languageForRecipients,
  forgetRecipient,
};
