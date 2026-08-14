require("dotenv").config();
const express = require("express");
const cors = require("cors");
const platformClient = require("purecloud-platform-client-v2");

const app = express();
const port = process.env.PORT || 4000;

const {
  signSession,
  sanitizeUser,
  sanitizeOrg,
  authMiddleware,
  requireAdmin,
  requireRole,
  isAuthConfigured,
} = require("./utils/auth");

// Orígenes permitidos. `origin: true` reflejaba cualquier origen con
// credentials: true, lo que permitía a cualquier web llamar a la API desde el
// navegador de un usuario autenticado.
const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Sin origin: curl, apps móviles, llamadas servidor-a-servidor.
      if (!origin) return callback(null, true);
      if (allowedOrigins.length === 0) {
        // Sin lista configurada se mantiene el comportamiento permisivo previo,
        // pero avisando: en producción CORS_ORIGINS debe estar definido.
        console.warn(
          `⚠️ [CORS] CORS_ORIGINS no configurado; se permite el origen "${origin}". Configúrelo en producción.`,
        );
        return callback(null, true);
      }
      if (allowedOrigins.includes(origin)) return callback(null, true);
      console.warn(`⛔ [CORS] Origen bloqueado: ${origin}`);
      const error = new Error("Origen no permitido por CORS");
      error.code = "CORS_NOT_ALLOWED";
      return callback(error);
    },
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "x-admin-token", "x-genesys-token"],
  }),
);

/**
 * Respuesta limpia para los orígenes bloqueados.
 *
 * Sin esto, el error del middleware de CORS llega al manejador por defecto de
 * Express, que devuelve una página HTML con la traza completa y las rutas
 * absolutas del servidor. Va aquí, inmediatamente después de `cors`, para no
 * interferir con el resto de errores de la aplicación.
 */
app.use((err, req, res, next) => {
  if (err && err.code === "CORS_NOT_ALLOWED") {
    return res.status(403).json({
      success: false,
      code: "CORS_NOT_ALLOWED",
      message: "Origen no permitido.",
    });
  }
  return next(err);
});

app.use(express.json());

// Health check público, útil para el balanceador y para diagnosticar la config.
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    entorno: process.env.ENTORNO || "DEV",
    authConfigurada: isAuthConfigured(),
    smtpConfigurado: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER),
  });
});

// A partir de aquí toda la API exige sesión. Las excepciones están en
// PUBLIC_PATHS dentro de utils/auth.js.
app.use(authMiddleware);

const bcrypt = require("bcryptjs");

// Importar configuración de Firebase
const { db } = require("./firebase");

// Importar plantillas de correo
const {
  generateTemplate,
  generateNotificationEmailTemplate,
} = require("./utils/emailTemplates");

const { formatTrusteeBilling } = require("./utils/formatTrusteeBilling");
const {
  getEmailSettings,
  saveEmailSettings,
} = require("./utils/appSettings");
// Envío de correo por SMTP (IONOS). Sustituye a Resend.
const { sendMail, verifyTransport, smtpConfig } = require("./utils/mailer");
const { fetchOrgToken } = require("./utils/genesysRegions");
// Registro de conexión y acceso (colección Firestore `accessLogs`).
const {
  EVENT,
  logEvent,
  queryLogs,
  purgeOldLogs,
  RETENTION_DAYS: LOG_RETENTION_DAYS,
} = require("./utils/auditLog");
// Bloqueo de notificaciones por entorno (ENTORNO=STAGING).
const { notificationsBlocked, blockedReason, currentEnv } = require("./utils/environment");
// Idioma de las plantillas de correo y del análisis de la IA.
const { normalizeLanguage, SUPPORTED_LANGUAGES } = require("./utils/emailI18n");
const { promptsFor, languageRule, numbered } = require("./utils/aiPrompts");
const { languageForRecipients, forgetRecipient } = require("./utils/userLanguage");

/**
 * Guard para endpoints administrativos que pueden disparar envíos masivos.
 * Requiere `x-admin-token` igual a MONITOR_ADMIN_TOKEN. Si la variable no está
 * configurada, el endpoint queda deshabilitado (falla cerrado, no abierto).
 */
function requireAdminToken(req, res) {
  const expected = process.env.MONITOR_ADMIN_TOKEN;

  if (!expected) {
    res.status(503).json({
      success: false,
      message:
        "Endpoint deshabilitado: configure MONITOR_ADMIN_TOKEN en el entorno para habilitarlo.",
    });
    return false;
  }

  const provided =
    req.headers["x-admin-token"] ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "");

  if (provided !== expected) {
    res.status(401).json({ success: false, message: "Token administrativo inválido." });
    return false;
  }

  return true;
}

/**
 * Devuelve las preferencias con `language` saneado a uno de los idiomas
 * soportados (es | en | pt). Un valor inesperado llegado del front no debe
 * quedar guardado: se caería a español en cada correo sin que nadie lo note.
 */
function withNormalizedLanguage(preferences) {
  const prefs = preferences && typeof preferences === "object" ? { ...preferences } : {};
  prefs.language = normalizeLanguage(prefs.language);
  return prefs;
}

// Helper para obtener token internamente.
//
// Antes hacía un fetch HTTP a su propio localhost:/api/token, lo que además de
// dar una vuelta innecesaria fallaba dentro de Docker y ahora chocaría con el
// middleware de sesión. Va directo contra el OAuth de Genesys.
async function getTokenForRegion(clientId, clientSecret, region) {
  // Nunca registrar clientSecret: los logs del despliegue quedan almacenados y
  // son visibles para cualquiera con acceso al panel.
  console.log(
    `🔑 Solicitando token para clientId=${String(clientId).slice(0, 8)}… región=${region}`,
  );
  const { accessToken } = await fetchOrgToken(clientId, clientSecret, region);
  return accessToken;
}

// Endpoint de Login
app.post("/api/login", async (req, res) => {
  try {
    const { orgname, username, password } = req.body;
    console.log("Login request:", { orgname, username });

    if (!orgname || !username || !password) {
      return res.status(400).json({
        success: false,
        message: "orgname, username y password requeridos.",
      });
    }

    // Buscar el usuario en la colección users
    const cleanUsername = username.trim();
    const userDoc = await db.collection("users").doc(cleanUsername).get();

    if (!userDoc.exists) {
      logEvent({
        type: EVENT.LOGIN_USER_NOT_FOUND,
        req,
        username: cleanUsername,
        orgname,
        success: false,
        message: "Usuario no encontrado.",
      });
      return res
        .status(401)
        .json({ success: false, message: "Usuario no encontrado." });
    }

    const userFound = userDoc.data();
    console.log(
      `👤 Usuario encontrado: username="${cleanUsername}" | role="${userFound.role}" | orgname="${userFound.orgname}" | thrusted="${userFound.thrusted}"`,
    );

    // Validar si el usuario está desactivado (active === false).
    // Los usuarios legados sin el campo 'active' se consideran activos.
    if (userFound.active === false) {
      console.warn(`🚫 [Usuario desactivado] username="${cleanUsername}"`);
      logEvent({
        type: EVENT.LOGIN_USER_DISABLED,
        req,
        username: cleanUsername,
        orgname,
        role: userFound.role,
        success: false,
        message: "El usuario está desactivado.",
      });
      return res.status(403).json({
        success: false,
        code: "USER_DISABLED",
        message:
          "Tu usuario está desactivado. Por favor, comunícate con el proveedor.",
      });
    }

    // Si no es admin, validar permisos
    let effectiveThrusted = userFound.thrusted; // Por defecto el del usuario (puede ser array en supervisor)

    if (userFound.role !== "administrator") {
      let hasAccess = false;

      // Si es supervisor, puede entrar a cualquier organización que pertenezca a su 'thrusted' (puede ser string o array)
      if (userFound.role === "supervisor") {
        console.log(
          `🔍 [Supervisor] Buscando org "${orgname}" con thrusted="${userFound.thrusted}" en colección organizations...`,
        );
        let orgQuery = db
          .collection("organizations")
          .where("orgname", "==", orgname);

        // Normalizar thrusted: puede ser string simple, string con comas, o array real
        let thrustedList = [];
        if (Array.isArray(userFound.thrusted)) {
          thrustedList = userFound.thrusted;
        } else if (
          typeof userFound.thrusted === "string" &&
          userFound.thrusted.includes(",")
        ) {
          thrustedList = userFound.thrusted.split(",").map((s) => s.trim());
        } else {
          thrustedList = [userFound.thrusted];
        }

        if (thrustedList.length > 1) {
          // Firebase 'in' soporta hasta 10 elementos.
          orgQuery = orgQuery.where("thrusted", "in", thrustedList);
        } else {
          orgQuery = orgQuery.where("thrusted", "==", thrustedList[0]);
        }

        const orgSnapshot = await orgQuery.get();

        if (!orgSnapshot.empty) {
          hasAccess = true;
          effectiveThrusted = orgSnapshot.docs[0].data().thrusted; // Tomamos el thrusted real de la organización
          console.log(
            `✅ [Supervisor] Org encontrada: "${orgname}" pertenece al thrusted "${effectiveThrusted}"`,
          );
        } else {
          console.warn(
            `⚠️ [Supervisor] No se encontró la org "${orgname}" con thrusted="${userFound.thrusted}". Docs encontrados: ${orgSnapshot.size}`,
          );
        }
      }

      // Si es cliente o el supervisor intenta entrar a su propia organización asignada
      if (!hasAccess && userFound.orgname === orgname) {
        hasAccess = true;
        console.log(
          `✅ [Acceso directo] orgname del usuario ("${userFound.orgname}") coincide con la solicitada ("${orgname}")`,
        );
      }

      if (!hasAccess) {
        console.error(
          `❌ [Acceso denegado] username="${cleanUsername}" | role="${userFound.role}" | orgname_usuario="${userFound.orgname}" | orgname_solicitada="${orgname}" | thrusted="${userFound.thrusted}"`,
        );
        logEvent({
          type: EVENT.LOGIN_NO_ACCESS,
          req,
          username: cleanUsername,
          orgname,
          role: userFound.role,
          success: false,
          message: "El usuario no pertenece a la organización solicitada.",
          detail: { orgnameUsuario: userFound.orgname },
        });
        return res.status(401).json({
          success: false,
          message:
            "El usuario no pertenece a la organización especificada o no tiene permisos.",
        });
      }
    } else {
      console.log(
        `👑 [Admin] Acceso total concedido a username="${cleanUsername}"`,
      );
    }

    // Validar si la organización está desactivada.
    // Solo aplica a usuarios "client": los administradores y los supervisores
    // pueden iniciar sesión aunque la organización esté desactivada.
    // Las organizaciones legadas sin el campo 'active' se consideran activas.
    if (!["administrator", "supervisor"].includes(userFound.role)) {
      const orgActiveSnapshot = await db
        .collection("organizations")
        .where("orgname", "==", orgname)
        .get();
      if (
        !orgActiveSnapshot.empty &&
        orgActiveSnapshot.docs[0].data().active === false
      ) {
        console.warn(`🚫 [Organización desactivada] orgname="${orgname}"`);
        logEvent({
          type: EVENT.LOGIN_ORG_DISABLED,
          req,
          username: cleanUsername,
          orgname,
          orgId: orgActiveSnapshot.docs[0].id,
          role: userFound.role,
          success: false,
          message: "La organización está desactivada.",
        });
        return res.status(403).json({
          success: false,
          code: "ORG_DISABLED",
          message: `La organización "${orgname}" está desactivada. Por favor, comunícate con el proveedor.`,
        });
      }
    }

    // Verificar contraseña
    console.log(`🔐 Verificando contraseña para "${cleanUsername}"...`);
    const passwordMatch = await bcrypt.compare(
      password,
      userFound.passwordHash,
    );
    if (!passwordMatch) {
      console.error(`❌ [Contraseña incorrecta] username="${cleanUsername}"`);
      logEvent({
        type: EVENT.LOGIN_FAILED,
        req,
        username: cleanUsername,
        orgname,
        role: userFound.role,
        success: false,
        message: "Contraseña incorrecta.",
      });
      return res
        .status(401)
        .json({ success: false, message: "Contraseña incorrecta." });
    }

    console.log("✅ Login successful for:", { orgname, username });

    let tokens;

    // Obtener la colección credenciales
    const credsSnapshot = await db.collection("credentials").get();
    const regionEnvMap = credsSnapshot.docs.map((doc) => doc.data());

    if (userFound.role === "administrator") {
      console.log(
        "🔑 Obteniendo tokens para administrador de todas las regiones",
      );
      tokens = {};

      const tokenPromises = regionEnvMap.map(async (org) => {
        // `org` contiene clientSecret: sólo se registra su nombre.
        console.log(`  · credencial: ${org.name} (${org.region})`);
        const token = await getTokenForRegion(
          org.clientId,
          org.clientSecret,
          org.region,
        );
        return { thrusted: org.name, token };
      });

      const tokenResults = await Promise.all(tokenPromises);
      tokenResults.forEach(({ thrusted, token }) => {
        tokens[thrusted] = token;
      });
      console.log("✅ Todos los tokens obtenidos:", Object.keys(tokens));

    } else {
      console.log(
        `🔑 Obteniendo token para región (thrusted efectivo): ${effectiveThrusted}`,
      );

      // Normalizar effectiveThrusted: puede ser string simple, string con comas, o array
      let thrustedCandidates = [];
      if (Array.isArray(effectiveThrusted)) {
        thrustedCandidates = effectiveThrusted;
      } else if (
        typeof effectiveThrusted === "string" &&
        effectiveThrusted.includes(",")
      ) {
        // Ej: "ESMT-DEV,ESMT-DEV-W2" → ["ESMT-DEV", "ESMT-DEV-W2"]
        thrustedCandidates = effectiveThrusted.split(",").map((s) => s.trim());
      } else {
        thrustedCandidates = [effectiveThrusted];
      }

      console.log(
        `🔍 Buscando credenciales para candidatos: [${thrustedCandidates.join(", ")}]`,
      );

      let orgCred = null;
      for (const candidate of thrustedCandidates) {
        const found = regionEnvMap.find((cred) => cred.name === candidate);
        if (found) {
          orgCred = found;
          console.log(
            `✅ Credencial encontrada para candidato: "${candidate}"`,
          );
          break;
        }
      }

      if (!orgCred) {
        return res.status(500).json({
          success: false,
          message: `No se encontraron credenciales para la región ${effectiveThrusted}`,
        });
      }
      tokens = await getTokenForRegion(
        orgCred.clientId,
        orgCred.clientSecret,
        orgCred.region,
      );
      console.log("Token obtenido:", tokens);
    }

    // Construir el objeto de usuario a devolver al front.
    // sanitizeUser elimina passwordHash, clientId y clientSecret: antes se
    // devolvía el documento completo y el navegador acababa guardando el hash
    // de la contraseña y las credenciales OAuth de Genesys en sessionStorage.
    let userResponse = sanitizeUser(userFound);

    // Si es supervisor, sobrescribir orgname, orgId y region con los datos de
    // la organización a la que está iniciando sesión, ya que puede navegar en
    // cualquier org hija.
    console.log(
      `🔎 Buscando org en colección 'organizations' con orgname: '${orgname}'`,
    );
    const targetOrgSnapshot = await db
      .collection("organizations")
      .where("orgname", "==", orgname)
      .get();

    if (!targetOrgSnapshot.empty) {
      const targetOrgDoc = targetOrgSnapshot.docs[0];
      const targetOrgData = targetOrgDoc.data();
      // El token de Genesys sí viaja al front: es lo que usa el dashboard para
      // consultar la API de Genesys. Es de vida corta y alcance limitado, a
      // diferencia del clientSecret que lo genera.
      const orgToken = await getTokenForRegion(
        targetOrgData.clientId,
        targetOrgData.clientSecret,
        targetOrgData.region,
      );
      userResponse.orgname = orgname;
      userResponse.orgId = targetOrgData.orgId || targetOrgDoc.id;
      userResponse.region = targetOrgData.region || userFound.region;
      userResponse.orgToken = orgToken;

      console.log(
        `🏢 Org encontrada: ${orgname} | orgId: ${userResponse.orgId} | orgToken generado: ${!!orgToken}`,
      );
    } else {
      console.log(
        `❌ No se encontró la organización '${orgname}' en la colección 'organizations'. El token no se añadirá.`,
      );
    }

    // JWT de sesión: es lo que autentica al usuario contra nuestra propia API.
    const sessionToken = signSession({
      username: cleanUsername,
      role: userFound.role,
      orgname: userResponse.orgname || userFound.orgname,
      orgId: userResponse.orgId,
    });

    logEvent({
      type: EVENT.LOGIN_SUCCESS,
      req,
      username: cleanUsername,
      orgname: userResponse.orgname || userFound.orgname,
      orgId: userResponse.orgId,
      role: userFound.role,
      success: true,
      message: "Inicio de sesión correcto.",
      detail: { language: userFound.preferences?.language || null },
    });

    return res.status(200).json({
      success: true,
      message: "Login exitoso",
      user: userResponse,
      sessionToken,
      token: tokens,
    });
  } catch (error) {
    console.error("Login error:", error);
    logEvent({
      type: EVENT.LOGIN_ERROR,
      req,
      username: req.body?.username,
      orgname: req.body?.orgname,
      success: false,
      message: error.message,
    });
    return res.status(500).json({
      success: false,
      message: "Error interno del servidor.",
      details: error.message,
    });
  }
});

