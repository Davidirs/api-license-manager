// Traducciones de las plantillas de correo.
//
// Mismos tres idiomas que el dashboard (utils/translations.ts): es, en, pt.
// El idioma sale de `preferences.language` del usuario destinatario; si no lo
// tiene configurado, se cae a español.

const DEFAULT_LANGUAGE = "es";
const SUPPORTED_LANGUAGES = ["es", "en", "pt"];

/** Normaliza cualquier entrada ("ES", "en-US", null) a un idioma soportado. */
function normalizeLanguage(value) {
  const base = String(value || "")
    .trim()
    .toLowerCase()
    .split(/[-_]/)[0];
  return SUPPORTED_LANGUAGES.includes(base) ? base : DEFAULT_LANGUAGE;
}

/** Locale para toLocaleDateString / toLocaleString. */
const LOCALES = {
  es: "es-ES",
  en: "en-US",
  pt: "pt-BR",
};

/** Locale para el formato de números (separadores de miles y decimales). */
const NUMBER_LOCALES = {
  es: "es-MX",
  en: "en-US",
  pt: "pt-BR",
};

/**
 * Nombre del idioma en su propia lengua. Es lo que se le indica a la IA para
 * que redacte su análisis en el idioma del usuario.
 */
const LANGUAGE_NAMES = {
  es: "español",
  en: "English",
  pt: "português",
};

/**
 * Nombre del idioma a partir de un código (o del propio nombre).
 *
 * Acepta tanto "pt" como "português" para no romper a los clientes que ya
 * mandaban el nombre. Cualquier cosa que no se reconozca cae a español, que es
 * el idioma por defecto del sistema.
 */
function languageName(value) {
  const raw = String(value || "").trim().toLowerCase();
  const byName = Object.entries(LANGUAGE_NAMES).find(
    ([, name]) => name.toLowerCase() === raw,
  );
  if (byName) return LANGUAGE_NAMES[byName[0]];
  return LANGUAGE_NAMES[normalizeLanguage(value)];
}

