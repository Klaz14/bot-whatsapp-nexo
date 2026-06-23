const fs = require('fs');
const path = require('path');

function normalizePhoneNumber(value) {
  if (value === undefined || value === null) return '';

  const text = String(value).trim();
  const beforeAt = text.split('@')[0];
  const beforeDeviceSuffix = beforeAt.split(':')[0];
  return beforeDeviceSuffix.replace(/\D/g, '');
}

function getPhoneSuffix(value, visible = 4) {
  const normalized = normalizePhoneNumber(value);
  if (!normalized) return 'unknown';
  return normalized.slice(-visible).padStart(visible, 'x');
}

// Canonicaliza el "9" de moviles argentinos: 549XXXXXXXXXX (13) -> 54XXXXXXXXXX (12).
// Asi un numero cargado con o sin el 9 matchea igual (el LID de WhatsApp suele traer el 9).
function canonicalizePhone(value) {
  const n = normalizePhoneNumber(value);
  if (/^549\d{10}$/.test(n)) return `54${n.slice(3)}`;
  return n;
}

function isFullSenderDebugEnabled(value = process.env.BLACKLIST_DEBUG_FULL_SENDER) {
  if (value === undefined || value === null) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function getDefaultBlockedSendersPath(projectRoot = process.cwd()) {
  return path.resolve(projectRoot, 'blocked-senders.json');
}

function normalizeBlockedNumbers(value) {
  if (!Array.isArray(value)) return [];

  return Array.from(
    new Set(
      value
        .map((item) => normalizePhoneNumber(item))
        .filter(Boolean)
    )
  );
}

function loadBlockedSenders(filePath, options = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return normalizeBlockedNumbers(parsed && parsed.blockedNumbers);
  } catch (err) {
    console.warn('[blocked-senders] invalid local blacklist file; ignoring it for this message.');
    if (options && typeof options.onWarning === 'function') {
      options.onWarning({ reason: 'invalid-json', error: err });
    }
    return [];
  }
}

function isSenderBlocked(senderId, blockedNumbers) {
  const canonicalSender = canonicalizePhone(senderId);
  if (!canonicalSender) return false;

  const canonicalBlocked = new Set(
    (Array.isArray(blockedNumbers) ? blockedNumbers : [])
      .map(canonicalizePhone)
      .filter(Boolean)
  );
  return canonicalBlocked.has(canonicalSender);
}

module.exports = {
  canonicalizePhone,
  getDefaultBlockedSendersPath,
  getPhoneSuffix,
  isFullSenderDebugEnabled,
  isSenderBlocked,
  loadBlockedSenders,
  normalizePhoneNumber,
};
