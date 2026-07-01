function formatDate(dateString) {
  return new Date(dateString).toLocaleDateString("es-ES", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function calculatePercentage(used, total) {
  if (total === 0 && used === 0) return 0;
  return Math.round((used / total) * 100);
}

function getProgressBarColor(percentage) {
  if (percentage >= 90) return "#dc2626"; // Rojo
  if (percentage >= 75) return "#ea580c"; // Naranja
  if (percentage >= 50) return "#eab308"; // Amarillo
  return "#16a34a"; // Verde
}

const footer = `<p style="margin: 0; padding: 0; font-size: 14px; opacity: 0.8; color: white;">
                Este correo fue enviado automáticamente por el sistema de monitoreo de <strong>License Manager</strong>.<br />
                Si tienes dudas, contáctanos a <a href="mailto:licensemanager@esmtconsulting.com" style="color: #60a5fa;">licensemanager@esmtconsulting.com</a>.<br />
                © 2025 License Manager
              </p>`;

function generateNotificationEmailTemplate(templateType, clientData) {
  const cxConcurrent = clientData.licencias.find((l) =>
    l.name.includes("CX 3 Concurrent"),
  );
  const digitalConcurrent = clientData.licencias.find((l) =>
    l.name.includes("Digital Concurrent"),
  );

  const cxUsed = parseInt(cxConcurrent?.usageQuantity || "0", 10);
  const cxTotal = parseInt(cxConcurrent?.prepayQuantity || "0", 10);
  const cxPercentage = calculatePercentage(cxUsed, cxTotal);

  const digitalUsed = parseInt(digitalConcurrent?.usageQuantity || "0", 10);
  const digitalTotal = parseInt(digitalConcurrent?.prepayQuantity || "0", 10);
  const digitalPercentage = calculatePercentage(digitalUsed, digitalTotal);

  const storageUsed = parseInt(clientData.storage.enUso, 10);
  const storageTotal = parseInt(clientData.storage.comprometido, 10);
  const storagePercentage = calculatePercentage(storageUsed, storageTotal);

  const tokensUsed = clientData.iaTokens.usageQuantity;
  const tokensTotal = clientData.iaTokens.prepayQuantity;
  const tokensPercentage =
    clientData.iaTokens.incluido > 0
      ? Math.round(
        (clientData.iaTokens.usageQuantity /
          (clientData.iaTokens.prepayQuantity +
            clientData.iaTokens.incluido)) *
        100,
      )
      : 0;
  console.log("CLIENT DATA", clientData);
  const periodStart = formatDate(clientData.facturacion.inicio);
  const periodEnd = formatDate(clientData.facturacion.final);

  switch (templateType) {
    case "current":
      return {
        subject: `📈 Reporte Actual - ${clientData.name} | Estado de Licencias`,
        html: `<!DOCTYPE html>
  <html lang="es">
    <head>
      <meta charset="UTF-8">
      <title>Reporte Actual</title>
    </head>
    <body style="margin: 0; padding: 0; background-color: #f9fafb;">
          <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <div style="padding: 32px 24px; text-align: center; color: white; background: #3b82f6;">
    <h1 style="margin: 0 0 8px 0; font-size: 28px; font-weight: 700;">📈 Reporte Actual</h1>
    <p style="margin: 0; font-size: 16px; opacity: 0.9;">Estado actual de licencias y recursos</p>
  </div>

  <div style="padding: 32px 24px;">
    <div style="background: #f1f5f9; padding: 16px; border-radius: 8px; margin-bottom: 24px; text-align: center;">
      <h3 style="margin: 0 0 4px 0; color: #475569; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Período de Facturación</h3>
      <p style="margin: 0; color: #1e293b; font-size: 16px; font-weight: 500;">${periodStart} - ${periodEnd}</p>
    </div>

    ${clientData.licencias
            .map((lic) => {
              const licUsed = Number(lic?.usageQuantity ?? 0);
              const licTotal = Number(lic?.prepayQuantity ?? 0);
              const licPercentage = calculatePercentage(licUsed, licTotal);
              const licBarColor = getProgressBarColor(licPercentage);

              return `
            <table width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid #e2e8f0; border-radius: 8px; background: #fefefe; margin-bottom: 20px; padding: 20px;">
              <tr>
                <td style="padding: 20px;">
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td align="left" style="font-size: 14px; font-weight: 600; color: #475569;">${lic.name}:</td>
                      <td align="right" style="font-size: 18px; font-weight: 700; color: #1e293b;">${lic.usageQuantity} / ${lic.prepayQuantity}</td>
                    </tr>
                  </table>
                  <div style="width: 100%; height: 8px; background: #e2e8f0; border-radius: 4px; overflow: hidden; margin: 8px 0;">
                    <div style="height: 8px; width: ${Number.isFinite(licPercentage) ? licPercentage : 0}%; background-color: ${licBarColor}; border-radius: 4px;"></div>
                  </div>
                  <div style="font-size: 12px; color: #64748b; text-align: right;">${Number.isFinite(licPercentage) ? licPercentage : 0}% utilizado</div>
                </td>
              </tr>
            </table>
            `;
            })
            .join("")}
            
            ${[
            {
              label: "Storage",
              used: storageUsed.toLocaleString() + " GB",
              total: storageTotal.toLocaleString() + " GB",
              percent: storagePercentage,
              barColor: getProgressBarColor(storagePercentage),
            },
            {
              label: "IA Tokens",
              used: tokensUsed.toLocaleString(),
              total: tokensTotal.toLocaleString(),
              percent: tokensPercentage,
              barColor: getProgressBarColor(tokensPercentage),
            },
          ]
            .map(
              (item) => `
        
      <table width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid #e2e8f0; border-radius: 8px; background: #fefefe; margin-bottom: 20px; padding: 20px;">
        <tr>
          <td style="padding: 20px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td align="left" style="font-size: 14px; font-weight: 600; color: #475569;">${item.label}:</td>
                <td align="right" style="font-size: 18px; font-weight: 700; color: #1e293b;">${item.used} / ${item.total}</td>
              </tr>
            </table>
            <div style="width: 100%; height: 8px; background: #e2e8f0; border-radius: 4px; overflow: hidden; margin: 8px 0;">
              <div style="height: 8px; width:${Number.isFinite(item.percent) ? item.percent : 0}%; background-color: ${item.barColor}; border-radius: 4px;"></div>
            </div>
            <div style="font-size: 12px; color: #64748b; text-align: right;">${Number.isFinite(item.percent) ? item.percent : 0}% utilizado</div>
          </td>
        </tr>
      </table>
    `,
            )
            .join("")}

    ${clientData.addons && clientData.addons.length > 0
            ? `
      <div style="background: #f8fafc; border-radius: 8px; padding: 20px; margin-top: 24px;">
        <h3 style="margin: 0 0 16px 0; color: #1e293b; font-size: 18px; font-weight: 600;">Resumen de Add-ons</h3>
        ${clientData.addons
              .map(
                (addon) => `
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 8px; border-bottom: 1px solid #e2e8f0;">
              <tr>
                <td align="left" style="font-size: 14px; color: #475569;">${addon.name}:</td>
                <td align="right" style="font-size: 14px; font-weight: 500; color: #1e293b;">${addon.usageQuantity} / ${addon.prepayQuantity}</td>
              </tr>
            </table>
          `,
              )
              .join("")}
      </div>
    `
            : ""
          }
  </div>

  <div style="background: #1e293b; color: white; padding: 24px; text-align: center;">
    <p style="margin: 0 0 16px 0; font-size: 14px; opacity: 0.8;">Reporte generado automáticamente para ${clientData.name}</p>
    ${footer}
  </div>
</div>
    </body>
  </html>

        `,
        text: `Reporte de Estado Actual - ${clientData.name}\n\nPeríodo: ${periodStart} - ${periodEnd}\n\nCX 3 Concurrent: ${cxUsed}/${cxTotal} (${cxPercentage}%)\nDigital Concurrent: ${digitalUsed}/${digitalTotal} (${digitalPercentage}%)\nStorage: ${storageUsed} GB/${storageTotal} GB (${storagePercentage}%)\nIA Tokens: ${tokensUsed}/${tokensTotal} (${tokensPercentage}%)`,
      };

    case "previous":
      return {
        subject: `📊 Reporte Final - Período Completado | ${clientData.name}`,
        html: `<!DOCTYPE html>
  <html lang="es">
    <head>
      <meta charset="UTF-8">
      <title>Reporte Final</title>
    </head>
    <body style="margin: 0; padding: 0; background-color: #f9fafb;">
          <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <div style="padding: 32px 24px; text-align: center; color: white; background: #16a34a;">
    <h1 style="margin: 0 0 8px 0; font-size: 28px; font-weight: 700;">📊 Reporte Final</h1>
    <p style="margin: 0; font-size: 16px; opacity: 0.9;">Resumen del período de facturación completado</p>
  </div>

  <div style="padding: 32px 24px;">
    <div style="background: #f1f5f9; padding: 16px; border-radius: 8px; margin-bottom: 24px; text-align: center;">
      <h3 style="margin: 0 0 4px 0; color: #475569; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Período Completado</h3>
      <p style="margin: 0; color: #1e293b; font-size: 16px; font-weight: 500;">${periodStart} - ${periodEnd}</p>
    </div>

    <div style="background: #f8fafc; border-radius: 8px; padding: 20px; margin-top: 24px; margin-bottom: 32px;">
      <h3 style="margin: 0 0 16px 0; color: #1e293b; font-size: 18px; font-weight: 600;">Resumen Final de Uso</h3>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 12px;">

${clientData.licencias
            .map((lic) => {
              const licUsed = Number(lic?.usageQuantity ?? 0);
              const licTotal = Number(lic?.prepayQuantity ?? 0);
              const licPercentage = calculatePercentage(licUsed, licTotal);
              const barColor = licPercentage > 100 ? "#dc2626" : "#16a34a";
              return `
                <tr>
          <td align="left" style="color: #475569; font-size: 14px;">${lic.name}:</td>
          <td align="right" style="color: ${barColor}; font-size: 14px; font-weight: 500;">${licUsed} / ${licTotal} (${licPercentage}%)</td>
        </tr>
              `;
            })
            .join("")}


        <tr>
          <td align="left" style="color: #475569; font-size: 14px;">Storage:</td>
          <td align="right" style="color: #1e293b; font-size: 14px; font-weight: 500;">${storageUsed.toLocaleString()} GB / ${storageTotal.toLocaleString()} GB (${storagePercentage}%)</td>
        </tr>
        <tr>
          <td align="left" style="color: #475569; font-size: 14px;">IA Tokens:</td>
          <td align="right" style="color: #1e293b; font-size: 14px; font-weight: 500;">${tokensUsed.toLocaleString()} / ${tokensTotal.toLocaleString()} (${tokensPercentage}%)</td>
        </tr>
      </table>
    </div>

    <div style="margin-bottom: 32px;">
      <div style="border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; background: #fefefe; margin-bottom: 20px;">
        <h3 style="margin: 0 0 12px 0; color: #16a34a; font-size: 16px; font-weight: 600;">✅ Licencias Disponibles</h3>
        ${clientData.licencias
            .map((lic) => {
              const licUsed = Number(lic?.usageQuantity ?? 0);
              const licTotal = Number(lic?.prepayQuantity ?? 0);
              // si licTotal - licUsed < 0
              const availableLicenses =
                licTotal - licUsed < 0 ? 0 : licTotal - licUsed;
              return `
        
        <p style="margin: 0 0 8px 0; font-size: 14px; color: #333;">${lic.name}: ${availableLicenses} licencias disponibles</p>
        `;
            })
            .join("")}
        </div>

      <div style="border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; background: #fefefe;">
        <h3 style="margin: 0 0 12px 0; color: #3b82f6; font-size: 16px; font-weight: 600;">📈 Eficiencia de Uso</h3>
        <p style="margin: 0 0 8px 0; font-size: 14px; color: #333;">Promedio de utilización: ${Math.round((cxPercentage + digitalPercentage + storagePercentage + tokensPercentage) / 4)}%</p>
        <p style="margin: 0; font-size: 14px; color: #333;">Storage optimizado: ${storagePercentage < 80 ? "Sí" : "Revisar"}</p>
      </div>
    </div>

    ${clientData.addons && clientData.addons.length > 0
            ? `
      <div style="background: #f8fafc; border-radius: 8px; padding: 20px; margin-top: 24px;">
        <h3 style="margin: 0 0 16px 0; color: #1e293b; font-size: 18px; font-weight: 600;">Add-ons Utilizados</h3>
        ${clientData.addons
              .map(
                (addon) => `
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 8px; border-bottom: 1px solid #e2e8f0;">
              <tr>
                <td align="left" style="color: #475569; font-size: 14px;">${addon.name}</td>
                <td align="right" style="color: #1e293b; font-size: 14px; font-weight: 500;">${addon.usageQuantity} / ${addon.prepayQuantity}</td>
              </tr>
            </table>
          `,
              )
              .join("")}
      </div>
    `
            : ""
          }
  </div>

  <div style="background: #1e293b; color: white; padding: 24px; text-align: center;">
    <p style="margin: 0 0 8px 0; font-size: 14px; opacity: 0.8;">Período de facturación completado exitosamente</p>
    <p style="margin: 0 0 8px 0; font-size: 14px; opacity: 0.8;">Próximo período inicia automáticamente</p>
    <p style="margin: 0 0 16px 0; font-size: 14px; opacity: 0.8;">Reporte generado automáticamente para ${clientData.name}</p>
    ${footer}
  </div>
</div>

    </body>
  </html>
        `,
        text: `Reporte del Período Finalizado - ${clientData.name}\n\nPeríodo: ${periodStart} - ${periodEnd}\n\nResumen Final:\nCX 3 Concurrent: ${cxUsed}/${cxTotal} (${cxPercentage}%)\nDigital Concurrent: ${digitalUsed}/${digitalTotal} (${digitalPercentage}%)\nStorage: ${storageUsed} GB/${storageTotal} GB (${storagePercentage}%)\nIA Tokens: ${tokensUsed}/${tokensTotal} (${tokensPercentage}%)\n\nLicencias disponibles: ${(cxTotal - cxUsed).toLocaleString()} CX 3, ${(digitalTotal - digitalUsed).toLocaleString()} Digital`,
      };

    case "alert":
      const criticalMetrics = [];

      clientData.licencias.forEach((lic) => {
        const licUsed = Number(lic?.usageQuantity ?? 0);
        const licTotal = Number(lic?.prepayQuantity ?? 0);
        const licPercentage = calculatePercentage(licUsed, licTotal);
        if (licTotal === 0 && licUsed > 0) {
          criticalMetrics.push(`${lic.name}: ${licUsed}`);
        } else if (licPercentage >= 90) {
          criticalMetrics.push(`${lic.name}: ${licPercentage}%`);
        }
      });
      if (clientData.addons) {
        for (const addon of clientData.addons) {
          const addonUsed = Number(addon?.usageQuantity ?? 0);
          const addonTotal = Number(addon?.prepayQuantity ?? 0);
          const addonPercentage = calculatePercentage(addonUsed, addonTotal);
          if (addonTotal === 0 && addonUsed > 0) {
            criticalMetrics.push(`${addon.name}: ${addonUsed}`);
          } else if (addonPercentage >= 90) {
            criticalMetrics.push(`${addon.name}: ${addonPercentage}%`);
          }
        }
      }

      if (storagePercentage >= 90)
        criticalMetrics.push(`Storage: ${storagePercentage}%`);
      if (tokensPercentage >= 90)
        criticalMetrics.push(`IA Tokens: ${tokensPercentage}%`);

      return {
        subject: `🚨 Notificación de uso elevado - Genesys Cloud | ${clientData.name}`,
        html: `
        <!DOCTYPE html>
  <html lang="es">
    <head>
      <meta charset="UTF-8">
      <title>Notificación</title>
    </head>
    <body style="margin: 0; padding: 0; background-color: #f9fafb;">
          <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
            <div style="padding: 32px 24px; text-align: center; color: white; background:  #dc2626;">
              <h1 style="margin: 0 0 8px 0; font-size: 28px; font-weight: 700;">Notificación</h1>
              <p style="margin: 0; font-size: 16px; opacity: 0.9;">Uso elevado detectado - Supervision del servicio recomendado</p>
            </div>
            
            <div style="padding: 32px 24px;">
              <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
                <h3 style="margin: 0 0 4px 0; color: #dc2626; font-size: 16px; font-weight: 600;">⚠️ ¿Qué ha pasado?</h3>
                <p style="margin: 0; color: #991b1b; font-size: 14px;">Se ha detectado uso crítico en uno o más servicios. Revise los detalles a continuación.</p>
              </div>
              
              <div style="background: #f1f5f9; padding: 16px; border-radius: 8px; margin-bottom: 24px; text-align: center;">
                <h3 style="margin: 0 0 4px 0; color: #475569; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Período Actual</h3>
                <p style="margin: 0; color: #1e293b; font-size: 16px; font-weight: 500;">${periodStart} - ${periodEnd}</p>
              </div>
              
              <div style="margin-bottom: 32px;">
                      ${clientData.licencias
            .filter((lic) => {
              const licUsed = Number(lic?.usageQuantity ?? 0);
              const licTotal = Number(lic?.prepayQuantity ?? 0);
              const licPercentage = calculatePercentage(
                licUsed,
                licTotal,
              );
              return licPercentage >= 90;
            })
            .map((lic) => {
              const licUsed = Number(lic?.usageQuantity ?? 0);
              const licTotal = Number(lic?.prepayQuantity ?? 0);
              const licPercentage = calculatePercentage(
                licUsed,
                licTotal,
              );

              return `
                            <div style="border: 1px solid #dc2626; border-radius: 8px; padding: 20px; background: #fef2f2; margin-bottom: 20px;">
                              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                                <span style="font-size: 14px; font-weight: 600; color: #dc2626;">🔴 ${lic.name} - CRÍTICO</span>
                                <span style="font-size: 18px; font-weight: 700; color: #dc2626;">${lic.usageQuantity} / ${lic.prepayQuantity}</span>
                              </div>
                              <div style="width: 100%; height: 8px; background: #e2e8f0; border-radius: 4px; overflow: hidden; margin-bottom: 8px;">
                                <div style="height: 100%; border-radius: 4px; width:  ${Number.isFinite(licPercentage) ? licPercentage : 0}%; background-color: #dc2626;"></div>
                              </div>
                              <div style="font-size: 12px; color: #dc2626; font-weight: 600; text-align: right;"> ${Number.isFinite(licPercentage) ? licPercentage : 0}% utilizado - SOBREUSO INMINENTE</div>
                            </div>
                          `;
            })
            .join("")}
 
            ${(clientData.addons || [])
            .filter((addon) => {
              const addonUsed = Number(addon?.usageQuantity ?? 0);
              const addonTotal = Number(addon?.prepayQuantity ?? 0);
              const addonPercentage = calculatePercentage(
                addonUsed,
                addonTotal,
              );
              return addonPercentage >= 90;
            })
            .map((addon) => {
              const addonUsed = Number(addon?.usageQuantity ?? 0);
              const addonTotal = Number(addon?.prepayQuantity ?? 0);
              const addonPercentage = calculatePercentage(
                addonUsed,
                addonTotal,
              );

              return `
                              <div style="border: 1px solid #dc2626; border-radius: 8px; padding: 20px; background: #fef2f2; margin-bottom: 20px;">
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                                  <span style="font-size: 14px; font-weight: 600; color: #dc2626;">🔴 ${addon.name} - CRÍTICO</span>
                                  <span style="font-size: 18px; font-weight: 700; color: #dc2626;">${addon.usageQuantity} / ${addon.prepayQuantity}</span>
                                </div>
                                <div style="width: 100%; height: 8px; background: #e2e8f0; border-radius: 4px; overflow: hidden; margin-bottom: 8px;">
                                  <div style="height: 100%; border-radius: 4px; width:  ${Number.isFinite(addonPercentage) ? addonPercentage : 0}%; background-color: #dc2626;"></div>
                                </div>
                                <div style="font-size: 12px; color: #dc2626; font-weight: 600; text-align: right;"> ${Number.isFinite(addonPercentage) ? addonPercentage : 0}% utilizado - SOBREUSO INMINENTE</div>
                              </div>
                            `;
            })
            .join("")}
                        
                      ${storagePercentage >= 90
            ? `
                              <div style="border: 1px solid #dc2626; border-radius: 8px; padding: 20px; background: #fef2f2; margin-bottom: 20px;">
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                                  <span style="font-size: 14px; font-weight: 600; color: #dc2626;">🔴 Storage - CRÍTICO</span>
                                  <span style="font-size: 18px; font-weight: 700; color: #dc2626;">${storageUsed.toLocaleString()} GB / ${storageTotal.toLocaleString()} GB</span>
                                </div>
                                <div style="width: 100%; height: 8px; background: #e2e8f0; border-radius: 4px; overflow: hidden; margin-bottom: 8px;">
                                  <div style="height: 100%; border-radius: 4px; width:  ${Number.isFinite(storagePercentage) ? storagePercentage : 0}%; background-color: #dc2626;"></div>
                                </div>
                                <div style="font-size: 12px; color: #dc2626; font-weight: 600; text-align: right;"> ${Number.isFinite(storagePercentage) ? storagePercentage : 0}% utilizado - SOBREUSO INMINENTE</div>
                              </div>
                            `
            : ""
          }
                      
                      ${tokensPercentage >= 90
            ? `
                              <div style="border: 1px solid #dc2626; border-radius: 8px; padding: 20px; background: #fef2f2; margin-bottom: 20px;">
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                                  <span style="font-size: 14px; font-weight: 600; color: #dc2626;">🔴 IA Tokens - CRÍTICO</span>
                                  <span style="font-size: 18px; font-weight: 700; color: #dc2626;">${tokensUsed.toLocaleString()} / ${tokensTotal.toLocaleString()}</span>
                                </div>
                                <div style="width: 100%; height: 8px; background: #e2e8f0; border-radius: 4px; overflow: hidden; margin-bottom: 8px;">
                                  <div style="height: 100%; border-radius: 4px; width:  ${Number.isFinite(tokensPercentage) ? tokensPercentage : 0}%; background-color: #dc2626;"></div>
                                </div>
                                <div style="font-size: 12px; color: #dc2626; font-weight: 600; text-align: right;"> ${Number.isFinite(tokensPercentage) ? tokensPercentage : 0}% utilizado - SOBREUSO INMINENTE</div>
                              </div>
                            `
            : ""
          }
              </div>
              
              <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 20px; margin-top: 24px;">
                <h3 style="margin: 0 0 16px 0; color: #dc2626; font-size: 18px; font-weight: 600;">🚨 Acciones Recomendadas</h3>
                <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #e2e8f0;">
                  <span style="color: #475569; font-size: 14px;">1. Contactar Soporte: </span>
                  <span style="color: #1e293b; font-size: 14px; font-weight: 500;">licensemanager@esmtconsulting.com</span>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #e2e8f0;">
                  <span style="color: #475569; font-size: 14px;">2. Revisar Uso: </span>
                  <span style="color: #1e293b; font-size: 14px; font-weight: 500;">Optimizar recursos activos</span>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 8px 0;">
                  <span style="color: #475569; font-size: 14px;">3. Considerar Upgrade: </span>
                  <span style="color: #1e293b; font-size: 14px; font-weight: 500;">Aumentar límites si es necesario</span>
                </div>
              </div>
              
              <div style="text-align: center; margin-top: 24px;">
                <a href="mailto:licensemanager@esmtconsulting.com" style="display: inline-block; background: #dc2626; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 500; margin: 16px 0;">
                  📞 Contactar Soporte Inmediatamente
                </a>
              </div>
            </div>
            
            <div style="background: #dc2626; color: white; padding: 24px; text-align: center;">
              <p style="margin: 0 0 16px 0; font-size: 14px; opacity: 0.8;">Reporte generado automáticamente para ${clientData.name}</p>
              ${footer}
            </div>
          </div>
 
    </body>
  </html>
        `,
        text: `🚨 Notificación de uso elevado - Genesys Cloud  - ${clientData.name}\n\nUso elevado detectado en:\n${criticalMetrics.join("\n")}\n\nPeríodo: ${periodStart} - ${periodEnd}\n\nSupervisión recomendada:\n1. Revisar su tablero en License Manager\n2. Revisar y optimizar uso de recursos\n3. Considerar upgrade de licencias\n\nEste es un mensaje automático de License Manager.`,
      };

    default:
      throw new Error("Tipo de plantilla no válido");
  }
}

function generateTemplate(templateType, data) {
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
                ${footer}
              </div>
            </div>
          </body>
        </html>
        `,
        text: `🎉 ¡Bienvenido/a a ${data.orgname}! 🎉\n\nTu acceso a los servicios de ${data.orgname} ha sido activado exitosamente.\n\nUsa las siguientes credenciales para iniciar sesión:\n\n================================\n🔑 CREDENCIALES DE ACCESO\n================================\n\nORGANIZACIÓN: ${data.orgname}\nUSUARIO: ${data.usuario}\nCONTRASEÑA TEMPORAL: ${data.password}\n\n--------------------------------\n\n\n ⚠️ RECOMENDACIÓN DE SEGURIDAD:\nPor favor, cambia tu contraseña temporal inmediatamente después de iniciar sesión.\n\nSi tienes algún problema, contacta a soporte en: licensemanager@esmtconsulting.com\n\nEste es un mensaje automático.`,
      };

    case "userupdated":
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
                  
                  ${isPasswordUpdate
            ? `<div style="display: flex; padding: 10px 0; border-top: 1px solid #dbeafe;">
                        <p style="margin: 0; color: #dc2626; font-size: 14px; font-weight: 600;">* NOTA: Tu contraseña fue modificada.</p>
                    </div>`
            : ""
          }

                  ${data.role
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
                ${footer}
              </div>
            </div>
          </body>
        </html>
        `,
        text: `✅ Actualización de Perfil en ${data.orgname} ✅\n\nTu información de usuario en ${data.orgname} ha sido actualizada exitosamente.\n\n================================\n👤 DETALLES DE LA CUENTA\n================================\n\nORGANIZACIÓN: ${data.orgname}\nUSUARIO: ${data.usuario}\n${isPasswordUpdate ? "⚠️ NOTA: Tu contraseña fue cambiada.\n" : ""}\n--------------------------------\n\nSi no realizaste esta acción o si tienes preguntas, contacta a soporte en: licensemanager@esmtconsulting.com\n\nEste es un mensaje automático.`,
      };

    default:
      throw new Error("Tipo de plantilla no válido");
  }
}

module.exports = {
  generateNotificationEmailTemplate,
  generateTemplate,
};
