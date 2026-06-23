const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT, resolveProjectPath } = require('./paths');
const { DEFAULT_TIME_ZONE, normalizeTimeZone } = require('../utils/time');

const DEFAULT_GOOGLE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const equalsIndex = trimmed.indexOf('=');
  if (equalsIndex === -1) return null;

  const key = trimmed.slice(0, equalsIndex).trim();
  let value = trimmed.slice(equalsIndex + 1).trim();

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return key ? [key, value] : null;
}

function loadDotEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;

    const [key, value] = parsed;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseJsonObject(value, variableName) {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('debe ser un objeto JSON');
    }
    return parsed;
  } catch (err) {
    throw new Error(`${variableName} no es JSON valido: ${err.message}`);
  }
}

function getBoolean(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function getOptionalBoolean(name) {
  const value = process.env[name];
  if (value === undefined || value === '') return undefined;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parseList(value, variableName) {
  if (!value) return [];

  const trimmed = value.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) {
        throw new Error('debe ser un array JSON');
      }
      return parsed.map((item) => String(item).trim()).filter(Boolean);
    } catch (err) {
      throw new Error(`${variableName} no es una lista valida: ${err.message}`);
    }
  }

  return trimmed.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseOptionalJsonList(value, variableName) {
  if (!value || !value.trim()) return null;

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      throw new Error('debe ser un array JSON');
    }
    return parsed.map((item) => String(item).trim()).filter(Boolean);
  } catch (err) {
    console.warn(`${variableName} invalido; se usara WHATSAPP_ALERT_GROUP_NAME como fallback.`);
    return null;
  }
}

function normalizeUniqueList(values) {
  const seen = new Set();
  const result = [];

  for (const value of values || []) {
    const item = String(value || '').trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }

  return result;
}

