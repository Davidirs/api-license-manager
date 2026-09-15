// Orquestador del monitoreo horario.
//
// Su única responsabilidad es *decidir a quién hay que evaluar* y encolar un
// job por organización. Todo el trabajo pesado (tokens, billing, analytics,
// evaluación y envío) ocurre en el worker de MonitorQueue.
//
// Diseñado para escalar a miles de usuarios:
//  - Lectura paginada de Firestore (nunca carga toda la colección de golpe).
//  - Un job por organización, procesados en paralelo por el worker.
//  - El cron termina en segundos aunque haya cientos de organizaciones.

const cron = require("node-cron");
const { db } = require("../firebase");
const { enqueueOrgMonitor } = require("./monitorQueue");
const { isKnownRegion } = require("../utils/genesysRegions");
const { purgeOldLogs } = require("../utils/auditLog");

const PAGE_SIZE = Number(process.env.MONITOR_FIRESTORE_PAGE_SIZE) || 500;
const CRON_EXPRESSION = process.env.MONITOR_CRON || "0 * * * *";
// Purga del log de accesos: una vez al día, de madrugada.
const LOG_PURGE_CRON = process.env.LOG_PURGE_CRON || "30 3 * * *";

/**
 * Una organización o un usuario se consideran activos salvo que `active` sea
 * explícitamente false. Los documentos legados no tienen el campo.
 */
function isActive(entity) {
  return entity?.active !== false;
}

/** Sólo se conservan los campos que el worker necesita: los jobs viajan por Redis. */
function compactUser(user) {
  return {
    username: user.username || user.id,
    role: user.role,
    orgname: user.orgname,
    preferences: {
      recipients: user.preferences?.recipients || [],
      alertThreshold: user.preferences?.alertThreshold,
      notificationDays: user.preferences?.notificationDays || [],
      notificationTime: user.preferences?.notificationTime || "08:00",
      timezone: user.preferences?.timezone || "UTC",
      // Idioma en el que se le renderizan las plantillas de correo.
      language: user.preferences?.language || null,
    },
  };
}

/** Lee una colección por páginas para no cargar miles de documentos en memoria. */
async function* paginateCollection(collectionName) {
  let query = db.collection(collectionName).orderBy("__name__").limit(PAGE_SIZE);
  let lastDoc = null;

  for (;;) {
    const snapshot = lastDoc ? await query.startAfter(lastDoc).get() : await query.get();
    if (snapshot.empty) return;

    for (const doc of snapshot.docs) {
      yield { id: doc.id, ...doc.data() };
    }

    if (snapshot.size < PAGE_SIZE) return;
    lastDoc = snapshot.docs[snapshot.docs.length - 1];
  }
}

/**
 * Carga las organizaciones activas con credenciales OAuth propias.
 *
 * Ya no se usa `thrusted` ni la colección `credentials`: cada organización
 * tiene su propio clientId/clientSecret y el token se obtiene por
 * client_credentials contra su región.
 */
async function loadActiveOrganizations() {
  const byId = {};
  const byName = {};
  const skipped = { inactive: 0, sinCredenciales: 0, regionInvalida: 0 };

  for await (const org of paginateCollection("organizations")) {
    if (!org.orgId) continue;

    if (!isActive(org)) {
      skipped.inactive += 1;
      continue;
    }

    if (!org.clientId || !org.clientSecret) {
      skipped.sinCredenciales += 1;
      console.warn(
        `[Cron] Org "${org.orgname || org.orgId}" sin clientId/clientSecret. Se omite.`,
      );
      continue;
    }

    if (!isKnownRegion(org.region)) {
      skipped.regionInvalida += 1;
      console.warn(
        `[Cron] Org "${org.orgname || org.orgId}" con región no soportada ("${org.region}"). Se omite.`,
      );
      continue;
    }

    const entry = {
      orgId: org.orgId,
      orgname: org.orgname || org.orgId,
      region: org.region,
      clientId: org.clientId,
      clientSecret: org.clientSecret,
    };

    byId[org.orgId] = entry;
    if (org.orgname) byName[String(org.orgname).toLowerCase()] = entry;
  }

  return { byId, byName, skipped };
}

/**
 * Organizaciones sobre las que hay que notificar a este usuario.
 * Una org inactiva nunca entra, aunque el usuario esté suscrito a ella.
 */
function targetOrgsFor(user, orgs) {
  const subscribed = user.preferences?.subscribedOrgs || [];

  if ((user.role === "supervisor" || user.role === "administrator") && subscribed.length > 0) {
    return subscribed.filter((orgId) => orgs.byId[orgId]);
  }

  if (user.role === "client" && user.orgname) {
    const org = orgs.byName[String(user.orgname).toLowerCase()];
    return org ? [org.orgId] : [];
  }

  if (user.orgId && orgs.byId[user.orgId]) return [user.orgId];

  return [];
}

