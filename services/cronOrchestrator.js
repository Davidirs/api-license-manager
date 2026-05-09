const cron = require("node-cron");
const platformClient = require("purecloud-platform-client-v2");
const { db } = require("../firebase");
const { enqueueEmail } = require("./emailQueue");

// Mapa de regiones al SDK de Genesys
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

/**
 * Obtiene un token de Genesys directamente vía SDK,
 * sin depender de una llamada HTTP interna (que falla en Docker).
 */
async function getGenesysToken(clientId, clientSecret, region) {
  const client = platformClient.ApiClient.instance;
  const url =
    REGION_MAP[region] || platformClient.PureCloudRegionHosts.us_east_1;
  client.setEnvironment(url);
  await client.loginClientCredentialsGrant(clientId, clientSecret);
  return client.authData.accessToken;
}

function esUnDiaDespues(fechaFacturacionISO) {
  if (!fechaFacturacionISO) return false;
  const fechaFactura = new Date(fechaFacturacionISO);
  const fechaSiguiente = new Date(fechaFactura);
  fechaSiguiente.setUTCDate(fechaFactura.getUTCDate() + 1);

  const hoy = new Date();
  const hoyUTC = new Date(
    Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate()),
  );
  const siguienteUTC = new Date(
    Date.UTC(
      fechaSiguiente.getUTCFullYear(),
      fechaSiguiente.getUTCMonth(),
      fechaSiguiente.getUTCDate(),
    ),
  );

  return hoyUTC.getTime() === siguienteUTC.getTime();
}

