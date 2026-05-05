const fs = require('fs');
const { formatDriveReference, maskPhone, maskSensitiveText } = require('../utils/mask');
const { limitString, sanitizeFilenamePart, sanitizeGroupForLog, sanitizeTag } = require('../utils/sanitize');

function createLogService(config) {
  const maxLength = config.logging.maxFieldLength;

  function appendLog(filePath, line) {
    fs.appendFile(filePath, line + '\n', (err) => {
      if (err) console.error('No se pudo escribir', filePath, err.message);
    });
  }

  function safeField(value) {
    return maskSensitiveText(limitString(value, maxLength), maxLength);
  }

  function uploadEvent(event) {
    const driveRef = formatDriveReference(event.driveResult, config.logging.storeDriveLinks);
    const line = [
      event.timestamp || new Date().toISOString(),
      sanitizeGroupForLog(event.chatName, maxLength),
      sanitizeTag(event.tag),
      sanitizeFilenamePart(event.filename, 'upload', maxLength),
      safeField(driveRef),
    ].join('\t');

    appendLog(config.paths.uploadsLog, line);
    return driveRef;
  }

  function errorEvent(event) {
    const sender = config.logging.maskPhoneNumbers ? maskPhone(event.senderId) : safeField(event.senderId);
    const line = [
      event.timestamp || new Date().toISOString(),
      sanitizeGroupForLog(event.chatName, maxLength),
      sanitizeTag(event.tag || '-'),
      event.filename ? sanitizeFilenamePart(event.filename, 'upload', maxLength) : '-',
      sender,
      `ERROR: ${maskSensitiveText(event.error && event.error.message ? event.error.message : event.error, maxLength)}`,
    ].join('\t');

    appendLog(config.paths.errorsLog, line);
    return line;
  }

  return {
    uploadEvent,
    errorEvent,
    upload(line) {
      appendLog(config.paths.uploadsLog, safeField(line));
    },
    error(line) {
      appendLog(config.paths.errorsLog, safeField(line));
    },
  };
}

module.exports = {
  createLogService,
};
