const fs = require('fs');
const { Readable } = require('stream');
const { google } = require('googleapis');
const { maskSensitiveText } = require('../utils/mask');
const { buildSequentialUploadFilename } = require('../utils/fileNames');
const { getPdfPageCount, convertPdfPageRangeToJpgs } = require('../utils/pdfConverter');
const { isRetryableDriveError, retryWaitMs, httpStatusOf } = require('../utils/driveRetry');
const {
  formatLocalDayMonthForFilename,
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

// V0.6: estructura plana — los archivos van directo a la raíz de Drive.
function buildDriveFolderPath() {
  return { logicalPath: '/' };
}

function extractSequentialIdFromName(name) {
  const match = SEQUENTIAL_UPLOAD_FILENAME_RE.exec(String(name || ''));
  if (!match) return null;

  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// V0.6: ID por día via DDMM del filename. ddmm opcional — sin él, comportamiento legacy.
// Listado simple: volumen esperado es decenas a cientos de archivos por día, sin paginación extra.
function getNextSequentialUploadId(fileNames, ddmm) {
  const maxId = (fileNames || [])
    .map((name) => {
      const match = SEQUENTIAL_UPLOAD_FILENAME_RE.exec(String(name || ''));
      if (!match) return null;
      if (ddmm && match[2] !== ddmm) return null;
      const id = Number(match[1]);
      return Number.isSafeInteger(id) && id > 0 ? id : null;
    })
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
  const folderLocks = new Map();

  // V0.6: estructura plana — retorna la raíz directamente, sin subcarpeta.
  async function resolveUploadFolder() {
    return {
      id: config.google.driveFolderId,
      logicalPath: '/',
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
    const ddmm = formatLocalDayMonthForFilename(options.date, config.timeZone);
    const sequenceId = getNextSequentialUploadId(existingNames, ddmm);
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
        if (i < attempts && isRetryableDriveError(err)) {
          const wait = retryWaitMs(err, i);
          console.warn(`[upload] intento ${i}/${attempts} fallo (transitorio ${httpStatusOf(err) || 'net'}): ${maskSensitiveText(err.message)}. Reintento en ${wait}ms`);
          await new Promise((resolve) => setTimeout(resolve, wait));
        } else {
          if (!isRetryableDriveError(err)) {
            console.warn(`[upload] error permanente (${httpStatusOf(err) || 'net'}): ${maskSensitiveText(err.message)}. No se reintenta, se propaga.`);
          }
          break; // permanente o ultimo intento -> propagar (el handler reencola a pending)
        }
      }
    }
    throw lastErr;
  }

  // Sube un PDF rasterizando cada página a JPEG, asignando el MISMO ID
  // secuencial a todas las páginas y diferenciándolas con sufijo _<pageNumber>.
  // Best-effort por página: una página que agota reintentos no aborta el resto.
  // options.onlyPages (array de nros de pagina) + options.baseId permiten reintentar en vivo
  // SOLO las paginas que fallaron, reusando el mismo ID (B2), sin duplicar las ya subidas.
  async function uploadPdfPagesWithRetry(pdfBuffer, mime, options = {}) {
    const batchSize = (config.pdf && config.pdf.batchSize) || 30;
    const onlyPages = options.onlyPages ? new Set(options.onlyPages) : null;

    if (config.dryRun || !config.safety.allowRealDriveUploads) {
      const pageCount = await getPdfPageCount(pdfBuffer);
      const folderPath = buildDriveFolderPath(options.date || new Date(), config.timeZone);
      const uploaded = [];
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
        if (onlyPages && !onlyPages.has(pageNumber)) continue;
        uploaded.push({
          filename: buildSequentialUploadFilename({
            id: options.baseId || 1,
            date: options.date,
            tag: options.tag,
            media: { ...options.media, mimetype: mime },
            timeZone: config.timeZone,
            pageNumber: pageCount > 1 ? pageNumber : undefined,
          }),
          pageNumber,
          id: 'dry-run',
          webViewLink: '',
        });
      }
      console.warn('[upload] subida multi-pagina a Drive bloqueada por configuracion de seguridad.');
      return {
        uploaded,
        failed: [],
        baseId: options.baseId || 1,
        pageCount,
        folderPath: folderPath.logicalPath,
      };
    }

    const uploadFolder = await resolveUploadFolder(options);
    const pageCount = await getPdfPageCount(pdfBuffer);

    return withFolderLock(uploadFolder.id, async () => {
      const existingNames = await listFileNamesInFolder(uploadFolder.id);
      const ddmm = formatLocalDayMonthForFilename(options.date, config.timeZone);
      // B2: en un reintento se reusa el baseId original para no duplicar las paginas ya subidas.
      const baseId = options.baseId || getNextSequentialUploadId(existingNames, ddmm);

      const uploaded = [];
      const failed = [];

      for (let from = 1; from <= pageCount; from += batchSize) {
        const to = Math.min(from + batchSize - 1, pageCount);

        // B2: si solo reintentamos algunas paginas, saltear lotes que no contienen ninguna.
        if (onlyPages) {
          let anyInBatch = false;
          for (let p = from; p <= to; p++) { if (onlyPages.has(p)) { anyInBatch = true; break; } }
          if (!anyInBatch) continue;
        }

        let pages;
        try {
          pages = await convertPdfPageRangeToJpgs(pdfBuffer, from, to);
        } catch (batchErr) {
          const reason = maskSensitiveText(
            batchErr && batchErr.message ? batchErr.message : 'batch conversion failed'
          );
          for (let p = from; p <= to; p++) {
            if (onlyPages && !onlyPages.has(p)) continue;
            failed.push({ pageNumber: p, error: reason });
          }
          continue;
        }

        for (const page of pages) {
          if (onlyPages && !onlyPages.has(page.pageNumber)) continue; // B2: subir solo las pedidas
          const filename = buildSequentialUploadFilename({
            id: baseId,
            date: options.date,
            tag: options.tag,
            media: { ...options.media, mimetype: mime },
            timeZone: config.timeZone,
            pageNumber: pageCount > 1 ? page.pageNumber : undefined,
          });

          let lastErr;
          let pageResult = null;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const res = await drive.files.create({
                requestBody: {
                  name: filename,
                  parents: [uploadFolder.id],
                },
                media: {
                  mimeType: mime,
                  body: Readable.from(page.buffer),
                },
                fields: 'id, webViewLink',
                supportsAllDrives: true,
              });
              pageResult = {
                filename,
                pageNumber: page.pageNumber,
                id: res.data.id,
                webViewLink: res.data.webViewLink,
              };
              break;
            } catch (err) {
              lastErr = err;
              if (attempt < 3 && isRetryableDriveError(err)) {
                const wait = retryWaitMs(err, attempt);
                console.warn(`[upload] pagina ${page.pageNumber} intento ${attempt}/3 fallo (transitorio): ${maskSensitiveText(err.message)}. Reintento en ${wait}ms`);
                await new Promise((resolve) => setTimeout(resolve, wait));
              } else {
                break; // permanente o ultimo intento
              }
            }
          }

          if (pageResult) {
            uploaded.push(pageResult);
          } else {
            failed.push({
              pageNumber: page.pageNumber,
              error: maskSensitiveText(lastErr && lastErr.message ? lastErr.message : 'unknown error'),
            });
          }
        }
        // Los buffers del lote salen de scope al terminar la iteración -> liberables.
      }

      return {
        uploaded,
        failed,
        baseId,
        pageCount,
        folderPath: uploadFolder.logicalPath,
      };
    });
  }

  async function downloadFileAsBuffer(fileId) {
    if (config.dryRun || !config.safety.allowRealDriveUploads) {
      return Buffer.alloc(0);
    }
    const res = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );
    return Buffer.from(res.data);
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

  // Auditoria de cierre: IDs ya subidos a Entrantes para la fecha dada (por DDMM del
  // filename). Sirve para detectar huecos en la secuencia diaria.
  async function listUploadedIdsForDate(date = new Date()) {
    if (config.dryRun || !config.safety.allowRealDriveUploads) return [];
    const uploadFolder = await resolveUploadFolder({});
    const names = await listFileNamesInFolder(uploadFolder.id);
    const ddmm = formatLocalDayMonthForFilename(date, config.timeZone);
    const ids = [];
    for (const name of names) {
      const m = SEQUENTIAL_UPLOAD_FILENAME_RE.exec(String(name || ''));
      if (m && m[2] === ddmm) {
        const id = Number(m[1]);
        if (Number.isSafeInteger(id) && id > 0) ids.push(id);
      }
    }
    return ids.sort((a, b) => a - b);
  }

  return {
    cleanupEmptyPendingDayFolder,
    listUploadedIdsForDate,
    createPendingUpload,
    copyPendingToEntrantes,
    deletePendingUpload,
    downloadFileAsBuffer,
    findPendingByMessageKey,
    listAllPendingFiles,
    markPendingUploadStatus,
    resolveUploadFolder,
    resolvePendingRootFolder,
    uploadWithRetry,
    uploadPdfPagesWithRetry,
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
