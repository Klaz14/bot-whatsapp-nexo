const DEFAULT_TIME_ZONE = 'America/Argentina/Buenos_Aires';

function isValidTimeZone(timeZone) {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch (err) {
    return false;
  }
}

function normalizeTimeZone(timeZone) {
  return isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
}

function toUtcISOString(date = new Date()) {
  return date.toISOString();
}

function toLocalAuditString(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const safeTimeZone = normalizeTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function buildAuditTime(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const safeTimeZone = normalizeTimeZone(timeZone);
  return {
    utc: toUtcISOString(date),
    local: toLocalAuditString(date, safeTimeZone),
    timeZone: safeTimeZone,
  };
}

function getLocalDateParts(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const safeTimeZone = normalizeTimeZone(timeZone);
  const safeDate = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(safeDate);

  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function getLocalTimeParts(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const safeTimeZone = normalizeTimeZone(timeZone);
  const safeDate = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTimeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(safeDate);

  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function formatLocalMonthForDriveFolder(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const values = getLocalDateParts(date, timeZone);
  return `${values.month}-${values.year}`;
}

function formatLocalDayForDriveFolder(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const values = getLocalDateParts(date, timeZone);
  return values.day;
}

function formatLocalTimeForFilename(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const values = getLocalTimeParts(date, timeZone);
  return `${values.hour}${values.minute}`;
}

module.exports = {
  DEFAULT_TIME_ZONE,
  buildAuditTime,
  formatLocalDayForDriveFolder,
  formatLocalMonthForDriveFolder,
  formatLocalTimeForFilename,
  normalizeTimeZone,
  toLocalAuditString,
  toUtcISOString,
};
