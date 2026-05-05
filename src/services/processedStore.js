const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { maskSensitiveText } = require('../utils/mask');

const STORE_VERSION = 1;

function getSerializedId(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value._serialized) return value._serialized;
  if (value.id) return value.id;
  return '';
}

function hashMessageKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

function buildMessageKey(message, chat) {
  const chatId = getSerializedId(chat && chat.id);
  const messageId = getSerializedId(message && message.id);
  if (!chatId || !messageId) return '';
  return hashMessageKey(`${chatId}|${messageId}`);
}

function createEmptyStore() {
  return {
    version: STORE_VERSION,
    updatedAt: new Date().toISOString(),
    entries: {},
  };
}

function normalizeStore(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return createEmptyStore();
  const entries = raw.entries && typeof raw.entries === 'object' && !Array.isArray(raw.entries)
    ? raw.entries
    : {};

  return {
    version: STORE_VERSION,
    updatedAt: raw.updatedAt || new Date().toISOString(),
    entries,
  };
}

function pruneStore(store, options, nowMs = Date.now()) {
  const ttlMs = Math.max(1, options.ttlHours) * 60 * 60 * 1000;
  const maxItems = Math.max(1, options.maxItems);
  const entries = Object.entries(store.entries)
    .filter(([, entry]) => {
      const processedAt = Date.parse(entry && entry.processedAt);
      return Number.isFinite(processedAt) && nowMs - processedAt <= ttlMs;
    })
    .sort((a, b) => Date.parse(b[1].processedAt) - Date.parse(a[1].processedAt));

  store.entries = Object.fromEntries(entries.slice(0, maxItems));
  store.updatedAt = new Date(nowMs).toISOString();
  return store;
}

function readStore(filePath, options) {
  if (!fs.existsSync(filePath)) return createEmptyStore();

  const rawContent = fs.readFileSync(filePath, 'utf8').trim();
  if (!rawContent) return createEmptyStore();

  try {
    return pruneStore(normalizeStore(JSON.parse(rawContent)), options);
  } catch (err) {
    const backupPath = `${filePath}.invalid-${Date.now()}.bak`;
    try {
      fs.renameSync(filePath, backupPath);
      console.warn('[processed-store] JSON invalido respaldado y store reiniciado.');
    } catch (backupErr) {
      console.warn('[processed-store] JSON invalido. No se pudo crear respaldo:', maskSensitiveText(backupErr.message));
    }
    return createEmptyStore();
  }
}

function writeStoreAtomic(filePath, store) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function createProcessedStore(config) {
  const filePath = config.paths.processedStore;
  const options = config.processedStore;
  let store = readStore(filePath, options);

  function save() {
    store = pruneStore(store, options);
    writeStoreAtomic(filePath, store);
  }

  function has(messageKey) {
    if (!messageKey) return false;
    store = pruneStore(store, options);
    return Boolean(store.entries[messageKey]);
  }

  function markProcessed(messageKey, metadata = {}) {
    if (!messageKey) return;
    store.entries[messageKey] = {
      processedAt: new Date().toISOString(),
      status: metadata.status || 'uploaded',
    };
    save();
  }

  return {
    has,
    markProcessed,
    path: filePath,
  };
}

module.exports = {
  buildMessageKey,
  createProcessedStore,
  hashMessageKey,
  pruneStore,
  readStore,
};
