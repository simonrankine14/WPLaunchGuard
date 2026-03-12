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

function canonicalizePath(inputPath) {
  const absolute = path.resolve(inputPath);
  const missingSegments = [];
  let cursor = absolute;

  while (!fs.existsSync(cursor)) {
    missingSegments.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  let canonicalBase = cursor;
  try {
    canonicalBase = fs.realpathSync.native(cursor);
  } catch {
    canonicalBase = path.resolve(cursor);
  }

  return path.resolve(canonicalBase, ...missingSegments);
}

function ensureWithin(basePath, targetPath) {
  // SEC-007: Canonicalize both paths (including symlink resolution where
  // possible) and enforce containment via path.relative() to avoid prefix
  // bypasses and macOS /private/var alias mismatches.
  const base = canonicalizePath(basePath);
  const target = canonicalizePath(targetPath);
  const relative = path.relative(base, target);

  if (relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative))) {
    throw new Error(`Resolved path escapes base directory. Base: ${base} Target: ${target}`);
  }
  return target;
}

function resolveWithin(basePath, ...segments) {
  return ensureWithin(basePath, path.resolve(basePath, ...segments));
}

function resolveRunRoot(env, fallbackPath) {
  return env && env.BASELINE_ROOT
    ? path.resolve(env.BASELINE_ROOT)
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