/**
 * Recorre los usuarios y arma el mapa organización → usuarios notificables.
 */
async function buildOrgJobs(orgs) {
  const jobs = {};
  const stats = {
    usuarios: 0,
    inactivos: 0,
    sinNotificaciones: 0,
    sinDestinatarios: 0,
    sinOrgActiva: 0,
    notificables: 0,
  };

  for await (const user of paginateCollection("users")) {
    stats.usuarios += 1;

    if (!isActive(user)) {
      stats.inactivos += 1;
      continue;
    }

    if (!user.preferences?.emailNotifications) {
      stats.sinNotificaciones += 1;
      continue;
    }

    if ((user.preferences?.recipients || []).length === 0) {
      stats.sinDestinatarios += 1;
      continue;
    }

    const targets = targetOrgsFor(user, orgs);
    if (targets.length === 0) {
      stats.sinOrgActiva += 1;
      continue;
    }

    stats.notificables += 1;
    const compact = compactUser(user);

    for (const orgId of targets) {
      const org = orgs.byId[orgId];
      if (!org) continue;

      if (!jobs[orgId]) jobs[orgId] = { ...org, users: [] };
      if (!jobs[orgId].users.some((u) => u.username === compact.username)) {
        jobs[orgId].users.push(compact);
      }
    }
  }

  return { jobs, stats };
}

/** Clave horaria usada para deduplicar jobs dentro de la misma hora. */
function currentHourKey() {
  return new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
}

function currentTimestamp() {
  return new Date().toISOString();
}

async function runDailyMonitor() {
  const started = Date.now();
  const startTime = currentTimestamp();
  console.log(`\n=============================================================`);
  console.log(`🕒 [Cron] [${startTime}] Iniciando monitor de correos...`);
  console.log(`=============================================================`);

  try {
    const orgs = await loadActiveOrganizations();
    console.log(
      `[Cron] [${currentTimestamp()}] Organizaciones activas: ${Object.keys(orgs.byId).length} | omitidas → inactivas: ${orgs.skipped.inactive}, sin credenciales: ${orgs.skipped.sinCredenciales}, región inválida: ${orgs.skipped.regionInvalida}`,
    );

    if (Object.keys(orgs.byId).length === 0) {
      console.log(`[Cron] [${currentTimestamp()}] No hay organizaciones activas con credenciales. Fin.`);
      return { organizaciones: 0 };
    }

    const { jobs, stats } = await buildOrgJobs(orgs);
    console.log(
      `[Cron] [${currentTimestamp()}] Usuarios: ${stats.usuarios} | notificables: ${stats.notificables} | omitidos → inactivos: ${stats.inactivos}, sin notificaciones: ${stats.sinNotificaciones}, sin destinatarios: ${stats.sinDestinatarios}, sin org activa: ${stats.sinOrgActiva}`,
    );

    const hourKey = currentHourKey();
    const orgIds = Object.keys(jobs);

    for (const orgId of orgIds) {
      try {
        await enqueueOrgMonitor(jobs[orgId], hourKey);
      } catch (error) {
        console.error(`[Cron] [${currentTimestamp()}] No se pudo encolar la org ${orgId}:`, error.message);
      }
    }

    console.log(
      `🏁 [Cron] [${currentTimestamp()}] ${orgIds.length} organizaciones encoladas en ${Date.now() - started}ms.`,
    );

    return { organizaciones: orgIds.length, usuarios: stats.notificables, hourKey };
  } catch (error) {
    console.error(`❌ [Cron] [${currentTimestamp()}] Error general en el monitor:`, error);
    throw error;
  }
}

function initCron() {
  cron.schedule(CRON_EXPRESSION, () => {
    const triggerTime = currentTimestamp();
    console.log(`\n⏰ [Cron Trigger] [${triggerTime}] Disparo programado ejecutado.`);
    runDailyMonitor().catch((err) =>
      console.error(`❌ [Cron] [${currentTimestamp()}] Ejecución programada falló:`, err.message),
    );
  });
  console.log(`[${currentTimestamp()}] 🕰️ [Cron] Orquestador inicializado con la expresión "${CRON_EXPRESSION}".`);

  // Purga diaria del log de accesos: sin ella la colección crece sin techo.
  cron.schedule(LOG_PURGE_CRON, () => {
    const purgeTime = currentTimestamp();
    console.log(`\n🧹 [Cron] [${purgeTime}] Iniciando purga diaria de logs programada...`);
    purgeOldLogs().catch((err) =>
      console.error(`❌ [Cron] [${currentTimestamp()}] Purga de logs falló:`, err.message),
    );
  });
  console.log(`[${currentTimestamp()}] 🧹 [Cron] Purga de logs programada con la expresión "${LOG_PURGE_CRON}".`);
}

module.exports = {
  initCron,
  runDailyMonitor,
  loadActiveOrganizations,
  buildOrgJobs,
  targetOrgsFor,
  isActive,
};
