'use strict';

/**
 * scripts/recoverWindow.js
 *
 * Recuperación one-shot de comprobantes perdidos en ventana de outage.
 * Requiere que el bot esté PAUSADO en Railway (Custom Start Command = "tail -f /dev/null").
 *
 * Modos:
 *   --dry-run          Lee historial real, reporta candidatos. Sin escrituras. Una sola pasada.
 *   --run              Descarga media y sube a Drive. Barridos de convergencia (máx 5).
 *   --run --no-sweep   Una sola pasada (micro-run final con bot vivo).
 *
 * fetchMessages({limit:N}) trae los N MÁS RECIENTES sin filtrar por fecha ni tipo.
 * El filtro por ventana UTC y por media se aplica en memoria post-fetch.
 * Si fetchedCount >= limit y el más viejo es posterior al inicio de ventana →
 * riesgo de truncamiento (se reporta).
 *
 * Convergencia: el dedup es monotónico — cada barrido skipea lo ya procesado
 * (processedStore.has) y procesa solo mensajes nuevos que llegaron durante el
 * barrido anterior. Converge cuando ningún mensaje nuevo cae en la ventana.
 */

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..');
process.chdir(PROJECT_ROOT);

const { loadConfig }                            = require('../src/config/env');
const { createWhatsappClient }                  = require('../src/services/whatsappClient');
const { createDriveService }                    = require('../src/services/driveService');
const { createProcessedStore, buildMessageKey } = require('../src/services/processedStore');
const {
  loadBlockedSenders,
  isSenderBlocked,
  getDefaultBlockedSendersPath,
} = require('../src/services/blockedSenders');
const { ALLOWED_MIME, extFromMime } = require('../src/utils/mime');
const {
  convertPdfFirstPageToJpg,
  getPdfPageCount,
} = require('../src/utils/pdfConverter');
const { maskSensitiveText } = require('../src/utils/mask');

// ─── Constantes ───────────────────────────────────────────────────────────────

const DEFAULT_START_UTC    = '2026-06-13T00:07:11Z';
const READY_TIMEOUT_MS     = 180_000;
const MAX_SWEEPS           = 5;
const BETWEEN_SWEEPS_MS    = 3_000;
const PROGRESS_INTERVAL_MS = 60_000;
const TZ_LOCAL             = 'America/Argentina/Buenos_Aires';

// ─── Formateo de tiempo local ─────────────────────────────────────────────────

function formatLocalShort(date) {
  // "12/06 18:15" en ART
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ_LOCAL,
      day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    return `${v.day}/${v.month} ${v.hour}:${v.minute}`;
  } catch (_) {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

function formatLocalLong(date) {
  // "2026-06-12 21:07:11 (ART)"
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ_LOCAL,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    return `${v.year}-${v.month}-${v.day} ${v.hour}:${v.minute}:${v.second} (ART)`;
  } catch (_) {
    return date.toISOString();
  }
}

