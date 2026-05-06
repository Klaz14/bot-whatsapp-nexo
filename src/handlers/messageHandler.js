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

function getBusinessCalendar(config) {
  return loadBusinessCalendar(config.paths && config.paths.businessCalendar);
}

function createMessageHandler({ config, driveService, logService, processedStore }) {
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
      const blockedNumbers = loadBlockedSenders(getDefaultBlockedSendersPath());
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
      const businessCalendar = getBusinessCalendar(config);
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
          processedStore.markProcessed(messageKey, { status: 'uploaded' });
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
      }
    } catch (err) {
      console.error('[handler] error inesperado:', maskSensitiveText(err && err.message));
      logService.errorEvent({
        timestamp: new Date().toISOString(),
        chatName: 'handler',
        tag: '-',
        error: err,
      });
    }
  };
}

module.exports = {
  createMessageHandler,
  getMessageDate,
};
