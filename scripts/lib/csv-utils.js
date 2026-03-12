'use strict';

/**
 * Shared CSV parsing and escaping utilities.
 *
 * CQ-007: parseCSV was duplicated across 5+ reporting and script files.
 * SEC-009: csvEscape now also guards the pipe character used by some
 *          Lotus/OpenOffice formula-injection variants.
 */

/**
 * Parse RFC 4180-compatible CSV content into an array of row objects.
 * The first row is treated as headers; subsequent rows are returned as
 * { [header]: value } objects.
 *
 * @param {string} content - Raw CSV string.
 * @returns {Array<Record<string, string>>}
 */
function parseCSV(content) {
  const rows = [];
  let row = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const next = content[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(current);
      current = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(current);
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      current = '';
    } else {
      current += char;
    }
  }

  if (current.length > 0 || row.length > 0) {
    row.push(current);
    rows.push(row);
  }

  if (rows.length === 0) return [];
  const headers = rows[0];
  return rows.slice(1).map((values) => {
    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = values[index] ?? '';
    });
    return obj;
  });
}

/**
 * Escape a single cell value for safe inclusion in a CSV file.
 *
 * SEC-009: Guards against formula-injection attacks (OWASP CSV Injection)
 * by prefixing dangerous leading characters with a single quote.
 * Extended to include '|' (Lotus-style injection), in addition to the
 * commonly-guarded '=', '+', '-', '@'.
 *
 * @param {*} value - Any value; will be coerced to string.
 * @returns {string}
 */
function csvEscape(value) {
  if (value === null || value === undefined) return '';
  let str = String(value);
  // Prefix any cell that could be interpreted as a spreadsheet formula.
  if (/^[\t\r\n ]*[=+\-@|]/.test(str)) {
    str = `'${str}`;
  }
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

module.exports = { parseCSV, csvEscape };
