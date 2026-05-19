const platformClient = require("purecloud-platform-client-v2");
const { db } = require("/Users/macbookpro/Documents/proyectos/LicenseManager/api-license-manager/firebase.js");

async function getGenesysToken(clientId, clientSecret, region) {
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
  const client = platformClient.ApiClient.instance;
  const url = REGION_MAP[region] || platformClient.PureCloudRegionHosts.us_east_1;
  client.setEnvironment(url);
  await client.loginClientCredentialsGrant(clientId, clientSecret);
  return client.authData.accessToken;
}

const getRegionUrl = (region) => {
  let url = "https://api.mypurecloud.com";
  switch (region) {
    case "us-east-1": url = "https://api.mypurecloud.com"; break;
    case "us-west-2": url = "https://api.usw2.pure.cloud"; break;
    case "us-east-2": url = "https://api.use2.pure.cloud"; break;
    case "ca-central-1": url = "https://api.cac1.pure.cloud"; break;
    case "sa-east-1": url = "https://api.sae1.pure.cloud"; break;
    case "eu-west-1": url = "https://api.euw1.pure.cloud"; break;
    case "eu-central-1": url = "https://api.euc1.pure.cloud"; break;
    case "eu-west-2": url = "https://api.euw2.pure.cloud"; break;
    case "eu-central-2": url = "https://api.euc2.pure.cloud"; break;
    case "ap-south-1": url = "https://api.aps1.pure.cloud"; break;
    case "ap-northeast-1": url = "https://api.apne1.pure.cloud"; break;
    case "ap-northeast-2": url = "https://api.apne2.pure.cloud"; break;
    case "ap-northeast-3": url = "https://api.apne3.pure.cloud"; break;
    case "ap-southeast-2": url = "https://api.apse2.pure.cloud"; break;
    case "me-central-1": url = "https://api.mec1.pure.cloud"; break;
  }
  return url;
};

async function testGenesysAPI() {
  try {
    const orgsSnapshot = await db.collection("organizations").where("orgname", "==", "lcpr").get();
    if (orgsSnapshot.empty) {
      console.log("No lcpr organization found in DB.");
      process.exit(1);
    }
    const orgDoc = orgsSnapshot.docs[0].data();
    console.log("Found Org:", orgDoc.orgname, orgDoc.region);

    const token = await getGenesysToken(orgDoc.clientId, orgDoc.clientSecret, orgDoc.region);
    console.log("Got Token!");

    const url = getRegionUrl(orgDoc.region);
    
    // Interval for a typical month
    const interval = "2026-04-20T00:00:00.000Z/2026-05-19T23:59:59.000Z";

    // Test flows
    const botFlowsPayload = {
      interval: interval,
      groupBy: ["flowType", "mediaType"],
      metrics: ["nFlow", "tFlow"]
    };
    
    console.log("Testing flows payload...");
    const resFlows = await fetch(`${url}/api/v2/analytics/flows/aggregates/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(botFlowsPayload)
    });
    console.log("Flows status:", resFlows.status);
    const dataFlows = await resFlows.json();
    if (dataFlows.results) {
       dataFlows.results.forEach(r => {
           console.log("Flow Group:", r.group, "Metrics:", r.data[0].metrics);
       });
    }

    // Test conversations
    const waPayload = {
      interval: interval,
      groupBy: ["divisionId"],
      metrics: ["nConnected"],
      filter: { type: "and", predicates: [{ type: "dimension", dimension: "mediaType", operator: "matches", value: "message" }, { type: "dimension", dimension: "messageType", operator: "matches", value: "whatsapp" }] }
    };
    console.log("\nTesting whatsapp payload...");
    const resWa = await fetch(`${url}/api/v2/analytics/conversations/aggregates/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(waPayload)
    });
    console.log("Wa status:", resWa.status);
    const dataWa = await resWa.json();
    if (dataWa.results) {
       dataWa.results.forEach(r => {
           console.log("WA Group:", r.group, "Metrics:", r.data[0].metrics);
       });
    }

  } catch (error) {
    console.error("Error:", error);
  } finally {
    process.exit(0);
  }
}

testGenesysAPI();
