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

function createMessageHandler({ config, driveService, logService, processedStore, operationalNotifier }) {
  return async function handleMessage(msg) {
    try {
      if (!config.processingEnabled) return;

      const chat = await msg.getChat();
      if (!chat.isGroup) return;

      const tag = config.whatsapp.groups[chat.name];
      if (!tag) return;

      if (!msg.hasMedia) return;

      const authorId = msg.author || '';
      const fromId = msg.from || '';
      const senderId = authorId || fromId || 'unknown';
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
      const blocked = isSenderBlocked(senderId, blockedNumbers);
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
      if (blocked) {
        console.log(`[IGNORED] blocked sender ${maskPhone(senderId)} in ${maskSensitiveText(chat.name, 80)}`);
        return;
      }

      const messageKey = buildMessageKey(msg, chat);
      if (messageKey && processedStore.has(messageKey)) {
        logService.duplicateEvent({
          timestamp: new Date().toISOString(),
          chatName: chat.name,
          tag,
        });
        return;
      }

      const messageDate = getMessageDate(msg);
      const businessCalendar = getBusinessCalendar(config, operationalNotifier);
      const processNow = isWithinBusinessHours(messageDate, businessCalendar);
      const operationalDate = getOperationalDateForMessage(messageDate, businessCalendar);

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
            buffer,
            mimeType: media.mimetype,
            originalFilename: media.filename,
            messageDate,
            operationalDate,
            metadata: {
              messageKey,
              pendingStatus: 'queued',
              groupName: chat.name,
              groupFolderName: sanitizeDriveFolderName(chat.name, 'grupo', 80),
              tag,
              mimeType: media.mimetype,
              originalMessageDate: messageDate,
              operationalDate: operationalDateText,
              queuedAt: new Date().toISOString(),
              attempts: 0,
            },
          });
          console.log(`[PENDING] ${maskSensitiveText(chat.name, 80)} -> ${result.folderPath}/${result.name}`);
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
        const result = await driveService.uploadWithRetry(null, media.mimetype, buffer, {
          groupName: chat.name,
          date: messageDate,
          media,
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
          'Fallo subiendo comprobante a Entrantes.',
          {
            group: chat.name,
            tag,
            filename,
            error: err,
          }
        );
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
    }
  };
}

module.exports = {
  createMessageHandler,
  getMessageDate,
};
