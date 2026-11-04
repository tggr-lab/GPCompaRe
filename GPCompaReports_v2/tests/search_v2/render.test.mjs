// Search v2 UI render tests. Run:
//   node --test GPCompaReports_v2/tests/search_v2/render.test.mjs
// Same index lookup as resolve.test.mjs (SEARCH2_DIR, else <build>/search2). Skips without an index.
//
// Every golden query goes through search() and renderAnswer(): nothing may throw, no placeholder text
// (undefined, null, NaN, [object Object]) may reach the page, and typed text must be escaped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { search } from '../../static/js/search/resolve.js';
import { renderAnswer, esc, html } from '../../static/js/search-ui/render.js';
import { suggestionsFor } from '../../static/js/search-ui/suggest.js';
import { shardsFor } from '../../static/js/search/shards.js';

const BASE = resolvePath(fileURLToPath(new URL('../..', import.meta.url)));
const candidates = [
  process.env.SEARCH2_DIR,
  join(process.env.FREEZE_BUILD_DIR ? resolvePath(BASE, process.env.FREEZE_BUILD_DIR) : join(BASE, 'output_v3_demo'), 'search2'),
  join(BASE, 'output', 'search2'),
].filter(Boolean);
const DIR = candidates.find((d) => existsSync(join(d, 'meta.json')));
const skip = DIR ? false : 'no search2 index';
const loader = async (p) => { try { return JSON.parse(await readFile(join(DIR, p), 'utf8')); } catch { return null; } };
const OPTS = { reports: '../reports/', studio: '../studio/', symbolOf: (g) => g };

const rows = readFileSync(new URL('./golden_queries.tsv', import.meta.url), 'utf8').split('\n').slice(1).filter(Boolean).map((l) => l.split('\t'));

test('every golden query renders without placeholders', { skip }, async () => {
  const placeholder = /\[object|undefined|NaN|\bnull\b/;
  for (const r of rows) {
    const q = r[1].replace(/\\t/g, '\t');
    const out = renderAnswer(await search(q, loader), q, OPTS);
    const visible = out.html.replace(/data-[a-z-]+="[^"]*"/g, '');
    assert.ok(!placeholder.test(visible), `${r[0]} ${q}: ${visible.match(/.{30}(\[object|undefined|NaN|null).{20}/)?.[0]}`);
  }
});

test('typed text is escaped', { skip }, async () => {
  const q = '<img src=x onerror=alert(1)>';
  const out = renderAnswer(await search(q, loader), q, OPTS);
  assert.ok(!out.html.includes('<img'), out.html.slice(0, 300));
  assert.equal(esc('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
  assert.equal(html`<b>${'<i>'}</b>`.toString(), '<b>&lt;i&gt;</b>');
});

test('the interpretation line is plain words', { skip }, async () => {
  const a = await search('NM_005242.4:c.477G>A', loader);
  const out = renderAnswer(a, 'NM_005242.4:c.477G>A', OPTS).html;
  assert.match(out, /PAR2 \(F2RL1\), protein change Met159Ile, from NM_005242\.4:c\.477G&gt;A/);
});

test('no em dashes in rendered copy', { skip }, async () => {
  for (const q of ['GLP1R', 'asdfgh', 'F2RL1 p.Met159Ile', 'M159I', 'F2RL1 c.477+1G>A']) {
    const out = renderAnswer(await search(q, loader), q, OPTS).html;
    assert.ok(!out.includes('—'), q);
  }
});

test('autocomplete suggests receptors, generic numbers and recent queries', { skip }, async () => {
  const meta = await shardsFor(loader).meta();
  const par = suggestionsFor('PAR', meta, []);
  assert.ok(par.some((s) => s.kind === 'receptor' && s.query === 'F2RL1'), JSON.stringify(par));
  assert.equal(suggestionsFor('beta2', meta, [])[0].query, 'ADRB2');
  assert.ok(suggestionsFor('3.5', meta, []).some((s) => s.query === '3.50x50'));
  assert.deepEqual(suggestionsFor('', meta, ['PAR2 M159I']).map((s) => s.query), ['PAR2 M159I']);
  assert.ok(suggestionsFor('par2 m', meta, ['PAR2 M159I'])[0].kind === 'recent');
});
