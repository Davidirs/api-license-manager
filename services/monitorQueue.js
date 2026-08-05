// Cola de monitoreo: un job por organización.
//
// Antes el cron hacía todo el trabajo en línea, de forma secuencial: con N
// organizaciones el tick de la hora tardaba N × (token + billing + analytics),
// y cualquier fallo intermedio (timeout, restart del contenedor) tumbaba el
// resto de las organizaciones de esa ejecución.
//
// Ahora el cron sólo encola; este worker procesa en paralelo, con reintentos
// por organización y sin bloquear al resto.

const { Queue, Worker } = require("bullmq");
const { getRedisConnection, isQueueEnabled } = require("./redisConnection");
const { processOrgMonitor } = require("./monitorProcessor");
const { db } = require("../firebase");

const QUEUE_NAME = "MonitorQueue";
const MONITOR_CONCURRENCY = Number(process.env.MONITOR_CONCURRENCY) || 5;

let monitorQueue = null;
let monitorWorker = null;

if (isQueueEnabled()) {
  monitorQueue = new Queue(QUEUE_NAME, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 30000 },
      removeOnComplete: { age: 6 * 3600, count: 500 },
      removeOnFail: { age: 7 * 24 * 3600, count: 1000 },
    },
  });

  monitorWorker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const started = Date.now();
      const summary = await processOrgMonitor(job.data);
      console.log(
        `✅ [Monitor] ${summary.orgname} procesada en ${Date.now() - started}ms | alertas: ${summary.alerts} · recuperadas: ${summary.recovered} · actual: ${summary.currentReports} · final: ${summary.finalReports}`,
      );
      return summary;
    },
    {
      connection: getRedisConnection(),
      concurrency: MONITOR_CONCURRENCY,
    },
  );

  monitorWorker.on("failed", async (job, err) => {
    console.error(
      `❌ [Monitor] Org ${job?.data?.orgname} (${job?.data?.orgId}) falló (intento ${job?.attemptsMade}):`,
      err.message,
    );

    // Sólo al agotar los reintentos se marca el fallo, para que el estado de
    // salud no muestre errores transitorios ya resueltos.
    if (job && job.attemptsMade >= (job.opts.attempts || 1) && job.data?.orgId) {
      try {
        await db
          .collection("organizations")
          .doc(job.data.orgId)
          .set(
            {
              monitorState: {
                lastError: { message: err.message, at: Date.now() },
              },
            },
            { merge: true },
          );
      } catch (stateError) {
        console.error("[Monitor] No se pudo registrar lastError:", stateError.message);
      }
    }
  });
} else {
  console.log("⚠️ [Monitor] BullMQ desactivado (DEV sin Redis). El monitoreo correrá en línea.");
}

/**
 * Encola el monitoreo de una organización.
 * El `jobId` incluye la hora: dos ejecuciones dentro de la misma hora (por
 * ejemplo por un disparo manual) no procesan la organización dos veces.
 */
async function enqueueOrgMonitor(orgJob, hourKey) {
  if (!isQueueEnabled() || !monitorQueue) {
    // DEV sin Redis: se procesa en línea para no perder la funcionalidad.
    return processOrgMonitor(orgJob);
  }

  await monitorQueue.add("monitor-org", orgJob, {
    jobId: `monitor:${orgJob.orgId}:${hourKey}`,
  });
  return { enqueued: true, orgId: orgJob.orgId };
}

async function getMonitorHealth() {
  if (!monitorQueue) return { enabled: false };
  const counts = await monitorQueue.getJobCounts(
    "waiting",
    "active",
    "completed",
    "failed",
    "delayed",
  );
  return { enabled: true, concurrency: MONITOR_CONCURRENCY, ...counts };
}

module.exports = {
  monitorQueue,
  enqueueOrgMonitor,
  getMonitorHealth,
};
