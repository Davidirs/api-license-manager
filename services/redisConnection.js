// Conexión Redis compartida por todas las colas de BullMQ.
//
// Antes cada servicio creaba su propio IORedis; con varias colas eso multiplica
// conexiones contra el mismo Redis sin necesidad.

const IORedis = require("ioredis");

const entorno = process.env.ENTORNO || "DEV";
// Se usa Redis si NO es DEV, o si se pasó explícitamente REDIS_HOST.
const queueEnabled = Boolean(entorno !== "DEV" || process.env.REDIS_HOST);

let connection = null;

function isQueueEnabled() {
  return queueEnabled;
}

function getRedisConnection() {
  if (!queueEnabled) return null;

  if (!connection) {
    const config = {
      host: process.env.REDIS_HOST || "localhost",
      port: Number(process.env.REDIS_PORT) || 6379,
      // Requerido por BullMQ para los comandos bloqueantes del worker.
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };

    if (process.env.REDIS_USERNAME) config.username = process.env.REDIS_USERNAME;
    if (process.env.REDIS_PASSWORD) config.password = process.env.REDIS_PASSWORD;

    connection = new IORedis(config);

    connection.on("error", (err) => {
      console.error("❌ [Redis] Error de conexión:", err.message);
    });
    connection.on("connect", () => {
      console.log(`🔌 [Redis] Conectado a ${config.host}:${config.port}`);
    });
  }

  return connection;
}

module.exports = { getRedisConnection, isQueueEnabled };
