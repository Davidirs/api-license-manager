// Fuente única de verdad para el cálculo de KPIs del monitoreo.
//
// Antes el porcentaje se calculaba en tres sitios distintos (cronOrchestrator,
// emailTemplates y el dashboard) con reglas diferentes: distintos denominadores,
// umbral hardcodeado en 90 y división entre cero produciendo Infinity.
// Todo el monitoreo debe pasar por aquí.

// Políticas de Fair Use de Genesys (no vienen en el billing; son contractuales).
const FAIR_USE = {
  byocNamedMinutes: 5000,
  byocConcurrentMinutes: 6500,
  byocOverageCostPerMinute: 0.0012,
  outboundNamedAttempts: 15000,
  outboundConcurrentAttempts: 19500,
  outboundOverageCostPerAttempt: 0.005,
};

const BYOC_RESOURCE_NAME = "Genesys Cloud BYOC Cloud";

// Estados posibles de un KPI, de menor a mayor severidad.
const STATUS = {
  OK: "ok",
  ON_DEMAND: "ondemand", // consumo sin compromiso contratado
  WARNING: "warning", // por encima del umbral del usuario
  EXCEEDED: "exceeded", // por encima del 100% de lo contratado
};

const SEVERITY_ORDER = {
  [STATUS.EXCEEDED]: 3,
  [STATUS.WARNING]: 2,
  [STATUS.ON_DEMAND]: 1,
  [STATUS.OK]: 0,
};

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Porcentaje de uso. Devuelve `null` cuando no hay base de comparación,
 * en vez de Infinity o NaN: quien lo consuma decide cómo presentar "sin límite".
 */
function calculatePercentage(used, total) {
  const u = toNumber(used);
  const t = toNumber(total);
  if (t <= 0) return null;
  return Math.round((u / t) * 100);
}

/**
 * Conteo de licencias nombradas y concurrentes, con las mismas exclusiones que
 * usa el dashboard para calcular los límites de Fair Use.
 */
function countLicenses(licencias = []) {
  let named = 0;
  let concurrent = 0;

  licencias.forEach((lic) => {
    const name = String(lic?.name || "").toLowerCase();
    const qty = Math.max(toNumber(lic?.prepayQuantity), toNumber(lic?.usageQuantity));

    if (name.includes("concurrent")) {
      concurrent += qty;
    } else if (
      !name.includes("wallboard") &&
      !name.includes("webrtc") &&
      !name.includes("collaborate")
    ) {
      named += qty;
    }
  });

  return { named, concurrent };
}

function makeKpi({
  key,
  name,
  category,
  used,
  committed = 0,
  included = 0,
  overage = null,
  unit = "",
  costPerUnit = 0,
  limitSource = "billing",
}) {
  const usedN = toNumber(used);
  const committedN = toNumber(committed);
  const includedN = toNumber(included);
  const total = committedN + includedN;
  const overageN =
    overage !== null && overage !== undefined
      ? toNumber(overage)
      : Math.max(0, usedN - total);

  return {
    key,
    name,
    category,
    used: usedN,
    committed: committedN,
    included: includedN,
    total,
    overage: overageN,
    percentage: calculatePercentage(usedN, total),
    unit,
    estimatedCost: overageN * toNumber(costPerUnit),
    limitSource,
  };
}

/**
 * Construye la lista completa de KPIs de una organización.
 *
 * @param {object} clientData  Salida de formatTrusteeBilling.
 * @param {object} extras      Datos que no vienen del billing (ej. outbound de Analytics).
 */
