// KPIs de licenciamiento del informe mensual, calculados en el servidor.
//
// Hasta ahora las reglas de fair use (BYOC Cloud, outbound), la asignación de
// IVR y los porcentajes de uso sólo existían en el frontend
// (genesys-dashboard.tsx: calculateByocMetrics, calculateOutboundLimits,
// calculateIvrMetrics) y, copiadas en Python, en el generador de informes
// (informes_mensuales/informes/license_manager.py: calcular_kpis y alertas).
// Este módulo es la versión de referencia: /api/report/licensing la expone y
// /api/analyze-metrics la usa para que la IA conozca el fair use.
//
// La forma del resultado (claves en español y snake_case) es la de
// `calcular_kpis`, para que el generador pueda consumir el endpoint sin
// cambios. Los redondeos imitan los de Python (round y format) para que las
// cifras coincidan exactamente.

const {
  fetchBillingPeriods,
  fetchBillingOverview,
  fetchOutboundCampaignAttempts,
  toDateOnly,
  todayUtc,
} = require("./genesysBilling");

const BYOC = "Genesys Cloud BYOC Cloud";
const IVR = "Genesys Cloud IVR Basic Per Minute Charge";

// Minutos / intentos de fair use por licencia.
const BYOC_NOMINAL = 5000;
const BYOC_CONCURRENTE = 6500;
const OUTBOUND_NOMINAL = 15000;
const OUTBOUND_CONCURRENTE = 19500;

// Zona horaria por defecto para contar los intentos outbound (la misma que el
// dashboard cuando el usuario no tiene una configurada).
const DEFAULT_TIMEZONE = "America/Mexico_City";

// ---------------------------------------------------------------------------
// Números con la semántica de Python
// ---------------------------------------------------------------------------

