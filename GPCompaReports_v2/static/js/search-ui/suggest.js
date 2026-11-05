/**
 * Search v2 UI: autocomplete for a search input (an ARIA 1.2 combobox with a listbox).
 *
 * Suggestions: recent queries (localStorage, optional), receptor names and aliases from the
 * search index's meta.json, generic residue numbers, and a receptor's CFR variant list ("ADRB2 CFR variants"). Nothing is fetched until the reader
 * focuses or types in the box.
 *
 *   attachSuggest(input, {indexUrl | loader, submit})
 *     indexUrl  absolute URL of the search2/ folder (or `loader`, a shared cached shard loader)
 *     submit    (query, item) => void; called when a suggestion is picked (default: submit the form)
 *
 * @module search-ui/suggest
 */

import { shardsFor } from '../search/shards.js';
import { makeLoader } from './loader.js';
import { aliasKey } from '../search/normalize.js';

const RECENT_KEY = 'gpcompare-search-recent';
const RECENT_MAX = 8;

/** Reference positions every reader knows; offered while typing a generic number. */
const LANDMARKS = [
  ['3.50x50', 'DRY motif arginine'],
  ['6.48x48', 'CWxP motif tryptophan, the toggle switch'],
  ['7.53x53', 'NPxxY motif tyrosine'],
  ['1.50x50', 'most conserved position of helix 1'],
  ['2.50x50', 'most conserved position of helix 2'],
  ['4.50x50', 'most conserved position of helix 4'],
  ['5.50x50', 'most conserved position of helix 5'],
  ['6.50x50', 'most conserved position of helix 6'],
  ['7.50x50', 'most conserved position of helix 7'],
];

// ------------------------------------------------------------------------------ recent queries

export function readRecent() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch (e) { return []; }
}

