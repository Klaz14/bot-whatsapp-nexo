// MOD-05: parser de errors.log para el informe semanal.
// El log tiene formato MIXTO: lineas TSV de logService.errorEvent (..\tERROR: msg) y
// lineas crudas de index.js (ISO\ttoken\t..\tERROR: msg). Las de duplicados (DUPLICATE)
// NO son errores y se descartan. errors.log no guarda eventType, asi que clusterizamos
// por el MENSAJE normalizado (frágil pero suficiente para un digest; mejora futura: O1).

function parseTimestamp(field) {
  if (!field) return NaN;
  if (field.includes('T')) {
    const t = Date.parse(field);
    return Number.isFinite(t) ? t : NaN;
  }
  // "YYYY-MM-DD HH:mm:ss America/..." -> tomar los primeros 19 chars como datetime local.
  const dt = field.slice(0, 19).replace(' ', 'T');
  const t = Date.parse(dt);
  return Number.isFinite(t) ? t : NaN;
}

function normalizeKey(message) {
  return String(message || '')
    .toLowerCase()
    .replace(/\d+/g, '#')      // numeros -> # (agrupa "status 429" con "status 500"? no: 4## vs 5##)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function parseErrors(content, sinceMs) {
  const lines = String(content || '').split(/\r?\n/);
  const errors = [];
  for (const line of lines) {
    if (!line) continue;
    if (line.includes('DUPLICATE')) continue;
    const idx = line.indexOf('ERROR:');
    if (idx < 0) continue;
    const ts = parseTimestamp(line.split('\t')[0]);
    if (sinceMs && Number.isFinite(ts) && ts < sinceMs) continue;
    const message = line.slice(idx + 'ERROR:'.length).trim();
    if (message) errors.push({ ts, message });
  }
  return errors;
}

function clusterErrors(errors) {
  const map = new Map();
  for (const e of errors) {
    const key = normalizeKey(e.message);
    if (!map.has(key)) {
      map.set(key, { key, count: 0, lastMessage: e.message, lastTs: e.ts });
    }
    const c = map.get(key);
    c.count += 1;
    if (!Number.isFinite(c.lastTs) || (Number.isFinite(e.ts) && e.ts > c.lastTs)) {
      c.lastTs = e.ts;
      c.lastMessage = e.message;
    }
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

module.exports = { parseErrors, clusterErrors, normalizeKey, parseTimestamp };
