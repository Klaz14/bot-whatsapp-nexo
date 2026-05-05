const { ALLOWED_MIME } = require('../utils/mime');
const { buildUploadFilename } = require('../utils/fileNames');
const { maskSensitiveText } = require('../utils/mask');
const { buildMessageKey } = require('../services/processedStore');

function getMessageDate(msg) {
  const timestamp = Number(msg && msg.timestamp);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    const milliseconds = timestamp > 1000000000000 ? timestamp : timestamp * 1000;
    const date = new Date(milliseconds);
    if (Number.isFinite(date.getTime())) return date;
  }
  return new Date();
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

      const messageKey = buildMessageKey(msg, chat);
      if (messageKey && processedStore.has(messageKey)) {
        logService.duplicateEvent({
          timestamp: new Date().toISOString(),
          chatName: chat.name,
          tag,
        });
        return;
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

      const senderId = msg.author || msg.from || 'unknown';
      const filename = buildUploadFilename(tag, senderId, media);
      const buffer = Buffer.from(media.data, 'base64');
      const messageDate = getMessageDate(msg);

      try {
        const result = await driveService.uploadWithRetry(filename, media.mimetype, buffer, {
          groupName: chat.name,
          date: messageDate,
        });
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
