// Datos en tiempo real de Genesys Cloud para la vista "Tiempo real" del dashboard.
//
// Cada panel de la vista tiene aquí su función (troncales, certificados…).
// Para sumar un valor nuevo: añadir una función que reciba { token, region,
// cacheKey }, exponerla en un endpoint `/api/realtime/<panel>` en index.js y
// crear su componente en genesys-dashboard/components/realtime/.
//
// Permisos del cliente OAuth de la org: Telephony > Plugin > All
// (telephony:plugin:all) para trunks, trunkbasesettings, métricas y
// certificateauthorities.

const crypto = require("crypto");
const tls = require("tls");
const { getApiUrl } = require("../utils/genesysRegions");

const EDGES = "/api/v2/telephony/providers/edges";

// ── Caché en memoria por organización ────────────────────────────────────────
// Varios usuarios de la misma org consultando cada pocos segundos no deben
// multiplicar las llamadas a Genesys (límite ~300 req/min por cliente OAuth).
const cache = new Map();

async function cached(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.promise;
  const promise = loader();
  cache.set(key, { promise, expiresAt: Date.now() + ttlMs });
  // Un fallo no se queda en caché.
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

async function genesysGet(region, token, path, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${getApiUrl(region)}${path}`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error(`❌ [realtime] GET ${path} → ${response.status}: ${detail.slice(0, 300)}`);
      if (response.status === 403) {
        throw new GenesysError(
          403,
          "El cliente OAuth de la organización no tiene permiso de telefonía (Telephony > Plugin > All).",
        );
      }
      throw new GenesysError(response.status, `Error de la API de Genesys Cloud: ${response.status}`);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Recorre todas las páginas de un listado `{ entities, pageCount }`. */
async function genesysGetAll(region, token, path, maxPages = 20) {
  const sep = path.includes("?") ? "&" : "?";
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await genesysGet(region, token, `${path}${sep}pageSize=100&pageNumber=${page}`);
    all.push(...(data.entities || []));
    if (!data.pageCount || page >= data.pageCount) break;
  }
  return all;
}

// ── Propiedades de la troncal externa ────────────────────────────────────────
// Las propiedades llegan como { clave: { value: { instance, default } } }. Los
// nombres exactos varían entre tipos de troncal, así que se buscan por patrón.

function propValue(prop) {
  if (!prop || typeof prop !== "object") return undefined;
  const v = prop.value;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v.instance !== undefined ? v.instance : v.default;
  }
  return v;
}

function findProp(properties, pattern) {
  if (!properties) return undefined;
  const key = Object.keys(properties).find((k) => pattern.test(k));
  return key ? propValue(properties[key]) : undefined;
}

function readProtocol(properties) {
  const value = findProp(properties, /transport.*protocol|protocol.*transport/i);
  return typeof value === "string" ? value.toUpperCase() : null;
}

function readTerminationId(properties) {
  const value = findProp(properties, /termination.?identifier/i);
  return typeof value === "string" && value ? value : null;
}

/** Hosts SIP del carrier ("host" o "host:puerto") para las troncales TLS. */
function readProxyHosts(properties) {
  const value = findProp(properties, /server.?proxy.?list|proxy.?list|sip.?servers/i);
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\s]+/) : [];
  return list
    .map((entry) => (typeof entry === "string" ? entry : entry?.address || entry?.host || ""))
    .map((s) => String(s).trim())
    .filter(Boolean);
}

// ── Troncales ────────────────────────────────────────────────────────────────

async function loadTrunkConfig(region, token, cacheKey) {
  return cached(`${cacheKey}:trunk-config`, 60_000, async () => {
    const [bases, trunks] = await Promise.all([
      genesysGetAll(region, token, `${EDGES}/trunkbasesettings?trunkType=EXTERNAL&expand=properties`),
      genesysGetAll(region, token, `${EDGES}/trunks?trunkType=EXTERNAL`),
    ]);
    return { bases, trunks };
  });
}

async function loadTrunkMetrics(region, token, cacheKey, trunkIds) {
  if (trunkIds.length === 0) return [];
  // La configuración puede cambiar mientras el proceso sigue vivo. Incluye los
  // IDs en la clave para no reutilizar métricas de una lista anterior.
  const metricsKey = `${cacheKey}:trunk-metrics:${[...trunkIds].sort().join(",")}`;
  return cached(metricsKey, 4_000, async () => {
    const chunks = [];
    for (let i = 0; i < trunkIds.length; i += 50) chunks.push(trunkIds.slice(i, i + 50));
    const results = await Promise.all(
      chunks.map((ids) =>
        genesysGet(region, token, `${EDGES}/trunks/metrics?trunkIds=${encodeURIComponent(ids.join(","))}`),
      ),
    );
    return results.flatMap((r) =>
      Array.isArray(r) ? r : Array.isArray(r?.entities) ? r.entities : r ? [r] : [],
    );
  });
}

/**
 * Troncales externas agrupadas por su configuración (External Trunk), con las
 * llamadas activas entrantes/salientes de cada una sumando sus instancias.
 */
async function getTrunksRealtime({ token, region, cacheKey }) {
  const { bases, trunks } = await loadTrunkConfig(region, token, cacheKey);
  const metrics = await loadTrunkMetrics(
    region,
    token,
    cacheKey,
    trunks.map((t) => t.id),
  );

  // Genesys publica las métricas de troncal sólo cuando cambian: su eventTime
  // es la última vez que reportó algo. Si el más reciente es viejo, las cifras
  // pueden estar congeladas (visto en orgs BYOC Cloud que se quedan en 0).
  let latestMetricMs = null;
  const metricsByTrunk = new Map();
  metrics.forEach((m) => {
    const id = m.trunk?.id || m.trunkId || m.id;
    if (id) metricsByTrunk.set(id, m);
    const t = Date.parse(m.eventTime);
    if (!Number.isNaN(t) && (latestMetricMs === null || t > latestMetricMs)) latestMetricMs = t;
  });

  const groups = new Map();
  bases.forEach((base) => {
    groups.set(base.id, {
      id: base.id,
      name: base.name,
      type: base.trunkMetabase?.name || null,
      state: base.state || null,
      inService: base.inService !== false,
      protocol: readProtocol(base.properties),
      terminationId: readTerminationId(base.properties),
      instances: [],
      inbound: 0,
      outbound: 0,
    });
  });

  trunks.forEach((trunk) => {
    const baseId = trunk.trunkBase?.id || trunk.id;
    if (!groups.has(baseId)) {
      groups.set(baseId, {
        id: baseId,
        name: trunk.trunkBase?.name || trunk.name,
        type: trunk.trunkMetabase?.name || null,
        state: null,
        inService: trunk.inService !== false,
        protocol: null,
        terminationId: null,
        instances: [],
        inbound: 0,
        outbound: 0,
      });
    }
    const group = groups.get(baseId);
    const m = metricsByTrunk.get(trunk.id);
    const inbound = Number(m?.calls?.inboundCallCount || 0);
    const outbound = Number(m?.calls?.outboundCallCount || 0);
    group.inbound += inbound;
    group.outbound += outbound;
    group.instances.push({
      id: trunk.id,
      name: trunk.name,
      location: trunk.edge?.name || trunk.edgeGroup?.name || null,
      inService: trunk.inService !== false,
      enabled: trunk.enabled !== false,
      connected: trunk.connectedStatus ? Boolean(trunk.connectedStatus.connected) : null,
      connectedSince: trunk.connectedStatus?.connectedStateTime || null,
      inbound,
      outbound,
      qosMismatch: Number(m?.qos?.mismatchCount || 0),
    });
  });

  const list = [...groups.values()].map((g) => {
    const connectedInstances = g.instances.filter((i) => i.connected === true).length;
    const knownInstances = g.instances.filter((i) => i.connected !== null).length;
    let status;
    if (!g.inService || g.instances.every((i) => !i.inService)) status = "out_of_service";
    else if (knownInstances === 0) status = g.instances.length ? "unknown" : "no_instances";
    else if (connectedInstances === knownInstances) status = "operational";
    else if (connectedInstances === 0) status = "disconnected";
    else status = "degraded";
    return { ...g, status, total: g.inbound + g.outbound };
  });

  list.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  const totals = list.reduce(
    (acc, t) => {
      acc.inbound += t.inbound;
      acc.outbound += t.outbound;
      acc.trunks += 1;
      if (t.status === "operational") acc.operational += 1;
      return acc;
    },
    { inbound: 0, outbound: 0, trunks: 0, operational: 0 },
  );
  totals.total = totals.inbound + totals.outbound;

  return {
    trunks: list,
    totals,
    eventTime: new Date().toISOString(),
    metricsEventTime: latestMetricMs === null ? null : new Date(latestMetricMs).toISOString(),
  };
}

// ── Certificados ─────────────────────────────────────────────────────────────

function daysUntil(dateStr) {
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return null;
  return Math.floor((t - Date.now()) / 86_400_000);
}

function certStatus(days) {
  if (days === null) return "unknown";
  if (days < 0) return "expired";
  if (days <= 30) return "expiring";
  return "valid";
}

function firstLine(dn) {
  if (!dn) return null;
  const cn = /CN=([^,\n]+)/.exec(dn);
  return cn ? cn[1].trim() : dn.split("\n")[0];
}

/** Lee los datos de un PEM con el X509 nativo de Node; null si no se puede. */
function parsePem(pem) {
  try {
    const x = new crypto.X509Certificate(pem);
    return {
      subject: firstLine(x.subject),
      issuer: firstLine(x.issuer),
      validFrom: new Date(x.validFrom).toISOString(),
      validTo: new Date(x.validTo).toISOString(),
      fingerprint: x.fingerprint256,
    };
  } catch {
    return null;
  }
}

/** Autoridades de certificación cargadas en Telephony > Certificates. */
async function loadCertificateAuthorities(region, token) {
  const data = await genesysGet(region, token, `${EDGES}/certificateauthorities`);
  const entities = data.entities || [];
  return entities.map((ca) => {
    const parsed = ca.certificate ? parsePem(ca.certificate) : null;
    const detail = (ca.certificateDetails || [])[0] || {};
    const validTo = parsed?.validTo || detail.expirationDate || null;
    const days = validTo ? daysUntil(validTo) : null;
    return {
      id: ca.id,
      name: ca.name,
      services: ca.services || [],
      type: ca.type || null,
      subject: parsed?.subject || firstLine(detail.subject) || null,
      issuer: parsed?.issuer || firstLine(detail.issuerName) || null,
      validFrom: parsed?.validFrom || detail.issueDate || null,
      validTo,
      daysLeft: days,
      status: certStatus(days),
      fingerprint: parsed?.fingerprint || null,
    };
  });
}

/**
 * Certificado que presenta el carrier en su endpoint SIP/TLS. Sin validar la
 * cadena (sólo queremos leer el certificado, aunque esté caducado o sea
 * autofirmado). Mejor esfuerzo: si el host no responde se informa el error.
 */
function probeTlsCertificate(host, port, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {}
      resolve(result);
    };
    const socket = tls.connect({
      host,
      port,
      servername: /^[\d.]+$/.test(host) ? undefined : host,
      rejectUnauthorized: false,
      timeout: timeoutMs,
    });
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      if (!cert || !cert.valid_to) return finish({ error: "El servidor no presentó certificado." });
      const validTo = new Date(cert.valid_to).toISOString();
      const days = daysUntil(validTo);
      finish({
        subject: cert.subject?.CN || null,
        issuer: cert.issuer?.CN || cert.issuer?.O || null,
        validFrom: new Date(cert.valid_from).toISOString(),
        validTo,
        daysLeft: days,
        status: certStatus(days),
        fingerprint: cert.fingerprint256 || null,
      });
    });
    socket.once("timeout", () => finish({ error: "Tiempo de espera agotado." }));
    socket.once("error", (err) => finish({ error: err.code || err.message }));
  });
}

function splitHostPort(entry) {
  // "[ipv6]:port", "host:port" o "host"
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
  if (v6) return { host: v6[1], port: Number(v6[2] || 5061) };
  const parts = entry.split(":");
  if (parts.length === 2 && /^\d+$/.test(parts[1])) return { host: parts[0], port: Number(parts[1]) };
  return { host: entry, port: 5061 };
}

async function getCertificatesRealtime({ token, region, cacheKey }) {
  return cached(`${cacheKey}:certificates`, 10 * 60_000, async () => {
    const [authorities, { bases }] = await Promise.all([
      loadCertificateAuthorities(region, token),
      loadTrunkConfig(region, token, cacheKey),
    ]);

    const tlsTrunks = bases.filter((b) => readProtocol(b.properties) === "TLS");
    const endpoints = [];
    for (const base of tlsTrunks) {
      const hosts = readProxyHosts(base.properties).slice(0, 5);
      if (hosts.length === 0) {
        endpoints.push({ trunkId: base.id, trunkName: base.name, host: null, port: null, error: "NO_HOSTS" });
        continue;
      }
      for (const entry of hosts) {
        const { host, port } = splitHostPort(entry);
        endpoints.push({ trunkId: base.id, trunkName: base.name, host, port });
      }
    }

    const probed = await Promise.all(
      endpoints.slice(0, 20).map(async (ep) =>
        ep.host ? { ...ep, ...(await probeTlsCertificate(ep.host, ep.port)) } : ep,
      ),
    );

    const all = [...authorities, ...probed.filter((p) => p.daysLeft !== undefined)];
    const summary = {
      total: all.length,
      expired: all.filter((c) => c.status === "expired").length,
      expiring: all.filter((c) => c.status === "expiring").length,
      tlsTrunks: tlsTrunks.length,
    };

    return { authorities, trunkEndpoints: probed, summary, checkedAt: new Date().toISOString() };
  });
}

module.exports = {
  getTrunksRealtime,
  getCertificatesRealtime,
};
