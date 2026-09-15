// Textos de los prompts de la IA, por idioma.
//
// No basta con pedirle al modelo que responda en el idioma del usuario: si la
// petición enumera las secciones en español ("1. Resumen ejecutivo de uso"), el
// modelo copia esos encabezados tal cual y devuelve un análisis en portugués
// con títulos en español. Por eso la estructura solicitada también va traducida.

const { normalizeLanguage, languageName } = require("./emailI18n");

const PROMPTS = {
  es: {
    sectionSummary: "Resumen ejecutivo de uso",
    sectionKpis: "Estado de KPIs principales",
    sectionAlerts: "Alertas",
    kpiLicenses: "Licencias",
    kpiResources: "Recursos",
    kpiStorage: "Storage",
    kpiAiTokens: "IA tokens",
    kpiOutbound: "Outbound attempts",
    metricsIntro:
      "Analiza las siguientes métricas de Genesys Cloud y proporciona un análisis sumamente conciso y directo estructurado exactamente en estas 3 secciones:",
    metricsSections: [
      "Resumen ejecutivo de uso",
      "Estado de KPIs principales",
      "Alertas",
    ],
    metricsLicenses: "Datos de licencias y uso general:",
    metricsLogins: "Resumen de conexiones diarias:",
    metricsOutbound: "Resumen de intentos outbound y campañas:",
    metricsOverage: "Detalles de sobreuso y últimos inicios de sesión:",
    metricsNoOverage: "No hay sobreuso de licencias detectado.",

    comparisonIntro:
      "Analiza la siguiente comparativa de métricas de Genesys Cloud entre periodos de facturación:",
    comparisonCategories: "Categorías seleccionadas:",
    comparisonData: "Datos de KPIs por periodo:",
    comparisonFocus: 'Enfócate especialmente en el KPI: "{{kpi}}"',
    comparisonGeneral: "Proporciona un análisis general de todos los KPIs.",
    comparisonEach: "Para cada KPI, incluye:",
    comparisonSections: [
      "Comparación numérica entre periodos",
      "Variación porcentual",
      "Tendencia",
      "Recomendaciones",
    ],
  },

  en: {
    sectionSummary: "Executive summary of usage",
    sectionKpis: "Status of main KPIs",
    sectionAlerts: "Alerts",
    kpiLicenses: "Licenses",
    kpiResources: "Resources",
    kpiStorage: "Storage",
    kpiAiTokens: "AI tokens",
    kpiOutbound: "Outbound attempts",
    metricsIntro:
      "Analyze the following Genesys Cloud metrics and provide a very concise and direct analysis structured exactly into these 3 sections:",
    metricsSections: [
      "Executive summary of usage",
      "Status of main KPIs",
      "Alerts",
    ],
    metricsLicenses: "License data and general usage:",
    metricsLogins: "Daily logins summary:",
    metricsOutbound: "Outbound attempts and campaigns summary:",
    metricsOverage: "Overage details and most recent logins:",
    metricsNoOverage: "No license overage detected.",

    comparisonIntro:
      "Analyze the following comparison of Genesys Cloud metrics across billing periods:",
    comparisonCategories: "Selected categories:",
    comparisonData: "KPI data by period:",
    comparisonFocus: 'Focus especially on this KPI: "{{kpi}}"',
    comparisonGeneral: "Provide a general analysis of all KPIs.",
    comparisonEach: "For each KPI, include:",
    comparisonSections: [
      "Numeric comparison between periods",
      "Percentage variation",
      "Trend",
      "Recommendations",
    ],
  },

  pt: {
    sectionSummary: "Resumo executivo de uso",
    sectionKpis: "Situação dos principais KPIs",
    sectionAlerts: "Alertas",
    kpiLicenses: "Licenças",
    kpiResources: "Recursos",
    kpiStorage: "Storage",
    kpiAiTokens: "Tokens de IA",
    kpiOutbound: "Tentativas de Outbound",
    metricsIntro:
      "Analise as seguintes métricas do Genesys Cloud e forneça uma análise altamente concisa e direta estruturada exatamente nestas 3 seções:",
    metricsSections: [
      "Resumo executivo de uso",
      "Situação dos principais KPIs",
      "Alertas",
    ],
    metricsLicenses: "Dados de licenças e uso general:",
    metricsLogins: "Resumo de conexões diárias:",
    metricsOutbound: "Resumo de tentativas outbound e campanhas:",
    metricsOverage: "Detalhes de sobreuso e últimos inícios de sessão:",
    metricsNoOverage: "Nenhum sobreuso de licenças detectado.",

    comparisonIntro:
      "Analise a seguinte comparação de métricas do Genesys Cloud entre períodos de faturamento:",
    comparisonCategories: "Categorias selecionadas:",
    comparisonData: "Dados de KPIs por período:",
    comparisonFocus: 'Concentre-se especialmente no KPI: "{{kpi}}"',
    comparisonGeneral: "Forneça uma análise geral de todos os KPIs.",
    comparisonEach: "Para cada KPI, inclua:",
    comparisonSections: [
      "Comparação numérica entre períodos",
      "Variação percentual",
      "Tendência",
      "Recomendações",
    ],
  },
};

function promptsFor(language) {
  return PROMPTS[normalizeLanguage(language)] || PROMPTS.es;
}

/** Bloque común que fija el idioma de salida en ambos análisis. */
function languageRule(language) {
  const idioma = languageName(language);
  return `IDIOMA DE LA RESPUESTA (OBLIGATORIO): redacta TODO el análisis en ${idioma}, incluidos los títulos de sección, las etiquetas y las recomendaciones. Los datos de entrada pueden contener texto en otro idioma; aun así, tu respuesta debe estar íntegramente en ${idioma}.`;
}

/** Lista numerada con el formato que ya pedían los prompts ("1.- "). */
function numbered(items) {
  return items.map((item, index) => `${index + 1}.- ${item}`).join("\n");
}

module.exports = { promptsFor, languageRule, numbered };
