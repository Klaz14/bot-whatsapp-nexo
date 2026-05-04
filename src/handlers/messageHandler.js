const { ALLOWED_MIME } = require('../utils/mime');
const { buildUploadFilename } = require('../utils/fileNames');

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
        const link = result.webViewLink || `https://drive.google.com/file/d/${result.id}`;
        const line = [
          new Date().toISOString(),
          chat.name,
          tag,
          filename,
          link,
        ].join('\t');
        logService.upload(line);
        console.log(`[OK] ${chat.name} -> ${filename}`);
        console.log(`     ${link}`);
      } catch (err) {
        const line = [
          new Date().toISOString(),
          chat.name,
          tag,
          filename,
          `ERROR: ${err.message}`,
        ].join('\t');
        logService.error(line);
        console.error(`[ERROR] no se pudo subir ${filename}: ${err.message}`);
      }
    } catch (err) {
      console.error('[handler] error inesperado:', err);
      logService.error(`${new Date().toISOString()}\thandler\t-\t-\tERROR: ${err.message}`);
    }
  };
}

module.exports = {
  createMessageHandler,
};
