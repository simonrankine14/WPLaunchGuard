'use strict';

/**
 * Shared HTML utility helpers.
 *
 * SEC-002 / SEC-005: Centralised safeHtml() ensures every reporting file
 * escapes user-controlled content consistently, eliminating the risk of
 * divergence between local copies and closing XSS vectors.
 */

/**
 * Escape a value for safe inclusion in HTML content or attribute values.
 * Handles &, <, >, ", and ' so that attacker-supplied strings cannot break
 * out of their context regardless of where the output appears in the markup.
 *
 * @param {*} str - Any value; will be coerced to string.
 * @returns {string} HTML-escaped string.
 */
function safeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Build an HTML attribute string from a plain object.
 * Every key and value is safeHtml-escaped.
 *
 * @param {Record<string, *>} attrs
 * @returns {string}
 */
function htmlAttrs(attrs) {
  return Object.entries(attrs || {})
    .map(([k, v]) => `${safeHtml(k)}="${safeHtml(v)}"`)
    .join(' ');
}

module.exports = { safeHtml, htmlAttrs };
