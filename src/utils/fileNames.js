const { extFromMime } = require('./mime');
const { maskSenderForFilename } = require('./mask');
const { sanitizeExtension, sanitizeTag } = require('./sanitize');

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function buildUploadFilename(tag, senderId, media) {
  const safeTag = sanitizeTag(tag);
  const sender = maskSenderForFilename(senderId);
  const ext = sanitizeExtension(extFromMime(media.mimetype, media.filename));
  return `${safeTag}_${timestamp()}_${sender}.${ext}`;
}

module.exports = {
  buildUploadFilename,
  timestamp,
};
