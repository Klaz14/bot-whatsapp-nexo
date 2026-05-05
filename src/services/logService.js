const fs = require('fs');
const { formatDriveReference, maskPhone, maskSensitiveText } = require('../utils/mask');
const {
  limitString,
  sanitizeDriveFolderName,
  sanitizeFilenamePart,
  sanitizeGroupForLog,
  sanitizeTag,
} = require('../utils/sanitize');
const { buildAuditTime } = require('../utils/time');

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

  function auditTimestamp(value) {
    const date = value ? new Date(value) : new Date();
    const safeDate = Number.isFinite(date.getTime()) ? date : new Date();
    const auditTime = buildAuditTime(safeDate, config.timeZone);
    return `${auditTime.local} ${auditTime.timeZone}`;
  }

  function safeDrivePath(value) {
    if (!value) return '-';
    return String(value)
      .split('/')
      .map((part) => sanitizeDriveFolderName(part, 'folder', 80))
      .join('/');
  }

  function uploadEvent(event) {
    const driveRef = formatDriveReference(event.driveResult, config.logging.storeDriveLinks);
    const line = [
      auditTimestamp(event.timestamp),
      sanitizeGroupForLog(event.chatName, maxLength),
      sanitizeTag(event.tag),
      sanitizeFilenamePart(event.filename, 'upload', maxLength),
      safeDrivePath(event.drivePath || (event.driveResult && event.driveResult.folderPath)),
      safeField(driveRef),
    ].join('\t');

    appendLog(config.paths.uploadsLog, line);
    return driveRef;
  }

  function errorEvent(event) {
    const sender = config.logging.maskPhoneNumbers ? maskPhone(event.senderId) : safeField(event.senderId);
    const line = [
      auditTimestamp(event.timestamp),
      sanitizeGroupForLog(event.chatName, maxLength),
      sanitizeTag(event.tag || '-'),
      event.filename ? sanitizeFilenamePart(event.filename, 'upload', maxLength) : '-',
      safeDrivePath(event.drivePath),
      sender,
      `ERROR: ${maskSensitiveText(event.error && event.error.message ? event.error.message : event.error, maxLength)}`,
    ].join('\t');

    appendLog(config.paths.errorsLog, line);
    return line;
  }

  function duplicateEvent(event) {
    const line = [
      auditTimestamp(event.timestamp),
      sanitizeGroupForLog(event.chatName, maxLength),
      sanitizeTag(event.tag || '-'),
      'duplicate_ignored',
      'DUPLICATE: message already processed',
    ].join('\t');

    appendLog(config.paths.errorsLog, line);
    return line;
  }

  return {
    uploadEvent,
    errorEvent,
    duplicateEvent,
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
