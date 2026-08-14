// Entorno de ejecución.
//
// Staging apunta a la MISMA base de datos y al mismo SMTP que producción. Sin
// un freno explícito, cada despliegue de staging manda a los clientes una copia
// de las alertas y los reportes que ya les llegaron desde producción. Aquí vive
// ese freno.

/** Valor normalizado de ENTORNO (DEV | STAGING | PROD | …). */
function currentEnv() {
  return String(process.env.ENTORNO || "DEV").trim().toUpperCase();
}

function isStaging() {
  return currentEnv() === "STAGING";
}

/**
 * ¿Están bloqueados los envíos automáticos de notificaciones?
 *
 * Cubre alertas del monitor, reportes de período y los correos transaccionales
 * de usuario (alta y actualización). NO cubre el correo de prueba manual del
 * administrador (/api/settings/email/test), que llama a `sendMail` directamente
 * para poder validar las credenciales SMTP también desde staging.
 */
function notificationsBlocked() {
  return isStaging();
}

/** Motivo legible para logs y respuestas de la API. */
function blockedReason() {
  return `Notificaciones deshabilitadas: ENTORNO=${currentEnv()}`;
}

module.exports = {
  currentEnv,
  isStaging,
  notificationsBlocked,
  blockedReason,
};
