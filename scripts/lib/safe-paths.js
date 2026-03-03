const fs = require('fs');
const path = require('path');

const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;

function validateClientId(rawValue, fieldName = 'client name') {
  const value = String(rawValue || '').trim();
  if (!CLIENT_ID_PATTERN.test(value)) {
    throw new Error(
      `Invalid ${fieldName}: "${rawValue}". Use 2-64 chars: letters, numbers, "_" or "-", and start with a letter/number.`
    );
  }
  return value;
}

function ensureWithin(basePath, targetPath) {
  const base = path.resolve(basePath);
  const target = path.resolve(targetPath);
  const baseWithSep = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
  if (target !== base && !target.startsWith(baseWithSep)) {
    throw new Error(`Resolved path escapes base directory. Base: ${base} Target: ${target}`);
  }
  return target;
}

function resolveWithin(basePath, ...segments) {
  return ensureWithin(basePath, path.resolve(basePath, ...segments));
}

function resolveRunRoot(env, fallbackPath) {
  return env && env.LAUNCHGUARD_ROOT
    ? path.resolve(env.LAUNCHGUARD_ROOT)
    : path.resolve(fallbackPath);
}

function resolveReportsRoot(runRoot) {
  return path.join(path.resolve(runRoot), 'reports');
}

function resolveClientReportsDir(runRoot, clientId, ...segments) {
  const safeClientId = validateClientId(clientId);
  return resolveWithin(resolveReportsRoot(runRoot), safeClientId, ...segments);
}

function resolveClientDataFile(runRoot, clientId) {
  const safeClientId = validateClientId(clientId);
  const root = path.resolve(runRoot);
  const lowerDir = path.join(root, 'data', 'clients');
  const upperDir = path.join(root, 'data', 'Clients');
  const lowerFile = path.join(lowerDir, `${safeClientId}.json`);
  const upperFile = path.join(upperDir, `${safeClientId}.json`);

  if (fs.existsSync(lowerFile)) {
    return resolveWithin(lowerDir, `${safeClientId}.json`);
  }
  if (fs.existsSync(upperFile)) {
    return resolveWithin(upperDir, `${safeClientId}.json`);
  }
  if (fs.existsSync(upperDir) && !fs.existsSync(lowerDir)) {
    return resolveWithin(upperDir, `${safeClientId}.json`);
  }
  return resolveWithin(lowerDir, `${safeClientId}.json`);
}

module.exports = {
  CLIENT_ID_PATTERN,
  ensureWithin,
  resolveClientDataFile,
  resolveClientReportsDir,
  resolveReportsRoot,
  resolveRunRoot,
  resolveWithin,
  validateClientId
};
