const { buildPendingFolderName, parsePendingAppProperties } = require('./pendingDriveService');
const {
  getOperationalDateForMessage,
  isWithinBusinessHours,
  loadBusinessCalendar,
} = require('../utils/businessCalendar');
const { maskSensitiveText } = require('../utils/mask');

function notifySafely(operationalNotifier, level, eventType, message, details = {}, options = {}) {
  if (!operationalNotifier || typeof operationalNotifier[level] !== 'function') return;
  operationalNotifier[level](eventType, message, details, options).catch((err) => {
    console.warn(`[PENDING ALERT] no se pudo enviar alerta ${eventType}: ${maskSensitiveText(err && err.message)}`);
  });
}

function shouldRunPendingProcessor(now, calendar) {
  return isWithinBusinessHours(now, calendar);
}

function validatePendingMetadata(metadata) {
  const missing = [];
  for (const field of ['messageKey', 'groupFolderName', 'tag', 'mimeType', 'operationalDate']) {
    if (!metadata[field]) missing.push(field);
  }
  return missing;
}

function isPendingRetryable(metadata, maxAttempts) {
  if (metadata.pendingStatus === 'queued') return true;
  if (metadata.pendingStatus !== 'failed') return false;
  return metadata.attempts < maxAttempts;
}

async function markPendingFailed(driveService, file, metadata, err) {
  const attempts = Number.isFinite(metadata.attempts) ? metadata.attempts + 1 : 1;
  await driveService.markPendingUploadStatus(file.id, 'failed', {
    attempts,
    lastError: err && err.message ? err.message : String(err),
  });
  return attempts;
}

async function processSinglePendingFile({ driveService, processedStore, file, operationalNotifier, maxAttempts = 3 }) {
  const metadata = parsePendingAppProperties(file.appProperties);
  const missing = validatePendingMetadata(metadata);
  if (missing.length) {
    const err = new Error(`Metadata pendiente incompleta: ${missing.join(', ')}`);
    const attempts = await markPendingFailed(driveService, file, metadata, err);
    notifySafely(
      operationalNotifier,
      'notifyError',
      'pending_invalid_metadata',
      'Un pendiente tiene metadata invalida y requiere revision.',
      {
        file: file.name,
        attempts,
        missing: missing.join(', '),
        error: err,
      }
    );
    return {
      ok: false,
      skipped: false,
      error: err,
      fileName: file.name,
    };
  }

  try {
    if (processedStore.has(metadata.messageKey)) {
      await driveService.markPendingUploadStatus(file.id, 'uploaded');
      await driveService.deletePendingUpload(file.id);
      return {
        ok: true,
        skipped: true,
        fileName: file.name,
      };
    }

    await driveService.markPendingUploadStatus(file.id, 'processing', {
      attempts: metadata.attempts,
    });

    const result = await driveService.copyPendingToEntrantes(file);
    try {
      processedStore.markProcessed(metadata.messageKey, { status: 'uploaded' });
    } catch (storeErr) {
      notifySafely(
        operationalNotifier,
        'notifyError',
        'processed_store_write_failed',
        'Pendiente copiado a Entrantes, pero no se pudo actualizar idempotencia local.',
        {
          file: file.name,
          finalFilename: result.filename,
          folderPath: result.folderPath,
          error: storeErr,
        }
      );
      throw storeErr;
    }
    await driveService.markPendingUploadStatus(file.id, 'uploaded');
    try {
      await driveService.deletePendingUpload(file.id);
    } catch (deleteErr) {
      notifySafely(
        operationalNotifier,
        'notifyWarning',
        'pending_delete_failed',
        'Pendiente copiado a Entrantes pero no se pudo borrar el archivo temporal.',
        {
          file: file.name,
          finalFilename: result.filename,
          folderPath: result.folderPath,
          error: deleteErr,
        }
      );
    }

    return {
      ok: true,
      skipped: false,
      fileName: file.name,
      finalFilename: result.filename,
      folderPath: result.folderPath,
    };
  } catch (err) {
    let attempts = Number.isFinite(metadata.attempts) ? metadata.attempts + 1 : 1;
    try {
      attempts = await markPendingFailed(driveService, file, metadata, err);
    } catch (markErr) {
      notifySafely(
        operationalNotifier,
        'notifyError',
        'pending_mark_failed_failed',
        'Fallo procesando pendiente y tambien fallo marcarlo como failed.',
        {
          file: file.name,
          error: markErr,
        }
      );
    }

    const exhausted = attempts >= maxAttempts;
    notifySafely(
      operationalNotifier,
      exhausted ? 'notifyError' : 'notifyWarning',
      exhausted ? 'pending_attempts_exhausted' : 'pending_failed_retryable',
      exhausted
        ? 'Pendiente agoto intentos y requiere intervencion.'
        : 'Pendiente fallo pero queda para reintento.',
      {
        file: file.name,
        attempts: `${attempts}/${maxAttempts}`,
        group: metadata.groupFolderName,
        tag: metadata.tag,
        error: err,
      }
    );
    return {
      ok: false,
      skipped: false,
      error: err,
      fileName: file.name,
    };
  }
}

