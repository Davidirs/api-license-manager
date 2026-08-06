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

    // 4. Obtener organizaciones reales desde la BD
    const orgsSnapshot = await db.collection("organizations").get();
    const allOrgsDict = {};     // orgId   → orgData
    const allOrgsByName = {};   // orgname (lower) → orgData
    orgsSnapshot.forEach((doc) => {
      const data = doc.data();
      if (data.orgId) {
        const entry = { ...data, _docId: doc.id };
        allOrgsDict[data.orgId] = entry;
        if (data.orgname) {
          allOrgsByName[(data.orgname || "").toLowerCase()] = entry;
        }
      }
    });

    // 5. Agrupar usuarios válidos por organización (orgId)
    const orgsMap = {};
    const isDev = process.env.ENTORNO === "DEV";
    console.log("isDev", isDev);
    const allowedOrgs = ["wuzi", "lcpr"];
    console.log("allowedOrgs", allowedOrgs);

    for (const u of allUsers) {
      if (!u || !u.preferences || !u.preferences.emailNotifications) {
        continue;
      }

      // En DEV, filtrar por allowedOrgs (tanto para supervisors como clients)
      if (isDev) {
        const userOrgname = (u.orgname || "").toLowerCase();
        const subscribedToAllowed =
          u.preferences.subscribedOrgs &&
          u.preferences.subscribedOrgs.some((orgId) => {
            const orgInfo = allOrgsDict[orgId];
            return orgInfo && allowedOrgs.includes((orgInfo.orgname || "").toLowerCase());
          });
        const isOwnOrgAllowed = allowedOrgs.includes(userOrgname);

        if (!isOwnOrgAllowed && !subscribedToAllowed) {
          continue; // Saltar en DEV si no pertenece a ninguna org permitida
        }
      }

      // Determinar a qué orgs pertenece este usuario para notificaciones
      let targetOrgs = [];
      if (
        (u.role === "supervisor" || u.role === "administrator") &&
        u.preferences.subscribedOrgs &&
        u.preferences.subscribedOrgs.length > 0
      ) {
        // Supervisor/admin: notifica sobre todas las orgs que sigue (por orgId)
        targetOrgs = u.preferences.subscribedOrgs;
      } else if (u.role === "client" && u.orgname) {
        // Client: no tiene orgId, resolvemos a través de su orgname
        const orgByName = allOrgsByName[(u.orgname || "").toLowerCase()];
        if (orgByName) {
          targetOrgs = [orgByName.orgId];
        } else {
          console.warn(`[Cron] Client ${u.username} tiene orgname "${u.orgname}" pero no se encontró en organizations. Saltando.`);
        }
      } else if (u.orgId) {
        // Supervisor sin suscripciones u otros roles con orgId
        targetOrgs = [u.orgId];
      }

      for (const orgId of targetOrgs) {
        const orgInfo = allOrgsDict[orgId];
        const orgName = orgInfo ? orgInfo.orgname : u.orgname;

        if (isDev && !allowedOrgs.includes((orgName || "").toLowerCase())) {
          continue;
        }

        if (!orgsMap[orgId]) {
          orgsMap[orgId] = {
            orgId: orgId,
            orgname: orgName,
            thrustedName: orgInfo ? orgInfo.thrusted : u.thrusted,
            region: orgInfo ? orgInfo.region : u.region,
            users: [],
          };

          if (Array.isArray(orgsMap[orgId].thrustedName)) {
            orgsMap[orgId].thrustedName = orgsMap[orgId].thrustedName[0];
          }
        }

        // Evitamos duplicados
        if (
          !orgsMap[orgId].users.find(
            (existingU) => existingU.username === u.username,
          )
        ) {
          orgsMap[orgId].users.push(u);
        }
      }
    }

    console.log(
      `[Cron] Se evaluarán ${Object.keys(orgsMap).length} organizaciones con alertas habilitadas.`,
    );

    // 6. Iterar por organización (Pedimos Billing 1 sola vez por org)
    for (const orgId in orgsMap) {
      const orgData = orgsMap[orgId];
      const token = tokens[orgData.thrustedName];

      if (!token) {
        console.warn(
          `⏳ [Cron] Sin token para ${orgData.thrustedName}, saltando org ${orgData.orgname}`,
        );
        continue;
      }

      // --- Obtener billing de la org ---
      let clientData = null;
      try {
        const abortController = new AbortController();
        const fetchTimeout = setTimeout(() => abortController.abort(), 60000); // 60s timeout

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
            signal: abortController.signal,
          },
        );
        clearTimeout(fetchTimeout);

        const currentData = await currentBillingRes.json();
        if (!currentData || !currentData.customer) {
          console.error(
            `[Cron] ❌ No se obtuvo billing para la org "${orgData.orgname}" (${orgId}). Respuesta: ${JSON.stringify(currentData)}`,
          );
          continue;
        }
        clientData = currentData.customer;
      } catch (err) {
        if (err.name === "AbortError") {
          console.error(
            `[Cron] ⏱️ Timeout (60s) al obtener billing para org "${orgData.orgname}" (${orgId}). Saltando.`,
          );
        } else {
          console.error(
            `[Cron] ❌ Error obteniendo billing para org "${orgData.orgname}" (${orgId}):`,
            err.message,
          );
        }
        continue;
      }

      const isDayAfterBilling = clientData.facturacion
        ? esUnDiaDespues(clientData.facturacion.final)
        : false;

      // ── PASO A: Calcular criticalMetrics UNA SOLA VEZ para la org ──────────
      // Usamos el alertThreshold más bajo entre los usuarios (más conservador = más seguro)
      const minThreshold = orgData.users.reduce((min, u) => {
        const t = u.preferences?.alertThreshold || 90;
        return t < min ? t : min;
      }, 100);

      const calculatePercentage = (used, total) => {
        if (total === 0 && used === 0) return 0;
        return Math.round((used / total) * 100);
      };

      const newCriticalMetrics = [];

      if (clientData.licencias) {
        clientData.licencias.forEach((lic) => {
          const licUsed = Number(lic.usageQuantity || 0);
          const licTotal = Number(lic.prepayQuantity || 0);
          const licPercentage = calculatePercentage(licUsed, licTotal);
          if (licTotal === 0 && licUsed > 0) {
            newCriticalMetrics.push(`${lic.name}: ${licUsed}`);
          } else if (licPercentage >= minThreshold) {
            newCriticalMetrics.push(`${lic.name}: ${licPercentage}%`);
          }
        });
      }

      if (clientData.addons) {
        clientData.addons.forEach((addon) => {
          const addonUsed = Number(addon.usageQuantity || 0);
          const addonTotal = Number(addon.prepayQuantity || 0);
          const addonPercentage = calculatePercentage(addonUsed, addonTotal);
          if (addonTotal === 0 && addonUsed > 0) {
            newCriticalMetrics.push(`${addon.name}: ${addonUsed}`);
          } else if (addonPercentage >= minThreshold) {
            newCriticalMetrics.push(`${addon.name}: ${addonPercentage}%`);
          }
        });
      }

      if (clientData.storage) {
        const storageUsed = Number(clientData.storage.enUso || 0);
        const storageTotal = Number(clientData.storage.comprometido || 0);
        const storagePercentage = calculatePercentage(storageUsed, storageTotal);
        if (storagePercentage >= minThreshold) {
          newCriticalMetrics.push(`Storage: ${storagePercentage}%`);
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
        if (tokensPercentage >= minThreshold) {
          newCriticalMetrics.push(`IA Tokens: ${tokensPercentage}%`);
        }
      }

      // ── PASO B: Leer criticalMetrics anteriores desde organizations/{orgId} ─
      // Comparamos AQUÍ, antes de tocar Firestore, para que todos los usuarios
      // sean notificados con el mismo estado.
      const sortAndStringify = (arr) =>
        arr ? [...arr].sort().join("|") : "";

      const orgDocRef = db.collection("organizations").doc(orgId);
      const orgDoc = await orgDocRef.get();
      const prevCriticalMetrics = orgDoc.exists
        ? orgDoc.data().criticalMetrics || []
        : [];

      const prevStringified = sortAndStringify(prevCriticalMetrics);
      const newStringified = sortAndStringify(newCriticalMetrics);
      const alertChanged = prevStringified !== newStringified;

      console.log(
        `[Cron] Org ${orgData.orgname} | Métricas anteriores: "${prevStringified}" | Nuevas: "${newStringified}" | Cambió: ${alertChanged}`,
      );

      // ── PASO C: Notificar a TODOS los usuarios ANTES de escribir en Firestore ─
      // Garantizamos que todos reciban la alerta; solo al final se actualiza el estado.
      if (alertChanged && newCriticalMetrics.length > 0) {
        console.log(
          `[Cron] 🚨 Nueva excedencia en org ${orgData.orgname}. Notificando a ${orgData.users.length} usuarios...`,
        );
        const alertPayload = { ...clientData, criticalMetrics: newCriticalMetrics };

        for (const u of orgData.users) {
          const recipients = u.preferences?.recipients || [];
          if (recipients.length === 0) continue;
          try {
            await enqueueEmail("alert", alertPayload, recipients, true);
            console.log(
              `[Cron]   ✉️  Alerta enviada a ${u.username || u.id} (${u.orgname})`,
            );
          } catch (err) {
            console.error(
              `[Cron] Error enviando alerta a ${u.username || u.id}:`,
              err.message,
            );
          }
        }
      } else if (alertChanged && newCriticalMetrics.length === 0) {
        console.log(
          `[Cron] 🟢 Excedencia superada en org ${orgData.orgname}. Limpiando métricas.`,
        );
      } else {
        console.log(
          `[Cron] 💤 Sin cambios en métricas para org ${orgData.orgname}. No se re-envía alerta.`,
        );
      }

      // ── PASO D: Actualizar criticalMetrics en organizations/{orgId} ─────────
      // Solo se escribe DESPUÉS de haber notificado a todos los usuarios.
      if (alertChanged) {
        try {
          await orgDocRef.set({ criticalMetrics: newCriticalMetrics }, { merge: true });
          console.log(
            `[Cron] 💾 criticalMetrics actualizado en organizations/${orgId}`,
          );
        } catch (err) {
          console.error(
            `[Cron] Error actualizando criticalMetrics en org ${orgId}:`,
            err.message,
          );
        }
      }

      // ── PASO E: Notificaciones regulares por usuario (días/hora configurados) ─
      for (const u of orgData.users) {
        const username = u.username || u.id;
        try {
          const recipients = u.preferences?.recipients || [];
          if (recipients.length === 0) continue;

          const userTime = u.preferences.notificationTime || "08:00";
          const userDays = u.preferences.notificationDays || [];
          const userTimezone = u.preferences.timezone || "UTC";

          const nowUTC = new Date();
          const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: userTimezone,
            hour: "2-digit",
            minute: "2-digit",
            weekday: "short",
            hour12: false,
          });
          const parts = formatter.formatToParts(nowUTC);
          const tzHour = parts.find((p) => p.type === "hour")?.value || "00";
          const tzMinute = parts.find((p) => p.type === "minute")?.value || "00";
          const tzWeekday = parts.find((p) => p.type === "weekday")?.value || "";

          const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
          const currentDay = weekdayMap[tzWeekday] ?? nowUTC.getDay();
          const userHour = userTime.split(":")[0];
          const currentHour = tzHour;

          console.log(
            `[Cron] 🕐 Usuario ${username} | TZ: ${userTimezone} | Hora local: ${currentHour}:${tzMinute} | Hora configurada: ${userTime} | Día: ${currentDay}`,
          );

          if (userHour === currentHour) {
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
