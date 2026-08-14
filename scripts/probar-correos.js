/**
 * Prueba de las plantillas de correo en los tres idiomas.
 *
 *   node scripts/probar-correos.js --render
 *       Genera los HTML en scripts/salida-correos/ SIN enviar nada.
 *       Es la forma recomendada de revisar textos y maquetación.
 *
 *   node scripts/probar-correos.js --to tu@correo.com --lang en
 *       Envía de verdad las 6 plantillas en inglés a esa dirección.
 *
 *   node scripts/probar-correos.js --to tu@correo.com --lang all --tipo alert
 *       Envía sólo la plantilla 'alert', en los tres idiomas.
 *
 * Opciones:
 *   --render        No envía; escribe los HTML en disco.
 *   --to <correo>   Destinatario. Obligatorio salvo con --render.
 *   --lang <código> es | en | pt | all   (por defecto: all)
 *   --tipo <nombre> current | previous | alert | recovered | newuser | userupdated
 *                   (por defecto: todas)
 *
 * Ojo: con ENTORNO=STAGING el envío está bloqueado a propósito y el script
 * avisará. Para probar envíos reales usa un entorno que no sea STAGING.
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const {
  generateNotificationEmailTemplate,
  generateTemplate,
} = require("../utils/emailTemplates");
const { SUPPORTED_LANGUAGES } = require("../utils/emailI18n");
const { currentEnv, notificationsBlocked } = require("../utils/environment");
const { getEmailSettings } = require("../utils/appSettings");
const { sendMail } = require("../utils/mailer");

// ── Argumentos ───────────────────────────────────────────────────────────────

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const soloRender = process.argv.includes("--render");
const destinatario = arg("to");
const idiomaPedido = (arg("lang", "all") || "all").toLowerCase();
const tipoPedido = arg("tipo");

const NOTIFICACIONES = ["current", "previous", "alert", "recovered"];
const TRANSACCIONALES = ["newuser", "userupdated"];
const TODAS = [...NOTIFICACIONES, ...TRANSACCIONALES];

const idiomas = idiomaPedido === "all" ? SUPPORTED_LANGUAGES : [idiomaPedido];
const tipos = tipoPedido ? [tipoPedido] : TODAS;

// ── Datos de ejemplo ─────────────────────────────────────────────────────────
// Imitan la forma de lo que manda el monitor, para que las plantillas se vean
// con contenido realista (sobreuso, proyección, coste estimado…).

const cliente = {
  name: "ACME Corp",
  facturacion: { inicio: "2026-07-28", final: "2026-08-27" },
};

const kpis = [
  {
    name: "Genesys Cloud 3", category: "licencia", used: 1180, total: 1000,
    included: 0, unit: "", percentage: 118, overage: 180, estimatedCost: 1350.5,
    status: "exceeded", label: "Genesys Cloud 3: 1180/1000",
  },
  {
    name: "BYOC Cloud", category: "fairuse", used: 5200, total: 0,
    included: 4000, unit: "min", percentage: null, overage: 1200,
    estimatedCost: 1.44, status: "on_demand", label: "BYOC Cloud: 5200 min",
  },
  {
    name: "Almacenamiento", category: "almacenamiento", used: 355, total: 500,
    included: 0, unit: "GB", percentage: 71, overage: 0, estimatedCost: 0,
    status: "ok", label: "Almacenamiento: 355/500 GB",
  },
];

const payloadNotificacion = {
  client: cliente,
  kpis,
  critical: [kpis[0], kpis[1]],
  threshold: 90,
  estimatedCost: 1351.94,
  periodClosed: false,
  resolved: ["Almacenamiento"],
  projection: {
    elapsedDays: 16, totalDays: 30,
    items: [{ name: "Genesys Cloud 3", projectedPercentage: 145 }],
  },
};

const payloadTransaccional = {
  orgname: "ACME Corp",
  usuario: "persona@acme.com",
  password: "Temporal-1234",
  role: "client",
};

// ── Ejecución ────────────────────────────────────────────────────────────────

function construir(tipo, lang, settings) {
  const esNotificacion = NOTIFICACIONES.includes(tipo);
  if (esNotificacion) {
    return generateNotificationEmailTemplate(tipo, {
      ...payloadNotificacion, settings, lang,
    });
  }
  return generateTemplate(tipo, { ...payloadTransaccional, settings, lang });
}

(async () => {
  const desconocidos = tipos.filter((t) => !TODAS.includes(t));
  if (desconocidos.length > 0) {
    console.error(`❌ Plantilla desconocida: ${desconocidos.join(", ")}`);
    console.error(`   Disponibles: ${TODAS.join(", ")}`);
    process.exit(1);
  }

  const idiomasNoValidos = idiomas.filter((l) => !SUPPORTED_LANGUAGES.includes(l));
  if (idiomasNoValidos.length > 0) {
    console.error(`❌ Idioma no soportado: ${idiomasNoValidos.join(", ")}`);
    console.error(`   Disponibles: ${SUPPORTED_LANGUAGES.join(", ")}, o "all"`);
    process.exit(1);
  }

  const settings = await getEmailSettings({ force: true });
  console.log(`Entorno: ${currentEnv()} | Remitente: ${settings.from} | Envío habilitado: ${settings.enabled !== false}`);

  // ── Modo render: no se envía nada ──────────────────────────────────────────
  if (soloRender) {
    const dir = path.join(__dirname, "salida-correos");
    fs.mkdirSync(dir, { recursive: true });

    for (const lang of idiomas) {
      for (const tipo of tipos) {
        const { subject, html } = construir(tipo, lang, settings);
        const archivo = path.join(dir, `${lang}-${tipo}.html`);
        fs.writeFileSync(archivo, html, "utf8");
        console.log(`  ✅ ${lang}/${tipo.padEnd(12)} → ${path.relative(process.cwd(), archivo)}`);
        console.log(`     asunto: ${subject}`);
      }
    }
    console.log(`\n📂 Abre los HTML de ${path.relative(process.cwd(), dir)} en el navegador.`);
    process.exit(0);
  }

  // ── Modo envío real ────────────────────────────────────────────────────────
  if (!destinatario) {
    console.error("❌ Falta --to <correo>. Usa --render si sólo quieres ver el HTML.");
    process.exit(1);
  }

  if (notificationsBlocked()) {
    console.error(`\n🚫 ENTORNO=${currentEnv()}: los envíos están bloqueados a propósito.`);
    console.error("   Es la protección para que staging no duplique los correos de producción.");
    console.error("   Usa --render, o ejecuta con otro ENTORNO.");
    process.exit(1);
  }

  if (settings.enabled === false) {
    console.error("\n🚫 El envío está deshabilitado en settings/email (panel de administrador).");
    process.exit(1);
  }

  console.log(`\nEnviando ${idiomas.length * tipos.length} correo(s) a ${destinatario}…\n`);

  let fallos = 0;
  for (const lang of idiomas) {
    for (const tipo of tipos) {
      const { subject, html, text } = construir(tipo, lang, settings);
      // El asunto se prefija con el idioma para distinguirlos en la bandeja.
      const asunto = `[${lang.toUpperCase()}] ${subject}`;
      try {
        const r = await sendMail({
          from: settings.from,
          to: [destinatario],
          subject: asunto,
          html,
          text,
          replyTo: settings.replyTo,
        });
        console.log(`  ✅ ${lang}/${tipo.padEnd(12)} ${asunto}`);
        if (r.rejected?.length) console.log(`     ⚠️ rechazados: ${r.rejected.join(", ")}`);
      } catch (error) {
        fallos++;
        console.error(`  ❌ ${lang}/${tipo.padEnd(12)} ${error.message}`);
      }
    }
  }

  console.log(fallos === 0 ? "\n🎉 Envío completado." : `\n💥 ${fallos} envío(s) fallaron.`);
  process.exit(fallos ? 1 : 0);
})().catch((error) => {
  console.error("💥 Error inesperado:", error);
  process.exit(1);
});
