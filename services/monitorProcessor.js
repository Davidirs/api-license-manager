// Procesamiento del monitoreo de UNA organización.
//
// El cron ya no hace este trabajo en línea: sólo encola un job por organización
// y este procesador corre en el worker, en paralelo y con reintentos.

const crypto = require("crypto");
const { db } = require("../firebase");
const { fetchOrgToken } = require("../utils/genesysRegions");
const {
  fetchCurrentPeriod,
  fetchBillingOverview,
  fetchOutboundAttempts,
  periodIdFromPeriod,
  toDateOnly,
  todayUtc,
} = require("./genesysBilling");
const { enqueueEmail } = require("./emailQueue");
const {
  STATUS,
  evaluateOrg,
  distinctThresholds,
  thresholdFor,
} = require("../utils/monitorMetrics");
const { normalizeLanguage } = require("../utils/emailI18n");

// Ventana para reintentar el reporte final si el envío del día siguiente falló.
const FINAL_REPORT_WINDOW_DAYS = Number(process.env.MONITOR_FINAL_REPORT_WINDOW_DAYS) || 5;
// Tiempo mínimo entre alertas del mismo estado (evita el flapping alrededor del umbral).
const ALERT_COOLDOWN_HOURS = Number(process.env.MONITOR_ALERT_COOLDOWN_HOURS) || 24;

const SEVERITY_ORDER = {
  [STATUS.OK]: 0,
  [STATUS.ON_DEMAND]: 1,
  [STATUS.WARNING]: 2,
  [STATUS.EXCEEDED]: 3,
};

// ── Tokens ───────────────────────────────────────────────────────────────────
// Cache por credencial: un token de client_credentials dura ~24h, no tiene
// sentido pedir uno nuevo por cada job.
const tokenCache = new Map();

