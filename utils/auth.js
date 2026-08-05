// Autenticación y saneamiento de respuestas.
//
// Antes ningún endpoint validaba quién llamaba: un GET sin credenciales a
// /api/setuser devolvía el clientId/clientSecret de Genesys de todas las
// organizaciones y el passwordHash de todos los usuarios. Aquí vive la capa
// que cierra eso.

const jwt = require("jsonwebtoken");

const TOKEN_TTL = process.env.JWT_TTL || "12h";

// Campos que NUNCA deben salir de la API hacia el cliente.
const USER_SECRET_FIELDS = ["passwordHash", "password", "clientId", "clientSecret"];
const ORG_SECRET_FIELDS = ["clientId", "clientSecret"];

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "JWT_SECRET no está configurado (o es demasiado corto). Genere uno con: openssl rand -hex 32",
    );
  }
  return secret;
}

function isAuthConfigured() {
  return Boolean(process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16);
}

function signSession(user) {
  return jwt.sign(
    {
      sub: user.username,
      role: user.role,
      orgname: user.orgname,
      orgId: user.orgId || null,
    },
    getSecret(),
    { expiresIn: TOKEN_TTL },
  );
}

function verifySession(token) {
  return jwt.verify(token, getSecret());
}

/** Quita del objeto de usuario todo lo que no debe viajar al navegador. */
function sanitizeUser(user) {
  if (!user || typeof user !== "object") return user;
  const clean = { ...user };
  USER_SECRET_FIELDS.forEach((field) => delete clean[field]);
  return clean;
}

/**
 * Quita las credenciales OAuth de una organización.
 * `hasCredentials` permite que la UI muestre si están configuradas sin revelarlas.
 */
function sanitizeOrg(org) {
  if (!org || typeof org !== "object") return org;
  const clean = { ...org };
  const hasCredentials = Boolean(org.clientId && org.clientSecret);
  ORG_SECRET_FIELDS.forEach((field) => delete clean[field]);
  clean.hasCredentials = hasCredentials;
  return clean;
}

function extractToken(req) {
  const header = req.headers.authorization || "";
  if (header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  return null;
}

/**
 * Rutas accesibles sin sesión. Todo lo demás exige un JWT válido.
 * Se listan como prefijos exactos para no abrir de más por accidente.
 */
const PUBLIC_PATHS = new Set([
  "/api/login",
  "/api/health",
]);

/**
 * Middleware global. Falla cerrado: si JWT_SECRET no está configurado, la API
 * responde 503 en vez de quedar abierta.
 */
function authMiddleware(req, res, next) {
  if (req.method === "OPTIONS") return next();
  if (PUBLIC_PATHS.has(req.path)) return next();

  if (!isAuthConfigured()) {
    return res.status(503).json({
      success: false,
      message:
        "La API no está configurada correctamente: falta JWT_SECRET. Contacte al administrador.",
    });
  }

  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ success: false, message: "Sesión requerida.", code: "NO_TOKEN" });
  }

  try {
    req.auth = verifySession(token);
    return next();
  } catch (error) {
    const expired = error.name === "TokenExpiredError";
    return res.status(401).json({
      success: false,
      message: expired ? "La sesión expiró." : "Sesión inválida.",
      code: expired ? "TOKEN_EXPIRED" : "INVALID_TOKEN",
    });
  }
}

/** Exige uno de los roles indicados. Usar después de authMiddleware. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.auth) {
      return res.status(401).json({ success: false, message: "Sesión requerida." });
    }
    if (!roles.includes(req.auth.role)) {
      console.warn(
        `⛔ [Auth] "${req.auth.sub}" (${req.auth.role}) intentó acceder a ${req.method} ${req.path}`,
      );
      return res.status(403).json({
        success: false,
        message: "No tienes permisos para realizar esta acción.",
      });
    }
    return next();
  };
}

const requireAdmin = requireRole("administrator");

module.exports = {
  signSession,
  verifySession,
  sanitizeUser,
  sanitizeOrg,
  authMiddleware,
  requireRole,
  requireAdmin,
  isAuthConfigured,
  PUBLIC_PATHS,
};
