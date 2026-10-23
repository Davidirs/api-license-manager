// Mensajes de WhatsApp: resúmenes cortos, no la plantilla del correo.
//
// El WhatsApp sólo avisa; el detalle está en el correo (si el usuario lo tiene
// activo) o en el dashboard. No se incluye enlace: el usuario ya sabe dónde
// está el dashboard, y un enlace en un mensaje automático parece phishing.

const { normalizeLanguage } = require("./emailI18n");

const MAX_METRICS = 3;

const TEXTS = {
  es: {
    header: "License Manager · {org}",
    alert: "🚨 Uso elevado: {count} métrica(s) superan el {threshold}%:",
    recovered: "✅ Las métricas volvieron a estar dentro del umbral ({threshold}%).",
    recovered_list: "Normalizadas:",
    current_ok: "📊 Reporte del período en curso: todas las métricas están dentro del umbral ({threshold}%).",
    current_bad: "📊 Reporte del período en curso: {count} métrica(s) superan el {threshold}%:",
    previous_ok: "📋 Cerró el período de facturación ({start} – {end}) sin métricas por encima del {threshold}%.",
    previous_bad: "📋 Cerró el período de facturación ({start} – {end}) con {count} métrica(s) por encima del {threshold}%:",
    more: "…y {n} más",
    see_email: "Revisa el correo de notificación para ver el detalle completo.",
    see_dashboard: "Revisa el dashboard de License Manager para ver el detalle.",
    delayed: "(Retenido por tu horario de no molestar.)",
    verification:
      "🔐 Tu código de verificación de License Manager es: *{code}*\n\nVence en {minutes} minutos. Si no lo solicitaste, ignora este mensaje.",
    verified:
      "✅ Tu número quedó registrado para recibir notificaciones de License Manager.\n\n" +
      "Para asegurar la entrega de los mensajes, guarda este número en tus contactos y responde a este mensaje indicando que estás de acuerdo con recibir notificaciones por WhatsApp. 🙌",
    test: "✅ Mensaje de prueba de License Manager: tus notificaciones por WhatsApp están funcionando.",
  },
  en: {
    header: "License Manager · {org}",
    alert: "🚨 High usage: {count} metric(s) exceed {threshold}%:",
    recovered: "✅ Metrics are back within the threshold ({threshold}%).",
    recovered_list: "Back to normal:",
    current_ok: "📊 Current period report: all metrics are within the threshold ({threshold}%).",
    current_bad: "📊 Current period report: {count} metric(s) exceed {threshold}%:",
    previous_ok: "📋 The billing period ({start} – {end}) closed with no metrics above {threshold}%.",
    previous_bad: "📋 The billing period ({start} – {end}) closed with {count} metric(s) above {threshold}%:",
    more: "…and {n} more",
    see_email: "Check the notification email for the full details.",
    see_dashboard: "Check the License Manager dashboard for the details.",
    delayed: "(Held by your do-not-disturb hours.)",
    verification:
      "🔐 Your License Manager verification code is: *{code}*\n\nIt expires in {minutes} minutes. If you didn't request it, ignore this message.",
    verified:
      "✅ Your number is now registered to receive License Manager notifications.\n\n" +
      "To make sure messages are delivered, save this number to your contacts and reply to this message agreeing to receive WhatsApp notifications. 🙌",
    test: "✅ License Manager test message: your WhatsApp notifications are working.",
  },
  pt: {
    header: "License Manager · {org}",
    alert: "🚨 Uso elevado: {count} métrica(s) ultrapassam {threshold}%:",
    recovered: "✅ As métricas voltaram a ficar dentro do limite ({threshold}%).",
    recovered_list: "Normalizadas:",
    current_ok: "📊 Relatório do período em curso: todas as métricas estão dentro do limite ({threshold}%).",
    current_bad: "📊 Relatório do período em curso: {count} métrica(s) ultrapassam {threshold}%:",
    previous_ok: "📋 O período de faturamento ({start} – {end}) fechou sem métricas acima de {threshold}%.",
    previous_bad: "📋 O período de faturamento ({start} – {end}) fechou com {count} métrica(s) acima de {threshold}%:",
    more: "…e mais {n}",
    see_email: "Confira o e-mail de notificação para ver todos os detalhes.",
    see_dashboard: "Confira o dashboard do License Manager para ver os detalhes.",
    delayed: "(Retido pelo seu horário de não perturbe.)",
    verification:
      "🔐 Seu código de verificação do License Manager é: *{code}*\n\nEle vence em {minutes} minutos. Se você não o solicitou, ignore esta mensagem.",
    verified:
      "✅ Seu número foi registrado para receber notificações do License Manager.\n\n" +
      "Para garantir a entrega das mensagens, salve este número nos seus contatos e responda a esta mensagem concordando em receber notificações por WhatsApp. 🙌",
    test: "✅ Mensagem de teste do License Manager: suas notificações por WhatsApp estão funcionando.",
  },
};

function tr(lang, key, vars = {}) {
  const dict = TEXTS[normalizeLanguage(lang)] || TEXTS.es;
  const template = dict[key] ?? TEXTS.es[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name) => (vars[name] ?? `{${name}}`));
}

function formatDay(value, lang) {
  if (!value) return "?";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const locale = { es: "es-ES", en: "en-US", pt: "pt-BR" }[normalizeLanguage(lang)];
  return date.toLocaleDateString(locale, { day: "numeric", month: "short", timeZone: "UTC" });
}

function metricLines(names, lang) {
  const shown = names.slice(0, MAX_METRICS).map((n) => `• ${n}`);
  if (names.length > MAX_METRICS) shown.push(tr(lang, "more", { n: names.length - MAX_METRICS }));
  return shown;
}

/**
 * @param {string} tipo alert | recovered | current | previous
 * @param {object} p { client, critical, resolved, threshold, lang, hasEmail, delayed }
 */
function buildWhatsappMessage(tipo, p = {}) {
  const lang = normalizeLanguage(p.lang);
  const org = p.client?.name || p.orgname || "—";
  const threshold = p.threshold ?? 90;
  const critical = Array.isArray(p.critical) ? p.critical : [];
  const names = critical.map((k) => k.label || k.name).filter(Boolean);
  const count = names.length;
  const start = formatDay(p.client?.facturacion?.inicio, lang);
  const end = formatDay(p.client?.facturacion?.final, lang);

  const lines = [`*${tr(lang, "header", { org })}*`];

  switch (tipo) {
    case "alert":
      lines.push(tr(lang, "alert", { count, threshold }), ...metricLines(names, lang));
      break;
    case "recovered": {
      lines.push(tr(lang, "recovered", { threshold }));
      const resolved = Array.isArray(p.resolved) ? p.resolved.filter(Boolean) : [];
      if (resolved.length > 0) lines.push(tr(lang, "recovered_list"), ...metricLines(resolved, lang));
      break;
    }
    case "current":
      lines.push(
        count > 0 ? tr(lang, "current_bad", { count, threshold }) : tr(lang, "current_ok", { threshold }),
        ...metricLines(names, lang),
      );
      break;
    case "previous":
      lines.push(
        count > 0
          ? tr(lang, "previous_bad", { count, threshold, start, end })
          : tr(lang, "previous_ok", { threshold, start, end }),
        ...metricLines(names, lang),
      );
      break;
    default:
      return null;
  }

  lines.push("", tr(lang, p.hasEmail ? "see_email" : "see_dashboard"));
  if (p.delayed) lines.push(tr(lang, "delayed"));
  return lines.join("\n");
}

module.exports = { buildWhatsappMessage, whatsappText: tr };