/** Cantidad de Genesys (texto, número o ausente) como número; 0 si no es válida. */
function num(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Equivalente a `format(x, f".{digits}f")` de Python: redondeo correcto sobre
 * el valor binario exacto y, en empate exacto, al par. `toFixed` desempata
 * hacia arriba, así que 1234.5 daría "1235" donde Python escribe "1234".
 */
function pyFixed(x, digits) {
  if (!Number.isFinite(x)) return String(x);
  const sign = x < 0 || Object.is(x, -0) ? "-" : "";
  // Con 60 decimales de más, la expansión decimal de un double de este rango
  // es exacta: se ve si la parte descartada es un empate de verdad.
  const [intPart, fracPart = ""] = Math.abs(x).toFixed(Math.min(100, digits + 60)).split(".");
  const kept = BigInt(intPart + fracPart.slice(0, digits));
  const rest = fracPart.slice(digits);
  let roundUp = rest[0] > "5" || (rest[0] === "5" && /[1-9]/.test(rest.slice(1)));
  if (rest[0] === "5" && !roundUp && !/[1-9]/.test(rest.slice(1))) {
    roundUp = kept % 2n === 1n;
  }
  const digitsStr = (kept + (roundUp ? 1n : 0n)).toString().padStart(digits + 1, "0");
  if (digits === 0) return sign + digitsStr;
  return `${sign}${digitsStr.slice(0, -digits)}.${digitsStr.slice(-digits)}`;
}

/** `round(x, digits)` de Python. */
function pyRound(x, digits) {
  return Number(pyFixed(x, digits));
}

/** `f"{x:,.{digits}f}"` de Python: separador de miles con coma. */
function fmt(x, digits) {
  const [intPart, fracPart] = pyFixed(x, digits).split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fracPart === undefined ? grouped : `${grouped}.${fracPart}`;
}

/** Porcentaje con un decimal; null si no hay total contra el que medir. */
function pct(usado, total) {
  return total ? pyRound((usado / total) * 100, 1) : null;
}

// ---------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------

/**
 * Licencias nominales y concurrentes como las cuenta el dashboard para el fair
 * use: el máximo entre contratado y usado, sin wallboard, WebRTC ni Collaborate.
 */
function licenciasNominales(licencias) {
  let nominales = 0;
  let concurrentes = 0;
  for (const l of licencias || []) {
    const cantidad = Math.max(Math.trunc(num(l.prepayQuantity)), Math.trunc(num(l.usageQuantity)));
    const nombre = String(l.name || "").toLowerCase();
    if (nombre.includes("concurrent")) {
      concurrentes += cantidad;
    } else if (!["wallboard", "webrtc", "collaborate"].some((x) => nombre.includes(x))) {
      nominales += cantidad;
    }
  }
  return { nominales, concurrentes };
}

function fila(item) {
  const contratadas = num(item.prepayQuantity);
  const enUso = num(item.usageQuantity);
  return {
    nombre: item.name,
    contratadas,
    en_uso: enUso,
    sobreuso: Math.max(0, enUso - contratadas),
    pct: pct(enUso, contratadas),
  };
}

/**
 * KPIs del informe a partir del cliente formateado (formatTrusteeBilling) y,
 * opcionalmente, de los intentos outbound del período ({ totalAttempts, campaigns }).
 * Sin intentos, `outbound` es null.
 */
function calcularKpis(c, intentos = null) {
  const recursos = new Map((c.resources || []).map((r) => [r.name, r]));
  const { nominales, concurrentes } = licenciasNominales(c.licencias);

  const byocR = recursos.get(BYOC) || null;
  const byocUsado = num(byocR?.usageQuantity);
  const byocLimite = nominales * BYOC_NOMINAL + concurrentes * BYOC_CONCURRENTE;
  const byoc = {
    existe: Boolean(byocR),
    usado: byocUsado,
    limite_fair_use: byocLimite,
    prepagado: num(byocR?.prepayQuantity),
    nominales,
    concurrentes,
    excedente: Math.max(0, byocUsado - byocLimite),
    pct: byocLimite ? pct(byocUsado, byocLimite) : byocUsado ? 100 : 0,
  };

  const ivrR = recursos.get(IVR) || null;
  const ivrAsignado = num(ivrR?.prepayQuantity) + num(ivrR?.incluido);
  const ivr = {
    existe: Boolean(ivrR),
    usado: num(ivrR?.usageQuantity),
    asignado: ivrAsignado,
    bajo_demanda: num(ivrR?.overageQuantity),
    pct: pct(num(ivrR?.usageQuantity), ivrAsignado),
  };

  const otros = [];
  for (const [nombre, r] of recursos) {
    if (nombre === BYOC || nombre === IVR) continue;
    const comprometido = num(r.prepayQuantity);
    const incluido = num(r.incluido);
    const usado = num(r.usageQuantity);
    if (!(comprometido || incluido || usado)) continue;
    otros.push({
      nombre,
      comprometido,
      incluido,
      en_uso: usado,
      sobreuso: num(r.overageQuantity),
      pct: pct(usado, comprometido + incluido),
    });
  }

  const s = c.storage || {};
  const storage = { comprometido: num(s.comprometido), en_uso: num(s.enUso) };
  storage.sobreuso = Math.max(0, storage.en_uso - storage.comprometido);
  storage.pct = pct(storage.en_uso, storage.comprometido);

  const t = c.iaTokens || {};
  const tokens = {
    nombre: t.name || "AI Experience Tokens",
    prepagados: num(t.prepayQuantity),
    incluidos: num(t.incluido),
    en_uso: num(t.usageQuantity),
    sobreuso: num(t.overageQuantity),
  };
  tokens.disponible = tokens.prepagados + tokens.incluidos;
  tokens.pct = pct(tokens.en_uso, tokens.disponible);

  const consumoIa = (c.aiExperience || [])
    .filter((a) => num(a.usageQuantity) > 0)
    .map((a) => ({ nombre: a.name, en_uso: num(a.usageQuantity) }));

  let outbound = null;
  if (intentos) {
    const limite = nominales * OUTBOUND_NOMINAL + concurrentes * OUTBOUND_CONCURRENTE;
    const total = num(intentos.totalAttempts);
    outbound = {
      intentos: total,
      limite_fair_use: limite,
      excedente: Math.max(0, total - limite),
      pct: pct(total, limite),
      campanias: (intentos.campaigns || []).length,
    };
  }

  return {
    organizacion: c.name ?? null,
    org_id: c.orgId ?? null,
    periodo: { inicio: c.facturacion?.inicio ?? null, fin: c.facturacion?.final ?? null },
    licencias: (c.licencias || []).map(fila),
    addons: (c.addons || []).map(fila),
    byoc,
    ivr,
    recursos: otros,
    storage,
    ia_tokens: tokens,
    consumo_ia: consumoIa,
    outbound,
    dispositivos: (c.devices || []).filter((d) => num(d.usageQuantity)).map(fila),
  };
}

/** Alertas deterministas del informe: los números salen de los datos, no de la IA. */
function alertas(k) {
  const lista = [];
  for (const l of [...k.licencias, ...k.addons]) {
    if (l.sobreuso > 0) {
      lista.push({
        nivel: "alta",
        tema: l.nombre,
        detalle: `${fmt(l.en_uso, 0)} en uso frente a ${fmt(l.contratadas, 0)} contratadas (${fmt(l.sobreuso, 0)} por encima).`,
      });
    } else if (l.pct !== null && l.pct >= 90) {
      lista.push({
        nivel: "media",
        tema: l.nombre,
        detalle: `${fmt(l.en_uso, 0)} en uso de ${fmt(l.contratadas, 0)} contratadas (${pyFixed(l.pct, 1)}%), cerca del límite.`,
      });
    }
  }
  const b = k.byoc;
  if (b.existe && b.excedente > 0) {
    lista.push({
      nivel: "alta",
      tema: "BYOC Cloud",
      detalle: `${fmt(b.usado, 1)} minutos frente a un fair use de ${fmt(b.limite_fair_use, 0)} (${fmt(b.excedente, 1)} por encima).`,
    });
  }
  const o = k.outbound;
  if (o && o.excedente > 0) {
    lista.push({
      nivel: "alta",
      tema: "Intentos outbound",
      detalle: `${fmt(o.intentos, 0)} intentos frente a un fair use de ${fmt(o.limite_fair_use, 0)}.`,
    });
  }
  for (const r of k.recursos) {
    if (r.sobreuso > 0) {
      lista.push({
        nivel: "alta",
        tema: r.nombre,
        detalle: `${fmt(r.en_uso, 0)} en uso, ${fmt(r.sobreuso, 0)} por encima de lo comprometido.`,
      });
    } else if (r.pct !== null && r.pct >= 85) {
      lista.push({ nivel: "media", tema: r.nombre, detalle: `Uso al ${pyFixed(r.pct, 1)}% de lo comprometido.` });
    }
  }
  for (const [nombre, x] of [["Storage", k.storage], ["IA Tokens", k.ia_tokens]]) {
    if (x.sobreuso > 0) {
      lista.push({ nivel: "alta", tema: nombre, detalle: `Sobreuso de ${fmt(x.sobreuso, 0)}.` });
    } else if (x.pct !== null && x.pct >= 85) {
      lista.push({ nivel: "media", tema: nombre, detalle: `Uso al ${pyFixed(x.pct, 1)}% de lo disponible.` });
    }
  }
  return lista;
}

/**
 * Lo que la IA necesita saber del fair use. Sin esto, el análisis veía el
 * consumo de BYOC sin prepago (overageQuantity = todo lo usado) y lo contaba
 * como sobreuso aunque estuviera dentro de lo incluido en las licencias.
 */
function resumenFairUse(k) {
  return {
    licencias_para_fair_use: {
      nominales: k.byoc.nominales,
      concurrentes: k.byoc.concurrentes,
      regla: "máx(prepagadas, en uso) por licencia, sin wallboard, WebRTC ni Collaborate",
    },
    byoc_cloud: k.byoc.existe
      ? {
          minutos_usados: k.byoc.usado,
          minutos_por_licencia_nominal: BYOC_NOMINAL,
          minutos_por_licencia_concurrente: BYOC_CONCURRENTE,
          limite_fair_use: k.byoc.limite_fair_use,
          excedente: k.byoc.excedente,
          pct_del_fair_use: k.byoc.pct,
          dentro_del_fair_use: k.byoc.excedente === 0,
        }
      : null,
    intentos_outbound: k.outbound
      ? {
          intentos: k.outbound.intentos,
          intentos_por_licencia_nominal: OUTBOUND_NOMINAL,
          intentos_por_licencia_concurrente: OUTBOUND_CONCURRENTE,
          limite_fair_use: k.outbound.limite_fair_use,
          excedente: k.outbound.excedente,
          pct_del_fair_use: k.outbound.pct,
          dentro_del_fair_use: k.outbound.excedente === 0,
        }
      : null,
    ivr_basic: k.ivr.existe
      ? {
          minutos_usados: k.ivr.usado,
          minutos_asignados: k.ivr.asignado,
          minutos_bajo_demanda: k.ivr.bajo_demanda,
          pct_de_lo_asignado: k.ivr.pct,
        }
      : null,
    storage: {
      comprometido: k.storage.comprometido,
      en_uso: k.storage.en_uso,
      sobreuso: k.storage.sobreuso,
    },
  };
}

/**
 * Copia de los datos del cliente para la IA con el sobreuso de BYOC medido
 * contra el fair use (formatTrusteeBilling lo mide contra el prepago, que en
 * BYOC suele ser 0) y el de storage recalculado.
 */
function clientDataConFairUse(c, k) {
  return {
    ...c,
    resources: (c.resources || []).map((r) =>
      r.name === BYOC ? { ...r, overageQuantity: k.byoc.excedente, limiteFairUse: k.byoc.limite_fair_use } : r,
    ),
    storage: { ...(c.storage || {}), overageQuantity: k.storage.sobreuso },
  };
}

// ---------------------------------------------------------------------------
// Obtención de datos
// ---------------------------------------------------------------------------

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  error.expose = true;
  return error;
}

