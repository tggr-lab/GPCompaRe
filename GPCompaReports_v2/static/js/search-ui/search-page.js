/**
 * Search v2 UI: the /search/ page controller. Reads ?q=, runs the engine, renders the answer.
 * Module; loaded by templates/search.html.
 */

import { search } from '../search/resolve.js';
import { shardsFor } from '../search/shards.js';
import { makeLoader } from './loader.js';
import { renderAnswer, renderHelp, renderReleases, notationsText } from './render.js';
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
let current = { results: [] };

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
  const r = renderAnswer(answer, q, { ...opts, releases, symbolOf });
  out.innerHTML = r.html;
  out.removeAttribute('aria-busy');
  current = { results: r.results };
  setStatus(r.status);
  if (releasesEl && releases) releasesEl.innerHTML = renderReleases(releases).toString();
  if (remember && answer.expect !== 'unrecognised' && answer.results?.length) rememberQuery(q);
  renderRecent();
  wireTables();
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

// ---------------------------------------------------------------------------- table sorting

function wireTables() {
  out.querySelectorAll('table[data-sortable]').forEach((table) => {
    table.querySelectorAll('button[data-sort-col]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const col = Number(btn.dataset.sortCol);
        const th = btn.closest('th');
        const dir = th.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending';
        table.querySelectorAll('th').forEach((x) => x.setAttribute('aria-sort', 'none'));
        th.setAttribute('aria-sort', dir);
        const body = table.tBodies[0];
        const rows = [...body.rows];
        const val = (tr) => tr.cells[col].dataset.v;
        const numeric = rows.every((tr) => val(tr) !== '' && !Number.isNaN(Number(val(tr))));
        rows.sort((a, b) => {
          const x = val(a); const y = val(b);
          const c = numeric ? Number(x) - Number(y) : x.localeCompare(y, 'en', { numeric: true });
          return dir === 'ascending' ? c : -c;
        });
        rows.forEach((tr) => body.append(tr));
        setStatus(`Sorted by ${btn.textContent}, ${dir}.`);
      });
    });
  });
}

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
  const a = e.target.closest('a[data-q]');
  if (a && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button)) {
    e.preventDefault();
    go(a.dataset.q);
    window.scrollTo({ top: 0 });
    return;
  }
  const c = e.target.closest('[data-copy], [data-copy-notations]');
  if (!c) return;
  const text = c.dataset.copy ?? notationsText(current.results[Number(c.dataset.copyNotations)]);
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
