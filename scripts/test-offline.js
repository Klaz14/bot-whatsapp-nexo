// Test OFFLINE de la logica nueva (Fase 0 + MODs). No conecta a WhatsApp/Drive, no
// necesita credenciales ni node_modules (solo usa modulos sin deps externas).
// Correr:  node scripts/test-offline.js
// Sirve como red de seguridad antes de tocar nada en serio.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); pass += 1; }
  catch (err) { console.error(`  FAIL ${name}: ${err.message}`); fail += 1; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); pass += 1; }
  catch (err) { console.error(`  FAIL ${name}: ${err.message}`); fail += 1; }
}
const tmp = (n) => path.join(os.tmpdir(), `kalaza-test-${n}-${process.pid}.json`);
const cleanup = [];

(async () => {
  console.log('\n== groupMatcher (MOD-01) ==');
  const { matchExact } = require('../src/services/groupMatcher');
  test('match exacto case-insensitive', () => {
    const pairs = [{ grupoWhatsapp: 'Vapeboss QR', tag: 'VPBOSS' }, { grupoWhatsapp: 'No existe', tag: 'X' }];
    const r = matchExact(['vapeboss qr', 'Otro'], pairs, { caseSensitive: false });
    assert.strictEqual(r.matched.length, 1);
    assert.strictEqual(r.matched[0].tag, 'VPBOSS');
    assert.strictEqual(r.unmatched.length, 1);
  });
  test('match case-sensitive distingue mayusculas', () => {
    const r = matchExact(['vapeboss qr'], [{ grupoWhatsapp: 'Vapeboss QR', tag: 'V' }], { caseSensitive: true });
    assert.strictEqual(r.matched.length, 0);
  });

  console.log('\n== groupsCache.normalizeTag (MOD-01) ==');
  const { normalizeTag } = require('../src/services/groupsCache');
  test('upper_underscore (default)', () => assert.strictEqual(normalizeTag('cruz neg 2', 'upper_underscore'), 'CRUZ_NEG_2'));
  test('asis', () => assert.strictEqual(normalizeTag('  VpBoss ', 'asis'), 'VpBoss'));
  test('underscore', () => assert.strictEqual(normalizeTag('a b c', 'underscore'), 'a_b_c'));

  console.log('\n== statsStore (MOD-04) ==');
  const { createStatsStore } = require('../src/services/statsStore');
  await testAsync('recordUpload + agregacion por tag', () => {
    const p = tmp('stats'); cleanup.push(p);
    const cfg = { timeZone: 'America/Argentina/Buenos_Aires', paths: { statsStore: p, businessCalendar: 'nope.json' } };
    const s = createStatsStore(cfg);
    s.recordUpload({ tag: 'VPBOSS', groupName: 'g', messageDate: new Date() });
    s.recordUpload({ tag: 'VPBOSS', groupName: 'g', messageDate: new Date() });
    s.recordUpload({ tag: 'AA', groupName: 'g2', messageDate: new Date() });
    const d = s.getDailyStats();
    assert.strictEqual(d.entries.length, 3);
    const byTag = {}; for (const e of d.entries) byTag[e.tag] = (byTag[e.tag] || 0) + 1;
    assert.strictEqual(byTag.VPBOSS, 2);
    assert.ok(s.getLastActivity());
  });

  console.log('\n== blacklistCache (MOD-02) ==');
  const { createBlacklistCache } = require('../src/services/blacklistCache');
  await testAsync('reload + isBlocked/isExempt normalizado', async () => {
    const p = tmp('bl'); cleanup.push(p);
    const cfg = { blacklist: { cachePath: p } };
    const fake = { readBlacklist: async () => ['+54 9 381 512-3456'], readExemptGroups: async () => ['TT/CAJA NEXO'] };
    const bc = createBlacklistCache({ config: cfg, sheetsService: fake });
    const r = await bc.reload();
    assert.strictEqual(r.blocked, 1);
    assert.strictEqual(bc.isBlocked('5493815123456@c.us'), true);
    assert.strictEqual(bc.isBlocked('5490000000@c.us'), false);
    assert.strictEqual(bc.isExempt('TT/CAJA NEXO'), true);
    assert.strictEqual(bc.isExempt('Otro'), false);
  });
  await testAsync('B3: sin cache de Sheets, cae a blocked-senders.json local + exentos legacy', () => {
    const cachePath = tmp('bl-nocache'); // NO se crea -> no existe -> dispara fallback
    const localPath = tmp('blocked-local'); cleanup.push(localPath);
    fs.writeFileSync(localPath, JSON.stringify({ blockedNumbers: ['543815123456'] }));
    const cfg = {
      blacklist: { cachePath },
      paths: { blockedSenders: localPath },
      blacklistExemptGroups: ['Grupo Exento'],
    };
    const bc = createBlacklistCache({ config: cfg, sheetsService: null });
    assert.strictEqual(bc.loadFromDisk(), true);                       // uso el fallback
    assert.strictEqual(bc.isBlocked('5493815123456@c.us'), true);      // canonical con/sin 9
    assert.strictEqual(bc.isBlocked('5490000000000@c.us'), false);
    assert.strictEqual(bc.isExempt('Grupo Exento'), true);
  });
  await testAsync('B3: sin cache ni fallback local -> lista vacia (no rompe)', () => {
    const cfg = { blacklist: { cachePath: tmp('bl-none') }, paths: {}, blacklistExemptGroups: [] };
    const bc = createBlacklistCache({ config: cfg, sheetsService: null });
    assert.strictEqual(bc.loadFromDisk(), false);
    assert.strictEqual(bc.isBlocked('5493815123456@c.us'), false);
  });

  console.log('\n== logParser (MOD-05) ==');
  const { parseErrors, clusterErrors } = require('../src/utils/logParser');
  test('descarta DUPLICATE, respeta ventana, agrupa', () => {
    const log = [
      '2026-06-16 10:00:00 America/Argentina/Buenos_Aires\tg\tt\tf\t/\ts\tERROR: status 429',
      '2026-06-16 11:00:00 America/Argentina/Buenos_Aires\tg\tt\tf\t/\ts\tERROR: status 429',
      '2026-06-15 09:00:00 America/Argentina/Buenos_Aires\tg\tt\t-\t-\t-\tDUPLICATE: ya procesado',
      '2020-01-01 00:00:00 America/Argentina/Buenos_Aires\tg\tt\tf\t/\ts\tERROR: viejo',
    ].join('\n');
    const errs = parseErrors(log, Date.parse('2026-06-14T00:00:00Z'));
    assert.strictEqual(errs.length, 2);
    const cl = clusterErrors(errs);
    assert.strictEqual(cl[0].count, 2);
  });

  console.log('\n== driveRetry (retry transitorio vs permanente) ==');
  const { isRetryableDriveError, retryWaitMs } = require('../src/utils/driveRetry');
  test('429/5xx/red = retryable; 4xx permanentes = no', () => {
    assert.strictEqual(isRetryableDriveError({ code: 429 }), true);
    assert.strictEqual(isRetryableDriveError({ code: 503 }), true);
    assert.strictEqual(isRetryableDriveError({ response: { status: 500 } }), true);
    assert.strictEqual(isRetryableDriveError({ code: 'ECONNRESET' }), true);
    assert.strictEqual(isRetryableDriveError({ message: 'socket hang up' }), true);
    // R5: premature close (bug gzip Node 22) = transitorio
    assert.strictEqual(isRetryableDriveError({ code: 'ERR_STREAM_PREMATURE_CLOSE' }), true);
    assert.strictEqual(isRetryableDriveError({ message: 'Premature close' }), true);
    assert.strictEqual(isRetryableDriveError({ code: 403 }), false);
    assert.strictEqual(isRetryableDriveError({ code: 404 }), false);
    assert.strictEqual(isRetryableDriveError({ code: 400 }), false);
  });
  test('retryWaitMs respeta Retry-After', () => {
    assert.strictEqual(retryWaitMs({ response: { headers: { 'retry-after': '2' } } }, 1), 2000);
    assert.ok(retryWaitMs({ code: 500 }, 1) > 0);
  });

  console.log('\n== blockedSenders: canonical "9" argentino ==');
  const { canonicalizePhone, isSenderBlocked } = require('../src/services/blockedSenders');
  test('549... y 54... matchean (con o sin el 9)', () => {
    assert.strictEqual(canonicalizePhone('5493815123456'), '543815123456');
    assert.strictEqual(canonicalizePhone('543815123456'), '543815123456');
    // bloqueado cargado SIN 9, sender llega CON 9 -> debe bloquear
    assert.strictEqual(isSenderBlocked('5493815123456@c.us', ['543815123456']), true);
    // y al reves
    assert.strictEqual(isSenderBlocked('543815123456@c.us', ['+54 9 381 512-3456']), true);
    assert.strictEqual(isSenderBlocked('5490000000000@c.us', ['543815123456']), false);
  });

  console.log('\n== groupsCache.getTagById (homonimos) ==');
  const { createGroupsCache } = require('../src/services/groupsCache');
  await testAsync('rutea por chatId estable', async () => {
    const p = tmp('groups'); cleanup.push(p);
    const cfg = { sheets: { cachePath: p, matchCaseSensitive: false, tagNormalize: 'upper_underscore' } };
    const sheets = { readGroupTagPairs: async () => [{ grupoWhatsapp: 'Caja Nexo', tag: 'caja n' }] };
    const getChats = async () => [{ isGroup: true, name: 'Caja Nexo', id: { _serialized: '123@g.us' } }];
    const gc = createGroupsCache({ config: cfg, sheetsService: sheets, getChats });
    await gc.reload();
    assert.strictEqual(gc.getTagById('123@g.us'), 'CAJA_N');
    assert.strictEqual(gc.getTag('Caja Nexo'), 'CAJA_N');
    assert.strictEqual(gc.getTagById('999@g.us'), undefined);
  });

  console.log('\n== operationalNotifier.formatAlertMessage (I2) ==');
  const { formatAlertMessage } = require('../src/services/operationalNotifier');
  test('etiquetas ES, campo Acción y orden de campos clave', () => {
    const msg = formatAlertMessage('ERROR', 'drive_upload_failed', 'Fallo subiendo', {
      error: 'status 429',
      filename: '12_0107_1430_XAEA.jpg',
      group: 'XAEA/NEXO',
      tag: 'XAEA',
      accion: 'reencolado a pendientes (se reintenta)',
    });
    assert.ok(msg.includes('🚨 BOT TRANSFERENCIAS - ERROR'));
    assert.ok(msg.includes('Grupo: XAEA/NEXO'));       // etiqueta ES (no "group:")
    assert.ok(msg.includes('Cartera: XAEA'));
    assert.ok(msg.includes('Comprobante: 12_0107_1430_XAEA.jpg'));
    assert.ok(msg.includes('Acción: reencolado a pendientes (se reintenta)'));
    assert.ok(!msg.includes('group:'));                // ya no muestra keys crudas
    // orden: Grupo antes que Comprobante antes que Acción antes que Error
    assert.ok(msg.indexOf('Grupo:') < msg.indexOf('Comprobante:'));
    assert.ok(msg.indexOf('Comprobante:') < msg.indexOf('Acción:'));
    assert.ok(msg.indexOf('Acción:') < msg.indexOf('Error:'));
  });

  console.log('\n== operationalNotifier: dedup con TTL ==');
  const { createOperationalNotifier } = require('../src/services/operationalNotifier');
  await testAsync('re-alerta una condicion recurrente despues del TTL', async () => {
    let nowMs = 1000000;
    const cfg = { paths: {}, operationalNotifications: { enabled: true, alertGroupNames: [], alertDedupeTtlMs: 1000 } };
    const n = createOperationalNotifier({ config: cfg, client: null, nowProvider: () => new Date(nowMs) });
    const r1 = await n.notifyWarning('x', 'm', {}, { dedupeKey: 'k' });
    assert.notStrictEqual(r1.reason, 'duplicate-alert');
    const r2 = await n.notifyWarning('x', 'm', {}, { dedupeKey: 'k' });
    assert.strictEqual(r2.reason, 'duplicate-alert'); // dentro del TTL
    nowMs += 2000; // pasa el TTL
    const r3 = await n.notifyWarning('x', 'm', {}, { dedupeKey: 'k' });
    assert.notStrictEqual(r3.reason, 'duplicate-alert'); // re-alerta
  });

  console.log('\n== sequence.findSequenceGaps (auditoria de cierre) ==');
  const { findSequenceGaps } = require('../src/utils/sequence');
  test('detecta huecos, dedup, ignora 0/negativos', () => {
    assert.deepStrictEqual(findSequenceGaps([1, 2, 4, 5, 7]), [3, 6]);
    assert.deepStrictEqual(findSequenceGaps([7, 7, 1, 2]), [3, 4, 5, 6]); // dups (PDF multipagina)
    assert.deepStrictEqual(findSequenceGaps([1, 2, 3]), []);
    assert.deepStrictEqual(findSequenceGaps([]), []);
  });

  console.log('\n== sessionLocks.clearSingletonLocks (R1) ==');
  const { clearSingletonLocks } = require('../src/utils/sessionLocks');
  test('borra Singleton* recursivo, respeta el resto, no rompe si falta', () => {
    const root = path.join(os.tmpdir(), `kalaza-locks-${process.pid}`);
    const sess = path.join(root, 'session-bot', 'Default');
    fs.mkdirSync(sess, { recursive: true });
    // locks que SI se deben borrar (en la raiz de sesion y en una subcarpeta)
    fs.writeFileSync(path.join(root, 'session-bot', 'SingletonLock'), 'x');
    fs.writeFileSync(path.join(root, 'session-bot', 'SingletonCookie'), 'x');
    fs.writeFileSync(path.join(sess, 'SingletonSocket'), 'x');
    // archivos que NO se deben tocar
    fs.writeFileSync(path.join(sess, 'Cookies'), 'x');
    fs.writeFileSync(path.join(root, 'session-bot', 'Default-Singleton'), 'x'); // no empieza con "Singleton"
    const removed = clearSingletonLocks(root);
    assert.strictEqual(removed, 3);
    assert.ok(!fs.existsSync(path.join(root, 'session-bot', 'SingletonLock')));
    assert.ok(!fs.existsSync(path.join(sess, 'SingletonSocket')));
    assert.ok(fs.existsSync(path.join(sess, 'Cookies')));                          // preservado
    assert.ok(fs.existsSync(path.join(root, 'session-bot', 'Default-Singleton'))); // preservado
    assert.strictEqual(clearSingletonLocks(root), 0);                    // idempotente
    assert.strictEqual(clearSingletonLocks(path.join(root, 'nope')), 0); // path inexistente: no rompe
    assert.strictEqual(clearSingletonLocks(undefined), 0);               // sin path: no rompe
    fs.rmSync(root, { recursive: true, force: true });
  });

  console.log('\n== time.parseLocalDateTime (B1 catch-up manual) ==');
  const { parseLocalDateTime } = require('../src/utils/time');
  test('interpreta hora LOCAL Argentina (UTC-3) y da el instante UTC correcto', () => {
    const d = parseLocalDateTime('2026-07-01 14:30', 'America/Argentina/Buenos_Aires');
    assert.ok(d instanceof Date);
    assert.strictEqual(d.toISOString(), '2026-07-01T17:30:00.000Z'); // 14:30 -03:00 = 17:30Z
    // acepta "T" como separador
    assert.strictEqual(
      parseLocalDateTime('2026-07-01T14:30', 'America/Argentina/Buenos_Aires').toISOString(),
      '2026-07-01T17:30:00.000Z'
    );
    // invalidos -> null (cae al modo automatico, no rompe el arranque)
    assert.strictEqual(parseLocalDateTime('no-es-fecha'), null);
    assert.strictEqual(parseLocalDateTime('2026-13-01 14:30'), null); // mes invalido
    assert.strictEqual(parseLocalDateTime('2026-07-01 25:30'), null); // hora invalida
    assert.strictEqual(parseLocalDateTime(''), null);
    assert.strictEqual(parseLocalDateTime(null), null);
  });

  console.log('\n== heartbeatStore (I2/R6 aviso post-caida) ==');
  const { createHeartbeatStore } = require('../src/services/heartbeatStore');
  test('write persiste ts y readLast lo recupera; sin archivo -> null', () => {
    const p = tmp('hb'); cleanup.push(p);
    const hb = createHeartbeatStore({ config: { paths: { heartbeat: p }, heartbeat: {} } });
    assert.strictEqual(hb.readLast(), null);            // aun no existe
    hb.write();
    const ts = hb.readLast();
    assert.ok(typeof ts === 'number' && ts > 0);        // recupera el ts escrito
    assert.ok(Math.abs(Date.now() - ts) < 60000);       // es reciente
  });
  test('readLast no rompe con path ausente o archivo corrupto', () => {
    const hb0 = createHeartbeatStore({ config: { paths: {}, heartbeat: {} } });
    assert.strictEqual(hb0.readLast(), null);
    const p = tmp('hb-bad'); cleanup.push(p);
    fs.writeFileSync(p, 'no-es-json{');
    const hb1 = createHeartbeatStore({ config: { paths: { heartbeat: p }, heartbeat: {} } });
    assert.strictEqual(hb1.readLast(), null);
  });

  console.log('\n== httpsIdentityPatch (R4) ==');
  const { forceIdentityEncoding, applyHttpsIdentityPatch } = require('../src/utils/httpsIdentityPatch');
  test('forceIdentityEncoding fuerza identity (case-insensitive) y agrega si falta', () => {
    assert.deepStrictEqual(forceIdentityEncoding({ 'Accept-Encoding': 'gzip' }), { 'Accept-Encoding': 'identity' });
    assert.deepStrictEqual(forceIdentityEncoding({ 'accept-encoding': 'gzip, deflate' }), { 'accept-encoding': 'identity' });
    assert.deepStrictEqual(forceIdentityEncoding({ 'X-Other': 'v' }), { 'X-Other': 'v', 'Accept-Encoding': 'identity' });
    assert.strictEqual(forceIdentityEncoding(null), null); // no rompe con headers ausente
  });
  test('applyHttpsIdentityPatch es idempotente', () => {
    const https = require('https');
    const before = https.request;
    assert.strictEqual(applyHttpsIdentityPatch(), true);  // primera vez: aplica
    const patched = https.request;
    assert.notStrictEqual(patched, before);               // cambio la referencia
    assert.strictEqual(applyHttpsIdentityPatch(), false); // segunda vez: no-op
    assert.strictEqual(https.request, patched);           // sigue siendo el mismo patch
  });

  for (const p of cleanup) { try { fs.unlinkSync(p); } catch (_) {} }

  console.log(`\n== RESULTADO: ${pass} OK, ${fail} FAIL ==`);
  process.exit(fail === 0 ? 0 : 1);
})();