async function processPendingForOperationalDate({
  config,
  driveService,
  processedStore,
  operationalNotifier,
  now = new Date(),
  calendar,
} = {}) {
  const activeCalendar = calendar || loadBusinessCalendar(config.paths.businessCalendar, {
    onWarning: (warning) => {
      notifySafely(
        operationalNotifier,
        'notifyWarning',
        'business_calendar_defaults',
        'Calendario laboral no disponible o invalido; usando defaults.',
        { reason: warning && warning.reason },
        { dedupeKey: 'business-calendar-defaults' }
      );
    },
  });
  if (!shouldRunPendingProcessor(now, activeCalendar)) {
    console.log('[PENDING PROCESSOR] skipped outside business hours');
    return {
      skipped: true,
      processed: 0,
      failed: 0,
    };
  }

  const operationalDate = getOperationalDateForMessage(now, activeCalendar);
  const folderName = buildPendingFolderName(operationalDate, activeCalendar.timeZone);
  console.log(`[PENDING PROCESSOR] processing ${folderName}`);
  if (!config.google.pendingFolderId) {
    notifySafely(
      operationalNotifier,
      'notifyWarning',
      'pending_folder_fallback',
      'Carpeta de pendientes sin ID explicito; se usa busqueda por nombre.',
      {},
      { dedupeKey: 'pending-folder-fallback' }
    );
  }

  const { folder, files } = await driveService.listPendingForOperationalDate(operationalDate);
  const retryableFiles = files.filter((file) => {
    const metadata = parsePendingAppProperties(file.appProperties);
    return isPendingRetryable(metadata, config.pendingProcessor.maxAttempts);
  });

  if (!folder || retryableFiles.length === 0) {
    const cleaned = folder ? await driveService.cleanupEmptyPendingDayFolder(folder) : false;
    if (cleaned) {
      console.log(`[PENDING CLEANUP] removed empty folder ${folderName}`);
    }
    return {
      skipped: false,
      processed: 0,
      failed: 0,
      folderName,
      cleaned,
    };
  }

  let processed = 0;
  let failed = 0;
  for (const file of retryableFiles) {
    const result = await processSinglePendingFile({
      driveService,
      processedStore,
      file,
      operationalNotifier,
      maxAttempts: config.pendingProcessor.maxAttempts,
    });
    if (result.ok) {
      processed += 1;
      if (result.skipped) {
        console.log(`[PENDING OK] duplicate already processed -> ${maskSensitiveText(result.fileName, 120)}`);
      } else {
        console.log(`[PENDING OK] ${folderName} -> ${result.folderPath}/${result.finalFilename}`);
      }
    } else {
      failed += 1;
      console.error(`[PENDING ERROR] ${maskSensitiveText(result.fileName, 120)}: ${maskSensitiveText(result.error && result.error.message)}`);
    }
  }

  const cleaned = await driveService.cleanupEmptyPendingDayFolder(folder);
  if (cleaned) {
    console.log(`[PENDING CLEANUP] removed empty folder ${folderName}`);
  }

  return {
    skipped: false,
    processed,
    failed,
    folderName,
    cleaned,
  };
}

function createPendingProcessor({ config, driveService, processedStore, operationalNotifier }) {
  let running = false;
  let timer;

  async function runOnce(now = new Date()) {
    if (running) {
      return {
        skipped: true,
        reason: 'already-running',
      };
    }

    running = true;
    try {
      return await processPendingForOperationalDate({
        config,
        driveService,
        processedStore,
        operationalNotifier,
        now,
      });
    } catch (err) {
      console.error('[PENDING PROCESSOR] error:', maskSensitiveText(err && err.message));
      notifySafely(
        operationalNotifier,
        'notifyError',
        'pending_processor_error',
        'Error general en el procesador de pendientes.',
        { error: err }
      );
      return {
        skipped: false,
        error: err,
      };
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    runOnce();
    const minutes = config.pendingProcessor.intervalMinutes;
    timer = setInterval(() => {
      runOnce();
    }, minutes * 60 * 1000);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
  }

  return {
    runOnce,
    start,
    stop,
  };
}

module.exports = {
  createPendingProcessor,
  processPendingForOperationalDate,
  processSinglePendingFile,
  isPendingRetryable,
  shouldRunPendingProcessor,
};
