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

module.exports = {
  DEFAULT_TIME_ZONE,
  buildAuditTime,
  normalizeTimeZone,
  toLocalAuditString,
  toUtcISOString,
};
