const { ALLOWED_MIME } = require('../utils/mime');
const { maskPhone, maskSensitiveText } = require('../utils/mask');
const { sanitizeDriveFolderName } = require('../utils/sanitize');
const { buildMessageKey } = require('../services/processedStore');
const {
  getBusinessDateString,
  getOperationalDateForMessage,
  isWithinBusinessHours,
  loadBusinessCalendar,
} = require('../utils/businessCalendar');
const {
  getDefaultBlockedSendersPath,
  getPhoneSuffix,
  isFullSenderDebugEnabled,
  isSenderBlocked,
  loadBlockedSenders,
  normalizePhoneNumber,
} = require('../services/blockedSenders');
const { convertPdfFirstPageToJpg, getPdfPageCount } = require('../utils/pdfConverter');

function getMessageDate(msg) {
  const timestamp = Number(msg && msg.timestamp);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    const milliseconds = timestamp > 1000000000000 ? timestamp : timestamp * 1000;
    const date = new Date(milliseconds);
    if (Number.isFinite(date.getTime())) return date;
  }
  return new Date();
}

function formatBlacklistSender(value) {
  if (!value) return 'missing';
  if (String(value).includes('@g.us')) return 'group_or_chat';
  return maskPhone(value);
}

function formatRawBlacklistDebugValue(value) {
  if (value === undefined || value === null || value === '') return 'missing';
  return String(value).replace(/\s+/g, ' ');
}

function notifySafely(operationalNotifier, level, eventType, message, details = {}, options = {}) {
  if (!operationalNotifier || typeof operationalNotifier[level] !== 'function') return;
  operationalNotifier[level](eventType, message, details, options).catch((err) => {
    console.warn(`[ALERT] no se pudo enviar alerta ${eventType}: ${maskSensitiveText(err && err.message)}`);
  });
}

function getBusinessCalendar(config, operationalNotifier) {
  return loadBusinessCalendar(config.paths && config.paths.businessCalendar, {
    onWarning: (warning) => {
      notifySafely(
        operationalNotifier,
        'notifyWarning',
        'business_calendar_defaults',
        'Calendario laboral no disponible o invalido; usando defaults.',
        { reason: warning && warning.reason },
        { dedupeKey: 'business-calendar-defaults' }
      );
    },
  });
}

