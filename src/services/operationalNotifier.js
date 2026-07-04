const {
  isWithinBusinessHours,
  loadBusinessCalendar,
} = require('../utils/businessCalendar');
const { maskSensitiveText } = require('../utils/mask');

const OPERATIONAL_MESSAGES = {
  readyBusinessHours: '✅ Bot preparado para trabajar. Horario operativo activo. Los comprobantes se procesarán en Entrantes.',
  readyOffHours: '🌙 Bot activo fuera de horario. Desde ahora los comprobantes quedan en lista de pendientes y se procesarán al comienzo del siguiente día hábil.',
  offHoursStarted: '🌙 Fin del horario operativo. Desde ahora los comprobantes quedan en lista de pendientes y se procesarán al comienzo del siguiente día hábil.',
  onHoursStarted: '🌞 Inicio del horario operativo. El bot va a procesar los comprobantes acumulados (si hay) y volver a recibir comprobantes en tiempo real.',
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

// I2: etiquetas legibles en español para los campos de detalle. Las alertas pasan a
// leerse "Grupo/Cartera/Comprobante/Acción" en vez de las keys crudas del código.
const DETAIL_LABELS = {
  group: 'Grupo',
  tag: 'Cartera',
  filename: 'Comprobante',
  accion: 'Acción',
  action: 'Acción',
  reason: 'Motivo',
  error: 'Error',
  senderId: 'Remitente',
  paths: 'Rutas',
  timeoutSeconds: 'Timeout (s)',
  failures: 'Fallos',
};
// Orden en que se muestran los campos clave (lo demás va después, en el orden recibido).
const DETAIL_ORDER = ['group', 'tag', 'filename', 'accion', 'action', 'reason', 'error'];

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

  const entries = Object.entries(details || {});
  entries.sort((a, b) => {
    const ia = DETAIL_ORDER.indexOf(a[0]);
    const ib = DETAIL_ORDER.indexOf(b[0]);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  for (const [key, value] of entries) {
    const safeValue = formatDetailValue(value);
    if (!safeValue) continue;
    const label = DETAIL_LABELS[key]
      || String(key || '').replace(/[^A-Za-z0-9_.:-]+/g, '_').slice(0, 40);
    if (label) lines.push(`${label}: ${safeValue}`);
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
  let lastBusinessHoursState;
  let lastStateMessageKey = '';
  const dedupedAlertKeys = new Map(); // dedupeKey -> timestamp ms (con TTL, no de por vida)
  let shutdownHooksInstalled = false;
  let shutdownInProgress = false;
  let dailyNotifyInProgress = false;

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

  function getStatusGroupNames() {
    return normalizeAlertGroupNames(notifierConfig.statusGroupNames);
  }

  function getDailyGroupNames() {
    return normalizeAlertGroupNames(notifierConfig.dailyGroupNames);
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
    if (!client || typeof client.getChats !== 'function') return new Map();
    const chats = await client.getChats();

    const chatsByName = new Map();
    for (const chat of chats || []) {
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

  async function sendToStatusGroups(message) {
    const groupNames = getStatusGroupNames();
    if (!groupNames.length) {
      console.log('[OPERATIONAL NOTIFY] sin grupos de estado configurados; aviso solo en consola');
      return { ok: false, reason: 'missing-status-groups', sent: 0, total: 0 };
    }

    const chatsByName = await getAlertChatsByName();
    let sent = 0;
    const failed = [];

    for (const groupName of groupNames) {
      const chat = chatsByName.get(groupName);
      if (!chat || typeof chat.sendMessage !== 'function') {
        console.warn(`[OPERATIONAL NOTIFY] grupo de estado no encontrado: ${maskSensitiveText(groupName, 80)}`);
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

    console.log(`[OPERATIONAL NOTIFY] sent to ${sent}/${groupNames.length} status group(s)`);
    return {
      ok: sent > 0,
      reason: sent > 0 ? undefined : 'no-status-delivered',
      sent,
      total: groupNames.length,
      failed,
    };
  }

  async function sendToDailyGroups(message) {
    if (dailyNotifyInProgress) {
      console.log('[OPERATIONAL NOTIFY] daily notify en curso; se omite envio solapado');
      return { ok: false, reason: 'in-progress', sent: 0, total: 0 };
    }

    const groupNames = getDailyGroupNames();
    if (!groupNames.length) {
      console.log('[OPERATIONAL NOTIFY] sin grupos daily configurados; aviso solo en consola');
      return { ok: false, reason: 'missing-daily-groups', sent: 0, total: 0 };
    }

    dailyNotifyInProgress = true;
    const delayMs = notifierConfig.dailyNotifyDelayMs || 0;

    try {
      const chatsByName = await getAlertChatsByName();
      let sent = 0;
      const failed = [];

      for (let i = 0; i < groupNames.length; i++) {
        const groupName = groupNames[i];
        const chat = chatsByName.get(groupName);
        if (!chat || typeof chat.sendMessage !== 'function') {
          console.warn(`[OPERATIONAL NOTIFY] grupo daily no encontrado: ${maskSensitiveText(groupName, 80)}`);
          failed.push({ groupName, reason: 'not-found' });
          continue;
        }

        try {
          await chat.sendMessage(message);
          sent += 1;
        } catch (err) {
          console.warn(
            `[OPERATIONAL NOTIFY] fallo envio daily a ${maskSensitiveText(groupName, 80)}: ` +
            `${maskSensitiveText(err && err.message)}`
          );
          failed.push({ groupName, reason: 'send-failed', error: err });
        }

        if (delayMs > 0 && i < groupNames.length - 1) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }

      console.log(`[OPERATIONAL NOTIFY] sent to ${sent}/${groupNames.length} daily group(s)`);
      return {
        ok: sent > 0,
        reason: sent > 0 ? undefined : 'no-daily-delivered',
        sent,
        total: groupNames.length,
        failed,
      };
    } finally {
      dailyNotifyInProgress = false;
    }
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

    const channel = options.channel === 'daily' ? 'daily'
      : options.channel === 'status' ? 'status'
      : 'alert';
    console.log(`[OPERATIONAL NOTIFY] ${message}`);
    try {
      const result = channel === 'daily'
        ? await sendToDailyGroups(message)
        : channel === 'status'
          ? await sendToStatusGroups(message)
          : await sendToAlertGroups(message);
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

    return sendPreparedMessage(buildOperationalMessage(type), { ...options, channel: 'status' });
  }

  // Canal out-of-band (Telegram via fetch, sin dep) para alertas de severidad alta: la
  // alerta llega aunque el WhatsApp del bot este caido (justo cuando mas hay que avisar).
  async function sendOutOfBand(text) {
    const ob = notifierConfig.outOfBand || {};
    if (!ob.telegramToken || !ob.telegramChatId) return;
    if (typeof fetch !== 'function') return;
    try {
      await fetch(`https://api.telegram.org/bot${ob.telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: ob.telegramChatId, text }),
      });
    } catch (err) {
      console.warn(`[OOB] alerta out-of-band fallo: ${maskSensitiveText(err && err.message)}`);
    }
  }

  async function notifyAlert(severity, eventType, message, details = {}, options = {}) {
    if (options.dedupeKey) {
      // Dedup con TTL: una condicion recurrente se re-alerta despues de alertDedupeTtlMs,
      // en vez de silenciarse de por vida.
      const ttlMs = notifierConfig.alertDedupeTtlMs || (30 * 60 * 1000);
      const nowMs = nowProvider().getTime();
      const lastMs = dedupedAlertKeys.get(options.dedupeKey);
      if (lastMs !== undefined && (nowMs - lastMs) < ttlMs) {
        return { ok: false, reason: 'duplicate-alert' };
      }
      dedupedAlertKeys.set(options.dedupeKey, nowMs);
    }

    const formatted = formatAlertMessage(severity, eventType, message, details);
    const sev = String(severity || '').toUpperCase();
    if (sev === 'ERROR' || sev === 'CRITICAL') {
      sendOutOfBand(formatted).catch(() => {});
    }

    return sendPreparedMessage(
      formatted,
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

  // I2/R6: aviso post-caida. Al revivir, informa a los grupos de estado cuanto estuvo caido
  // (calculado por index.js con el heartbeat persistido). El bot caido no puede avisar por
  // WhatsApp; este aviso llega recien cuando vuelve.
  async function notifyRecovery(minutesDown, sinceLocal) {
    if (!isEnabled()) return { ok: false, reason: 'disabled' };
    const msg = `♻️ Bot reiniciado tras una caida. Estuvo sin actividad ~${minutesDown} min (desde ${sinceLocal}). Recuperando comprobantes del periodo.`;
    return sendPreparedMessage(msg, { channel: 'status' });
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
      return sendPreparedMessage(buildOperationalMessage('offHoursStarted'), { stateKey: 'transition:off-hours', channel: 'daily' });
    }

    if (!wasInside && insideBusinessHours) {
      lastStateMessageKey = '';
      return sendPreparedMessage(buildOperationalMessage('onHoursStarted'), { stateKey: 'transition:on-hours', channel: 'daily' });
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
    getDailyGroupNames,
    getStatusGroupNames,
    installShutdownHooks,
    isOperationalMessageSafe,
    notify,
    notifyAlert,
    notifyCritical,
    notifyError,
    notifyReady,
    notifyRecovery,
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
