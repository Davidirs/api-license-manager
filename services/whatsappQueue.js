// Cola de notificaciones por WhatsApp (vía WhaiBot).
//
// Mismo esquema que EmailsQueue: un job por número, `jobId` determinístico para
// que una reejecución del monitor no duplique mensajes y un limiter global
// conservador. WhatsApp penaliza los envíos en ráfaga desde un mismo número
// (bloqueos del bot), así que el ritmo por defecto es bastante más bajo que el
// del correo.
//
// El mensaje llega ya redactado (utils/whatsappMessages.js). Un job puede ir
// con `delay` cuando cae en el horario de no molestar del usuario.

const { Queue, Worker } = require("bullmq");
const { getRedisConnection, isQueueEnabled } = require("./redisConnection");
const { notificationsBlocked, blockedReason } = require("../utils/environment");
const { notifyPlatformError } = require("../utils/platformAlerts");
const {
  getWhaibotConfig,
  isIntegrationEnabled,
  isTemplateEnabled,
  normalizeNumbers,
  resolveDailyLimit,
  reserveOrgDailySlot,
  sendWhaibotMessage,
} = require("../utils/whaibot");

const RATE_MAX = Number(process.env.WHATSAPP_RATE_MAX) || 1;
const RATE_DURATION_MS = Number(process.env.WHATSAPP_RATE_DURATION_MS) || 2000;
const ATTEMPTS = 3;

const QUEUE_NAME = "WhatsappQueue";

let whatsappQueue = null;
let whatsappWorker = null;

function safeJobId(raw) {
  if (!raw) return undefined;
  return String(raw).replace(/:/g, "_");
}

if (isQueueEnabled()) {
  whatsappQueue = new Queue(QUEUE_NAME, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: ATTEMPTS,
      backoff: { type: "exponential", delay: 10000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
    },
  });

  whatsappWorker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const result = await sendWhatsappDirect(job.data);
      // Un fallo de WhaiBot se lanza para que BullMQ lo reintente.
      if (result && result.success === false) throw new Error(result.message);
      return result;
    },
    {
      connection: getRedisConnection(),
      concurrency: 1,
      limiter: { max: RATE_MAX, duration: RATE_DURATION_MS },
    },
  );

  whatsappWorker.on("completed", (job) => {
    console.log(`[${new Date().toISOString()}] ✅ [WhatsApp] Job ${job.id} enviado a ${job.data.to}`);
  });

  whatsappWorker.on("failed", (job, err) => {
    console.error(
      `[${new Date().toISOString()}] ❌ [WhatsApp] Job ${job?.id} falló al enviar a ${job?.data?.to}:`,
      err.message,
    );
    if (job && job.attemptsMade >= (job.opts.attempts || 1)) {
      notifyPlatformError({
        source: "whatsapp",
        title: "Fallo al enviar WhatsApp",
        message: `No se pudo enviar '${job.data?.tipo}' a ${job.data?.to} tras ${job.attemptsMade} intentos: ${err.message}`,
        detail: { organizacion: job.data?.orgname || job.data?.orgId || null },
        // Un bot caído falla en todos los envíos: un solo aviso por ventana.
        key: "whatsapp|send_failed",
      });
    }
  });
}

/**
 * Envía un WhatsApp. Las comprobaciones se repiten aquí (no sólo al encolar):
 * el admin puede desactivar la integración o la plantilla con jobs pendientes
 * (por ejemplo, retenidos por el horario de no molestar).
 *
 * @param {object} job { tipo, to, message, orgId, orgname }
 */
