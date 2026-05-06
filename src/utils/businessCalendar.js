const fs = require('fs');
const { DEFAULT_TIME_ZONE, normalizeTimeZone } = require('./time');

const DEFAULT_BUSINESS_CALENDAR = {
  timeZone: DEFAULT_TIME_ZONE,
  businessDays: [1, 2, 3, 4, 5],
  startTime: '09:00',
  endTime: '16:30',
  nonBusinessDates: [],
};

function parseTimeToMinutes(value, fallback) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ''));
  if (!match) return fallback;
  return Number(match[1]) * 60 + Number(match[2]);
}

function isValidDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function normalizeNonBusinessDates(value) {
  if (!Array.isArray(value)) return [];

  const seen = new Set();
  const dates = [];

  for (const item of value) {
    const date = typeof item === 'string'
      ? item
      : item && typeof item === 'object'
        ? item.date
        : '';

    if (!isValidDateString(date) || seen.has(date)) continue;
    seen.add(date);
    dates.push({
      date,
      name: item && typeof item === 'object' && item.name ? String(item.name) : '',
    });
  }

  return dates.sort((a, b) => a.date.localeCompare(b.date));
}

function normalizeBusinessDays(value) {
  const source = Array.isArray(value) ? value : DEFAULT_BUSINESS_CALENDAR.businessDays;
  const days = [...new Set(source.map(Number))]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((a, b) => a - b);

  return days.length ? days : DEFAULT_BUSINESS_CALENDAR.businessDays;
}

function normalizeBusinessCalendar(raw = {}) {
  const calendar = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const defaultStart = parseTimeToMinutes(DEFAULT_BUSINESS_CALENDAR.startTime, 9 * 60);
  const defaultEnd = parseTimeToMinutes(DEFAULT_BUSINESS_CALENDAR.endTime, 16 * 60 + 30);
  let startMinutes = parseTimeToMinutes(calendar.startTime, defaultStart);
  let endMinutes = parseTimeToMinutes(calendar.endTime, defaultEnd);

  if (startMinutes > endMinutes) {
    startMinutes = defaultStart;
    endMinutes = defaultEnd;
  }

  const formatTime = (minutes) => {
    const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
    const mm = String(minutes % 60).padStart(2, '0');
    return `${hh}:${mm}`;
  };

  return {
    timeZone: normalizeTimeZone(calendar.timeZone || DEFAULT_BUSINESS_CALENDAR.timeZone),
    businessDays: normalizeBusinessDays(calendar.businessDays),
    startTime: formatTime(startMinutes),
    endTime: formatTime(endMinutes),
    startMinutes,
    endMinutes,
    nonBusinessDates: normalizeNonBusinessDates(calendar.nonBusinessDates),
  };
}

function loadBusinessCalendar(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return normalizeBusinessCalendar(DEFAULT_BUSINESS_CALENDAR);
  }

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return normalizeBusinessCalendar(raw);
}

function getSafeDate(date) {
  return date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
}

function getLocalDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(getSafeDate(date));

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    ymd: `${values.year}-${values.month}-${values.day}`,
  };
}

function getLocalWeekDay(date, timeZone) {
  const parts = getLocalDateParts(date, timeZone);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

function getLocalMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(getSafeDate(date));

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(values.hour) * 60 + Number(values.minute);
}

function addDaysToLocalDateString(ymd, days) {
  const [year, month, day] = String(ymd).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function dateFromLocalDateString(ymd) {
  return new Date(`${ymd}T12:00:00.000Z`);
}

function hasNonBusinessDate(ymd, calendar) {
  return calendar.nonBusinessDates.some((item) => item.date === ymd);
}

function isBusinessDay(date, calendar) {
  const normalized = normalizeBusinessCalendar(calendar);
  const localDate = getLocalDateParts(date, normalized.timeZone).ymd;
  const weekDay = getLocalWeekDay(date, normalized.timeZone);

  return normalized.businessDays.includes(weekDay) && !hasNonBusinessDate(localDate, normalized);
}

function isWithinBusinessHours(date, calendar) {
  const normalized = normalizeBusinessCalendar(calendar);
  if (!isBusinessDay(date, normalized)) return false;

  const minutes = getLocalMinutes(date, normalized.timeZone);
  return minutes >= normalized.startMinutes && minutes <= normalized.endMinutes;
}

function getNextBusinessDate(date, calendar) {
  const normalized = normalizeBusinessCalendar(calendar);
  let candidate = addDaysToLocalDateString(getLocalDateParts(date, normalized.timeZone).ymd, 1);

  for (let i = 0; i < 370; i += 1) {
    const candidateDate = dateFromLocalDateString(candidate);
    if (isBusinessDay(candidateDate, normalized)) return candidateDate;
    candidate = addDaysToLocalDateString(candidate, 1);
  }

  throw new Error('No se encontro proximo dia habil dentro del rango esperado');
}

function getOperationalDateForMessage(messageDate, calendar) {
  const normalized = normalizeBusinessCalendar(calendar);
  const date = getSafeDate(messageDate);

  if (!isBusinessDay(date, normalized)) {
    return getNextBusinessDate(date, normalized);
  }

  const minutes = getLocalMinutes(date, normalized.timeZone);
  if (minutes > normalized.endMinutes) {
    return getNextBusinessDate(date, normalized);
  }

  return dateFromLocalDateString(getLocalDateParts(date, normalized.timeZone).ymd);
}

function shouldProcessNow(now, calendar) {
  return isWithinBusinessHours(now, calendar);
}

function getPendingTargetDateForMessage(messageDate, calendar) {
  return getOperationalDateForMessage(messageDate, calendar);
}

module.exports = {
  DEFAULT_BUSINESS_CALENDAR,
  getNextBusinessDate,
  getOperationalDateForMessage,
  getPendingTargetDateForMessage,
  isBusinessDay,
  isWithinBusinessHours,
  loadBusinessCalendar,
  normalizeBusinessCalendar,
  shouldProcessNow,
};