/**
 * Cierre de sesión. No invalida el JWT (es sin estado y de vida corta): existe
 * para dejar constancia en el log de cuándo terminó cada sesión.
 */
app.post("/api/logout", (req, res) => {
  logEvent({
    type: EVENT.LOGOUT,
    req,
    success: true,
    message: "Cierre de sesión.",
  });
  return res.status(200).json({ success: true, message: "Sesión cerrada." });
});

app.post("/api/token", requireAdmin, async (req, res) => {
  try {
    const { clientId, clientSecret, region } = req.body;
    //console.log("region", region);
    // Validar credenciales
    if (!clientId || !clientSecret) {
      return res.status(400).json({
        success: false,
        error: "Debe proporcionar clientId y clientSecret",
      });
    }

    // Configuración del cliente de Genesys
    const client = platformClient.ApiClient.instance;
    let url = platformClient.PureCloudRegionHosts.us_east_1; // Por defecto

    if (region) {
      switch (region) {
        case "us-east-1":
          url = platformClient.PureCloudRegionHosts.us_east_1;
          break;
        case "us-west-2":
          url = platformClient.PureCloudRegionHosts.us_west_2;
          break;
        case "us-east-2":
          url = platformClient.PureCloudRegionHosts.us_east_2;
          break;
        case "ca-central-1":
          url = platformClient.PureCloudRegionHosts.ca_central_1;
          break;
        case "sa-east-1":
          url = platformClient.PureCloudRegionHosts.sa_east_1;
          break;
        case "eu-west-1":
          url = platformClient.PureCloudRegionHosts.eu_west_1;
          break;
        case "eu-central-1":
          url = platformClient.PureCloudRegionHosts.eu_central_1;
          break;
        case "eu-west-2":
          url = platformClient.PureCloudRegionHosts.eu_west_2;
          break;
        case "eu-central-2":
          url = platformClient.PureCloudRegionHosts.eu_central_2;
          break;
        case "ap-south-1":
          url = platformClient.PureCloudRegionHosts.ap_south_1;
          break;
        case "ap-northeast-1":
          url = platformClient.PureCloudRegionHosts.ap_northeast_1;
          break;
        case "ap-northeast-2":
          url = platformClient.PureCloudRegionHosts.ap_northeast_2;
          break;
        case "ap-northeast-3":
          url = platformClient.PureCloudRegionHosts.ap_northeast_3;
          break;
        case "ap-southeast-2":
          url = platformClient.PureCloudRegionHosts.ap_southeast_2;
          break;
        case "me-central-1":
          url = platformClient.PureCloudRegionHosts.me_central_1;
          break;
        case "mx-central-1":
          url = platformClient.PureCloudRegionHosts.mx_central_1;
          break;
        default:
          console.error(`Región no reconocida: ${region}`);
      }
    }

    //console.log(`Configurando región: ${region}, URL: ${url}`);
    client.setEnvironment(url);

    // Generar token
    await client.loginClientCredentialsGrant(clientId, clientSecret);

    return res.status(200).json({
      success: true,
      token: client.authData.accessToken,
    });
  } catch (error) {
    console.error("Error al generar token:", error);
    return res.status(500).json({
      success: false,
      error: "Error al generar el token. Verifique sus credenciales.",
    });
  }
});

const { initCron, runDailyMonitor } = require("./services/cronOrchestrator");
const { getMonitorHealth } = require("./services/monitorQueue");
const { getQueueHealth } = require("./services/emailQueue");

// Iniciar el servidor
app.listen(port, () => {
  console.log(`✅ API de Node.js corriendo en http://localhost:${port}`);
  initCron();
});

// Disparo manual del orquestador. Protegido: sin el guard, cualquiera con la
// URL podía lanzar un envío masivo de correos a todos los clientes.
app.post("/api/monitor/run", async (req, res) => {
  if (!requireAdminToken(req, res)) return;

  console.log("▶️ Forzando ejecución del monitor desde endpoint administrativo...");
  logEvent({
    type: EVENT.MONITOR_RUN,
    req,
    message: "Ejecución manual del orquestador de monitoreo.",
    detail: { entorno: currentEnv(), notificacionesBloqueadas: notificationsBlocked() },
  });
  runDailyMonitor().catch((err) =>
    console.error("❌ Ejecución manual del monitor falló:", err.message),
  );
  return res.json({
    success: true,
    message: "El orquestador se inició en background. Revisa la consola.",
  });
});

// Salud del monitoreo: estado de las colas y organizaciones con último error.
app.get("/api/monitor/health", async (req, res) => {
  if (!requireAdminToken(req, res)) return;

  try {
    const [monitor, emails] = await Promise.all([getMonitorHealth(), getQueueHealth()]);

    const orgsSnapshot = await db.collection("organizations").get();
    const conProblemas = [];
    orgsSnapshot.forEach((doc) => {
      const data = doc.data();
      if (data.monitorState?.lastError) {
        conProblemas.push({
          orgId: data.orgId || doc.id,
          orgname: data.orgname,
          error: data.monitorState.lastError,
          lastRunAt: data.monitorState.lastRunAt || null,
        });
      }
    });

    return res.json({
      success: true,
      queues: { monitor, emails },
      organizacionesConError: conProblemas,
    });
  } catch (error) {
    console.error("❌ Error en /api/monitor/health:", error);
    return res
      .status(500)
      .json({ success: false, message: "Error interno", detail: error.message });
  }
});

// Endpoint para obtener Trustee Billing Overview
app.post("/api/trusteebillingoverview", async (req, res) => {
  try {
    const { trustorOrgId, accessToken, billingPeriodIndex, region } = req.body;

    if (!trustorOrgId || !accessToken || billingPeriodIndex === undefined) {
      return res.status(400).json({
        success: false,
        error: "Se requieren trustorOrgId, accessToken y billingPeriodIndex",
      });
    }

    const client = platformClient.ApiClient.instance;
    let url = platformClient.PureCloudRegionHosts.us_east_1; // Por defecto

    if (region) {
      switch (region) {
        case "us-east-1":
          url = platformClient.PureCloudRegionHosts.us_east_1;
          break;
        case "us-west-2":
          url = platformClient.PureCloudRegionHosts.us_west_2;
          break;
        case "us-east-2":
          url = platformClient.PureCloudRegionHosts.us_east_2;
          break;
        case "ca-central-1":
          url = platformClient.PureCloudRegionHosts.ca_central_1;
          break;
        case "sa-east-1":
          url = platformClient.PureCloudRegionHosts.sa_east_1;
          break;
        case "eu-west-1":
          url = platformClient.PureCloudRegionHosts.eu_west_1;
          break;
        case "eu-central-1":
          url = platformClient.PureCloudRegionHosts.eu_central_1;
          break;
        case "eu-west-2":
          url = platformClient.PureCloudRegionHosts.eu_west_2;
          break;
        case "eu-central-2":
          url = platformClient.PureCloudRegionHosts.eu_central_2;
          break;
        case "ap-south-1":
          url = platformClient.PureCloudRegionHosts.ap_south_1;
          break;
        case "ap-northeast-1":
          url = platformClient.PureCloudRegionHosts.ap_northeast_1;
          break;
        case "ap-northeast-2":
          url = platformClient.PureCloudRegionHosts.ap_northeast_2;
          break;
        case "ap-northeast-3":
          url = platformClient.PureCloudRegionHosts.ap_northeast_3;
          break;
        case "ap-southeast-2":
          url = platformClient.PureCloudRegionHosts.ap_southeast_2;
          break;
        case "me-central-1":
          url = platformClient.PureCloudRegionHosts.me_central_1;
          break;
        case "mx-central-1":
          url = platformClient.PureCloudRegionHosts.mx_central_1;
          break;
        default:
          console.error(`Región no reconocida: ${region}`);
      }
    }

    console.log(`[billing] Configurando región: ${region} | trustorOrgId: ${trustorOrgId}`);
    client.setEnvironment(url);
    client.setAccessToken(accessToken);
    client.timeout = 60000; // 60s timeout para llamadas al SDK de Genesys

    const apiInstance = new platformClient.BillingApi();
    const opts = {
      billingPeriodIndex: Number(billingPeriodIndex),
    };

    const data = await apiInstance.getBillingTrusteebillingoverviewTrustorOrgId(
      trustorOrgId,
      opts,
    );

    const customerFormated = formatTrusteeBilling(data);

    console.log("✅ Billing overview obtenido para:", trustorOrgId);
    return res.status(200).json({
      success: true,
      data,
      customer: customerFormated,
    });
  } catch (error) {
    console.error(`❌ Error al obtener billing overview para trustorOrgId "${req.body?.trustorOrgId}":`, error?.body || error?.message || error);

    let errorMessage = "Error inesperado al obtener billing overview";
    const details = error.body || error;

    if (error.body && error.body.message) {
      errorMessage = error.body.message;
    } else if (error.text) {
      errorMessage = error.text;
    } else if (error.message) {
      errorMessage = error.message;
    }

    return res.status(error.status || 500).json({
      success: false,
      error: errorMessage,
      details: details,
      code: error.body?.code || error.code,
      contextId: error.body?.contextId || error.contextId,
    });
  }
});