async function sendWhatsappDirect({ tipo, to, message, orgId, orgname }) {
  if (notificationsBlocked()) {
    console.warn(`🚫 [WhatsApp] ${blockedReason()}. Se omite '${tipo}' a ${to}.`);
    return { skipped: true, reason: "environment_blocked" };
  }

  const cfg = await getWhaibotConfig();
  if (!isIntegrationEnabled(cfg)) {
    return { skipped: true, reason: "integration_disabled" };
  }
  if (!isTemplateEnabled(cfg, tipo)) {
    return { skipped: true, reason: "template_disabled" };
  }

  if (orgId) {
    const slot = await reserveOrgDailySlot(orgId, resolveDailyLimit(cfg));
    if (!slot.allowed) {
      console.warn(`⛔ [WhatsApp] ${orgname || orgId} alcanzó su límite diario (${slot.limit}). Se omite '${tipo}' a ${to}.`);
      if (slot.firstBlocked) {
        notifyPlatformError({
          source: "whatsapp",
          title: `Límite diario de WhatsApp alcanzado: ${orgname || orgId}`,
          message: `La organización ${orgname || orgId} llegó a ${slot.limit} WhatsApp hoy. Los siguientes envíos del día se omiten (el correo sigue saliendo).`,
          detail: { orgId, limite: slot.limit },
          key: `whatsapp|limit|${orgId}`,
        });
      }
      return { skipped: true, reason: "daily_limit" };
    }
  }

  return await sendWhaibotMessage(cfg, to, message);
}

/**
 * Encola un WhatsApp por número.
 *
 * @param {string} tipo            alert | recovered | current | previous
 * @param {object} payload         { message, orgId, orgname }
 * @param {string[]|string} to     Número(s) en formato internacional.
 * @param {object} options         { dedupeKey, delayMs }
 */
async function enqueueWhatsapp(tipo, payload, to, options = {}) {
  const recipients = normalizeNumbers(to);
  if (recipients.length === 0 || !payload?.message) return { enqueued: 0 };

  if (notificationsBlocked()) {
    console.warn(
      `🚫 [WhatsApp] ${blockedReason()}. Se omiten ${recipients.length} mensaje(s) de tipo '${tipo}'.`,
    );
    return { enqueued: 0, skipped: recipients.length, reason: "environment_blocked" };
  }

  // Se corta en el encolado para no llenar Redis de jobs que se descartarían.
  const cfg = await getWhaibotConfig();
  if (!isIntegrationEnabled(cfg) || !isTemplateEnabled(cfg, tipo)) {
    return { enqueued: 0, skipped: recipients.length, reason: "disabled" };
  }

  const delay = Math.max(0, Number(options.delayMs) || 0);
  const jobsData = recipients.map((recipient) => ({ ...payload, tipo, to: recipient }));

  if (!isQueueEnabled() || !whatsappQueue) {
    // Desarrollo local sin Redis: envío en línea. Lo retenido por el horario de
    // no molestar se programa en memoria (se pierde si se reinicia el proceso).
    const run = async (data) => {
      try {
        const result = await sendWhatsappDirect(data);
        if (result.success === false) {
          console.error(`❌ [Bypass Queue] WhatsApp a ${data.to}: ${result.message}`);
        }
      } catch (e) {
        console.error(`❌ [Bypass Queue] Error enviando WhatsApp a ${data.to}:`, e.message);
      }
    };
    console.log(
      `🚀 [Bypass Queue] WhatsApp '${tipo}' a ${recipients.length} número(s)${delay ? ` en ${Math.round(delay / 60000)} min` : ""}...`,
    );
    for (const data of jobsData) {
      if (delay) setTimeout(() => run(data), delay).unref?.();
      else await run(data);
    }
    return { enqueued: recipients.length, delayed: delay > 0 };
  }

  const jobs = jobsData.map((data) => ({
    name: "send-whatsapp",
    data,
    opts: {
      ...(options.dedupeKey ? { jobId: safeJobId(`wa_${options.dedupeKey}_${data.to}`) } : {}),
      ...(delay ? { delay } : {}),
    },
  }));

  await whatsappQueue.addBulk(jobs);
  console.log(
    `[${new Date().toISOString()}] 📥 [Queue] Encolados ${jobs.length} WhatsApp de tipo '${tipo}'${delay ? ` (retenidos ${Math.round(delay / 60000)} min por no molestar)` : ""}`,
  );
  return { enqueued: jobs.length, delayed: delay > 0 };
}

async function getWhatsappQueueHealth() {
  if (!whatsappQueue) return { enabled: false };
  const counts = await whatsappQueue.getJobCounts(
    "waiting",
    "active",
    "completed",
    "failed",
    "delayed",
  );
  return { enabled: true, ...counts };
}

module.exports = {
  whatsappQueue,
  enqueueWhatsapp,
  sendWhatsappDirect,
  getWhatsappQueueHealth,
};
