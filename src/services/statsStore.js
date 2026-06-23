// MOD-04: store de metricas diarias. Registra cada comprobante subido OK con
// { ts, tag, groupName, inBusinessHours } y rota de forma lazy al cambiar el dia
// habil (archiva el dia anterior). Escritura atomica (patron processedStore).

const fs = require('fs');
const {
  getBusinessDateString,
  getOperationalDateForMessage,
  isWithinBusinessHours,
  loadBusinessCalendar,
} = require('../utils/businessCalendar');

function createStatsStore(config) {
  let state = { date: null, entries: [] };
  let lastActivityTs = null;

  function calendar() {
    return loadBusinessCalendar(config.paths.businessCalendar, {});
  }

  function businessDateOf(date) {
    const cal = calendar();
    return getBusinessDateString(getOperationalDateForMessage(date, cal), cal);
  }

  function persist() {
    try {
      const tmp = `${config.paths.statsStore}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, config.paths.statsStore);
    } catch (err) {
      console.warn('[STATS] no se pudo persistir:', err && err.message);
    }
  }

  function load() {
    try {
      if (fs.existsSync(config.paths.statsStore)) {
        const d = JSON.parse(fs.readFileSync(config.paths.statsStore, 'utf8'));
        if (d && Array.isArray(d.entries)) {
          state = { date: d.date || null, entries: d.entries };
        }
      }
    } catch (err) {
      console.warn('[STATS] no se pudo leer:', err && err.message);
    }
  }

  // Rota de forma lazy: si cambio el dia habil, archiva y arranca uno nuevo.
  function rotateIfNeeded(now = new Date()) {
    const today = businessDateOf(now);
    if (!state.date) {
      state.date = today;
      return;
    }
    if (state.date !== today) {
      try {
        const archive = config.paths.statsStore.replace(/\.json$/i, `-${state.date}.json`);
        fs.writeFileSync(archive, JSON.stringify(state, null, 2));
      } catch (_) { /* best effort */ }
      state = { date: today, entries: [] };
      persist();
    }
  }

  // messageDate = timestamp ORIGINAL del mensaje (para clasificar en/fuera de horario
  // segun cuando llego, no cuando se proceso) — SPEC MOD-04 O3.
  function recordUpload({ tag, groupName, messageDate }) {
    rotateIfNeeded();
    const inBusinessHours = isWithinBusinessHours(messageDate || new Date(), calendar());
    const ts = new Date().toISOString();
    state.entries.push({ ts, tag: tag || '-', groupName: groupName || '-', inBusinessHours });
    lastActivityTs = ts;
    persist();
  }

  function getDailyStats() {
    rotateIfNeeded();
    return { date: state.date, entries: state.entries.slice() };
  }

  function getLastActivity() {
    return lastActivityTs;
  }

  load();
  return { recordUpload, getDailyStats, getLastActivity };
}

module.exports = { createStatsStore };
