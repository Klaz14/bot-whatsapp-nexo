const DEFAULT_MAX_FIELD_LENGTH = 120;

function limitString(value, maxLength = DEFAULT_MAX_FIELD_LENGTH) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength);
}

function collapseDots(value) {
  return value.replace(/\.+/g, '.').replace(/\.\./g, '.');
}

function sanitizeFilenamePart(value, fallback = 'unknown', maxLength = 80) {
  const cleaned = collapseDots(
    String(value || '')
      .trim()
      .replace(/\s+/g, '_')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/_+\./g, '.')
      .replace(/^[._-]+|[._-]+$/g, '')
  );

  return limitString(cleaned || fallback, maxLength);
}

function sanitizeTag(value) {
  return sanitizeFilenamePart(value, 'tag', 32);
}

function sanitizeExtension(value) {
  const cleaned = String(value || '')
    .toLowerCase()
    .replace(/^\.+/, '')
    .replace(/[^a-z0-9]+/g, '');

  return limitString(cleaned || 'bin', 12);
}

function sanitizeGroupForLog(value, maxLength = DEFAULT_MAX_FIELD_LENGTH) {
  return limitString(
    String(value || 'unknown')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'unknown',
    maxLength
  );
}

module.exports = {
  DEFAULT_MAX_FIELD_LENGTH,
  limitString,
  sanitizeExtension,
  sanitizeFilenamePart,
  sanitizeGroupForLog,
  sanitizeTag,
};
