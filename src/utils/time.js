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

function formatLocalDateForPendingFolder(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const values = getLocalDateParts(date, timeZone);
  return `${values.day}-${values.month}-${values.year}`;
}

function formatLocalTimeForFilename(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const values = getLocalTimeParts(date, timeZone);
  return `${values.hour}${values.minute}`;
}

function formatLocalDayMonthForFilename(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const values = getLocalDateParts(date, timeZone);
  return `${values.day}${values.month}`;
}

// Parsea "YYYY-MM-DD HH:mm" (acepta tambien "T" como separador) interpretando la hora en la
// timeZone dada y devuelve el Date (instante UTC) correcto. null si el formato es invalido.
// Lo usa el override manual del catch-up (CATCHUP_SINCE): el operador escribe la hora de la
// caida en hora LOCAL (la que ve) y esto la convierte al instante real. Algoritmo estandar
// zoned-time -> UTC de una pasada: correcto para TZ sin DST como Argentina (en el borde de
// un cambio de DST podria errar 1h, no aplica aca).
function parseLocalDateTime(str, timeZone = DEFAULT_TIME_ZONE) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(String(str || '').trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const safeTimeZone = normalizeTimeZone(timeZone);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTimeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(asUtc));
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const localAsUtc = Date.UTC(+v.year, +v.month - 1, +v.day, +v.hour, +v.minute, +v.second);
  const offset = localAsUtc - asUtc; // cuanto adelanta la TZ respecto a UTC
  const result = new Date(asUtc - offset);
  return Number.isFinite(result.getTime()) ? result : null;
}

module.exports = {
  DEFAULT_TIME_ZONE,
  buildAuditTime,
  formatLocalDateForPendingFolder,
  formatLocalDayForDriveFolder,
  formatLocalDayMonthForFilename,
  formatLocalMonthForDriveFolder,
  formatLocalTimeForFilename,
  normalizeTimeZone,
  parseLocalDateTime,
  toLocalAuditString,
  toUtcISOString,
};
