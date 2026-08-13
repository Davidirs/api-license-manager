const {
  STATUS,
  buildKpis,
  classify,
  signatureFor,
  formatValue,
  toNumber,
} = require("./monitorMetrics");
const { DEFAULT_EMAIL_SETTINGS } = require("./appSettings");
const { translator, normalizeLanguage } = require("./emailI18n");

// Todas las plantillas se renderizan en el idioma del destinatario
// (`preferences.language`). El traductor `t` viaja por los helpers en vez de
// tener los textos incrustados en el HTML.

function formatDate(dateString, t) {
  if (!dateString) return "—";
  const d = new Date(dateString);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(t.locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatNumber(value, t) {
  return toNumber(value).toLocaleString(t.numberLocale);
}

function formatMoney(amount, t) {
  // Compatibilidad: se sigue admitiendo la llamada sin traductor (español).
  const translate = typeof t === "function" ? t : translator();
  return `$${toNumber(amount).toLocaleString(translate.numberLocale, {
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

const STATUS_KEY = {
  [STATUS.EXCEEDED]: "status.exceeded",
  [STATUS.WARNING]: "status.warning",
  [STATUS.ON_DEMAND]: "status.on_demand",
  [STATUS.OK]: "status.ok",
};

function statusLabel(status, t) {
  return t(STATUS_KEY[status] || "status.ok");
}

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

function footerHtml(settings, t) {
  const support = settings.supportEmail || DEFAULT_EMAIL_SETTINGS.supportEmail;
  return `<p style="margin: 0; padding: 0; font-size: 14px; opacity: 0.8; color: white;">
                ${t("footer.auto")}<br />
                ${t("footer.doubts")} <a href="mailto:${support}" style="color: #60a5fa;">${support}</a>.<br />
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
  const t = translator(payload.lang || payload.language);

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
    orgName: (client && client.name) || t("org.fallback"),
    kpis,
    critical,
    threshold,
    settings,
    t,
    lang: t.language,
    estimatedCost:
      payload.estimatedCost !== undefined
        ? toNumber(payload.estimatedCost)
        : critical.reduce((sum, k) => sum + toNumber(k.estimatedCost), 0),
    periodStart: formatDate(client?.facturacion?.inicio, t),
    periodEnd: formatDate(client?.facturacion?.final, t),
    periodClosed: Boolean(payload.periodClosed),
    resolved: Array.isArray(payload.resolved) ? payload.resolved : [],
    projection: payload.projection || null,
  };
}

// ── Bloques HTML reutilizables ───────────────────────────────────────────────

function kpiBarRow(kpi, t) {
  const pct = kpi.percentage;
  const barWidth = pct === null ? 0 : Math.min(pct, 100);
  const color = getProgressBarColor(pct);
  const unit = kpi.unit ? " " + kpi.unit : "";
  const rightLabel =
    kpi.total > 0
      ? `${formatNumber(kpi.used, t)} / ${formatNumber(kpi.total, t)}${unit}`
      : `${formatNumber(kpi.used, t)}${unit}`;
  const footNote =
    pct === null
      ? t("kpi.no_commitment")
      : `${t("kpi.used_pct", { value: pct })}${
          kpi.included > 0
            ? t("kpi.fairuse_included", { value: formatNumber(kpi.included, t) })
            : ""
        }`;

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

function kpiCriticalCard(kpi, t) {
  const pct = kpi.percentage;
  const barWidth = pct === null ? 100 : Math.min(pct, 100);
  const accent = kpi.status === STATUS.ON_DEMAND ? "#ea580c" : "#dc2626";
  const bg = kpi.status === STATUS.ON_DEMAND ? "#fff7ed" : "#fef2f2";
  const unit = kpi.unit ? " " + kpi.unit : "";
  const rightLabel =
    kpi.total > 0
      ? `${formatNumber(kpi.used, t)} / ${formatNumber(kpi.total, t)}${unit}`
      : `${formatNumber(kpi.used, t)}${unit}`;

  const detail =
    kpi.overage > 0
      ? `${t("kpi.overage", { value: `${formatNumber(kpi.overage, t)}${unit}` })}${
          kpi.estimatedCost > 0
            ? t("kpi.overage_cost", { amount: formatMoney(kpi.estimatedCost, t) })
            : ""
        }`
      : pct !== null
        ? t("kpi.used_pct", { value: pct })
        : t("kpi.on_demand_detail");

  return `
    <div style="border: 1px solid ${accent}; border-radius: 8px; padding: 16px 20px; background: ${bg}; margin-bottom: 12px;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td align="left" style="font-size: 14px; font-weight: 600; color: ${accent};">🔴 ${kpi.name} — ${statusLabel(kpi.status, t)}</td>
          <td align="right" style="font-size: 16px; font-weight: 700; color: ${accent};">${rightLabel}</td>
        </tr>
      </table>
      <div style="width: 100%; height: 8px; background: #e2e8f0; border-radius: 4px; overflow: hidden; margin: 8px 0;">
        <div style="height: 8px; width: ${barWidth}%; background-color: ${accent}; border-radius: 4px;"></div>
      </div>
      <div style="font-size: 12px; color: ${accent}; font-weight: 600; text-align: right;">${detail}</div>
    </div>`;
}

function groupedKpiSections(kpis, t, { onlyRelevant = true } = {}) {
  const visible = onlyRelevant
    ? kpis.filter((k) => k.used > 0 || k.total > 0)
    : kpis;

  return CATEGORY_ORDER.map((category) => {
    const items = visible.filter((k) => k.category === category);
    if (items.length === 0) return "";
    return `
      <h3 style="margin: 24px 0 12px 0; color: #1e293b; font-size: 16px; font-weight: 600;">${t(`category.${category}`)}</h3>
      ${items.map((kpi) => kpiBarRow(kpi, t)).join("")}`;
  }).join("");
}

function costBanner(estimatedCost, t) {
  if (!(estimatedCost > 0)) return "";
  return `
    <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin-bottom: 24px; text-align: center;">
      <h3 style="margin: 0 0 4px 0; color: #dc2626; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">${t("cost.title")}</h3>
      <p style="margin: 0; color: #991b1b; font-size: 22px; font-weight: 700;">${formatMoney(estimatedCost, t)}</p>
      <p style="margin: 4px 0 0 0; color: #991b1b; font-size: 12px;">${t("cost.note")}</p>
    </div>`;
}

function projectionBanner(projection, t) {
  if (!projection || !projection.items || projection.items.length === 0) return "";
  return `
    <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 16px 20px; margin-bottom: 24px;">
      <h3 style="margin: 0 0 8px 0; color: #b45309; font-size: 15px; font-weight: 600;">${t("projection.title", {
        elapsed: projection.elapsedDays,
        total: projection.totalDays,
      })}</h3>
      ${projection.items
        .map(
          (item) => `
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 6px;">
          <tr>
            <td align="left" style="color: #78350f; font-size: 13px;">${item.name}</td>
            <td align="right" style="color: #b45309; font-size: 13px; font-weight: 600;">${t("projection.item", { value: item.projectedPercentage })}</td>
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

function shell({ headerColor, title, subtitle, body, orgName, footerColor, settings, t }) {
  return `<!DOCTYPE html>
<html lang="${t.language}">
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
        <p style="margin: 0 0 16px 0; font-size: 14px; opacity: 0.8;">${t("footer.generated_for", { org: orgName })}</p>
        ${footerHtml(settings, t)}
      </div>
    </div>
  </body>
</html>`;
}

// ── Plantillas ───────────────────────────────────────────────────────────────

function generateNotificationEmailTemplate(templateType, payload) {
  const ctx = normalizePayload(payload);
  const { orgName, kpis, critical, threshold, settings, periodStart, periodEnd, t } = ctx;

  switch (templateType) {
    case "current": {
      const note = ctx.periodClosed ? t("current.period_closed_note") : "";
      const body = `
        ${periodBanner(t("current.period"), periodStart, periodEnd, note)}
        ${costBanner(ctx.estimatedCost, t)}
        ${projectionBanner(ctx.projection, t)}
        ${
          critical.length > 0
            ? `<div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
                 <h3 style="margin: 0 0 8px 0; color: #dc2626; font-size: 15px; font-weight: 600;">${t("current.attention", { count: critical.length })}</h3>
                 <p style="margin: 0; color: #991b1b; font-size: 13px;">${critical.map((k) => k.name).join(", ")}</p>
               </div>`
            : `<div style="background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
                 <p style="margin: 0; color: #065f46; font-size: 14px;">${t("current.all_ok", { threshold })}</p>
               </div>`
        }
        ${groupedKpiSections(kpis, t)}`;

      return {
        subject: t("current.subject", { org: orgName }),
        html: shell({
          headerColor: "#3b82f6",
          title: t("current.title"),
          subtitle: t("current.subtitle"),
          body,
          orgName,
          settings,
          t,
        }),
        text: [
          t("current.text_title", { org: orgName }),
          t("text.period", { start: periodStart, end: periodEnd }),
          "",
          ...kpis.filter((k) => k.used > 0 || k.total > 0).map((k) => k.label),
          "",
          ctx.estimatedCost > 0
            ? t("cost.summary", { amount: formatMoney(ctx.estimatedCost, t) })
            : "",
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
          return `<p style="margin: 0 0 8px 0; font-size: 14px; color: #333;">${t("previous.available_item", {
            name: k.name,
            count: formatNumber(available, t),
          })}</p>`;
        })
        .join("");

      const measured = kpis.filter((k) => k.percentage !== null && (k.used > 0 || k.total > 0));
      const avgUtilization =
        measured.length > 0
          ? Math.round(measured.reduce((sum, k) => sum + k.percentage, 0) / measured.length)
          : 0;

      const body = `
        ${periodBanner(t("previous.period"), periodStart, periodEnd)}
        ${costBanner(ctx.estimatedCost, t)}
        <div style="background: #f8fafc; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
          <h3 style="margin: 0 0 8px 0; color: #1e293b; font-size: 18px; font-weight: 600;">${t("previous.summary")}</h3>
          ${groupedKpiSections(kpis, t)}
        </div>
        <div style="border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; background: #fefefe; margin-bottom: 20px;">
          <h3 style="margin: 0 0 12px 0; color: #16a34a; font-size: 16px; font-weight: 600;">${t("previous.available_licenses")}</h3>
          ${availability || `<p style="margin: 0; font-size: 14px; color: #64748b;">${t("previous.no_commitment_licenses")}</p>`}
        </div>
        <div style="border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; background: #fefefe;">
          <h3 style="margin: 0 0 12px 0; color: #3b82f6; font-size: 16px; font-weight: 600;">${t("previous.efficiency")}</h3>
          <p style="margin: 0 0 8px 0; font-size: 14px; color: #333;">${t("previous.avg_utilization", { value: avgUtilization })}</p>
          <p style="margin: 0; font-size: 14px; color: #333;">${t("previous.exceeded_count", {
            count: critical.filter((k) => k.status === STATUS.EXCEEDED).length,
          })}</p>
        </div>`;

      return {
        subject: t("previous.subject", { org: orgName }),
        html: shell({
          headerColor: "#16a34a",
          title: t("previous.title"),
          subtitle: t("previous.subtitle"),
          body,
          orgName,
          settings,
          t,
        }),
        text: [
          t("previous.text_title", { org: orgName }),
          t("text.period", { start: periodStart, end: periodEnd }),
          "",
          ...kpis.filter((k) => k.used > 0 || k.total > 0).map((k) => k.label),
          "",
          t("previous.avg_utilization", { value: avgUtilization }),
          ctx.estimatedCost > 0
            ? t("cost.summary", { amount: formatMoney(ctx.estimatedCost, t) })
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }

    case "alert": {
      const support = settings.supportEmail || DEFAULT_EMAIL_SETTINGS.supportEmail;
      const body = `
        <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
          <h3 style="margin: 0 0 4px 0; color: #dc2626; font-size: 16px; font-weight: 600;">${t("alert.what_happened")}</h3>
          <p style="margin: 0; color: #991b1b; font-size: 14px;">${t("alert.what_happened_desc", {
            threshold,
            count: critical.length,
          })}</p>
        </div>
        ${periodBanner(t("alert.period"), periodStart, periodEnd)}
        ${costBanner(ctx.estimatedCost, t)}
        ${projectionBanner(ctx.projection, t)}
        <div style="margin-bottom: 24px;">
          ${
            critical.length > 0
              ? critical.map((kpi) => kpiCriticalCard(kpi, t)).join("")
              : `<p style="font-size: 14px; color: #64748b;">${t("alert.none_above")}</p>`
          }
        </div>
        <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 20px;">
          <h3 style="margin: 0 0 12px 0; color: #dc2626; font-size: 17px; font-weight: 600;">${t("alert.actions")}</h3>
          <p style="margin: 0 0 8px 0; color: #475569; font-size: 14px;">${t("alert.action_1")}</p>
          <p style="margin: 0 0 8px 0; color: #475569; font-size: 14px;">${t("alert.action_2")}</p>
          <p style="margin: 0; color: #475569; font-size: 14px;">${t("alert.action_3", { support })}</p>
        </div>
        <div style="text-align: center; margin-top: 24px;">
          <a href="mailto:${support}" style="display: inline-block; background: #dc2626; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 500;">${t("alert.contact_support")}</a>
        </div>`;

      return {
        subject: t("alert.subject", { org: orgName }),
        html: shell({
          headerColor: "#dc2626",
          footerColor: "#dc2626",
          title: t("alert.title"),
          subtitle: t("alert.subtitle"),
          body,
          orgName,
          settings,
          t,
        }),
        text: [
          t("alert.text_title", { org: orgName }),
          t("alert.text_threshold", { threshold }),
          t("text.period", { start: periodStart, end: periodEnd }),
          "",
          t("alert.text_metrics"),
          ...critical.map((k) => `- ${k.label} [${statusLabel(k.status, t)}]`),
          "",
          ctx.estimatedCost > 0
            ? t("cost.summary", { amount: formatMoney(ctx.estimatedCost, t) })
            : "",
          t("alert.text_footer"),
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }

    case "recovered": {
      const body = `
        <div style="background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
          <h3 style="margin: 0 0 4px 0; color: #059669; font-size: 16px; font-weight: 600;">${t("recovered.heading")}</h3>
          <p style="margin: 0; color: #065f46; font-size: 14px;">${t("recovered.desc", { threshold })}</p>
        </div>
        ${periodBanner(t("alert.period"), periodStart, periodEnd)}
        ${
          ctx.resolved.length > 0
            ? `<div style="background: #f8fafc; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
                 <h3 style="margin: 0 0 12px 0; color: #1e293b; font-size: 16px; font-weight: 600;">${t("recovered.normalized")}</h3>
                 ${ctx.resolved.map((name) => `<p style="margin: 0 0 6px 0; font-size: 14px; color: #475569;">• ${name}</p>`).join("")}
               </div>`
            : ""
        }
        ${groupedKpiSections(kpis, t)}`;

      return {
        subject: t("recovered.subject", { org: orgName }),
        html: shell({
          headerColor: "#16a34a",
          title: t("recovered.title"),
          subtitle: t("recovered.subtitle"),
          body,
          orgName,
          settings,
          t,
        }),
        text: [
          t("recovered.text_title", { org: orgName }),
          t("alert.text_threshold", { threshold }),
          t("text.period", { start: periodStart, end: periodEnd }),
          "",
          ctx.resolved.length > 0
            ? t("recovered.text_normalized", { list: ctx.resolved.join(", ") })
            : "",
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
  const t = translator(data?.lang || data?.language);
  const support = settings.supportEmail || DEFAULT_EMAIL_SETTINGS.supportEmail;

  switch (templateType) {
    case "newuser":
      return {
        subject: t("newuser.subject", { org: data.orgname }),
        html: `<!DOCTYPE html>
        <html lang="${t.language}">
          <head>
            <meta charset="UTF-8">
            <title>${t("newuser.doc_title")}</title>
          </head>
          <body style="margin: 0; padding: 0; background-color: #f9fafb;">
            <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">

              <div style="padding: 32px 24px; text-align: center; color: white; background:  #10b981;">
                <h1 style="margin: 0 0 8px 0; font-size: 28px; font-weight: 700;">${t("newuser.title")}</h1>
                <p style="margin: 0; font-size: 16px; opacity: 0.9;">${t("newuser.subtitle")}</p>
              </div>

              <div style="padding: 32px 24px;">

                <div style="background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
                  <h3 style="margin: 0 0 4px 0; color: #059669; font-size: 16px; font-weight: 600;">${t("newuser.activated")}</h3>
                  <p style="margin: 0; color: #065f46; font-size: 14px;">${t("newuser.activated_desc", { org: data.orgname })}</p>
                </div>

                <div style="background: #f1f5f9; padding: 16px; border-radius: 8px; margin-bottom: 24px; text-align: center;">
                  <h3 style="margin: 0 0 4px 0; color: #475569; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">${t("newuser.organization")}</h3>
                  <p style="margin: 0; color: #1e293b; font-size: 18px; font-weight: 600;">${data.orgname}</p>
                </div>

                <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 20px; margin-bottom: 32px;">
                  <h3 style="margin: 0 0 16px 0; color: #2563eb; font-size: 18px; font-weight: 600;">${t("newuser.credentials")}</h3>

                  <div style="display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #dbeafe;">
                    <span style="color: #475569; font-size: 14px; font-weight: 500;">${t("newuser.username")} </span>
                    <span style="color: #1e293b; font-size: 14px; font-weight: 600;">${data.usuario}</span>
                  </div>

                  <div style="display: flex; justify-content: space-between; padding: 10px 0;">
                    <span style="color: #475569; font-size: 14px; font-weight: 500;">${t("newuser.temp_password")} </span>
                    <span style="color: #1e293b; font-size: 14px; font-weight: 600;">${data.password}</span>
                  </div>
                </div>

                <div style="text-align: center; margin-top: 24px;">
                  <a style="display: inline-block; background: #2563eb; color: white; padding: 14px 28px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 16px; margin: 16px 0;">
                    ${t("newuser.cta")}
                  </a>
                </div>

                <p style="text-align: center; color: #64748b; font-size: 12px; margin-top: 20px;">
                  ${t("newuser.security_note")}
                </p>
              </div>

              <div style="background: #10b981; color: white; padding: 24px; text-align: center;">
                <p style="margin: 0 0 8px 0; font-size: 14px; opacity: 0.8;">${t("newuser.footer_note")}</p>
                ${footerHtml(settings, t)}
              </div>
            </div>
          </body>
        </html>
        `,
        text: t("newuser.text", {
          org: data.orgname,
          user: data.usuario,
          password: data.password,
          support,
        }),
      };

    case "userupdated": {
      const isPasswordUpdate = !!data.password;

      return {
        subject: t("userupdated.subject", { org: data.orgname }),
        html: `<!DOCTYPE html>
        <html lang="${t.language}">
          <head>
            <meta charset="UTF-8">
            <title>${t("userupdated.doc_title")}</title>
          </head>
          <body style="margin: 0; padding: 0; background-color: #f9fafb;">
            <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">

              <div style="padding: 32px 24px; text-align: center; color: white; background:  #3b82f6;">
                <h1 style="margin: 0 0 8px 0; font-size: 28px; font-weight: 700;">${t("userupdated.title")}</h1>
                <p style="margin: 0; font-size: 16px; opacity: 0.9;">${t("userupdated.subtitle", { org: data.orgname })}</p>
              </div>

              <div style="padding: 32px 24px;">

                <div style="background: #e0f2fe; border: 1px solid #7dd3fc; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
                  <h3 style="margin: 0 0 4px 0; color: #0284c7; font-size: 16px; font-weight: 600;">${t("userupdated.notice")}</h3>
                  <p style="margin: 0; color: #075985; font-size: 14px;">${t("userupdated.notice_desc", { org: data.orgname })}</p>
                </div>

                <div style="background: #f1f5f9; padding: 16px; border-radius: 8px; margin-bottom: 24px; text-align: center;">
                  <h3 style="margin: 0 0 4px 0; color: #475569; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">${t("userupdated.organization")}</h3>
                  <p style="margin: 0; color: #1e293b; font-size: 18px; font-weight: 600;">${data.orgname}</p>
                </div>

                <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 20px; margin-bottom: 32px;">
                  <h3 style="margin: 0 0 16px 0; color: #2563eb; font-size: 18px; font-weight: 600;">${t("userupdated.details")}</h3>

                  <div style="display: flex; justify-content: space-between; padding: 10px 0;">
                    <span style="color: #475569; font-size: 14px; font-weight: 500;">${t("userupdated.username")} </span>
                    <span style="color: #1e293b; font-size: 14px; font-weight: 600;">${data.usuario}</span>
                  </div>

                  ${
                    isPasswordUpdate
                      ? `<div style="display: flex; padding: 10px 0; border-top: 1px solid #dbeafe;">
                        <p style="margin: 0; color: #dc2626; font-size: 14px; font-weight: 600;">${t("userupdated.password_changed")}</p>
                    </div>`
                      : ""
                  }

                  ${
                    data.role
                      ? `<div style="display: flex; justify-content: space-between; padding: 10px 0; border-top: 1px solid #dbeafe;">
                                <span style="color: #475569; font-size: 14px; font-weight: 500;">${t("userupdated.role")} </span>
                                <span style="color: #1e293b; font-size: 14px; font-weight: 600;">${data.role}</span>
                            </div>`
                      : ""
                  }

                </div>

                <div style="text-align: center; margin-top: 24px;">
                  <a style="display: inline-block; background: #3b82f6; color: white; padding: 14px 28px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 16px; margin: 16px 0;">
                    ${t("userupdated.cta")}
                  </a>
                </div>

                <p style="text-align: center; color: #64748b; font-size: 12px; margin-top: 20px;">
                  ${t("userupdated.help")}
                </p>
              </div>

              <div style="background: #3b82f6; color: white; padding: 24px; text-align: center;">
                <p style="margin: 0 0 8px 0; font-size: 14px; opacity: 0.8;">${t("userupdated.footer_note")}</p>
                ${footerHtml(settings, t)}
              </div>
            </div>
          </body>
        </html>
        `,
        text: t("userupdated.text", {
          org: data.orgname,
          user: data.usuario,
          passwordNote: isPasswordUpdate ? t("userupdated.text_password_note") : "",
          support,
        }),
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
  normalizeLanguage,
};
