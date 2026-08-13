// Textos de los prompts de la IA, por idioma.
//
// No basta con pedirle al modelo que responda en el idioma del usuario: si la
// petición enumera las secciones en español ("1. Resumen ejecutivo de uso"), el
// modelo copia esos encabezados tal cual y devuelve un análisis en portugués
// con títulos en español. Por eso la estructura solicitada también va traducida.

const { normalizeLanguage, languageName } = require("./emailI18n");

const PROMPTS = {
  es: {
    metricsIntro: "Analiza las siguientes métricas de Genesys Cloud y proporciona:",
    metricsSections: [
      "Resumen ejecutivo de uso",
      "Estado de KPIs principales (licencias, recursos, storage, IA tokens e intentos Outbound)",
      "Alertas (si hay sobreuso)",
      "Recomendaciones específicas para optimización",
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
    metricsIntro: "Analyze the following Genesys Cloud metrics and provide:",
    metricsSections: [
      "Executive summary of usage",
      "Status of the main KPIs (licenses, resources, storage, AI tokens and Outbound attempts)",
      "Alerts (if there is any overage)",
      "Specific recommendations for optimization",
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
    metricsIntro: "Analise as seguintes métricas do Genesys Cloud e forneça:",
    metricsSections: [
      "Resumo executivo de uso",
      "Situação dos principais KPIs (licenças, recursos, armazenamento, tokens de IA e tentativas de Outbound)",
      "Alertas (caso haja excedente)",
      "Recomendações específicas de otimização",
    ],
    metricsLicenses: "Dados de licenças e uso geral:",
    metricsLogins: "Resumo de acessos diários:",
    metricsOutbound: "Resumo de tentativas de outbound e campanhas:",
    metricsOverage: "Detalhes de excedente e últimos acessos:",
    metricsNoOverage: "Nenhum excedente de licenças detectado.",

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