function buildKpis(clientData = {}, extras = {}) {
  const kpis = [];

  (clientData.licencias || []).forEach((lic) => {
    kpis.push(
      makeKpi({
        key: `licencia:${lic.name}`,
        name: lic.name,
        category: "licencia",
        used: lic.usageQuantity,
        committed: lic.prepayQuantity,
        overage: lic.overageQuantity,
      }),
    );
  });

  (clientData.addons || []).forEach((addon) => {
    kpis.push(
      makeKpi({
        key: `addon:${addon.name}`,
        name: addon.name,
        category: "addon",
        used: addon.usageQuantity,
        committed: addon.prepayQuantity,
        overage: addon.overageQuantity,
      }),
    );
  });

  // Recursos: el denominador correcto es prepago + incluido (fair-use del billing).
  // BYOC Cloud se excluye aquí porque su límite real es de Fair Use por licencia,
  // no el prepago del billing; se añade más abajo con su propio cálculo.
  (clientData.resources || []).forEach((resource) => {
    if (resource.name === BYOC_RESOURCE_NAME) return;
    kpis.push(
      makeKpi({
        key: `recurso:${resource.name}`,
        name: resource.name,
        category: "recurso",
        used: resource.usageQuantity,
        committed: resource.prepayQuantity,
        included: resource.incluido,
        overage: resource.overageQuantity,
      }),
    );
  });

  (clientData.aiExperience || []).forEach((ai) => {
    kpis.push(
      makeKpi({
        key: `ai:${ai.name}`,
        name: ai.name,
        category: "ai",
        used: ai.usageQuantity,
        committed: ai.prepayQuantity,
        overage: ai.overageQuantity,
      }),
    );
  });

  (clientData.devices || []).forEach((device) => {
    kpis.push(
      makeKpi({
        key: `dispositivo:${device.name}`,
        name: device.name,
        category: "dispositivo",
        used: device.usageQuantity,
        committed: device.prepayQuantity,
        overage: device.overageQuantity,
      }),
    );
  });

  if (clientData.storage) {
    kpis.push(
      makeKpi({
        key: "storage",
        name: "Storage",
        category: "almacenamiento",
        used: clientData.storage.enUso,
        committed: clientData.storage.comprometido,
        overage: clientData.storage.overageQuantity,
        unit: "GB",
      }),
    );
  }

  if (clientData.iaTokens) {
    kpis.push(
      makeKpi({
        key: "ia-tokens",
        name: "IA Tokens",
        category: "tokens",
        used: clientData.iaTokens.usageQuantity,
        committed: clientData.iaTokens.prepayQuantity,
        included: clientData.iaTokens.incluido,
        overage: clientData.iaTokens.overageQuantity,
      }),
    );
  }

  // ── KPIs de Fair Use (límite calculado a partir de licencias) ──────────────
  const { named, concurrent } = countLicenses(clientData.licencias);

  const byocResource = (clientData.resources || []).find(
    (r) => r.name === BYOC_RESOURCE_NAME,
  );
  if (byocResource) {
    const byocLimit =
      named * FAIR_USE.byocNamedMinutes + concurrent * FAIR_USE.byocConcurrentMinutes;
    kpis.push(
      makeKpi({
        key: "fairuse:byoc",
        name: "BYOC Cloud (Fair Use)",
        category: "fairuse",
        // Minutos facturados por Genesys, no el tTalk de Analytics.
        used: byocResource.usageQuantity,
        committed: byocLimit,
        unit: "min",
        costPerUnit: FAIR_USE.byocOverageCostPerMinute,
        limitSource: "fair-use",
      }),
    );
  }

  if (extras.outbound && extras.outbound.totalAttempts !== undefined) {
    const outboundLimit =
      named * FAIR_USE.outboundNamedAttempts +
      concurrent * FAIR_USE.outboundConcurrentAttempts;
    kpis.push(
      makeKpi({
        key: "fairuse:outbound",
        name: "Intentos Outbound (Fair Use)",
        category: "fairuse",
        used: extras.outbound.totalAttempts,
        committed: outboundLimit,
        unit: "intentos",
        costPerUnit: FAIR_USE.outboundOverageCostPerAttempt,
        limitSource: "fair-use",
      }),
    );
  }

  return kpis;
}

/**
 * Clasifica un KPI contra el umbral del usuario.
 */
