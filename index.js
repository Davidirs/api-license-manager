require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
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

// Toda respuesta 5xx se notifica al contacto de alertas de la plataforma.
const { serverErrorMonitor, notifyPlatformError } = require("./utils/platformAlerts");
app.use(serverErrorMonitor);

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
const { fetchOrgToken, isKnownRegion } = require("./utils/genesysRegions");
const { fetchOutboundCampaignAttempts } = require("./services/genesysBilling");
// KPIs del informe y fair use (BYOC, outbound, IVR) calculados en el servidor.
const {
  buildLicensingReport,
  calcularKpis,
  resumenFairUse,
  clientDataConFairUse,
  DEFAULT_TIMEZONE: REPORT_DEFAULT_TIMEZONE,
} = require("./services/licensingReport");
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
const {
  MIN_PASSWORD_LENGTH,
  createResetToken,
  findValidReset,
  invalidatePending,
  passwordPolicyError,
} = require("./utils/passwordReset");

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

/**
 * El número de WhatsApp y su verificación los gestiona sólo el servidor
 * (/api/whatsapp/verification/*): se descarta lo que mande el front y se
 * conserva lo guardado. Además se sanean el horario de no molestar y las
 * plantillas elegidas por el usuario.
 */
function withServerManagedWhatsapp(prefs, storedPrefs) {
  const next = { ...prefs };
  const stored = storedPrefs || {};
  next.whatsappRecipients = Array.isArray(stored.whatsappRecipients) ? stored.whatsappRecipients : [];
  next.whatsappVerifiedAt = stored.whatsappVerifiedAt || null;
  if (!next.whatsappVerifiedAt) next.whatsappNotifications = false;
  if (next.whatsappQuietHours !== undefined) {
    next.whatsappQuietHours = sanitizeQuietHours(next.whatsappQuietHours);
  }
  if (next.whatsappTemplates !== undefined) {
    const clean = {};
    for (const key of WHATSAPP_TEMPLATES) {
      if (typeof next.whatsappTemplates?.[key] === "boolean") clean[key] = next.whatsappTemplates[key];
    }
    next.whatsappTemplates = clean;
  }
  return next;
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
      // Si la organización permite el análisis con IA (ver /api/organization/ai).
      userResponse.aiEnabled = targetOrgData.aiEnabled !== false;
      // Si la organización tiene habilitadas las notificaciones por WhatsApp.
      userResponse.whatsappEnabled = isOrgWhatsappEnabled(targetOrgData);

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
const { getWhatsappQueueHealth } = require("./services/whatsappQueue");
const {
  WHATSAPP_TEMPLATES,
  MAX_NUMBERS_PER_USER,
  getWhaibotConfig,
  invalidateWhaibotCache,
  isConfigured: isWhaibotConfigured,
  isIntegrationEnabled: isWhaibotEnabled,
  resolveTemplates: resolveWhatsappTemplates,
  sanitizeTemplates: sanitizeWhatsappTemplates,
  isOrgWhatsappEnabled,
  normalizeNumbers,
  sendWhaibotMessage,
  resolveDailyLimit,
} = require("./utils/whaibot");
const { whatsappText } = require("./utils/whatsappMessages");
const { sanitizeQuietHours } = require("./utils/quietHours");
const {
  getPlatformAlertSettings,
  savePlatformAlertSettings,
  deliverAlert,
} = require("./utils/platformAlerts");

// Iniciar el servidor
app.listen(port, () => {
  console.log(`✅ API de Node.js corriendo en http://localhost:${port}`);
  initCron();
});

// Disparo manual del orquestador. Protegido: sin el guard, cualquiera con la
// URL podía lanzar un envío masivo de correos a todos los clientes.
app.post("/api/monitor/run", async (req, res) => {
  if (!requireAdminToken(req, res)) return;

  console.log(`[${new Date().toISOString()}] ▶️ Forzando ejecución manual del monitor desde endpoint administrativo...`);
  logEvent({
    type: EVENT.MONITOR_RUN,
    req,
    message: "Ejecución manual del orquestador de monitoreo.",
    detail: { entorno: currentEnv(), notificacionesBloqueadas: notificationsBlocked() },
  });
  runDailyMonitor().catch((err) =>
    console.error(`[${new Date().toISOString()}] ❌ Ejecución manual del monitor falló:`, err.message),
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
    const [monitor, emails, whatsapp] = await Promise.all([
      getMonitorHealth(),
      getQueueHealth(),
      getWhatsappQueueHealth(),
    ]);

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
      queues: { monitor, emails, whatsapp },
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

// Tokens de Genesys de las organizaciones resueltas desde la sesión.
const sessionOrgTokenCache = new Map();

/**
 * Token y región de Genesys de la organización de la sesión (la del JWT), con
 * las credenciales OAuth guardadas en Firestore, igual que en el login.
 */
async function genesysAccessForSession(req) {
  let orgDoc = await findOrgDoc(req.auth?.orgId);
  if (!orgDoc && req.auth?.orgname) {
    const snapshot = await db
      .collection("organizations")
      .where("orgname", "==", req.auth.orgname)
      .limit(1)
      .get();
    if (!snapshot.empty) orgDoc = snapshot.docs[0];
  }

  const org = orgDoc?.data();
  if (!org || !org.clientId || !org.clientSecret) {
    const error = new Error("La organización de la sesión no tiene credenciales de Genesys configuradas.");
    error.status = 404;
    error.expose = true;
    throw error;
  }

  const region = org.region || "us-east-1";
  const cacheKey = `${orgDoc.id}:${org.clientId}:${region}`;
  const cached = sessionOrgTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { token: cached.accessToken, region };
  }
  const fresh = await fetchOrgToken(org.clientId, org.clientSecret, region);
  sessionOrgTokenCache.set(cacheKey, fresh);
  return { token: fresh.accessToken, region };
}

/**
 * KPIs del informe mensual de licenciamiento, calculados en el servidor con las
 * reglas de fair use del dashboard (ver services/licensingReport.js).
 *
 * Parámetros (query en GET, cuerpo en POST):
 *  - endDate: "previous" (por defecto), "current", timestamp en ms o fecha.
 *  - timezone: zona para contar los intentos outbound (America/Mexico_City).
 *  - outbound: "false" para no consultar Analytics (outbound sale null).
 *  - accessToken + region: opcionales; sin ellos se usa la organización de la
 *    sesión con sus credenciales de Firestore.
 *
 * Respuesta: { success, region, periodEndingTimestamp, timezone, kpis, alertas,
 * outboundError }. `kpis` y `alertas` tienen la forma de `calcular_kpis` y
 * `alertas` de informes_mensuales.
 */
async function licensingReportHandler(req, res) {
  res.set("Cache-Control", "no-store");
  try {
    const params = { ...req.query, ...(req.body || {}) };

    if (params.region && !isKnownRegion(params.region)) {
      return res.status(400).json({ success: false, error: "Región no válida o no soportada." });
    }

    const access = params.accessToken
      ? { token: params.accessToken, region: params.region || "us-east-1" }
      : await genesysAccessForSession(req);

    const report = await buildLicensingReport({
      token: access.token,
      region: access.region,
      endDate: String(params.endDate || "previous"),
      timezone: params.timezone || REPORT_DEFAULT_TIMEZONE,
      includeOutbound: !["false", "0", false, 0].includes(params.outbound),
    });

    return res.status(200).json({ success: true, ...report });
  } catch (error) {
    console.error("❌ Error en /api/report/licensing:", error?.message || error);
    // Los errores propios (parámetros, período) se devuelven tal cual; los de
    // Genesys como 502 para que el front no los confunda con la sesión.
    const status = error.expose
      ? error.status
      : error.name === "AbortError"
        ? 504
        : 502;
    return res.status(status).json({
      success: false,
      error: error.message || "Error interno del servidor",
      genesysStatus: error.expose ? undefined : error.status,
    });
  }
}

app.get("/api/report/licensing", licensingReportHandler);
app.post("/api/report/licensing", licensingReportHandler);

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

// Helper para invocar servicio de IA (DeepSeek por defecto, con soporte configurable / fallback a Groq)
async function callAiChatCompletion({ systemPrompt, userPrompt, maxTokens }) {
  const deepseekApiKey = (process.env.DEEPSEEK_API_KEY || "").trim();
  const groqApiKey = (process.env.GROQ_API_KEY || "").trim();

  // Si no se define AI_PROVIDER explícito: usar deepseek si tiene key, si no groq
  const explicitProvider = process.env.AI_PROVIDER ? process.env.AI_PROVIDER.toLowerCase().trim() : null;
  const configuredProvider = explicitProvider || (deepseekApiKey ? 'deepseek' : 'groq');

  let requestBody;

  if (configuredProvider === 'deepseek') {
    endpoint = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';
    apiKey = deepseekApiKey;
    model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';

    requestBody = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      // En DeepSeek V4 la propiedad thinking va en la raíz del payload JSON
      thinking: {
        type: process.env.DEEPSEEK_THINKING === 'true' ? 'enabled' : 'disabled'
      },
      max_tokens: maxTokens || 4000
    };
  } else {
    endpoint = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions';
    apiKey = groqApiKey;
    model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

    requestBody = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: maxTokens || 2000
    };
  }

  if (!apiKey) {
    const missingVar = configuredProvider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'GROQ_API_KEY';
    const err = new Error(`${missingVar} no está configurado en el servidor.`);
    err.status = 500;
    throw err;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errText = await response.text();
    const err = new Error(`AI API error (${configuredProvider}): ${response.status} - ${errText}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const choice = data.choices?.[0]?.message;
  const aiText = choice?.content || choice?.reasoning_content;
  return aiText;
}

// Endpoint para analizar métricas con IA (DeepSeek / Groq)
app.post("/api/analyze-metrics", requireAiEnabled, async (req, res) => {
  try {
    const { clientData, dailyLogins, outboundAttempts, overageDetailsText, lang, languageName } = req.body;

    // El idioma se resuelve en el backend, no se toma tal cual del cliente:
    // antes llegaba una cadena libre y bastaba una clave de traducción sin
    // traducir para que el modelo recibiera un idioma inexistente y respondiera
    // en cualquier lengua. `promptsFor`/`languageRule` sanean el valor y caen a
    // español ante cualquier cosa que no reconozcan.
    const idiomaAnalisis = lang || languageName;
    const p = promptsFor(idiomaAnalisis);

    // Fair use calculado aquí, con las mismas reglas que /api/report/licensing.
    // Sin él la IA veía el consumo de BYOC sin prepago (overageQuantity = todo
    // lo usado) y lo presentaba como sobreuso aunque estuviera dentro del fair
    // use de las licencias. Si los datos no tienen la forma esperada, el
    // análisis sigue como antes, sin este bloque.
    let fairUse = null;
    let datosCliente = clientData;
    try {
      if (clientData) {
        const kpis = calcularKpis(clientData, outboundAttempts || null);
        fairUse = resumenFairUse(kpis);
        datosCliente = clientDataConFairUse(clientData, kpis);
      }
    } catch (fairUseError) {
      console.warn("⚠️ [analyze-metrics] No se pudo calcular el fair use:", fairUseError.message);
    }

    const systemPrompt = `Eres un experto analista de métricas de Genesys Cloud CX. Analiza los datos proporcionados y genera un análisis sumamente conciso, directo y breve.

${languageRule(idiomaAnalisis)}

REGLAS DE FORMATO Y ESTRUCTURA OBLIGATORIAS:
1. El análisis debe contener ÚNICAMENTE las siguientes 3 secciones (sin secciones adicionales, sin recomendaciones largas ni texto de relleno):

${p.sectionSummary}:
Un único párrafo corto (máximo 3 a 5 líneas) resumiendo la organización, período de facturación, uso general de licencias indicando si hubo sobreuso frente a lo prepagado, y una breve mención de recursos como almacenamiento, tokens de IA e intentos de salida.

${p.sectionKpis}:
Una lista de viñetas con guion "- ", con exactamente una línea concisa por cada KPI:
- ${p.kpiLicenses}: [resumen de 1 frase del uso vs prepagadas y si hay exceso o está dentro del límite]
- ${p.kpiResources}: [resumen de 1 frase de unidades utilizadas vs límite comprometido]
- ${p.kpiStorage}: [resumen de 1 frase de almacenamiento disponible o utilizado]
- ${p.kpiAiTokens}: [resumen de 1 frase de tokens utilizados vs límite incluido]
- ${p.kpiOutbound}: [resumen de 1 frase de total de intentos de salida distribuidos en campañas]

${p.sectionAlerts}:
Una lista de viñetas con guion "- ":
- Si hay sobreuso: una viñeta indicando la licencia y cantidad de usuarios excedidos, y si aplica, otra viñeta indicando que los últimos usuarios que consumieron licencias corresponden a los mencionados en la sección de detalles de sobreuso y últimos inicios de sesión.
- Si no hay sobreuso: una sola viñeta indicando que no se ha detectado sobreuso de licencias ni de recursos.

2. No uses negritas (**texto**) en ningún lugar, ni en los títulos ni en el cuerpo del texto.
3. Los encabezados de sección deben ir exactamente con el título seguido de dos puntos (ejemplo "${p.sectionSummary}:", "${p.sectionKpis}:", "${p.sectionAlerts}:"), sin números.
4. Para las viñetas utiliza únicamente el guion "- ", nunca asteriscos "*".
5. Los datos que recibes son agregados y no incluyen identidades de agentes. No inventes nombres, correos ni datos personales.
6. Mantén la extensión total muy corta, semejante a 3 párrafos o bloques breves.${fairUse ? `
7. Genesys Cloud BYOC Cloud y los intentos outbound no se miden contra lo prepagado, sino contra el fair use incluido en las licencias, que recibes ya calculado en la sección de fair use. Solo hay sobreuso si su "excedente" es mayor que 0; si "dentro_del_fair_use" es true, di que el consumo está dentro del fair use y no lo presentes como sobreuso ni lo incluyas en ${p.sectionAlerts}. Usa esas cifras tal cual, sin recalcularlas.` : ""}`;

    // Los datos y encabezados en el idioma correspondiente
    const userPrompt = `${p.metricsIntro}

${p.metricsLicenses}
${JSON.stringify(datosCliente, null, 2)}
${fairUse ? `
${p.metricsFairUse}
${JSON.stringify(fairUse, null, 2)}
` : ""}
${p.metricsLogins}
${JSON.stringify(dailyLogins, null, 2)}

${p.metricsOutbound}
${JSON.stringify(outboundAttempts, null, 2)}

${p.metricsOverage}
${overageDetailsText || p.metricsNoOverage}`;

    const aiText = await callAiChatCompletion({ systemPrompt, userPrompt, maxTokens: 1000 });
    if (!aiText) {
      return res.status(502).json({ success: false, code: "EMPTY_AI_RESPONSE" });
    }

    return res.status(200).json({
      success: true,
      analysis: aiText
    });

  } catch (error) {
    console.error("Error en analyze-metrics:", error);
    return res.status(error.status || 500).json({ success: false, error: error.message });
  }
});


// Endpoint para analizar comparativa entre periodos con IA
app.post("/api/analyze-comparison", requireAiEnabled, async (req, res) => {
  try {
    const { kpiData, selectedCategories, kpiName, lang, languageName } = req.body;

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

    const aiText = await callAiChatCompletion({ systemPrompt, userPrompt });
    if (!aiText) {
      return res.status(502).json({ success: false, code: "EMPTY_AI_RESPONSE" });
    }

    return res.status(200).json({
      success: true,
      analysis: aiText
    });

  } catch (error) {
    console.error("Error en analyze-comparison:", error);
    return res.status(error.status || 500).json({ success: false, error: error.message });
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

    // El cálculo (intervalo, filtro y recuento) es el mismo que usa
    // /api/report/licensing: vive en services/genesysBilling.js.
    const { totalAttempts, campaigns } = await fetchOutboundCampaignAttempts(
      accessToken,
      region,
      startDate,
      endDate,
      timezone,
    );

    if (campaigns.length > 0) {
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
            thrusted:
              body.thrusted ||
              (Array.isArray(userToCreate.thrusted)
                ? userToCreate.thrusted[0]
                : userToCreate.thrusted) ||
              "N/A",
            region: body.region || userToCreate.region || "us-east-1",
            clientId: body.clientId || userToCreate.clientId || "",
            clientSecret: body.clientSecret || userToCreate.clientSecret || "",
            criticalMetrics: orgDoc.exists ? orgDoc.data().criticalMetrics || [] : [],
            // Preservar el estado 'active' existente; por defecto activa.
            active: orgDoc.exists ? orgDoc.data().active ?? true : true,
            // Uso de IA: se preserva el existente; activo por defecto.
            aiEnabled: orgDoc.exists ? orgDoc.data().aiEnabled ?? true : true,
            // WhatsApp es opt-in: las organizaciones nuevas nacen sin él.
            whatsappEnabled: orgDoc.exists ? orgDoc.data().whatsappEnabled === true : false,
          },
          { merge: true },
        );
      }

      // Creamos el Usuario
      const firestoreUser = {
        username: cleanUsername,
        passwordHash: passwordHash,
        role: userToCreate.role || "client",
        thrusted:
          userToCreate.thrusted !== undefined
            ? userToCreate.thrusted
            : body.thrusted || "N/A",
        orgname: orgname,
        orgId: orgId,
        clientId: userToCreate.clientId || body.clientId || (orgDoc.exists ? orgDoc.data().clientId : "") || "",
        clientSecret: userToCreate.clientSecret || body.clientSecret || (orgDoc.exists ? orgDoc.data().clientSecret : "") || "",
        region: userToCreate.region || body.region || (orgDoc.exists ? orgDoc.data().region : "us-east-1") || "us-east-1",
        // El idioma se elige al crear el usuario y decide en qué idioma se le
        // renderizan la interfaz y las plantillas de correo. Sin selección,
        // español.
        preferences: withServerManagedWhatsapp(withNormalizedLanguage(userToCreate.preferences), null),
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
          updates.preferences = withServerManagedWhatsapp(
            withNormalizedLanguage(safeUserFields.preferences),
            userDoc.exists ? userDoc.data().preferences : null,
          );
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
          updates.preferences = withServerManagedWhatsapp(
            withNormalizedLanguage(userToCreate.preferences),
            userDoc.exists ? userDoc.data().preferences : null,
          );
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
    const {
      orgId,
      orgname,
      thrusted,
      region,
      clientId,
      clientSecret,
      active,
      aiEnabled,
      whatsappEnabled,
    } = body;

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

    // Uso de IA: igual que 'active'. Las organizaciones nuevas nacen con la
    // IA activa; el administrador puede desactivarla después.
    const resolvedAiEnabled =
      typeof aiEnabled === "boolean"
        ? aiEnabled
        : orgDoc.exists
          ? orgDoc.data().aiEnabled ?? true
          : true;

    // WhatsApp: al revés que la IA, las organizaciones nuevas nacen sin él.
    const resolvedWhatsappEnabled =
      typeof whatsappEnabled === "boolean"
        ? whatsappEnabled
        : orgDoc.exists
          ? orgDoc.data().whatsappEnabled === true
          : false;

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
        aiEnabled: resolvedAiEnabled,
        whatsappEnabled: resolvedWhatsappEnabled,
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

// ==================== Uso de IA por organización ====================
// El análisis con IA (botón flotante del dashboard y análisis del comparativo)
// envía métricas agregadas a un proveedor externo (DeepSeek / Groq). Una
// organización puede no querer compartir datos con terceros, así que el
// administrador puede desactivarlo.
//
// Convención igual que `active`: si el campo `aiEnabled` falta, la IA está
// activa; sólo `aiEnabled === false` la desactiva.

/** Documento de una organización por id (con respaldo por el campo `orgId`). */
async function findOrgDoc(orgId) {
  if (!orgId) return null;
  const clean = String(orgId).trim();
  const direct = await db.collection("organizations").doc(clean).get();
  if (direct.exists) return direct;
  const snapshot = await db
    .collection("organizations")
    .where("orgId", "==", clean)
    .limit(1)
    .get();
  return snapshot.empty ? null : snapshot.docs[0];
}

/**
 * ¿Puede la sesión actual usar la IA? Se decide por la organización de la
 * sesión (la del JWT), no por lo que mande el navegador.
 */
async function isAiEnabledForSession(req) {
  const orgDoc = await findOrgDoc(req.auth?.orgId);
  // Sin organización resoluble se mantiene el comportamiento previo (activa).
  if (!orgDoc) return true;
  return orgDoc.data().aiEnabled !== false;
}

/** Middleware para los endpoints que llaman al proveedor de IA. */
async function requireAiEnabled(req, res, next) {
  try {
    if (await isAiEnabledForSession(req)) return next();
    return res.status(403).json({
      success: false,
      code: "AI_DISABLED",
      message: "El análisis con IA está desactivado para esta organización.",
    });
  } catch (error) {
    console.error("❌ Error comprobando aiEnabled:", error);
    return res.status(500).json({ success: false, message: "Error interno del servidor" });
  }
}

// Estado de la IA para la organización de la sesión. Lo consultan el
// dashboard y el comparativo para mostrar u ocultar los botones de análisis.
app.get("/api/organization/ai-status", async (req, res) => {
  try {
    const aiEnabled = await isAiEnabledForSession(req);
    return res.status(200).json({ success: true, aiEnabled });
  } catch (error) {
    console.error("❌ Error en GET /api/organization/ai-status:", error);
    return res.status(500).json({ success: false, message: "Error interno del servidor" });
  }
});

// Activar / desactivar las notificaciones por WhatsApp de una organización
// (sólo administrador). Opt-in: sin el campo, la organización no tiene WhatsApp.
app.post("/api/organization/whatsapp", requireAdmin, async (req, res) => {
  try {
    const { orgId, whatsappEnabled } = req.body;

    if (!orgId || typeof whatsappEnabled !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "orgId y whatsappEnabled (boolean) son requeridos.",
      });
    }

    const orgDoc = await findOrgDoc(orgId);
    if (!orgDoc) {
      return res
        .status(404)
        .json({ success: false, message: "Organización no encontrada." });
    }

    await orgDoc.ref.set({ whatsappEnabled }, { merge: true });

    logEvent({
      type: EVENT.ORG_WHATSAPP_CHANGED,
      req,
      target: orgDoc.id,
      orgname: orgDoc.data().orgname || null,
      orgId: orgDoc.id,
      message: `Notificaciones por WhatsApp ${whatsappEnabled ? "activadas" : "desactivadas"}.`,
      detail: { whatsappEnabled },
    });

    return res.status(200).json({
      success: true,
      whatsappEnabled,
      message: `WhatsApp ${whatsappEnabled ? "activado" : "desactivado"} exitosamente.`,
    });
  } catch (error) {
    console.error("❌ Error en POST /api/organization/whatsapp:", error);
    return res.status(500).json({ success: false, message: "Error interno del servidor" });
  }
});

// Activar / desactivar el uso de IA en una organización (sólo administrador).
app.post("/api/organization/ai", requireAdmin, async (req, res) => {
  try {
    const { orgId, aiEnabled } = req.body;

    if (!orgId || typeof aiEnabled !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "orgId y aiEnabled (boolean) son requeridos.",
      });
    }

    const orgDoc = await findOrgDoc(orgId);
    if (!orgDoc) {
      return res
        .status(404)
        .json({ success: false, message: "Organización no encontrada." });
    }

    await orgDoc.ref.set({ aiEnabled }, { merge: true });

    logEvent({
      type: EVENT.ORG_AI_CHANGED,
      req,
      target: orgDoc.id,
      orgname: orgDoc.data().orgname || null,
      orgId: orgDoc.id,
      message: `Uso de IA ${aiEnabled ? "activado" : "desactivado"}.`,
      detail: { aiEnabled },
    });

    return res.status(200).json({
      success: true,
      aiEnabled,
      message: `Uso de IA ${aiEnabled ? "activado" : "desactivado"} exitosamente.`,
    });
  } catch (error) {
    console.error("❌ Error en POST /api/organization/ai:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno del servidor",
      detail: error.message,
    });
  }
});

// ==================== Restablecimiento de contraseña ====================
// Flujo: se emite un token de un solo uso (utils/passwordReset.js), se envía
// por correo un enlace a /reset-password del dashboard y, con ese token, el
// usuario fija una contraseña nueva sin haber iniciado sesión.
//
// Estos correos NO pasan por el bloqueo de STAGING: son una acción explícita
// de una persona (como el correo de prueba del admin), no una notificación
// automática que producción ya haya enviado.

/**
 * URL base del dashboard para construir el enlace.
 *
 * APP_URL manda. Sin ella se usa el Origin de la petición, pero sólo si está
 * en CORS_ORIGINS: aceptar cualquier Origin permitiría que alguien pidiera un
 * reseteo para otra persona con un enlace hacia un dominio suyo y capturase el
 * token cuando la víctima lo abriera.
 */
function resolveAppUrl(req) {
  const configured = (process.env.APP_URL || "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) return origin.replace(/\/+$/, "");
  return null;
}

/** Emite el token y envía el correo. Lanza si el SMTP falla. */
async function sendPasswordResetEmail(req, userData, { byAdmin }) {
  const appUrl = resolveAppUrl(req);
  if (!appUrl) {
    const err = new Error(
      "No se pudo determinar la URL del dashboard. Configure APP_URL en el servidor.",
    );
    err.code = "APP_URL_MISSING";
    throw err;
  }

  const { token, expiresInMinutes } = await createResetToken(
    userData.username,
    byAdmin ? req.auth?.sub || "admin" : "self",
  );
  const resetUrl = `${appUrl}/reset-password/?token=${token}`;

  const settings = await getEmailSettings();
  const template = generateTemplate("passwordreset", {
    usuario: userData.username,
    orgname: userData.orgname,
    resetUrl,
    byAdmin,
    expiresInMinutes,
    settings,
    lang: userData.preferences?.language,
  });

  await sendMail({
    from: settings.from,
    to: userData.username,
    subject: template.subject,
    html: template.html,
    text: template.text,
    replyTo: settings.replyTo,
  });
}

// Límite de ritmo en memoria para el endpoint público: evita usarlo para
// inundar de correos un buzón o para sondear qué usuarios existen.
const PASSWORD_FORGOT_WINDOW_MS = 15 * 60 * 1000;
const PASSWORD_FORGOT_MAX_PER_IP = 10;
const PASSWORD_FORGOT_MAX_PER_USER = 3;
const passwordForgotHits = new Map();

function hitRateLimit(key, max) {
  const now = Date.now();
  const hits = (passwordForgotHits.get(key) || []).filter(
    (ts) => now - ts < PASSWORD_FORGOT_WINDOW_MS,
  );
  if (hits.length >= max) {
    passwordForgotHits.set(key, hits);
    return true;
  }
  hits.push(now);
  passwordForgotHits.set(key, hits);
  return false;
}

// "¿Olvidaste tu contraseña?" desde el login. Siempre responde lo mismo exista
// o no el usuario, para no revelar qué correos están registrados.
app.post("/api/password/forgot", async (req, res) => {
  const genericResponse = {
    success: true,
    message:
      "Si el usuario existe y está activo, recibirá un correo con un enlace para restablecer su contraseña.",
  };

  try {
    const username = String(req.body?.username || "").trim();
    if (!username) {
      return res
        .status(400)
        .json({ success: false, message: "El usuario es requerido." });
    }

    const ip =
      String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      req.socket?.remoteAddress ||
      "unknown";
    if (
      hitRateLimit(`ip:${ip}`, PASSWORD_FORGOT_MAX_PER_IP) ||
      hitRateLimit(`user:${username.toLowerCase()}`, PASSWORD_FORGOT_MAX_PER_USER)
    ) {
      return res.status(429).json({
        success: false,
        code: "RATE_LIMITED",
        message: "Demasiadas solicitudes. Inténtalo de nuevo en unos minutos.",
      });
    }

    const userDoc = await db.collection("users").doc(username).get();
    if (!userDoc.exists || userDoc.data().active === false) {
      logEvent({
        type: EVENT.PASSWORD_RESET_REQUESTED,
        req,
        username,
        success: false,
        message: userDoc.exists
          ? "Solicitud de restablecimiento para un usuario desactivado."
          : "Solicitud de restablecimiento para un usuario inexistente.",
      });
      return res.status(200).json(genericResponse);
    }

    const userData = { ...userDoc.data(), username };
    await sendPasswordResetEmail(req, userData, { byAdmin: false });

    logEvent({
      type: EVENT.PASSWORD_RESET_REQUESTED,
      req,
      username,
      orgname: userData.orgname || null,
      orgId: userData.orgId || null,
      role: userData.role || null,
      success: true,
      message: "Enlace de restablecimiento enviado (solicitado desde el login).",
    });

    return res.status(200).json(genericResponse);
  } catch (error) {
    console.error("❌ Error en POST /api/password/forgot:", error.message);
    // El fallo de SMTP no se oculta tras la respuesta genérica: el usuario
    // quedaría esperando un correo que nunca llega.
    return res.status(502).json({
      success: false,
      code: error.code || "SEND_FAILED",
      message: "No se pudo enviar el correo. Inténtalo más tarde o contacta al administrador.",
    });
  }
});

// El administrador envía al usuario el enlace para que fije una contraseña nueva.
app.post("/api/password/reset-request", requireAdmin, async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    if (!username) {
      return res
        .status(400)
        .json({ success: false, message: "username es requerido." });
    }

    const userDoc = await db.collection("users").doc(username).get();
    if (!userDoc.exists) {
      return res
        .status(404)
        .json({ success: false, message: "Usuario no encontrado." });
    }

    const userData = { ...userDoc.data(), username };
    await sendPasswordResetEmail(req, userData, { byAdmin: true });

    logEvent({
      type: EVENT.PASSWORD_RESET_REQUESTED,
      req,
      target: username,
      orgname: userData.orgname || null,
      orgId: userData.orgId || null,
      success: true,
      message: `El administrador envió un enlace de restablecimiento a "${username}".`,
    });

    return res.status(200).json({
      success: true,
      message: `Se envió a ${username} un enlace para restablecer su contraseña.`,
    });
  } catch (error) {
    console.error("❌ Error en POST /api/password/reset-request:", error.message);
    return res.status(error.code === "APP_URL_MISSING" ? 500 : 502).json({
      success: false,
      code: error.code || "SEND_FAILED",
      message:
        error.code === "APP_URL_MISSING"
          ? error.message
          : `No se pudo enviar el correo: ${error.message}`,
    });
  }
});

// La página /reset-password comprueba el token antes de mostrar el formulario.
app.get("/api/password/reset/validate", async (req, res) => {
  try {
    const reset = await findValidReset(String(req.query.token || ""));
    if (!reset) {
      return res.status(200).json({ success: true, valid: false });
    }
    return res.status(200).json({
      success: true,
      valid: true,
      username: reset.data.username,
      minPasswordLength: MIN_PASSWORD_LENGTH,
    });
  } catch (error) {
    console.error("❌ Error en GET /api/password/reset/validate:", error.message);
    return res.status(500).json({ success: false, message: "Error interno del servidor" });
  }
});

// Fija la contraseña nueva con el token del correo.
app.post("/api/password/reset", async (req, res) => {
  try {
    const { token, password } = req.body || {};

    const policyError = passwordPolicyError(password);
    if (policyError) {
      return res
        .status(400)
        .json({ success: false, code: "WEAK_PASSWORD", message: policyError });
    }

    const reset = await findValidReset(String(token || ""));
    if (!reset) {
      return res.status(400).json({
        success: false,
        code: "INVALID_TOKEN",
        message: "El enlace no es válido o ha caducado. Solicita uno nuevo.",
      });
    }

    const { username } = reset.data;
    const userRef = db.collection("users").doc(username);
    const userDoc = await userRef.get();
    if (!userDoc.exists || userDoc.data().active === false) {
      return res.status(400).json({
        success: false,
        code: "INVALID_TOKEN",
        message: "El enlace no es válido o ha caducado. Solicita uno nuevo.",
      });
    }

    await userRef.set(
      { passwordHash: await bcrypt.hash(password, 10), passwordChangedAt: Date.now() },
      { merge: true },
    );
    await reset.ref.set({ usedAt: Date.now() }, { merge: true });
    // Cualquier otro enlace pendiente del mismo usuario deja de servir.
    await invalidatePending(username);

    logEvent({
      type: EVENT.PASSWORD_RESET_COMPLETED,
      req,
      username,
      orgname: userDoc.data().orgname || null,
      orgId: userDoc.data().orgId || null,
      role: userDoc.data().role || null,
      success: true,
      message: "Contraseña restablecida mediante enlace.",
      detail: { solicitadoPor: reset.data.requestedBy },
    });

    return res.status(200).json({
      success: true,
      message: "Contraseña actualizada. Ya puedes iniciar sesión.",
    });
  } catch (error) {
    console.error("❌ Error en POST /api/password/reset:", error.message);
    return res.status(500).json({ success: false, message: "Error interno del servidor" });
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
    if (integrations.whaibot) {
      integrations.whaibot.templates = resolveWhatsappTemplates(integrations.whaibot);
      integrations.whaibot.dailyLimitPerOrg = resolveDailyLimit(integrations.whaibot);
    }
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
    const { botId, apiKey, enabled, templates } = req.body;

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
    invalidateWhaibotCache();

    console.log("💾 [Integración WhaiBot] configuración guardada");
    // El apiKey no viaja al log: sanitizeDetail lo descartaría igualmente.
    logEvent({
      type: EVENT.INTEGRATION_UPDATED,
      req,
      target: "whaibot",
      message: "Configuración de la integración WhaiBot actualizada.",
      detail: { botId: String(botId).trim(), habilitado: typeof enabled === "boolean" ? enabled : true },
    });

    // Las plantillas también se pueden guardar desde aquí, aunque tienen su
    // propia ruta para no exigir reenviar las credenciales.
    const cleanTemplates = sanitizeWhatsappTemplates(templates);
    if (cleanTemplates && Object.keys(cleanTemplates).length > 0) {
      await saveWhatsappTemplates(req, cleanTemplates);
    }
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

/** Guarda qué plantillas se notifican también por WhatsApp (afecta a todos). */
async function saveWhatsappTemplates(req, templates) {
  const cfg = await getWhaibotConfig({ force: true });
  const next = { ...resolveWhatsappTemplates(cfg), ...templates };
  await db
    .collection("integrations")
    .doc("whaibot")
    .set({ templates: next, updatedAt: Date.now() }, { merge: true });
  invalidateWhaibotCache();
  logEvent({
    type: EVENT.INTEGRATION_UPDATED,
    req,
    target: "whaibot",
    message: "Plantillas notificadas por WhatsApp actualizadas.",
    detail: { plantillas: next },
  });
  return next;
}

// Plantillas que se notifican por WhatsApp: { alert, recovered, current, previous }.
app.post("/api/integrations/whaibot/templates", requireAdmin, async (req, res) => {
  try {
    const clean = sanitizeWhatsappTemplates(req.body?.templates);
    if (!clean || Object.keys(clean).length === 0) {
      return res.status(400).json({
        success: false,
        message: `templates debe ser un objeto con valores boolean para: ${WHATSAPP_TEMPLATES.join(", ")}.`,
      });
    }
    const templates = await saveWhatsappTemplates(req, clean);
    return res.status(200).json({
      success: true,
      templates,
      message: "Plantillas de WhatsApp actualizadas.",
    });
  } catch (error) {
    console.error("❌ Error en POST /api/integrations/whaibot/templates:", error);
    return res
      .status(500)
      .json({ success: false, message: "Error interno del servidor", detail: error.message });
  }
});

// Tope de WhatsApp por organización y día: { dailyLimitPerOrg }.
app.post("/api/integrations/whaibot/daily-limit", requireAdmin, async (req, res) => {
  try {
    const value = Number(req.body?.dailyLimitPerOrg);
    if (!Number.isInteger(value) || value < 1 || value > 10000) {
      return res.status(400).json({
        success: false,
        message: "dailyLimitPerOrg debe ser un entero entre 1 y 10000.",
      });
    }
    await db
      .collection("integrations")
      .doc("whaibot")
      .set({ dailyLimitPerOrg: value, updatedAt: Date.now() }, { merge: true });
    invalidateWhaibotCache();
    logEvent({
      type: EVENT.INTEGRATION_UPDATED,
      req,
      target: "whaibot",
      message: `Límite diario de WhatsApp por organización: ${value}.`,
      detail: { dailyLimitPerOrg: value },
    });
    return res.status(200).json({ success: true, dailyLimitPerOrg: value, message: "Límite diario actualizado." });
  } catch (error) {
    console.error("❌ Error en POST /api/integrations/whaibot/daily-limit:", error);
    return res
      .status(500)
      .json({ success: false, message: "Error interno del servidor", detail: error.message });
  }
});

/**
 * ¿Puede la sesión actual usar WhatsApp? Hace falta la integración global y que
 * la organización de la sesión (la del JWT) lo tenga habilitado.
 */
async function whatsappStatusForSession(req) {
  const cfg = await getWhaibotConfig();
  const configured = isWhaibotConfigured(cfg);
  const enabled = isWhaibotEnabled(cfg);
  const orgDoc = await findOrgDoc(req.auth?.orgId);
  const orgEnabled = orgDoc ? isOrgWhatsappEnabled(orgDoc.data()) : false;
  return {
    enabled,
    configured,
    orgEnabled,
    // Lo único que debe mirar el dashboard para mostrar u ocultar la opción.
    available: enabled && orgEnabled,
    templates: resolveWhatsappTemplates(cfg),
  };
}

// Estado de WhatsApp para la sesión (sin exponer credenciales). Lo usan los
// usuarios para saber si deben ver la opción de notificaciones por WhatsApp.
app.get("/api/integrations/whaibot/status", async (req, res) => {
  try {
    const status = await whatsappStatusForSession(req);
    const userDoc = await sessionUserDoc(req);
    const prefs = userDoc ? userDoc.data().preferences || {} : {};
    return res.status(200).json({
      success: true,
      ...status,
      // Número del propio usuario, ya verificado (o null).
      verifiedNumber: prefs.whatsappVerifiedAt ? (prefs.whatsappRecipients || [])[0] || null : null,
    });
  } catch (error) {
    console.error("❌ Error en GET /api/integrations/whaibot/status:", error);
    return res.status(500).json({
      success: false,
      enabled: false,
      configured: false,
      orgEnabled: false,
      available: false,
    });
  }
});

// Enviar un mensaje de prueba de WhatsApp al número verificado del usuario.
// No acepta números en el cuerpo: así no es un primitivo de "enviar WhatsApp a
// números arbitrarios".
app.post("/api/integrations/whaibot/send-test", async (req, res) => {
  try {
    const status = await whatsappStatusForSession(req);
    if (!status.available) {
      return res.status(403).json({
        success: false,
        code: "WHATSAPP_DISABLED",
        message: "Las notificaciones por WhatsApp no están habilitadas para tu organización.",
      });
    }
    const userDoc = await sessionUserDoc(req);
    const prefs = userDoc ? userDoc.data().preferences || {} : {};
    const [number] = prefs.whatsappVerifiedAt ? normalizeNumbers(prefs.whatsappRecipients || []) : [];
    if (!number) {
      return res.status(400).json({
        success: false,
        code: "NOT_VERIFIED",
        message: "Primero verifica tu número de WhatsApp.",
      });
    }

    const cfg = await getWhaibotConfig();
    const result = await sendWhaibotMessage(cfg, number, whatsappText(prefs.language, "test"));
    return res.status(200).json({
      success: result.success,
      allSent: result.success,
      results: [result],
      message: result.success ? "Mensaje de prueba enviado correctamente." : result.message,
    });
  } catch (error) {
    console.error("❌ Error en POST /api/integrations/whaibot/send-test:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno al enviar el mensaje de prueba.",
      detail: error.message,
    });
  }
});

// ==================== Verificación del número de WhatsApp ====================
// Cada usuario registra UN número y sólo queda activo tras confirmar un código
// de 6 dígitos enviado por WhatsApp. El número y `whatsappVerifiedAt` los
// gestiona sólo el servidor: /api/setuser los ignora (ver
// withServerManagedWhatsapp), así que no se puede registrar un número ajeno.
//
//   whatsappVerifications/{username} → { number, codeHash, expiresAt, attempts, sends, windowStart, sentAt }

const WA_CODE_TTL_MINUTES = 10;
const WA_CODE_MAX_ATTEMPTS = 5;
const WA_CODE_RESEND_SECONDS = 60;
const WA_CODE_MAX_SENDS_PER_HOUR = 5;

function hashWhatsappCode(username, code) {
  return crypto
    .createHash("sha256")
    .update(`${username}:${code}:${process.env.JWT_SECRET || ""}`)
    .digest("hex");
}

async function sessionUserDoc(req) {
  const username = req.auth?.sub;
  if (!username) return null;
  const doc = await db.collection("users").doc(String(username)).get();
  return doc.exists ? doc : null;
}

// Paso 1: enviar el código al número indicado.
app.post("/api/whatsapp/verification/start", async (req, res) => {
  try {
    const status = await whatsappStatusForSession(req);
    if (!status.available) {
      return res.status(403).json({
        success: false,
        code: "WHATSAPP_DISABLED",
        message: "Las notificaciones por WhatsApp no están habilitadas para tu organización.",
      });
    }

    const [number] = normalizeNumbers(req.body?.number);
    if (!number || number.length > 15) {
      return res.status(400).json({ success: false, code: "INVALID_NUMBER", message: "Número de WhatsApp no válido." });
    }

    const userDoc = await sessionUserDoc(req);
    if (!userDoc) {
      return res.status(404).json({ success: false, message: "Usuario no encontrado." });
    }
    const username = userDoc.id;
    const ref = db.collection("whatsappVerifications").doc(username);
    const previous = (await ref.get()).data() || {};
    const now = Date.now();

    if (previous.sentAt && now - previous.sentAt < WA_CODE_RESEND_SECONDS * 1000) {
      return res.status(429).json({
        success: false,
        code: "RESEND_TOO_SOON",
        retryAfter: Math.ceil((WA_CODE_RESEND_SECONDS * 1000 - (now - previous.sentAt)) / 1000),
        message: "Espera un momento antes de pedir otro código.",
      });
    }
    const inWindow = previous.windowStart && now - previous.windowStart < 60 * 60 * 1000;
    const sends = inWindow ? previous.sends || 0 : 0;
    if (sends >= WA_CODE_MAX_SENDS_PER_HOUR) {
      return res.status(429).json({
        success: false,
        code: "TOO_MANY_CODES",
        message: "Demasiados códigos solicitados. Inténtalo de nuevo en una hora.",
      });
    }

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    const lang = userDoc.data().preferences?.language;
    const cfg = await getWhaibotConfig();
    const result = await sendWhaibotMessage(
      cfg,
      number,
      whatsappText(lang, "verification", { code, minutes: WA_CODE_TTL_MINUTES }),
    );
    if (!result.success) {
      return res.status(502).json({
        success: false,
        code: "SEND_FAILED",
        message: `No se pudo enviar el código por WhatsApp: ${result.message}`,
      });
    }

    await ref.set({
      number,
      codeHash: hashWhatsappCode(username, code),
      expiresAt: now + WA_CODE_TTL_MINUTES * 60 * 1000,
      attempts: 0,
      sentAt: now,
      sends: sends + 1,
      windowStart: inWindow ? previous.windowStart : now,
    });

    return res.status(200).json({
      success: true,
      expiresInMinutes: WA_CODE_TTL_MINUTES,
      message: "Código enviado por WhatsApp.",
    });
  } catch (error) {
    console.error("❌ Error en POST /api/whatsapp/verification/start:", error);
    return res.status(500).json({ success: false, message: "Error interno del servidor", detail: error.message });
  }
});

// Paso 2: confirmar el código. Si es correcto, el número queda registrado.
app.post("/api/whatsapp/verification/confirm", async (req, res) => {
  try {
    const code = String(req.body?.code || "").replace(/\D/g, "");
    if (code.length !== 6) {
      return res.status(400).json({ success: false, code: "INVALID_CODE", message: "El código debe tener 6 dígitos." });
    }

    const userDoc = await sessionUserDoc(req);
    if (!userDoc) {
      return res.status(404).json({ success: false, message: "Usuario no encontrado." });
    }
    const username = userDoc.id;
    const ref = db.collection("whatsappVerifications").doc(username);
    const snap = await ref.get();
    const pending = snap.exists ? snap.data() : null;

    if (!pending || !pending.codeHash) {
      return res.status(400).json({ success: false, code: "NO_PENDING", message: "No hay un código pendiente. Solicita uno nuevo." });
    }
    if (Date.now() > pending.expiresAt) {
      return res.status(400).json({ success: false, code: "CODE_EXPIRED", message: "El código venció. Solicita uno nuevo." });
    }
    if ((pending.attempts || 0) >= WA_CODE_MAX_ATTEMPTS) {
      return res.status(429).json({ success: false, code: "TOO_MANY_ATTEMPTS", message: "Demasiados intentos. Solicita un código nuevo." });
    }

    const expected = Buffer.from(pending.codeHash, "hex");
    const received = Buffer.from(hashWhatsappCode(username, code), "hex");
    if (!crypto.timingSafeEqual(expected, received)) {
      await ref.set({ attempts: (pending.attempts || 0) + 1 }, { merge: true });
      return res.status(400).json({
        success: false,
        code: "WRONG_CODE",
        attemptsLeft: WA_CODE_MAX_ATTEMPTS - (pending.attempts || 0) - 1,
        message: "Código incorrecto.",
      });
    }

    const verifiedAt = Date.now();
    await userDoc.ref.set(
      {
        preferences: {
          whatsappRecipients: [pending.number],
          whatsappVerifiedAt: verifiedAt,
          whatsappNotifications: true,
        },
      },
      { merge: true },
    );
    // Se conserva el ritmo de envíos para que borrar y volver a verificar no
    // permita saltarse el límite de códigos por hora.
    await ref.set(
      { codeHash: null, expiresAt: 0, attempts: 0 },
      { merge: true },
    );

    logEvent({
      type: EVENT.USER_UPDATED,
      req,
      target: username,
      message: "Número de WhatsApp verificado.",
      detail: { campos: "whatsappRecipients" },
    });

    // Mensaje de bienvenida: pide guardar el contacto y responder, lo que
    // mejora la entrega de los siguientes mensajes del bot.
    const cfg = await getWhaibotConfig();
    sendWhaibotMessage(cfg, pending.number, whatsappText(userDoc.data().preferences?.language, "verified")).catch(
      () => {},
    );

    return res.status(200).json({
      success: true,
      number: pending.number,
      verifiedAt,
      message: "Número de WhatsApp verificado.",
    });
  } catch (error) {
    console.error("❌ Error en POST /api/whatsapp/verification/confirm:", error);
    return res.status(500).json({ success: false, message: "Error interno del servidor", detail: error.message });
  }
});

// Quitar el número registrado (para cambiarlo hay que verificar otro).
app.post("/api/whatsapp/number/remove", async (req, res) => {
  try {
    const userDoc = await sessionUserDoc(req);
    if (!userDoc) {
      return res.status(404).json({ success: false, message: "Usuario no encontrado." });
    }
    await userDoc.ref.set(
      {
        preferences: {
          whatsappRecipients: [],
          whatsappVerifiedAt: null,
          whatsappNotifications: false,
        },
      },
      { merge: true },
    );
    return res.status(200).json({ success: true, message: "Número de WhatsApp eliminado." });
  } catch (error) {
    console.error("❌ Error en POST /api/whatsapp/number/remove:", error);
    return res.status(500).json({ success: false, message: "Error interno del servidor", detail: error.message });
  }
});

// ==================== Alertas de la plataforma ====================
// Contacto que recibe los errores de License Manager (correo y, si falla,
// WhatsApp). Ver utils/platformAlerts.js.

app.get("/api/settings/platform-alerts", requireAdmin, async (req, res) => {
  try {
    const settings = await getPlatformAlertSettings({ force: true });
    return res.status(200).json({ success: true, settings });
  } catch (error) {
    console.error("❌ Error en GET /api/settings/platform-alerts:", error);
    return res.status(500).json({ success: false, message: "Error interno del servidor" });
  }
});

app.post("/api/settings/platform-alerts", requireAdmin, async (req, res) => {
  try {
    const { enabled, email, whatsapp } = req.body || {};
    const settings = await savePlatformAlertSettings({ enabled, email, whatsapp });
    logEvent({
      type: EVENT.INTEGRATION_UPDATED,
      req,
      target: "platformAlerts",
      message: "Contacto de alertas de la plataforma actualizado.",
      detail: { habilitado: settings.enabled, correo: settings.email, whatsapp: settings.whatsapp },
    });
    return res.status(200).json({ success: true, settings, message: "Alertas de la plataforma guardadas." });
  } catch (error) {
    console.error("❌ Error en POST /api/settings/platform-alerts:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
});

// Envío de prueba por un canal concreto: { channel: "email" | "whatsapp" }.
app.post("/api/settings/platform-alerts/test", requireAdmin, async (req, res) => {
  const channel = req.body?.channel === "whatsapp" ? "whatsapp" : "email";
  try {
    await deliverAlert(
      {
        source: "prueba",
        title: "Prueba de alertas de la plataforma",
        message: `Mensaje de prueba solicitado por ${req.auth?.sub || "el administrador"}. Si lo recibes, las alertas de License Manager llegan a este contacto.`,
        at: Date.now(),
      },
      { force: true, channel },
    );
    return res.status(200).json({ success: true, channel, message: "Alerta de prueba enviada." });
  } catch (error) {
    return res.status(200).json({ success: false, channel, message: error.message });
  }
});

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

// ==================== Errores no controlados ====================
// Último manejador: errores lanzados por una ruta (o por express.json con un
// cuerpo inválido) que nadie capturó. Responde JSON sin la traza; el aviso al
// contacto de alertas lo emite serverErrorMonitor al ver el 500.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number(err.status || err.statusCode) || 500;
  if (status >= 500) console.error(`❌ Error no controlado en ${req.method} ${req.path}:`, err);
  return res.status(status).json({
    success: false,
    message: status >= 500 ? "Error interno del servidor" : err.message,
    detail: status >= 500 ? err.message : undefined,
  });
});

process.on("unhandledRejection", (reason) => {
  console.error("❌ Promesa rechazada sin manejar:", reason);
  notifyPlatformError({
    source: "proceso",
    title: "Promesa rechazada sin manejar",
    message: reason instanceof Error ? reason.message : String(reason),
    detail: reason instanceof Error ? reason.stack : undefined,
  });
});

process.on("uncaughtException", (error) => {
  console.error("❌ Excepción no capturada:", error);
  notifyPlatformError({
    source: "proceso",
    title: "Excepción no capturada: la API se reinicia",
    message: error.message,
    detail: error.stack,
  });
  // El proceso queda en un estado indefinido: se sale (el orquestador de
  // contenedores lo reinicia) tras dar unos segundos al aviso.
  setTimeout(() => process.exit(1), 5000).unref();
});
