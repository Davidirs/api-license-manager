// Envío de correo por SMTP (IONOS), en sustitución de Resend.
//
// Un único transport reutilizado con pool de conexiones: abrir una conexión SMTP
// por correo es lento y IONOS limita conexiones simultáneas. Con miles de
// notificaciones por hora, el pool es lo que hace viable el volumen.

const nodemailer = require("nodemailer");

let transporter = null;

function smtpConfig() {
  return {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    // SMTP_SECURE=true sólo para el puerto 465 (TLS implícito).
    // En 587 va false: la conexión arranca en claro y sube a TLS con STARTTLS.
    secure: String(process.env.SMTP_SECURE || "false").toLowerCase() === "true",
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
  };
}

function isConfigured() {
  const cfg = smtpConfig();
  return Boolean(cfg.host && cfg.user && cfg.pass);
}

function getTransporter() {
  if (transporter) return transporter;

  const cfg = smtpConfig();
  if (!isConfigured()) {
    throw new Error(
      "SMTP no configurado: faltan SMTP_HOST, SMTP_USER o SMTP_PASS en el entorno.",
    );
  }

  transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    // Exige STARTTLS en el puerto 587: sin esto, un servidor que no lo ofrezca
    // haría que las credenciales viajaran en claro.
    requireTLS: !cfg.secure,
    pool: true,
    maxConnections: Number(process.env.SMTP_MAX_CONNECTIONS) || 3,
    maxMessages: Number(process.env.SMTP_MAX_MESSAGES) || 100,
    connectionTimeout: 20000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
  });

  console.log(`📮 [SMTP] Transport listo → ${cfg.host}:${cfg.port} (secure=${cfg.secure})`);
  return transporter;
}

/**
 * IONOS rechaza los envíos cuyo `From` no coincide con la cuenta autenticada
 * (ni es un alias suyo). Si el administrador configura otro remitente, se envía
 * con la cuenta SMTP y se conserva el suyo como Reply-To, en vez de fallar.
 */
function resolveFrom(requestedFrom) {
  const cfg = smtpConfig();
  const authAddress = (cfg.from || cfg.user || "").toLowerCase();

  if (!requestedFrom) return cfg.from;

  const match = String(requestedFrom).match(/<([^>]+)>/);
  const requestedAddress = (match ? match[1] : requestedFrom).trim().toLowerCase();

  if (requestedAddress === authAddress) return requestedFrom;

  // Mismo dominio: IONOS suele aceptarlo si el buzón existe como alias.
  const sameDomain =
    requestedAddress.split("@")[1] &&
    requestedAddress.split("@")[1] === authAddress.split("@")[1];

  if (sameDomain) return requestedFrom;

  console.warn(
    `[SMTP] El remitente configurado (${requestedAddress}) no pertenece al dominio de la cuenta SMTP (${authAddress}). Se usa la cuenta autenticada y se conserva el configurado como Reply-To.`,
  );
  return { from: cfg.from, fallbackReplyTo: requestedFrom };
}

/**
 * Envía un correo. Firma equivalente a la que se usaba con Resend para que el
 * resto del código no cambie.
 */
async function sendMail({ from, to, subject, html, text, replyTo }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (recipients.length === 0) {
    throw new Error("No hay destinatarios para el envío");
  }

  const resolved = resolveFrom(from);
  const finalFrom = typeof resolved === "string" ? resolved : resolved.from;
  const finalReplyTo =
    typeof resolved === "string" ? replyTo : replyTo || resolved.fallbackReplyTo;

  const info = await getTransporter().sendMail({
    from: finalFrom,
    to: recipients,
    subject,
    html,
    ...(text ? { text } : {}),
    ...(finalReplyTo ? { replyTo: finalReplyTo } : {}),
  });

  return { id: info.messageId, accepted: info.accepted, rejected: info.rejected };
}

/** Comprueba credenciales y conectividad sin enviar nada. */
async function verifyTransport() {
  await getTransporter().verify();
  return true;
}

/** Fuerza la recreación del transport (tras cambiar variables de entorno). */
function resetTransport() {
  if (transporter) transporter.close();
  transporter = null;
}

module.exports = {
  sendMail,
  verifyTransport,
  resetTransport,
  isConfigured,
  smtpConfig,
  resolveFrom,
};
