const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
]);

function extFromMime(mime, fallbackName) {
  const map = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'application/pdf': 'pdf',
  };

  if (map[mime]) return map[mime];
  if (fallbackName && fallbackName.includes('.')) {
    return fallbackName.split('.').pop().toLowerCase();
  }
  return 'bin';
}

module.exports = {
  ALLOWED_MIME,
  extFromMime,
};
