const fs = require('fs');
const { Readable } = require('stream');
const { google } = require('googleapis');
const { maskSensitiveText } = require('../utils/mask');
const { buildSequentialUploadFilename } = require('../utils/fileNames');
const {
  formatLocalDateForPendingFolder,
} = require('../utils/time');
const {
  DEFAULT_PENDING_ROOT_NAME,
  buildPendingFileName,
  createPendingFile,
  deletePendingFile,
  deletePendingFolder,
  findOrCreatePendingRootFolder,
  findPendingFileByMessageKeyGlobal,
  findPendingRootFolder,
  listFilesInFolder,
  listPendingFilesForDate,
  markPendingStatus,
  parsePendingAppProperties,
} = require('./pendingDriveService');

const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const SEQUENTIAL_UPLOAD_FILENAME_RE = /^(\d+)_(\d{4})_([01]\d|2[0-3])([0-5]\d)_[A-Za-z0-9][A-Za-z0-9_-]*\.[A-Za-z0-9]+$/;

function assertDriveConfig(config) {
  if (!config.google.driveFolderId || config.google.driveFolderId === 'YYY') {
    console.error('Edita config.json o GOOGLE_DRIVE_FOLDER_ID y pone un driveFolderId real.');
    process.exit(1);
  }
  if (!fs.existsSync(config.paths.credentials)) {
    console.error('Falta credentials.json en', config.paths.credentials);
    console.error('Segui los pasos del README para crear el OAuth Client ID (tipo Desktop app) y bajar el JSON.');
    process.exit(1);
  }
  if (!fs.existsSync(config.paths.token)) {
    console.error('Falta token.json. Corri primero:  node auth.js');
    process.exit(1);
  }
}

