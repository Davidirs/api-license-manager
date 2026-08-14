// Acceso a los datos de facturación de Genesys para el monitoreo.
//
// Deliberadamente NO usa el SDK (`platformClient.ApiClient.instance` es un
// singleton de proceso: región y token compartidos entre requests, lo que en
// multi-tenant puede devolver los datos de otra organización) ni el endpoint
// HTTP interno (que falla dentro de Docker). Todo por HTTP directo, con el
// token de la organización.

const { getApiUrl } = require("../utils/genesysRegions");
const { formatTrusteeBilling } = require("../utils/formatTrusteeBilling");

const DEFAULT_TIMEOUT_MS = 30000;

async function genesysFetch(url, token, { timeoutMs = DEFAULT_TIMEOUT_MS, ...init } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.headers || {}),
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const error = new Error(`Genesys ${response.status}: ${detail.slice(0, 300)}`);
      error.status = response.status;
      throw error;
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function toDateOnly(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function todayUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function isoDay(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "?";
  return d.toISOString().split("T")[0];
}

/**
 * Identificador estable de un período, para saber si su reporte final ya se envió.
 */
function periodId(facturacion) {
  return `${isoDay(facturacion?.inicio)}_${isoDay(facturacion?.final)}`;
}

/** Mismo identificador, calculado desde una entrada de /api/v2/billing/periods. */
function periodIdFromPeriod(period) {
  return `${isoDay(period?.startDate)}_${isoDay(period?.endDate)}`;
}

/**
 * Lista de períodos reales de facturación, del más reciente al más antiguo.
 * Es la única fuente fiable de las fechas de inicio/fin: el subscriptionoverview
 * no las devuelve y el endpoint las aproximaba restando un mes al timestamp.
 */
async function fetchBillingPeriods(token, region) {
  const data = await genesysFetch(`${getApiUrl(region)}/api/v2/billing/periods`, token);
  const periods = data.entities || data.periods || (Array.isArray(data) ? data : []);
  if (!Array.isArray(periods)) return [];
  return periods
    .filter((p) => p && p.startDate)
    .sort((a, b) => new Date(b.startDate) - new Date(a.startDate));
}

/**
 * Overview de facturación formateado para un timestamp dentro del período.
 * Si se conocen las fechas reales del período, se sobrescriben las que el
 * overview aproxima.
 */
async function fetchBillingOverview(token, region, timestamp, period = null) {
  const apiUrl = getApiUrl(region);

  const [overview, org] = await Promise.all([
    genesysFetch(
      `${apiUrl}/api/v2/billing/subscriptionoverview?periodEndingTimestamp=${timestamp}`,
      token,
    ),
    genesysFetch(`${apiUrl}/api/v2/organizations/me`, token).catch(() => null),
  ]);

  if (period && period.startDate && period.endDate) {
    overview.billingPeriodStartDate = new Date(period.startDate).toISOString();
    overview.billingPeriodEndDate = new Date(period.endDate).toISOString();
  } else {
    const endDateObj = new Date(timestamp);
    overview.billingPeriodEndDate = endDateObj.toISOString();
    const startDateObj = new Date(timestamp);
    startDateObj.setUTCMonth(startDateObj.getUTCMonth() - 1);
    overview.billingPeriodStartDate = startDateObj.toISOString();
  }

  overview.rampPeriodStartDate =
    overview.rampPeriodStartingTimestamp || overview.billingPeriodStartDate;
  overview.rampPeriodEndDate =
    overview.rampPeriodEndingTimestamp || overview.billingPeriodEndDate;

  if (!overview.organization && org) {
    overview.organization = { name: org.name || "", id: org.id || "" };
  }

  return formatTrusteeBilling(overview);
}

/**
 * Datos del período en curso.
 *
 * `periodClosed` indica que la fecha de fin ya pasó pero Genesys todavía no ha
 * rotado el período: pasa habitualmente durante varios días y es la razón por
 * la que no se puede asumir que "índice 0" == "período vigente".
 */
async function fetchCurrentPeriod(token, region) {
  const periods = await fetchBillingPeriods(token, region).catch(() => []);
  const current = periods[0] || null;

  const timestamp = current?.endDate
    ? Math.min(new Date(current.endDate).getTime(), Date.now())
    : Date.now();

  const client = await fetchBillingOverview(token, region, timestamp, current);
  const end = toDateOnly(client.facturacion?.final);

  return {
    client,
    period: current,
    // Se devuelve la lista completa para que el monitor decida cuál es el
    // período completado sin volver a llamar a Genesys.
    periods,
    periodId: periodId(client.facturacion),
    periodClosed: Boolean(end && end.getTime() < todayUtc().getTime()),
  };
}

/**
 * Datos del último período **completado**.
 *
 * Reemplaza al `billingPeriodIndex: 0` que se reusaba para el reporte final:
 * en lugar de asumir un índice, se decide comparando fechas. Si el período que
 * Genesys reporta como vigente ya terminó, ése *es* el período completado; si
 * no, se retrocede al anterior de la lista de períodos.
 */
async function fetchCompletedPeriod(token, region) {
  const periods = await fetchBillingPeriods(token, region);
  if (periods.length === 0) {
    throw new Error("Genesys no devolvió períodos de facturación");
  }

  const today = todayUtc().getTime();
  const completed = periods.find((p) => {
    const end = toDateOnly(p.endDate);
    return end && end.getTime() < today;
  });

  if (!completed) {
    throw new Error("No se encontró ningún período de facturación ya finalizado");
  }

  const timestamp = new Date(completed.endDate).getTime();
  const client = await fetchBillingOverview(token, region, timestamp, completed);

  return {
    client,
    period: completed,
    periodId: periodId(client.facturacion),
    daysSinceClose: Math.floor(
      (today - toDateOnly(completed.endDate).getTime()) / (24 * 60 * 60 * 1000),
    ),
  };
}

/**
 * Intentos de outbound del período (Analytics), para el KPI de Fair Use que
 * hoy no se monitorea pese a ser el que más se excede.
 */
async function fetchOutboundAttempts(token, region, startDate, endDate) {
  const interval = `${String(startDate).split("T")[0]}T00:00:00.000Z/${String(endDate).split("T")[0]}T23:59:59.999Z`;

  const body = {
    interval,
    groupBy: ["outboundCampaignId"],
    metrics: ["nOutboundAttempted"],
  };

  const data = await genesysFetch(
    `${getApiUrl(region)}/api/v2/analytics/conversations/aggregates/query`,
    token,
    { method: "POST", body: JSON.stringify(body) },
  );

  let totalAttempts = 0;
  (data.results || []).forEach((result) => {
    const metrics = result?.data?.[0]?.metrics || [];
    const metric = metrics.find((m) => m.metric === "nOutboundAttempted");
    totalAttempts += metric?.stats?.count || 0;
  });

  return { totalAttempts };
}

module.exports = {
  genesysFetch,
  fetchBillingPeriods,
  fetchBillingOverview,
  fetchCurrentPeriod,
  fetchCompletedPeriod,
  fetchOutboundAttempts,
  periodId,
  periodIdFromPeriod,
  isoDay,
  toDateOnly,
  todayUtc,
};
