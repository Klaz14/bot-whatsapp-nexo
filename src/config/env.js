const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT, resolveProjectPath } = require('./paths');

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

function getNumber(name, defaultValue) {
  const value = process.env[name];
  if (value === undefined || value === '') return defaultValue;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} debe ser numerico`);
  }
  return parsed;
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

  const oauthRedirectHost = process.env.GOOGLE_OAUTH_REDIRECT_HOST || 'localhost';
  const oauthRedirectPort = getNumber('GOOGLE_OAUTH_REDIRECT_PORT', 53682);

  return {
    projectRoot: PROJECT_ROOT,
    env: process.env.BOT_ENV || process.env.NODE_ENV || 'local',
    dryRun: getBoolean('BOT_DRY_RUN', false),
    processingEnabled: getBoolean('BOT_PROCESSING_ENABLED', true),
    logLevel: process.env.BOT_LOG_LEVEL || 'info',
    safety: {
      allowRealWhatsappConnection: getBoolean('ALLOW_REAL_WHATSAPP_CONNECTION', true),
      allowRealDriveUploads: getBoolean('ALLOW_REAL_DRIVE_UPLOADS', true),
    },
    paths: {
      groupConfig: groupConfigPath,
      credentials: resolveProjectPath(process.env.GOOGLE_CREDENTIALS_PATH, 'credentials.json'),
      token: resolveProjectPath(process.env.GOOGLE_TOKEN_PATH, 'token.json'),
      whatsappAuthData: resolveProjectPath(process.env.WHATSAPP_AUTH_DATA_PATH, '.wwebjs_auth'),
      uploadsLog: resolveProjectPath(process.env.LOG_UPLOADS_PATH, 'uploads.log'),
      errorsLog: resolveProjectPath(process.env.LOG_ERRORS_PATH, 'errors.log'),
    },
    google: {
      driveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID || fileConfig.driveFolderId,
      oauthRedirectHost,
      oauthRedirectPort,
      oauthRedirectUri: `http://${oauthRedirectHost}:${oauthRedirectPort}`,
      oauthScope: process.env.GOOGLE_OAUTH_SCOPE || DEFAULT_GOOGLE_SCOPE,
    },
    whatsapp: {
      clientId: process.env.WHATSAPP_CLIENT_ID || undefined,
      groups: envGroups || fileConfig.groups || {},
    },
  };
}

module.exports = {
  loadConfig,
};
