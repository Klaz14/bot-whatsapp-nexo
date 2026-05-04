const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function resolveProjectPath(value, fallback) {
  const candidate = value || fallback;
  if (!candidate) return undefined;
  return path.isAbsolute(candidate)
    ? candidate
    : path.join(PROJECT_ROOT, candidate);
}

module.exports = {
  PROJECT_ROOT,
  resolveProjectPath,
};
