const fs = require('fs');
const { Readable } = require('stream');
const { google } = require('googleapis');
const { maskSensitiveText } = require('../utils/mask');
const { sanitizeDriveFolderName } = require('../utils/sanitize');
const { buildSequentialUploadFilename } = require('../utils/fileNames');
const {
  formatLocalDayForDriveFolder,
  formatLocalMonthForDriveFolder,
} = require('../utils/time');

const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const SEQUENTIAL_UPLOAD_FILENAME_RE = /^(\d+)_([01]\d|2[0-3])([0-5]\d)_[A-Za-z0-9][A-Za-z0-9_-]*\.[A-Za-z0-9]+$/;

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

function buildDriveFolderPath(groupName, date, timeZone) {
  const groupFolderName = sanitizeDriveFolderName(groupName, 'grupo');
  const monthFolderName = formatLocalMonthForDriveFolder(date, timeZone);
  const dayFolderName = formatLocalDayForDriveFolder(date, timeZone);

  return {
    groupFolderName,
    monthFolderName,
    dayFolderName,
    logicalPath: `${groupFolderName}/${monthFolderName}/${dayFolderName}`,
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
    const folderPath = buildDriveFolderPath(options.groupName, date, config.timeZone);

    if (config.dryRun || !config.safety.allowRealDriveUploads) {
      return {
        id: config.google.driveFolderId,
        ...folderPath,
      };
    }

    const groupFolder = await getOrCreateFolder(config.google.driveFolderId, folderPath.groupFolderName);
    const monthFolder = await getOrCreateFolder(groupFolder.id, folderPath.monthFolderName);
    const dayFolder = await getOrCreateFolder(monthFolder.id, folderPath.dayFolderName);

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
      const folderPath = buildDriveFolderPath(options.groupName, options.date || new Date(), config.timeZone);
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

  return {
    resolveUploadFolder,
    uploadWithRetry,
  };
}

module.exports = {
  buildDriveFolderPath,
  createDriveService,
  escapeDriveQueryString,
  extractSequentialIdFromName,
  getNextSequentialUploadId,
};