async function runDailyMonitor() {
  console.log("🕒 [Cron] Iniciando monitor diario de correos...");

  try {
    // 1. Obtener todos los usuarios de Firestore
    const usersSnapshot = await db.collection("users").get();
    if (usersSnapshot.empty) {
      console.log("No se encontraron usuarios.");
      return;
    }

    let allUsers = [];
    usersSnapshot.forEach((doc) => {
      allUsers.push({ id: doc.id, ...doc.data() });
    });

    console.log(`[Cron] Encontrados ${allUsers.length} usuarios para evaluar.`);

    // 2. Extraer 'thrusted' únicos para pedir tokens
    const requiredThrusted = new Set(
      allUsers.map((u) => u.thrusted).filter(Boolean),
    );

    // Obtener credenciales de Firestore
    const credsSnapshot = await db.collection("credentials").get();
    let credentials = [];
    credsSnapshot.forEach((doc) => {
      const cred = doc.data();
      if (requiredThrusted.has(cred.name)) {
        credentials.push(cred);
      }
    });
    console.log(`credentials: ${credentials}`);

    // 3. Obtener Tokens directamente vía SDK (sin HTTP interno)
    let tokens = {};
    const API_URL =
      process.env.API_INTERNAL_URL ||
      `http://localhost:${process.env.PORT || 4000}`;
    console.log("API_URL", API_URL);
    for (const cred of credentials) {
      try {
        const token = await getGenesysToken(
          cred.clientId,
          cred.clientSecret,
          cred.region,
        );
        tokens[cred.name] = token;
        console.log(`✅ [Cron] Token obtenido para thrusted: ${cred.name}`);
      } catch (e) {
        console.error(
          `❌ [Cron] Error al pedir token de ${cred.name}`,
          e.message,
        );
      }
    }

    // 4. Agrupar usuarios válidos por organización (orgId)
    const orgsMap = {};
    const isDev = (process.env.ENTORNO || "DEV") === "DEV";
    const allowedOrgs = ["wuzi", "lcpr"];

    for (const u of allUsers) {
      if (
        isDev &&
        (!u || !allowedOrgs.includes((u.orgname || "").toLowerCase()))
      ) {
        continue;
      }
      if (!u || !u.preferences || !u.preferences.emailNotifications) {
        continue;
      }

      const orgId = u.orgId;
      if (!orgId) continue;

      if (!orgsMap[orgId]) {
        orgsMap[orgId] = {
          orgId: orgId,
          orgname: u.orgname,
          thrustedName: u.thrusted,
          region: u.region,
          users: [],
        };
      }
      orgsMap[orgId].users.push(u);
    }

    console.log(
      `[Cron] Se evaluarán ${Object.keys(orgsMap).length} organizaciones con alertas habilitadas.`,
    );

    // 5. Iterar por organización (Pedimos Billing 1 sola vez por org)
    for (const orgId in orgsMap) {
      const orgData = orgsMap[orgId];
      const token = tokens[orgData.thrustedName];

      if (!token) {
        console.warn(
          `⏳ [Cron] Sin token para ${orgData.thrustedName}, saltando org ${orgData.orgname}`,
        );
        continue;
      }

      let clientData = null;
      try {
        const currentBillingRes = await fetch(
          `${API_URL}/api/trusteebillingoverview`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              trustorOrgId: orgId,
              accessToken: token,
              region: orgData.region,
              billingPeriodIndex: 0,
            }),
          },
        );

        const currentData = await currentBillingRes.json();
        if (!currentData || !currentData.customer) {
          console.error(
            `[Cron] No se obtuvo billing para la org ${orgData.orgname} (${orgId})`,
          );
          continue;
        }
        clientData = currentData.customer;
      } catch (err) {
        console.error(
          `[Cron] Error obteniendo billing org ${orgData.orgname}:`,
          err.message,
        );
        continue;
      }
      // Nota: API_URL se usa solo para /api/trusteebillingoverview (el token ya no necesita HTTP)

      // Validamos si acaba de cambiar el periodo

      const isDayAfterBilling = clientData.facturacion
        ? esUnDiaDespues(clientData.facturacion.final)
        : false;

      // 6. Iterar sobre cada usuario de esta organización
      for (const u of orgData.users) {
        const username = u.username || u.id;
        try {
          const recipients = u.preferences.recipients || [];
          if (recipients.length === 0) continue;

          // --- LÓGICA DE ALERTAS INDIVIDUALES ---
          const alertThreshold = u.preferences.alertThreshold || 90;
          const criticalMetrics = [];

          const calculatePercentage = (used, total) => {
            if (total === 0 && used === 0) return 0;
            return Math.round((used / total) * 100);
          };

          if (clientData.licencias) {
            clientData.licencias.forEach((lic) => {
              const licUsed = Number(lic.usageQuantity || 0);
              const licTotal = Number(lic.prepayQuantity || 0);
              const licPercentage = calculatePercentage(licUsed, licTotal);
              if (licTotal === 0 && licUsed > 0) {
                criticalMetrics.push(`${lic.name}: ${licUsed}`);
              } else if (licPercentage >= alertThreshold) {
                criticalMetrics.push(`${lic.name}: ${licPercentage}%`);
              }
            });
          }

          if (clientData.addons) {
            clientData.addons.forEach((addon) => {
              const addonUsed = Number(addon.usageQuantity || 0);
              const addonTotal = Number(addon.prepayQuantity || 0);
              const addonPercentage = calculatePercentage(
                addonUsed,
                addonTotal,
              );
              if (addonTotal === 0 && addonUsed > 0) {
                criticalMetrics.push(`${addon.name}: ${addonUsed}`);
              } else if (addonPercentage >= alertThreshold) {
                criticalMetrics.push(`${addon.name}: ${addonPercentage}%`);
              }
            });
          }

          if (clientData.storage) {
            const storageUsed = Number(clientData.storage.enUso || 0);
            const storageTotal = Number(clientData.storage.comprometido || 0);
            const storagePercentage = calculatePercentage(
              storageUsed,
              storageTotal,
            );
            if (storagePercentage >= alertThreshold) {
              criticalMetrics.push(`Storage: ${storagePercentage}%`);
            }
          }

          if (clientData.iaTokens) {
            const tokensUsed = Number(clientData.iaTokens.usageQuantity || 0);
            const tokensTotal = Number(clientData.iaTokens.prepayQuantity || 0);
            const tokensIncluido = Number(clientData.iaTokens.incluido || 0);
            let tokensPercentage = 0;
            if (tokensIncluido > 0) {
              tokensPercentage = Math.round(
                (tokensUsed / (tokensTotal + tokensIncluido)) * 100,
              );
            } else {
              tokensPercentage = calculatePercentage(tokensUsed, tokensTotal);
            }
            if (tokensPercentage >= alertThreshold) {
              criticalMetrics.push(`IA Tokens: ${tokensPercentage}%`);
            }
          }

          if (criticalMetrics.length > 0) {
            const sortAndStringify = (arr) =>
              arr ? [...arr].sort().join("|") : "";

            const currentCriticalMetrics = u.criticalMetrics || [];
            const currentStringified = sortAndStringify(currentCriticalMetrics);
            const newStringified = sortAndStringify(criticalMetrics);

            const shouldUpdate = currentStringified !== newStringified;

            if (shouldUpdate) {
              console.log(
                `[Cron] 🚨 Alerta nueva para el usuario ${u.username} (${u.orgname}). Actualizando Firebase y enviando email...`,
              );
              await db
                .collection("users")
                .doc(u.id)
                .update({ criticalMetrics });

              // Clonamos clientData para no sobreescribir criticalMetrics para otros usuarios de la misma org
              const userDataPayload = { ...clientData, criticalMetrics };
              await enqueueEmail("alert", userDataPayload, recipients, true);
            } else {
              console.log(
                `[Cron] 💤 Alerta repetida para el usuario ${u.username} (${u.orgname}). No se re-enviará.`,
              );
            }
          } else {
            if (u.criticalMetrics && u.criticalMetrics.length > 0) {
              await db
                .collection("users")
                .doc(u.id)
                .update({ criticalMetrics: [] });
              console.log(
                `[Cron] 🟢 Alerta superada para el usuario ${u.username} (${u.orgname}). Limpiando Firebase.`,
              );
            }
          }

          // --- LÓGICA DE FRECUENCIA REGULAR (Días y Hora) ---
          const now = new Date();
          const currentHour =
            now.getHours().toString().padStart(2, "0") + ":00";
          const currentDay = now.getDay();

          const userTime = u.preferences.notificationTime || "08:00";
          const userDays = u.preferences.notificationDays || [];

          if (userTime === currentHour) {
            if (isDayAfterBilling) {
              console.log(
                `[Cron] 📅 Enviando reporte ANTERIOR (previous) a ${username} (Inicia nuevo periodo)`,
              );
              await enqueueEmail("previous", clientData, recipients, true);
            } else if (userDays.includes(currentDay)) {
              console.log(
                `[Cron] 📅 Enviando reporte ACTUAL programado a ${username}`,
              );
              await enqueueEmail("current", clientData, recipients, true);
            }
          }
        } catch (err) {
          console.error(
            `[Cron] Error al procesar usuario ${username}:`,
            err.message,
          );
        }
      }
    }

    console.log("🏁 [Cron] Monitoreo diario finalizado.");
  } catch (error) {
    console.error("❌ [Cron] Error general en el monitor:", error);
  }
}

// Configurar Cron para que corra cada hora (en el minuto 0 de cada hora)
function initCron() {
  cron.schedule("0 * * * *", () => {
    runDailyMonitor();
  });
  console.log("🕰️ [Cron] Orquestador inicializado. Programado para cada hora.");
}

module.exports = { initCron, runDailyMonitor };
