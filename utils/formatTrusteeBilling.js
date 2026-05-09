function formatTrusteeBilling(billingData) {
  // Aquí puedes formatear los datos según tus necesidades

  const listNameLicences = [
    "Genesys Cloud CX 3",
    "Genesys Cloud CX 3 Concurrent",
    "Genesys Cloud CX 3 Digital User",
    "Genesys Cloud CX 3 Digital Concurrent User",
    "Genesys Cloud CX 2",
    "Genesys Cloud CX 2 Concurrent",
    "Genesys Cloud CX 2 Digital User",
    "Genesys Cloud CX 2 Digital Concurrent User",
    "Genesys Cloud for Wallboard Device Charge",
    "Genesys Cloud CX 1",
    "Genesys Cloud CX 1 Concurrent",
    "Genesys Cloud CX 1 Digital User",
    "Genesys Cloud CX 1 Digital Concurrent User",
    "Genesys Cloud Collaborate User",
    "Genesys Cloud Communicate User",
    "Mobile Office for Genesys Cloud Concurrent",
    "Smart Connector for HubSpot - Named",
    "CX Cloud from Genesys and Salesforce Concurrent",
    "DEV Genesys Cloud Partner Lab Bundle BYOC",
    "Journey Management for the Contact Center Concurrent",
  ];

  const listNameAIExperience = [
    "AI Guide",
    "AI Scoring",
    "AI Summary",
    "AI Translate",
    "Facebook Private Messaging",
    "Facebook Public Post Ingestion",
    "Facebook Public Post Response",
    "Genesys Cloud Agentic Virtual Agent",
    "Genesys Cloud Predictive Routing",
    "Genesys Cloud Virtual Agent",
    "Genesys Cloud for Bot Flow - Digital",
    "Genesys Cloud for Bot Flow - Voice",
    "Genesys Speech and Text Analytics",
    "Instagram Private Messaging",
    "Instagram Public Post Ingestion",
    "Instagram Public Post Response",
    "WhatsApp Private Messaging",
    "WhatsApp Public Post Ingestion",
    "WhatsApp Public Post Response",
    "X Private Messaging",
    "X Public Post Ingestion",
    "X Public Post Response",
  ];

  const listNameDevices = ["Genesys Cloud Static WebRTC TURN Charge"];

  const listNameResources = [
    "BYOT Rate A",
    "BYOT Rate B Per Transaction",
    "BYOT Rate C Per Minute",
    "BYOT Rate D Per Transaction",
    "BYOT Rate E Per Minute",
    "Genesys Cloud BYOC Cloud",
    "Genesys Cloud Voice Transcription",
    "Genesys Cloud IVR Basic Per Minute Charge",
    "Genesys Cloud API Resource",
  ];

  const listNameAddons = [
    "Feebak 2 for Genesys Cloud",
    "Genesys Cloud CX 1 Digital Add-On II",
    "Genesys Cloud CX 1 Digital Add-On II",
    "Genesys Cloud CX 1 Digital Add-On II Concurrent",
    "Genesys Cloud CX 1 WEM Add-On II",
    "Genesys Cloud for Salesforce Add-on",
    "Auvious Videο Named Licenses (Metered)",
    "Genesys Cloud CX 2 Digital Add-On I",
    "Genesys Cloud CX 2 WEM Add-On I",
    "Auvious Videο Named Licenses (Metered)",
    "PureCloud for Sugar CRM Connector Add-On",
    "ApifyCloud WhatsApp Connector BYO-BSP",
    "Twitter Addon Small",
    "Genesys Cloud for Salesforce Concurrent Add-on",
    "Work Automation Add-On Concurrent",
    "Genesys Cloud CX 2 Digital Add-On I Concurrent",
    "Genesys Cloud CX 2 WEM Add-On I Concurrent",
  ];

  const listNameToken = [
    "AI Experience Tokens Concurrent",
    "AI Experience Tokens",
    "AI Experience Tokens - GC1",
  ];

  const listLicencesFounded = (billingData.usages || [])
    .filter((usage) => listNameLicences.includes(usage.name))
    .map((usage) => ({
      name: usage.name,
      prepayQuantity: usage.prepayQuantity ?? 0,
      overageQuantity:
        Number(usage.usageQuantity) > Number(usage.prepayQuantity)
          ? Number(usage.usageQuantity) - Number(usage.prepayQuantity)
          : 0,
      usageQuantity: usage.usageQuantity ?? 0,
    }));

  const listTokensFounded = (billingData.usages || [])
    .filter((usage) => listNameToken.includes(usage.name))
    .map((usage) => ({
      name: usage.name,
      prepayQuantity: usage.prepayQuantity ?? 0,
      overageQuantity:
        Number(usage.usageQuantity) > Number(usage.prepayQuantity)
          ? Number(usage.usageQuantity) - Number(usage.prepayQuantity)
          : 0,
      usageQuantity: usage.usageQuantity ?? 0,
    }));

  const listAddonsFounded = (billingData.usages || [])
    .filter((usage) => listNameAddons.includes(usage.name))
    .map((usage) => ({
      name: usage.name,
      prepayQuantity: usage.prepayQuantity ?? 0,
      overageQuantity:
        Number(usage.usageQuantity) > Number(usage.prepayQuantity)
          ? Number(usage.usageQuantity) - Number(usage.prepayQuantity)
          : 0,
      usageQuantity: usage.usageQuantity ?? 0,
    }));

  const groupedByName = (billingData.usages || [])
    .filter((usage) => listNameResources.includes(usage.name))
    .reduce((acc, usage) => {
      const name = usage.name;
      if (!acc[name]) acc[name] = [];
      acc[name].push(usage);
      return acc;
    }, {});

  const listResourcesFounded = Object.keys(groupedByName).map((name) => {
    const entries = groupedByName[name];
    const resourceEntry = entries.find((e) => e.grouping === "resource");
    const fairUseEntry = entries.find((e) => e.grouping === "fair-use");
    const mainEntry = resourceEntry || entries[0];

    const prepay = Number(mainEntry.prepayQuantity || 0);
    const usageQty = Number(mainEntry.usageQuantity || 0);
    const incluido = Number(fairUseEntry?.usageQuantity || 0);
    return {
      name: name,
      prepayQuantity: prepay,
      overageQuantity:
        usageQty > prepay + incluido ? usageQty - (prepay + incluido) : 0,
      usageQuantity: usageQty,
      incluido: incluido,
    };
  });

  const listAIExperienceFounded = (billingData.usages || [])
    .filter((usage) => listNameAIExperience.includes(usage.name))
    .map((usage) => ({
      name: usage.name,
      prepayQuantity: usage.prepayQuantity ?? 0,
      overageQuantity:
        Number(usage.usageQuantity) > Number(usage.prepayQuantity)
          ? Number(usage.usageQuantity) - Number(usage.prepayQuantity)
          : 0,
      usageQuantity: usage.usageQuantity ?? 0,
    }));

  const listDevicesFounded = (billingData.usages || [])
    .filter((usage) => listNameDevices.includes(usage.name))
    .map((usage) => ({
      name: usage.name,
      prepayQuantity: usage.prepayQuantity ?? 0,
      overageQuantity:
        Number(usage.usageQuantity) > Number(usage.prepayQuantity)
          ? Number(usage.usageQuantity) - Number(usage.prepayQuantity)
          : 0,
      usageQuantity: usage.usageQuantity ?? 0,
    }));

  const tokensUnified = {
    name: "",
    prepayQuantity: 0,
    overageQuantity: 0,
    usageQuantity: 0,
    incluido: 0,
  };

  for (let index = 0; index < listTokensFounded.length; index++) {
    const token = listTokensFounded[listTokensFounded.length - 1 - index];
    if (token.overageQuantity === 0 && token.prepayQuantity === 0) {
      tokensUnified.incluido = Number(token.usageQuantity);
    } else {
      tokensUnified.name = token.name;
      tokensUnified.prepayQuantity = Number(token.prepayQuantity);
      tokensUnified.usageQuantity = Number(token.usageQuantity);
      tokensUnified.overageQuantity =
        token.prepayQuantity > 0
          ? token.usageQuantity >
            Number(token.prepayQuantity) + Number(tokensUnified.incluido)
            ? token.usageQuantity - token.prepayQuantity
            : 0
          : token.usageQuantity > tokensUnified.incluido
          ? token.usageQuantity - tokensUnified.incluido
          : 0;
    }
  }

  const storage = buscarPorNombre(
    billingData.usages || [],
    "Genesys Cloud Data Storage"
  );

  const customerData = {
    name: billingData.organization?.name || "",
    orgId: billingData.organization?.id || "",
    licencias: listLicencesFounded,
    facturacion: {
      inicio: billingData.billingPeriodStartDate,
      final: billingData.billingPeriodEndDate,
    },
    rampUp: {
      inicio: billingData.rampPeriodStartDate,
      final: billingData.rampPeriodEndDate,
    },
    storage: {
      comprometido: storage?.prepayQuantity ?? 0,
      enUso: storage?.usageQuantity ?? 0,
      overageQuantity:
        (storage?.prepayQuantity || 0) > (storage?.usageQuantity || 0)
          ? 0
          : (storage?.usageQuantity || 0) - (storage?.prepayQuantity || 0),
    },
    iaTokens: tokensUnified,
    addons: listAddonsFounded,
    resources: listResourcesFounded,
    aiExperience: listAIExperienceFounded,
    devices: listDevicesFounded,
  };

  return customerData;
}

function buscarPorNombre(lista, nombreBuscado) {
  return lista.find((item) => item.name === nombreBuscado) || null;
}

module.exports = {
  formatTrusteeBilling,
};
