require("dotenv").config();
const express = require("express");
const cors = require("cors");
const platformClient = require("purecloud-platform-client-v2");
const { Resend } = require("resend");

const app = express();
const port = process.env.PORT || 4000;

// Middlewares
app.use(cors({
  origin: true,
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

const bcrypt = require("bcryptjs");

// Importar configuración de Firebase
const { db } = require("./firebase");

// Inicializar Resend
const resend = new Resend(process.env.RESEND_API_KEY);

// Helper para obtener token internamente
async function getTokenForRegion(clientId, clientSecret, region) {
  const response = await fetch(`http://localhost:${port}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, clientSecret, region }),
  });
  const data = await response.json();
  if (data.success) {
    return data.token;
  }
  throw new Error(data.error || "Error obteniendo token");
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
      return res
        .status(401)
        .json({ success: false, message: "Usuario no encontrado." });
    }

    const userFound = userDoc.data();
    console.log(
      `👤 Usuario encontrado: username="${cleanUsername}" | role="${userFound.role}" | orgname="${userFound.orgname}" | thrusted="${userFound.thrusted}"`,
    );

    // Si no es admin, validar permisos
    if (userFound.role !== "administrator") {
      let hasAccess = false;

      // Si es supervisor, puede entrar a cualquier organización que pertenezca a su 'thrusted'
      if (userFound.role === "supervisor") {
        console.log(
          `🔍 [Supervisor] Buscando org "${orgname}" con thrusted="${userFound.thrusted}" en colección organizations...`,
        );
        const orgSnapshot = await db
          .collection("organizations")
          .where("orgname", "==", orgname)
          .where("thrusted", "==", userFound.thrusted)
          .get();

        if (!orgSnapshot.empty) {
          hasAccess = true;
          console.log(
            `✅ [Supervisor] Org encontrada: "${orgname}" pertenece al thrusted "${userFound.thrusted}"`,
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

    // Verificar contraseña
    console.log(`🔐 Verificando contraseña para "${cleanUsername}"...`);
    const passwordMatch = await bcrypt.compare(
      password,
      userFound.passwordHash,
    );
    if (!passwordMatch) {
      console.error(`❌ [Contraseña incorrecta] username="${cleanUsername}"`);
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
        `🔑 Obteniendo token para región (thrusted): ${userFound.thrusted}`,
      );
      const orgCred = regionEnvMap.find(
        (cred) => cred.name === userFound.thrusted,
      );
      if (!orgCred) {
        return res.status(500).json({
          success: false,
          message: `Credenciales no encontradas para thrusted: ${userFound.thrusted}`,
        });
      }
      tokens = await getTokenForRegion(
        orgCred.clientId,
        orgCred.clientSecret,
        orgCred.region,
      );
      console.log("Token obtenido:", tokens);
    }

    // Construir el objeto de usuario a devolver al front
    let userResponse = { ...userFound };

    // Si es supervisor, sobrescribir orgname, orgId, clientId, clientSecret y region
    // con los datos de la organización a la que está iniciando sesión,
    // ya que puede navegar en cualquier org hija de su thrusted
    if (userFound.role === "supervisor") {
      const targetOrgSnapshot = await db
        .collection("organizations")
        .where("orgname", "==", orgname)
        .get();

      if (!targetOrgSnapshot.empty) {
        const targetOrgDoc = targetOrgSnapshot.docs[0];
        const targetOrgData = targetOrgDoc.data();

        userResponse.orgname    = orgname;
        userResponse.orgId      = targetOrgData.orgId      || targetOrgDoc.id;
        userResponse.clientId   = targetOrgData.clientId   || "";
        userResponse.clientSecret = targetOrgData.clientSecret || "";
        userResponse.region     = targetOrgData.region     || userFound.region;

        console.log(
          `🏢 Supervisor sesión en org: ${orgname} | orgId: ${userResponse.orgId} | clientId: ${userResponse.clientId}`,
        );
      }
    }

    return res.status(200).json({
      success: true,
      message: "Login exitoso",
      user: userResponse,
      token: tokens,
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno del servidor.",
      details: error.message,
    });
  }
});
app.post("/api/token", async (req, res) => {
  try {
    const { clientId, clientSecret, region } = req.body;

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
        default:
          console.error(`Región no reconocida: ${region}`);
      }
    }

    console.log(`Configurando región: ${region}, URL: ${url}`);
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

// Iniciar el servidor
app.listen(port, () => {
  console.log(`✅ API de Node.js corriendo en http://localhost:${port}`);
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
        default:
          console.error(`Región no reconocida: ${region}`);
      }
    }

    console.log(`Configurando región: ${region}, URL: ${url}`);
    client.setEnvironment(url);
    client.setAccessToken(accessToken);

    const apiInstance = new platformClient.BillingApi();
    const opts = {
      billingPeriodIndex: Number(billingPeriodIndex),
    };

    const data = await apiInstance.getBillingTrusteebillingoverviewTrustorOrgId(
      trustorOrgId,
      opts,
    );

    console.log("✅ Billing overview obtenido para:", trustorOrgId);
    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("❌ Error al obtener billing overview:", error);

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
      default:
        console.error(`Región no reconocida: ${region}`);
        url = "null";
    }
  }
  return url;
};

