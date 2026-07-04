// I2/R6: latido (heartbeat) persistido en disco. El bot escribe un timestamp cada N seg
// mientras esta vivo. Al arrancar, index.js lee el ULTIMO latido ANTES de empezar a latir
// de nuevo: si ese latido es viejo, es cuanto tiempo estuvo caido el bot -> se avisa a los
// grupos de estado (aviso post-caida). El bot caido no puede avisar por WhatsApp; este
// mecanismo permite avisarlo recien cuando vuelve. Write atomico (.tmp + rename), best-effort.

const fs = require('fs');

function createHeartbeatStore({ config }) {
  const filePath = config.paths && config.paths.heartbeat;
  const intervalMs = ((config.heartbeat && config.heartbeat.intervalSeconds) || 60) * 1000;
  let timer;

  // Ultimo latido persistido (ms epoch) o null si no hay/ilegible. Leer ANTES del primer write().
  function readLast() {
    try {
      if (!filePath || !fs.existsSync(filePath)) return null;
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const ts = data && Number(data.ts);
      return Number.isFinite(ts) ? ts : null;
    } catch (_) {
      return null; // ilegible / corrupto: best-effort
    }
  }

  function write() {
    if (!filePath) return;
    try {
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ts: Date.now(), iso: new Date().toISOString() }));
      fs.renameSync(tmp, filePath); // atomico (patron processedStore)
    } catch (err) {
      console.warn('[HEARTBEAT] no se pudo escribir el latido:', err && err.message);
    }
  }

  function start() {
    if (timer) return;
    write(); // latido inmediato al arrancar
    timer = setInterval(write, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
  }

  return { readLast, write, start, stop };
}

module.exports = { createHeartbeatStore };