export function rememberQuery(q) {
  const s = String(q ?? '').trim();
  if (!s || s.length > 120) return;
  try {
    const next = [s, ...readRecent().filter((x) => x.toLowerCase() !== s.toLowerCase())].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch (e) { /* storage blocked: the box still works */ }
}

export function clearRecent() {
  try { localStorage.removeItem(RECENT_KEY); } catch (e) { /* ignore */ }
}

// ----------------------------------------------------------------------------- suggestion logic

const CFR_HINT = 'Variants at, connected to or near its CFR positions';
/** Endings that ask for a receptor's CFR variant list, as typed so far ("ADRB2 c", "ADRB2 near"). */
const CFR_TAILS = ['cfr variants', 'near cfr'];
/** Receptors whose names start with `term` (exact first), as meta indices; [] without meta. */
function receptorsFor(term, meta, max = 3) {
  const k = aliasKey(term);
  if (!k || !meta) return [];
  const exact = meta.aliases.get(k) ?? [];
  const out = [...new Set(exact.map((h) => h.idx))];
  for (const key of meta.keys) {
    if (out.length >= max) break;
    if (key !== k && key.startsWith(k)) for (const h of meta.aliases.get(key)) if (!out.includes(h.idx)) out.push(h.idx);
  }
  return out.slice(0, max);
}

/** CFR list suggestions for the text typed so far: "<receptor> CFR variants" and "CFR variants in <receptor>". */
function cfrSuggestions(t, meta) {
  const out = [];
  const low = t.toLowerCase();
  const m = /^(?:cfrs?|core functional residues?)(?:\s+variants?)?(?:\s+(?:in|of|for|near))?\s+(.+)$/i.exec(t);
  if (m && meta) {
    for (const idx of receptorsFor(m[1], meta)) out.push({ kind: 'cfr', label: `CFR variants in ${meta.receptors[idx].symbol}`, hint: CFR_HINT, query: `CFR variants in ${meta.receptors[idx].symbol}` });
  } else if (low.length >= 2 && ('cfr variants'.startsWith(low) || /^cfrs?\b/.test(low))) {
    for (const q of ['ADRB2 CFR variants', 'CFR variants in MC4R']) out.push({ kind: 'cfr', label: q, hint: `${CFR_HINT} (add a receptor)`, query: q });
  }
  const sp = t.lastIndexOf(' ');
  if (sp > 0 && meta) {
    // every split "head tail" where the head names a receptor exactly and the tail starts a CFR request
    for (let i = t.indexOf(' '); i > 0; i = t.indexOf(' ', i + 1)) {
      const head = t.slice(0, i).trim(); const tail = t.slice(i + 1).trim().toLowerCase();
      if (tail.length < 2 || !CFR_TAILS.some((x) => x.startsWith(tail))) continue;
      const hit = meta.aliases.get(aliasKey(head));
      if (!hit) continue;
      const sym = meta.receptors[hit[0].idx].symbol;
      out.push({ kind: 'cfr', label: `${sym} CFR variants`, hint: CFR_HINT, query: `${sym} CFR variants` });
      break;
    }
  }
  return out;
}

/**
 * Suggestions for the text typed so far. Pure (takes decoded meta), so it is testable.
 * Each: {kind: 'recent'|'receptor'|'generic', label, hint, query}.
 */
export function suggestionsFor(text, meta, recent = []) {
  const t = String(text ?? '').trim();
  const out = [];
  if (!t) {
    return recent.slice(0, 5).map((q) => ({ kind: 'recent', label: q, hint: 'Recent search', query: q }));
  }
  const low = t.toLowerCase();
  for (const q of recent) if (q.toLowerCase().startsWith(low) && q.toLowerCase() !== low && out.length < 3) out.push({ kind: 'recent', label: q, hint: 'Recent search', query: q });

  out.push(...cfrSuggestions(t, meta));

  if (/^\d{1,2}([.x]\d{0,3}(x\d{0,3})?)?$/i.test(t)) {
    const norm = t.toLowerCase();
    for (const [g, hint] of LANDMARKS) if (g.startsWith(norm)) out.push({ kind: 'generic', label: g, hint: `Generic number, ${hint}`, query: g });
    if (/^\d{1,2}\.\d{2}(x\d{2})?$/i.test(norm) && !out.some((o) => o.query === norm)) out.push({ kind: 'generic', label: norm, hint: 'Generic residue number in every receptor', query: norm });
  }

  const k = aliasKey(t);
  if (k.length >= 1 && meta) {
    const best = new Map(); // receptor idx -> {score, display}
    const consider = (key, score) => {
      for (const h of meta.aliases.get(key)) {
        const s = score * 10 + h.tier;
        const cur = best.get(h.idx);
        if (!cur || s < cur.score) best.set(h.idx, { score: s, display: h.display, key });
      }
    };
    for (const key of meta.keys) {
      if (key === k) consider(key, 0);
      else if (key.startsWith(k)) consider(key, 1 + Math.min(key.length - k.length, 20) / 100);
      else if (k.length >= 3 && key.includes(k)) consider(key, 3);
    }
    const ranked = [...best.entries()].sort((a, b) => a[1].score - b[1].score || meta.receptors[a[0]].symbol.localeCompare(meta.receptors[b[0]].symbol)).slice(0, 8);
    for (const [idx, v] of ranked) {
      const r = meta.receptors[idx];
      out.push({ kind: 'receptor', label: v.display, hint: `${r.symbol}, ${r.name}`, query: r.symbol, gid: r.gid });
    }
    // the whole text names one receptor: its CFR variant list is one step away
    const exact = meta.aliases.get(k);
    if (exact && new Set(exact.map((h) => h.idx)).size === 1 && !out.some((o) => o.kind === 'cfr')) {
      const sym = meta.receptors[exact[0].idx].symbol;
      out.push({ kind: 'cfr', label: `${sym} CFR variants`, hint: CFR_HINT, query: `${sym} CFR variants` });
    }
  }
  // the same query twice is noise
  const seen = new Set();
  return out.filter((o) => { const key = `${o.kind}:${o.query}:${o.label}`; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 9);
}

// ------------------------------------------------------------------------------------ widget

let uid = 0;

export function attachSuggest(input, opts = {}) {
  if (!input || input.__suggest) return input?.__suggest;
  const id = `sg-${++uid}`;
  const form = input.form;
  const wrap = input.closest('[data-suggest-host]') || input.parentElement;
  wrap.classList.add('sg-host');

  const list = document.createElement('ul');
  list.id = `${id}-list`;
  list.className = 'sg-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Search suggestions');
  list.hidden = true;
  const live = document.createElement('div');
  live.className = 'sr-sr-only';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  wrap.append(list, live);

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-haspopup', 'listbox');
  input.setAttribute('autocomplete', 'off');

  let items = [];
  let active = -1;
  let meta = null;
  let metaPromise = null;
  let token = 0;

  const loader = opts.loader ?? makeLoader(opts.indexUrl);
  const loadMeta = () => {
    if (!metaPromise) metaPromise = shardsFor(loader).meta().then((m) => { meta = m; return m; }).catch(() => null);
    return metaPromise;
  };

  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }

  function setActive(i) {
    const opts2 = list.querySelectorAll('[role="option"]');
    opts2.forEach((o, j) => o.setAttribute('aria-selected', j === i ? 'true' : 'false'));
    active = i;
    if (i >= 0 && opts2[i]) {
      input.setAttribute('aria-activedescendant', opts2[i].id);
      opts2[i].scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }

  function render() {
    list.textContent = '';
    if (!items.length) { close(); live.textContent = ''; return; }
    items.forEach((it, i) => {
      const li = document.createElement('li');
      li.id = `${id}-o${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.className = `sg-opt sg-opt--${it.kind}`;
      const main = document.createElement('span');
      main.className = 'sg-main';
      main.textContent = it.label;
      const hint = document.createElement('span');
      hint.className = 'sg-hint';
      hint.textContent = it.hint;
      li.append(main, hint);
      li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(i); });
      list.append(li);
    });
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    live.textContent = `${items.length} suggestion${items.length === 1 ? '' : 's'}. Use the up and down arrow keys, then Enter.`;
    active = -1;
  }

  function pick(i) {
    const it = items[i];
    if (!it) return;
    input.value = it.query;
    close();
    if (opts.submit) opts.submit(it.query, it);
    else if (form) { if (form.requestSubmit) form.requestSubmit(); else form.submit(); }
  }

  async function update() {
    const my = ++token;
    const text = input.value;
    const recent = readRecent();
    if (!text.trim()) { items = suggestionsFor('', null, recent); render(); return; }
    // show what needs no index straight away, then the receptor names
    items = suggestionsFor(text, meta, recent);
    render();
    if (!meta) {
      await loadMeta();
      if (my !== token || !meta) return;
      items = suggestionsFor(input.value, meta, recent);
      render();
    }
  }

  input.addEventListener('focus', () => { loadMeta(); if (!input.value.trim()) update(); });
  input.addEventListener('input', update);
  input.addEventListener('blur', () => { setTimeout(close, 120); });
  input.addEventListener('keydown', (e) => {
    const open = !list.hidden;
    if (e.key === 'ArrowDown') {
      if (!open) { update(); return; }
      e.preventDefault(); setActive((active + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      if (!open) return;
      e.preventDefault(); setActive(active <= 0 ? items.length - 1 : active - 1);
    } else if (e.key === 'Enter') {
      if (open && active >= 0) { e.preventDefault(); pick(active); }
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); close(); }
    } else if (e.key === 'Tab') {
      close();
    }
  });
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) close(); });

  const api = { close, loadMeta, update };
  input.__suggest = api;
  return api;
}