const formatUsersDivision = (data) => {
  const listUsers = data.results.map((user) => ({
    divisionId: user.divisionId,
    email: user.contactInfo?.email_main?.[0]?.value || "",
    uuid: user.guid,
  }));
  // agrupar por divisionID
  return listUsers.reduce((acc, user) => {
    if (!acc[user.divisionId]) {
      acc[user.divisionId] = [];
    }
    acc[user.divisionId].push(user);
    return acc;
  }, {});
};

async function getUsersDivision(accessToken, region) {
  try {
    let allResults = [];
    let pageNumber = 1;
    let totalPages = 1;

    do {
      const response = await fetch(`${getRegionUrl(region)}/api/v2/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          pageSize: 100,
          pageNumber: pageNumber,
          returnFields: ["divisionId", "email"],
          types: ["users"],
          query: [
            {
              type: "MATCH_ALL",
              fields: ["email"],
            },
          ],
        }),
      });
      const result = await response.json();

      if (pageNumber === 1 && result.pageCount) {
        totalPages = result.pageCount;
      }

      if (result.results && result.results.length > 0) {
        allResults = [...allResults, ...result.results];
      }

      pageNumber++;
    } while (pageNumber <= totalPages);

    console.log("Total users fetched:", allResults.length);
    return formatUsersDivision({ results: allResults });
  } catch (error) {
    console.error("⚠️ Error al obtener usuarios:", error);
    return {};
  }
}

const formatDivisions = async (data, accessToken, region) => {
  const divisiones = await getUsersDivision(accessToken, region);

  return data.entities.map((division) => ({
    id: division.id,
    name: division.name,
    description: division.description,
    users: divisiones[division.id] || [],
  }));
};

async function getDivisions(accessToken, region) {
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
    return await formatDivisions(result, accessToken, region);
  } catch (error) {
    console.error("⚠️ Error al obtener divisiones:", error);
    throw error;
  }
}

// Endpoint para obtener Divisions Data
app.post("/api/divisionsdata", async (req, res) => {
  try {
    const { accessToken, region } = req.body;

    if (!accessToken || !region) {
      return res.status(400).json({
        success: false,
        message: "Se requieren accessToken y region",
      });
    }

    const dataFormated = await getDivisions(accessToken, region);

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

// Endpoint para manejar la creación, actualización y obtención de usuarios
app.get("/api/setuser", async (req, res) => {
  try {
    const { username, orgname } = req.query;

    // Si consultan uno específico
    if (username && orgname) {
      const userDoc = await db.collection("users").doc(username.trim()).get();
      if (!userDoc.exists) {
        return res.status(404).json({ message: "Usuario no encontrado." });
      }
      return res.status(200).json(userDoc.data());
    }

    // Si no se envían parámetros, lista todos los usuarios mapeados en formato de organizaciones (como lo hacía DynamoDB)
    const orgsSnapshot = await db.collection("organizations").get();
    const usersSnapshot = await db.collection("users").get();

    let orgsList = orgsSnapshot.docs.map((doc) => ({
      ...doc.data(),
      orgId: doc.id,
      users: [],
    }));
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
          orgId: u.orgId,
          region: u.region,
          thrusted: u.thrusted,
          criticalMetrics: [],
          users: [],
        };
        orgsList.push(org);
      }
      // Agregamos el usuario con el formato exacto que espera el frontend / settings
      org.users.push({
        username: u.username,
        passwordHash: u.passwordHash,
        user: u, // Todo el detalle dentro de la propiedad 'user'
      });
    });

    return res.status(200).json(orgsList);
  } catch (error) {
    console.error("❌ Error en GET /api/setuser:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

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
    const userRef = db.collection("users").doc(cleanUsername);
    const userDoc = await userRef.get();

    const orgId = body.orgId || userToCreate.orgId || orgname;
    const orgRef = db.collection("organizations").doc(orgId);

    // Validar si el usuario NO existe y no estamos en modo actualización
    if (!userDoc.exists && mode !== "update") {
      if (!userData.password) {
        return res.status(400).json({
          success: false,
          message: "La contraseña es requerida para la creación de usuario.",
        });
      }
      const passwordHash = await bcrypt.hash(userData.password, 10);

      // Creamos/Actualizamos la Organización
      await orgRef.set(
        {
          orgname: orgname,
          thrusted: body.thrusted || userToCreate.thrusted || "N/A",
          region: body.region || userToCreate.region || "us-east-1",
          criticalMetrics: [],
        },
        { merge: true },
      );

      // Creamos el Usuario
      const firestoreUser = {
        username: cleanUsername,
        passwordHash: passwordHash,
        role: userToCreate.role || "client",
        thrusted: userToCreate.thrusted || body.thrusted || "N/A",
        orgname: orgname,
        orgId: orgId,
        region: userToCreate.region || body.region || "us-east-1",
        clientId: userToCreate.clientId || "",
        clientSecret: userToCreate.clientSecret || "",
        preferences: userToCreate.preferences || {},
      };
      await userRef.set(firestoreUser);

      return res.status(201).json({
        success: true,
        message: `Usuario ${cleanUsername} creado exitosamente.`,
      });
    } else {
      // Update
      const updates = { ...userToCreate, orgname: orgname };
      delete updates.password; // Prevenir guardado plano

      // Si el usuario provee una nueva contraseña (no vacía)
      if (userData.password && userData.password.trim() !== "") {
        updates.passwordHash = await bcrypt.hash(userData.password, 10);
      }

      await userRef.set(updates, { merge: true });

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

// Endpoint para enviar correos usando Resend
app.post("/api/sendmail", async (req, res) => {
  const { to, subject, message } = req.body;

  // Establece el remitente fijo
  const fromEmail =
    "License Manager <notificaciones@genesys-metrics.cambialapp.com>";

  if (!to || !subject || !message || !Array.isArray(to) || to.length === 0) {
    return res.status(400).json({
      success: false,
      message:
        "Faltan parámetros o 'to' no es una lista válida de destinatarios.",
    });
  }

  try {
    const { data, error } = await resend.emails.send({
      from: fromEmail,
      to: to,
      subject: subject,
      html: message,
    });

    if (error) {
      console.error("❌ Error devuelto por Resend:", error);
      return res.status(400).json({
        success: false,
        message: "Resend Error: " + error.message,
      });
    }

    console.log("✅ Correo enviado con éxito. ID:", data.id);
    return res.status(200).json({
      success: true,
      message: "Correos enviados con éxito",
      id: data.id,
    });
  } catch (error) {
    console.error("❌ Error al enviar correo (Resend):", error);
    return res.status(500).json({
      success: false,
      message:
        "Error al enviar correo: " + (error.message || "Error desconocido"),
    });
  }
});

// Endpoint de prueba para guardar algo en Firestore
app.post("/api/firestore-test", async (req, res) => {
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
