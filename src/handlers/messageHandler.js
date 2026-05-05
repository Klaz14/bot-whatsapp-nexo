const { ALLOWED_MIME } = require('../utils/mime');
const { buildUploadFilename } = require('../utils/fileNames');
const { maskSensitiveText } = require('../utils/mask');

function createMessageHandler({ config, driveService, logService }) {
  return async function handleMessage(msg) {
    try {
      if (!config.processingEnabled) return;

      const chat = await msg.getChat();
      if (!chat.isGroup) return;

      const tag = config.whatsapp.groups[chat.name];
      if (!tag) return;

      if (!msg.hasMedia) return;

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

      try {
        const result = await driveService.uploadWithRetry(filename, media.mimetype, buffer);
        const driveRef = logService.uploadEvent({
          timestamp: new Date().toISOString(),
          chatName: chat.name,
          tag,
          filename,
          driveResult: result,
        });
        console.log(`[OK] ${chat.name} -> ${filename}`);
        console.log(`     ${driveRef}`);
      } catch (err) {
        logService.errorEvent({
          timestamp: new Date().toISOString(),
          chatName: chat.name,
          tag,
          filename,
          senderId,
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
};
