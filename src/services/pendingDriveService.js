const { Readable } = require('stream');
const { extFromMime } = require('../utils/mime');
const { maskSensitiveText } = require('../utils/mask');
const { sanitizeDriveFolderName, sanitizeExtension, sanitizeTag } = require('../utils/sanitize');
const {
  buildAuditTime,
  formatLocalDateForPendingFolder,
  formatLocalTimeForFilename,
} = require('../utils/time');

const APP_NAME = 'bot-whatsapp-drive';
const PENDING_TYPE = 'pending-transfer';
const PENDING_VERSION = '1';
const DEFAULT_PENDING_ROOT_NAME = 'Archivos Pendientes por Fuera de Horario';
const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const VALID_PENDING_STATUSES = new Set(['queued', 'processing', 'uploaded', 'failed']);

function escapeDriveQueryString(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function asSafeDate(date) {
  return date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
}

function toAppPropertyValue(value, maxLength = 124) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[\r\n\t]+/g, ' ').trim().slice(0, maxLength);
}

function normalizePendingStatus(status) {
  const normalized = String(status || 'queued').toLowerCase();
  return VALID_PENDING_STATUSES.has(normalized) ? normalized : 'queued';
}

function buildPendingFolderName(date, timeZone) {
  return formatLocalDateForPendingFolder(date, timeZone);
}

function buildShortMessageKey(messageKey) {
  const cleaned = String(messageKey || '').replace(/[^A-Za-z0-9]/g, '');
  return (cleaned || 'pending').slice(0, 12);
}

function buildPendingFileName({ messageKey, tag, messageDate, mimeType, originalFilename, timeZone } = {}) {
  const time = formatLocalTimeForFilename(asSafeDate(messageDate), timeZone);
  const safeTag = sanitizeTag(tag);
  const key = buildShortMessageKey(messageKey);
  const ext = sanitizeExtension(extFromMime(mimeType, originalFilename));
  return `pending_${time}_${safeTag}_${key}.${ext}`;
}

function sanitizePendingMetadata(metadata = {}) {
  const originalDate = asSafeDate(metadata.originalMessageDate || metadata.messageDate);
  const queuedDate = asSafeDate(metadata.queuedAtDate || metadata.queuedAt);
  const timeZone = metadata.timeZone;
  const originalAuditTime = buildAuditTime(originalDate, timeZone);
  const queuedAuditTime = buildAuditTime(queuedDate, timeZone);

  return {
    messageKey: toAppPropertyValue(metadata.messageKey, 80),
    pendingStatus: normalizePendingStatus(metadata.pendingStatus),
    groupFolderName: sanitizeDriveFolderName(metadata.groupFolderName || metadata.groupName, 'grupo', 80),
    tag: sanitizeTag(metadata.tag),
    mimeType: toAppPropertyValue(metadata.mimeType, 80),
    originalMessageAtUtc: toAppPropertyValue(metadata.originalMessageAtUtc || originalAuditTime.utc, 40),
    originalMessageAtLocal: toAppPropertyValue(metadata.originalMessageAtLocal || originalAuditTime.local, 40),
    operationalDate: toAppPropertyValue(metadata.operationalDate, 20),
    queuedAt: toAppPropertyValue(metadata.queuedAt || queuedAuditTime.utc, 40),
    attempts: toAppPropertyValue(Number.isFinite(Number(metadata.attempts)) ? Number(metadata.attempts) : 0, 10),
    lastError: metadata.lastError ? maskSensitiveText(toAppPropertyValue(metadata.lastError, 120), 120) : '',
  };
}

function buildPendingAppProperties(metadata = {}) {
  const safe = sanitizePendingMetadata(metadata);
  return {
    app: APP_NAME,
    type: PENDING_TYPE,
    version: PENDING_VERSION,
    messageKey: safe.messageKey,
    pendingStatus: safe.pendingStatus,
    groupFolderName: safe.groupFolderName,
    tag: safe.tag,
    mimeType: safe.mimeType,
    originalMessageAtUtc: safe.originalMessageAtUtc,
    originalMessageAtLocal: safe.originalMessageAtLocal,
    operationalDate: safe.operationalDate,
    queuedAt: safe.queuedAt,
    attempts: safe.attempts,
    lastError: safe.lastError,
  };
}

