/**
 * Search v2 UI: the /search/ page controller. Reads ?q=, runs the engine, renders the answer.
 * Module; loaded by templates/search.html.
 */

import { search } from '../search/resolve.js';
import { shardsFor } from '../search/shards.js';
import { makeLoader } from './loader.js';
import {
  renderAnswer, renderHelp, renderReleases, notationsText, evidenceText,
  renderCompareBody, compareDefaults, compareCsv, compareRows,
  renderCfrListBody, cfrListDefaults, cfrListCsv, cfrListRows,
} from './render.js';
import { attachSuggest, rememberQuery, readRecent, clearRecent } from './suggest.js';

const app = document.getElementById('search-app');
const form = document.getElementById('search-form');
const input = document.getElementById('search-input');
const out = document.getElementById('search-results');
const statusEl = document.getElementById('search-status');
const releasesEl = document.getElementById('search-releases');
const recentEl = document.getElementById('search-recent');

const indexUrl = new URL(app.dataset.index, document.baseURI);
const opts = {
  reports: app.dataset.reports,
  studio: app.dataset.studio,
  glossary: app.dataset.glossary,
  models: app.dataset.models ?? `${app.dataset.reports}../models/`,
  base: '',
};
const loader = makeLoader(indexUrl);

let run = 0;
let current = { results: [], compare: null, state: null, cfr: null, cfrState: null, ctx: {} };

function setStatus(text) { statusEl.textContent = text || ''; }

function setTitle(q) {
  document.title = q ? `${q} · Search · GPCompaRe` : 'Search · GPCompaRe';
}

async function show(q, { remember = true } = {}) {
  const my = ++run;
  input.value = q;
  setTitle(q);
  if (!q.trim()) {
    out.innerHTML = renderHelp(opts).toString();
    setStatus('');
    renderRecent();
    return;
  }
  setStatus('Searching');
  out.setAttribute('aria-busy', 'true');
  let answer;
  try {
    answer = await search(q, loader);
  } catch (e) {
    if (my !== run) return;
    out.removeAttribute('aria-busy');
    out.innerHTML = '<div class="sr-message sr-message--stop" role="alert">The search index could not be loaded. Check your connection and try again.</div>';
    setStatus('');
    return;
  }
  if (my !== run) return;
  const meta = await shardsFor(loader).meta();
  const releases = meta?.releases ?? null;
  const symbolOf = (gid) => meta?.byGid.get(gid)?.symbol ?? gid;
  const familyOf = (gid) => meta?.byGid.get(gid)?.family;
  const pageUrl = `${window.location.origin}${window.location.pathname}`;
  const r = renderAnswer(answer, q, { ...opts, releases, symbolOf, familyOf, pageUrl });
  out.innerHTML = r.html;
  out.removeAttribute('aria-busy');
  current = { results: r.results, compare: r.compare, state: r.compare ? compareDefaults() : null, cfr: r.cfr, cfrState: r.cfr ? cfrListDefaults() : null, ctx: r.ctx };
  setStatus(r.status);
  if (releasesEl && releases) releasesEl.innerHTML = renderReleases(releases).toString();
  if (remember && answer.expect !== 'unrecognised' && answer.results?.length) rememberQuery(q);
  renderRecent();
}

function renderRecent() {
  if (!recentEl) return;
  const rec = readRecent();
  recentEl.hidden = rec.length === 0;
  recentEl.textContent = '';
  if (!rec.length) return;
  const h = document.createElement('span');
  h.className = 'sr-label';
  h.textContent = 'Recent';
  const ul = document.createElement('ul');
  ul.className = 'sr-chips';
  for (const q of rec) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.className = 'sr-chip';
    a.href = `?q=${encodeURIComponent(q)}`;
    a.dataset.q = q;
    a.textContent = q;
    li.append(a);
    ul.append(li);
  }
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'sr-linkbtn';
  clear.textContent = 'Clear';
  clear.addEventListener('click', () => { clearRecent(); renderRecent(); });
  recentEl.append(h, ul, clear);
}

