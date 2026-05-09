const { Queue, Worker } = require("bullmq");
const IORedis = require("ioredis");
const { Resend } = require("resend");
const {
  generateTemplate,
  generateNotificationEmailTemplate,
} = require("../utils/emailTemplates");

const resend = new Resend(process.env.RESEND_API_KEY);
const fromEmail = "License Manager <notificaciones@genesys-metrics.cambialapp.com>";

// Para permitir desarrollo local sin Redis, verificamos el entorno
const entorno = process.env.ENTORNO || "DEV";
// Usamos redis si NO es DEV, o si pasaste explícitamente REDIS_HOST
const useQueue = entorno !== "DEV" || process.env.REDIS_HOST;

let emailQueue = null;
let emailWorker = null;
let connection = null;

if (useQueue) {
  connection = new IORedis({
    host: process.env.REDIS_HOST || "localhost",
    port: process.env.REDIS_PORT || 6379,
    maxRetriesPerRequest: null,
  });

  emailQueue = new Queue("EmailsQueue", { connection });

  emailWorker = new Worker(
    "EmailsQueue",
    async (job) => {
      const { tipo, data, to, isNotification } = job.data;
      return await sendEmailDirect(tipo, data, to, isNotification);
    },
    {
      connection,
      concurrency: 5,
    }
  );

  emailWorker.on("completed", (job) => {
    console.log(`✅ [Worker] Job ${job.id} de correo enviado a ${job.data.to}`);
  });

  emailWorker.on("failed", (job, err) => {
    console.error(`❌ [Worker] Job ${job.id} falló al enviar correo a ${job.data.to}:`, err.message);
  });
} else {
  console.log("⚠️ [Queue] BullMQ desactivado (Modo DEV sin Redis). Los envíos serán síncronos.");
}

/**
 * Lógica base compartida para generar y enviar el correo.
 */
async function sendEmailDirect(tipo, data, to, isNotification) {
  let template;
  if (isNotification) {
    template = generateNotificationEmailTemplate(tipo, data);
  } else {
    template = generateTemplate(tipo, data);
  }

  if (!template || !template.subject || !template.html) {
    throw new Error(`No se pudo generar el template para el tipo: ${tipo}`);
  }

  const { data: resendData, error } = await resend.emails.send({
    from: fromEmail,
    to: to,
    subject: template.subject,
    html: template.html,
  });

  if (error) {
    throw new Error("Resend Error: " + error.message);
  }

  return resendData;
}

/**
 * Función principal para solicitar un envío.
 * Usa BullMQ si está activo, de lo contrario lo envía en el mismo instante.
 */
async function enqueueEmail(tipo, data, to, isNotification = false) {
  const recipients = Array.isArray(to) ? to : [to];

  if (useQueue && emailQueue) {
    await emailQueue.add(
      "send-email",
      { tipo, data, to: recipients, isNotification },
      {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
      }
    );
    console.log(`📥 [Queue] Encolado email de tipo '${tipo}' para ${recipients}`);
  } else {
    // Desarrollo Local sin Redis: Bypass de Cola
    console.log(`🚀 [Bypass Queue] Enviando correo síncrono '${tipo}' a ${recipients}...`);
    try {
      await sendEmailDirect(tipo, data, recipients, isNotification);
      console.log(`✅ [Bypass Queue] Correo enviado exitosamente a ${recipients}`);
    } catch (e) {
      console.error(`❌ [Bypass Queue] Error enviando correo:`, e.message);
    }
  }
}

module.exports = {
  emailQueue,
  enqueueEmail,
};
