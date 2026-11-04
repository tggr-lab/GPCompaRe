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
  base: '',
};
const loader = makeLoader(indexUrl);

let run = 0;
let current = { results: [], compare: null, state: null, ctx: {} };

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
  current = { results: r.results, compare: r.compare, state: r.compare ? compareDefaults() : null, ctx: r.ctx };
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

function downloadCsv() {
  const { compare, state } = current;
  if (!compare) return;
  const text = compareCsv(compare, state);
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

out.addEventListener('click', async (e) => {
  if (onCompareClick(e)) return;
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
      ? notationsText(current.results[Number(c.dataset.copyNotations)])
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