/**
 * Traduce `endDate` (como en /api/subscriptionoverview: "previous", "current",
 * timestamp en ms o fecha) a un timestamp y, si se puede, al período real de
 * /billing/periods, cuyas fechas sustituyen a las aproximadas.
 */
function resolvePeriod(endDate, periods) {
  if (endDate === "previous") {
    // El último período YA FINALIZADO, no el índice 1: Genesys tarda días en
    // rotar el período vigente (misma regla que /api/subscriptionoverview).
    const today = todayUtc().getTime();
    const period = periods.find((p) => {
      const end = toDateOnly(p.endDate);
      return end && end.getTime() < today;
    });
    if (!period || !period.endDate) {
      const error = new Error("No se encontró ningún periodo de facturación ya finalizado.");
      error.status = 404;
      error.expose = true;
      throw error;
    }
    return { timestamp: new Date(period.endDate).getTime(), period };
  }

  let timestamp;
  if (endDate === "current") {
    timestamp = Date.now();
  } else if (isNaN(endDate)) {
    timestamp = new Date(endDate).getTime();
    if (isNaN(timestamp)) {
      throw badRequest(
        "Formato de fecha inválido. Debe ser 'current', 'previous', un timestamp o una fecha válida (e.g., YYYY-MM-DD).",
      );
    }
  } else {
    timestamp = Number(endDate);
  }
  if (!timestamp || timestamp <= 0) timestamp = Date.now();

  const exact = periods.find((p) => new Date(p.endDate).getTime() === timestamp);
  const containing = periods.find(
    (p) => new Date(p.startDate).getTime() <= timestamp && timestamp <= new Date(p.endDate).getTime(),
  );
  return { timestamp, period: exact || containing || null };
}

