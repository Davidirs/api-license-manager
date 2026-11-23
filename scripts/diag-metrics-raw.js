// Respuesta CRUDA de /trunks/metrics para una org, para ver la forma real
// del JSON y si los contadores vienen en 0 o con datos que no se mapean.
// Uso: node scripts/diag-metrics-raw.js [orgname]
const path = require("path");
const base = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(base, ".env") });
const { db } = require(path.join(base, "firebase.js"));
const { fetchOrgToken, getApiUrl } = require(path.join(base, "utils", "genesysRegions.js"));

const EDGES = "/api/v2/telephony/providers/edges";

(async () => {
  const orgname = process.argv[2] || "gosmo";
  const snap = await db.collection("organizations").where("orgname", "==", orgname).limit(1).get();
  if (snap.empty) {
    console.log(`Org "${orgname}" no encontrada.`);
    process.exit(1);
  }
  const org = snap.docs[0].data();
  const region = org.region || "us-east-1";
  const { accessToken } = await fetchOrgToken(org.clientId, org.clientSecret, region);
  const url = getApiUrl(region);

  // 1) Troncales externas
  const trunksRes = await fetch(`${url}${EDGES}/trunks?trunkType=EXTERNAL&pageSize=100&pageNumber=1`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const trunks = await trunksRes.json();
  const ids = (trunks.entities || []).map((t) => t.id);
  console.log(`Org: ${org.orgname} | troncales EXTERNAL: ${ids.length}`);
  console.log(`Primera troncal: ${JSON.stringify((trunks.entities || [])[0]?.name)}\n`);

  if (ids.length === 0) return process.exit(0);

  // 2) Métricas crudas
  const mRes = await fetch(
    `${url}${EDGES}/trunks/metrics?trunkIds=${encodeURIComponent(ids.join(","))}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const raw = await mRes.json();
  console.log(`metrics HTTP ${mRes.status} | typeof=${Array.isArray(raw) ? "array" : typeof raw}`);
  console.log(`Claves: ${Array.isArray(raw) ? "(array)" : Object.keys(raw || {}).join(", ")}`);
  console.log(`Longitud: ${Array.isArray(raw) ? raw.length : "n/a"}`);
  console.log(`\nPrimer elemento:\n${JSON.stringify(Array.isArray(raw) ? raw[0] : raw, null, 2)}`);

  // 3) Comparar con el mapeo del código
  const map = new Map();
  (Array.isArray(raw) ? raw : Array.isArray(raw?.entities) ? raw.entities : raw ? [raw] : []).forEach((m) => {
    const id = m.trunk?.id || m.trunkId || m.id;
    if (id) map.set(id, m);
  });
  console.log(`\nMapeadas por id: ${map.size} de ${ids.length} troncales`);
  let withCalls = 0;
  for (const m of map.values()) {
    const i = Number(m.calls?.inboundCallCount || 0);
    const o = Number(m.calls?.outboundCallCount || 0);
    if (i || o) withCalls++;
  }
  console.log(`Troncales con llamadas > 0: ${withCalls}`);
  process.exit(0);
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
