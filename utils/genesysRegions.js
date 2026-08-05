// Mapa de regiones de Genesys Cloud → hosts de API y de login.
// Se mantiene aquí (y no en index.js) para que los servicios de monitoreo
// puedan resolver regiones sin depender del arranque del servidor Express.

const REGION_API_HOSTS = {
  "us-east-1": "https://api.mypurecloud.com",
  "us-west-2": "https://api.usw2.pure.cloud",
  "us-east-2": "https://api.use2.pure.cloud",
  "ca-central-1": "https://api.cac1.pure.cloud",
  "sa-east-1": "https://api.sae1.pure.cloud",
  "eu-west-1": "https://api.euw1.pure.cloud",
  "eu-central-1": "https://api.euc1.pure.cloud",
  "eu-west-2": "https://api.euw2.pure.cloud",
  "eu-central-2": "https://api.euc2.pure.cloud",
  "ap-south-1": "https://api.aps1.pure.cloud",
  "ap-northeast-1": "https://api.apne1.pure.cloud",
  "ap-northeast-2": "https://api.apne2.pure.cloud",
  "ap-northeast-3": "https://api.apne3.pure.cloud",
  "ap-southeast-2": "https://api.apse2.pure.cloud",
  "me-central-1": "https://api.mec1.pure.cloud",
  "mx-central-1": "https://api.mxc1.pure.cloud",
};

const DEFAULT_REGION = "us-east-1";

function getApiUrl(region) {
  return REGION_API_HOSTS[region] || REGION_API_HOSTS[DEFAULT_REGION];
}

function getLoginUrl(region) {
  return getApiUrl(region).replace("https://api.", "https://login.");
}

function isKnownRegion(region) {
  return Boolean(REGION_API_HOSTS[region]);
}

/**
 * Client Credentials Grant vía HTTP directo.
 *
 * Deliberadamente NO se usa `platformClient.ApiClient.instance`: ese singleton
 * guarda región y token a nivel de proceso, así que dos organizaciones
 * procesadas en paralelo (o un request del dashboard concurrente con el cron)
 * se pisan entre sí y pueden devolver datos de la org equivocada.
 */
async function fetchOrgToken(clientId, clientSecret, region, { timeoutMs = 15000 } = {}) {
  if (!clientId || !clientSecret) {
    throw new Error("clientId y clientSecret son requeridos para obtener el token");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const response = await fetch(`${getLoginUrl(region)}/oauth/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`OAuth ${response.status} en ${region}: ${detail.slice(0, 200)}`);
    }

    const data = await response.json();
    if (!data.access_token) {
      throw new Error("La respuesta de OAuth no incluyó access_token");
    }

    return {
      accessToken: data.access_token,
      // Renovamos con 60s de margen para no usar un token recién expirado.
      expiresAt: Date.now() + (Number(data.expires_in || 3600) - 60) * 1000,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  REGION_API_HOSTS,
  DEFAULT_REGION,
  getApiUrl,
  getLoginUrl,
  isKnownRegion,
  fetchOrgToken,
};