function go(q, push = true) {
  const url = q ? `?q=${encodeURIComponent(q)}` : window.location.pathname;
  if (push) { try { history.pushState({ q }, '', url); } catch (e) { /* ignore */ } }
  return show(q);
}

// ------------------------------------------------------------ the cross-receptor table

function cmpBody() { return out.querySelector('[data-cmp-body]'); }

/** Redraw the table body after a state change; keeps focus on the control that was used. */
function cmpUpdate(focusSel) {
  const { compare, state } = current;
  if (!compare || !state) return;
  const body = cmpBody();
  if (!body) return;
  body.innerHTML = renderCompareBody(compare, state, { reports: opts.reports }).toString();
  const sortSel = out.querySelector('[data-cmp-sortsel]');
  if (sortSel) sortSel.value = state.sort;
  const dir = out.querySelector('[data-cmp-dir]');
  if (dir) {
    dir.disabled = state.sort === 'orig';
    dir.textContent = state.dir === 'desc' ? 'High to low' : 'Low to high';
    dir.setAttribute('aria-label', `Sort direction: ${state.dir === 'desc' ? 'high to low' : 'low to high'}. Press to reverse.`);
  }
  out.querySelectorAll('[data-cmp-group]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cmpGroup === state.group)));
  if (focusSel) body.querySelector(focusSel)?.focus();
  setStatus(`${compareRows(compare, state).length} rows.`);
}

/** Sort by a column: numbers start high to low, text starts A to Z; the same column again reverses. */
function cmpSort(key) {
  const s = current.state;
  if (s.sort === key) s.dir = s.dir === 'asc' ? 'desc' : 'asc';
  else {
    s.sort = key;
    s.dir = key !== 'orig' && current.compare.cols.find((c) => c.key === key)?.num ? 'desc' : 'asc';
  }
  s.page = 1;
}

function saveCsv(text) {
  const slug = (input.value || 'search').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'search';
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `gpcompare-${slug}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus('Table saved as CSV.');
}

function downloadCsv() {
  const { compare, state } = current;
  if (compare) saveCsv(compareCsv(compare, state));
}

// ------------------------------------------------------ the CFR variant table of one receptor

/** Redraw the CFR table body (chips, table, pager) after a state change; keeps focus on the control used. */
function cfrUpdate(focusSel) {
  const { cfr, cfrState: s } = current;
  const body = out.querySelector('[data-cfr-body]');
  if (!cfr || !s || !body) return;
  body.innerHTML = renderCfrListBody(cfr, s, opts).toString();
  const sortSel = out.querySelector('[data-cfr-sortsel]');
  if (sortSel) sortSel.value = s.sort;
  const dir = out.querySelector('[data-cfr-dir]');
  if (dir) {
    dir.disabled = s.sort === 'orig';
    dir.textContent = s.dir === 'desc' ? 'High to low' : 'Low to high';
    dir.setAttribute('aria-label', `Sort direction: ${s.dir === 'desc' ? 'high to low' : 'low to high'}. Press to reverse.`);
  }
  if (focusSel) body.querySelector(focusSel)?.focus();
  setStatus(`${cfrListRows(cfr, s).length} variants.`);
}

function cfrSort(key) {
  const s = current.cfrState;
  if (s.sort === key) s.dir = s.dir === 'asc' ? 'desc' : 'asc';
  else {
    s.sort = key;
    s.dir = key !== 'orig' && current.cfr.cols.find((c) => c.key === key)?.num ? 'desc' : 'asc';
  }
  s.page = 1;
}

function onCfrClick(e) {
  const s = current.cfrState;
  if (!current.cfr || !s) return false;
  const t = e.target;
  const sort = t.closest('[data-cfr-sort]');
  if (sort) { cfrSort(sort.dataset.cfrSort); cfrUpdate(`[data-cfr-sort="${sort.dataset.cfrSort}"]`); return true; }
  const grp = t.closest('[data-cfr-group]');
  if (grp) { s.group = grp.dataset.cfrGroup; s.page = 1; cfrUpdate(`[data-cfr-group="${s.group}"]`); return true; }
  const src = t.closest('[data-cfr-source]');
  if (src) { s.source = src.dataset.cfrSource; s.page = 1; cfrUpdate(`[data-cfr-source="${s.source}"]`); return true; }
  const pg = t.closest('[data-cfr-page]');
  if (pg) { s.page = Math.max(1, s.page + (pg.dataset.cfrPage === 'next' ? 1 : -1)); cfrUpdate(`[data-cfr-page="${pg.dataset.cfrPage}"]:not([disabled])`); return true; }
  const all = t.closest('[data-cfr-all]');
  if (all) { s.all = all.dataset.cfrAll === '1'; s.page = 1; cfrUpdate('[data-cfr-all]'); return true; }
  const dir = t.closest('[data-cfr-dir]');
  if (dir) { if (s.sort !== 'orig') s.dir = s.dir === 'asc' ? 'desc' : 'asc'; s.page = 1; cfrUpdate(); return true; }
  if (t.closest('[data-cfr-csv]')) { saveCsv(cfrListCsv(current.cfr, s)); return true; }
  return false;
}

function onCompareClick(e) {
  const s = current.state;
  if (!current.compare || !s) return false;
  const sort = e.target.closest('[data-cmp-sort]');
  if (sort) { cmpSort(sort.dataset.cmpSort); cmpUpdate(`[data-cmp-sort="${sort.dataset.cmpSort}"]`); return true; }
  const pg = e.target.closest('[data-cmp-page]');
  if (pg) {
    s.page = Math.max(1, s.page + (pg.dataset.cmpPage === 'next' ? 1 : -1));
    cmpUpdate(`[data-cmp-page="${pg.dataset.cmpPage}"]:not([disabled])`);
    return true;
  }
  const all = e.target.closest('[data-cmp-all]');
  if (all) { s.all = all.dataset.cmpAll === '1'; s.page = 1; cmpUpdate('[data-cmp-all]'); return true; }
  const grp = e.target.closest('[data-cmp-group]');
  if (grp) { s.group = grp.dataset.cmpGroup; s.page = 1; cmpUpdate(); return true; }
  const dir = e.target.closest('[data-cmp-dir]');
  if (dir) { if (s.sort !== 'orig') s.dir = s.dir === 'asc' ? 'desc' : 'asc'; s.page = 1; cmpUpdate(); return true; }
  if (e.target.closest('[data-cmp-csv]')) { downloadCsv(); return true; }
  return false;
}

out.addEventListener('change', (e) => {
  if (e.target.matches('[data-cfr-sortsel]') && current.cfr && current.cfrState) {
    current.cfrState.sort = '';
    cfrSort(e.target.value);
    cfrUpdate();
    return;
  }
  const s = current.state;
  if (!current.compare || !s) return;
  if (e.target.matches('[data-cmp-family]')) { s.family = e.target.value; s.page = 1; cmpUpdate(); }
  else if (e.target.matches('[data-cmp-sortsel]')) {
    s.sort = '';
    cmpSort(e.target.value);
    cmpUpdate();
  }
});

// ------------------------------------------------------------------------------- copy buttons

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e2) { return false; }
  }
}

// ------------------------------------------------------------ card section nav and the receptor map

/** A section link opens its target (a folded <details>) before the browser scrolls to it. */
function onNavClick(e) {
  const a = e.target.closest('a[data-nav]');
  if (!a) return false;
  const id = a.getAttribute('href').slice(1);
  const target = document.getElementById(id);
  if (!target) return false;
  if (target.tagName === 'DETAILS') target.open = true;
  e.preventDefault();
  try { history.replaceState(history.state, '', `#${id}`); } catch (err) { /* ignore */ }
  target.scrollIntoView({ block: 'start' });
  const focusable = target.tagName === 'DETAILS' ? target.querySelector('summary') : target;
  if (focusable) { focusable.setAttribute('tabindex', '-1'); focusable.focus({ preventScroll: true }); }
  const card = a.closest('.sr-card');
  card?.querySelectorAll('.sr-nav a').forEach((x) => x.classList.toggle('is-current', x === a || (x.getAttribute('href') === a.getAttribute('href'))));
  return true;
}

/** Clicking the receptor map's track searches the residue under the pointer. */
function onMapClick(e) {
  const hit = e.target.closest('[data-map-hit]');
  if (!hit) return false;
  const fig = hit.closest('.sr-map');
  const svg = fig?.querySelector('svg');
  if (!fig || !svg) return false;
  const box = svg.getBoundingClientRect();
  const n = Number(fig.dataset.length);
  if (!(box.width > 0) || !(n > 0)) return false;
  const pos = Math.min(n, Math.max(1, Math.ceil(((e.clientX - box.left) / box.width) * n)));
  go(`${fig.dataset.symbol} ${pos}`);
  window.scrollTo({ top: 0 });
  return true;
}

out.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-map-go]');
  if (!form) return;
  e.preventDefault();
  const fig = form.closest('.sr-map');
  const n = Number(form.pos.value);
  if (!fig || !(n >= 1) || n > Number(fig.dataset.length)) { setStatus(`Residue numbers run from 1 to ${fig?.dataset.length ?? '?'}.`); return; }
  go(`${fig.dataset.symbol} ${n}`);
  window.scrollTo({ top: 0 });
});

