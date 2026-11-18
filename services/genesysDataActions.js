// Rendimiento de Data Actions (equivalente a "Data Actions Performance" de
// Genesys Cloud): ejecuciones, duración media/p95/p99 y errores por acción,
// agrupadas por categoría.
//
// Fuentes:
//  - POST /api/v2/analytics/actions/aggregates/query  (métrica tTotalExecution)
//  - GET  /api/v2/integrations/actions                (nombre y categoría)
//
// Permisos del cliente OAuth de la org: Analytics > Action Aggregate > View e
// Integrations > Action > View.
//
// El desglose de errores usa las dimensiones `errorType` y `remoteStatusCode`.
// Sus nombres no están documentados en el SDK: si Genesys rechaza una dimensión
// (400) se reintenta con menos y la respuesta indica con `errorBreakdown` qué
// nivel de detalle se obtuvo ("status" | "type" | "none").

const { getApiUrl } = require("../utils/genesysRegions");

const cache = new Map();
async function cached(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.promise;
  const promise = loader();
  cache.set(key, { promise, expiresAt: Date.now() + ttlMs });
  promise.catch(() => cache.delete(key));
  return promise;
}

class GenesysError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

async function genesysRequest(region, token, path, { method = "GET", body, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${getApiUrl(region)}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error(`❌ [dataActions] ${method} ${path} → ${response.status}: ${detail.slice(0, 300)}`);
      if (response.status === 403) {
        throw new GenesysError(
          403,
          "El cliente OAuth de la organización no tiene permiso para ver las Data Actions (Analytics > Action Aggregate > View, Integrations > Action > View).",
        );
      }
      throw new GenesysError(response.status, `Error de la API de Genesys Cloud: ${response.status}`);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Catálogo de acciones: id → { name, category }. */
async function loadActionCatalog(region, token, cacheKey) {
  return cached(`${cacheKey}:catalog`, 10 * 60 * 1000, async () => {
    const catalog = new Map();
    for (let page = 1; page <= 20; page++) {
      const data = await genesysRequest(
        region,
        token,
        `/api/v2/integrations/actions?pageSize=100&pageNumber=${page}`,
      );
      (data.entities || []).forEach((a) => {
        catalog.set(a.id, {
          name: a.name || a.id,
          category: a.category || a.integration?.name || null,
        });
      });
      if (!data.pageCount || page >= data.pageCount) break;
    }
    return catalog;
  });
}

function aggregateQuery(region, token, interval, groupBy) {
  return genesysRequest(region, token, "/api/v2/analytics/actions/aggregates/query", {
    method: "POST",
    body: { interval, groupBy, metrics: ["tTotalExecution"] },
  });
}

/** Suma `stats` de todos los buckets de un resultado (puede venir por intervalos). */
function readStats(result) {
  const out = { count: 0, sum: 0, max: 0, p95: null, p99: null };
  (result.data || []).forEach((bucket) => {
    (bucket.metrics || []).forEach((m) => {
      if (m.metric !== "tTotalExecution") return;
      const s = m.stats || {};
      out.count += Number(s.count || 0);
      out.sum += Number(s.sum || 0);
      out.max = Math.max(out.max, Number(s.max || 0));
      if (s.p95 != null) out.p95 = Math.max(out.p95 ?? 0, Number(s.p95));
      if (s.p99 != null) out.p99 = Math.max(out.p99 ?? 0, Number(s.p99));
    });
  });
  return out;
}

/**
 * Errores por acción. Prueba primero con código HTTP remoto, luego solo con
 * tipo de error; si ninguna dimensión existe, devuelve "none".
 */
async function loadErrors(region, token, interval) {
  const attempts = [
    { level: "status", groupBy: ["actionId", "errorType", "remoteStatusCode"] },
    { level: "type", groupBy: ["actionId", "errorType"] },
  ];
  for (const attempt of attempts) {
    try {
      const data = await aggregateQuery(region, token, interval, attempt.groupBy);
      return { level: attempt.level, results: data.results || [] };
    } catch (error) {
      if (error.status !== 400) throw error;
    }
  }
  return { level: "none", results: [] };
}

// Valores de `errorType` que Genesys usa para ejecuciones SIN error. Si el
// grupo trae uno de estos (o ninguno), la ejecución fue correcta.
const SUCCESS_ERROR_TYPES = new Set(["", "none", "no_error", "noerror", "success", "ok", "null", "undefined"]);

function isErrorType(value) {
  if (value == null) return false;
  return !SUCCESS_ERROR_TYPES.has(String(value).trim().toLowerCase().replace(/[\s-]+/g, "_"));
}

function emptyRow() {
  return {
    executions: 0,
    totalMs: 0,
    p95Ms: null,
    p99Ms: null,
    maxMs: 0,
    errors: 0,
    remoteErrors: 0,
    remote429: 0,
    remote4xx: 0,
    remote5xx: 0,
    timeouts: 0,
  };
}

function addInto(target, src) {
  target.executions += src.executions;
  target.totalMs += src.totalMs;
  target.maxMs = Math.max(target.maxMs, src.maxMs);
  // p95/p99 de un grupo no se pueden sumar: se toma el peor de sus acciones.
  if (src.p95Ms != null) target.p95Ms = Math.max(target.p95Ms ?? 0, src.p95Ms);
  if (src.p99Ms != null) target.p99Ms = Math.max(target.p99Ms ?? 0, src.p99Ms);
  ["errors", "remoteErrors", "remote429", "remote4xx", "remote5xx", "timeouts"].forEach((k) => {
    target[k] += src[k];
  });
}

function finalize(row) {
  const pct = (n) => (row.executions > 0 ? Math.round((n / row.executions) * 1000) / 10 : 0);
  return {
    ...row,
    avgMs: row.executions > 0 ? Math.round(row.totalMs / row.executions) : 0,
    errorPct: pct(row.errors),
    remoteErrorPct: pct(row.remoteErrors),
    remote429Pct: pct(row.remote429),
  };
}

/** Intervalo ISO del día `date` (YYYY-MM-DD) en la zona `timeZone`. */
function dayInterval(date, timeZone) {
  // Desfase de la zona en ese día, calculado con Intl (sin dependencias).
  const probe = new Date(`${date}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(probe);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  const offsetMs = local - probe.getTime();
  const start = new Date(Date.parse(`${date}T00:00:00Z`) - offsetMs);
  let end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  // El día en curso termina "ahora": Genesys no acepta intervalos en el futuro lejano.
  if (end.getTime() > Date.now()) end = new Date();
  return `${start.toISOString()}/${end.toISOString()}`;
}

/**
 * Rendimiento de las Data Actions de un día.
 * @returns {{ date, timezone, interval, errorBreakdown, totals, categories }}
 */
async function getDataActionsPerformance({ token, region, cacheKey, date, timezone }) {
  const tz = timezone || "America/Mexico_City";
  const day =
    date && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? date
      : new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  const interval = dayInterval(day, tz);

  return cached(`${cacheKey}:perf:${day}:${tz}`, 60 * 1000, async () => {
    const [catalog, base, errors] = await Promise.all([
      loadActionCatalog(region, token, cacheKey).catch((error) => {
        // Sin catálogo se muestran los ids; no es motivo para fallar.
        console.warn("⚠️ [dataActions] Catálogo no disponible:", error.message);
        return new Map();
      }),
      aggregateQuery(region, token, interval, ["actionId"]),
      loadErrors(region, token, interval),
    ]);

    const actions = new Map();
    const rowFor = (actionId) => {
      if (!actions.has(actionId)) actions.set(actionId, emptyRow());
      return actions.get(actionId);
    };

    (base.results || []).forEach((result) => {
      const actionId = result.group?.actionId;
      if (!actionId) return;
      const s = readStats(result);
      const row = rowFor(actionId);
      row.executions += s.count;
      row.totalMs += s.sum;
      row.maxMs = Math.max(row.maxMs, s.max);
      if (s.p95 != null) row.p95Ms = s.p95;
      if (s.p99 != null) row.p99Ms = s.p99;
    });

    // Valores de errorType recibidos, con su conteo: sirven para diagnosticar
    // si Genesys usa un nombre distinto para "sin error".
    const errorTypesSeen = {};
    errors.results.forEach((result) => {
      const actionId = result.group?.actionId;
      const errorType = result.group?.errorType;
      const { count } = readStats(result);
      const label = errorType == null ? "(sin valor)" : String(errorType);
      errorTypesSeen[label] = (errorTypesSeen[label] || 0) + count;
      if (!actionId || !isErrorType(errorType) || !count) return;
      const row = rowFor(actionId);
      row.errors += count;
      const type = String(errorType).toLowerCase();
      const isRemote = type.includes("remote") || type.includes("endpoint");
      if (isRemote) row.remoteErrors += count;
      if (type.includes("timeout")) row.timeouts += count;
      const code = Number(result.group?.remoteStatusCode);
      if (code === 429) row.remote429 += count;
      else if (code >= 400 && code < 500) row.remote4xx += count;
      else if (code >= 500) row.remote5xx += count;
    });

    console.log(`🔎 [dataActions] ${cacheKey} ${day} errorType recibidos:`, JSON.stringify(errorTypesSeen));

    const categories = new Map();
    const totals = emptyRow();
    actions.forEach((row, actionId) => {
      const meta = catalog.get(actionId);
      const categoryName = meta?.category || "Sin categoría";
      if (!categories.has(categoryName)) {
        categories.set(categoryName, { name: categoryName, ...emptyRow(), actions: [] });
      }
      const category = categories.get(categoryName);
      addInto(category, row);
      addInto(totals, row);
      category.actions.push({ id: actionId, name: meta?.name || actionId, ...finalize(row) });
    });

    const list = [...categories.values()]
      .map((c) => ({
        ...finalize(c),
        actions: c.actions.sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      date: day,
      timezone: tz,
      interval,
      errorBreakdown: errors.level,
      errorTypesSeen,
      totals: { ...finalize(totals), actions: actions.size, categories: list.length },
      categories: list,
      eventTime: new Date().toISOString(),
    };
  });
}

module.exports = { getDataActionsPerformance };
