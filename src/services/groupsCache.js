// MOD-01: cache en memoria + disco del mapa { nombre_grupo: { tag, chatId, source } }.
// Lookup O(1) en runtime (sin latencia de Sheets por mensaje). Se recarga al arrancar
// y con /recargar (MOD-04). Si Sheets falla, se conserva el cache anterior.

const fs = require('fs');
const { matchExact } = require('./groupMatcher');

// Normalizacion de TAGs (SPEC nota 3). Default (d): MAYUSCULAS + espacios->'_'.
function normalizeTag(tag, mode) {
  const t = String(tag || '').trim();
  switch (mode) {
    case 'asis': return t;
    case 'upper': return t.toUpperCase();
    case 'underscore': return t.replace(/\s+/g, '_');
    case 'upper_underscore':
    default: return t.toUpperCase().replace(/\s+/g, '_');
  }
}

function createGroupsCache({ config, sheetsService, getChats }) {
  let map = {};          // name -> { tag, chatId, source }
  let idIndex = {};      // chatId -> tag (ruteo estable ante grupos homonimos)
  let loadedAt = null;

  function rebuildIdIndex() {
    idIndex = {};
    for (const [, v] of Object.entries(map)) {
      if (v && v.chatId) idIndex[v.chatId] = v.tag;
    }
  }

  function getTag(name) {
    const entry = map[name];
    return entry ? entry.tag : undefined;
  }

  // Ruteo por ID estable del chat: evita el bug de "primero gana" con nombres homonimos.
  function getTagById(chatId) {
    return chatId ? idIndex[chatId] : undefined;
  }

  function getAll() {
    return { ...map };
  }

  function size() {
    return Object.keys(map).length;
  }

  function persist() {
    try {
      const tmp = `${config.sheets.cachePath}.tmp`;
      const data = { loadedAt, source: 'sheets', groups: map };
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, config.sheets.cachePath); // escritura atomica (patron processedStore)
    } catch (err) {
      console.warn('[GROUPS-CACHE] no se pudo persistir el cache:', err && err.message);
    }
  }

  function loadFromDisk() {
    try {
      if (!fs.existsSync(config.sheets.cachePath)) return false;
      const data = JSON.parse(fs.readFileSync(config.sheets.cachePath, 'utf8'));
      if (data && data.groups && typeof data.groups === 'object') {
        map = data.groups;
        loadedAt = data.loadedAt || null;
        rebuildIdIndex();
        console.log(`[GROUPS-CACHE] cargado de disco: ${size()} grupos (loadedAt ${loadedAt || '-'}).`);
        return true;
      }
    } catch (err) {
      console.warn('[GROUPS-CACHE] no se pudo leer el cache de disco:', err && err.message);
    }
    return false;
  }

  // Lee Sheets + grupos presentes -> match exacto -> actualiza memoria + disco.
  // Si algo falla, lanza (el llamador conserva el cache anterior).
  async function reload() {
    const pairs = await sheetsService.readGroupTagPairs();
    const chats = await getChats();
    const presentGroups = (chats || []).filter((c) => c && c.isGroup);
    const presentNames = presentGroups.map((c) => c.name);
    const idByName = new Map(presentGroups.map((c) => [c.name, c.id && c.id._serialized]));

    const { matched, unmatched } = matchExact(presentNames, pairs, {
      caseSensitive: config.sheets.matchCaseSensitive,
    });

    const newMap = {};
    for (const m of matched) {
      newMap[m.name] = {
        tag: normalizeTag(m.tag, config.sheets.tagNormalize),
        chatId: idByName.get(m.name) || null,
        source: 'sheets',
      };
    }

    map = newMap;
    rebuildIdIndex();
    loadedAt = new Date().toISOString();
    persist();

    return {
      matched: matched.length,
      unmatchedSheet: unmatched.length,
      total: pairs.length,
      loadedAt,
    };
  }

  return { getTag, getTagById, getAll, size, persist, loadFromDisk, reload };
}

module.exports = { createGroupsCache, normalizeTag };