/** "Show in 3D": the viewer and the models load only now, into the card's own pane. */
const viewers = new Map();
async function onShow3d(e) {
  const btn = e.target.closest('button[data-3d]');
  if (!btn) return false;
  const idx = Number(btn.dataset['3d']);
  const r = current.results[idx];
  const box = btn.closest('.sr-3d');
  const pane = box?.querySelector('.sr-3d-pane');
  const statusEl3 = box?.querySelector('.sr-3d-status');
  if (!r || !pane) return false;
  const open = btn.getAttribute('aria-expanded') !== 'true';
  btn.setAttribute('aria-expanded', String(open));
  btn.textContent = open ? 'Hide 3D' : 'Show in 3D';
  pane.hidden = !open;
  if (!open || viewers.has(idx)) return true;
  viewers.set(idx, true);
  const say = (text, state) => { if (statusEl3) { statusEl3.textContent = text; statusEl3.dataset.state = state; } };
  try {
    const { mount3d } = await import('./view3d.js');
    await mount3d(pane, { gid: r.gid, pos: r.pos, contacts: r.contacts ?? [], models: opts.models, studio: opts.studio, status: say });
  } catch (err) {
    viewers.delete(idx);
  }
  return true;
}

out.addEventListener('click', async (e) => {
  if (onCompareClick(e)) return;
  if (onCfrClick(e)) return;
  if (onNavClick(e)) return;
  if (onMapClick(e)) return;
  if (await onShow3d(e)) return;
  const a = e.target.closest('a[data-q]');
  if (a && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button)) {
    e.preventDefault();
    go(a.dataset.q);
    window.scrollTo({ top: 0 });
    return;
  }
  const c = e.target.closest('[data-copy], [data-copy-notations], [data-copy-evidence]');
  if (!c) return;
  const text = c.dataset.copy
    ?? (c.dataset.copyNotations !== undefined
      ? notationsText(current.results[Number(c.dataset.copyNotations)], current.ctx)
      : evidenceText(current.results[Number(c.dataset.copyEvidence)], current.ctx));
  const old = c.textContent;
  const ok = await copyText(text);
  c.textContent = ok ? 'Copied' : 'Copy failed';
  setStatus(ok ? 'Copied to the clipboard.' : 'Could not copy. Select the text and copy it by hand.');
  setTimeout(() => { c.textContent = old; }, 1500);
});

// ------------------------------------------------------------------------------------ start

attachSuggest(input, { loader, submit: (q) => go(q) });
form.addEventListener('submit', (e) => {
  e.preventDefault();
  go(input.value.trim());
});
window.addEventListener('popstate', () => {
  show(new URLSearchParams(window.location.search).get('q') ?? '', { remember: false });
});

const q0 = (new URLSearchParams(window.location.search).get('q') ?? '').trim();
document.documentElement.classList.add('sr-js');
show(q0).then(() => { if (!q0) input.focus(); });
// the index is needed by every query; start it while the reader reads the page
shardsFor(loader).meta().catch(() => {});
