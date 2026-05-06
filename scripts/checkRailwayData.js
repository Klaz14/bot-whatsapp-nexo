const fs = require('fs');
const path = require('path');

const DEFAULT_DATA_DIR = '/data';

const REQUIRED_ITEMS = [
  { label: 'data dir', relativePath: '', type: 'dir' },
  { label: 'credentials', relativePath: 'credentials.json', type: 'file' },
  { label: 'token', relativePath: 'token.json', type: 'file' },
  { label: 'config', relativePath: 'config.json', type: 'file' },
  { label: 'business calendar', relativePath: 'business-calendar.json', type: 'file' },
  { label: 'blocked senders', relativePath: 'blocked-senders.json', type: 'file' },
  { label: 'whatsapp auth', relativePath: '.wwebjs_auth', type: 'dir' },
  { label: 'logs dir', relativePath: 'logs', type: 'dir' },
];

function resolveDataPath(dataDir, relativePath) {
  return relativePath ? path.join(dataDir, relativePath) : dataDir;
}

function describeItem(itemPath, expectedType) {
  if (!fs.existsSync(itemPath)) {
    return { status: 'missing' };
  }

  const stat = fs.statSync(itemPath);
  const actualType = stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other';
  const typeMatches = actualType === expectedType;

  return {
    status: typeMatches ? 'ok' : 'type-mismatch',
    actualType,
    size: stat.isFile() ? stat.size : undefined,
    modifiedAt: stat.mtime.toISOString(),
  };
}

function formatResult(item, itemPath, result) {
  const safePath = itemPath.replace(/\\/g, '/');
  if (result.status === 'missing') {
    return `[RAILWAY DATA] missing ${item.label}: ${safePath}`;
  }
  if (result.status === 'type-mismatch') {
    return `[RAILWAY DATA] type mismatch ${item.label}: expected=${item.type} actual=${result.actualType} path=${safePath}`;
  }

  const size = result.size === undefined ? '' : ` size=${result.size}B`;
  return `[RAILWAY DATA] ok ${item.label}: type=${result.actualType}${size} modified=${result.modifiedAt}`;
}

function main() {
  const dataDir = process.env.DATA_DIR || DEFAULT_DATA_DIR;
  let missing = 0;
  let mismatched = 0;

  console.log(`[RAILWAY DATA] checking ${dataDir}`);

  for (const item of REQUIRED_ITEMS) {
    const itemPath = resolveDataPath(dataDir, item.relativePath);
    const result = describeItem(itemPath, item.type);
    if (result.status === 'missing') missing += 1;
    if (result.status === 'type-mismatch') mismatched += 1;
    console.log(formatResult(item, itemPath, result));
  }

  console.log(`[RAILWAY DATA] summary missing=${missing} typeMismatch=${mismatched}`);
}

main();
