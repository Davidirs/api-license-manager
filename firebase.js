const admin = require('firebase-admin');

// Si tienes el archivo JSON descargado desde Firebase, puedes cargarlo así:
// const serviceAccount = require('./serviceAccountKey.json');

// Opcionalmente, puedes configurar las credenciales a través de variables de entorno (recomendado para producción)
// para esto tendrías que guardar el stringificado de tu JSON de credenciales en tu archivo .env
// const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

let db;

try {
  // Inicializamos Firebase Admin.
  // IMPORTANTE: Debes colocar tu archivo serviceAccountKey.json en esta carpeta (api-server)
  // y descomentar la línea de abajo, o usar variables de entorno.
  
  // Opción 1: Archivo JSON local (asegúrate de agregarlo a .gitignore)
  const serviceAccount = require('./serviceAccountKey.json');
  
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  db = admin.firestore();
  console.log('🔥 Conexión a Firebase Firestore exitosa.');
} catch (error) {
  console.error('❌ Error al inicializar Firebase Admin:', error);
  console.error('⚠️  Asegúrate de tener el archivo serviceAccountKey.json en la carpeta api-server');
}

module.exports = { admin, db };
