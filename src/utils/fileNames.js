const { extFromMime } = require('./mime');
const { maskSenderForFilename } = require('./mask');
const { sanitizeExtension, sanitizeTag } = require('./sanitize');
const { formatLocalDayMonthForFilename, formatLocalTimeForFilename } = require('./time');

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

function buildSequentialUploadFilename({ id, date, tag, media, timeZone, pageNumber }) {
  const safeId = Number.isInteger(id) && id > 0 ? id : 1;
  const dayMonth = formatLocalDayMonthForFilename(date, timeZone);
  const time = formatLocalTimeForFilename(date, timeZone);
  const safeTag = sanitizeTag(tag);
  const ext = sanitizeExtension(extFromMime(media && media.mimetype, media && media.filename));
  const pageSuffix = Number.isInteger(pageNumber) && pageNumber >= 1 ? `_${pageNumber}` : '';
  return `${safeId}_${dayMonth}_${time}_${safeTag}${pageSuffix}.${ext}`;
}

module.exports = {
  buildSequentialUploadFilename,
  buildUploadFilename,
  timestamp,
};
