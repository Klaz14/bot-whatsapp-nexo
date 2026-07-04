// MOD-02: cache en memoria + disco de la blacklist y los grupos exentos, leidos de
// una planilla NUEVA del bot (separada de la de cotizaciones). Lookup O(1) por mensaje
// (sin leer disco). Se recarga al arrancar y con /recargar. Si Sheets falla, conserva
// el cache anterior. Patron identico a groupsCache.

const fs = require('fs');
const { canonicalizePhone, loadBlockedSenders } = require('./blockedSenders');

function createBlacklistCache({ config, sheetsService }) {
  let blockedSet = new Set();
  let exemptSet = new Set();
  let loadedAt = null;

  function isBlocked(senderId) {
    const n = canonicalizePhone(senderId);
    return n ? blockedSet.has(n) : false;
  }

  function isExempt(groupName) {
    return exemptSet.has(groupName);
  }

  function getNumbers() {
    return Array.from(blockedSet);
  }

  function persist() {
    try {
      const tmp = `${config.blacklist.cachePath}.tmp`;
      const data = {
        loadedAt,
        blockedNumbers: Array.from(blockedSet),
        exemptGroups: Array.from(exemptSet),
      };
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, config.blacklist.cachePath);
    } catch (err) {
      console.warn('[BLACKLIST-CACHE] no se pudo persistir:', err && err.message);
    }
  }

  // B3 (MOD-02 nota 4): 3er nivel de fallback. Si no hay cache de Sheets en disco (o quedo
  // corrupto), sembrar la blacklist con el legacy local (blocked-senders.json +
  // BLACKLIST_EXEMPT_GROUPS_JSON) para NO arrancar con la lista VACIA (nadie bloqueado) si
  // Sheets tampoco responde. Cuando el reload de Sheets tenga exito, reemplaza (respeta la
  // intencion del operador, incluso vaciar la lista).
  function loadFallbackFromLocalFile() {
    const localPath = config.paths && config.paths.blockedSenders;
    const nums = loadBlockedSenders(localPath);
    const exempt = config.blacklistExemptGroups || [];
    if (!nums.length && !exempt.length) return false;
    if (nums.length) blockedSet = new Set(nums.map(canonicalizePhone).filter(Boolean));
    if (exempt.length) exemptSet = new Set(exempt.map((g) => String(g).trim()).filter(Boolean));
    console.warn(`[BLACKLIST-CACHE] sin cache de Sheets; fallback legacy: ${blockedSet.size} bloqueados, ${exemptSet.size} exentos (blocked-senders.json + BLACKLIST_EXEMPT_GROUPS_JSON).`);
    return true;
  }

  function loadFromDisk() {
    try {
      if (!fs.existsSync(config.blacklist.cachePath)) return loadFallbackFromLocalFile();
      const d = JSON.parse(fs.readFileSync(config.blacklist.cachePath, 'utf8'));
      blockedSet = new Set((d.blockedNumbers || []).map(canonicalizePhone).filter(Boolean));
      exemptSet = new Set((d.exemptGroups || []).map((g) => String(g).trim()).filter(Boolean));
      loadedAt = d.loadedAt || null;
      console.log(`[BLACKLIST-CACHE] cargado de disco: ${blockedSet.size} bloqueados, ${exemptSet.size} exentos.`);
      return true;
    } catch (err) {
      console.warn('[BLACKLIST-CACHE] no se pudo leer el cache de disco:', err && err.message);
      return loadFallbackFromLocalFile();
    }
  }

  async function reload() {
    const [nums, groups] = await Promise.all([
      sheetsService.readBlacklist(),
      sheetsService.readExemptGroups(),
    ]);
    blockedSet = new Set(nums.map(canonicalizePhone).filter(Boolean));
    exemptSet = new Set(groups.map((g) => String(g).trim()).filter(Boolean));
    loadedAt = new Date().toISOString();
    persist();
    return { blocked: blockedSet.size, exempt: exemptSet.size };
  }

  return { isBlocked, isExempt, getNumbers, reload, persist, loadFromDisk };
}

module.exports = { createBlacklistCache };