function escapeDriveQueryString(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function buildDriveFolderPath(date, timeZone) {
  const dayFolderName = formatLocalDateForPendingFolder(date, timeZone);
  return {
    dayFolderName,
    logicalPath: dayFolderName,
  };
}

function extractSequentialIdFromName(name) {
  const match = SEQUENTIAL_UPLOAD_FILENAME_RE.exec(String(name || ''));
  if (!match) return null;

  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function getNextSequentialUploadId(fileNames) {
  const maxId = (fileNames || [])
    .map((name) => extractSequentialIdFromName(name))
    .filter((id) => id !== null)
    .reduce((max, id) => Math.max(max, id), 0);

  return maxId + 1;
}

function dateFromOperationalDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return new Date();
  return new Date(`${match[1]}-${match[2]}-${match[3]}T15:00:00.000Z`);
}

function dateFromPendingMetadata(metadata) {
  const date = new Date(metadata.originalMessageAtUtc || metadata.originalMessageAtLocal);
  return Number.isFinite(date.getTime()) ? date : dateFromOperationalDate(metadata.operationalDate);
}

function createDriveService(config) {
  assertDriveConfig(config);

  const credsRaw = JSON.parse(fs.readFileSync(config.paths.credentials, 'utf8'));
  const oauthBlock = credsRaw.installed || credsRaw.web;
  if (!oauthBlock || !oauthBlock.client_id) {
    console.error('credentials.json no parece ser un OAuth Client ID. Ver README.');
    process.exit(1);
  }

  const oauth2 = new google.auth.OAuth2(
    oauthBlock.client_id,
    oauthBlock.client_secret,
    config.google.oauthRedirectUri
  );
  oauth2.setCredentials(JSON.parse(fs.readFileSync(config.paths.token, 'utf8')));
  oauth2.on('tokens', (tokens) => {
    try {
      const existing = JSON.parse(fs.readFileSync(config.paths.token, 'utf8'));
      fs.writeFileSync(config.paths.token, JSON.stringify({ ...existing, ...tokens }, null, 2));
    } catch (e) {
      console.warn('No se pudo persistir nuevo token:', e.message);
    }
  });

  const drive = google.drive({ version: 'v3', auth: oauth2 });
  const folderCache = new Map();
  const folderLocks = new Map();

  function cacheKey(parentId, folderName) {
    return `${parentId}\0${folderName}`;
  }

  async function findFolderByName(parentId, folderName) {
    const escapedParentId = escapeDriveQueryString(parentId);
    const escapedFolderName = escapeDriveQueryString(folderName);
    const res = await drive.files.list({
      q: [
        `mimeType = '${DRIVE_FOLDER_MIME}'`,
        `name = '${escapedFolderName}'`,
        `'${escapedParentId}' in parents`,
        'trashed = false',
      ].join(' and '),
      fields: 'files(id, name, createdTime)',
      orderBy: 'createdTime',
      pageSize: 10,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const folders = res.data.files || [];
    return folders[0] || null;
  }

  async function createFolder(parentId, folderName) {
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

  async function getOrCreateFolder(parentId, folderName) {
    const key = cacheKey(parentId, folderName);
    if (folderCache.has(key)) return folderCache.get(key);

    const existing = await findFolderByName(parentId, folderName);
    const folder = existing || await createFolder(parentId, folderName);
    folderCache.set(key, folder);
    return folder;
  }

  async function resolveUploadFolder(options = {}) {
    const date = options.date instanceof Date ? options.date : new Date();
    const folderPath = buildDriveFolderPath(date, config.timeZone);

    if (config.dryRun || !config.safety.allowRealDriveUploads) {
      return {
        id: config.google.driveFolderId,
        ...folderPath,
      };
    }

    const dayFolder = await getOrCreateFolder(config.google.driveFolderId, folderPath.dayFolderName);

    return {
      id: dayFolder.id,
      ...folderPath,
    };
  }

  function withFolderLock(folderId, task) {
    const previous = folderLocks.get(folderId) || Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const cleanup = run.finally(() => {
      if (folderLocks.get(folderId) === cleanup) {
        folderLocks.delete(folderId);
      }
    });
    folderLocks.set(folderId, cleanup);
    return run;
  }

  async function listFileNamesInFolder(parentId) {
    const escapedParentId = escapeDriveQueryString(parentId);
    const fileNames = [];
    let pageToken;

    do {
      const res = await drive.files.list({
        q: [
          `'${escapedParentId}' in parents`,
          `mimeType != '${DRIVE_FOLDER_MIME}'`,
          'trashed = false',
        ].join(' and '),
        fields: 'nextPageToken, files(name)',
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      for (const file of res.data.files || []) {
        if (file && file.name) fileNames.push(file.name);
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);

    return fileNames;
  }

  async function buildFilenameForUploadFolder(uploadFolder, mime, options) {
    if (!options.sequentialFilename) {
      return {
        filename: options.filename,
      };
    }

    if (config.dryRun || !config.safety.allowRealDriveUploads) {
      return {
        filename: buildSequentialUploadFilename({
          id: 1,
          date: options.date,
          tag: options.tag,
          media: options.media || { mimetype: mime, filename: options.originalFilename },
          timeZone: config.timeZone,
        }),
        sequenceId: 1,
      };
    }

    const existingNames = await listFileNamesInFolder(uploadFolder.id);
    const sequenceId = getNextSequentialUploadId(existingNames);
    return {
      filename: buildSequentialUploadFilename({
        id: sequenceId,
        date: options.date,
        tag: options.tag,
        media: options.media || { mimetype: mime, filename: options.originalFilename },
        timeZone: config.timeZone,
      }),
      sequenceId,
    };
  }

  async function uploadWithRetry(filename, mime, buffer, options = {}, attempts = 3) {
    if (typeof options === 'number') {
      attempts = options;
      options = {};
    }

    if (config.dryRun || !config.safety.allowRealDriveUploads) {
      const folderPath = buildDriveFolderPath(options.date || new Date(), config.timeZone);
      const filenameInfo = await buildFilenameForUploadFolder({ id: config.google.driveFolderId }, mime, {
        ...options,
        filename,
      });
      console.warn('[upload] subida a Drive bloqueada por configuracion de seguridad.');
      return {
        id: 'dry-run',
        webViewLink: '',
        folderPath: folderPath.logicalPath,
        filename: filenameInfo.filename,
        sequenceId: filenameInfo.sequenceId,
      };
    }

    let lastErr;
    for (let i = 1; i <= attempts; i++) {
      try {
        const uploadFolder = await resolveUploadFolder(options);
        const result = await withFolderLock(uploadFolder.id, async () => {
          const filenameInfo = await buildFilenameForUploadFolder(uploadFolder, mime, {
            ...options,
            filename,
          });
          const res = await drive.files.create({
            requestBody: {
              name: filenameInfo.filename,
              parents: [uploadFolder.id],
            },
            media: {
              mimeType: mime,
              body: Readable.from(buffer),
            },
            fields: 'id, webViewLink',
            supportsAllDrives: true,
          });

          return {
            ...res.data,
            filename: filenameInfo.filename,
            sequenceId: filenameInfo.sequenceId,
          };
        });
        return {
          ...result,
          folderPath: uploadFolder.logicalPath,
        };
      } catch (err) {
        lastErr = err;
        if (i < attempts) {
          const wait = 1000 * Math.pow(2, i - 1);
          console.warn(`[upload] intento ${i}/${attempts} fallo: ${maskSensitiveText(err.message)}. Reintento en ${wait}ms`);
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
      }
    }
    throw lastErr;
  }

  async function resolvePendingRootFolder(options = {}) {
    const createIfMissing = options.create !== false;

    if (config.dryRun || !config.safety.allowRealDriveUploads) {
      return {
        id: config.google.pendingFolderId || config.google.driveFolderId,
        name: DEFAULT_PENDING_ROOT_NAME,
        folderPath: DEFAULT_PENDING_ROOT_NAME,
      };
    }

    const rootOptions = {
      pendingFolderId: config.google.pendingFolderId,
      parentFolderId: config.google.driveFolderId,
      pendingRootName: DEFAULT_PENDING_ROOT_NAME,
    };
    const rootFolder = createIfMissing
      ? await findOrCreatePendingRootFolder(drive, rootOptions)
      : await findPendingRootFolder(drive, rootOptions);
    if (!rootFolder) return null;

    return {
      id: rootFolder.id,
      name: rootFolder.name || DEFAULT_PENDING_ROOT_NAME,
      folderPath: rootFolder.name || DEFAULT_PENDING_ROOT_NAME,
    };
  }

  async function findPendingByMessageKey(messageKey) {
    if (!messageKey) return null;

    if (config.dryRun || !config.safety.allowRealDriveUploads) return null;

    const file = await findPendingFileByMessageKeyGlobal(drive, messageKey);
    return file ? {
      ...file,
      folderPath: DEFAULT_PENDING_ROOT_NAME,
    } : null;
  }

  async function createPendingUpload(options = {}) {
    const pendingRootFolder = await resolvePendingRootFolder({ create: true });

    if (config.dryRun || !config.safety.allowRealDriveUploads) {
      return {
        id: 'dry-run-pending',
        name: options.filename || buildPendingFileName({
          messageKey: options.metadata && options.metadata.messageKey,
          tag: options.metadata && options.metadata.tag,
          messageDate: options.messageDate,
          mimeType: options.mimeType,
          originalFilename: options.originalFilename,
          timeZone: config.timeZone,
        }),
        appProperties: options.metadata || {},
        folderPath: pendingRootFolder.folderPath,
      };
    }

    const file = await createPendingFile(drive, {
      ...options,
      pendingDayFolderId: pendingRootFolder.id,
      timeZone: config.timeZone,
    });

    return {
      ...file,
      folderPath: pendingRootFolder.folderPath,
    };
  }

  async function listAllPendingFiles() {
    const pendingRootFolder = await resolvePendingRootFolder({ create: false });
    if (!pendingRootFolder) {
      return {
        folder: null,
        files: [],
      };
    }

    if (config.dryRun || !config.safety.allowRealDriveUploads) {
      return {
        folder: pendingRootFolder,
        files: [],
      };
    }

    return {
      folder: pendingRootFolder,
      files: await listPendingFilesForDate(drive, pendingRootFolder.id),
    };
  }

  async function copyPendingToEntrantes(pendingFile) {
    const metadata = parsePendingAppProperties(pendingFile && pendingFile.appProperties);
    const messageDate = dateFromPendingMetadata(metadata);
    const mime = metadata.mimeType || pendingFile.mimeType;
    const uploadFolder = await resolveUploadFolder({
      date: new Date(),
    });

    if (config.dryRun || !config.safety.allowRealDriveUploads) {
      const filenameInfo = await buildFilenameForUploadFolder({ id: uploadFolder.id }, mime, {
        sequentialFilename: true,
        date: messageDate,
        tag: metadata.tag,
        media: { mimetype: mime, filename: pendingFile.name },
      });
      return {
        id: 'dry-run-pending-copy',
        filename: filenameInfo.filename,
        sequenceId: filenameInfo.sequenceId,
        folderPath: uploadFolder.logicalPath,
      };
    }

    return withFolderLock(uploadFolder.id, async () => {
      const filenameInfo = await buildFilenameForUploadFolder(uploadFolder, mime, {
        sequentialFilename: true,
        date: messageDate,
        tag: metadata.tag,
        media: { mimetype: mime, filename: pendingFile.name },
      });

      const res = await drive.files.copy({
        fileId: pendingFile.id,
        requestBody: {
          name: filenameInfo.filename,
          parents: [uploadFolder.id],
        },
        fields: 'id, webViewLink',
        supportsAllDrives: true,
      });

      return {
        ...res.data,
        filename: filenameInfo.filename,
        sequenceId: filenameInfo.sequenceId,
        folderPath: uploadFolder.logicalPath,
      };
    });
  }

  async function markPendingUploadStatus(fileId, status, patch = {}) {
    if (config.dryRun || !config.safety.allowRealDriveUploads) {
      return { id: fileId, appProperties: { pendingStatus: status, ...patch } };
    }
    return markPendingStatus(drive, fileId, status, patch);
  }

  async function deletePendingUpload(fileId) {
    if (config.dryRun || !config.safety.allowRealDriveUploads) return;
    await deletePendingFile(drive, fileId);
  }

  async function cleanupEmptyPendingDayFolder() {
    return false;
  }

  return {
    cleanupEmptyPendingDayFolder,
    createPendingUpload,
    copyPendingToEntrantes,
    deletePendingUpload,
    findPendingByMessageKey,
    listAllPendingFiles,
    markPendingUploadStatus,
    resolveUploadFolder,
    resolvePendingRootFolder,
    uploadWithRetry,
  };
}

module.exports = {
  buildDriveFolderPath,
  createDriveService,
  dateFromOperationalDate,
  escapeDriveQueryString,
  extractSequentialIdFromName,
  getNextSequentialUploadId,
};
