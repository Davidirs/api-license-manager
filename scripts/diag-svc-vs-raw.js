// Compara getTrunksRealtime() contra un cálculo directo de las métricas crudas.
// Si el servicio da 0 pero las métricas crudas tienen llamadas → fallo de mapeo.
const path = require("path");
const base = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(base, ".env") });
const { db } = require(path.join(base, "firebase.js"));
const { getTrunksRealtime } = require(path.join(base, "services", "genesysRealtime.js"));
const { fetchOrgToken, getApiUrl } = require(path.join(base, "utils", "genesysRegions.js"));

const EDGES = "/api/v2/telephony/providers/edges";

async function getAll(url, token, p) {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const sep = p.includes("?") ? "&" : "?";
    const r = await fetch(`${url}${p}${sep}pageSize=100&pageNumber=${page}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    out.push(...(d.entities || []));
    if (!d.pageCount || page >= d.pageCount) break;
  }
  return out;
}

(async () => {
  const snap = await db.collection("organizations").get();
  let problems = 0;
  for (const doc of snap.docs) {
    const org = doc.data();
    if (!org.clientId || !org.clientSecret) continue;
    const region = org.region || "us-east-1";
    let url, token;
    try {
      ({ accessToken: token } = await fetchOrgToken(org.clientId, org.clientSecret, region));
      url = getApiUrl(region);
    } catch {
      continue;
    }

    // Servicio
    let svc;
    try {
      svc = await getTrunksRealtime({ token, region, cacheKey: `cmp:${doc.id}` });
    } catch (e) {
      continue; // 403 u otro: ya reportado antes
    }

    // Cálculo directo
    let rawIn = 0;
    let rawOut = 0;
    let mapped = 0;
    let unmatched = 0;
    try {
      const trunks = await getAll(url, token, `${EDGES}/trunks?trunkType=EXTERNAL`);
      const ids = trunks.map((t) => t.id);
      const idSet = new Set(ids);
      if (ids.length > 0) {
        const r = await fetch(
          `${url}${EDGES}/trunks/metrics?trunkIds=${encodeURIComponent(ids.slice(0, 50).join(","))}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (r.ok) {
          const md = await r.json();
          const list = Array.isArray(md) ? md : Array.isArray(md?.entities) ? md.entities : md ? [md] : [];
          for (const m of list) {
            const id = m.trunk?.id || m.trunkId || m.id;
            const i = Number(m.calls?.inboundCallCount || 0);
            const o = Number(m.calls?.outboundCallCount || 0);
            rawIn += i;
            rawOut += o;
            if (id && idSet.has(id)) mapped++;
            else unmatched++;
          }
        }
      }
    } catch (e) {
      console.log(`ERRRAW ${org.orgname}: ${e.message}`);
      continue;
    }

    const svcIn = svc.totals.inbound;
    const svcOut = svc.totals.outbound;
    const mismatch = svcIn !== rawIn || svcOut !== rawOut;

    if (mismatch || unmatched > 0 || (rawIn + rawOut > 0 && svcIn + svcOut === 0)) {
      problems++;
      console.log(
        `⚠️  ${org.orgname}: servicio in=${svcIn} out=${svcOut} | crudo in=${rawIn} out=${rawOut} | mapeadas=${mapped} sinMatch=${unmatched}`,
      );
    } else if (rawIn + rawOut === 0) {
      console.log(`ok(0) ${org.orgname}: Genesys reporta 0 llamadas concurrentes`);
    } else {
      console.log(`ok     ${org.orgname}: in=${svcIn} out=${svcOut}`);
    }
  }
  console.log(`\nProblemas de mapeo/desajuste: ${problems}`);
  process.exit(0);
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
