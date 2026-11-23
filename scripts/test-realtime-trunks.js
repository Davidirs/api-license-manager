// Diagnóstico: ¿qué devuelve getTrunksRealtime para una org concreta?
// Uso: node scripts/test-realtime-trunks.js [orgname]
const path = require("path");
const { db } = require(path.join(__dirname, "..", "firebase.js"));
const { getTrunksRealtime } = require(path.join(__dirname, "..", "services", "genesysRealtime.js"));

const platformClient = require("purecloud-platform-client-v2");

const REGION_MAP = {
  "us-east-1": platformClient.PureCloudRegionHosts.us_east_1,
  "us-west-2": platformClient.PureCloudRegionHosts.us_west_2,
  "us-east-2": platformClient.PureCloudRegionHosts.us_east_2,
  "ca-central-1": platformClient.PureCloudRegionHosts.ca_central_1,
  "sa-east-1": platformClient.PureCloudRegionHosts.sa_east_1,
  "eu-west-1": platformClient.PureCloudRegionHosts.eu_west_1,
  "eu-central-1": platformClient.PureCloudRegionHosts.eu_central_1,
  "eu-west-2": platformClient.PureCloudRegionHosts.eu_west_2,
  "eu-central-2": platformClient.PureCloudRegionHosts.eu_central_2,
  "ap-south-1": platformClient.PureCloudRegionHosts.ap_south_1,
  "ap-northeast-1": platformClient.PureCloudRegionHosts.ap_northeast_1,
  "ap-northeast-2": platformClient.PureCloudRegionHosts.ap_northeast_2,
  "ap-northeast-3": platformClient.PureCloudRegionHosts.ap_northeast_3,
  "ap-southeast-2": platformClient.PureCloudRegionHosts.ap_southeast_2,
  "me-central-1": platformClient.PureCloudRegionHosts.me_central_1,
};

async function getToken(clientId, clientSecret, region) {
  const client = platformClient.ApiClient.instance;
  client.setEnvironment(REGION_MAP[region] || platformClient.PureCloudRegionHosts.us_east_1);
  await client.loginClientCredentialsGrant(clientId, clientSecret);
  return client.authData.accessToken;
}

(async () => {
  const orgname = process.argv[2] || "lcpr";
  const snap = await db
    .collection("organizations")
    .where("orgname", "==", orgname)
    .limit(1)
    .get();
  if (snap.empty) {
    console.log(`Org "${orgname}" no encontrada en Firestore.`);
    process.exit(1);
  }
  const doc = snap.docs[0];
  const org = doc.data();
  console.log(`Org: ${org.orgname} | region: ${org.region} | clientId: ${(org.clientId || "").slice(0, 8)}…`);

  const token = await getToken(org.clientId, org.clientSecret, org.region || "us-east-1");
  console.log("Token OK\n");

  const result = await getTrunksRealtime({
    token,
    region: org.region || "us-east-1",
    cacheKey: `test:${doc.id}`,
  });

  console.log("TOTALS:", JSON.stringify(result.totals));
  console.log(`Troncales: ${result.trunks.length}\n`);
  result.trunks.slice(0, 15).forEach((t) => {
    console.log(
      ` - ${t.name} [${t.status}] proto=${t.protocol || "?"} in=${t.inbound} out=${t.outbound} instancias=${t.instances.length}` +
        (t.instances.length
          ? ` | primera: connected=${t.instances[0].connected} inService=${t.instances[0].inService}`
          : ""),
    );
  });
  process.exit(0);
})().catch((e) => {
  console.error("ERROR:", e.message);
  if (e.status) console.error("status:", e.status);
  process.exit(1);
});