function classify(kpi, threshold) {
  const limit = toNumber(threshold) || 90;

  if (kpi.percentage !== null) {
    if (kpi.percentage >= 100) return STATUS.EXCEEDED;
    if (kpi.percentage >= limit) return STATUS.WARNING;
    return STATUS.OK;
  }

  // Sin compromiso contratado pero con consumo: es gasto on-demand real.
  // Se reporta, pero con firma estable para no re-alertar cada hora (ver signatureFor).
  if (kpi.used > 0) return STATUS.ON_DEMAND;
  return STATUS.OK;
}

/**
 * Firma de un KPI para detectar cambios *significativos*.
 *
 * Deliberadamente NO incluye el porcentaje exacto: antes la firma llevaba
 * "Licencia X: 91%" y cualquier variación de 1% (o el consumo absoluto en KPIs
 * sin compromiso) disparaba un correo nuevo cada hora. Ahora sólo cambia al
 * cambiar de estado, o al saltar un tramo de 25% por encima del 100%.
 */
function signatureFor(kpi, status) {
  if (status === STATUS.EXCEEDED) {
    const bucket = Math.min(Math.floor(kpi.percentage / 25) * 25, 500);
    return `${kpi.key}:exceeded:${bucket}`;
  }
  return `${kpi.key}:${status}`;
}

function formatValue(kpi) {
  const unit = kpi.unit ? ` ${kpi.unit}` : "";
  const used = kpi.used.toLocaleString("es-MX");
  if (kpi.total > 0) {
    return `${used}${unit} / ${kpi.total.toLocaleString("es-MX")}${unit} (${kpi.percentage}%)`;
  }
  return `${used}${unit} (sin compromiso)`;
}

/**
 * Evalúa una organización para un umbral concreto.
 *
 * @returns {{ kpis, critical, signature, estimatedCost, worstStatus }}
 */
function evaluateOrg(clientData, extras = {}, threshold = 90) {
  const kpis = buildKpis(clientData, extras).map((kpi) => {
    const status = classify(kpi, threshold);
    return {
      ...kpi,
      status,
      signature: signatureFor(kpi, status),
      label: `${kpi.name}: ${formatValue(kpi)}`,
    };
  });

  const critical = kpis
    .filter((k) => k.status !== STATUS.OK)
    .sort((a, b) => {
      const bySeverity = SEVERITY_ORDER[b.status] - SEVERITY_ORDER[a.status];
      if (bySeverity !== 0) return bySeverity;
      return (b.percentage ?? 0) - (a.percentage ?? 0);
    });

  const worstStatus = critical.length > 0 ? critical[0].status : STATUS.OK;

  return {
    kpis,
    critical,
    // Firma del conjunto: ordenada para ser estable ante cambios de orden.
    signature: critical
      .map((k) => k.signature)
      .sort()
      .join("|"),
    estimatedCost: critical.reduce((sum, k) => sum + k.estimatedCost, 0),
    worstStatus,
    threshold: toNumber(threshold) || 90,
  };
}

/**
 * Umbrales distintos configurados por un grupo de usuarios.
 * Permite evaluar una sola vez por umbral en lugar de una vez por usuario.
 */
function distinctThresholds(users = []) {
  const set = new Set();
  users.forEach((u) => {
    const t = toNumber(u?.preferences?.alertThreshold) || 90;
    set.add(Math.min(Math.max(t, 1), 200));
  });
  if (set.size === 0) set.add(90);
  return [...set].sort((a, b) => a - b);
}

function thresholdFor(user) {
  const t = toNumber(user?.preferences?.alertThreshold) || 90;
  return Math.min(Math.max(t, 1), 200);
}

module.exports = {
  FAIR_USE,
  STATUS,
  BYOC_RESOURCE_NAME,
  toNumber,
  calculatePercentage,
  countLicenses,
  buildKpis,
  classify,
  signatureFor,
  formatValue,
  evaluateOrg,
  distinctThresholds,
  thresholdFor,
};
