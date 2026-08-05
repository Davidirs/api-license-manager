const {
  STATUS,
  buildKpis,
  classify,
  signatureFor,
  formatValue,
  toNumber,
} = require("./monitorMetrics");
const { DEFAULT_EMAIL_SETTINGS } = require("./appSettings");

function formatDate(dateString) {
  if (!dateString) return "—";
  const d = new Date(dateString);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("es-ES", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatMoney(amount) {
  return `$${toNumber(amount).toLocaleString("es-MX", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} USD`;
}

function getProgressBarColor(percentage) {
  if (percentage === null) return "#64748b"; // Sin compromiso: gris
  if (percentage >= 100) return "#dc2626";
  if (percentage >= 90) return "#dc2626";
  if (percentage >= 75) return "#ea580c";
  if (percentage >= 50) return "#eab308";
  return "#16a34a";
}

const STATUS_LABEL = {
  [STATUS.EXCEEDED]: "SOBREUSO",
  [STATUS.WARNING]: "UMBRAL SUPERADO",
  [STATUS.ON_DEMAND]: "CONSUMO ON-DEMAND",
  [STATUS.OK]: "En rango",
};

const CATEGORY_LABEL = {
  licencia: "Licencias",
  addon: "Add-ons",
  recurso: "Recursos",
  ai: "AI Experience",
  dispositivo: "Dispositivos",
  almacenamiento: "Almacenamiento",
  tokens: "IA Tokens",
  fairuse: "Fair Use (Voz y Outbound)",
};

const CATEGORY_ORDER = [
  "licencia",
  "addon",
  "fairuse",
  "recurso",
  "ai",
  "tokens",
  "almacenamiento",
  "dispositivo",
];

function footerHtml(settings) {
  const support = settings.supportEmail || DEFAULT_EMAIL_SETTINGS.supportEmail;
  return `<p style="margin: 0; padding: 0; font-size: 14px; opacity: 0.8; color: white;">
                Este correo fue enviado automáticamente por el sistema de monitoreo de <strong>License Manager</strong>.<br />
                Si tienes dudas, contáctanos a <a href="mailto:${support}" style="color: #60a5fa;">${support}</a>.<br />
                © ${new Date().getFullYear()} License Manager
              </p>`;
}

/**
 * Normaliza la entrada de las plantillas de notificación.
 *
 * Acepta dos formas:
 *  - El payload nuevo del monitor: { client, kpis, critical, threshold, ... }
 *  - El `clientData` crudo (envíos manuales desde /api/sendmail del dashboard),
 *    en cuyo caso se calculan los KPIs aquí con el umbral por defecto.
 */
function normalizePayload(payload = {}) {
  const isMonitorPayload = Boolean(payload && payload.client);
  const client = isMonitorPayload ? payload.client : payload;
  const settings = { ...DEFAULT_EMAIL_SETTINGS, ...(payload.settings || {}) };
  const threshold = toNumber(payload.threshold) || 90;

  let kpis = isMonitorPayload && Array.isArray(payload.kpis) ? payload.kpis : null;
  if (!kpis) {
    kpis = buildKpis(client || {}, payload.extras || {}).map((kpi) => {
      const status = classify(kpi, threshold);
      return {
        ...kpi,
        status,
        signature: signatureFor(kpi, status),
        label: `${kpi.name}: ${formatValue(kpi)}`,
      };
    });
  }

  const critical =
    isMonitorPayload && Array.isArray(payload.critical)
      ? payload.critical
      : kpis.filter((k) => k.status && k.status !== STATUS.OK);

  return {
    client: client || {},
    orgName: (client && client.name) || "Organización",
    kpis,
    critical,
    threshold,
    settings,
    estimatedCost:
      payload.estimatedCost !== undefined
        ? toNumber(payload.estimatedCost)
        : critical.reduce((sum, k) => sum + toNumber(k.estimatedCost), 0),
    periodStart: formatDate(client?.facturacion?.inicio),
    periodEnd: formatDate(client?.facturacion?.final),
    periodClosed: Boolean(payload.periodClosed),
    resolved: Array.isArray(payload.resolved) ? payload.resolved : [],
    projection: payload.projection || null,
  };
}

// ── Bloques HTML reutilizables ───────────────────────────────────────────────

function kpiBarRow(kpi) {
  const pct = kpi.percentage;
  const barWidth = pct === null ? 0 : Math.min(pct, 100);
  const color = getProgressBarColor(pct);
  const rightLabel =
    kpi.total > 0
      ? `${kpi.used.toLocaleString("es-MX")} / ${kpi.total.toLocaleString("es-MX")}${kpi.unit ? " " + kpi.unit : ""}`
      : `${kpi.used.toLocaleString("es-MX")}${kpi.unit ? " " + kpi.unit : ""}`;
  const footNote =
    pct === null
      ? "Sin compromiso contratado (on-demand)"
      : `${pct}% utilizado${kpi.included > 0 ? ` · incluye ${kpi.included.toLocaleString("es-MX")} de fair use` : ""}`;

  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid #e2e8f0; border-radius: 8px; background: #fefefe; margin-bottom: 12px;">
      <tr>
        <td style="padding: 16px 20px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td align="left" style="font-size: 14px; font-weight: 600; color: #475569;">${kpi.name}</td>
              <td align="right" style="font-size: 16px; font-weight: 700; color: #1e293b;">${rightLabel}</td>
            </tr>
          </table>
          <div style="width: 100%; height: 8px; background: #e2e8f0; border-radius: 4px; overflow: hidden; margin: 8px 0;">
            <div style="height: 8px; width: ${barWidth}%; background-color: ${color}; border-radius: 4px;"></div>
          </div>
          <div style="font-size: 12px; color: #64748b; text-align: right;">${footNote}</div>
        </td>
      </tr>
    </table>`;
}

function kpiCriticalCard(kpi) {
  const pct = kpi.percentage;
  const barWidth = pct === null ? 100 : Math.min(pct, 100);
  const accent = kpi.status === STATUS.ON_DEMAND ? "#ea580c" : "#dc2626";
  const bg = kpi.status === STATUS.ON_DEMAND ? "#fff7ed" : "#fef2f2";
  const rightLabel =
    kpi.total > 0
      ? `${kpi.used.toLocaleString("es-MX")} / ${kpi.total.toLocaleString("es-MX")}${kpi.unit ? " " + kpi.unit : ""}`
      : `${kpi.used.toLocaleString("es-MX")}${kpi.unit ? " " + kpi.unit : ""}`;

  const detail =
    kpi.overage > 0
      ? `Sobreuso: ${kpi.overage.toLocaleString("es-MX")}${kpi.unit ? " " + kpi.unit : ""}${
          kpi.estimatedCost > 0 ? ` · costo estimado ${formatMoney(kpi.estimatedCost)}` : ""
        }`
      : pct !== null
        ? `${pct}% utilizado`
        : "Consumo sin compromiso contratado";

  return `
    <div style="border: 1px solid ${accent}; border-radius: 8px; padding: 16px 20px; background: ${bg}; margin-bottom: 12px;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td align="left" style="font-size: 14px; font-weight: 600; color: ${accent};">🔴 ${kpi.name} — ${STATUS_LABEL[kpi.status]}</td>
          <td align="right" style="font-size: 16px; font-weight: 700; color: ${accent};">${rightLabel}</td>
        </tr>
      </table>
      <div style="width: 100%; height: 8px; background: #e2e8f0; border-radius: 4px; overflow: hidden; margin: 8px 0;">
        <div style="height: 8px; width: ${barWidth}%; background-color: ${accent}; border-radius: 4px;"></div>
      </div>
      <div style="font-size: 12px; color: ${accent}; font-weight: 600; text-align: right;">${detail}</div>
    </div>`;
}

function groupedKpiSections(kpis, { onlyRelevant = true } = {}) {
  const visible = onlyRelevant
    ? kpis.filter((k) => k.used > 0 || k.total > 0)
    : kpis;

  return CATEGORY_ORDER.map((category) => {
    const items = visible.filter((k) => k.category === category);
    if (items.length === 0) return "";
    return `
      <h3 style="margin: 24px 0 12px 0; color: #1e293b; font-size: 16px; font-weight: 600;">${CATEGORY_LABEL[category]}</h3>
      ${items.map(kpiBarRow).join("")}`;
  }).join("");
}

function costBanner(estimatedCost) {
  if (!(estimatedCost > 0)) return "";
  return `
    <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin-bottom: 24px; text-align: center;">
      <h3 style="margin: 0 0 4px 0; color: #dc2626; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Costo estimado de sobreuso</h3>
      <p style="margin: 0; color: #991b1b; font-size: 22px; font-weight: 700;">${formatMoney(estimatedCost)}</p>
      <p style="margin: 4px 0 0 0; color: #991b1b; font-size: 12px;">Estimación según tarifas de Fair Use; la factura final la emite Genesys.</p>
    </div>`;
}

function projectionBanner(projection) {
  if (!projection || !projection.items || projection.items.length === 0) return "";
  return `
    <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 16px 20px; margin-bottom: 24px;">
      <h3 style="margin: 0 0 8px 0; color: #b45309; font-size: 15px; font-weight: 600;">📈 Proyección al cierre del período (día ${projection.elapsedDays} de ${projection.totalDays})</h3>
      ${projection.items
        .map(
          (item) => `
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 6px;">
          <tr>
            <td align="left" style="color: #78350f; font-size: 13px;">${item.name}</td>
            <td align="right" style="color: #b45309; font-size: 13px; font-weight: 600;">${item.projectedPercentage}% proyectado</td>
          </tr>
        </table>`,
        )
        .join("")}
    </div>`;
}

function periodBanner(title, start, end, extraNote) {
  return `
    <div style="background: #f1f5f9; padding: 16px; border-radius: 8px; margin-bottom: 24px; text-align: center;">
      <h3 style="margin: 0 0 4px 0; color: #475569; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">${title}</h3>
      <p style="margin: 0; color: #1e293b; font-size: 16px; font-weight: 500;">${start} - ${end}</p>
      ${extraNote ? `<p style="margin: 8px 0 0 0; color: #b45309; font-size: 12px;">${extraNote}</p>` : ""}
    </div>`;
}

function shell({ headerColor, title, subtitle, body, orgName, footerColor, settings }) {
  return `<!DOCTYPE html>
<html lang="es">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
  </head>
  <body style="margin: 0; padding: 0; background-color: #f9fafb;">
    <div style="max-width: 640px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
      <div style="padding: 32px 24px; text-align: center; color: white; background: ${headerColor};">
        <h1 style="margin: 0 0 8px 0; font-size: 26px; font-weight: 700;">${title}</h1>
        <p style="margin: 0; font-size: 15px; opacity: 0.9;">${subtitle}</p>
      </div>
      <div style="padding: 28px 24px;">
        ${body}
      </div>
      <div style="background: ${footerColor || "#1e293b"}; color: white; padding: 24px; text-align: center;">
        <p style="margin: 0 0 16px 0; font-size: 14px; opacity: 0.8;">Reporte generado automáticamente para ${orgName}</p>
        ${footerHtml(settings)}
      </div>
    </div>
  </body>
</html>`;
}

// ── Plantillas ───────────────────────────────────────────────────────────────

function generateNotificationEmailTemplate(templateType, payload) {
  const ctx = normalizePayload(payload);
  const { orgName, kpis, critical, threshold, settings, periodStart, periodEnd } = ctx;

  switch (templateType) {
    case "current": {
      const note = ctx.periodClosed
        ? "⚠️ Este período de facturación ya cerró; Genesys aún no publica el nuevo período. Las cifras son las del período mostrado."
        : "";
      const body = `
        ${periodBanner("Período de Facturación", periodStart, periodEnd, note)}
        ${costBanner(ctx.estimatedCost)}
        ${projectionBanner(ctx.projection)}
        ${
          critical.length > 0
            ? `<div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
                 <h3 style="margin: 0 0 8px 0; color: #dc2626; font-size: 15px; font-weight: 600;">Atención en ${critical.length} métrica(s)</h3>
                 <p style="margin: 0; color: #991b1b; font-size: 13px;">${critical.map((k) => k.name).join(", ")}</p>
               </div>`
            : `<div style="background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
                 <p style="margin: 0; color: #065f46; font-size: 14px;">✅ Todo el consumo está dentro de lo contratado (umbral de alerta: ${threshold}%).</p>
               </div>`
        }
        ${groupedKpiSections(kpis)}`;

      return {
        subject: `📈 Reporte Actual - ${orgName} | Estado de Licencias`,
        html: shell({
          headerColor: "#3b82f6",
          title: "📈 Reporte Actual",
          subtitle: "Estado actual de licencias y recursos",
          body,
          orgName,
          settings,
        }),
        text: [
          `Reporte de Estado Actual - ${orgName}`,
          `Período: ${periodStart} - ${periodEnd}`,
          "",
          ...kpis.filter((k) => k.used > 0 || k.total > 0).map((k) => k.label),
          "",
          ctx.estimatedCost > 0 ? `Costo estimado de sobreuso: ${formatMoney(ctx.estimatedCost)}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }

    case "previous": {
      const availability = kpis
        .filter((k) => k.category === "licencia" && k.total > 0)
        .map((k) => {
          const available = Math.max(0, k.total - k.used);
          return `<p style="margin: 0 0 8px 0; font-size: 14px; color: #333;">${k.name}: ${available.toLocaleString("es-MX")} licencias disponibles</p>`;
        })
        .join("");

      const measured = kpis.filter((k) => k.percentage !== null && (k.used > 0 || k.total > 0));
      const avgUtilization =
        measured.length > 0
          ? Math.round(measured.reduce((sum, k) => sum + k.percentage, 0) / measured.length)
          : 0;

      const body = `
        ${periodBanner("Período Completado", periodStart, periodEnd)}
        ${costBanner(ctx.estimatedCost)}
        <div style="background: #f8fafc; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
          <h3 style="margin: 0 0 8px 0; color: #1e293b; font-size: 18px; font-weight: 600;">Resumen Final de Uso</h3>
          ${groupedKpiSections(kpis)}
        </div>
        <div style="border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; background: #fefefe; margin-bottom: 20px;">
          <h3 style="margin: 0 0 12px 0; color: #16a34a; font-size: 16px; font-weight: 600;">✅ Licencias Disponibles</h3>
          ${availability || '<p style="margin: 0; font-size: 14px; color: #64748b;">Sin licencias con compromiso en el período.</p>'}
        </div>
        <div style="border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; background: #fefefe;">
          <h3 style="margin: 0 0 12px 0; color: #3b82f6; font-size: 16px; font-weight: 600;">📈 Eficiencia de Uso</h3>
          <p style="margin: 0 0 8px 0; font-size: 14px; color: #333;">Promedio de utilización: ${avgUtilization}%</p>
          <p style="margin: 0; font-size: 14px; color: #333;">Métricas con sobreuso: ${critical.filter((k) => k.status === STATUS.EXCEEDED).length}</p>
        </div>`;

      return {
        subject: `📊 Reporte Final - Período Completado | ${orgName}`,
        html: shell({
          headerColor: "#16a34a",
          title: "📊 Reporte Final",
          subtitle: "Resumen del período de facturación completado",
          body,
          orgName,
          settings,
        }),
        text: [
          `Reporte del Período Finalizado - ${orgName}`,
          `Período: ${periodStart} - ${periodEnd}`,
          "",
          ...kpis.filter((k) => k.used > 0 || k.total > 0).map((k) => k.label),
          "",
          `Promedio de utilización: ${avgUtilization}%`,
          ctx.estimatedCost > 0 ? `Costo estimado de sobreuso: ${formatMoney(ctx.estimatedCost)}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }

    case "alert": {
      const support = settings.supportEmail || DEFAULT_EMAIL_SETTINGS.supportEmail;
      const body = `
        <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
          <h3 style="margin: 0 0 4px 0; color: #dc2626; font-size: 16px; font-weight: 600;">⚠️ ¿Qué ha pasado?</h3>
          <p style="margin: 0; color: #991b1b; font-size: 14px;">Se detectó consumo por encima de tu umbral configurado (<strong>${threshold}%</strong>) en ${critical.length} métrica(s). Revisa el detalle a continuación.</p>
        </div>
        ${periodBanner("Período Actual", periodStart, periodEnd)}
        ${costBanner(ctx.estimatedCost)}
        ${projectionBanner(ctx.projection)}
        <div style="margin-bottom: 24px;">
          ${
            critical.length > 0
              ? critical.map(kpiCriticalCard).join("")
              : '<p style="font-size: 14px; color: #64748b;">Sin métricas por encima del umbral en este momento.</p>'
          }
        </div>
        <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 20px;">
          <h3 style="margin: 0 0 12px 0; color: #dc2626; font-size: 17px; font-weight: 600;">🚨 Acciones Recomendadas</h3>
          <p style="margin: 0 0 8px 0; color: #475569; font-size: 14px;">1. Revisar el consumo en tu tablero de License Manager.</p>
          <p style="margin: 0 0 8px 0; color: #475569; font-size: 14px;">2. Optimizar los recursos activos que aparecen arriba.</p>
          <p style="margin: 0; color: #475569; font-size: 14px;">3. Contactar a soporte si necesitas ampliar límites: ${support}</p>
        </div>
        <div style="text-align: center; margin-top: 24px;">
          <a href="mailto:${support}" style="display: inline-block; background: #dc2626; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 500;">📞 Contactar Soporte</a>
        </div>`;

      return {
        subject: `🚨 Notificación de uso elevado - Genesys Cloud | ${orgName}`,
        html: shell({
          headerColor: "#dc2626",
          footerColor: "#dc2626",
          title: "Notificación",
          subtitle: "Uso elevado detectado - Supervisión del servicio recomendada",
          body,
          orgName,
          settings,
        }),
        text: [
          `🚨 Notificación de uso elevado - Genesys Cloud - ${orgName}`,
          `Umbral configurado: ${threshold}%`,
          `Período: ${periodStart} - ${periodEnd}`,
          "",
          "Métricas por encima del umbral:",
          ...critical.map((k) => `- ${k.label} [${STATUS_LABEL[k.status]}]`),
          "",
          ctx.estimatedCost > 0 ? `Costo estimado de sobreuso: ${formatMoney(ctx.estimatedCost)}` : "",
          "Este es un mensaje automático de License Manager.",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }

    case "recovered": {
      const body = `
        <div style="background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
          <h3 style="margin: 0 0 4px 0; color: #059669; font-size: 16px; font-weight: 600;">✅ Consumo normalizado</h3>
          <p style="margin: 0; color: #065f46; font-size: 14px;">Las métricas que habían superado tu umbral (<strong>${threshold}%</strong>) volvieron a estar en rango.</p>
        </div>
        ${periodBanner("Período Actual", periodStart, periodEnd)}
        ${
          ctx.resolved.length > 0
            ? `<div style="background: #f8fafc; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
                 <h3 style="margin: 0 0 12px 0; color: #1e293b; font-size: 16px; font-weight: 600;">Métricas normalizadas</h3>
                 ${ctx.resolved.map((name) => `<p style="margin: 0 0 6px 0; font-size: 14px; color: #475569;">• ${name}</p>`).join("")}
               </div>`
            : ""
        }
        ${groupedKpiSections(kpis)}`;

      return {
        subject: `✅ Consumo normalizado - ${orgName}`,
        html: shell({
          headerColor: "#16a34a",
          title: "✅ Consumo Normalizado",
          subtitle: "Ya no hay métricas por encima de tu umbral",
          body,
          orgName,
          settings,
        }),
        text: [
          `Consumo normalizado - ${orgName}`,
          `Umbral configurado: ${threshold}%`,
          `Período: ${periodStart} - ${periodEnd}`,
          "",
          ctx.resolved.length > 0 ? `Métricas normalizadas: ${ctx.resolved.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }

    default:
      throw new Error(`Tipo de plantilla de notificación no válido: ${templateType}`);
  }
}

function generateTemplate(templateType, data) {
  const settings = { ...DEFAULT_EMAIL_SETTINGS, ...(data?.settings || {}) };

  switch (templateType) {
    case "newuser":
      return {
        subject: `👋 Tu acceso a ${data.orgname} ha sido activado.`,
        html: `<!DOCTYPE html>
        <html lang="es">
          <head>
            <meta charset="UTF-8">
            <title>¡Bienvenido/a!</title>
          </head>
          <body style="margin: 0; padding: 0; background-color: #f9fafb;">
            <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">

              <div style="padding: 32px 24px; text-align: center; color: white; background:  #10b981;">
                <h1 style="margin: 0 0 8px 0; font-size: 28px; font-weight: 700;">👋 ¡Bienvenido/a!</h1>
                <p style="margin: 0; font-size: 16px; opacity: 0.9;">Tu cuenta ha sido creada exitosamente. Es hora de empezar.</p>
              </div>

              <div style="padding: 32px 24px;">

                <div style="background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
                  <h3 style="margin: 0 0 4px 0; color: #059669; font-size: 16px; font-weight: 600;">✅ Cuenta Activada</h3>
                  <p style="margin: 0; color: #065f46; font-size: 14px;">Tu acceso a la organización ${data.orgname} ya está listo. Usa las siguientes credenciales para iniciar sesión.</p>
                </div>

                <div style="background: #f1f5f9; padding: 16px; border-radius: 8px; margin-bottom: 24px; text-align: center;">
                  <h3 style="margin: 0 0 4px 0; color: #475569; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Organización</h3>
                  <p style="margin: 0; color: #1e293b; font-size: 18px; font-weight: 600;">${data.orgname}</p>
                </div>

                <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 20px; margin-bottom: 32px;">
                  <h3 style="margin: 0 0 16px 0; color: #2563eb; font-size: 18px; font-weight: 600;">🔑 Tus Credenciales</h3>

                  <div style="display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #dbeafe;">
                    <span style="color: #475569; font-size: 14px; font-weight: 500;">Nombre de Usuario: </span>
                    <span style="color: #1e293b; font-size: 14px; font-weight: 600;">${data.usuario}</span>
                  </div>

                  <div style="display: flex; justify-content: space-between; padding: 10px 0;">
                    <span style="color: #475569; font-size: 14px; font-weight: 500;">Contraseña Temporal: </span>
                    <span style="color: #1e293b; font-size: 14px; font-weight: 600;">${data.password}</span>
                  </div>
                </div>

                <div style="text-align: center; margin-top: 24px;">
                  <a style="display: inline-block; background: #2563eb; color: white; padding: 14px 28px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 16px; margin: 16px 0;">
                    ▶️ Puedes ir a la plataforma e iniciar Sesión.
                  </a>
                </div>

                <p style="text-align: center; color: #64748b; font-size: 12px; margin-top: 20px;">
                  ⚠️ Por motivos de seguridad, te recomendamos cambiar tu contraseña temporal inmediatamente después de iniciar sesión.
                </p>
              </div>

              <div style="background: #10b981; color: white; padding: 24px; text-align: center;">
                <p style="margin: 0 0 8px 0; font-size: 14px; opacity: 0.8;">Este correo es solo para fines informativos. Por favor, no lo respondas.</p>
                ${footerHtml(settings)}
              </div>
            </div>
          </body>
        </html>
        `,
        text: `🎉 ¡Bienvenido/a a ${data.orgname}! 🎉\n\nTu acceso a los servicios de ${data.orgname} ha sido activado exitosamente.\n\nUsa las siguientes credenciales para iniciar sesión:\n\n================================\n🔑 CREDENCIALES DE ACCESO\n================================\n\nORGANIZACIÓN: ${data.orgname}\nUSUARIO: ${data.usuario}\nCONTRASEÑA TEMPORAL: ${data.password}\n\n--------------------------------\n\n\n ⚠️ RECOMENDACIÓN DE SEGURIDAD:\nPor favor, cambia tu contraseña temporal inmediatamente después de iniciar sesión.\n\nSi tienes algún problema, contacta a soporte en: ${settings.supportEmail}\n\nEste es un mensaje automático.`,
      };

    case "userupdated": {
      const isPasswordUpdate = !!data.password;

      return {
        subject: `✅ Tu perfil en ${data.orgname} ha sido actualizado.`,
        html: `<!DOCTYPE html>
        <html lang="es">
          <head>
            <meta charset="UTF-8">
            <title>Actualización de Perfil</title>
          </head>
          <body style="margin: 0; padding: 0; background-color: #f9fafb;">
            <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">

              <div style="padding: 32px 24px; text-align: center; color: white; background:  #3b82f6;">
                <h1 style="margin: 0 0 8px 0; font-size: 28px; font-weight: 700;">⚙️ Perfil Actualizado</h1>
                <p style="margin: 0; font-size: 16px; opacity: 0.9;">Tus datos de usuario en ${data.orgname} han sido modificados.</p>
              </div>

              <div style="padding: 32px 24px;">

                <div style="background: #e0f2fe; border: 1px solid #7dd3fc; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
                  <h3 style="margin: 0 0 4px 0; color: #0284c7; font-size: 16px; font-weight: 600;">🔔 Notificación Importante</h3>
                  <p style="margin: 0; color: #075985; font-size: 14px;">La información de tu cuenta en la organización <b>${data.orgname}</b> ha sido actualizada recientemente. Si no reconoces esta acción, contacta a tu administrador.</p>
                </div>

                <div style="background: #f1f5f9; padding: 16px; border-radius: 8px; margin-bottom: 24px; text-align: center;">
                  <h3 style="margin: 0 0 4px 0; color: #475569; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Organización</h3>
                  <p style="margin: 0; color: #1e293b; font-size: 18px; font-weight: 600;">${data.orgname}</p>
                </div>

                <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 20px; margin-bottom: 32px;">
                  <h3 style="margin: 0 0 16px 0; color: #2563eb; font-size: 18px; font-weight: 600;">👤 Detalles de la Cuenta</h3>

                  <div style="display: flex; justify-content: space-between; padding: 10px 0;">
                    <span style="color: #475569; font-size: 14px; font-weight: 500;">Nombre de Usuario: </span>
                    <span style="color: #1e293b; font-size: 14px; font-weight: 600;">${data.usuario}</span>
                  </div>

                  ${
                    isPasswordUpdate
                      ? `<div style="display: flex; padding: 10px 0; border-top: 1px solid #dbeafe;">
                        <p style="margin: 0; color: #dc2626; font-size: 14px; font-weight: 600;">* NOTA: Tu contraseña fue modificada.</p>
                    </div>`
                      : ""
                  }

                  ${
                    data.role
                      ? `<div style="display: flex; justify-content: space-between; padding: 10px 0; border-top: 1px solid #dbeafe;">
                                <span style="color: #475569; font-size: 14px; font-weight: 500;">Rol Actual: </span>
                                <span style="color: #1e293b; font-size: 14px; font-weight: 600;">${data.role}</span>
                            </div>`
                      : ""
                  }

                </div>

                <div style="text-align: center; margin-top: 24px;">
                  <a style="display: inline-block; background: #3b82f6; color: white; padding: 14px 28px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 16px; margin: 16px 0;">
                    Puedes acceder de nuevo a la Plataforma.
                  </a>
                </div>

                <p style="text-align: center; color: #64748b; font-size: 12px; margin-top: 20px;">
                  Si no realizaste esta acción o si tienes preguntas, contacta al soporte de tu organización inmediatamente.
                </p>
              </div>

              <div style="background: #3b82f6; color: white; padding: 24px; text-align: center;">
                <p style="margin: 0 0 8px 0; font-size: 14px; opacity: 0.8;">Este correo es una notificación de seguridad. Por favor, no lo respondas.</p>
                ${footerHtml(settings)}
              </div>
            </div>
          </body>
        </html>
        `,
        text: `✅ Actualización de Perfil en ${data.orgname} ✅\n\nTu información de usuario en ${data.orgname} ha sido actualizada exitosamente.\n\n================================\n👤 DETALLES DE LA CUENTA\n================================\n\nORGANIZACIÓN: ${data.orgname}\nUSUARIO: ${data.usuario}\n${isPasswordUpdate ? "⚠️ NOTA: Tu contraseña fue cambiada.\n" : ""}\n--------------------------------\n\nSi no realizaste esta acción o si tienes preguntas, contacta a soporte en: ${settings.supportEmail}\n\nEste es un mensaje automático.`,
      };
    }

    default:
      throw new Error(`Tipo de plantilla no válido: ${templateType}`);
  }
}

module.exports = {
  generateNotificationEmailTemplate,
  generateTemplate,
  normalizePayload,
  formatMoney,
};
