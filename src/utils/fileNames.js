const { extFromMime } = require('./mime');

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function buildUploadFilename(tag, senderId, media) {
  const sender = (senderId || 'unknown').replace(/[^0-9]/g, '') || 'unknown';
  const ext = extFromMime(media.mimetype, media.filename);
  return `${tag}_${timestamp()}_${sender}.${ext}`;
}

module.exports = {
  buildUploadFilename,
  timestamp,
};
