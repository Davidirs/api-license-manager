const { Queue, Worker } = require("bullmq");
const { getRedisConnection, isQueueEnabled } = require("./redisConnection");
const { sendMail } = require("../utils/mailer");
const {
  generateTemplate,
  generateNotificationEmailTemplate,
} = require("../utils/emailTemplates");
const { getEmailSettings } = require("../utils/appSettings");
const { notificationsBlocked, blockedReason } = require("../utils/environment");
const { languageForRecipients } = require("../utils/userLanguage");

// IONOS limita el envío por hora y las conexiones simultáneas. El limiter de
// BullMQ es global a la cola (compartido entre réplicas vía Redis), así que
// aunque se encolen miles de correos nunca se supera el ritmo del proveedor.
const RATE_MAX = Number(process.env.EMAIL_RATE_MAX) || 5;
const RATE_DURATION_MS = Number(process.env.EMAIL_RATE_DURATION_MS) || 1000;
// Debe ir alineado con SMTP_MAX_CONNECTIONS del pool de nodemailer.
const EMAIL_CONCURRENCY = Number(process.env.EMAIL_CONCURRENCY) || 3;

const QUEUE_NAME = "EmailsQueue";

let emailQueue = null;
let emailWorker = null;

if (isQueueEnabled()) {
  emailQueue = new Queue(QUEUE_NAME, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      // Sin esto, con miles de correos por hora Redis crece sin control.
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
    },
  });

  emailWorker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { tipo, data, to, isNotification } = job.data;
      return await sendEmailDirect(tipo, data, to, isNotification);
    },
    {
      connection: getRedisConnection(),
      concurrency: EMAIL_CONCURRENCY,
      limiter: { max: RATE_MAX, duration: RATE_DURATION_MS },
    },
  );

  emailWorker.on("completed", (job) => {
    console.log(`✅ [Worker] Job ${job.id} de correo enviado a ${job.data.to}`);
  });

  emailWorker.on("failed", (job, err) => {
    console.error(
      `❌ [Worker] Job ${job?.id} falló al enviar correo a ${job?.data?.to}:`,
      err.message,
    );
  });
} else {
  console.log("⚠️ [Queue] BullMQ desactivado (Modo DEV sin Redis). Los envíos serán síncronos.");
}

/**
 * Genera y envía un correo. El remitente sale de la configuración del admin
 * (settings/email), no de una constante hardcodeada.
 *
 * El idioma sale de `data.lang` (lo manda el monitor, que ya conoce al usuario)
 * y, si no viene, se resuelve a partir del destinatario. Sin nada de eso,
 * español.
 */
async function sendEmailDirect(tipo, data, to, isNotification) {
  // Segunda barrera del bloqueo de staging: los jobs ya encolados antes del
  // despliegue tampoco deben salir.
  if (notificationsBlocked()) {
    console.warn(`🚫 [Email] ${blockedReason()}. Se omite '${tipo}' a ${to}.`);
    return { skipped: true, reason: "environment_blocked" };
  }

  const settings = await getEmailSettings();

  if (settings.enabled === false) {
    console.warn(`⏸️ [Email] Envío deshabilitado en settings/email. Se omite '${tipo}' a ${to}.`);
    return { skipped: true, reason: "email_disabled" };
  }

  const lang =
    (data && typeof data === "object" && (data.lang || data.language)) ||
    (await languageForRecipients(to));

  // Las plantillas usan supportEmail/footer desde la configuración.
  const payload =
    data && typeof data === "object"
      ? { ...data, settings, lang }
      : { settings, lang };

  const template = isNotification
    ? generateNotificationEmailTemplate(tipo, payload)
    : generateTemplate(tipo, payload);

  if (!template || !template.subject || !template.html) {
    throw new Error(`No se pudo generar el template para el tipo: ${tipo}`);
  }

  return await sendMail({
    from: settings.from,
    to: Array.isArray(to) ? to : [to],
    subject: template.subject,
    html: template.html,
    text: template.text,
    replyTo: settings.replyTo,
  });
}

/**
 * Encola un correo.
 *
 * Cambios respecto a la versión anterior:
 *  - Un job por destinatario: los destinatarios ya no se ven entre sí en el
 *    campo `to`, y el reintento de uno no reenvía a todos los demás.
 *  - `jobId` determinístico opcional: BullMQ descarta duplicados con el mismo
 *    id, así que una segunda ejecución del cron en la misma hora no duplica
 *    correos.
 *
 * @param {string} tipo             current | previous | alert | recovered | newuser | ...
 * @param {object} data             Payload de la plantilla.
 * @param {string[]|string} to      Destinatario(s).
 * @param {boolean} isNotification  true → plantillas de monitoreo.
 * @param {object} options          { dedupeKey } para construir el jobId.
 */
async function enqueueEmail(tipo, data, to, isNotification = false, options = {}) {
  const recipients = [...new Set((Array.isArray(to) ? to : [to]).filter(Boolean))];
  if (recipients.length === 0) return { enqueued: 0 };

  // Staging comparte base de datos y SMTP con producción: sin este corte, cada
  // cliente recibiría por duplicado toda alerta y todo reporte. Se corta ya en
  // el encolado para no llenar Redis de jobs que nunca deben enviarse.
  if (notificationsBlocked()) {
    console.warn(
      `🚫 [Queue] ${blockedReason()}. Se omiten ${recipients.length} correo(s) de tipo '${tipo}'.`,
    );
    return { enqueued: 0, skipped: recipients.length, reason: "environment_blocked" };
  }

  if (!isQueueEnabled() || !emailQueue) {
    // Desarrollo local sin Redis: envío síncrono, secuencial.
    console.log(`🚀 [Bypass Queue] Enviando '${tipo}' a ${recipients.length} destinatario(s)...`);
    for (const recipient of recipients) {
      try {
        await sendEmailDirect(tipo, data, [recipient], isNotification);
        console.log(`✅ [Bypass Queue] Correo enviado a ${recipient}`);
      } catch (e) {
        console.error(`❌ [Bypass Queue] Error enviando a ${recipient}:`, e.message);
      }
    }
    return { enqueued: recipients.length };
  }

  const jobs = recipients.map((recipient) => ({
    name: "send-email",
    data: { tipo, data, to: [recipient], isNotification },
    opts: options.dedupeKey
      ? { jobId: `${options.dedupeKey}:${recipient}` }
      : undefined,
  }));

  await emailQueue.addBulk(jobs);
  console.log(`📥 [Queue] Encolados ${jobs.length} correos de tipo '${tipo}'`);
  return { enqueued: jobs.length };
}

async function getQueueHealth() {
  if (!emailQueue) return { enabled: false };
  const counts = await emailQueue.getJobCounts(
    "waiting",
    "active",
    "completed",
    "failed",
    "delayed",
  );
  return { enabled: true, ...counts };
}

module.exports = {
  emailQueue,
  enqueueEmail,
  sendEmailDirect,
  getQueueHealth,
};
