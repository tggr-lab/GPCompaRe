/**
 * Search v2: text normalisation for the query parser (pure, no DOM, no network).
 *
 * Two jobs:
 * - `normalizeQuery(raw)`: make a typed query safe to read with ASCII regexes. Full-width and other
 *   compatibility characters fold to ASCII (NFKC), every dash becomes '-', every arrow becomes '>',
 *   '×' becomes 'x', quotes and zero-width characters go, whitespace (tabs, NBSP) collapses to one
 *   space, and a trailing ';' or ',' is dropped. Case is kept: the parsers are case-insensitive, and
 *   receptor terms are shown back to the reader as typed.
 * - `aliasKey(term)`: the canonical key for matching a receptor name against an alias table
 *   (lower case, Greek letters spelled out, punctuation and spaces removed). The alias table must be
 *   keyed with the same function.
 *
 * @module search/normalize
 */

/** Every dash-like character that readers paste instead of '-'. */
const DASHES = /[‐‑‒–—―−﹘﹣－]/g;
/** Arrow characters and ASCII arrows, all read as '>' (M159→I). */
const ARROWS = /\s*(?:[→⇒➔➜➝➡⟶⟹↦⭢›]|->|=>)\s*/g;
/** Characters that carry no meaning in a query. */
const INVISIBLE = /[​-‍⁠﻿­]/g;
const QUOTES = /[\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F\u00AB\u00BB"'`]/g;

/** Greek letters as their names, for receptor terms (β2AR -> beta2AR). Lower and upper case. */
export const GREEK = Object.freeze({
  α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon', κ: 'kappa', λ: 'lambda', μ: 'mu', µ: 'mu',
  ν: 'nu', π: 'pi', σ: 'sigma', τ: 'tau', ω: 'omega',
  Α: 'alpha', Β: 'beta', Γ: 'gamma', Δ: 'delta', Ε: 'epsilon', Κ: 'kappa', Λ: 'lambda', Μ: 'mu',
  Ν: 'nu', Π: 'pi', Σ: 'sigma', Τ: 'tau', Ω: 'omega',
});
const GREEK_RE = new RegExp(`[${Object.keys(GREEK).join('')}]`, 'g');

/**
 * Normalise a raw query string for parsing.
 *
 * Note that NFKC folds the micro sign to Greek mu and full-width letters to ASCII, but leaves Greek
 * letters themselves alone; they stay in receptor terms and `aliasKey` spells them out. The one
 * exception is a capital or small delta directly before digits (`CCR5-Δ32`), which becomes the
 * word `delta` so the deletion reading can see it.
 *
 * @param {unknown} raw what the reader typed (non-strings read as empty)
 * @returns {string} the normalised query; '' when nothing readable is left
 */
export function normalizeQuery(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.normalize('NFKC');
  s = s.replace(INVISIBLE, '').replace(QUOTES, '');
  s = s.replace(DASHES, '-').replace(ARROWS, '>').replace(/×/g, 'x');
  s = s.replace(/[Δδ](?=\d)/g, ' delta').replace(/-\s*delta(?=\d)/gi, ' delta');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/\s*[;,]+$/, '').trim();
  return s;
}

/**
 * Canonical key for receptor-name matching: Greek letters spelled out, lower case, every character
 * that is not a letter or digit removed. `β2-AR`, `beta 2 AR` and `Beta2AR` share the key `beta2ar`;
 * `5-HT1A` and `5HT1A` share `5ht1a`. Synonym pairs that differ in more than spelling (`B2AR` and
 * `beta2AR`) are the alias table's job.
 *
 * @param {string} term a receptor name, symbol or identifier
 * @returns {string}
 */
export function aliasKey(term) {
  return normalizeQuery(String(term ?? ''))
    .replace(GREEK_RE, (c) => GREEK[c])
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Strip thousands separators from a run of digits (`76,833,084` -> `76833084`). Only digit groups of
 * exactly three after each comma are joined, so `PAR2, M159I` is left alone.
 *
 * @param {string} s
 * @returns {string}
 */
export function stripDigitCommas(s) {
  return s.replace(/\b(\d{1,3})((?:,\d{3})+)\b/g, (_, a, b) => a + b.replace(/,/g, ''));
}

/**
 * True when a string reads as a name (receptor symbol, common name, accession): it starts with a
 * letter or digit, contains at least one letter, and uses only letters, digits, spaces and the
 * punctuation found in receptor names (`-`, `_`, `.`, `'`, `/`, `+`).
 *
 * @param {string} s
 * @returns {boolean}
 */
export function isNameShaped(s) {
  return s.length > 0 && s.length <= 80 && /^[\p{L}\p{N}][\p{L}\p{N} ._'/+-]*$/u.test(s) && /\p{L}/u.test(s);
}
