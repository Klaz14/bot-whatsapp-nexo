const {
  DEFAULT_PENDING_ROOT_NAME,
  findPendingRootFolder,
  listPendingDayFolders,
  listPendingFilesForDate,
  parsePendingAppProperties,
} = require('./pendingDriveService');
const { maskSensitiveText } = require('../utils/mask');
const { sanitizeDriveFolderName, sanitizeFilenamePart, sanitizeTag } = require('../utils/sanitize');

const STATUS_KEYS = ['queued', 'processing', 'uploaded', 'failed'];

function createEmptyStatusCounts() {
  return {
    queued: 0,
    processing: 0,
    uploaded: 0,
    failed: 0,
    other: 0,
  };
}

function sanitizePendingAuditFile(file = {}) {
  const metadata = parsePendingAppProperties(file.appProperties || {});
  const rawStatus = String((file.appProperties && file.appProperties.pendingStatus) || '').toLowerCase();
  const status = STATUS_KEYS.includes(rawStatus) ? rawStatus : 'other';

  return {
    name: sanitizeFilenamePart(file.name, 'pending', 120),
    status,
    attempts: Number.isFinite(metadata.attempts) ? metadata.attempts : 0,
    operationalDate: sanitizeFilenamePart(metadata.operationalDate, 'unknown', 20),
    groupFolderName: sanitizeDriveFolderName(metadata.groupFolderName, 'grupo', 80),
    tag: sanitizeTag(metadata.tag),
    lastError: metadata.lastError ? maskSensitiveText(metadata.lastError, 120) : '',
  };
}

function summarizePendingFolder(folder = {}, files = []) {
  const counts = createEmptyStatusCounts();
  const details = [];

  for (const file of files) {
    const safeFile = sanitizePendingAuditFile(file);
    counts[safeFile.status] = (counts[safeFile.status] || 0) + 1;
    if (['queued', 'processing', 'failed'].includes(safeFile.status)) {
      details.push(safeFile);
    }
  }

  return {
    folderName: sanitizeDriveFolderName(folder.name, 'pending-day', 80),
    total: files.length,
    counts,
    details,
  };
}

function formatPendingAuditReport(summary = {}) {
  const lines = [];
  lines.push(`[PENDING AUDIT] root ${summary.rootFound ? 'found' : 'missing'}: ${sanitizeDriveFolderName(summary.rootName || DEFAULT_PENDING_ROOT_NAME, 'pendientes', 80)}`);

  if (!summary.rootFound) return lines;
  if (!summary.folders || summary.folders.length === 0) {
    lines.push('[PENDING AUDIT] no pending day folders found');
    return lines;
  }

  for (const folder of summary.folders) {
    lines.push(
      `[PENDING AUDIT] folder ${folder.folderName}: ` +
      `${folder.counts.queued} queued, ` +
      `${folder.counts.processing} processing, ` +
      `${folder.counts.failed} failed, ` +
      `${folder.counts.uploaded} uploaded, ` +
      `${folder.counts.other} other`
    );

    for (const file of folder.details) {
      const error = file.lastError ? ` error="${file.lastError}"` : '';
      lines.push(
        `[PENDING AUDIT] ${file.status} ${file.name} ` +
        `attempts=${file.attempts} operationalDate=${file.operationalDate} ` +
        `group=${file.groupFolderName} tag=${file.tag}${error}`
      );
    }
  }

  return lines;
}

async function auditPendingTransfers(drive, options = {}) {
  const root = await findPendingRootFolder(drive, {
    pendingFolderId: options.pendingFolderId,
    parentFolderId: options.parentFolderId,
    pendingRootName: options.pendingRootName || DEFAULT_PENDING_ROOT_NAME,
  });

  if (!root) {
    return {
      rootFound: false,
      rootName: options.pendingRootName || DEFAULT_PENDING_ROOT_NAME,
      folders: [],
    };
  }

  const dayFolders = await listPendingDayFolders(drive, root.id);
  const folders = [];

  for (const folder of dayFolders) {
    const files = await listPendingFilesForDate(drive, folder.id);
    folders.push(summarizePendingFolder(folder, files));
  }

  return {
    rootFound: true,
    rootName: root.name || options.pendingRootName || DEFAULT_PENDING_ROOT_NAME,
    folders,
  };
}

module.exports = {
  auditPendingTransfers,
  formatPendingAuditReport,
  sanitizePendingAuditFile,
  summarizePendingFolder,
};
