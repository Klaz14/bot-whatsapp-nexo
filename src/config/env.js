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
