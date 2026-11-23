// Para cada org: cuántas trunkbasesettings, cuántas trunks y cuántas métricas
// devuelve Genesys. Detecta el caso bases>0 pero trunks==0 (todo en 0).
const path = require("path");
const base = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(base, ".env") });
const { db } = require(path.join(base, "firebase.js"));
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
  console.log("org | bases | trunks | metrics | notas");
  for (const doc of snap.docs) {
    const org = doc.data();
    if (!org.clientId || !org.clientSecret) continue;
    const region = org.region || "us-east-1";
    try {
      const { accessToken } = await fetchOrgToken(org.clientId, org.clientSecret, region);
      const url = getApiUrl(region);
      const [bases, trunks] = await Promise.all([
        getAll(url, accessToken, `${EDGES}/trunkbasesettings?trunkType=EXTERNAL&expand=properties`),
        getAll(url, accessToken, `${EDGES}/trunks?trunkType=EXTERNAL`),
      ]);
      let metrics = 0;
      let notas = "";
      if (trunks.length > 0) {
        const ids = trunks.map((t) => t.id);
        const mr = await fetch(
          `${url}${EDGES}/trunks/metrics?trunkIds=${encodeURIComponent(ids.slice(0, 50).join(","))}`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (mr.ok) {
          const md = await mr.json();
          metrics = Array.isArray(md) ? md.length : (md.entities || []).length;
        } else notas = `metrics HTTP ${mr.status}`;
      }
      const flag =
        bases > 0 && trunks === 0
          ? " ⚠️ BASES_SIN_TRUNKS"
          : trunks > 0 && metrics === 0
            ? " ⚠️ SIN_METRICAS"
            : trunks > 0 && metrics < trunks
              ? " ⚠️ METRICAS_MENOS"
              : "";
      if (flag || process.argv[2] === "-v") {
        console.log(`${org.orgname} | ${bases} | ${trunks} | ${metrics} | ${notas}${flag}`);
      }
    } catch (e) {
      if (process.argv[2] === "-v") console.log(`${org.orgname} | ERR ${e.message.slice(0, 60)}`);
    }
  }
  console.log("\n(listado sólo con anomalías; usa -v para ver todo)");
  process.exit(0);
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