function getNumber(name, defaultValue) {
  const value = process.env[name];
  if (value === undefined || value === '') return defaultValue;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} debe ser numerico`);
  }
  return parsed;
}

function getPositiveNumber(name, defaultValue) {
  const value = process.env[name];
  if (value === undefined || value === '') return defaultValue;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return parsed;
}

function getWhatsappWebCacheType() {
  const value = (process.env.WHATSAPP_WEB_VERSION_CACHE_TYPE || 'none').toLowerCase();
  return ['none', 'local', 'remote'].includes(value) ? value : 'none';
}

function loadConfig() {
  loadDotEnvFile(resolveProjectPath(process.env.ENV_FILE, '.env'));

  const groupConfigPath = resolveProjectPath(
    process.env.WHATSAPP_GROUPS_CONFIG_PATH || process.env.CONFIG_PATH,
    'config.json'
  );
  const fileConfig = readJsonIfExists(groupConfigPath);
  const envGroups = parseJsonObject(
    process.env.WHATSAPP_ALLOWED_GROUPS_JSON,
    'WHATSAPP_ALLOWED_GROUPS_JSON'
  );

  const oauthRedirectHost = process.env.GOOGLE_OAUTH_REDIRECT_HOST || '127.0.0.1';
  const oauthRedirectPort = getNumber('GOOGLE_OAUTH_REDIRECT_PORT', 53682);
  const parsedAlertGroupNames = parseOptionalJsonList(
    process.env.WHATSAPP_ALERT_GROUPS_JSON,
    'WHATSAPP_ALERT_GROUPS_JSON'
  );
  const alertGroupNames = normalizeUniqueList(
    parsedAlertGroupNames && parsedAlertGroupNames.length
      ? parsedAlertGroupNames
      : [process.env.WHATSAPP_ALERT_GROUP_NAME]
  );

  const parsedStatusGroupNames = parseOptionalJsonList(
    process.env.WHATSAPP_STATUS_GROUPS_JSON,
    'WHATSAPP_STATUS_GROUPS_JSON'
  );
  const statusGroupNames = normalizeUniqueList(
    parsedStatusGroupNames && parsedStatusGroupNames.length
      ? parsedStatusGroupNames
      : alertGroupNames
  );

  const parsedDailyGroupNames = parseOptionalJsonList(
    process.env.WHATSAPP_DAILY_GROUPS_JSON,
    'WHATSAPP_DAILY_GROUPS_JSON'
  );
  const dailyGroupNames = normalizeUniqueList(
    parsedDailyGroupNames && parsedDailyGroupNames.length
      ? parsedDailyGroupNames
      : statusGroupNames
  );

  const rawDailyDelayMs = process.env.OPERATIONAL_DAILY_NOTIFY_DELAY_MS;
  const parsedDailyDelayMs = rawDailyDelayMs !== undefined && rawDailyDelayMs !== ''
    ? Number(rawDailyDelayMs)
    : 1500;
  const dailyNotifyDelayMs = Number.isFinite(parsedDailyDelayMs) && parsedDailyDelayMs >= 0
    ? parsedDailyDelayMs
    : 1500;

  const blacklistExemptGroups = normalizeUniqueList(
    parseOptionalJsonList(
      process.env.BLACKLIST_EXEMPT_GROUPS_JSON,
      'BLACKLIST_EXEMPT_GROUPS_JSON'
    ) || []
  );

  const rawPdfBatchSize = process.env.PDF_BATCH_SIZE;
  const parsedPdfBatchSize = rawPdfBatchSize !== undefined && rawPdfBatchSize !== ''
    ? Number(rawPdfBatchSize)
    : 30;
  const pdfBatchSize = Number.isInteger(parsedPdfBatchSize) && parsedPdfBatchSize >= 1
    ? parsedPdfBatchSize
    : 30;

  return {
    projectRoot: PROJECT_ROOT,
    env: process.env.BOT_ENV || process.env.NODE_ENV || 'local',
    timeZone: normalizeTimeZone(process.env.BOT_TIME_ZONE || DEFAULT_TIME_ZONE),
    dryRun: getBoolean('BOT_DRY_RUN', false),
    processingEnabled: getBoolean('BOT_PROCESSING_ENABLED', true),
    // Acuse: reacciona al mensaje del comprobante (👍 subido / 🕒 encolado off-hours).
    reactOnProcessed: getBoolean('REACT_ON_PROCESSED', true),
    blacklistExemptGroups,
    logLevel: process.env.BOT_LOG_LEVEL || 'info',
    logging: {
      format: process.env.LOG_FORMAT || 'text',
      maskPhoneNumbers: getBoolean('LOG_MASK_PHONE_NUMBERS', true),
      storeDriveLinks: getBoolean('LOG_STORE_DRIVE_LINKS', false),
      maxFieldLength: getNumber('LOG_MAX_FIELD_LENGTH', 120),
    },
    safety: {
      allowRealWhatsappConnection: getBoolean('ALLOW_REAL_WHATSAPP_CONNECTION', true),
      allowRealDriveUploads: getBoolean('ALLOW_REAL_DRIVE_UPLOADS', true),
    },
    paths: {
      groupConfig: groupConfigPath,
      credentials: resolveProjectPath(process.env.GOOGLE_CREDENTIALS_PATH, 'credentials.json'),
      token: resolveProjectPath(process.env.GOOGLE_TOKEN_PATH, 'token.json'),
      whatsappAuthData: resolveProjectPath(process.env.WHATSAPP_AUTH_DATA_PATH, '.wwebjs_auth'),
      whatsappWebCache: resolveProjectPath(process.env.WHATSAPP_WEB_CACHE_PATH, '.wwebjs_cache'),
      uploadsLog: resolveProjectPath(process.env.LOG_UPLOADS_PATH, 'uploads.log'),
      errorsLog: resolveProjectPath(process.env.LOG_ERRORS_PATH, 'errors.log'),
      alertsLog: resolveProjectPath(process.env.ALERTS_LOG_PATH, 'alerts.log'),
      processedStore: resolveProjectPath(process.env.PROCESSED_STORE_PATH, 'processed-messages.json'),
      businessCalendar: resolveProjectPath(process.env.BUSINESS_CALENDAR_PATH, 'business-calendar.json'),
      blockedSenders: resolveProjectPath(process.env.BLOCKED_SENDERS_PATH, 'blocked-senders.json'),
      statsStore: resolveProjectPath(process.env.STATS_STORE_PATH, 'daily-stats.json'),
    },
    processedStore: {
      ttlHours: getPositiveNumber('PROCESSED_STORE_TTL_HOURS', 720),
      maxItems: getPositiveNumber('PROCESSED_STORE_MAX_ITEMS', 5000),
      timeZone: normalizeTimeZone(process.env.BOT_TIME_ZONE || DEFAULT_TIME_ZONE),
    },
    pendingProcessor: {
      intervalMinutes: getPositiveNumber('PENDING_PROCESSOR_INTERVAL_MINUTES', 5),
      maxAttempts: getPositiveNumber('PENDING_PROCESSOR_MAX_ATTEMPTS', 3),
    },
    pdf: {
      batchSize: pdfBatchSize,
    },
    concurrency: {
      // F0.3: backpressure del handler en vivo. Limita cuantos mensajes se procesan
      // en paralelo para evitar picos de RAM/CPU bajo rafaga (apertura/cierre).
      handler: getPositiveNumber('HANDLER_CONCURRENCY', 3),
    },
    autoRecovery: {
      // F0.4: anti-zombie. Si se cae la sesion, salir (exit 1) para que Railway
      // reinicie y reconecte con la sesion persistida (REQUIERE rutas en /data).
      enabled: getBoolean('AUTO_RECOVERY_ENABLED', true),
      watchdogIntervalSeconds: getPositiveNumber('WATCHDOG_INTERVAL_SECONDS', 60),
      watchdogMaxFailures: getPositiveNumber('WATCHDOG_MAX_FAILURES', 2),
      // PORT lo provee Railway para el healthcheck; HEALTH_PORT es override manual.
      healthPort: getPositiveNumber('PORT', getPositiveNumber('HEALTH_PORT', 3000)),
    },
    catchUp: {
      // F0.5: al arrancar, reprocesar el backlog de mensajes con media que llegaron
      // durante el outage (idempotencia via processedStore evita duplicados).
      enabled: getBoolean('CATCHUP_ENABLED', true),
      delaySeconds: getPositiveNumber('CATCHUP_DELAY_SECONDS', 30),
      windowMinutes: getPositiveNumber('CATCHUP_WINDOW_MINUTES', 30),
      fetchLimit: getPositiveNumber('CATCHUP_FETCH_LIMIT', 50),
    },
    sheets: {
      // MOD-01: si GOOGLE_SHEETS_ID esta seteada, los grupos/TAGs salen de Sheets y
      // las vars legacy (config.json / WHATSAPP_ALLOWED_GROUPS_JSON) se ignoran.
      enabled: Boolean(process.env.GOOGLE_SHEETS_ID),
      spreadsheetId: process.env.GOOGLE_SHEETS_ID || undefined,
      sheetName: process.env.GOOGLE_SHEETS_SHEET_NAME || 'Hoja 1',
      tagColumn: process.env.GOOGLE_SHEETS_TAG_COLUMN || 'E',
      groupColumn: process.env.GOOGLE_SHEETS_GROUP_COLUMN || 'K',
      credentialsPath: resolveProjectPath(process.env.GOOGLE_SHEETS_CREDENTIALS_PATH, undefined),
      matchCaseSensitive: getBoolean('SHEETS_MATCH_CASE_SENSITIVE', false),
      // Normalizacion de TAGs (SPEC nota 3): asis | upper | underscore | upper_underscore.
      tagNormalize: process.env.SHEETS_TAG_NORMALIZE || 'upper_underscore',
      cachePath: resolveProjectPath(process.env.SHEETS_GROUPS_CACHE_PATH, 'sheets-groups-cache.json'),
      // Auto-recarga periodica de Sheets: reconoce grupos nuevos SIN deploy ni /recargar
      // manual (basta agregar el bot al grupo listado en la planilla). 0 = desactivar.
      reloadMinutes: getNumber('SHEETS_RELOAD_MINUTES', 15),
    },
    blacklist: {
      // MOD-02: blacklist + grupos exentos desde una planilla NUEVA del bot (separada de
      // cotizaciones). Si GOOGLE_SHEETS_BOT_CONFIG_ID no esta, se usa blocked-senders.json
      // + BLACKLIST_EXEMPT_GROUPS_JSON como hoy (legacy). Usa el mismo Service Account.
      enabled: Boolean(process.env.GOOGLE_SHEETS_BOT_CONFIG_ID),
      botConfigId: process.env.GOOGLE_SHEETS_BOT_CONFIG_ID || undefined,
      blacklistSheetName: process.env.GOOGLE_SHEETS_BLACKLIST_SHEET_NAME || 'BOT_BLACKLIST',
      exemptSheetName: process.env.GOOGLE_SHEETS_EXEMPT_SHEET_NAME || 'BOT_EXEMPT',
      cachePath: resolveProjectPath(process.env.SHEETS_BLACKLIST_CACHE_PATH, 'sheets-blacklist-cache.json'),
    },
    broadcast: {
      // MOD-03: difusion masiva. Timeout de confirmacion y delay entre envios (anti-spam).
      confirmTimeoutMs: getPositiveNumber('BROADCAST_CONFIRM_TIMEOUT_MS', 300000),
      sendDelayMs: getNumber('BROADCAST_SEND_DELAY_MS', 1500),
    },
    weeklyReport: {
      // MOD-05: informe semanal de errores via Claude API (fetch nativo, sin SDK).
      enabled: getBoolean('WEEKLY_REPORT_ENABLED', true),
      apiKey: process.env.ANTHROPIC_API_KEY || undefined,
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
      hour: getNumber('WEEKLY_REPORT_HOUR', 18),
      lookbackDays: getPositiveNumber('WEEKLY_REPORT_LOOKBACK_DAYS', 7),
      statePath: resolveProjectPath(process.env.WEEKLY_REPORT_STATE_PATH, 'weekly-report-state.json'),
    },
    operationalNotifications: {
      enabled: getBoolean('OPERATIONAL_NOTIFICATIONS_ENABLED', true),
      alertGroupName: process.env.WHATSAPP_ALERT_GROUP_NAME || '',
      alertGroupNames,
      statusGroupNames,
      dailyGroupNames,
      dailyNotifyDelayMs,
      notifyOnReady: getBoolean('OPERATIONAL_NOTIFY_ON_READY', true),
      notifyOnOffHours: getBoolean('OPERATIONAL_NOTIFY_ON_OFF_HOURS', true),
      notifyOnShutdown: getBoolean('OPERATIONAL_NOTIFY_ON_SHUTDOWN', false),
      statusCheckIntervalSeconds: getPositiveNumber('OPERATIONAL_STATUS_CHECK_INTERVAL_SECONDS', 60),
      // Mejora: re-alertar condiciones recurrentes tras este TTL (no silenciar de por vida).
      alertDedupeTtlMs: getPositiveNumber('ALERT_DEDUPE_TTL_MINUTES', 30) * 60 * 1000,
      // Canal out-of-band (Telegram) para ERROR/CRITICAL: llega aunque el WhatsApp este caido.
      outOfBand: {
        telegramToken: process.env.ALERT_TELEGRAM_BOT_TOKEN || undefined,
        telegramChatId: process.env.ALERT_TELEGRAM_CHAT_ID || undefined,
      },
    },
    google: {
      driveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID || fileConfig.driveFolderId,
      pendingFolderId: process.env.GOOGLE_DRIVE_PENDING_FOLDER_ID || undefined,
      oauthRedirectHost,
      oauthRedirectPort,
      oauthRedirectUri: `http://${oauthRedirectHost}:${oauthRedirectPort}`,
      oauthScope: process.env.GOOGLE_OAUTH_SCOPE || DEFAULT_GOOGLE_SCOPE,
      oauthTimeoutSeconds: getPositiveNumber('GOOGLE_OAUTH_TIMEOUT_SECONDS', 300),
    },
    whatsapp: {
      clientId: process.env.WHATSAPP_CLIENT_ID || undefined,
      // MOD-03/04: grupo desde donde se operan los comandos y el broadcast.
      controlGroupName: process.env.WHATSAPP_CONTROL_GROUP_NAME || undefined,
      groups: envGroups || fileConfig.groups || {},
      readyTimeoutSeconds: getPositiveNumber('WHATSAPP_READY_TIMEOUT_SECONDS', 120),
      webVersion: process.env.WHATSAPP_WEB_VERSION || undefined,
      webVersionCacheType: getWhatsappWebCacheType(),
      webVersionRemotePath: process.env.WHATSAPP_WEB_VERSION_REMOTE_PATH || undefined,
    },
    puppeteer: {
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      headless: getOptionalBoolean('PUPPETEER_HEADLESS'),
      browserArgs: parseList(process.env.PUPPETEER_BROWSER_ARGS, 'PUPPETEER_BROWSER_ARGS'),
    },
  };
}

module.exports = {
  loadConfig,
};
