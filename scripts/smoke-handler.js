// SMOKE del flujo del handler con dependencias MOCKEADAS (sin red, sin produccion).
// Invariante: un comprobante de grupo configurado nunca se pierde (sube+👍 o encola+🕒);
// uno de grupo NO configurado se ignora. Temporal: se corre y se borra.
const assert = require('assert');
const { createMessageHandler } = require('../src/handlers/messageHandler');

const PNG_B64 = Buffer.from('fake-bytes').toString('base64');

function makeMsg({ groupName, hasMedia = true }) {
  const reactions = [];
  return {
    reactions,
    author: '5491111111111@c.us',
    from: '5491111111111@c.us',
    timestamp: Math.floor(Date.now() / 1000),
    hasMedia,
    id: { _serialized: 'msg-' + Math.random().toString(16).slice(2) },
    async getChat() { return { isGroup: true, name: groupName, id: { _serialized: 'chat-' + groupName } }; },
    async downloadMedia() { return { mimetype: 'image/jpeg', data: PNG_B64, filename: 'comp.jpg' }; },
    async react(e) { reactions.push(e); },
  };
}

function makeDeps() {
  const calls = { upload: 0, pending: 0, marked: 0, recorded: 0 };
  const config = {
    processingEnabled: true,
    reactOnProcessed: true,
    timeZone: 'America/Argentina/Buenos_Aires',
    blacklistExemptGroups: [],
    whatsapp: { groups: { 'Grupo OK': 'TAGOK' } },
    google: { pendingFolderId: 'pend-folder' },
    paths: { businessCalendar: 'no-existe.json', blockedSenders: 'no-existe.json' },
  };
  const driveService = {
    async uploadWithRetry() { calls.upload++; return { filename: '1_0101_1200_TAGOK.jpg', folderPath: '/' }; },
    async createPendingUpload() { calls.pending++; return { name: 'pend.jpg', folderPath: 'PENDIENTES' }; },
    async findPendingByMessageKey() { return null; },
  };
  const logService = { uploadEvent: () => 'driveRef', duplicateEvent: () => {}, errorEvent: () => {} };
  const processedStore = { has: () => false, markProcessed: () => { calls.marked++; } };
  const statsStore = { recordUpload: () => { calls.recorded++; } };
  const operationalNotifier = {
    async notifyError() {}, async notifyWarning() {},
  };
  return { calls, deps: { config, driveService, logService, processedStore, operationalNotifier, statsStore } };
}

(async () => {
  let pass = 0; let fail = 0;
  const t = (n, c) => { try { c(); console.log('  ok  ' + n); pass++; } catch (e) { console.error('  FAIL ' + n + ': ' + e.message); fail++; } };

  // 1) Grupo configurado: no se pierde (sube+👍 o encola+🕒) y se contabiliza.
  {
    const { calls, deps } = makeDeps();
    const handler = createMessageHandler(deps);
    const msg = makeMsg({ groupName: 'Grupo OK' });
    await handler(msg);
    const subio = calls.upload === 1 && msg.reactions.includes('👍') && calls.marked === 1;
    const encolo = calls.pending === 1 && msg.reactions.includes('🕒');
    t('grupo configurado -> comprobante NO se pierde (sube+👍 o encola+🕒)', () => {
      assert.ok(subio || encolo, `subio=${subio} encolo=${encolo} reactions=${msg.reactions}`);
    });
    t('se contabilizo o quedo en cola (no se descarto)', () => {
      assert.ok(calls.recorded >= 1 || calls.pending >= 1);
    });
  }

  // 2) Grupo NO configurado: se ignora (no sube, no encola, no reacciona).
  {
    const { calls, deps } = makeDeps();
    const handler = createMessageHandler(deps);
    const msg = makeMsg({ groupName: 'Grupo Random' });
    await handler(msg);
    t('grupo NO configurado -> ignorado (no sube/encola/reacciona)', () => {
      assert.strictEqual(calls.upload, 0);
      assert.strictEqual(calls.pending, 0);
      assert.strictEqual(msg.reactions.length, 0);
    });
  }

  // 3) Mensaje sin media en grupo configurado: ignorado.
  {
    const { calls, deps } = makeDeps();
    const handler = createMessageHandler(deps);
    const msg = makeMsg({ groupName: 'Grupo OK', hasMedia: false });
    await handler(msg);
    t('grupo configurado sin media -> ignorado', () => {
      assert.strictEqual(calls.upload, 0);
      assert.strictEqual(calls.pending, 0);
    });
  }

  console.log(`\nHANDLER SMOKE: ${pass} OK, ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
})();