function formatElapsed(startMs, endMs) {
  const total = Math.max(0, Math.floor((endMs - startMs) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ─── Helpers de logging seguro ────────────────────────────────────────────────

function shortKey(key) {
  if (!key || key.length < 8) return key || 'no-key';
  return key.slice(0, 8);
}

function senderHashShort(senderId) {
  return crypto.createHash('sha256').update(String(senderId || '')).digest('hex').slice(0, 8);
}

function getMsgMimeHint(msg) {
  const raw = msg && msg._data && msg._data.mimetype;
  if (!raw) return '(media)';
  return String(raw).split(';')[0].trim();
}

function mimeExt(mime) {
  return extFromMime(mime, '') || mime || 'media';
}

function log(level, tag, message) {
  const ts      = new Date().toISOString();
  const safeTag = maskSensitiveText(String(tag || ''), 60);
  const safeMsg = maskSensitiveText(String(message || ''), 240);
  console.log(`[${ts}] [${level.padEnd(5)}] [${safeTag}] ${safeMsg}`);
}

// ─── CLI parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Uso: node scripts/recoverWindow.js <modo> [opciones]

Modos (obligatorio uno):
  --dry-run             Lee historial WA y reporta candidatos. No escribe nada.
                        Siempre hace una sola pasada (sin convergencia).
  --run                 Descarga media y sube a Drive.
                        Por default ejecuta barridos de convergencia (máx ${MAX_SWEEPS}).
  --run --no-sweep      Una sola pasada. Para micro-run final con el bot ya vivo
                        (el bot cubre mensajes nuevos, no queremos perseguir tráfico).

Opciones:
  --start-utc ISO8601   Override inicio ventana (default: ${DEFAULT_START_UTC})
  --end-utc   ISO8601   Override fin ventana. Si no se pasa, el fin se re-evalúa
                        como "ahora" al inicio de cada barrido, capturando mensajes
                        que llegan mientras el script corre con el bot pausado.
  --group "Nombre"      Limitar a un solo grupo (nombre exacto del config.json).
  --limit-per-group N   Tope de mensajes por fetchMessages (default: 1500).
                        fetchMessages({limit:N}) trae los N más recientes de cualquier
                        tipo. El filtro de ventana y media se aplica en memoria.
                        Si fetchedCount >= N y el más viejo es posterior al inicio
                        de ventana, hay riesgo de truncamiento (se reporta).
  --no-sweep            (solo con --run) una sola pasada sin convergencia.
  --help                Muestra este mensaje

Ejemplos desde SSH en Railway:
  node scripts/recoverWindow.js --dry-run
  node scripts/recoverWindow.js --dry-run --group "BOT TEST"
  node scripts/recoverWindow.js --run --group "BOT TEST"
  node scripts/recoverWindow.js --run
  node scripts/recoverWindow.js --run --no-sweep
  node scripts/recoverWindow.js --run --group "Transfer BBZ APPLE" --limit-per-group 6000
`);
    process.exit(0);
  }

  const isDryRun = args.includes('--dry-run');
  const isRun    = args.includes('--run');
  const noSweep  = args.includes('--no-sweep');

  if (!isDryRun && !isRun) {
    console.error('[ERROR] Debés especificar --dry-run o --run. Usá --help para más información.');
    process.exit(2);
  }
  if (isDryRun && isRun) {
    console.error('[ERROR] No podés combinar --dry-run y --run.');
    process.exit(2);
  }
  if (noSweep && isDryRun) {
    console.error('[ERROR] --no-sweep solo aplica con --run (dry-run siempre es single-pass).');
    process.exit(2);
  }

  function getFlag(name) {
    const idx = args.indexOf(name);
    return (idx !== -1 && idx + 1 < args.length) ? args[idx + 1] : undefined;
  }

  const startUtcStr = getFlag('--start-utc') || DEFAULT_START_UTC;
  const startMs     = Date.parse(startUtcStr);
  if (!Number.isFinite(startMs)) {
    console.error('[ERROR] --start-utc no es una fecha ISO 8601 válida.');
    process.exit(2);
  }

  const endUtcStr      = getFlag('--end-utc');
  const endUtcExplicit = Boolean(endUtcStr);
  const endMsFixed     = endUtcExplicit ? Date.parse(endUtcStr) : null;

  if (endUtcExplicit && !Number.isFinite(endMsFixed)) {
    console.error('[ERROR] --end-utc no es una fecha ISO 8601 válida.');
    process.exit(2);
  }
  if (endUtcExplicit && startMs >= endMsFixed) {
    console.error('[ERROR] --start-utc debe ser anterior a --end-utc.');
    process.exit(2);
  }

  const groupFilter   = getFlag('--group') || null;
  const limitStr      = getFlag('--limit-per-group');
  let limitPerGroup   = 1500;
  if (limitStr !== undefined) {
    const parsed = parseInt(limitStr, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      limitPerGroup = parsed;
    } else {
      console.warn(`[WARN] --limit-per-group inválido '${limitStr}', usando default 1500`);
    }
  }

  return {
    dryRun: isDryRun,
    noSweep,
    singlePass: isDryRun || noSweep,
    startMs,
    startUtc: startUtcStr,
    endUtcExplicit,
    endMsFixed,
    groupFilter,
    limitPerGroup,
  };
}

// ─── Semáforo PDF ─────────────────────────────────────────────────────────────

function buildPdfSemaphore() {
  try {
    const pLimit = require('p-limit');
    const limiter = pLimit(2);
    log('INFO', 'INIT', 'Semáforo PDF: p-limit N=2');
    return (fn) => limiter(fn);
  } catch (_) {
    log('WARN', 'INIT', 'p-limit no disponible — sin semáforo externo (procesamiento ya es serial)');
    return (fn) => fn();
  }
}

// ─── Helpers menores ──────────────────────────────────────────────────────────

function randomDelay(minMs, maxMs) {
  const ms = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeGroupStats(groupName, tag) {
  return {
    groupName, tag,
    fetched: 0, inWindow: 0, hasMedia: 0, validMime: 0,
    skippedBlacklist: 0, skippedAlreadyProcessed: 0,
    uploadedOk: 0, failed: 0,
    errors: [],
  };
}

// ─── Inicializar cliente WA con timeout ───────────────────────────────────────

function initWhatsappClient(config) {
  return new Promise((resolve, reject) => {
    const client = createWhatsappClient(config);

    function rejectWithCleanup(err) {
      client.destroy().catch(() => {}).finally(() => reject(err));
    }

    const timer = setTimeout(() => {
      rejectWithCleanup(new Error(`ready-timeout: cliente WA no alcanzó ready en ${READY_TIMEOUT_MS / 1000}s`));
    }, READY_TIMEOUT_MS);

    client.on('qr', () => {
      clearTimeout(timer);
      rejectWithCleanup(new Error(
        'qr-generated: sesión no autenticada. ' +
        'Verificá que /data/.wwebjs_auth existe y el bot estaba autenticado antes de pausarlo.'
      ));
    });

    client.on('auth_failure', (msg) => {
      clearTimeout(timer);
      rejectWithCleanup(new Error(`auth_failure: ${maskSensitiveText(String(msg || ''))}`));
    });

    client.on('ready', () => {
      clearTimeout(timer);
      log('INFO', 'WA', 'Cliente listo');
      resolve(client);
    });

    client.initialize();
  });
}

// ─── Procesamiento de un único mensaje candidato ─────────────────────────────
//
// Devuelve { status, mime?, filename?, pages?, baseId?, reason?, uploadedPages?, failedPages? }
// status: 'uploaded_ok' | 'partial' | 'skipped_blacklist' | 'skipped_already_processed'
//         'skipped_mime' | 'failed'

async function processMessage(msg, chat, tag, { driveService, processedStore, blockedNumbers, exemptGroups, pdfSemaphore }) {
  const senderId   = msg.author || msg.from || 'unknown';
  const messageKey = buildMessageKey(msg, chat);

  if (isSenderBlocked(senderId, blockedNumbers) && !exemptGroups.includes(chat.name)) {
    return { status: 'skipped_blacklist' };
  }

  if (messageKey && processedStore.has(messageKey)) {
    return { status: 'skipped_already_processed' };
  }

  const originalDate = new Date((msg.timestamp || 0) * 1000);

  let media;
  try {
    media = await msg.downloadMedia();
  } catch (err) {
    return { status: 'failed', mime: '(sin descarga)', reason: `download_error: ${maskSensitiveText(err && err.message)}` };
  }

  if (!media || !media.data) {
    return { status: 'failed', mime: '(sin descarga)', reason: 'media_data_empty' };
  }

  const mimeType = media.mimetype || '';
  if (!ALLOWED_MIME.has(mimeType)) {
    return { status: 'skipped_mime', mime: mimeType, reason: `mime_not_allowed:${mimeType}` };
  }

  const buffer = Buffer.from(media.data, 'base64');
  const isPdf  = mimeType === 'application/pdf';

  if (isPdf) {
    let pageCount = 1;
    try { pageCount = await pdfSemaphore(() => getPdfPageCount(buffer)); }
    catch (_) { pageCount = 1; }

    if (pageCount > 1) {
      try {
        const result = await driveService.uploadPdfPagesWithRetry(buffer, 'image/jpeg', {
          groupName: chat.name, date: originalDate,
          media: { ...media, mimetype: 'image/jpeg' }, tag,
        });
        if (result.failed.length === 0) {
          if (messageKey) processedStore.markProcessed(messageKey, { status: 'uploaded_recovery' });
          return { status: 'uploaded_ok', mime: 'application/pdf', pages: result.pageCount, baseId: result.baseId };
        }
        // Parcial: no marcamos processed → reintentable en siguiente barrido
        return {
          status: 'partial', mime: 'application/pdf',
          uploadedPages: result.uploaded.length,
          failedPages:   result.failed.length,
          reason: `partial_upload: ${result.failed.length} págs fallaron`,
        };
      } catch (err) {
        return { status: 'failed', mime: 'application/pdf', reason: `pdf_multipage: ${maskSensitiveText(err && err.message)}` };
      }
    }

    // PDF 1 página → JPEG
    let jpgBuffer;
    try {
      jpgBuffer = await pdfSemaphore(() => convertPdfFirstPageToJpg(buffer));
    } catch (err) {
      return { status: 'failed', mime: 'application/pdf', reason: `pdf_convert: ${maskSensitiveText(err && err.message)}` };
    }

    try {
      const result = await driveService.uploadWithRetry(null, 'image/jpeg', jpgBuffer, {
        groupName: chat.name, date: originalDate,
        media: { ...media, mimetype: 'image/jpeg' },
        sequentialFilename: true, tag,
      });
      if (messageKey) processedStore.markProcessed(messageKey, { status: 'uploaded_recovery' });
      return { status: 'uploaded_ok', mime: 'application/pdf', filename: result.filename };
    } catch (err) {
      return { status: 'failed', mime: 'application/pdf', reason: `pdf_upload: ${maskSensitiveText(err && err.message)}` };
    }
  }

  // Imagen (jpeg, png, webp, gif)
  try {
    const result = await driveService.uploadWithRetry(null, mimeType, buffer, {
      groupName: chat.name, date: originalDate,
      media, sequentialFilename: true, tag,
    });
    if (messageKey) processedStore.markProcessed(messageKey, { status: 'uploaded_recovery' });
    return { status: 'uploaded_ok', mime: mimeType, filename: result.filename };
  } catch (err) {
    return { status: 'failed', mime: mimeType, reason: `img_upload: ${maskSensitiveText(err && err.message)}` };
  }
}

// ─── Log de ventana efectiva ─────────────────────────────────────────────────

function logWindowInfo(args) {
  const startDate  = new Date(args.startMs);
  const endDisplay = args.endUtcExplicit ? new Date(args.endMsFixed) : new Date();
  const endNote    = args.endUtcExplicit ? '' : '  ← re-evaluado al inicio de cada barrido';

  let modeDesc;
  if (args.dryRun)       modeDesc = 'dry-run (una sola pasada, sin escrituras)';
  else if (args.noSweep) modeDesc = 'run single-pass (--no-sweep)';
  else                   modeDesc = `run con convergencia (máx ${MAX_SWEEPS} barridos)`;

  console.log('');
  console.log('[recoverWindow] Ventana de recuperación:');
  console.log(`  Inicio: ${startDate.toISOString()}  (${formatLocalLong(startDate)})`);
  console.log(`  Fin:    ${endDisplay.toISOString()}  (${formatLocalLong(endDisplay)})${endNote}`);
  console.log(`  Modo:   ${modeDesc}`);
  if (!args.dryRun && !args.noSweep) {
    console.log('  Nota:   el fin se re-evalúa al inicio de cada barrido para capturar');
    console.log('          mensajes que llegan mientras el bot está pausado.');
  }
  console.log('');
}

// ─── Guardar reporte JSON ─────────────────────────────────────────────────────

function saveReportJson({ mode, aborted, args, startedAt, finishedAt,
  sweepsExecuted, converged,
  totalUploaded, totalFailed, totalSkippedDedup, totalSkippedBlacklist, totalSkippedMime,
  groupResults, truncatedGroups }) {

  const fileTs     = startedAt.replace(/[:.]/g, '-');
  const reportPath = path.join(__dirname, `recovery-report-${fileTs}.json`);

  const report = {
    mode, aborted,
    window: {
      startUtc: args.startUtc,
      endUtc:   args.endUtcExplicit ? new Date(args.endMsFixed).toISOString() : '(re-evaluated per sweep)',
    },
    groupFilter:   args.groupFilter || null,
    limitPerGroup: args.limitPerGroup,
    startedAt, finishedAt,
    sweepsExecuted, converged,
    totals: {
      uploaded: totalUploaded, failed: totalFailed,
      skippedDedup: totalSkippedDedup,
      skippedBlacklist: totalSkippedBlacklist,
      skippedMime: totalSkippedMime,
    },
    truncatedGroups,
    groups: groupResults,
  };

  try {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    log('INFO', 'REPORT', `JSON guardado: ${path.basename(reportPath)}`);
  } catch (err) {
    log('ERROR', 'REPORT', `No se pudo guardar JSON: ${maskSensitiveText(err && err.message)}`);
  }
}

// ─── Guardar reporte TXT ──────────────────────────────────────────────────────

function saveReportTxt({ mode, aborted, args, startedAtMs, finishedAtMs,
  sweepsExecuted, converged,
  totalUploaded, totalFailed, totalSkippedDedup, totalSkippedBlacklist, totalSkippedMime,
  failedMessages, truncatedGroups }) {

  const startedAt = new Date(startedAtMs);
  const fileTs    = startedAt.toISOString().replace(/[:.]/g, '-');
  const txtPath   = path.join(__dirname, `recovery-failures-${fileTs}.txt`);
  const elapsed   = formatElapsed(startedAtMs, finishedAtMs);
  const L         = [];
  const DIV       = '═'.repeat(60);
  const sub       = '─'.repeat(60);

  L.push(DIV);
  L.push('INFORME DE RECUPERACIÓN — recoverWindow');
  L.push(DIV);

  if (aborted) L.push('*** EJECUCIÓN ABORTADA POR USUARIO ***');

  let modeDesc;
  if (mode === 'dry-run')    modeDesc = 'dry-run (sin escrituras, una sola pasada)';
  else if (args.noSweep)     modeDesc = 'run single-pass (--no-sweep)';
  else                       modeDesc = `run con convergencia (máx ${MAX_SWEEPS} barridos)`;

  L.push(`Modo:         ${modeDesc}`);
  L.push(`Ventana:      ${args.startUtc} → ${args.endUtcExplicit ? new Date(args.endMsFixed).toISOString() : '(dinámico)'}`);
  L.push(`Iniciado:     ${formatLocalLong(startedAt)}`);
  L.push(`Duración:     ${elapsed}`);

  if (mode !== 'dry-run') {
    const sweepNote = converged
      ? `convergió en barrido ${sweepsExecuted}`
      : `no convergió (alcanzó máx ${MAX_SWEEPS})`;
    L.push(`Barridos:     ${sweepsExecuted}/${MAX_SWEEPS} — ${sweepNote}`);
  }
  if (args.groupFilter) L.push(`Filtro grupo: ${args.groupFilter}`);
  L.push(`Límite/grupo: ${args.limitPerGroup}`);
  L.push('');

  L.push(sub);
  L.push('TOTALES');
  L.push(sub);
  L.push(`Subidos OK:         ${String(totalUploaded).padStart(6)}`);
  L.push(`Fallidos:           ${String(totalFailed).padStart(6)}`);
  L.push(`Skip dedup:         ${String(totalSkippedDedup).padStart(6)}`);
  L.push(`Skip blacklist:     ${String(totalSkippedBlacklist).padStart(6)}`);
  L.push(`Skip MIME inválido: ${String(totalSkippedMime).padStart(6)}`);
  L.push('');

  if (failedMessages.length > 0) {
    L.push(sub);
    L.push(`MENSAJES FALLIDOS (${failedMessages.length})`);
    L.push(sub);
    failedMessages.forEach((f, i) => {
      L.push(`${i + 1}. ${f.groupName} [${f.tag}]`);
      L.push(`   Timestamp:  ${f.timestampLocal}`);
      L.push(`   MIME:       ${f.mime}`);
      L.push(`   MsgID:      ${f.messageKeyShort}`);
      L.push(`   Sender:     ${f.senderHash}`);
      L.push(`   Razón:      ${f.reason}`);
      L.push(`   Intentos:   ${f.attempts}`);
      if (f.isPartial) {
        L.push('   *** INCOMPLETO — algunas páginas pueden haber subido, requiere revisión manual ***');
      }
      L.push('');
    });

    L.push(sub);
    L.push('GRUPOS CON FALLOS (resumen)');
    L.push(sub);
    const byGroup = {};
    for (const f of failedMessages) byGroup[f.groupName] = (byGroup[f.groupName] || 0) + 1;
    for (const [g, count] of Object.entries(byGroup)) {
      L.push(`  ${g}: ${count} fallido${count !== 1 ? 's' : ''}`);
    }
    L.push('');
  }

  if (truncatedGroups.length > 0) {
    L.push(sub);
    L.push(`⚠  GRUPOS CON POSIBLE TRUNCAMIENTO (${truncatedGroups.length})`);
    L.push(sub);
    truncatedGroups.forEach((t, i) => {
      const suggested = t.fetchedCount * 4;
      L.push(`${i + 1}. ${t.groupName} [${t.tag}]`);
      L.push(`   Msgs traídos: ${t.fetchedCount}/${t.limit} (límite alcanzado)`);
      L.push(`   Más viejo:    ${t.oldestFetchedLocal} (posterior al inicio de ventana)`);
      L.push(`   Re-run:`);
      L.push(`     node scripts/recoverWindow.js --run --group "${t.groupName}" --limit-per-group ${suggested}`);
      L.push('');
    });
  }

  L.push(sub);
  L.push('PRÓXIMOS PASOS SUGERIDOS');
  L.push(sub);
  if (failedMessages.length > 0) {
    L.push('[ ] Revisar mensajes fallidos y reintentar con --group + --limit-per-group mayor');
  }
  if (truncatedGroups.length > 0) {
    L.push('[ ] Correr comandos de re-run sugeridos para grupos con truncamiento');
  }
  if (mode !== 'dry-run' && !args.noSweep) {
    L.push('[ ] Micro-run final con el bot vivo (una sola pasada):');
    L.push('      node scripts/recoverWindow.js --run --no-sweep');
  }
  L.push('[ ] Verificar archivos subidos en Drive → carpeta PULL TRANSFERENCIAS/');
  L.push('[ ] Reactivar bot (vaciar Custom Start Command en Railway → Redeploy)');

  if (failedMessages.length === 0 && truncatedGroups.length === 0) {
    L.push('');
    L.push('✓ Sin fallidos ni truncamientos. Recuperación completada con éxito.');
  }

  L.push('');
  L.push(DIV);

  try {
    fs.writeFileSync(txtPath, L.join('\n'), 'utf8');
    log('INFO', 'REPORT', `TXT guardado: ${path.basename(txtPath)}`);
  } catch (err) {
    log('ERROR', 'REPORT', `No se pudo guardar TXT: ${maskSensitiveText(err && err.message)}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

let activeClient = null; // referencia al client WA para destruir en catch fatal

async function main() {
  const args        = parseArgs(process.argv);
  const startedAtMs = Date.now();
  const startedAt   = new Date(startedAtMs).toISOString();

  log('INFO', 'RECOVERY', '=== INICIO RECOVERY WINDOW ===');
  logWindowInfo(args);

  const config         = loadConfig();
  const processedStore = createProcessedStore(config);
  const blockedNumbers = loadBlockedSenders(config.paths.blockedSenders || getDefaultBlockedSendersPath());
  const exemptGroups   = config.blacklistExemptGroups || [];

  let driveService = null;
  if (!args.dryRun) {
    driveService = createDriveService(config);
    log('INFO', 'INIT', 'Drive service inicializado');
  }

  const pdfSemaphore = buildPdfSemaphore();

  const allGroups = Object.entries(config.whatsapp.groups || {});
  if (allGroups.length === 0) {
    log('ERROR', 'INIT', 'No hay grupos en config.whatsapp.groups. Verificá config.json y env vars.');
    process.exit(2);
  }

  const groups = args.groupFilter
    ? allGroups.filter(([name]) => name === args.groupFilter)
    : allGroups;

  if (groups.length === 0) {
    log('ERROR', 'INIT', `Grupo "${args.groupFilter}" no encontrado en config.json`);
    process.exit(2);
  }

  log('INFO', 'INIT', `Grupos a procesar: ${groups.length}`);

  // ─── Pre-flight ───────────────────────────────────────────────────────────

  {
    const blockedSendersPath = path.resolve(config.paths.blockedSenders || getDefaultBlockedSendersPath());

    let storeEntryCount = -1;
    try {
      if (fs.existsSync(processedStore.path)) {
        const raw = JSON.parse(fs.readFileSync(processedStore.path, 'utf8'));
        const entries = raw && typeof raw.entries === 'object' ? raw.entries : {};
        storeEntryCount = Object.keys(entries).length;
      } else {
        storeEntryCount = 0;
      }
    } catch (_) {
      storeEntryCount = -1;
    }

    const rawFolderId    = (config.google && config.google.driveFolderId) || '';
    const maskedFolderId = rawFolderId.length >= 10
      ? `${rawFolderId.slice(0, 4)}...${rawFolderId.slice(-4)}`
      : (rawFolderId || '(no configurado)');

    let modeLabel;
    if (args.dryRun)       modeLabel = 'dry-run (sin escrituras, una sola pasada)';
    else if (args.noSweep) modeLabel = 'run single-pass (--no-sweep)';
    else                   modeLabel = `run con convergencia (máx ${MAX_SWEEPS} barridos)`;

    console.log('');
    console.log('══════════ PRE-FLIGHT (confirmá antes de seguir) ══════════');
    console.log(`processedStore path   : ${processedStore.path}`);
    console.log(`processedStore entries: ${storeEntryCount >= 0 ? storeEntryCount : '(error leyendo)'}`);
    console.log(`blockedSenders path   : ${blockedSendersPath}`);
    console.log(`Drive folder ID       : ${maskedFolderId}`);
    console.log(`Grupos en config      : ${groups.length}`);
    console.log(`Modo                  : ${modeLabel}`);
    console.log('══════════════════════════════════════════════════════════');
    console.log('');

    if (!args.dryRun) {
      console.log('  ⚠  Revisá el PRE-FLIGHT de arriba. Si la ruta del store o las entradas no');
      console.log('     son las de producción, abortá con Ctrl+C AHORA. Continuando en 10s...');
      for (let i = 10; i > 0; i--) {
        process.stdout.write(`\r     ${i}s...`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      process.stdout.write('\r     Arrancando...    \n');
      console.log('');
    }
  }

  // ─── Estado global (compartido entre barridos) ────────────────────────────

  let abortRequested       = false;
  let sweepsExecuted       = 0;
  let converged            = false;
  let totalUploaded        = 0;
  let totalFailed          = 0;
  let totalSkippedDedup    = 0;
  let totalSkippedBlacklist = 0;
  let totalSkippedMime     = 0;

  const groupStatsMap       = new Map(); // groupName → stats (acumulado entre barridos)
  const truncatedGroupNames = new Set();
  const truncatedGroups     = [];
  const failedMessageMap    = new Map(); // messageKey → entry (dedup de failures)
  const failedThisRun       = new Set(); // failKeys fallados en esta corrida (no reintentar en barridos siguientes)

  process.on('SIGINT', () => {
    if (!abortRequested) {
      abortRequested = true;
      log('WARN', 'RECOVERY', 'SIGINT recibido — finalizando grupo actual y guardando reporte parcial...');
    }
  });

  // ─── Inicializar cliente WA ────────────────────────────────────────────────

  log('INFO', 'WA', `Inicializando cliente (timeout ${READY_TIMEOUT_MS / 1000}s)...`);
  let client;
  try {
    client = await initWhatsappClient(config);
    activeClient = client;
  } catch (err) {
    log('ERROR', 'WA', `Fallo al inicializar: ${maskSensitiveText(err && err.message)}`);
    process.exit(2);
  }

  log('INFO', 'WA', 'Cargando lista de chats...');
  let allChats;
  try {
    allChats = await client.getChats();
  } catch (err) {
    log('ERROR', 'WA', `getChats() falló: ${maskSensitiveText(err && err.message)}`);
    await client.destroy().catch(() => {});
    process.exit(2);
  }

  const chatsByName = new Map(
    allChats.filter((c) => c.isGroup).map((c) => [c.name, c])
  );
  log('INFO', 'WA', `Grupos disponibles en sesión activa: ${chatsByName.size}`);

  // ─── Progress ticker ──────────────────────────────────────────────────────

  const progressTimer = setInterval(() => {
    const elapsed = formatElapsed(startedAtMs, Date.now());
    log('INFO', 'PROGRESS',
      `elapsed=${elapsed} | barrido=${sweepsExecuted}/${args.singlePass ? 1 : MAX_SWEEPS} ` +
      `| ok=${totalUploaded} fail=${totalFailed} ` +
      `skip-dedup=${totalSkippedDedup} skip-bl=${totalSkippedBlacklist} skip-mime=${totalSkippedMime}`
    );
  }, PROGRESS_INTERVAL_MS);

  // ─── Loop de barridos ─────────────────────────────────────────────────────
  //
  // El dedup es monotónico: en barrido N, processedStore.has() devuelve true
  // para todo lo que subió en barridos anteriores → se skipea. Solo se procesan
  // mensajes recién llegados (timestamp posterior al inicio del barrido N-1).
  // Cuando ningún mensaje nuevo cae en la ventana → sweepNewCount === 0 → convergió.

  const maxSweeps = args.singlePass ? 1 : MAX_SWEEPS;

  for (let sweepIdx = 0; sweepIdx < maxSweeps && !abortRequested; sweepIdx++) {
    sweepsExecuted++;

    // Re-evaluar fin de ventana: si no fue explícito, tomar "ahora"
    const sweepEndMs = args.endUtcExplicit ? args.endMsFixed : Date.now();

    if (!args.singlePass) {
      log('INFO', 'SWEEP', `=== Barrido ${sweepsExecuted}/${MAX_SWEEPS} | fin=${new Date(sweepEndMs).toISOString()} ===`);
    }

    let sweepNewCount = 0;

    // ─── Iteración de grupos ──────────────────────────────────────────────

    for (let gi = 0; gi < groups.length; gi++) {
      if (abortRequested) break;

      const [groupName, tag] = groups[gi];

      if (!groupStatsMap.has(groupName)) {
        groupStatsMap.set(groupName, makeGroupStats(groupName, tag));
      }
      const stats = groupStatsMap.get(groupName);

      const chat = chatsByName.get(groupName);
      if (!chat) {
        log('WARN', groupName, 'Grupo no encontrado en chats activos (bot no es miembro o nombre cambió)');
        if (sweepIdx === 0) stats.errors.push({ type: 'group_not_found' });
        continue;
      }

      // fetchMessages
      let messages = [];
      try {
        messages = await chat.fetchMessages({ limit: args.limitPerGroup });
      } catch (err) {
        log('WARN', groupName, `fetchMessages falló: ${maskSensitiveText(err && err.message)}`);
        stats.errors.push({ type: 'fetch_failed', sweep: sweepsExecuted, reason: maskSensitiveText(err && err.message) });
        continue;
      }

      const fetchedCount = messages.length;
      stats.fetched += fetchedCount;

      // ── Detección de truncamiento ────────────────────────────────────────
      if (fetchedCount >= args.limitPerGroup && fetchedCount > 0 && !truncatedGroupNames.has(groupName)) {
        const oldestTsMs = messages.reduce((min, m) => Math.min(min, (m.timestamp || 0) * 1000), Infinity);
        if (Number.isFinite(oldestTsMs) && oldestTsMs > args.startMs) {
          truncatedGroupNames.add(groupName);
          const oldestLocal = formatLocalLong(new Date(oldestTsMs));
          truncatedGroups.push({ groupName, tag, fetchedCount, oldestFetchedLocal: oldestLocal, limit: args.limitPerGroup });
          log('WARN', groupName,
            `[TRUNCADO] ${tag} | trajo ${fetchedCount} msgs | más viejo: ${oldestLocal} | riesgo de comprobantes sin recuperar`
          );
        }
      }

      // ── Filtrar por ventana + hasMedia ───────────────────────────────────
      const candidates = [];
      let inWindowThisFetch = 0;
      for (const msg of messages) {
        const tsMs = (msg.timestamp || 0) * 1000;
        if (tsMs >= args.startMs && tsMs <= sweepEndMs) {
          inWindowThisFetch++;
          stats.inWindow++;
          if (msg.hasMedia) {
            stats.hasMedia++;
            candidates.push(msg);
          }
        }
      }

      log('INFO', groupName,
        `[GROUP ${gi + 1}/${groups.length}] "${groupName}" → tag=${tag} | ` +
        `fetched=${fetchedCount} | en ventana=${inWindowThisFetch} | con media=${candidates.length}`
      );

      // ── Procesamiento serial ─────────────────────────────────────────────

      for (const msg of candidates) {
        if (abortRequested) break;

        const originalDate = new Date((msg.timestamp || 0) * 1000);
        const localShort   = formatLocalShort(originalDate);
        const senderId     = msg.author || msg.from || 'unknown';
        const senderHash   = senderHashShort(senderId);
        const messageKey   = buildMessageKey(msg, chat);
        const failKey      = messageKey || `nokey-${groupName}-${originalDate.toISOString()}`;
        const mimeHint     = getMsgMimeHint(msg);

        if (args.dryRun) {
          const isBlocked = isSenderBlocked(senderId, blockedNumbers) && !exemptGroups.includes(groupName);
          if (isBlocked) {
            stats.skippedBlacklist++;
            totalSkippedBlacklist++;
            log('INFO', groupName, `[DRY-SKIP-BLACKLIST] ${tag} | ${localShort} | (sin descarga) | senderHash=${senderHash}`);
            continue;
          }
          if (messageKey && processedStore.has(messageKey)) {
            stats.skippedAlreadyProcessed++;
            totalSkippedDedup++;
            log('INFO', groupName, `[DRY-SKIP-DEDUP] ${tag} | ${localShort} | (sin descarga) | ya procesado`);
            continue;
          }
          stats.validMime++;
          stats.uploadedOk++;
          totalUploaded++;
          log('INFO', groupName, `[DRY-OK] ${tag} | ${localShort} | ${mimeHint} | candidato`);
          continue;
        }

        // ── MODO RUN ─────────────────────────────────────────────────────

        if (failedThisRun.has(failKey)) {
          log('INFO', groupName,
            `[SKIP-FAILED-EARLIER] ${tag} | ${localShort} | ${mimeHint} | msgId=${shortKey(messageKey)} | falló en barrido previo`
          );
          continue;
        }

        let result;
        try {
          result = await processMessage(msg, chat, tag, {
            driveService, processedStore, blockedNumbers, exemptGroups, pdfSemaphore,
          });
        } catch (err) {
          result = { status: 'failed', mime: '(unexpected)', reason: `unexpected: ${maskSensitiveText(err && err.message)}` };
        }

        const resultMime = result.mime || mimeHint;
        const resultExt  = mimeExt(resultMime);

        switch (result.status) {
          case 'uploaded_ok': {
            stats.validMime++;
            stats.uploadedOk++;
            totalUploaded++;
            sweepNewCount++;
            const fileDesc = result.filename
              ? result.filename
              : `PDF ${result.pages}pags baseId=${result.baseId}`;
            log('INFO', groupName, `[OK] ${tag} | ${localShort} | ${resultExt} | ${fileDesc}`);
            break;
          }

          case 'partial': {
            stats.validMime++;
            sweepNewCount++;
            failedThisRun.add(failKey);
            const existing = failedMessageMap.get(failKey);
            if (!existing) {
              stats.failed++;
              totalFailed++;
              failedMessageMap.set(failKey, {
                groupName, tag,
                timestampLocal: localShort,
                mime: resultMime,
                messageKeyShort: shortKey(messageKey),
                senderHash,
                reason: result.reason,
                isPartial: true,
                attempts: 1,
              });
            } else {
              existing.attempts++;
              existing.reason = result.reason;
            }
            log('WARN', groupName, `[PARTIAL] ${tag} | ${localShort} | ${resultExt} | ok=${result.uploadedPages} fail=${result.failedPages}`);
            break;
          }

          case 'skipped_blacklist': {
            stats.skippedBlacklist++;
            totalSkippedBlacklist++;
            log('INFO', groupName, `[SKIP-BLACKLIST] ${tag} | ${localShort} | ${resultExt} | senderHash=${senderHash}`);
            break;
          }

          case 'skipped_already_processed': {
            stats.skippedAlreadyProcessed++;
            totalSkippedDedup++;
            log('INFO', groupName, `[SKIP-DEDUP] ${tag} | ${localShort} | ${resultExt} | ya procesado`);
            break;
          }

          case 'skipped_mime': {
            totalSkippedMime++;
            log('INFO', groupName, `[SKIP-MIME] ${tag} | ${localShort} | ${resultExt} | ${result.reason}`);
            break;
          }

          case 'failed': {
            sweepNewCount++;
            failedThisRun.add(failKey);
            const exF = failedMessageMap.get(failKey);
            if (!exF) {
              stats.failed++;
              totalFailed++;
              failedMessageMap.set(failKey, {
                groupName, tag,
                timestampLocal: localShort,
                mime: resultMime,
                messageKeyShort: shortKey(messageKey),
                senderHash,
                reason: result.reason,
                isPartial: false,
                attempts: 1,
              });
            } else {
              exF.attempts++;
              exF.reason = result.reason;
            }
            log('ERROR', groupName,
              `[FAIL] ${tag} | ${localShort} | ${resultExt} | msgId=${shortKey(messageKey)} | reason=${result.reason}`
            );
            break;
          }
        }
      }

      log('INFO', groupName,
        `Resumen grupo: ok=${stats.uploadedOk} fail=${stats.failed} ` +
        `skip-dedup=${stats.skippedAlreadyProcessed} skip-bl=${stats.skippedBlacklist}`
      );

      // Delay entre grupos, excepto el último
      if (gi < groups.length - 1 && !abortRequested) {
        await randomDelay(5000, 10000);
      }
    }

    // ── Evaluación de convergencia ────────────────────────────────────────
    if (!args.singlePass && !abortRequested) {
      if (sweepNewCount === 0) {
        converged = true;
        log('INFO', 'SWEEP', `Barrido ${sweepsExecuted}: 0 mensajes nuevos → CONVERGIÓ`);
        break;
      }
      if (sweepsExecuted < maxSweeps) {
        log('INFO', 'SWEEP',
          `Barrido ${sweepsExecuted}: ${sweepNewCount} mensajes nuevos. Pausa ${BETWEEN_SWEEPS_MS}ms...`
        );
        await new Promise((r) => setTimeout(r, BETWEEN_SWEEPS_MS));
      }
    }
  }

  if (!args.singlePass && !converged && !abortRequested) {
    log('WARN', 'SWEEP',
      `Alcanzó ${MAX_SWEEPS} barridos sin converger — posible tráfico continuo, revisar manualmente`
    );
  }

  clearInterval(progressTimer);

  try {
    await client.destroy();
    log('INFO', 'WA', 'Cliente destruido correctamente');
  } catch (_) {}

  const finishedAtMs = Date.now();
  const finishedAt   = new Date(finishedAtMs).toISOString();

  // ─── Resumen final en consola ──────────────────────────────────────────────

  console.log('');
  console.log('══════════════ RESUMEN FINAL ══════════════');
  const modeLabel = args.dryRun ? 'dry-run' : args.noSweep ? 'run single-pass' : 'run con convergencia';
  console.log(`Modo:           ${modeLabel}`);
  console.log(`Duración:       ${formatElapsed(startedAtMs, finishedAtMs)}`);
  if (!args.singlePass) {
    const sweepResult = converged ? `convergió en barrido ${sweepsExecuted}` : `no convergió (máx ${MAX_SWEEPS})`;
    console.log(`Barridos:       ${sweepsExecuted}/${MAX_SWEEPS} — ${sweepResult}`);
  }
  console.log(`Subidos OK:     ${totalUploaded}`);
  console.log(`Fallidos:       ${totalFailed}`);
  console.log(`Skip dedup:     ${totalSkippedDedup}`);
  console.log(`Skip blacklist: ${totalSkippedBlacklist}`);
  console.log(`Skip MIME:      ${totalSkippedMime}`);
  if (truncatedGroups.length > 0) {
    console.log(`⚠ Truncados:    ${truncatedGroups.length} grupos — ver TXT para comandos`);
  }
  console.log('════════════════════════════════════════════');
  console.log('');

  // ─── Guardar reportes ──────────────────────────────────────────────────────

  const groupResults = Array.from(groupStatsMap.values());
  const modeKey      = args.dryRun ? 'dry-run' : args.noSweep ? 'run-no-sweep' : 'run';

  saveReportJson({
    mode: modeKey, aborted: abortRequested, args,
    startedAt, finishedAt, sweepsExecuted, converged,
    totalUploaded, totalFailed,
    totalSkippedDedup, totalSkippedBlacklist, totalSkippedMime,
    groupResults, truncatedGroups,
  });

  saveReportTxt({
    mode: modeKey, aborted: abortRequested, args,
    startedAtMs, finishedAtMs, sweepsExecuted, converged,
    totalUploaded, totalFailed,
    totalSkippedDedup, totalSkippedBlacklist, totalSkippedMime,
    failedMessages: Array.from(failedMessageMap.values()),
    truncatedGroups,
  });

  log('INFO', 'RECOVERY', '=== FIN RECOVERY WINDOW ===');

  if (abortRequested) process.exit(1);
  process.exit(totalFailed > 0 ? 1 : 0);
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

main().catch(async (err) => {
  console.error(`[FATAL] ${maskSensitiveText(err && err.message)}`);
  if (activeClient) {
    try {
      await activeClient.destroy();
      console.warn('[WA] Cliente destruido desde catch fatal');
    } catch (_) {
      console.warn('[WA] ⚠ No se pudo destruir el cliente — correr: find /data/.wwebjs_auth/ -name "Singleton*" -delete');
    }
  } else {
    console.warn('[WA] ⚠ Cliente no inicializado — si hay Singleton huérfano: find /data/.wwebjs_auth/ -name "Singleton*" -delete');
  }
  process.exit(2);
});