async function getOrgToken(org) {
  const cacheKey = `${org.clientId}:${org.region}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.accessToken;
  }

  const token = await fetchOrgToken(org.clientId, org.clientSecret, org.region);
  tokenCache.set(cacheKey, token);
  return token.accessToken;
}

// ── Horarios ─────────────────────────────────────────────────────────────────

/**
 * Hora y día locales del usuario. Antes se comparaban strings ("8" vs "08"),
 * lo que dejaba a algunos usuarios sin recibir nada en silencio.
 */
function localTimeFor(timezone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "UTC",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const weekday = parts.find((p) => p.type === "weekday")?.value || "";
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    hour: Number.isFinite(hour) ? hour % 24 : 0,
    day: weekdayMap[weekday] ?? new Date().getUTCDay(),
    dateKey: new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date()),
  };
}

function parseHour(value) {
  const hour = Number(String(value ?? "08").split(":")[0]);
  return Number.isFinite(hour) ? Math.min(Math.max(hour, 0), 23) : 8;
}

function recipientsOf(user) {
  return [...new Set((user?.preferences?.recipients || []).filter(Boolean))];
}

/** Idioma de las plantillas para un usuario. Sin preferencia, español. */
function languageOf(user) {
  return normalizeLanguage(user?.preferences?.language);
}

/**
 * Agrupa destinatarios por idioma.
 *
 * Una alerta cubre a todos los usuarios que comparten umbral, y esos usuarios
 * pueden tener idiomas distintos: se manda un envío por idioma en vez de uno
 * solo en el idioma del primero. Devuelve [idioma, destinatarios[]].
 */
function recipientsByLanguage(users) {
  const groups = new Map();

  for (const user of users) {
    const lang = languageOf(user);
    const bucket = groups.get(lang) || new Set();
    recipientsOf(user).forEach((email) => bucket.add(email));
    groups.set(lang, bucket);
  }

  return [...groups.entries()]
    .map(([lang, emails]) => [lang, [...emails]])
    .filter(([, emails]) => emails.length > 0);
}

/**
 * La firma de una organización con muchas métricas críticas puede medir varios
 * KB. Como forma parte del `jobId` de BullMQ (y por tanto de una clave de
 * Redis), se resume a un hash corto.
 */
function shortHash(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 12);
}

// ── Proyección de cierre de período ──────────────────────────────────────────

function buildProjection(client, kpis) {
  const start = toDateOnly(client?.facturacion?.inicio);
  const end = toDateOnly(client?.facturacion?.final);
  if (!start || !end) return null;

  const dayMs = 24 * 60 * 60 * 1000;
  const totalDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / dayMs) + 1);
  const elapsedDays = Math.max(
    1,
    Math.min(totalDays, Math.round((todayUtc().getTime() - start.getTime()) / dayMs) + 1),
  );

  // Sólo tiene sentido proyectar con algo de período recorrido y sin haber terminado.
  if (elapsedDays >= totalDays || elapsedDays < 3) return null;

  const items = kpis
    .filter((k) => k.percentage !== null && k.used > 0)
    .map((k) => ({
      name: k.name,
      projectedPercentage: Math.round((k.percentage / elapsedDays) * totalDays),
    }))
    // Avisar sólo de lo que va camino de excederse aunque hoy esté en rango.
    .filter((item) => item.projectedPercentage >= 100)
    .sort((a, b) => b.projectedPercentage - a.projectedPercentage)
    .slice(0, 5);

  if (items.length === 0) return null;
  return { totalDays, elapsedDays, items };
}

// ── Alertas ──────────────────────────────────────────────────────────────────

/**
 * Decide si hay que notificar para un umbral dado.
 *
 * Reglas:
 *  - Misma firma que la vez anterior → no se reenvía (esto es lo que corta el
 *    correo cada hora: la firma ya no incluye el porcentaje exacto).
 *  - Firma nueva sin métricas críticas → correo de recuperación.
 *  - Firma nueva con métricas críticas → alerta, salvo que estemos dentro del
 *    cooldown y la severidad no haya empeorado.
 */
function decideAlert(previousState, evaluation) {
  const previousSignature = previousState?.signature || "";
  const lastAlertAt = previousState?.lastAlertAt || 0;
  const previousSeverity = SEVERITY_ORDER[previousState?.worstStatus || STATUS.OK] ?? 0;
  const currentSeverity = SEVERITY_ORDER[evaluation.worstStatus] ?? 0;

  if (previousSignature === evaluation.signature) {
    return { action: "none", reason: "sin cambios" };
  }

  if (evaluation.critical.length === 0) {
    if (!previousSignature) {
      // Primera evaluación y todo en rango: se guarda el estado, no se notifica.
      return { action: "persist", reason: "estado inicial en rango" };
    }
    return { action: "recovered", reason: "métricas normalizadas" };
  }

  const cooldownMs = ALERT_COOLDOWN_HOURS * 60 * 60 * 1000;
  const withinCooldown = lastAlertAt > 0 && Date.now() - lastAlertAt < cooldownMs;
  const escalated = currentSeverity > previousSeverity;

  if (withinCooldown && !escalated) {
    return { action: "none", reason: `dentro del cooldown de ${ALERT_COOLDOWN_HOURS}h` };
  }

  return { action: "alert", reason: escalated ? "severidad aumentó" : "cambio de estado" };
}

function previousNames(previousState) {
  return Array.isArray(previousState?.names) ? previousState.names : [];
}

// ── Procesamiento principal ──────────────────────────────────────────────────

/**
 * @param {object} jobData { orgId, orgname, region, clientId, clientSecret, users }
 */
async function processOrgMonitor(jobData) {
  const { orgId, orgname, region, users = [] } = jobData;
  const summary = {
    orgId,
    orgname,
    alerts: 0,
    recovered: 0,
    currentReports: 0,
    finalReports: 0,
    skipped: [],
  };

  if (users.length === 0) {
    summary.skipped.push("sin usuarios notificables");
    return summary;
  }

  const token = await getOrgToken(jobData);

  // ── Datos del período en curso ─────────────────────────────────────────────
  const current = await fetchCurrentPeriod(token, region);
  const client = current.client;

  // Outbound viene de Analytics, no del billing: si falla, se sigue sin ese KPI.
  let extras = {};
  try {
    extras.outbound = await fetchOutboundAttempts(
      token,
      region,
      client.facturacion?.inicio,
      client.facturacion?.final,
    );
  } catch (error) {
    console.warn(`[Monitor] ${orgname}: no se pudo obtener outbound (${error.message})`);
  }

  const orgRef = db.collection("organizations").doc(orgId);
  const orgDoc = await orgRef.get();
  const monitorState = (orgDoc.exists && orgDoc.data().monitorState) || {};
  const thresholdState = monitorState.thresholds || {};

  // ── Alertas: una evaluación por umbral distinto configurado ────────────────
  const thresholds = distinctThresholds(users);
  const evaluations = new Map();
  const nextThresholdState = { ...thresholdState };

  for (const threshold of thresholds) {
    const evaluation = evaluateOrg(client, extras, threshold);
    evaluations.set(threshold, evaluation);

    const stateKey = String(threshold);
    const previousState = thresholdState[stateKey];
    const decision = decideAlert(previousState, evaluation);

    console.log(
      `[${new Date().toISOString()}] [Monitor] ${orgname} · umbral ${threshold}% → ${decision.action} (${decision.reason}) | críticas: ${evaluation.critical.length}`,
    );

    if (decision.action === "none") continue;

    const usersForThreshold = users.filter((u) => thresholdFor(u) === threshold);
    // Un envío por idioma: los usuarios que comparten umbral no tienen por qué
    // compartir el idioma en el que quieren recibir el correo.
    const groups = recipientsByLanguage(usersForThreshold);

    if (decision.action === "alert") {
      for (const [lang, recipients] of groups) {
        await enqueueEmail(
          "alert",
          {
            client,
            kpis: evaluation.kpis,
            critical: evaluation.critical,
            threshold,
            estimatedCost: evaluation.estimatedCost,
            periodClosed: current.periodClosed,
            projection: buildProjection(client, evaluation.kpis),
            lang,
          },
          recipients,
          true,
          { dedupeKey: `alert:${orgId}:${threshold}:${shortHash(evaluation.signature)}` },
        );
        summary.alerts += recipients.length;
      }
    }

    if (decision.action === "recovered") {
      const resolved = previousNames(previousState).filter(
        (name) => !evaluation.critical.some((k) => k.name === name),
      );
      for (const [lang, recipients] of groups) {
        await enqueueEmail(
          "recovered",
          {
            client,
            kpis: evaluation.kpis,
            critical: evaluation.critical,
            threshold,
            resolved,
            periodClosed: current.periodClosed,
            lang,
          },
          recipients,
          true,
          { dedupeKey: `recovered:${orgId}:${threshold}:${current.periodId}` },
        );
        summary.recovered += recipients.length;
      }
    }

    nextThresholdState[stateKey] = {
      signature: evaluation.signature,
      worstStatus: evaluation.worstStatus,
      names: evaluation.critical.map((k) => k.name),
      updatedAt: Date.now(),
      lastAlertAt:
        decision.action === "alert" ? Date.now() : previousState?.lastAlertAt || 0,
    };
  }

  // ── Reporte final del período completado ──────────────────────────────────
  const finalReportState = monitorState.finalReport || {};
  const completedPeriod = (current.periods || []).find((p) => {
    const end = toDateOnly(p.endDate);
    return end && end.getTime() < todayUtc().getTime();
  });

  let nextFinalReportState = finalReportState;

  if (completedPeriod) {
    const completedId = periodIdFromPeriod(completedPeriod);
    const daysSinceClose = Math.floor(
      (todayUtc().getTime() - toDateOnly(completedPeriod.endDate).getTime()) /
        (24 * 60 * 60 * 1000),
    );

    const alreadyNotified =
      finalReportState.periodId === completedId
        ? new Set(finalReportState.notified || [])
        : new Set();

    // Se reintenta durante varios días: antes, si el único run del "día
    // siguiente" fallaba, el reporte final del período se perdía para siempre.
    const withinWindow = daysSinceClose >= 1 && daysSinceClose <= FINAL_REPORT_WINDOW_DAYS;

    const pendingUsers = users.filter((u) => {
      if (alreadyNotified.has(u.username)) return false;
      if (recipientsOf(u).length === 0) return false;
      const local = localTimeFor(u.preferences?.timezone);
      // Dentro de la ventana basta con que su hora del día ya haya llegado.
      return local.hour >= parseHour(u.preferences?.notificationTime);
    });

    if (withinWindow && pendingUsers.length > 0) {
      // Si el período "vigente" que reporta Genesys es justamente el que ya
      // cerró, reutilizamos esos datos en vez de pedirlos otra vez.
      const completedClient =
        current.periodId === completedId
          ? client
          : await fetchBillingOverview(
              token,
              region,
              new Date(completedPeriod.endDate).getTime(),
              completedPeriod,
            );

      const notified = new Set(alreadyNotified);

      for (const user of pendingUsers) {
        const threshold = thresholdFor(user);
        const evaluation = evaluateOrg(completedClient, extras, threshold);
        await enqueueEmail(
          "previous",
          {
            client: completedClient,
            kpis: evaluation.kpis,
            critical: evaluation.critical,
            threshold,
            estimatedCost: evaluation.estimatedCost,
            lang: languageOf(user),
          },
          recipientsOf(user),
          true,
          { dedupeKey: `previous:${orgId}:${completedId}:${user.username}` },
        );
        notified.add(user.username);
        summary.finalReports += 1;
      }

      nextFinalReportState = {
        periodId: completedId,
        notified: [...notified],
        updatedAt: Date.now(),
      };
    } else if (finalReportState.periodId !== completedId) {
      // Nuevo período cerrado: se reinicia el registro de notificados.
      nextFinalReportState = { periodId: completedId, notified: [], updatedAt: Date.now() };
    }
  }

  // ── Reporte programado del período en curso ───────────────────────────────
  for (const user of users) {
    const recipients = recipientsOf(user);
    if (recipients.length === 0) continue;

    const local = localTimeFor(user.preferences?.timezone);
    const scheduledHour = parseHour(user.preferences?.notificationTime);
    const days = user.preferences?.notificationDays || [];

    if (local.hour !== scheduledHour) continue;
    if (!days.includes(local.day)) continue;

    // Si ya se le mandó el reporte final de este período hoy, no duplicamos.
    if (
      nextFinalReportState.periodId &&
      nextFinalReportState.periodId === current.periodId &&
      (nextFinalReportState.notified || []).includes(user.username)
    ) {
      continue;
    }

    const threshold = thresholdFor(user);
    const evaluation = evaluations.get(threshold) || evaluateOrg(client, extras, threshold);

    await enqueueEmail(
      "current",
      {
        client,
        kpis: evaluation.kpis,
        critical: evaluation.critical,
        threshold,
        estimatedCost: evaluation.estimatedCost,
        periodClosed: current.periodClosed,
        projection: buildProjection(client, evaluation.kpis),
        lang: languageOf(user),
      },
      recipients,
      true,
      { dedupeKey: `current:${orgId}:${user.username}:${local.dateKey}` },
    );
    summary.currentReports += 1;
  }

  // ── Persistencia del estado ───────────────────────────────────────────────
  await orgRef.set(
    {
      monitorState: {
        thresholds: nextThresholdState,
        finalReport: nextFinalReportState,
        lastRunAt: Date.now(),
        lastPeriodId: current.periodId,
        lastError: null,
      },
    },
    { merge: true },
  );

  return summary;
}

module.exports = {
  processOrgMonitor,
  decideAlert,
  localTimeFor,
  parseHour,
  buildProjection,
  FINAL_REPORT_WINDOW_DAYS,
  ALERT_COOLDOWN_HOURS,
};
