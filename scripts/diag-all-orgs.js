// Recorre todas las organizaciones y prueba getTrunksRealtime en cada una.
// Reporta: OK con totales, o el error devuelto.
const path = require("path");
const base = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(base, ".env") });
const { db } = require(path.join(base, "firebase.js"));
const { getTrunksRealtime } = require(path.join(base, "services", "genesysRealtime.js"));
const { fetchOrgToken } = require(path.join(base, "utils", "genesysRegions.js"));

(async () => {
  const snap = await db.collection("organizations").get();
  const docs = snap.docs;
  console.log(`Orgs: ${docs.length}\n`);

  for (const doc of docs) {
    const org = doc.data();
    const label = `${org.orgname} (${org.region || "us-east-1"})`;
    if (!org.clientId || !org.clientSecret) {
      console.log(`SKIP  ${label} — sin credenciales`);
      continue;
    }
    try {
      const { accessToken } = await fetchOrgToken(org.clientId, org.clientSecret, org.region || "us-east-1");
      const r = await getTrunksRealtime({
        token: accessToken,
        region: org.region || "us-east-1",
        cacheKey: `diag:${doc.id}`,
      });
      const zero = r.totals.inbound === 0 && r.totals.outbound === 0;
      console.log(
        `${zero ? "CERO " : "OK   "} ${label} — troncales=${r.totals.trunks} in=${r.totals.inbound} out=${r.totals.outbound} op=${r.totals.operational}`,
      );
    } catch (e) {
      console.log(`FAIL ${label} — status=${e.status || "?"} ${e.message}`);
    }
  }
  process.exit(0);
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