function buildPendingAppPropertiesPatch(patch = {}) {
  const appProperties = {};

  if (patch.pendingStatus !== undefined) {
    appProperties.pendingStatus = normalizePendingStatus(patch.pendingStatus);
  }
  if (patch.attempts !== undefined) {
    appProperties.attempts = toAppPropertyValue(Number.isFinite(Number(patch.attempts)) ? Number(patch.attempts) : 0, 10);
  }
  if (patch.lastError !== undefined) {
    appProperties.lastError = patch.lastError ? maskSensitiveText(toAppPropertyValue(patch.lastError, 120), 120) : '';
  }
  if (patch.queuedAt !== undefined) {
    appProperties.queuedAt = toAppPropertyValue(patch.queuedAt, 40);
  }

  return appProperties;
}

function parsePendingAppProperties(appProperties = {}) {
  const attempts = Number(appProperties.attempts || 0);
  return {
    app: appProperties.app || '',
    type: appProperties.type || '',
    version: appProperties.version || '',
    messageKey: appProperties.messageKey || '',
    pendingStatus: normalizePendingStatus(appProperties.pendingStatus),
    groupFolderName: appProperties.groupFolderName || '',
    tag: appProperties.tag || '',
    mimeType: appProperties.mimeType || '',
    originalMessageAtUtc: appProperties.originalMessageAtUtc || '',
    originalMessageAtLocal: appProperties.originalMessageAtLocal || '',
    operationalDate: appProperties.operationalDate || '',
    queuedAt: appProperties.queuedAt || '',
    attempts: Number.isFinite(attempts) ? attempts : 0,
    lastError: appProperties.lastError || '',
  };
}

function isPendingStatusQueued(status) {
  return normalizePendingStatus(status) === 'queued';
}

async function findFolderByName(drive, parentId, folderName) {
  const res = await drive.files.list({
    q: [
      `mimeType = '${DRIVE_FOLDER_MIME}'`,
      `name = '${escapeDriveQueryString(folderName)}'`,
      `'${escapeDriveQueryString(parentId)}' in parents`,
      'trashed = false',
    ].join(' and '),
    fields: 'files(id, name, createdTime)',
    orderBy: 'createdTime',
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  return (res.data.files || [])[0] || null;
}

async function createFolder(drive, parentId, folderName) {
  const res = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: DRIVE_FOLDER_MIME,
      parents: [parentId],
    },
    fields: 'id, name',
    supportsAllDrives: true,
  });

  return res.data;
}

async function findOrCreatePendingRootFolder(drive, options = {}) {
  if (options.pendingFolderId) {
    return {
      id: options.pendingFolderId,
      name: options.pendingRootName || DEFAULT_PENDING_ROOT_NAME,
    };
  }

  if (!options.parentFolderId) {
    throw new Error('Falta parentFolderId para resolver la carpeta raiz de pendientes');
  }

  const folderName = sanitizeDriveFolderName(options.pendingRootName || DEFAULT_PENDING_ROOT_NAME, 'pendientes');
  return await findFolderByName(drive, options.parentFolderId, folderName)
    || createFolder(drive, options.parentFolderId, folderName);
}

async function findPendingRootFolder(drive, options = {}) {
  if (options.pendingFolderId) {
    return {
      id: options.pendingFolderId,
      name: options.pendingRootName || DEFAULT_PENDING_ROOT_NAME,
    };
  }

  if (!options.parentFolderId) return null;

  const folderName = sanitizeDriveFolderName(options.pendingRootName || DEFAULT_PENDING_ROOT_NAME, 'pendientes');
  return findFolderByName(drive, options.parentFolderId, folderName);
}

async function findOrCreatePendingDayFolder(drive, rootFolderId, operationalDate, timeZone) {
  const folderName = buildPendingFolderName(operationalDate, timeZone);
  return await findFolderByName(drive, rootFolderId, folderName)
    || createFolder(drive, rootFolderId, folderName);
}

async function findPendingDayFolder(drive, rootFolderId, operationalDate, timeZone) {
  const folderName = buildPendingFolderName(operationalDate, timeZone);
  return findFolderByName(drive, rootFolderId, folderName);
}

async function createPendingFile(drive, options = {}) {
  const appProperties = buildPendingAppProperties(options.metadata);
  const filename = options.filename || buildPendingFileName({
    messageKey: appProperties.messageKey,
    tag: appProperties.tag,
    messageDate: options.messageDate,
    mimeType: options.mimeType,
    originalFilename: options.originalFilename,
    timeZone: options.timeZone,
  });

  const res = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [options.pendingDayFolderId],
      appProperties,
    },
    media: {
      mimeType: options.mimeType,
      body: Readable.from(options.buffer),
    },
    fields: 'id, name, appProperties, webViewLink',
    supportsAllDrives: true,
  });

  return res.data;
}