// Endpoint para obtener Subscription Overview (alternativa que pide enddate/periodEndingTimestamp y accessToken)
app.post("/api/subscriptionoverview", async (req, res) => {
  try {
    const { endDate, accessToken, region } = req.body;

    const actualToken = accessToken;
    let actualEndDate = endDate;

    if (!actualToken) {
      return res.status(400).json({
        success: false,
        error: "Se requiere accessToken o token en el cuerpo de la petición.",
      });
    }

    if (!actualEndDate) {
      return res.status(400).json({
        success: false,
        error: "Se requiere endDate, enddate o periodEndingTimestamp en el cuerpo de la petición.",
      });
    }

    // Obtener la URL de la API de Genesys según la región especificada
    const regionUrl = getRegionUrl(region || "us-east-1");
    if (!regionUrl || regionUrl === "null") {
      return res.status(400).json({
        success: false,
        error: "Región no válida o no soportada.",
      });
    }

    // Helper: fetch con timeout via AbortController
    const fetchWithTimeout = (url, options = {}, timeoutMs = 20000) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      return fetch(url, { ...options, signal: controller.signal })
        .finally(() => clearTimeout(timer));
    };

    const genesysHeaders = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${actualToken}`,
    };

    // Convertir a timestamp en milisegundos o resolver palabras clave "current" / "previous"
    let timestamp;
    // Fechas reales del periodo, cuando se resuelven desde /billing/periods.
    let periodOverride = null;
    if (actualEndDate === "current") {
      timestamp = Date.now();
    } else if (actualEndDate === "previous") {
      // Para obtener el periodo anterior, consultamos /api/v2/billing/periods
      // (Genesys no devuelve billingPeriodStartDate en el overview crudo)
      const periodsUrl = `${regionUrl}/api/v2/billing/periods`;
      let periodsResponse;
      try {
        periodsResponse = await fetchWithTimeout(periodsUrl, { method: "GET", headers: genesysHeaders });
      } catch (e) {
        return res.status(504).json({
          success: false,
          error: "Timeout al consultar los periodos de facturación de Genesys Cloud.",
        });
      }

      if (!periodsResponse.ok) {
        const errorText = await periodsResponse.text();
        return res.status(periodsResponse.status).json({
          success: false,
          error: "Error al consultar los periodos de facturación de Genesys Cloud.",
          details: errorText,
        });
      }

      const periodsData = await periodsResponse.json();
      const periods = periodsData.entities || periodsData.periods || periodsData || [];

      if (!Array.isArray(periods) || periods.length === 0) {
        return res.status(500).json({
          success: false,
          error: "No se encontraron periodos de facturación para determinar el periodo anterior.",
        });
      }

      // Ordenar de más reciente a más antiguo por startDate
      periods.sort((a, b) => new Date(b.startDate) - new Date(a.startDate));

      // El "periodo anterior" es el más reciente YA FINALIZADO, no el índice 1.
      // Genesys tarda días en rotar el periodo vigente: durante esa ventana
      // periods[0] es el periodo recién cerrado y periods[1] sería uno de más,
      // devolviendo datos de dos meses atrás.
      const now = new Date();
      const hoyUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const previousPeriod = periods.find((p) => {
        const end = new Date(p.endDate);
        if (isNaN(end.getTime())) return false;
        return Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()) < hoyUTC;
      });

      if (!previousPeriod || !previousPeriod.endDate) {
        return res.status(500).json({
          success: false,
          error: "No se encontró ningún periodo de facturación ya finalizado.",
        });
      }

      // La fecha de fin del periodo cerrado identifica el periodo sin ambigüedad.
      timestamp = new Date(previousPeriod.endDate).getTime();
      periodOverride = previousPeriod;
    } else if (isNaN(actualEndDate)) {
      const parsedDate = new Date(actualEndDate).getTime();
      if (isNaN(parsedDate)) {
        return res.status(400).json({
          success: false,
          error: "Formato de fecha inválido. Debe ser 'current', 'previous', un timestamp o una fecha válida (e.g., YYYY-MM-DD).",
        });
      }
      timestamp = parsedDate;
    } else {
      timestamp = Number(actualEndDate);
    }

    // Guardia final: si el timestamp es 0, NaN o negativo, usar la fecha actual
    if (!timestamp || isNaN(timestamp) || timestamp <= 0) {
      console.warn(`[subscriptionoverview] Timestamp inválido (${timestamp}) para endDate="${actualEndDate}", usando Date.now()`);
      timestamp = Date.now();
    }

    const overviewUrl = `${regionUrl}/api/v2/billing/subscriptionoverview?periodEndingTimestamp=${timestamp}`;
    const orgUrl = `${regionUrl}/api/v2/organizations/me`;

    // Ejecutar overview + org en paralelo para reducir latencia
    let overviewRes, orgRes;
    try {
      [overviewRes, orgRes] = await Promise.all([
        fetchWithTimeout(overviewUrl, { method: "GET", headers: genesysHeaders }),
        fetchWithTimeout(orgUrl, { method: "GET", headers: genesysHeaders }),
      ]);
    } catch (e) {
      return res.status(504).json({
        success: false,
        error: "Timeout al consultar Genesys Cloud. Intente de nuevo.",
      });
    }

    if (!overviewRes.ok) {
      const errorText = await overviewRes.text();
      let errorJson;
      try {
        errorJson = JSON.parse(errorText);
      } catch (e) {
        errorJson = { message: errorText };
      }
      return res.status(overviewRes.status).json({
        success: false,
        error: errorJson.message || "Error al consultar la API de Genesys Cloud",
        details: errorJson,
      });
    }

    const data = await overviewRes.json();

    // Enriquecer con fechas. Si conocemos el periodo real (vía /billing/periods)
    // usamos sus fechas exactas; si no, se aproxima restando un mes.
    if (periodOverride && periodOverride.startDate && periodOverride.endDate) {
      data.billingPeriodStartDate = new Date(periodOverride.startDate).toISOString();
      data.billingPeriodEndDate = new Date(periodOverride.endDate).toISOString();
    } else {
      const endDateObj = new Date(timestamp);
      data.billingPeriodEndDate = endDateObj.toISOString();

      const startDateObj = new Date(timestamp);
      startDateObj.setUTCMonth(startDateObj.getUTCMonth() - 1);
      data.billingPeriodStartDate = startDateObj.toISOString();
    }

    data.rampPeriodStartDate = data.rampPeriodStartingTimestamp || data.billingPeriodStartDate;
    data.rampPeriodEndDate = data.rampPeriodEndingTimestamp || data.billingPeriodEndDate;

    // Enriquecer con datos de organización (ya obtenidos en paralelo)
    if (!data.organization && orgRes.ok) {
      try {
        const orgData = await orgRes.json();
        data.organization = { name: orgData.name || "", id: orgData.id || "" };
      } catch (orgError) {
        console.warn("[subscriptionoverview] No se pudo parsear datos de la organización:", orgError.message);
      }
    }

    const customerFormated = formatTrusteeBilling(data);

    console.log("✅ Subscription overview obtenido y formateado correctamente");
    return res.status(200).json({
      success: true,
      data,
      customer: customerFormated,
    });
  } catch (error) {
    console.error("❌ Error en /api/subscriptionoverview:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Error interno del servidor",
    });
  }
});

// Endpoint para obtener la lista de periodos reales de facturación desde Genesys
app.post("/api/billing/periods", async (req, res) => {
  try {
    const { accessToken, region } = req.body;

    if (!accessToken) {
      return res.status(400).json({
        success: false,
        error: "Se requiere accessToken en el cuerpo de la petición.",
      });
    }

    const regionUrl = getRegionUrl(region || "us-east-1");
    if (!regionUrl || regionUrl === "null") {
      return res.status(400).json({
        success: false,
        error: "Región no válida o no soportada.",
      });
    }

    const apiUrl = `${regionUrl}/api/v2/billing/periods`;
    console.log(`[billing] Consultando periodos de facturación reales: ${apiUrl}`);

    const response = await fetch(apiUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorJson;
      try {
        errorJson = JSON.parse(errorText);
      } catch (e) {
        errorJson = { message: errorText };
      }
      return res.status(response.status).json({
        success: false,
        error: errorJson.message || "Error al consultar los periodos en Genesys Cloud",
        details: errorJson,
      });
    }

    const data = await response.json();
    return res.status(200).json({
      success: true,
      periods: data.entities || [],
    });
  } catch (error) {
    console.error("❌ Error en /api/billing/periods:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Error interno del servidor",
    });
  }
});

// Endpoint para obtener Billable Usage (Uso Facturable)
app.post("/api/billableusage", async (req, res) => {
  try {
    const { accessToken, startDate, endDate, region } = req.body;

    if (!accessToken || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: "Se requieren accessToken, startDate y endDate",
      });
    }

    const client = platformClient.ApiClient.instance;
    let url = platformClient.PureCloudRegionHosts.us_east_1; // Por defecto

    if (region) {
      switch (region) {
        case "us-east-1":
          url = platformClient.PureCloudRegionHosts.us_east_1;
          break;
        case "us-west-2":
          url = platformClient.PureCloudRegionHosts.us_west_2;
          break;
        case "us-east-2":
          url = platformClient.PureCloudRegionHosts.us_east_2;
          break;
        case "ca-central-1":
          url = platformClient.PureCloudRegionHosts.ca_central_1;
          break;
        case "sa-east-1":
          url = platformClient.PureCloudRegionHosts.sa_east_1;
          break;
        case "eu-west-1":
          url = platformClient.PureCloudRegionHosts.eu_west_1;
          break;
        case "eu-central-1":
          url = platformClient.PureCloudRegionHosts.eu_central_1;
          break;
        case "eu-west-2":
          url = platformClient.PureCloudRegionHosts.eu_west_2;
          break;
        case "eu-central-2":
          url = platformClient.PureCloudRegionHosts.eu_central_2;
          break;
        case "ap-south-1":
          url = platformClient.PureCloudRegionHosts.ap_south_1;
          break;
        case "ap-northeast-1":
          url = platformClient.PureCloudRegionHosts.ap_northeast_1;
          break;
        case "ap-northeast-2":
          url = platformClient.PureCloudRegionHosts.ap_northeast_2;
          break;
        case "ap-northeast-3":
          url = platformClient.PureCloudRegionHosts.ap_northeast_3;
          break;
        case "ap-southeast-2":
          url = platformClient.PureCloudRegionHosts.ap_southeast_2;
          break;
        case "me-central-1":
          url = platformClient.PureCloudRegionHosts.me_central_1;
          break;
        case "mx-central-1":
          url = platformClient.PureCloudRegionHosts.mx_central_1;
          break;
        default:
          console.error(`Región no reconocida: ${region}`);
      }
    }

    console.log(`Configurando región: ${region}, URL: ${url}`);
    client.setEnvironment(url);
    client.setAccessToken(accessToken);

    const apiInstance = new platformClient.BillingApi();

    const data = await apiInstance.getBillingReportsBillableusage(
      new Date(startDate),
      new Date(endDate),
    );

    console.log("✅ BillableUsage obtenido");
    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("❌ Error al consultar uso facturable:", error);

    // El SDK de Genesys suele incluir el detalle del error en error.body o error.text
    let errorMessage = "Error inesperado al obtener billable usage";
    const details = error.body || error;

    if (error.body && error.body.message) {
      errorMessage = error.body.message;
    } else if (error.text) {
      errorMessage = error.text;
    } else if (error.message) {
      errorMessage = error.message;
    }

    return res.status(error.status || 500).json({
      success: false,
      error: errorMessage,
      details: details,
      code: error.body?.code || error.code,
      contextId: error.body?.contextId || error.contextId,
    });
  }
});

// Funciones auxiliares para divisionsdata
const getRegionUrl = (region) => {
  let url = "https://api.mypurecloud.com";
  if (region) {
    switch (region) {
      case "us-east-1":
        url = "https://api.mypurecloud.com";
        break;
      case "us-west-2":
        url = "https://api.usw2.pure.cloud";
        break;
      case "us-east-2":
        url = "https://api.use2.pure.cloud";
        break;
      case "ca-central-1":
        url = "https://api.cac1.pure.cloud";
        break;
      case "sa-east-1":
        url = "https://api.sae1.pure.cloud";
        break;
      case "eu-west-1":
        url = "https://api.euw1.pure.cloud";
        break;
      case "eu-central-1":
        url = "https://api.euc1.pure.cloud";
        break;
      case "eu-west-2":
        url = "https://api.euw2.pure.cloud";
        break;
      case "eu-central-2":
        url = "https://api.euc2.pure.cloud";
        break;
      case "ap-south-1":
        url = "https://api.aps1.pure.cloud";
        break;
      case "ap-northeast-1":
        url = "https://api.apne1.pure.cloud";
        break;
      case "ap-northeast-2":
        url = "https://api.apne2.pure.cloud";
        break;
      case "ap-northeast-3":
        url = "https://api.apne3.pure.cloud";
        break;
      case "ap-southeast-2":
        url = "https://api.apse2.pure.cloud";
        break;
      case "me-central-1":
        url = "https://api.mec1.pure.cloud";
        break;
      case "mx-central-1":
        url = "https://api.mxc1.pure.cloud";
        break;
      default:
        console.error(`Región no reconocida: ${region}`);
        url = "null";
    }
  }
  return url;
};

// Memoria caché para usuarios (TTL 5 minutos)
const userCache = new Map();

async function getAllUsersCached(accessToken, region, forceRefresh = false) {
  const cacheKey = `${accessToken}_${region}`;

  if (forceRefresh) {
    console.log("🔄 Force refresh solicitado, limpiando caché...");
    userCache.delete(cacheKey);
  }

  const cached = userCache.get(cacheKey);
  if (cached && Date.now() < cached.expiry) {
    console.log("✅ Usando lista de usuarios desde caché en memoria");
    return cached.data;
  }

  console.log("🔍 Obteniendo todos los usuarios de Genesys API (GET /api/v2/users)...");
  const regionUrl = getRegionUrl(region);
  let allUsers = [];
  let pageNumber = 1;
  let totalPages = 1;

  try {
    do {
      const response = await fetch(
        `${regionUrl}/api/v2/users?pageSize=100&pageNumber=${pageNumber}&expand=dateLastLogin,presence&state=active`,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );
      if (!response.ok) {
        throw new Error(`Failed to fetch users from Genesys: ${response.status}`);
      }
      const result = await response.json();
      if (pageNumber === 1 && result.pageCount) totalPages = result.pageCount;
      if (result.entities && result.entities.length > 0) {
        allUsers = [...allUsers, ...result.entities];
      }
      pageNumber++;
    } while (pageNumber <= totalPages);

    console.log(`✅ Total users fetched from API: ${allUsers.length}`);

    // Guardar en caché por 5 minutos (300000 ms)
    userCache.set(cacheKey, { data: allUsers, expiry: Date.now() + 300000 });
    return allUsers;
  } catch (err) {
    console.error("Error fetching users for cache", err);
    return [];
  }
}

const formatUsersDivision = (allUsers) => {
  // Debug: log the first user's presence to understand the data structure
  const firstWithPresence = allUsers.find(u => u.presence);
  if (firstWithPresence) {
    console.log("Sample presence object:", JSON.stringify(firstWithPresence.presence, null, 2));
  }

  const listUsers = allUsers.map((user) => {
    const sysPresence = user.presence?.presenceDefinition?.systemPresence;
    // Consider connected if presence exists and is not Offline (case-insensitive)
    const isConnected = !!sysPresence && sysPresence.toUpperCase() !== "OFFLINE";

    return {
      divisionId: user.division?.id,
      email: user.email || "",
      uuid: user.id,
      isConnected,
    };
  });
  // agrupar por divisionID
  return listUsers.reduce((acc, user) => {
    if (user.divisionId) {
      if (!acc[user.divisionId]) {
        acc[user.divisionId] = [];
      }
      acc[user.divisionId].push(user);
    }
    return acc;
  }, {});
};

async function getUsersDivision(accessToken, region, forceRefresh = false) {
  try {
    const allUsers = await getAllUsersCached(accessToken, region, forceRefresh);
    return formatUsersDivision(allUsers);
  } catch (error) {
    console.error("⚠️ Error al obtener usuarios:", error);
    return {};
  }
}

const formatDivisions = async (data, accessToken, region, forceRefresh = false) => {
  const divisiones = await getUsersDivision(accessToken, region, forceRefresh);

  return data.entities.map((division) => ({
    id: division.id,
    name: division.name,
    description: division.description,
    users: divisiones[division.id] || [],
  }));
};

async function getDivisions(accessToken, region, forceRefresh = false) {
  try {
    const regionUrl = getRegionUrl(region);
    const response = await fetch(
      `${regionUrl}/api/v2/authorization/divisions?pageSize=1000&pageNumber=1&objectCount=true`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );
    const result = await response.json();
    return await formatDivisions(result, accessToken, region, forceRefresh);
  } catch (error) {
    console.error("⚠️ Error al obtener divisiones:", error);
    throw error;
  }
}

// Endpoint para obtener Divisions Data
app.post("/api/divisionsdata", async (req, res) => {
  try {
    const { accessToken, region, forceRefresh } = req.body;

    if (!accessToken || !region) {
      return res.status(400).json({
        success: false,
        message: "Se requieren accessToken y region",
      });
    }

    const dataFormated = await getDivisions(accessToken, region, forceRefresh);

    console.log("✅ Divisions data obtenida");
    return res.status(200).json(dataFormated); // Nota: AWS Lambda devolvía el arreglo directamente
  } catch (error) {
    console.error("❌ Error al obtener divisiones:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Error interno del servidor",
    });
  }
});

// Endpoint para obtener Daily Logins
app.get("/api/reports/daily-logins", async (req, res) => {
  try {
    const { startDate, endDate, timezone, region } = req.query;
    const accessToken =
      req.query.accessToken ||
      (req.headers.authorization && req.headers.authorization.split(" ")[1]);

    if (!accessToken || !startDate || !endDate || !region) {
      return res.status(400).json({
        success: false,
        error: "Se requieren startDate, endDate, accessToken y region",
      });
    }

    let url = getRegionUrl(region);

    // Obtener offset de la zona horaria
    let offsetStart = "Z";
    let offsetEnd = "Z";
    if (timezone) {
      try {
        const formatterStart = new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          timeZoneName: "longOffset",
        });
        const tzStrStart = formatterStart
          .formatToParts(new Date(`${startDate}T12:00:00Z`))
          .find((p) => p.type === "timeZoneName").value;
        offsetStart = tzStrStart.replace("GMT", "");
        if (offsetStart === "") offsetStart = "Z";

        const formatterEnd = new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          timeZoneName: "longOffset",
        });
        const tzStrEnd = formatterEnd
          .formatToParts(new Date(`${endDate}T12:00:00Z`))
          .find((p) => p.type === "timeZoneName").value;
        offsetEnd = tzStrEnd.replace("GMT", "");
        if (offsetEnd === "") offsetEnd = "Z";
      } catch (e) {
        console.error("Error al calcular timezone offset", e);
      }
    }

    const interval = `${startDate}T00:00:00.000${offsetStart}/${endDate}T23:59:59.999${offsetEnd}`;

    // Obtener todos los usuarios de la organización
    const divisionsObj = await getUsersDivision(accessToken, region);
    let allUserIds = [];
    for (const divId in divisionsObj) {
      divisionsObj[divId].forEach((u) => {
        if (u.uuid) allUserIds.push(u.uuid);
      });
    }

    // Generar Esqueleto
    const dailyCounts = {};
    const start = new Date(`${startDate}T12:00:00Z`);
    const end = new Date(`${endDate}T12:00:00Z`);
    const daysOfWeek = [
      "Domingo",
      "Lunes",
      "Martes",
      "Miércoles",
      "Jueves",
      "Viernes",
      "Sábado",
    ];

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateKey = d.toISOString().split("T")[0];
      dailyCounts[dateKey] = 0;
    }

    let totalUniqueLoginsInPeriod = 0;
    const uniqueUsersSet = new Set();
    const chunkErrors = []; // Collect errors per chunk for frontend debug

    if (allUserIds.length > 0) {
      const chunkSize = 100;
      const chunks = [];
      for (let i = 0; i < allUserIds.length; i += chunkSize) {
        chunks.push(allUserIds.slice(i, i + chunkSize));
      }

      for (const chunk of chunks) {
        const predicates = chunk.map((id) => ({
          type: "dimension",
          dimension: "userId",
          operator: "matches",
          value: id,
        }));

        const payload = {
          interval: interval,
          granularity: "P1D",
          groupBy: ["userId"],
          metrics: ["tSystemPresence"],
          filter: {
            type: "or",
            predicates: predicates,
          },
        };

        const response = await fetch(
          `${url}/api/v2/analytics/users/aggregates/query`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify(payload),
          },
        );

        const genesysResponse = await response.json();

        if (response.ok && genesysResponse.results) {
          genesysResponse.results.forEach((userResult) => {
            let userHasLogin = false;
            if (userResult.data) {
              userResult.data.forEach((dayData) => {
                const dateKey = dayData.interval.split("T")[0];
                if (dayData.metrics && dayData.metrics.length > 0) {
                  const hasActivePresence = dayData.metrics.some(
                    (m) =>
                      m.metric === "tSystemPresence" &&
                      m.qualifier !== "OFFLINE" &&
                      m.stats &&
                      (m.stats.count > 0 || m.stats.sum > 0),
                  );

                  if (hasActivePresence) {
                    if (dailyCounts[dateKey] !== undefined) {
                      dailyCounts[dateKey] += 1;
                    }
                    userHasLogin = true;
                  }
                }
              });
            }
            if (userHasLogin && userResult.group && userResult.group.userId) {
              uniqueUsersSet.add(userResult.group.userId);
            }
          });
        } else if (!response.ok) {
          console.error(
            "Error from Genesys aggregations API for chunk:",
            genesysResponse,
          );
          chunkErrors.push({
            status: genesysResponse.status,
            code: genesysResponse.code,
            message: genesysResponse.message,
            contextId: genesysResponse.contextId,
          });
        }
      }
    }

    totalUniqueLoginsInPeriod = uniqueUsersSet.size;

    const dailyData = Object.keys(dailyCounts).map((date) => {
      const dateObj = new Date(`${date}T12:00:00Z`);
      return {
        date: date,
        dayOfWeek: daysOfWeek[dateObj.getUTCDay()],
        activeUsers: dailyCounts[date],
      };
    });

    // Detectar si los errores impiden obtener datos reales
    const permissionErrors = chunkErrors.filter((e) => e.status === 403);
    const hasPermissionError = permissionErrors.length > 0;
    const allChunksFailedWithPermission =
      hasPermissionError &&
      chunkErrors.length >= Math.ceil(allUserIds.length / 100);

    return res.status(200).json({
      success: true,
      period: { start: startDate, end: endDate },
      totalUniqueLoginsInPeriod,
      dailyData,
      warning: hasPermissionError
        ? {
          code: "missing_permission",
          message: permissionErrors[0].message,
          affectedChunks: permissionErrors.length,
          totalChunks: chunkErrors.length,
          dataReliable: !allChunksFailedWithPermission,
        }
        : undefined,
      debug: chunkErrors.length > 0 ? { chunkErrors } : undefined,
    });
  } catch (error) {
    console.error("Error en daily-logins:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint: Detalles de IA Tokens por División
app.get("/api/reports/ia-tokens-details", async (req, res) => {
  try {
    const { startDate, endDate, timezone, region } = req.query;
    const accessToken =
      req.query.accessToken ||
      (req.headers.authorization && req.headers.authorization.split(" ")[1]);

    if (!accessToken || !startDate || !endDate || !region) {
      return res.status(400).json({
        success: false,
        error: "Se requieren startDate, endDate, accessToken y region",
      });
    }

    let url = getRegionUrl(region);

    let offsetStart = "Z";
    let offsetEnd = "Z";
    if (timezone) {
      try {
        const formatterStart = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" });
        const tzStrStart = formatterStart.formatToParts(new Date(`${startDate}T12:00:00Z`)).find((p) => p.type === "timeZoneName").value;
        offsetStart = tzStrStart.replace("GMT", "");
        if (offsetStart === "") offsetStart = "Z";

        const formatterEnd = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" });
        const tzStrEnd = formatterEnd.formatToParts(new Date(`${endDate}T12:00:00Z`)).find((p) => p.type === "timeZoneName").value;
        offsetEnd = tzStrEnd.replace("GMT", "");
        if (offsetEnd === "") offsetEnd = "Z";
      } catch (e) {
        console.error("Error al calcular timezone offset", e);
      }
    }

    const interval = `${startDate}T00:00:00.000${offsetStart}/${endDate}T23:59:59.999${offsetEnd}`;

    // Get Divisions to map IDs to Names
    const divisionsObj = await getDivisions(accessToken, region, false);
    const divisionsMap = {};
    divisionsObj.forEach(div => { divisionsMap[div.id] = div.name; });

    const divisionUsage = {};
    const initDiv = (divId) => {
      if (!divisionUsage[divId]) {
        divisionUsage[divId] = {
          divisionId: divId,
          divisionName: divisionsMap[divId] || "Desconocida",
          botVoiceMin: 0,
          botDigitalSessions: 0,
          whatsappSessions: 0,
          copilotSessions: 0  // Conversations where Agent Copilot could be used
        };
      }
    };

    // 1. Bot Flows Query
    const botFlowsPayload = {
      interval: interval,
      groupBy: ["divisionId", "mediaType"],
      metrics: ["nFlow", "tFlow"],
      filter: {
        type: "or",
        predicates: [
          { type: "dimension", dimension: "flowType", operator: "matches", value: "bot" },
          { type: "dimension", dimension: "flowType", operator: "matches", value: "digitalbot" }
        ]
      }
    };

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`
    };

    const resFlows = await fetch(`${url}/api/v2/analytics/flows/aggregates/query`, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(botFlowsPayload)
    });

    if (resFlows.ok) {
      const dataFlows = await resFlows.json();
      if (dataFlows.results) {
        dataFlows.results.forEach(group => {
          const divId = group.group.divisionId || "Home";
          const mediaType = group.group.mediaType || "unknown";
          initDiv(divId);
          if (divId === "Home") {
            divisionUsage[divId].divisionName = "Home / Default";
          }
          if (group.data && group.data[0] && group.data[0].metrics) {
            group.data[0].metrics.forEach(m => {
              if (m.metric === "tFlow" && mediaType === "voice") {
                divisionUsage[divId].botVoiceMin += (m.stats.sum / 60000); // ms to minutes
              }
              if (m.metric === "nFlow" && mediaType !== "voice") {
                divisionUsage[divId].botDigitalSessions += m.stats.count;
              }
            });
          }
        });
      }
    }

    // 2. WhatsApp Query
    const waPayload = {
      interval: interval,
      groupBy: ["divisionId"],
      metrics: ["nConnected"],
      filter: {
        type: "and",
        predicates: [
          { type: "dimension", dimension: "mediaType", operator: "matches", value: "message" },
          { type: "dimension", dimension: "messageType", operator: "matches", value: "whatsapp" }
        ]
      }
    };

    const resWa = await fetch(`${url}/api/v2/analytics/conversations/aggregates/query`, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(waPayload)
    });

    if (resWa.ok) {
      const dataWa = await resWa.json();
      if (dataWa.results) {
        dataWa.results.forEach(group => {
          const divId = group.group.divisionId || "Home";
          initDiv(divId);
          if (divId === "Home") {
            divisionUsage[divId].divisionName = "Home / Default";
          }
          if (group.data && group.data[0] && group.data[0].metrics) {
            group.data[0].metrics.forEach(m => {
              if (m.metric === "nConnected") {
                divisionUsage[divId].whatsappSessions += m.stats.count;
              }
            });
          }
        });
      }
    }

    // 3. Copilot Query - Conversaciones de agente (voz + chat + email, sin WhatsApp)
    // Agent Copilot asiste agentes en interacciones, distribuimos por volumen de conversaciones conectadas por división
    const copilotPayload = {
      interval: interval,
      groupBy: ["divisionId"],
      metrics: ["nConnected"],
      filter: {
        type: "or",
        predicates: [
          { type: "dimension", dimension: "mediaType", operator: "matches", value: "voice" },
          { type: "dimension", dimension: "mediaType", operator: "matches", value: "chat" },
          { type: "dimension", dimension: "mediaType", operator: "matches", value: "email" }
        ]
      }
    };

    const resCopilot = await fetch(`${url}/api/v2/analytics/conversations/aggregates/query`, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(copilotPayload)
    });

    if (resCopilot.ok) {
      const dataCopilot = await resCopilot.json();
      if (dataCopilot.results) {
        dataCopilot.results.forEach(group => {
          const divId = group.group.divisionId || "Home";
          initDiv(divId);
          if (divId === "Home") divisionUsage[divId].divisionName = "Home / Default";
          if (group.data && group.data[0] && group.data[0].metrics) {
            group.data[0].metrics.forEach(m => {
              if (m.metric === "nConnected") {
                divisionUsage[divId].copilotSessions += m.stats.count;
              }
            });
          }
        });
      }
    }

    // Prorrateo proporcional usando los totales reales de facturación
    // El frontend envía los tokens reales facturados por Genesys (de clientData.aiExperience)
    const billedVoice = parseFloat(req.query.billedVoice) || 0;
    const billedDigital = parseFloat(req.query.billedDigital) || 0;
    const billedWa = parseFloat(req.query.billedWa) || 0;
    const billedCopilot = parseFloat(req.query.billedCopilot) || 0;

    console.log(`💰 Tokens facturados → Voice: ${billedVoice}, Digital: ${billedDigital}, WhatsApp: ${billedWa}, Copilot: ${billedCopilot}`);

    const rawData = Object.values(divisionUsage);
    const sumVoice = rawData.reduce((acc, r) => acc + r.botVoiceMin, 0);
    const sumDigital = rawData.reduce((acc, r) => acc + r.botDigitalSessions, 0);
    const sumWa = rawData.reduce((acc, r) => acc + r.whatsappSessions, 0);
    const sumCopilot = rawData.reduce((acc, r) => acc + r.copilotSessions, 0);

    console.log(`📊 Totales Analytics → Voice: ${sumVoice.toFixed(2)} min, Digital: ${sumDigital}, WA: ${sumWa}, Copilot convs: ${sumCopilot}`);

    // Si tenemos los totales facturados reales, prorratear. Si no, usar estimaciones con reglas fijas.
    const useBilledData = billedVoice > 0 || billedDigital > 0 || billedWa > 0 || billedCopilot > 0;

    const responseData = rawData.map(d => {
      let estimatedVoiceTokens, estimatedDigitalTokens, estimatedWhatsappTokens, estimatedCopilotTokens;

      if (useBilledData) {
        // PRORRATEO PROPORCIONAL:
        // Tokens División = (Volumen División / Volumen Total Org) × Tokens Facturados
        estimatedVoiceTokens = sumVoice > 0 ? Math.round((d.botVoiceMin / sumVoice) * billedVoice) : 0;
        estimatedDigitalTokens = sumDigital > 0 ? Math.round((d.botDigitalSessions / sumDigital) * billedDigital) : 0;
        estimatedWhatsappTokens = sumWa > 0 ? Math.round((d.whatsappSessions / sumWa) * billedWa) : 0;
        estimatedCopilotTokens = sumCopilot > 0 ? Math.round((d.copilotSessions / sumCopilot) * billedCopilot) : 0;
      } else {
        // FALLBACK con reglas fijas de Genesys si no hay totales de facturación
        estimatedVoiceTokens = Math.ceil(d.botVoiceMin / 17);
        estimatedDigitalTokens = Math.ceil(d.botDigitalSessions / 51);
        estimatedWhatsappTokens = d.whatsappSessions; // 1 a 1
        estimatedCopilotTokens = 0;
      }

      return {
        ...d,
        estimatedVoiceTokens,
        estimatedDigitalTokens,
        estimatedWhatsappTokens,
        estimatedCopilotTokens,
        estimatedTotalTokens: estimatedVoiceTokens + estimatedDigitalTokens + estimatedWhatsappTokens + estimatedCopilotTokens
      };
    });

    // Sort by estimatedTotalTokens descending
    responseData.sort((a, b) => b.estimatedTotalTokens - a.estimatedTotalTokens);

    return res.status(200).json({ success: true, data: responseData });

  } catch (error) {
    console.error("Error en ia-tokens-details:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint: Auditoría diaria de Bot Flow Voice (granularity P1D)
// Retorna los minutos de bot de voz por día para el período indicado.
// Utiliza la misma query que ia-tokens-details pero con granularity "P1D"
// para obtener el desglose día a día en lugar de un acumulado del mes.
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/reports/ia-tokens-daily", async (req, res) => {
  try {
    const { startDate, endDate, timezone, region } = req.query;
    const accessToken =
      req.query.accessToken ||
      (req.headers.authorization && req.headers.authorization.split(" ")[1]);

    if (!accessToken || !startDate || !endDate || !region) {
      return res.status(400).json({
        success: false,
        error: "Se requieren startDate, endDate, accessToken y region",
      });
    }

    const url = getRegionUrl(region);

    // ── Timezone offset ───────────────────────────────────────────────────
    let offsetStart = "Z";
    let offsetEnd = "Z";
    if (timezone) {
      try {
        const fmtStart = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" });
        const tzStart = fmtStart.formatToParts(new Date(`${startDate}T12:00:00Z`)).find((p) => p.type === "timeZoneName").value;
        offsetStart = tzStart.replace("GMT", "") || "Z";

        const fmtEnd = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" });
        const tzEnd = fmtEnd.formatToParts(new Date(`${endDate}T12:00:00Z`)).find((p) => p.type === "timeZoneName").value;
        offsetEnd = tzEnd.replace("GMT", "") || "Z";
      } catch (e) {
        console.error("Error al calcular timezone offset:", e);
      }
    }

    const interval = `${startDate}T00:00:00.000${offsetStart}/${endDate}T23:59:59.999${offsetEnd}`;

    console.log(`📅 [ia-tokens-daily] interval=${interval}  region=${region}`);

    // ── Build day skeleton (every day in range → 0 minutes) ──────────────
    const dailyMap = {};
    const startD = new Date(`${startDate}T12:00:00Z`);
    const endD = new Date(`${endDate}T12:00:00Z`);
    for (let d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
      dailyMap[d.toISOString().split("T")[0]] = 0;
    }

    // ── Query Genesys: Bot Flows with P1D granularity ─────────────────────
    const payload = {
      interval: interval,
      granularity: "P1D",               // ← key change vs ia-tokens-details
      groupBy: ["mediaType"],            // we only care about voice total, not per division
      metrics: ["tFlow"],
      filter: {
        type: "or",
        predicates: [
          { type: "dimension", dimension: "flowType", operator: "matches", value: "bot" },
          { type: "dimension", dimension: "flowType", operator: "matches", value: "digitalbot" },
        ],
      },
    };

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    };

    const resFlows = await fetch(`${url}/api/v2/analytics/flows/aggregates/query`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!resFlows.ok) {
      const errBody = await resFlows.text();
      console.error("[ia-tokens-daily] Genesys API error:", errBody);
      return res.status(502).json({ success: false, error: "Error consultando Genesys Analytics" });
    }

    const dataFlows = await resFlows.json();

    // ── Aggregate tFlow (ms) per day → convert to minutes ────────────────
    if (dataFlows.results) {
      dataFlows.results.forEach((group) => {
        const mediaType = group.group?.mediaType || "";
        // Only count voice flows
        if (mediaType !== "voice") return;

        if (group.data && Array.isArray(group.data)) {
          group.data.forEach((daySlot) => {
            // daySlot.interval looks like "2026-06-01T06:00:00.000Z/2026-06-02T06:00:00.000Z"
            const rawDatePart = daySlot.interval ? daySlot.interval.split("/")[0] : null;
            if (!rawDatePart) return;

            // Normalize to date key in local timezone if needed
            // We use the UTC date of the interval start as the key
            const dateKey = rawDatePart.split("T")[0];

            if (daySlot.metrics && Array.isArray(daySlot.metrics)) {
              daySlot.metrics.forEach((m) => {
                if (m.metric === "tFlow" && m.stats?.sum) {
                  const minutes = m.stats.sum / 60000; // ms → minutes
                  if (dailyMap[dateKey] !== undefined) {
                    dailyMap[dateKey] += minutes;
                  } else {
                    // Date might fall in timezone-shifted day: try adjacent keys
                    dailyMap[dateKey] = (dailyMap[dateKey] || 0) + minutes;
                  }
                }
              });
            }
          });
        }
      });
    }

    // ── Build response array sorted by date ascending ─────────────────────
    const data = Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, botVoiceMin]) => ({ date, botVoiceMin }));

    console.log(`✅ [ia-tokens-daily] ${data.length} días, total=${data.reduce((s, r) => s + r.botVoiceMin, 0).toFixed(2)} min`);

    return res.status(200).json({ success: true, period: { start: startDate, end: endDate }, data });

  } catch (error) {
    console.error("Error en ia-tokens-daily:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint para analizar métricas con IA (usando Groq API y API Key del Servidor)
app.post("/api/analyze-metrics", async (req, res) => {
  try {
    const { clientData, dailyLogins, outboundAttempts, overageDetailsText, lang, languageName } = req.body;

    const groqApiKey = process.env.GROQ_API_KEY;

    if (!groqApiKey) {
      return res.status(500).json({
        success: false,
        error: "GROQ_API_KEY no está configurado en el servidor."
      });
    }

    // El idioma se resuelve en el backend, no se toma tal cual del cliente:
    // antes llegaba una cadena libre y bastaba una clave de traducción sin
    // traducir para que el modelo recibiera un idioma inexistente y respondiera
    // en cualquier lengua. `promptsFor`/`languageRule` sanean el valor y caen a
    // español ante cualquier cosa que no reconozcan.
    const idiomaAnalisis = lang || languageName;
    const p = promptsFor(idiomaAnalisis);

    const systemPrompt = `Eres un experto analista de métricas de Genesys Cloud CX. Analiza los datos proporcionados y genera un resumen ejecutivo con insights clave, estado de KPIs, y recomendaciones específicas.

${languageRule(idiomaAnalisis)}

REGLAS DE FORMATO OBLIGATORIAS:
1. No uses negritas (**texto**) en ningún lugar, ni en los títulos ni en el cuerpo del texto del análisis.
2. Para las listas y puntos, utiliza "1.- " para números o "- " para viñetas, nunca uses "*".
3. En la sección de Recomendaciones, debes sugerir explícitamente que a través de la opción de "Último Login" (en Conexiones Diarias) el administrador puede detectar usuarios inactivos que no han iniciado sesión en los últimos meses. Recomienda desactivar estas cuentas en la organización de Genesys Cloud para evitar que por algún motivo inicien sesión por error y consuman licencias innecesarias de la organización.
4. Si se proporciona información de sobreuso de licencias, analízala indicando en qué licencias se excedió el compromiso y en cuánto, y qué implica ese exceso.
5. Los datos que recibes son agregados y NO incluyen identidades de agentes. No inventes ni menciones nombres, correos, divisiones ni fechas de inicio de sesión de personas concretas: si el análisis requiere ese detalle, remite al reporte de "Último Login" del panel.`;

    // Los encabezados van ya en el idioma de salida: si se piden en español, el
    // modelo los copia literalmente y devuelve títulos en español dentro de un
    // análisis en otro idioma.
    const userPrompt = `${p.metricsIntro}
${numbered(p.metricsSections)}

${p.metricsLicenses}
${JSON.stringify(clientData, null, 2)}

${p.metricsLogins}
${JSON.stringify(dailyLogins, null, 2)}

${p.metricsOutbound}
${JSON.stringify(outboundAttempts, null, 2)}

${p.metricsOverage}
${overageDetailsText || p.metricsNoOverage}`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqApiKey}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: 2000
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Groq API error: ${response.status} - ${errText}`);
    }

    const data = await response.json();
    // Si el modelo no devuelve nada se responde con un código, no con un texto:
    // el mensaje que ve el usuario lo pone el front en SU idioma. Antes se
    // devolvía "No se pudo obtener respuesta" en español y se pintaba tal cual
    // como si fuera el análisis, incluso para usuarios en inglés o portugués.
    const aiText = data.choices[0]?.message?.content;
    if (!aiText) {
      return res.status(502).json({ success: false, code: "EMPTY_AI_RESPONSE" });
    }

    return res.status(200).json({
      success: true,
      analysis: aiText
    });

  } catch (error) {
    console.error("Error en analyze-metrics:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint para analizar comparativa entre periodos con IA
app.post("/api/analyze-comparison", async (req, res) => {
  try {
    const { kpiData, selectedCategories, kpiName, lang, languageName } = req.body;

    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey) {
      return res.status(500).json({
        success: false,
        error: "GROQ_API_KEY no está configurado en el servidor."
      });
    }

    const idiomaAnalisis = lang || languageName;
    const p = promptsFor(idiomaAnalisis);

    const systemPrompt = `Eres un experto analista de métricas de Genesys Cloud CX especializado en análisis comparativo entre periodos de facturación. Analiza los datos proporcionados y genera un análisis detallado.

${languageRule(idiomaAnalisis)}

REGLAS DE FORMATO OBLIGATORIAS:
1. No uses negritas (**texto**) en ningún lugar.
2. Para listas usa "1.- " para números o "- " para viñetas.
3. Estructura tu respuesta en secciones claras.

Para cada KPI analizado, debes:
1. Comparar los valores entre periodos (incremento/decremento porcentual)
2. Identificar tendencias (creciente, decreciente, estable)
3. Proporcionar contexto sobre si los cambios son normales o requieren atención
4. Dar recomendaciones específicas basadas en las tendencias observadas`;

    const userPrompt = `${p.comparisonIntro}

${p.comparisonCategories} ${(selectedCategories || []).join(", ")}

${p.comparisonData}
${JSON.stringify(kpiData, null, 2)}

${kpiName ? p.comparisonFocus.replace("{{kpi}}", kpiName) : p.comparisonGeneral}

${p.comparisonEach}
${p.comparisonSections.map((s) => `- ${s}`).join("\n")}`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqApiKey}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: 2000
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Groq API error: ${response.status} - ${errText}`);
    }

    const data = await response.json();
    // Si el modelo no devuelve nada se responde con un código, no con un texto:
    // el mensaje que ve el usuario lo pone el front en SU idioma. Antes se
    // devolvía "No se pudo obtener respuesta" en español y se pintaba tal cual
    // como si fuera el análisis, incluso para usuarios en inglés o portugués.
    const aiText = data.choices[0]?.message?.content;
    if (!aiText) {
      return res.status(502).json({ success: false, code: "EMPTY_AI_RESPONSE" });
    }

    return res.status(200).json({
      success: true,
      analysis: aiText
    });

  } catch (error) {
    console.error("Error en analyze-comparison:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint: Intentos Outbound y métricas de campañas
app.get("/api/reports/outbound-attempts", async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { startDate, endDate, timezone, region } = req.query;
    const accessToken =
      req.query.accessToken ||
      (req.headers.authorization && req.headers.authorization.split(" ")[1]);

    if (!accessToken || !startDate || !endDate || !region) {
      return res.status(400).json({
        success: false,
        error: "Se requieren startDate, endDate, accessToken y region",
      });
    }

    const url = getRegionUrl(region);

    let offsetStart = "Z";
    let offsetEnd = "Z";
    if (timezone) {
      try {
        const formatterStart = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" });
        const tzStrStart = formatterStart.formatToParts(new Date(`${startDate}T12:00:00Z`)).find((p) => p.type === "timeZoneName").value;
        offsetStart = tzStrStart.replace("GMT", "");
        if (offsetStart === "") offsetStart = "Z";

        const formatterEnd = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" });
        const tzStrEnd = formatterEnd.formatToParts(new Date(`${endDate}T12:00:00Z`)).find((p) => p.type === "timeZoneName").value;
        offsetEnd = tzStrEnd.replace("GMT", "");
        if (offsetEnd === "") offsetEnd = "Z";
      } catch (e) {
        console.error("Error al calcular timezone offset", e);
      }
    }

    const interval = `${startDate}T00:00:00.000${offsetStart}/${endDate}T23:59:59.999${offsetEnd}`;

    const payload = {
      interval: interval,
      groupBy: ["outboundCampaignId"],
      metrics: ["nOutboundAttempted"],
      filter: {
        type: "and",
        predicates: [
          {
            type: "dimension",
            dimension: "direction",
            operator: "matches",
            value: "outbound"
          }
        ]
      }
    };

    const response = await fetch(`${url}/api/v2/analytics/conversations/aggregates/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Genesys API error: ${response.status} - ${errText}`);
    }

    const genesysResponse = await response.json();
    let totalAttempts = 0;
    const campaigns = [];

    if (genesysResponse.results) {
      // Collect campaigns and count total
      for (const result of genesysResponse.results) {
        const campaignId = result.group?.outboundCampaignId;
        if (!campaignId) continue;

        let count = 0;
        if (result.data && result.data[0] && result.data[0].metrics) {
          const metricObj = result.data[0].metrics.find(m => m.metric === "nOutboundAttempted");
          if (metricObj && metricObj.stats) {
            count = metricObj.stats.count || 0;
          }
        }

        totalAttempts += count;
        campaigns.push({
          id: campaignId,
          name: campaignId, // fallback to ID
          attempts: count
        });
      }

      // Try to fetch campaign names in parallel
      try {
        await Promise.all(campaigns.map(async (camp) => {
          try {
            const campRes = await fetch(`${url}/api/v2/outbound/campaigns/${camp.id}`, {
              method: "GET",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${accessToken}`,
              }
            });
            if (campRes.ok) {
              const campData = await campRes.json();
              if (campData && campData.name) {
                camp.name = campData.name;
              }
            }
          } catch (err) {
            console.error(`Error fetching name for campaign ${camp.id}:`, err);
          }
        }));
      } catch (err) {
        console.error("Error batch fetching campaign names:", err);
      }
    }

    // Sort campaigns by attempts descending
    campaigns.sort((a, b) => b.attempts - a.attempts);

    return res.status(200).json({
      success: true,
      period: { start: startDate, end: endDate },
      totalAttempts,
      campaigns
    });

  } catch (error) {
    console.error("Error en outbound-attempts:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint: Reporte de último login de todos los usuarios
app.get("/api/reports/last-login", async (req, res) => {
  try {
    const { accessToken, region } = req.query;

    if (!accessToken || !region) {
      return res.status(400).json({
        success: false,
        error: "Se requieren accessToken y region",
      });
    }

    const allUsers = await getAllUsersCached(accessToken, region);

    // Mapear al formato de reporte
    const users = allUsers.map((u) => ({
      id: u.id,
      name: u.name || `${u.firstName || ""} ${u.lastName || ""}`.trim(),
      email: u.email || "",
      department: u.department || "",
      division: u.division?.name || "",
      lastLogin: u.dateLastLogin,
      state: u.state || "active",
    }));

    // Ordenar: usuarios con lastLogin primero (más reciente arriba), luego los sin login
    users.sort((a, b) => {
      if (!a.lastLogin && !b.lastLogin) return 0;
      if (!a.lastLogin) return 1;
      if (!b.lastLogin) return -1;
      return new Date(b.lastLogin).getTime() - new Date(a.lastLogin).getTime();
    });

    return res.status(200).json({
      success: true,
      totalUsers: users.length,
      users,
    });
  } catch (error) {
    console.error("Error en last-login report:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint para manejar la creación, actualización y obtención de usuarios
app.get("/api/setuser", async (req, res) => {
  try {
    const { username, orgname } = req.query;
    const isAdmin = req.auth?.role === "administrator";

    // Si consultan uno específico: administrador, o el propio usuario.
    if (username && orgname) {
      const cleanUsername = username.trim();
      if (!isAdmin && req.auth?.sub !== cleanUsername) {
        return res.status(403).json({
          success: false,
          message: "Sólo puedes consultar tu propio perfil.",
        });
      }
      const userDoc = await db.collection("users").doc(cleanUsername).get();
      if (!userDoc.exists) {
        return res.status(404).json({ message: "Usuario no encontrado." });
      }
      return res.status(200).json(sanitizeUser(userDoc.data()));
    }

    // El listado completo (todas las organizaciones y usuarios) es sólo para
    // administradores: es el que expone la nómina entera de clientes.
    if (!isAdmin) {
      console.warn(
        `⛔ [Auth] "${req.auth?.sub}" (${req.auth?.role}) intentó listar todos los usuarios`,
      );
      return res.status(403).json({
        success: false,
        message: "No tienes permisos para listar usuarios.",
      });
    }

    // Lista todos los usuarios mapeados en formato de organizaciones (como lo hacía DynamoDB)
    const orgsSnapshot = await db.collection("organizations").get();
    const usersSnapshot = await db.collection("users").get();

    // sanitizeOrg quita clientId/clientSecret: este endpoint devolvía las
    // credenciales OAuth de Genesys de TODAS las organizaciones. Se conserva
    // `hasCredentials` para que la UI pueda indicar si están configuradas.
    let orgsList = orgsSnapshot.docs.map((doc) =>
      sanitizeOrg({ ...doc.data(), orgId: doc.id, users: [] }),
    );
    let usersList = usersSnapshot.docs.map((doc) => doc.data());

    // Mapear usuarios dentro de sus organizaciones correspondientes
    usersList.forEach((u) => {
      let org = orgsList.find(
        (o) => o.orgname === u.orgname || o.orgId === u.orgId,
      );
      if (!org) {
        // Si la organización no fue insertada independientemente, la creamos en memoria para responder
        org = {
          orgname: u.orgname,
          orgId: u.orgId || u.orgname || "unknown",
          region: u.region || "us-east-1",
          thrusted: u.thrusted || "N/A",
          criticalMetrics: [],
          active: true,
          hasCredentials: false,
          users: [],
        };
        orgsList.push(org);
      }
      // Agregamos el usuario con el formato que espera el frontend / settings,
      // sin passwordHash ni credenciales.
      org.users.push({
        username: u.username,
        user: sanitizeUser(u),
      });
    });

    return res.status(200).json(orgsList);
  } catch (error) {
    console.error("❌ Error en GET /api/setuser:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Crear o actualizar usuarios.
//
// No lleva `requireAdmin` global: cualquier usuario debe poder guardar SUS
// propias preferencias de notificación desde /settings. La autorización es por
// fila — administrador para todo, el resto sólo sobre sí mismo y con una lista
// blanca de campos, para que nadie pueda ascenderse a administrador.
app.post("/api/setuser", async (req, res) => {
  try {
    const body = req.body;
    const { orgname, user: userData, mode } = body;
    const userToCreate = userData?.user;

    if (!orgname || !userToCreate?.username) {
      return res.status(400).json({
        success: false,
        message: "orgname y detalles de usuario son requeridos",
      });
    }

    const cleanUsername = userToCreate.username.trim();
    const isAdmin = req.auth?.role === "administrator";
    const isSelf = req.auth?.sub === cleanUsername;

    if (!isAdmin && !isSelf) {
      console.warn(
        `⛔ [Auth] "${req.auth?.sub}" (${req.auth?.role}) intentó modificar a "${cleanUsername}"`,
      );
      return res.status(403).json({
        success: false,
        message: "Sólo puedes modificar tu propio perfil.",
      });
    }

    const userRef = db.collection("users").doc(cleanUsername);
    const userDoc = await userRef.get();

    if (!isAdmin && (mode !== "update" || !userDoc.exists)) {
      return res.status(403).json({
        success: false,
        message: "No tienes permisos para crear usuarios.",
      });
    }

    const orgId = body.orgId || userToCreate.orgId || orgname;
    const orgRef = db.collection("organizations").doc(orgId);
    const orgDoc = await orgRef.get();

    // Validar si el usuario NO existe y no estamos en modo actualización
    if (!userDoc.exists && mode !== "update") {
      if (!userData.password) {
        return res.status(400).json({
          success: false,
          message: "La contraseña es requerida para la creación de usuario.",
        });
      }
      const passwordHash = await bcrypt.hash(userData.password, 10);

      // Creamos/Actualizamos la Organización si no existe o si se proporcionan credenciales explícitas
      if (!orgDoc.exists || (body.clientId && body.clientSecret)) {
        await orgRef.set(
          {
            orgId: orgId,
            orgname: orgname,
            thrusted: body.thrusted || userToCreate.thrusted || "N/A",
            region: body.region || userToCreate.region || "us-east-1",
            clientId: body.clientId || userToCreate.clientId || "",
            clientSecret: body.clientSecret || userToCreate.clientSecret || "",
            criticalMetrics: orgDoc.exists ? orgDoc.data().criticalMetrics || [] : [],
            // Preservar el estado 'active' existente; por defecto activa.
            active: orgDoc.exists ? orgDoc.data().active ?? true : true,
          },
          { merge: true },
        );
      }

      // Creamos el Usuario
      const firestoreUser = {
        username: cleanUsername,
        passwordHash: passwordHash,
        role: userToCreate.role || "client",
        thrusted: userToCreate.thrusted || body.thrusted || "N/A",
        orgname: orgname,
        orgId: orgId,
        clientId: userToCreate.clientId || body.clientId || (orgDoc.exists ? orgDoc.data().clientId : "") || "",
        clientSecret: userToCreate.clientSecret || body.clientSecret || (orgDoc.exists ? orgDoc.data().clientSecret : "") || "",
        region: userToCreate.region || body.region || (orgDoc.exists ? orgDoc.data().region : "us-east-1") || "us-east-1",
        // El idioma se elige al crear el usuario y decide en qué idioma se le
        // renderizan la interfaz y las plantillas de correo. Sin selección,
        // español.
        preferences: withNormalizedLanguage(userToCreate.preferences),
        // Los usuarios nuevos se crean activos por defecto.
        active: true,
      };
      await userRef.set(firestoreUser);
      forgetRecipient(cleanUsername);

      logEvent({
        type: EVENT.USER_CREATED,
        req,
        target: cleanUsername,
        orgname,
        orgId,
        message: `Usuario "${cleanUsername}" creado.`,
        detail: {
          rol: firestoreUser.role,
          idioma: firestoreUser.preferences.language,
        },
      });

      return res.status(201).json({
        success: true,
        message: `Usuario ${cleanUsername} creado exitosamente.`,
      });
    } else {
      let updates;

      if (isAdmin) {
        // Update de administrador: se guardan los campos seguros del usuario.
        // orgId, orgToken, region y criticalMetrics se gestionan a nivel de
        // organización y NO deben sobreescribirse desde el perfil del usuario.
        const {
          orgId: _orgId,
          orgToken: _orgToken,
          region: _region,
          criticalMetrics: _criticalMetrics,
          password: _password,
          ...safeUserFields
        } = userToCreate;

        updates = { ...safeUserFields, orgname };
        if (safeUserFields.preferences && typeof safeUserFields.preferences === "object") {
          updates.preferences = withNormalizedLanguage(safeUserFields.preferences);
        }
        if (orgId) {
          updates.orgId = orgId;
        }
      } else {
        // Autoedición: lista blanca estricta. El front manda el objeto de
        // usuario completo desde sessionStorage, que incluye `role`, `active`
        // y `orgname`; copiarlo tal cual permitiría ascenderse a administrador
        // o reactivarse tras ser dado de baja.
        updates = {};
        if (userToCreate.preferences && typeof userToCreate.preferences === "object") {
          updates.preferences = withNormalizedLanguage(userToCreate.preferences);
        }
      }

      // Nueva contraseña. Se acepta tanto dentro de `user` como en la raíz del
      // cuerpo: el cambio de contraseña del perfil la envía en la raíz.
      const newPassword = userData.password || body.password;
      if (newPassword && String(newPassword).trim() !== "") {
        updates.passwordHash = await bcrypt.hash(String(newPassword), 10);
      }

      if (Object.keys(updates).length === 0) {
        return res
          .status(400)
          .json({ success: false, message: "No hay cambios que guardar." });
      }

      await userRef.set(updates, { merge: true });
      // La caché de idiomas quedaría sirviendo el anterior hasta que expire.
      forgetRecipient(cleanUsername);

      logEvent({
        type: EVENT.USER_UPDATED,
        req,
        target: cleanUsername,
        orgname,
        orgId,
        message: isSelf
          ? "Actualización del propio perfil."
          : `El administrador actualizó a "${cleanUsername}".`,
        detail: {
          // Nunca el valor, sólo qué se tocó: el hash de la contraseña no debe
          // acabar en un log que se muestra en pantalla.
          campos: Object.keys(updates)
            .map((k) => (k === "passwordHash" ? "contraseña" : k))
            .join(", "),
          idioma: updates.preferences?.language || null,
        },
      });

      return res
        .status(200)
        .json({ success: true, message: "Usuario actualizado exitosamente" });
    }
  } catch (error) {
    console.error("❌ Error en POST /api/setuser:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno del servidor",
      detail: error.message,
    });
  }
});

app.post("/api/organization", requireAdmin, async (req, res) => {
  try {
    const body = req.body;
    const { orgId, orgname, thrusted, region, clientId, clientSecret, active } =
      body;

    if (!orgId || !orgname) {
      return res.status(400).json({
        success: false,
        message: "orgId y orgname son requeridos",
      });
    }

    const cleanOrgId = orgId.trim();
    const orgRef = db.collection("organizations").doc(cleanOrgId);
    const orgDoc = await orgRef.get();

    // Determinar el estado 'active': si viene explícito en el body se usa,
    // si no, se preserva el existente y por defecto la org queda activa.
    const resolvedActive =
      typeof active === "boolean"
        ? active
        : orgDoc.exists
          ? orgDoc.data().active ?? true
          : true;

    await orgRef.set(
      {
        orgId: cleanOrgId,
        orgname: orgname.trim(),
        thrusted: thrusted || "N/A",
        region: region || "us-east-1",
        clientId: clientId || "",
        clientSecret: clientSecret || "",
        criticalMetrics: orgDoc.exists ? orgDoc.data().criticalMetrics || [] : [],
        active: resolvedActive,
      },
      { merge: true },
    );

    logEvent({
      type: orgDoc.exists ? EVENT.ORG_UPDATED : EVENT.ORG_CREATED,
      req,
      target: cleanOrgId,
      orgname: orgname.trim(),
      orgId: cleanOrgId,
      message: `Organización "${orgname.trim()}" ${orgDoc.exists ? "actualizada" : "creada"}.`,
      detail: { region: region || "us-east-1", thrusted: thrusted || "N/A", active: resolvedActive },
    });

    return res.status(200).json({
      success: true,
      message: `Organización ${orgname} guardada exitosamente.`,
    });
  } catch (error) {
    console.error("❌ Error en POST /api/organization:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno del servidor",
      detail: error.message,
    });
  }
});

// Activar / Desactivar una organización.
// Cuando active === false, los usuarios no administradores no podrán iniciar
// sesión en esa organización (ver /api/login).
app.post("/api/organization/status", requireAdmin, async (req, res) => {
  try {
    const { orgId, active } = req.body;

    if (!orgId || typeof active !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "orgId y active (boolean) son requeridos.",
      });
    }

    const orgRef = db.collection("organizations").doc(orgId.trim());
    const orgDoc = await orgRef.get();

    if (!orgDoc.exists) {
      return res
        .status(404)
        .json({ success: false, message: "Organización no encontrada." });
    }

    await orgRef.set({ active }, { merge: true });

    console.log(
      `🔁 [Org ${active ? "activada" : "desactivada"}] orgId="${orgId}"`,
    );

    logEvent({
      type: EVENT.ORG_STATUS_CHANGED,
      req,
      target: orgId.trim(),
      orgname: orgDoc.data().orgname || null,
      orgId: orgId.trim(),
      message: `Organización ${active ? "activada" : "desactivada"}.`,
      detail: { active },
    });

    return res.status(200).json({
      success: true,
      active,
      message: `Organización ${active ? "activada" : "desactivada"} exitosamente.`,
    });
  } catch (error) {
    console.error("❌ Error en POST /api/organization/status:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno del servidor",
      detail: error.message,
    });
  }
});

// Activar / Desactivar un usuario.
// Cuando active === false, el usuario no podrá iniciar sesión (ver /api/login).
app.post("/api/user/status", requireAdmin, async (req, res) => {
  try {
    const { username, active } = req.body;

    if (!username || typeof active !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "username y active (boolean) son requeridos.",
      });
    }

    const userRef = db.collection("users").doc(username.trim());
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res
        .status(404)
        .json({ success: false, message: "Usuario no encontrado." });
    }

    await userRef.set({ active }, { merge: true });

    console.log(
      `🔁 [Usuario ${active ? "activado" : "desactivado"}] username="${username}"`,
    );

    logEvent({
      type: EVENT.USER_STATUS_CHANGED,
      req,
      target: username.trim(),
      orgname: userDoc.data().orgname || null,
      orgId: userDoc.data().orgId || null,
      message: `Usuario ${active ? "activado" : "desactivado"}.`,
      detail: { active },
    });

    return res.status(200).json({
      success: true,
      active,
      message: `Usuario ${active ? "activado" : "desactivado"} exitosamente.`,
    });
  } catch (error) {
    console.error("❌ Error en POST /api/user/status:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno del servidor",
      detail: error.message,
    });
  }
});

// ==================== Logs de conexión y acceso (admin) ====================
// Los registros los escribe utils/auditLog.js desde el login, el middleware de
// sesión y cada acción sensible. Aquí sólo se consultan.

app.get("/api/logs", requireAdmin, async (req, res) => {
  try {
    const { from, to, type, category, username, orgname, success, limit, cursor } =
      req.query;

    const parseTimestamp = (value, endOfDay = false) => {
      if (!value) return null;
      // Se aceptan epoch en milisegundos y fechas ISO ("2026-08-12").
      if (/^\d+$/.test(String(value))) return Number(value);
      const date = new Date(String(value));
      if (Number.isNaN(date.getTime())) return null;
      if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
        date.setUTCHours(23, 59, 59, 999);
      }
      return date.getTime();
    };

    const result = await queryLogs({
      from: parseTimestamp(from),
      to: parseTimestamp(to, true),
      type: type || null,
      category: category || null,
      username: username || null,
      orgname: orgname || null,
      success: success === undefined || success === "" ? null : success === "true",
      limit: limit,
      cursor: cursor || null,
    });

    return res.status(200).json({
      success: true,
      items: result.items,
      nextCursor: result.nextCursor,
      retentionDays: LOG_RETENTION_DAYS,
    });
  } catch (error) {
    console.error("❌ Error en GET /api/logs:", error);
    return res.status(500).json({
      success: false,
      message: "No se pudieron consultar los registros.",
      detail: error.message,
    });
  }
});

// Purga manual de registros antiguos. El cron diario ya la ejecuta sola.
app.post("/api/logs/purge", requireAdmin, async (req, res) => {
  try {
    const days = Number(req.body?.retentionDays) || LOG_RETENTION_DAYS;
    const result = await purgeOldLogs(days);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error("❌ Error en POST /api/logs/purge:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== Configuración de correo (admin) ====================
// El remitente ya no está hardcodeado: se guarda en Firestore (settings/email)
// y se edita desde /settings del administrador.

app.get("/api/settings/email", requireAdmin, async (req, res) => {
  try {
    const settings = await getEmailSettings({ force: true });
    return res.status(200).json({ success: true, settings });
  } catch (error) {
    console.error("❌ Error en GET /api/settings/email:", error);
    return res
      .status(500)
      .json({ success: false, message: "Error interno del servidor", detail: error.message });
  }
});

app.post("/api/settings/email", requireAdmin, async (req, res) => {
  try {
    const { fromName, fromEmail, replyTo, supportEmail, enabled } = req.body;

    if (fromEmail === undefined && fromName === undefined && enabled === undefined) {
      return res.status(400).json({
        success: false,
        message: "Debe enviar al menos fromName, fromEmail o enabled.",
      });
    }

    const settings = await saveEmailSettings({
      fromName,
      fromEmail,
      replyTo,
      supportEmail,
      enabled,
    });

    console.log(`💾 [Settings] Remitente de correo actualizado: ${settings.from}`);
    logEvent({
      type: EVENT.EMAIL_SETTINGS_UPDATED,
      req,
      target: "settings/email",
      message: "Configuración de correo actualizada.",
      detail: { remitente: settings.from, habilitado: settings.enabled },
    });
    return res.status(200).json({
      success: true,
      message: "Configuración de correo guardada exitosamente.",
      settings,
    });
  } catch (error) {
    console.error("❌ Error en POST /api/settings/email:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
});

// Límite simple en memoria para el correo de prueba: es un primitivo de
// "enviar correo a una dirección arbitraria" y sin tope sirve para mail-bombing.
const emailTestAttempts = [];
const EMAIL_TEST_WINDOW_MS = 10 * 60 * 1000;
const EMAIL_TEST_MAX = 5;

// Envía un correo de prueba con el remitente configurado, para validar las
// credenciales SMTP antes de dejarlo en producción.
app.post("/api/settings/email/test", requireAdmin, async (req, res) => {
  try {
    const { to } = req.body;
    if (!to) {
      return res
        .status(400)
        .json({ success: false, message: "Se requiere el destinatario 'to'." });
    }

    const ahora = Date.now();
    while (emailTestAttempts.length > 0 && ahora - emailTestAttempts[0] > EMAIL_TEST_WINDOW_MS) {
      emailTestAttempts.shift();
    }
    if (emailTestAttempts.length >= EMAIL_TEST_MAX) {
      return res.status(429).json({
        success: false,
        message: `Demasiados correos de prueba. Máximo ${EMAIL_TEST_MAX} cada 10 minutos.`,
      });
    }
    emailTestAttempts.push(ahora);

    const settings = await getEmailSettings({ force: true });
    const result = await sendMail({
      from: settings.from,
      to,
      subject: "✅ Prueba de remitente - License Manager",
      html: `<p>Este es un correo de prueba enviado desde <strong>${settings.from}</strong>.</p>
             <p>Si lo recibiste, la configuración SMTP es correcta.</p>`,
      text: `Correo de prueba enviado desde ${settings.from}. Si lo recibiste, la configuración SMTP es correcta.`,
      replyTo: settings.replyTo,
    });

    return res.status(200).json({
      success: true,
      message: `Correo de prueba enviado desde ${settings.from}.`,
      id: result.id,
      rechazados: result.rejected,
    });
  } catch (error) {
    console.error("❌ Error en POST /api/settings/email/test:", error.message);
    return res.status(502).json({
      success: false,
      message: `No se pudo enviar por SMTP: ${error.message}`,
    });
  }
});

// Verifica credenciales y conectividad SMTP sin enviar ningún correo.
app.get("/api/settings/email/verify", requireAdmin, async (req, res) => {
  const cfg = smtpConfig();
  try {
    await verifyTransport();
    return res.status(200).json({
      success: true,
      message: `Conexión SMTP correcta con ${cfg.host}:${cfg.port}.`,
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      user: cfg.user,
    });
  } catch (error) {
    console.error("❌ [SMTP] Verificación fallida:", error.message);
    return res.status(502).json({
      success: false,
      message: `No se pudo conectar a ${cfg.host}:${cfg.port}: ${error.message}`,
    });
  }
});

// ==================== Integraciones (config admin) ====================
// Se almacenan en la colección Firestore 'integrations'; cada documento es
// una integración (por ejemplo 'whaibot', 'sms').

// Obtener la configuración de todas las integraciones.
app.get("/api/integrations", requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection("integrations").get();
    const integrations = {};
    snapshot.docs.forEach((doc) => {
      integrations[doc.id] = doc.data();
    });
    return res.status(200).json({ success: true, integrations });
  } catch (error) {
    console.error("❌ Error en GET /api/integrations:", error);
    return res
      .status(500)
      .json({ success: false, message: "Error interno del servidor", detail: error.message });
  }
});

// Guardar / actualizar la configuración de WhaiBot (botId + apiKey/clientKey).
app.post("/api/integrations/whaibot", requireAdmin, async (req, res) => {
  try {
    const { botId, apiKey, enabled } = req.body;

    if (!botId || !apiKey) {
      return res.status(400).json({
        success: false,
        message: "botId y apiKey son requeridos.",
      });
    }

    await db
      .collection("integrations")
      .doc("whaibot")
      .set(
        {
          botId: String(botId).trim(),
          apiKey: String(apiKey).trim(),
          enabled: typeof enabled === "boolean" ? enabled : true,
          updatedAt: Date.now(),
        },
        { merge: true },
      );

    console.log("💾 [Integración WhaiBot] configuración guardada");
    // El apiKey no viaja al log: sanitizeDetail lo descartaría igualmente.
    logEvent({
      type: EVENT.INTEGRATION_UPDATED,
      req,
      target: "whaibot",
      message: "Configuración de la integración WhaiBot actualizada.",
      detail: { botId: String(botId).trim(), habilitado: typeof enabled === "boolean" ? enabled : true },
    });
    return res.status(200).json({
      success: true,
      message: "Configuración de WhaiBot guardada exitosamente.",
    });
  } catch (error) {
    console.error("❌ Error en POST /api/integrations/whaibot:", error);
    return res
      .status(500)
      .json({ success: false, message: "Error interno del servidor", detail: error.message });
  }
});

// Probar la conexión con WhaiBot mediante su health check.
// Acepta botId/apiKey en el body (para probar antes de guardar); si no vienen,
// usa los valores previamente guardados.
app.post("/api/integrations/whaibot/test", requireAdmin, async (req, res) => {
  try {
    let { botId, apiKey } = req.body;

    if (!botId || !apiKey) {
      const doc = await db.collection("integrations").doc("whaibot").get();
      if (doc.exists) {
        botId = botId || doc.data().botId;
        apiKey = apiKey || doc.data().apiKey;
      }
    }

    if (!botId || !apiKey) {
      return res.status(400).json({
        success: false,
        message: "botId y apiKey son requeridos para probar la conexión.",
      });
    }

    const baseUrl = process.env.WHAIBOT_API_URL || "https://whaibot.com";

    let whaibotResp;
    try {
      whaibotResp = await fetch(`${baseUrl}/api/health`, {
        method: "GET",
        headers: {
          "x-client-key": String(apiKey).trim(),
          "x-client-botid": String(botId).trim(),
        },
      });
    } catch (netErr) {
      console.error("❌ [WhaiBot test] error de red:", netErr.message);
      return res.status(200).json({
        success: false,
        status: "error",
        message:
          "No se pudo contactar con WhaiBot (error de red). Verifica tu conexión.",
      });
    }

    const data = await whaibotResp.json().catch(() => ({}));

    if (whaibotResp.ok && data.success) {
      return res.status(200).json({
        success: true,
        status: data.status || "ready",
        botId: data.botId || botId,
        message: data.message || "El bot está conectado y listo.",
      });
    }

    // Respuesta no exitosa (bot no listo, credenciales inválidas, no encontrado…)
    return res.status(200).json({
      success: false,
      status: data.status || "error",
      httpStatus: whaibotResp.status,
      message:
        data.message ||
        data.error ||
        `No se pudo verificar el bot (HTTP ${whaibotResp.status}).`,
    });
  } catch (error) {
    console.error("❌ Error en POST /api/integrations/whaibot/test:", error);
    return res.status(200).json({
      success: false,
      status: "error",
      message: "Error interno al probar la conexión: " + error.message,
    });
  }
});

// Estado público de la integración WhaiBot (sin exponer credenciales).
// Lo usan los clientes para saber si la opción de WhatsApp está disponible.
app.get("/api/integrations/whaibot/status", async (req, res) => {
  try {
    const doc = await db.collection("integrations").doc("whaibot").get();
    const cfg = doc.exists ? doc.data() : null;
    const configured = !!(cfg && cfg.botId && cfg.apiKey);
    const enabled = !!(cfg && cfg.enabled !== false && configured);
    return res.status(200).json({ success: true, enabled, configured });
  } catch (error) {
    console.error("❌ Error en GET /api/integrations/whaibot/status:", error);
    return res
      .status(500)
      .json({ success: false, enabled: false, configured: false });
  }
});

// Enviar un mensaje de prueba de WhatsApp (vía WhaiBot) a los números del cliente.
// Acepta { to: "<numero>" } o { numbers: ["<numero>", ...] }.
//
// Restringido a supervisores y administradores: la notificación por WhatsApp no
// se libera todavía a los clientes. Además, sin guard de rol este endpoint era
// un primitivo de "enviar un WhatsApp a un número arbitrario" disponible para
// cualquier usuario con sesión.
app.post(
  "/api/integrations/whaibot/send-test",
  requireRole("administrator", "supervisor"),
  async (req, res) => {
  try {
    const { to, numbers } = req.body;

    // Normalizar destinos: solo dígitos, formato internacional sin '+'
    let targets = [];
    if (Array.isArray(numbers)) targets = numbers;
    else if (to) targets = [to];
    targets = targets
      .map((n) => String(n).replace(/\D/g, ""))
      .filter((n) => n.length >= 8);

    if (targets.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Debes indicar al menos un número válido.",
      });
    }

    const doc = await db.collection("integrations").doc("whaibot").get();
    if (!doc.exists) {
      return res.status(400).json({
        success: false,
        message: "La integración de WhatsApp (WhaiBot) no está configurada.",
      });
    }
    const cfg = doc.data();
    if (cfg.enabled === false) {
      return res.status(403).json({
        success: false,
        message: "La integración de WhatsApp (WhaiBot) está deshabilitada.",
      });
    }
    if (!cfg.botId || !cfg.apiKey) {
      return res.status(400).json({
        success: false,
        message:
          "La integración de WhatsApp (WhaiBot) no está configurada correctamente.",
      });
    }

    const baseUrl = process.env.WHAIBOT_API_URL || "https://whaibot.com";
    const mensaje =
      "✅ ¡Tu número ha sido configurado correctamente para recibir notificaciones de License Manager!\n\n" +
      "Para asegurar la correcta entrega de los mensajes, por favor:\n" +
      "1️⃣ Guarda este número en tus contactos.\n" +
      "2️⃣ Responde a este mensaje indicando que estás de acuerdo con recibir notificaciones por WhatsApp.\n\n" +
      "¡Gracias! 🙌";

    const results = [];
    for (const target of targets) {
      try {
        const r = await fetch(`${baseUrl}/api/send-message`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-client-key": String(cfg.apiKey).trim(),
            "x-client-botid": String(cfg.botId).trim(),
          },
          body: JSON.stringify({
            to: target,
            message: mensaje,
            fromMe: "License Manager",
          }),
        });
        const data = await r.json().catch(() => ({}));
        results.push({
          to: target,
          success: !!(r.ok && data.success),
          message: data.message || data.error || `HTTP ${r.status}`,
        });
      } catch (err) {
        results.push({
          to: target,
          success: false,
          message: "Error de red: " + err.message,
        });
      }
    }

    const allOk = results.every((x) => x.success);
    const anyOk = results.some((x) => x.success);
    return res.status(200).json({
      success: anyOk,
      allSent: allOk,
      results,
      message: allOk
        ? "Mensaje de prueba enviado correctamente."
        : anyOk
          ? "Algunos mensajes no se pudieron enviar."
          : (results[0] && results[0].message) ||
          "No se pudo enviar el mensaje de prueba.",
    });
  } catch (error) {
    console.error("❌ Error en POST /api/integrations/whaibot/send-test:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno al enviar el mensaje de prueba.",
      detail: error.message,
    });
    }
  },
);

// Endpoint para enviar correos por SMTP
app.post("/api/sendmail", async (req, res) => {
  let { to, subject, message, templateType, templateData, isNotification, lang } =
    req.body;

  if (!to || !Array.isArray(to) || to.length === 0) {
    return res.status(400).json({
      success: false,
      message:
        "Faltan parámetros o 'to' no es una lista válida de destinatarios.",
    });
  }

  // El envío de HTML arbitrario (subject + message libres) convertía este
  // endpoint en un relay abierto desde el dominio corporativo. Ahora sólo se
  // permite con token administrativo; el flujo normal usa plantillas.
  if (!templateType && !requireAdminToken(req, res)) return;

  // En staging no sale ningún correo de notificación: comparte SMTP y base de
  // datos con producción y el cliente recibiría todo por duplicado.
  if (notificationsBlocked()) {
    console.warn(`🚫 [Sendmail] ${blockedReason()}. Destinatarios omitidos: ${to.length}`);
    return res.status(409).json({
      success: false,
      code: "ENVIRONMENT_BLOCKED",
      message: `${blockedReason()}. Este entorno no envía correos a los clientes.`,
    });
  }

  try {
    const emailSettings = await getEmailSettings();

    if (emailSettings.enabled === false) {
      return res.status(409).json({
        success: false,
        message: "El envío de correos está deshabilitado en la configuración del administrador.",
      });
    }

    let text;
    let sentLanguage = null;

    // Si se recibe un templateType, generamos el HTML en el backend
    if (templateType && templateData) {
      let template;
      // Idioma: el que indique quien llama y, si no lo indica, el configurado
      // por el destinatario. Sin ninguno de los dos, español.
      const language =
        lang ||
        templateData?.lang ||
        templateData?.language ||
        (await languageForRecipients(to));
      sentLanguage = language;
      const payload =
        templateData && typeof templateData === "object"
          ? { ...templateData, settings: emailSettings, lang: language }
          : { settings: emailSettings, lang: language };

      if (isNotification) {
        template = generateNotificationEmailTemplate(templateType, payload);
      } else {
        template = generateTemplate(templateType, payload);
      }
      subject = template.subject;
      message = template.html;
      text = template.text;
    }

    if (!subject || !message) {
      return res.status(400).json({
        success: false,
        message:
          "Faltan parámetros de subject o message, o el template no se generó correctamente.",
      });
    }

    const result = await sendMail({
      from: emailSettings.from,
      to,
      subject,
      html: message,
      text,
      replyTo: emailSettings.replyTo,
    });

    console.log(`✅ Correo enviado con éxito. ID: ${result.id}`);
    logEvent({
      type: EVENT.EMAIL_SENT,
      req,
      target: to.join(", "),
      message: `Correo "${templateType || "personalizado"}" enviado a ${to.length} destinatario(s).`,
      detail: { plantilla: templateType || null, idioma: sentLanguage, rechazados: result.rejected?.length || 0 },
    });
    return res.status(200).json({
      success: true,
      message: "Correos enviados con éxito",
      id: result.id,
      rechazados: result.rejected,
    });
  } catch (error) {
    console.error("❌ Error al enviar correo (SMTP):", error.message);
    logEvent({
      type: EVENT.EMAIL_SENT,
      req,
      target: to.join(", "),
      success: false,
      message: `Fallo al enviar correo: ${error.message}`,
      detail: { plantilla: templateType || null },
    });
    return res.status(502).json({
      success: false,
      message:
        "Error al enviar correo: " + (error.message || "Error desconocido"),
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint: BYOC Voice – Consumo desglosado por División
// Consulta la API de Agregados de Conversación de Genesys Cloud
// POST /api/v2/analytics/conversations/aggregates/query
// ─────────────────────────────────────────────────────────────────────────────
app.get("/api/reports/byoc-voice-divisions", async (req, res) => {
  try {
    const { startDate, endDate, timezone, region } = req.query;
    const accessToken =
      req.query.accessToken ||
      (req.headers.authorization && req.headers.authorization.split(" ")[1]);

    if (!accessToken || !startDate || !endDate || !region) {
      return res.status(400).json({
        success: false,
        error: "Se requieren startDate, endDate, accessToken y region",
      });
    }

    const url = getRegionUrl(region);

    // ── Timezone offset ───────────────────────────────────────────────────
    let offsetStart = "Z";
    let offsetEnd = "Z";
    if (timezone) {
      try {
        const fmtStart = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" });
        const tzStart = fmtStart.formatToParts(new Date(`${startDate}T12:00:00Z`)).find((p) => p.type === "timeZoneName").value;
        offsetStart = tzStart.replace("GMT", "") || "Z";

        const fmtEnd = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" });
        const tzEnd = fmtEnd.formatToParts(new Date(`${endDate}T12:00:00Z`)).find((p) => p.type === "timeZoneName").value;
        offsetEnd = tzEnd.replace("GMT", "") || "Z";
      } catch (e) {
        console.error("Error al calcular timezone offset:", e);
      }
    }

    const interval = `${startDate}T00:00:00.000${offsetStart}/${endDate}T23:59:59.999${offsetEnd}`;

    console.log(`📞 [byoc-voice-divisions] interval=${interval}  region=${region}`);

    // ── Get Divisions to map IDs to Names ─────────────────────────────────
    const divisionsObj = await getDivisions(accessToken, region, false);
    const divisionsMap = {};
    divisionsObj.forEach(div => { divisionsMap[div.id] = div.name; });

    // ── Query Conversations Aggregates by division (voice only) ───────────
    const payload = {
      interval: interval,
      groupBy: ["divisionId"],
      metrics: [
        "nOffered",    // Llamadas entrantes offered
        "tAnswered",   // Tiempo contestado (ms)
        "tTalk",       // Tiempo de conversación (ms)
        "nConnected"   // Llamadas conectadas
      ],
      filter: {
        type: "and",
        predicates: [
          {
            type: "dimension",
            dimension: "mediaType",
            value: "voice"
          }
        ]
      }
    };

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`
    };

    const apiResponse = await fetch(`${url}/api/v2/analytics/conversations/aggregates/query`, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload)
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      console.error(`❌ [byoc-voice-divisions] API error ${apiResponse.status}:`, errorText);
      return res.status(apiResponse.status).json({
        success: false,
        error: `Error de la API de Genesys Cloud: ${apiResponse.status}`
      });
    }

    const apiData = await apiResponse.json();

    // ── Build division results ────────────────────────────────────────────
    const divisionResults = [];

    if (apiData.results && apiData.results.length > 0) {
      apiData.results.forEach(group => {
        const divId = group.group?.divisionId || "Home";
        const divisionName = divisionsMap[divId] || (divId === "Home" ? "Home / Default" : divId);

        let nOffered = 0;
        let tAnswered = 0;
        let tTalk = 0;
        let nConnected = 0;

        if (group.data && group.data[0] && group.data[0].metrics) {
          group.data[0].metrics.forEach(m => {
            switch (m.metric) {
              case "nOffered":
                nOffered = m.stats.count || 0;
                break;
              case "tAnswered":
                tAnswered = (m.stats.sum || 0) / 1000; // ms to seconds
                break;
              case "tTalk":
                tTalk = (m.stats.sum || 0) / 1000; // ms to seconds
                break;
              case "nConnected":
                nConnected = m.stats.count || 0;
                break;
            }
          });
        }

        divisionResults.push({
          divisionId: divId,
          divisionName,
          nOffered,
          tAnswered,
          tTalk,
          nConnected
        });
      });
    }

    // Sort by nOffered descending
    divisionResults.sort((a, b) => b.nOffered - a.nOffered);

    console.log(`✅ [byoc-voice-divisions] ${divisionResults.length} divisiones encontradas`);

    return res.status(200).json({
      success: true,
      data: divisionResults,
      interval
    });

  } catch (error) {
    console.error("Error en byoc-voice-divisions:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Error interno del servidor"
    });
  }
});

// ── Consumo de IVR (Genesys Cloud IVR Basic Per Minute Charge) por división ──
// Usa la métrica de Analytics `tIvr` (tiempo en IVR) agrupada por divisionId.
app.get("/api/reports/ivr-divisions", async (req, res) => {
  try {
    const { startDate, endDate, timezone, region } = req.query;
    const accessToken =
      req.query.accessToken ||
      (req.headers.authorization && req.headers.authorization.split(" ")[1]);

    if (!accessToken || !startDate || !endDate || !region) {
      return res.status(400).json({
        success: false,
        error: "Se requieren startDate, endDate, accessToken y region",
      });
    }

    const url = getRegionUrl(region);

    // ── Timezone offset ───────────────────────────────────────────────────
    let offsetStart = "Z";
    let offsetEnd = "Z";
    if (timezone) {
      try {
        const fmtStart = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" });
        const tzStart = fmtStart.formatToParts(new Date(`${startDate}T12:00:00Z`)).find((p) => p.type === "timeZoneName").value;
        offsetStart = tzStart.replace("GMT", "") || "Z";

        const fmtEnd = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" });
        const tzEnd = fmtEnd.formatToParts(new Date(`${endDate}T12:00:00Z`)).find((p) => p.type === "timeZoneName").value;
        offsetEnd = tzEnd.replace("GMT", "") || "Z";
      } catch (e) {
        console.error("Error al calcular timezone offset:", e);
      }
    }

    const interval = `${startDate}T00:00:00.000${offsetStart}/${endDate}T23:59:59.999${offsetEnd}`;

    console.log(`🔊 [ivr-divisions] interval=${interval}  region=${region}`);

    // ── Get Divisions to map IDs to Names ─────────────────────────────────
    const divisionsObj = await getDivisions(accessToken, region, false);
    const divisionsMap = {};
    divisionsObj.forEach(div => { divisionsMap[div.id] = div.name; });

    // ── Query Flows Aggregates by division (tFlow = tiempo en IVR/flujo) ───
    // Nota: tFlow/nFlow son métricas de FLUJO, por lo que se consultan en el
    // endpoint de flows aggregates (no en conversations, que devuelve 403).
    const payload = {
      interval: interval,
      groupBy: ["divisionId"],
      metrics: [
        "nFlow", // Nº de ejecuciones de flujo (IVR)
        "tFlow"  // Tiempo total en flujo / IVR (ms)
      ],
      filter: {
        type: "and",
        predicates: [
          {
            type: "dimension",
            dimension: "mediaType",
            operator: "matches",
            value: "voice"
          }
        ]
      }
    };

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`
    };

    const apiResponse = await fetch(`${url}/api/v2/analytics/flows/aggregates/query`, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload)
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      console.error(`❌ [ivr-divisions] API error ${apiResponse.status}:`, errorText);
      return res.status(apiResponse.status).json({
        success: false,
        error: `Error de la API de Genesys Cloud: ${apiResponse.status}`
      });
    }

    const apiData = await apiResponse.json();

    // ── Build division results ────────────────────────────────────────────
    const divisionResults = [];

    if (apiData.results && apiData.results.length > 0) {
      apiData.results.forEach(group => {
        const divId = group.group?.divisionId || "Home";
        const divisionName = divisionsMap[divId] || (divId === "Home" ? "Home / Default" : divId);

        let tFlow = 0;
        let nFlow = 0;

        if (group.data && group.data[0] && group.data[0].metrics) {
          group.data[0].metrics.forEach(m => {
            switch (m.metric) {
              case "nFlow":
                nFlow = m.stats.count || 0;        // nº de ejecuciones de flujo/IVR
                break;
              case "tFlow":
                tFlow = (m.stats.sum || 0) / 1000; // ms a segundos
                break;
            }
          });
        }

        // Solo incluir divisiones que efectivamente usaron IVR (flujo)
        if (tFlow > 0 || nFlow > 0) {
          divisionResults.push({
            divisionId: divId,
            divisionName,
            nIvr: nFlow,
            tIvr: tFlow,
            ivrMinutes: Math.round(tFlow / 60)
          });
        }
      });
    }

    // Ordenar por tiempo de IVR (flujo) descendente
    divisionResults.sort((a, b) => b.tIvr - a.tIvr);

    console.log(`✅ [ivr-divisions] ${divisionResults.length} divisiones con IVR encontradas`);

    return res.status(200).json({
      success: true,
      data: divisionResults,
      interval
    });

  } catch (error) {
    console.error("Error en ivr-divisions:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Error interno del servidor"
    });
  }
});

// Endpoint de prueba para guardar algo en Firestore
app.post("/api/firestore-test", requireAdmin, async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({
        success: false,
        error:
          "Firebase no está inicializado. Verifica tu serviceAccountKey.json",
      });
    }

    const data = req.body;

    // Ejemplo: Guardar un log en la colección "logs"
    const docRef = await db.collection("logs").add({
      ...data,
      timestamp: new Date().toISOString(),
    });

    return res.status(200).json({
      success: true,
      message: "Documento creado en Firestore exitosamente",
      id: docRef.id,
    });
  } catch (error) {
    console.error("Error al guardar en Firestore:", error);
    return res.status(500).json({
      success: false,
      error: "Error al comunicarse con Firestore",
    });
  }
});