/**
 * Informe de licenciamiento completo para una organización.
 *
 * @param {object} opts
 * @param {string} opts.token     token de Genesys de la organización
 * @param {string} opts.region    región de Genesys
 * @param {string} [opts.endDate] "previous" (por defecto), "current", timestamp o fecha
 * @param {string} [opts.timezone] zona horaria para contar los intentos outbound
 * @param {boolean} [opts.includeOutbound] false para no consultar Analytics
 */
async function buildLicensingReport({
  token,
  region,
  endDate = "previous",
  timezone = DEFAULT_TIMEZONE,
  includeOutbound = true,
}) {
  // Para "previous" los períodos son imprescindibles; para el resto sólo
  // afinan las fechas, así que un fallo no impide el informe.
  const periods =
    endDate === "previous"
      ? await fetchBillingPeriods(token, region)
      : await fetchBillingPeriods(token, region).catch(() => []);
  const { timestamp, period } = resolvePeriod(endDate, periods);
  const customer = await fetchBillingOverview(token, region, timestamp, period);

  let intentos = null;
  let outboundError = null;
  const inicio = customer.facturacion?.inicio;
  const fin = customer.facturacion?.final;
  if (includeOutbound && inicio && fin) {
    try {
      intentos = await fetchOutboundCampaignAttempts(
        token,
        region,
        String(inicio).slice(0, 10),
        String(fin).slice(0, 10),
        timezone,
      );
    } catch (error) {
      // Igual que en el generador: sin Analytics el informe sale sin outbound.
      console.warn(`⚠️ [report/licensing] Intentos outbound no disponibles: ${error.message}`);
      outboundError = error.message;
    }
  }

  const kpis = calcularKpis(customer, intentos);
  return {
    region,
    periodEndingTimestamp: timestamp,
    timezone,
    kpis,
    alertas: alertas(kpis),
    outboundError,
  };
}

module.exports = {
  BYOC,
  IVR,
  BYOC_NOMINAL,
  BYOC_CONCURRENTE,
  OUTBOUND_NOMINAL,
  OUTBOUND_CONCURRENTE,
  DEFAULT_TIMEZONE,
  licenciasNominales,
  calcularKpis,
  alertas,
  resumenFairUse,
  clientDataConFairUse,
  resolvePeriod,
  buildLicensingReport,
  // Expuestos para las pruebas de paridad con Python.
  pyFixed,
  pyRound,
  fmt,
};