function createMessageHandler({ config, driveService, logService, processedStore, operationalNotifier, groupsCache, statsStore, blacklistCache }) {
  // Lock en memoria por messageKey: cierra la race entre handlers concurrentes
  // (has() persistente cubre el dedup entre reinicios; esto, el del mismo proceso).
  const inFlight = new Set();

  return async function handleMessage(msg) {
    let reservedKey = null;
    // Acuse visual: reacciona al mensaje del comprobante (best-effort, nunca rompe el flujo).
    async function reactSafe(emoji) {
      if (!config.reactOnProcessed) return;
      try { await msg.react(emoji); } catch (_) { /* reaccion best-effort */ }
    }
    try {
      if (!config.processingEnabled) return;

      const chat = await msg.getChat();
      if (!chat.isGroup) return;

      // MOD-01: el TAG sale del cache de Sheets si esta activo — por ID estable del chat
      // primero (evita el bug de "primero gana" con grupos homonimos), fallback a nombre;
      // si el cache no esta activo, de config.json (legacy).
      let tag;
      if (groupsCache) {
        const chatId = chat.id && chat.id._serialized;
        tag = groupsCache.getTagById(chatId) || groupsCache.getTag(chat.name);
      } else {
        tag = config.whatsapp.groups[chat.name];
      }
      if (!tag) return;

      if (!msg.hasMedia) return;

      const authorId = msg.author || '';
      const fromId = msg.from || '';
      const senderId = authorId || fromId || 'unknown';
      // MOD-02: blacklist + grupos exentos desde Sheets si esta activa; si no, archivo local (legacy).
      let blocked;
      let isExempt;
      if (blacklistCache) {
        blocked = blacklistCache.isBlocked(senderId);
        isExempt = blacklistCache.isExempt(chat.name);
      } else {
        const blockedNumbers = loadBlockedSenders(config.paths.blockedSenders || getDefaultBlockedSendersPath(), {
          onWarning: (warning) => {
            notifySafely(
              operationalNotifier,
              'notifyWarning',
              'blocked_senders_invalid',
              'Blacklist local invalida; se ignora temporalmente.',
              { reason: warning && warning.reason },
              { dedupeKey: 'blocked-senders-invalid' }
            );
          },
        });
        blocked = isSenderBlocked(senderId, blockedNumbers);
        isExempt = (config.blacklistExemptGroups || []).includes(chat.name);
      }
      console.log(
        `[blacklist] author=${formatBlacklistSender(authorId)} ` +
        `from=${formatBlacklistSender(fromId)} ` +
        `effective=${formatBlacklistSender(senderId)} ` +
        `effectiveLast4=${getPhoneSuffix(senderId)} ` +
        `blocked=${blocked}`
      );
      if (isFullSenderDebugEnabled()) {
        console.log(
          `[blacklist-debug-local] authorRaw=${formatRawBlacklistDebugValue(authorId)} ` +
          `authorNormalized=${normalizePhoneNumber(authorId) || 'missing'} ` +
          `fromRaw=${formatRawBlacklistDebugValue(fromId)} ` +
          `fromNormalized=${normalizePhoneNumber(fromId) || 'missing'} ` +
          `effectiveRaw=${formatRawBlacklistDebugValue(senderId)} ` +
          `effectiveNormalized=${normalizePhoneNumber(senderId) || 'missing'} ` +
          `blocked=${blocked}`
        );
      }
      if (blocked && isExempt) {
        console.log(`[BLACKLIST EXEMPT] sender ${maskPhone(senderId)} estaria bloqueado pero el grupo "${maskSensitiveText(chat.name, 80)}" esta en BLACKLIST_EXEMPT_GROUPS_JSON, procesando comprobante`);
      }
      if (blocked && !isExempt) {
        console.log(`[IGNORED] blocked sender ${maskPhone(senderId)} in ${maskSensitiveText(chat.name, 80)}`);
        return;
      }

      const messageKey = buildMessageKey(msg, chat);
      if (messageKey && (processedStore.has(messageKey) || inFlight.has(messageKey))) {
        logService.duplicateEvent({
          timestamp: new Date().toISOString(),
          chatName: chat.name,
          tag,
        });
        return;
      }
      if (messageKey) { inFlight.add(messageKey); reservedKey = messageKey; }

      const messageDate = getMessageDate(msg);
      const businessCalendar = getBusinessCalendar(config, operationalNotifier);
      const processNow = isWithinBusinessHours(messageDate, businessCalendar);
      const operationalDate = getOperationalDateForMessage(messageDate, businessCalendar);

      // F0.1/F0.2: fallback durable. Si una subida en vivo agota reintentos o un PDF
      // no se puede convertir, encolamos el comprobante a pendientes en vez de perderlo
      // (el pendingProcessor lo reintenta). Reusa la misma metadata que el flujo
      // fuera-de-horario y NO marca processed (eso lo hace el processor al subir OK).
      async function enqueueToPending({ buffer: bufferToQueue, mimeType: mimeToQueue, media: mediaInfo, reason }) {
        try {
          if (messageKey) {
            const existing = await driveService.findPendingByMessageKey(messageKey);
            if (existing) {
              console.log(`[PENDING-FALLBACK ${reason}] ya encolado, no se duplica -> ${existing.folderPath}/${existing.name}`);
              return;
            }
          }
          const operationalDateText = getBusinessDateString(operationalDate, businessCalendar);
          const result = await driveService.createPendingUpload({
            buffer: bufferToQueue,
            mimeType: mimeToQueue,
            originalFilename: mediaInfo && mediaInfo.filename,
            messageDate,
            operationalDate,
            metadata: {
              messageKey,
              pendingStatus: 'queued',
              groupName: chat.name,
              groupFolderName: sanitizeDriveFolderName(chat.name, 'grupo', 80),
              tag,
              mimeType: mimeToQueue,
              originalMessageDate: messageDate,
              operationalDate: operationalDateText,
              queuedAt: new Date().toISOString(),
              attempts: 0,
            },
          });
          console.log(`[PENDING-FALLBACK ${reason}] ${maskSensitiveText(chat.name, 80)} -> ${result.folderPath}/${result.name}`);
        } catch (enqueueErr) {
          console.error(`[PENDING-FALLBACK ${reason}] no se pudo encolar: ${maskSensitiveText(enqueueErr && enqueueErr.message)}`);
          notifySafely(
            operationalNotifier,
            'notifyError',
            'pending_enqueue_failed',
            'No se pudo guardar comprobante en pendientes tras fallo de subida.',
            { group: chat.name, tag, error: enqueueErr }
          );
        }
      }

      if (!processNow && messageKey) {
        const existingPending = await driveService.findPendingByMessageKey(messageKey);
        if (existingPending) {
          console.log(`[PENDING] duplicate ignored -> ${existingPending.folderPath}/${existingPending.name}`);
          return;
        }
      }

      const media = await msg.downloadMedia();
      if (!media || !media.data) {
        console.warn(`[${chat.name}] mensaje con media pero sin data, salteando`);
        return;
      }

      if (!ALLOWED_MIME.has(media.mimetype)) {
        // Solo imagenes y PDFs.
        return;
      }

      const buffer = Buffer.from(media.data, 'base64');

      const isPdf = media.mimetype === 'application/pdf';

      if (isPdf && processNow) {
        let pageCount = 1;
        try { pageCount = await getPdfPageCount(buffer); } catch (_) { pageCount = 1; }

        if (pageCount > 1) {
          try {
            const result = await driveService.uploadPdfPagesWithRetry(buffer, 'image/jpeg', {
              groupName: chat.name,
              date: messageDate,
              media: { ...media, mimetype: 'image/jpeg' },
              tag,
            });

            console.log(`[PDF multi-pagina] ${result.uploaded.length} OK, ${result.failed.length} fallidas (baseId ${result.baseId}, ${result.pageCount} pags)`);

            if (result.failed.length === 0) {
              if (messageKey) {
                try {
                  processedStore.markProcessed(messageKey, { status: 'uploaded' });
                } catch (storeErr) {
                  console.error(`[ERROR] no se pudo marcar processed: ${maskSensitiveText(storeErr && storeErr.message)}`);
                  notifySafely(
                    operationalNotifier,
                    'notifyError',
                    'processed_store_write_failed',
                    'Comprobante subido, pero no se pudo actualizar idempotencia local.',
                    {
                      group: chat.name,
                      tag,
                      filename: `baseId_${result.baseId}`,
                      error: storeErr,
                    }
                  );
                }
              }
              if (statsStore) statsStore.recordUpload({ tag, groupName: chat.name, messageDate });
              await reactSafe('👍'); // acuse: PDF multi-pagina subido OK
            } else {
              notifySafely(
                operationalNotifier,
                'notifyError',
                'drive_multipage_partial',
                `Subida parcial de PDF multi-pagina: ${result.uploaded.length} OK, ${result.failed.length} fallaron.`,
                {
                  group: chat.name,
                  tag,
                  filename: `baseId_${result.baseId}`,
                  error: null,
                }
              );
            }
          } catch (err) {
            logService.errorEvent({
              timestamp: new Date().toISOString(),
              chatName: chat.name,
              tag,
              filename: '-',
              senderId,
              drivePath: err && err.folderPath,
              error: err,
            });
            console.error(`[ERROR] no se pudo subir PDF multi-pagina: ${maskSensitiveText(err.message)}`);
            notifySafely(
              operationalNotifier,
              'notifyError',
              'drive_upload_failed',
              'Fallo subiendo comprobante multi-pagina a Entrantes.',
              {
                group: chat.name,
                tag,
                filename: '-',
                error: err,
              }
            );
            // F0.1: fallo total de la subida multi-pagina -> encolar el PDF crudo a
            // pendientes (el pendingProcessor re-rasteriza y reintenta). El fallo PARCIAL
            // (algunas paginas OK) NO se reencola para no duplicar; tracking por pagina = P2.
            await enqueueToPending({ buffer, mimeType: 'application/pdf', media, reason: 'multipage_live' });
          }
          return;
          // pageCount == 1 -> NO retorna; cae al flujo normal de abajo (intacto)
        }
      }

      // Fuera de horario: si es PDF multi-página, encolar el PDF ORIGINAL crudo
      // (la conversión por página se difiere al pendingProcessor). PDF de 1 página
      // o imagen siguen el flujo de siempre (convertir 1ª pág -> encolar JPEG).
      let enqueueRawPdf = false;
      if (isPdf && !processNow) {
        let pageCount = 1;
        try { pageCount = await getPdfPageCount(buffer); } catch (_) { pageCount = 1; }
        enqueueRawPdf = pageCount > 1;
      }

      // Conversión PDF → JPG (primera página) si aplica
      let processBuffer = buffer;
      let processMime = media.mimetype;
      if (media.mimetype === 'application/pdf' && !enqueueRawPdf) {
        try {
          processBuffer = await convertPdfFirstPageToJpg(buffer);
          processMime = 'image/jpeg';
          console.log(`[PDF→JPG] convertido: ${maskSensitiveText(chat.name, 80)} - ${media.filename || '(sin nombre)'} - ${processBuffer.length} bytes`);
        } catch (err) {
          console.error(`[PDF→JPG ERROR] ${maskSensitiveText(chat.name, 80)}: ${maskSensitiveText(err && err.message)}`);
          notifySafely(
            operationalNotifier,
            'notifyError',
            'pdf_conversion_failed',
            'Fallo convirtiendo PDF a imagen; se encola el PDF crudo para reintento.',
            {
              group: chat.name,
              tag,
              filename: media.filename || '(sin nombre)',
              error: err,
            }
          );
          // F0.2: no descartar el PDF. Encolar el PDF ORIGINAL crudo a pendientes;
          // el pendingProcessor lo re-rasteriza y sube. Evita la perdida silenciosa
          // de todos los PDFs si falta poppler-utils en el contenedor.
          await enqueueToPending({ buffer, mimeType: 'application/pdf', media, reason: 'pdf_conversion' });
          return;
        }
      }

      if (!processNow) {
        const operationalDateText = getBusinessDateString(operationalDate, businessCalendar);
        try {
          if (!config.google.pendingFolderId) {
            notifySafely(
              operationalNotifier,
              'notifyWarning',
              'pending_folder_fallback',
              'Carpeta de pendientes sin ID explicito; se usa busqueda/creacion por nombre.',
              {},
              { dedupeKey: 'pending-folder-fallback' }
            );
          }
          const result = await driveService.createPendingUpload({
            buffer: processBuffer,
            mimeType: processMime,
            originalFilename: media.filename,
            messageDate,
            operationalDate,
            metadata: {
              messageKey,
              pendingStatus: 'queued',
              groupName: chat.name,
              groupFolderName: sanitizeDriveFolderName(chat.name, 'grupo', 80),
              tag,
              mimeType: processMime,
              originalMessageDate: messageDate,
              operationalDate: operationalDateText,
              queuedAt: new Date().toISOString(),
              attempts: 0,
            },
          });
          console.log(`[PENDING] ${maskSensitiveText(chat.name, 80)} -> ${result.folderPath}/${result.name}`);
          await reactSafe('🕒'); // acuse: recibido fuera de horario, se sube al volver
        } catch (err) {
          logService.errorEvent({
            timestamp: new Date().toISOString(),
            chatName: chat.name,
            tag,
            filename: 'pending',
            senderId,
            drivePath: err && err.folderPath,
            error: err,
          });
          console.error(`[ERROR] no se pudo encolar pendiente: ${maskSensitiveText(err && err.message)}`);
          notifySafely(
            operationalNotifier,
            'notifyError',
            'pending_enqueue_failed',
            'No se pudo guardar comprobante fuera de horario en pendientes.',
            {
              group: chat.name,
              tag,
              error: err,
            }
          );
        }
        return;
      }

      let filename = '-';

      try {
        const result = await driveService.uploadWithRetry(null, processMime, processBuffer, {
          groupName: chat.name,
          date: messageDate,
          media: { ...media, mimetype: processMime },
          sequentialFilename: true,
          tag,
        });
        filename = result.filename || filename;
        const driveRef = logService.uploadEvent({
          timestamp: new Date().toISOString(),
          chatName: chat.name,
          tag,
          filename,
          driveResult: result,
          drivePath: result.folderPath,
        });
        console.log(`[OK] ${chat.name} -> ${result.folderPath}/${filename}`);
        console.log(`     ${driveRef}`);
        if (statsStore) statsStore.recordUpload({ tag, groupName: chat.name, messageDate });
        await reactSafe('👍'); // acuse: comprobante subido a Entrantes
        if (messageKey) {
          try {
            processedStore.markProcessed(messageKey, { status: 'uploaded' });
          } catch (storeErr) {
            console.error(`[ERROR] no se pudo marcar processed: ${maskSensitiveText(storeErr && storeErr.message)}`);
            notifySafely(
              operationalNotifier,
              'notifyError',
              'processed_store_write_failed',
              'Comprobante subido, pero no se pudo actualizar idempotencia local.',
              {
                group: chat.name,
                tag,
                filename,
                error: storeErr,
              }
            );
          }
        }
      } catch (err) {
        logService.errorEvent({
          timestamp: new Date().toISOString(),
          chatName: chat.name,
          tag,
          filename,
          senderId,
          drivePath: err && err.folderPath,
          error: err,
        });
        console.error(`[ERROR] no se pudo subir ${filename}: ${maskSensitiveText(err.message)}`);
        notifySafely(
          operationalNotifier,
          'notifyError',
          'drive_upload_failed',
          'Fallo subiendo comprobante a Entrantes; se encola a pendientes para reintento.',
          {
            group: chat.name,
            tag,
            filename,
            error: err,
          }
        );
        // F0.1 (cierra P5): la subida en vivo agoto los reintentos. El mensaje de
        // WhatsApp ya se consumio, asi que encolamos a pendientes para no perderlo.
        await enqueueToPending({ buffer: processBuffer, mimeType: processMime, media, reason: 'upload_live' });
      }
    } catch (err) {
      console.error('[handler] error inesperado:', maskSensitiveText(err && err.message));
      logService.errorEvent({
        timestamp: new Date().toISOString(),
        chatName: 'handler',
        tag: '-',
        error: err,
      });
      notifySafely(
        operationalNotifier,
        'notifyError',
        'message_handler_unexpected',
        'Error inesperado procesando mensaje recibido.',
        { error: err }
      );
    } finally {
      if (reservedKey) inFlight.delete(reservedKey);
    }
  };
}

module.exports = {
  createMessageHandler,
  getMessageDate,
};