const MESSAGES = {
  es: {
    // Genéricos
    "org.fallback": "Organización",
    "footer.auto": "Este correo fue enviado automáticamente por el sistema de monitoreo de <strong>License Manager</strong>.",
    "footer.doubts": "Si tienes dudas, contáctanos a",
    "footer.generated_for": "Reporte generado automáticamente para {{org}}",
    "cost.title": "Costo estimado de sobreuso",
    "cost.note": "Estimación según tarifas de Fair Use; la factura final la emite Genesys.",
    "cost.summary": "Costo estimado de sobreuso: {{amount}}",
    "projection.title": "📈 Proyección al cierre del período (día {{elapsed}} de {{total}})",
    "projection.item": "{{value}}% proyectado",
    "kpi.no_commitment": "Sin compromiso contratado (on-demand)",
    "kpi.used_pct": "{{value}}% utilizado",
    "kpi.fairuse_included": " · incluye {{value}} de fair use",
    "kpi.overage": "Sobreuso: {{value}}",
    "kpi.overage_cost": " · costo estimado {{amount}}",
    "kpi.on_demand_detail": "Consumo sin compromiso contratado",

    // Estados
    "status.exceeded": "SOBREUSO",
    "status.warning": "UMBRAL SUPERADO",
    "status.on_demand": "CONSUMO ON-DEMAND",
    "status.ok": "En rango",

    // Categorías
    "category.licencia": "Licencias",
    "category.addon": "Add-ons",
    "category.recurso": "Recursos",
    "category.ai": "AI Experience",
    "category.dispositivo": "Dispositivos",
    "category.almacenamiento": "Almacenamiento",
    "category.tokens": "IA Tokens",
    "category.fairuse": "Fair Use (Voz y Outbound)",

    // Plantilla: reporte actual
    "current.subject": "📈 Reporte Actual - {{org}} | Estado de Licencias",
    "current.title": "📈 Reporte Actual",
    "current.subtitle": "Estado actual de licencias y recursos",
    "current.period": "Período de Facturación",
    "current.period_closed_note": "⚠️ Este período de facturación ya cerró; Genesys aún no publica el nuevo período. Las cifras son las del período mostrado.",
    "current.attention": "Atención en {{count}} métrica(s)",
    "current.all_ok": "✅ Todo el consumo está dentro de lo contratado (umbral de alerta: {{threshold}}%).",
    "current.text_title": "Reporte de Estado Actual - {{org}}",
    "text.period": "Período: {{start}} - {{end}}",

    // Plantilla: reporte del período completado
    "previous.subject": "📊 Reporte Final - Período Completado | {{org}}",
    "previous.title": "📊 Reporte Final",
    "previous.subtitle": "Resumen del período de facturación completado",
    "previous.period": "Período Completado",
    "previous.summary": "Resumen Final de Uso",
    "previous.available_licenses": "✅ Licencias Disponibles",
    "previous.available_item": "{{name}}: {{count}} licencias disponibles",
    "previous.no_commitment_licenses": "Sin licencias con compromiso en el período.",
    "previous.efficiency": "📈 Eficiencia de Uso",
    "previous.avg_utilization": "Promedio de utilización: {{value}}%",
    "previous.exceeded_count": "Métricas con sobreuso: {{count}}",
    "previous.text_title": "Reporte del Período Finalizado - {{org}}",

    // Plantilla: alerta
    "alert.subject": "🚨 Notificación de uso elevado - Genesys Cloud | {{org}}",
    "alert.title": "Notificación",
    "alert.subtitle": "Uso elevado detectado - Supervisión del servicio recomendada",
    "alert.what_happened": "⚠️ ¿Qué ha pasado?",
    "alert.what_happened_desc": "Se detectó consumo por encima de tu umbral configurado (<strong>{{threshold}}%</strong>) en {{count}} métrica(s). Revisa el detalle a continuación.",
    "alert.period": "Período Actual",
    "alert.none_above": "Sin métricas por encima del umbral en este momento.",
    "alert.actions": "🚨 Acciones Recomendadas",
    "alert.action_1": "1. Revisar el consumo en tu tablero de License Manager.",
    "alert.action_2": "2. Optimizar los recursos activos que aparecen arriba.",
    "alert.action_3": "3. Contactar a soporte si necesitas ampliar límites: {{support}}",
    "alert.contact_support": "📞 Contactar Soporte",
    "alert.text_title": "🚨 Notificación de uso elevado - Genesys Cloud - {{org}}",
    "alert.text_threshold": "Umbral configurado: {{threshold}}%",
    "alert.text_metrics": "Métricas por encima del umbral:",
    "alert.text_footer": "Este es un mensaje automático de License Manager.",

    // Plantilla: normalizado
    "recovered.subject": "✅ Consumo normalizado - {{org}}",
    "recovered.title": "✅ Consumo Normalizado",
    "recovered.subtitle": "Ya no hay métricas por encima de tu umbral",
    "recovered.heading": "✅ Consumo normalizado",
    "recovered.desc": "Las métricas que habían superado tu umbral (<strong>{{threshold}}%</strong>) volvieron a estar en rango.",
    "recovered.normalized": "Métricas normalizadas",
    "recovered.text_title": "Consumo normalizado - {{org}}",
    "recovered.text_normalized": "Métricas normalizadas: {{list}}",

    // Plantilla: usuario nuevo
    "newuser.subject": "👋 Tu acceso a {{org}} ha sido activado.",
    "newuser.doc_title": "¡Bienvenido/a!",
    "newuser.title": "👋 ¡Bienvenido/a!",
    "newuser.subtitle": "Tu cuenta ha sido creada exitosamente. Es hora de empezar.",
    "newuser.activated": "✅ Cuenta Activada",
    "newuser.activated_desc": "Tu acceso a la organización {{org}} ya está listo. Usa las siguientes credenciales para iniciar sesión.",
    "newuser.organization": "Organización",
    "newuser.credentials": "🔑 Tus Credenciales",
    "newuser.username": "Nombre de Usuario:",
    "newuser.temp_password": "Contraseña Temporal:",
    "newuser.cta": "▶️ Puedes ir a la plataforma e iniciar Sesión.",
    "newuser.security_note": "⚠️ Por motivos de seguridad, te recomendamos cambiar tu contraseña temporal inmediatamente después de iniciar sesión.",
    "newuser.footer_note": "Este correo es solo para fines informativos. Por favor, no lo respondas.",
    "newuser.text": "🎉 ¡Bienvenido/a a {{org}}! 🎉\n\nTu acceso a los servicios de {{org}} ha sido activado exitosamente.\n\nUsa las siguientes credenciales para iniciar sesión:\n\n================================\n🔑 CREDENCIALES DE ACCESO\n================================\n\nORGANIZACIÓN: {{org}}\nUSUARIO: {{user}}\nCONTRASEÑA TEMPORAL: {{password}}\n\n--------------------------------\n\n⚠️ RECOMENDACIÓN DE SEGURIDAD:\nPor favor, cambia tu contraseña temporal inmediatamente después de iniciar sesión.\n\nSi tienes algún problema, contacta a soporte en: {{support}}\n\nEste es un mensaje automático.",

    // Plantilla: usuario actualizado
    "userupdated.subject": "✅ Tu perfil en {{org}} ha sido actualizado.",
    "userupdated.doc_title": "Actualización de Perfil",
    "userupdated.title": "⚙️ Perfil Actualizado",
    "userupdated.subtitle": "Tus datos de usuario en {{org}} han sido modificados.",
    "userupdated.notice": "🔔 Notificación Importante",
    "userupdated.notice_desc": "La información de tu cuenta en la organización <b>{{org}}</b> ha sido actualizada recientemente. Si no reconoces esta acción, contacta a tu administrador.",
    "userupdated.organization": "Organización",
    "userupdated.details": "👤 Detalles de la Cuenta",
    "userupdated.username": "Nombre de Usuario:",
    "userupdated.password_changed": "* NOTA: Tu contraseña fue modificada.",
    "userupdated.role": "Rol Actual:",
    "userupdated.cta": "Puedes acceder de nuevo a la Plataforma.",
    "userupdated.help": "Si no realizaste esta acción o si tienes preguntas, contacta al soporte de tu organización inmediatamente.",
    "userupdated.footer_note": "Este correo es una notificación de seguridad. Por favor, no lo respondas.",
    "userupdated.text": "✅ Actualización de Perfil en {{org}} ✅\n\nTu información de usuario en {{org}} ha sido actualizada exitosamente.\n\n================================\n👤 DETALLES DE LA CUENTA\n================================\n\nORGANIZACIÓN: {{org}}\nUSUARIO: {{user}}\n{{passwordNote}}\n--------------------------------\n\nSi no realizaste esta acción o si tienes preguntas, contacta a soporte en: {{support}}\n\nEste es un mensaje automático.",
    "userupdated.text_password_note": "⚠️ NOTA: Tu contraseña fue cambiada.\n",
  },

  en: {
    "org.fallback": "Organization",
    "footer.auto": "This email was sent automatically by the <strong>License Manager</strong> monitoring system.",
    "footer.doubts": "If you have any questions, contact us at",
    "footer.generated_for": "Report generated automatically for {{org}}",
    "cost.title": "Estimated overage cost",
    "cost.note": "Estimate based on Fair Use rates; the final invoice is issued by Genesys.",
    "cost.summary": "Estimated overage cost: {{amount}}",
    "projection.title": "📈 End-of-period projection (day {{elapsed}} of {{total}})",
    "projection.item": "{{value}}% projected",
    "kpi.no_commitment": "No contracted commitment (on-demand)",
    "kpi.used_pct": "{{value}}% used",
    "kpi.fairuse_included": " · includes {{value}} of fair use",
    "kpi.overage": "Overage: {{value}}",
    "kpi.overage_cost": " · estimated cost {{amount}}",
    "kpi.on_demand_detail": "Usage without a contracted commitment",

    "status.exceeded": "OVERAGE",
    "status.warning": "THRESHOLD EXCEEDED",
    "status.on_demand": "ON-DEMAND USAGE",
    "status.ok": "Within range",

    "category.licencia": "Licenses",
    "category.addon": "Add-ons",
    "category.recurso": "Resources",
    "category.ai": "AI Experience",
    "category.dispositivo": "Devices",
    "category.almacenamiento": "Storage",
    "category.tokens": "AI Tokens",
    "category.fairuse": "Fair Use (Voice and Outbound)",

    "current.subject": "📈 Current Report - {{org}} | License Status",
    "current.title": "📈 Current Report",
    "current.subtitle": "Current status of licenses and resources",
    "current.period": "Billing Period",
    "current.period_closed_note": "⚠️ This billing period has already closed; Genesys has not published the new period yet. The figures belong to the period shown.",
    "current.attention": "Attention needed on {{count}} metric(s)",
    "current.all_ok": "✅ All usage is within what was contracted (alert threshold: {{threshold}}%).",
    "current.text_title": "Current Status Report - {{org}}",
    "text.period": "Period: {{start}} - {{end}}",

    "previous.subject": "📊 Final Report - Completed Period | {{org}}",
    "previous.title": "📊 Final Report",
    "previous.subtitle": "Summary of the completed billing period",
    "previous.period": "Completed Period",
    "previous.summary": "Final Usage Summary",
    "previous.available_licenses": "✅ Available Licenses",
    "previous.available_item": "{{name}}: {{count}} licenses available",
    "previous.no_commitment_licenses": "No licenses with a commitment during the period.",
    "previous.efficiency": "📈 Usage Efficiency",
    "previous.avg_utilization": "Average utilization: {{value}}%",
    "previous.exceeded_count": "Metrics with overage: {{count}}",
    "previous.text_title": "Completed Period Report - {{org}}",

    "alert.subject": "🚨 High usage notification - Genesys Cloud | {{org}}",
    "alert.title": "Notification",
    "alert.subtitle": "High usage detected - Service supervision recommended",
    "alert.what_happened": "⚠️ What happened?",
    "alert.what_happened_desc": "Usage above your configured threshold (<strong>{{threshold}}%</strong>) was detected on {{count}} metric(s). Review the details below.",
    "alert.period": "Current Period",
    "alert.none_above": "No metrics above the threshold at this time.",
    "alert.actions": "🚨 Recommended Actions",
    "alert.action_1": "1. Review your usage in the License Manager dashboard.",
    "alert.action_2": "2. Optimize the active resources listed above.",
    "alert.action_3": "3. Contact support if you need to raise your limits: {{support}}",
    "alert.contact_support": "📞 Contact Support",
    "alert.text_title": "🚨 High usage notification - Genesys Cloud - {{org}}",
    "alert.text_threshold": "Configured threshold: {{threshold}}%",
    "alert.text_metrics": "Metrics above the threshold:",
    "alert.text_footer": "This is an automated message from License Manager.",

    "recovered.subject": "✅ Usage back to normal - {{org}}",
    "recovered.title": "✅ Usage Back to Normal",
    "recovered.subtitle": "There are no more metrics above your threshold",
    "recovered.heading": "✅ Usage back to normal",
    "recovered.desc": "The metrics that had exceeded your threshold (<strong>{{threshold}}%</strong>) are back within range.",
    "recovered.normalized": "Metrics back to normal",
    "recovered.text_title": "Usage back to normal - {{org}}",
    "recovered.text_normalized": "Metrics back to normal: {{list}}",

    "newuser.subject": "👋 Your access to {{org}} has been activated.",
    "newuser.doc_title": "Welcome!",
    "newuser.title": "👋 Welcome!",
    "newuser.subtitle": "Your account has been created successfully. Time to get started.",
    "newuser.activated": "✅ Account Activated",
    "newuser.activated_desc": "Your access to the {{org}} organization is ready. Use the following credentials to sign in.",
    "newuser.organization": "Organization",
    "newuser.credentials": "🔑 Your Credentials",
    "newuser.username": "Username:",
    "newuser.temp_password": "Temporary Password:",
    "newuser.cta": "▶️ You can now go to the platform and sign in.",
    "newuser.security_note": "⚠️ For security reasons, we recommend changing your temporary password immediately after signing in.",
    "newuser.footer_note": "This email is for informational purposes only. Please do not reply to it.",
    "newuser.text": "🎉 Welcome to {{org}}! 🎉\n\nYour access to the {{org}} services has been activated successfully.\n\nUse the following credentials to sign in:\n\n================================\n🔑 ACCESS CREDENTIALS\n================================\n\nORGANIZATION: {{org}}\nUSERNAME: {{user}}\nTEMPORARY PASSWORD: {{password}}\n\n--------------------------------\n\n⚠️ SECURITY RECOMMENDATION:\nPlease change your temporary password immediately after signing in.\n\nIf you run into any problems, contact support at: {{support}}\n\nThis is an automated message.",

    "userupdated.subject": "✅ Your profile in {{org}} has been updated.",
    "userupdated.doc_title": "Profile Update",
    "userupdated.title": "⚙️ Profile Updated",
    "userupdated.subtitle": "Your user details in {{org}} have been modified.",
    "userupdated.notice": "🔔 Important Notice",
    "userupdated.notice_desc": "Your account information in the <b>{{org}}</b> organization was recently updated. If you do not recognize this action, contact your administrator.",
    "userupdated.organization": "Organization",
    "userupdated.details": "👤 Account Details",
    "userupdated.username": "Username:",
    "userupdated.password_changed": "* NOTE: Your password was changed.",
    "userupdated.role": "Current Role:",
    "userupdated.cta": "You can sign in to the platform again.",
    "userupdated.help": "If you did not perform this action, or if you have questions, contact your organization's support immediately.",
    "userupdated.footer_note": "This email is a security notification. Please do not reply to it.",
    "userupdated.text": "✅ Profile Update in {{org}} ✅\n\nYour user information in {{org}} has been updated successfully.\n\n================================\n👤 ACCOUNT DETAILS\n================================\n\nORGANIZATION: {{org}}\nUSERNAME: {{user}}\n{{passwordNote}}\n--------------------------------\n\nIf you did not perform this action, or if you have questions, contact support at: {{support}}\n\nThis is an automated message.",
    "userupdated.text_password_note": "⚠️ NOTE: Your password was changed.\n",
  },

  pt: {
    "org.fallback": "Organização",
    "footer.auto": "Este e-mail foi enviado automaticamente pelo sistema de monitoramento do <strong>License Manager</strong>.",
    "footer.doubts": "Em caso de dúvidas, fale conosco em",
    "footer.generated_for": "Relatório gerado automaticamente para {{org}}",
    "cost.title": "Custo estimado de excedente",
    "cost.note": "Estimativa conforme as tarifas de Fair Use; a fatura final é emitida pela Genesys.",
    "cost.summary": "Custo estimado de excedente: {{amount}}",
    "projection.title": "📈 Projeção para o fechamento do período (dia {{elapsed}} de {{total}})",
    "projection.item": "{{value}}% projetado",
    "kpi.no_commitment": "Sem compromisso contratado (on-demand)",
    "kpi.used_pct": "{{value}}% utilizado",
    "kpi.fairuse_included": " · inclui {{value}} de fair use",
    "kpi.overage": "Excedente: {{value}}",
    "kpi.overage_cost": " · custo estimado {{amount}}",
    "kpi.on_demand_detail": "Consumo sem compromisso contratado",

    "status.exceeded": "EXCEDENTE",
    "status.warning": "LIMITE ULTRAPASSADO",
    "status.on_demand": "CONSUMO ON-DEMAND",
    "status.ok": "Dentro do previsto",

    "category.licencia": "Licenças",
    "category.addon": "Add-ons",
    "category.recurso": "Recursos",
    "category.ai": "AI Experience",
    "category.dispositivo": "Dispositivos",
    "category.almacenamiento": "Armazenamento",
    "category.tokens": "Tokens de IA",
    "category.fairuse": "Fair Use (Voz e Outbound)",

    "current.subject": "📈 Relatório Atual - {{org}} | Status das Licenças",
    "current.title": "📈 Relatório Atual",
    "current.subtitle": "Status atual de licenças e recursos",
    "current.period": "Período de Faturamento",
    "current.period_closed_note": "⚠️ Este período de faturamento já encerrou; a Genesys ainda não publicou o novo período. Os números são os do período exibido.",
    "current.attention": "Atenção em {{count}} métrica(s)",
    "current.all_ok": "✅ Todo o consumo está dentro do contratado (limite de alerta: {{threshold}}%).",
    "current.text_title": "Relatório de Status Atual - {{org}}",
    "text.period": "Período: {{start}} - {{end}}",

    "previous.subject": "📊 Relatório Final - Período Encerrado | {{org}}",
    "previous.title": "📊 Relatório Final",
    "previous.subtitle": "Resumo do período de faturamento encerrado",
    "previous.period": "Período Encerrado",
    "previous.summary": "Resumo Final de Uso",
    "previous.available_licenses": "✅ Licenças Disponíveis",
    "previous.available_item": "{{name}}: {{count}} licenças disponíveis",
    "previous.no_commitment_licenses": "Sem licenças com compromisso no período.",
    "previous.efficiency": "📈 Eficiência de Uso",
    "previous.avg_utilization": "Média de utilização: {{value}}%",
    "previous.exceeded_count": "Métricas com excedente: {{count}}",
    "previous.text_title": "Relatório do Período Encerrado - {{org}}",

    "alert.subject": "🚨 Notificação de uso elevado - Genesys Cloud | {{org}}",
    "alert.title": "Notificação",
    "alert.subtitle": "Uso elevado detectado - Supervisão do serviço recomendada",
    "alert.what_happened": "⚠️ O que aconteceu?",
    "alert.what_happened_desc": "Foi detectado consumo acima do limite configurado (<strong>{{threshold}}%</strong>) em {{count}} métrica(s). Confira os detalhes abaixo.",
    "alert.period": "Período Atual",
    "alert.none_above": "Nenhuma métrica acima do limite neste momento.",
    "alert.actions": "🚨 Ações Recomendadas",
    "alert.action_1": "1. Revisar o consumo no seu painel do License Manager.",
    "alert.action_2": "2. Otimizar os recursos ativos listados acima.",
    "alert.action_3": "3. Falar com o suporte se precisar ampliar os limites: {{support}}",
    "alert.contact_support": "📞 Falar com o Suporte",
    "alert.text_title": "🚨 Notificação de uso elevado - Genesys Cloud - {{org}}",
    "alert.text_threshold": "Limite configurado: {{threshold}}%",
    "alert.text_metrics": "Métricas acima do limite:",
    "alert.text_footer": "Esta é uma mensagem automática do License Manager.",

    "recovered.subject": "✅ Consumo normalizado - {{org}}",
    "recovered.title": "✅ Consumo Normalizado",
    "recovered.subtitle": "Não há mais métricas acima do seu limite",
    "recovered.heading": "✅ Consumo normalizado",
    "recovered.desc": "As métricas que haviam ultrapassado o seu limite (<strong>{{threshold}}%</strong>) voltaram ao previsto.",
    "recovered.normalized": "Métricas normalizadas",
    "recovered.text_title": "Consumo normalizado - {{org}}",
    "recovered.text_normalized": "Métricas normalizadas: {{list}}",

    "newuser.subject": "👋 Seu acesso a {{org}} foi ativado.",
    "newuser.doc_title": "Boas-vindas!",
    "newuser.title": "👋 Boas-vindas!",
    "newuser.subtitle": "Sua conta foi criada com sucesso. Hora de começar.",
    "newuser.activated": "✅ Conta Ativada",
    "newuser.activated_desc": "Seu acesso à organização {{org}} já está pronto. Use as credenciais a seguir para entrar.",
    "newuser.organization": "Organização",
    "newuser.credentials": "🔑 Suas Credenciais",
    "newuser.username": "Nome de Usuário:",
    "newuser.temp_password": "Senha Temporária:",
    "newuser.cta": "▶️ Você já pode acessar a plataforma e entrar.",
    "newuser.security_note": "⚠️ Por motivos de segurança, recomendamos alterar sua senha temporária logo após o primeiro acesso.",
    "newuser.footer_note": "Este e-mail é apenas informativo. Por favor, não responda.",
    "newuser.text": "🎉 Boas-vindas a {{org}}! 🎉\n\nSeu acesso aos serviços de {{org}} foi ativado com sucesso.\n\nUse as credenciais a seguir para entrar:\n\n================================\n🔑 CREDENCIAIS DE ACESSO\n================================\n\nORGANIZAÇÃO: {{org}}\nUSUÁRIO: {{user}}\nSENHA TEMPORÁRIA: {{password}}\n\n--------------------------------\n\n⚠️ RECOMENDAÇÃO DE SEGURANÇA:\nAltere sua senha temporária imediatamente após entrar.\n\nSe tiver algum problema, fale com o suporte em: {{support}}\n\nEsta é uma mensagem automática.",

    "userupdated.subject": "✅ Seu perfil em {{org}} foi atualizado.",
    "userupdated.doc_title": "Atualização de Perfil",
    "userupdated.title": "⚙️ Perfil Atualizado",
    "userupdated.subtitle": "Seus dados de usuário em {{org}} foram modificados.",
    "userupdated.notice": "🔔 Aviso Importante",
    "userupdated.notice_desc": "As informações da sua conta na organização <b>{{org}}</b> foram atualizadas recentemente. Se você não reconhece esta ação, fale com o seu administrador.",
    "userupdated.organization": "Organização",
    "userupdated.details": "👤 Detalhes da Conta",
    "userupdated.username": "Nome de Usuário:",
    "userupdated.password_changed": "* OBSERVAÇÃO: Sua senha foi modificada.",
    "userupdated.role": "Função Atual:",
    "userupdated.cta": "Você já pode acessar a plataforma novamente.",
    "userupdated.help": "Se você não realizou esta ação, ou se tiver dúvidas, fale imediatamente com o suporte da sua organização.",
    "userupdated.footer_note": "Este e-mail é uma notificação de segurança. Por favor, não responda.",
    "userupdated.text": "✅ Atualização de Perfil em {{org}} ✅\n\nSuas informações de usuário em {{org}} foram atualizadas com sucesso.\n\n================================\n👤 DETALHES DA CONTA\n================================\n\nORGANIZAÇÃO: {{org}}\nUSUÁRIO: {{user}}\n{{passwordNote}}\n--------------------------------\n\nSe você não realizou esta ação, ou se tiver dúvidas, fale com o suporte em: {{support}}\n\nEsta é uma mensagem automática.",
    "userupdated.text_password_note": "⚠️ OBSERVAÇÃO: Sua senha foi alterada.\n",
  },
};

/**
 * Devuelve un traductor para el idioma indicado.
 *
 * Si falta una clave en el idioma pedido cae a español y, en último término,
 * a la propia clave: una traducción olvidada nunca deja el correo en blanco.
 */
function translator(language) {
  const lang = normalizeLanguage(language);
  const dictionary = MESSAGES[lang];
  const fallback = MESSAGES[DEFAULT_LANGUAGE];

  const t = (key, params) => {
    let text = dictionary[key] ?? fallback[key] ?? key;
    if (params) {
      Object.entries(params).forEach(([name, value]) => {
        text = text.split(`{{${name}}}`).join(String(value));
      });
    }
    return text;
  };

  t.language = lang;
  t.locale = LOCALES[lang];
  t.numberLocale = NUMBER_LOCALES[lang];
  return t;
}

module.exports = {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  LANGUAGE_NAMES,
  normalizeLanguage,
  languageName,
  translator,
};
