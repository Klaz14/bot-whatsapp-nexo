const { limitString } = require('./sanitize');

const DRIVE_FILE_URL_RE = /https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)(?:\/[^\s\t]*)?/g;
const DRIVE_FOLDER_URL_RE = /https:\/\/drive\.google\.com\/drive\/folders\/([A-Za-z0-9_-]+)(?:[^\s\t]*)?/g;
const GENERIC_URL_RE = /https?:\/\/[^\s\t]+/g;
const GOOGLE_ACCESS_TOKEN_RE = /ya29\.[A-Za-z0-9._-]+/g;
const GOOGLE_REFRESH_TOKEN_RE = /1\/\/[A-Za-z0-9._-]+/g;
const GOOGLE_CLIENT_SECRET_RE = /GOCSPX-[A-Za-z0-9_-]+/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._-]+/gi;
const LONG_ID_RE = /\b[A-Za-z0-9_-]{24,}\b/g;
const LONG_PHONE_RE = /\b\d{8,}\b/g;

function maskLongId(value, visible = 4) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= visible) return '*'.repeat(text.length);
  return `${'*'.repeat(Math.max(3, text.length - visible))}${text.slice(-visible)}`;
}

function maskPhone(value, visible = 4) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return 'unknown';
  return `phone_${maskLongId(digits, visible)}`;
}

function maskDriveLink(value) {
  if (!value) return '';
  return String(value)
    .replace(DRIVE_FILE_URL_RE, '[drive-link-hidden:$1]')
    .replace(DRIVE_FOLDER_URL_RE, '[drive-folder-hidden:$1]')
    .replace(LONG_ID_RE, (match) => maskLongId(match));
}

function formatDriveReference(result, storeFullLink = false) {
  if (!result) return '';
  if (storeFullLink && result.webViewLink) return result.webViewLink;
  if (result.id) return `[drive-file:${maskLongId(result.id)}]`;
  return '[drive-link-hidden]';
}

function maskSensitiveText(value, maxLength = 240) {
  if (value === undefined || value === null) return '';
  return limitString(String(value), maxLength)
    .replace(DRIVE_FILE_URL_RE, '[drive-link-hidden]')
    .replace(DRIVE_FOLDER_URL_RE, '[drive-folder-hidden]')
    .replace(GENERIC_URL_RE, '[url-hidden]')
    .replace(GOOGLE_ACCESS_TOKEN_RE, '[google-access-token-hidden]')
    .replace(GOOGLE_REFRESH_TOKEN_RE, '[google-refresh-token-hidden]')
    .replace(GOOGLE_CLIENT_SECRET_RE, '[google-client-secret-hidden]')
    .replace(BEARER_RE, 'Bearer [token-hidden]')
    .replace(LONG_PHONE_RE, (match) => maskPhone(match))
    .replace(LONG_ID_RE, (match) => maskLongId(match));
}

module.exports = {
  formatDriveReference,
  maskDriveLink,
  maskLongId,
  maskPhone,
  maskSensitiveText,
};
