// Emite un JWT de sesión de prueba y llama a /api/realtime/trunks por HTTP.
// Uso: node scripts/test-realtime-http.js [orgname] [username]
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const jwt = require("jsonwebtoken");
const { db } = require(path.join(__dirname, "..", "firebase.js"));

(async () => {
  const orgname = process.argv[2] || "lcpr";
  const snap = await db
    .collection("organizations")
    .where("orgname", "==", orgname)
    .limit(1)
    .get();
  if (snap.empty) {
    console.log(`Org "${orgname}" no encontrada.`);
    process.exit(1);
  }
  const doc = snap.docs[0];
  const org = doc.data();

  const token = jwt.sign(
    {
      sub: process.argv[3] || "diag-script",
      role: "administrator",
      orgname: org.orgname,
      orgId: org.orgId || doc.id,
    },
    process.env.JWT_SECRET,
    { expiresIn: "10m" },
  );

  const res = await fetch("http://localhost:4000/api/realtime/trunks", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  console.log("HTTP", res.status);
  console.log(JSON.stringify(body, null, 2).slice(0, 3000));
  process.exit(0);
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