async function listPendingFilesForDate(drive, pendingDayFolderId) {
  const files = [];
  let pageToken;

  do {
    const res = await drive.files.list({
      q: [
        `'${escapeDriveQueryString(pendingDayFolderId)}' in parents`,
        'trashed = false',
        `appProperties has { key='app' and value='${APP_NAME}' }`,
        `appProperties has { key='type' and value='${PENDING_TYPE}' }`,
      ].join(' and '),
      fields: 'nextPageToken, files(id, name, mimeType, appProperties, createdTime)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return files;
}

async function listFilesInFolder(drive, folderId) {
  const files = [];
  let pageToken;

  do {
    const res = await drive.files.list({
      q: [
        `'${escapeDriveQueryString(folderId)}' in parents`,
        'trashed = false',
      ].join(' and '),
      fields: 'nextPageToken, files(id, name, mimeType, appProperties)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return files;
}

async function listPendingDayFolders(drive, rootFolderId) {
  const folders = [];
  let pageToken;

  do {
    const res = await drive.files.list({
      q: [
        `'${escapeDriveQueryString(rootFolderId)}' in parents`,
        `mimeType = '${DRIVE_FOLDER_MIME}'`,
        'trashed = false',
      ].join(' and '),
      fields: 'nextPageToken, files(id, name, createdTime)',
      orderBy: 'name',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    folders.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return folders;
}

async function findPendingFileByMessageKey(drive, pendingDayFolderId, messageKey) {
  if (!messageKey) return null;

  const res = await drive.files.list({
    q: [
      `'${escapeDriveQueryString(pendingDayFolderId)}' in parents`,
      'trashed = false',
      `appProperties has { key='app' and value='${APP_NAME}' }`,
      `appProperties has { key='type' and value='${PENDING_TYPE}' }`,
      `appProperties has { key='messageKey' and value='${escapeDriveQueryString(messageKey)}' }`,
    ].join(' and '),
    fields: 'files(id, name, mimeType, appProperties, createdTime)',
    orderBy: 'createdTime',
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  return (res.data.files || [])[0] || null;
}

async function findPendingFileByMessageKeyGlobal(drive, messageKey) {
  if (!messageKey) return null;

  const res = await drive.files.list({
    q: [
      'trashed = false',
      `appProperties has { key='app' and value='${APP_NAME}' }`,
      `appProperties has { key='type' and value='${PENDING_TYPE}' }`,
      `appProperties has { key='messageKey' and value='${escapeDriveQueryString(messageKey)}' }`,
    ].join(' and '),
    fields: 'files(id, name, mimeType, appProperties, createdTime)',
    orderBy: 'createdTime',
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  return (res.data.files || [])[0] || null;
}

async function markPendingStatus(drive, fileId, status, patch = {}) {
  const appProperties = buildPendingAppPropertiesPatch({
    ...patch,
    pendingStatus: status,
  });

  const res = await drive.files.update({
    fileId,
    requestBody: {
      appProperties,
    },
    fields: 'id, name, appProperties',
    supportsAllDrives: true,
  });

  return res.data;
}

async function deletePendingFile(drive, fileId) {
  await drive.files.delete({
    fileId,
    supportsAllDrives: true,
  });
}

async function deletePendingFolder(drive, folderId) {
  await drive.files.delete({
    fileId: folderId,
    supportsAllDrives: true,
  });
}

module.exports = {
  APP_NAME,
  DEFAULT_PENDING_ROOT_NAME,
  PENDING_TYPE,
  PENDING_VERSION,
  VALID_PENDING_STATUSES,
  buildPendingAppProperties,
  buildPendingAppPropertiesPatch,
  buildPendingFileName,
  buildPendingFolderName,
  createPendingFile,
  deletePendingFile,
  deletePendingFolder,
  findPendingFileByMessageKey,
  findPendingFileByMessageKeyGlobal,
  findPendingDayFolder,
  findPendingRootFolder,
  findOrCreatePendingDayFolder,
  findOrCreatePendingRootFolder,
  isPendingStatusQueued,
  listFilesInFolder,
  listPendingDayFolders,
  listPendingFilesForDate,
  markPendingStatus,
  parsePendingAppProperties,
  sanitizePendingMetadata,
};
