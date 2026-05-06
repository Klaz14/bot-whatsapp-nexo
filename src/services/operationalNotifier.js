const {
  isWithinBusinessHours,
  loadBusinessCalendar,
} = require('../utils/businessCalendar');
const { maskSensitiveText } = require('../utils/mask');

const OPERATIONAL_MESSAGES = {
  readyBusinessHours: '✅ Bot preparado para trabajar. Horario operativo activo. Los comprobantes se procesarán en Entrantes.',
  readyOffHours: '🌙 Bot activo fuera de horario. Desde ahora los comprobantes quedan en lista de pendientes y se procesarán al comienzo del siguiente día hábil.',
  offHoursStarted: '🌙 Fin del horario operativo. Desde ahora los comprobantes quedan en lista de pendientes y se procesarán al comienzo del siguiente día hábil.',
  manualShutdown: '⚠️ Bot detenido manualmente. Si se reciben comprobantes mientras está apagado, no podrán ser capturados hasta que vuelva a iniciar.',
};

function getNotifierConfig(config = {}) {
  return config.operationalNotifications || {};
}

function normalizeAlertGroupNames(value) {
  const source = Array.isArray(value) ? value : [value];
  const seen = new Set();
  const result = [];

  for (const item of source) {
    const name = String(item || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }

  return result;
}

function buildOperationalMessage(type) {
  return OPERATIONAL_MESSAGES[type] || '';
}

function formatDetailValue(value) {
  if (value === undefined || value === null || value === '') return '';
  if (value instanceof Error) return maskSensitiveText(value.message, 160);
  if (typeof value === 'object') return maskSensitiveText(JSON.stringify(value), 160);
  return maskSensitiveText(value, 160);
}

function formatAlertMessage(severity, eventType, message, details = {}) {
  const safeSeverity = String(severity || 'WARNING').toUpperCase();
  const safeEventType = String(eventType || 'operational_event')
    .replace(/[^A-Za-z0-9_.:-]+/g, '_')
    .slice(0, 80);
  const safeMessage = maskSensitiveText(message || 'Evento operativo requiere revision', 180);
  const icon = safeSeverity === 'ERROR' || safeSeverity === 'CRITICAL' ? '🚨' : '⚠️';
  const lines = [
    `${icon} BOT TRANSFERENCIAS - ${safeSeverity}`,
    `Evento: ${safeEventType}`,
    `Detalle: ${safeMessage}`,
  ];

  for (const [key, value] of Object.entries(details || {})) {
    const safeKey = String(key || '')
      .replace(/[^A-Za-z0-9_.:-]+/g, '_')
      .slice(0, 40);
    const safeValue = formatDetailValue(value);
    if (safeKey && safeValue) {
      lines.push(`${safeKey}: ${safeValue}`);
    }
  }

  return lines.join('\n');
}

function isOperationalMessageSafe(message) {
  const text = String(message || '');
  if (!text) return false;
  if (/https?:\/\//i.test(text)) return false;
  if (/\b\d{8,}\b/.test(text)) return false;
  if (/@(?:c\.us|lid|g\.us)\b/i.test(text)) return false;
  return true;
}

function normalizeIntervalMilliseconds(seconds) {
  const parsed = Number(seconds);
  const safeSeconds = Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
  return safeSeconds * 1000;
}

async function withTimeout(task, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(task).catch((err) => ({ ok: false, reason: 'error', error: err })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), milliseconds);
        if (timer.unref) timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createOperationalNotifier({
  config,
  client,
  nowProvider = () => new Date(),
  processLike = process,
  exitProcess = (code) => process.exit(code),
  shutdownTimeoutMilliseconds = 3000,
} = {}) {
  const notifierConfig = getNotifierConfig(config);
  let timer;
  let cachedChats;
  let lastBusinessHoursState;
  let lastStateMessageKey = '';
  const dedupedAlertKeys = new Set();
  let shutdownHooksInstalled = false;
  let shutdownInProgress = false;

  function loadCalendar() {
    return loadBusinessCalendar(config.paths && config.paths.businessCalendar, {
      onWarning: (warning) => {
        notifyWarning('business_calendar_defaults', 'Calendario laboral no disponible o invalido; usando defaults.', {
          reason: warning && warning.reason,
        }, {
          dedupeKey: 'business-calendar-defaults',
        }).catch((err) => {
          console.warn(`[OPERATIONAL ALERT] error alertando calendario: ${maskSensitiveText(err && err.message)}`);
        });
      },
    });
  }

  function isEnabled() {
    return notifierConfig.enabled !== false;
  }

  function getAlertGroupNames() {
    const names = normalizeAlertGroupNames(notifierConfig.alertGroupNames);
    if (names.length) return names;
    return normalizeAlertGroupNames(notifierConfig.alertGroupName);
  }

  function shouldNotify(type) {
    if (!isEnabled()) return false;
    if ((type === 'readyBusinessHours' || type === 'readyOffHours') && notifierConfig.notifyOnReady === false) {
      return false;
    }
    if (type === 'offHoursStarted' && notifierConfig.notifyOnOffHours === false) {
      return false;
    }
    if (type === 'manualShutdown' && notifierConfig.notifyOnShutdown !== true) {
      return false;
    }
    return true;
  }

  async function getAlertChatsByName() {
    if (!cachedChats) {
      if (!client || typeof client.getChats !== 'function') return new Map();
      cachedChats = await client.getChats();
    }

    const chatsByName = new Map();
    for (const chat of cachedChats || []) {
      if (chat && chat.isGroup && chat.name && !chatsByName.has(chat.name)) {
        chatsByName.set(chat.name, chat);
      }
    }
    return chatsByName;
  }

  async function sendToAlertGroups(message) {
    const groupNames = getAlertGroupNames();
    if (!groupNames.length) {
      console.log('[OPERATIONAL NOTIFY] sin grupos de alerta configurados; aviso solo en consola');
      return { ok: false, reason: 'missing-alert-groups', sent: 0, total: 0 };
    }

    const chatsByName = await getAlertChatsByName();
    let sent = 0;
    const failed = [];

    for (const groupName of groupNames) {
      const chat = chatsByName.get(groupName);
      if (!chat || typeof chat.sendMessage !== 'function') {
        console.warn(`[OPERATIONAL NOTIFY] grupo de alertas no encontrado: ${maskSensitiveText(groupName, 80)}`);
        failed.push({ groupName, reason: 'not-found' });
        continue;
      }

      try {
        await chat.sendMessage(message);
        sent += 1;
      } catch (err) {
        console.warn(
          `[OPERATIONAL NOTIFY] fallo envio a ${maskSensitiveText(groupName, 80)}: ` +
          `${maskSensitiveText(err && err.message)}`
        );
        failed.push({ groupName, reason: 'send-failed', error: err });
      }
    }

    console.log(`[OPERATIONAL NOTIFY] sent to ${sent}/${groupNames.length} alert group(s)`);
    return {
      ok: sent > 0,
      reason: sent > 0 ? undefined : 'no-alert-delivered',
      sent,
      total: groupNames.length,
      failed,
    };
  }

  async function sendPreparedMessage(message, options = {}) {
    if (!isEnabled()) {
      return { ok: false, reason: 'disabled' };
    }
    if (!isOperationalMessageSafe(message)) {
      console.warn('[OPERATIONAL NOTIFY] mensaje operativo rechazado por seguridad');
      return { ok: false, reason: 'unsafe-message' };
    }

    const stateKey = options.stateKey || '';
    if (stateKey && lastStateMessageKey === stateKey) {
      return { ok: false, reason: 'duplicate-state' };
    }

    console.log(`[OPERATIONAL NOTIFY] ${message}`);
    try {
      const result = await sendToAlertGroups(message);
      if (stateKey) lastStateMessageKey = stateKey;
      return result;
    } catch (err) {
      if (stateKey) lastStateMessageKey = stateKey;
      console.warn(`[OPERATIONAL NOTIFY] no se pudo enviar: ${maskSensitiveText(err && err.message)}`);
      return { ok: false, reason: 'send-failed', error: err };
    }
  }

  async function notify(type, options = {}) {
    if (!shouldNotify(type)) {
      return { ok: false, reason: 'disabled' };
    }

    return sendPreparedMessage(buildOperationalMessage(type), options);
  }

  async function notifyAlert(severity, eventType, message, details = {}, options = {}) {
    if (options.dedupeKey) {
      if (dedupedAlertKeys.has(options.dedupeKey)) {
        return { ok: false, reason: 'duplicate-alert' };
      }
      dedupedAlertKeys.add(options.dedupeKey);
    }

    return sendPreparedMessage(
      formatAlertMessage(severity, eventType, message, details),
      options.stateKey ? { stateKey: options.stateKey } : {}
    );
  }

  function notifyWarning(eventType, message, details, options) {
    return notifyAlert('WARNING', eventType, message, details, options);
  }

  function notifyError(eventType, message, details, options) {
    return notifyAlert('ERROR', eventType, message, details, options);
  }

  function notifyCritical(eventType, message, details, options) {
    return notifyAlert('CRITICAL', eventType, message, details, options);
  }

  async function notifyReady(now = nowProvider()) {
    const calendar = loadCalendar();
    const insideBusinessHours = isWithinBusinessHours(now, calendar);
    lastBusinessHoursState = insideBusinessHours;
    const type = insideBusinessHours ? 'readyBusinessHours' : 'readyOffHours';
    const stateKey = insideBusinessHours ? 'ready:business-hours' : 'ready:off-hours';
    return notify(type, { stateKey });
  }

  async function checkOperationalTransition(now = nowProvider()) {
    if (!isEnabled() || notifierConfig.notifyOnOffHours === false) {
      return { ok: false, reason: 'disabled' };
    }

    const calendar = loadCalendar();
    const insideBusinessHours = isWithinBusinessHours(now, calendar);

    if (lastBusinessHoursState === undefined) {
      lastBusinessHoursState = insideBusinessHours;
      return { ok: false, reason: 'initial-state' };
    }

    const wasInside = lastBusinessHoursState;
    lastBusinessHoursState = insideBusinessHours;

    if (wasInside && !insideBusinessHours) {
      return notify('offHoursStarted', { stateKey: 'transition:off-hours' });
    }

    if (insideBusinessHours) {
      lastStateMessageKey = '';
    }

    return { ok: false, reason: 'no-transition' };
  }

  function startOperationalStatusWatcher() {
    if (timer || !isEnabled() || notifierConfig.notifyOnOffHours === false) return;

    timer = setInterval(() => {
      checkOperationalTransition().catch((err) => {
        console.warn(`[OPERATIONAL NOTIFY] error revisando horario: ${maskSensitiveText(err && err.message)}`);
      });
    }, normalizeIntervalMilliseconds(notifierConfig.statusCheckIntervalSeconds));
    if (timer.unref) timer.unref();
  }

  function stopOperationalStatusWatcher() {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
  }

  async function notifyShutdown() {
    return notify('manualShutdown', { stateKey: 'manual-shutdown' });
  }

  function installShutdownHooks() {
    if (shutdownHooksInstalled || notifierConfig.notifyOnShutdown !== true) return;
    shutdownHooksInstalled = true;

    const handleShutdown = (signal) => {
      if (shutdownInProgress) return;
      shutdownInProgress = true;
      stopOperationalStatusWatcher();
      withTimeout(notifyShutdown(), shutdownTimeoutMilliseconds).finally(() => {
        exitProcess(0);
      });
    };

    processLike.once('SIGINT', handleShutdown);
    processLike.once('SIGTERM', handleShutdown);
  }

  return {
    buildOperationalMessage,
    checkOperationalTransition,
    getAlertGroupNames,
    installShutdownHooks,
    isOperationalMessageSafe,
    notify,
    notifyAlert,
    notifyCritical,
    notifyError,
    notifyReady,
    notifyShutdown,
    notifyWarning,
    startOperationalStatusWatcher,
    stopOperationalStatusWatcher,
  };
}

module.exports = {
  OPERATIONAL_MESSAGES,
  buildOperationalMessage,
  createOperationalNotifier,
  formatAlertMessage,
  isOperationalMessageSafe,
  normalizeAlertGroupNames,
};
