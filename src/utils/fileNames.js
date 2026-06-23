const { extFromMime } = require('./mime');
const { sanitizeExtension, sanitizeTag } = require('./sanitize');
const { formatLocalDayMonthForFilename, formatLocalTimeForFilename } = require('./time');

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
};
