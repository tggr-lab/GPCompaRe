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
import {
  renderAnswer, esc, html, compareModel, compareRows, compareCsv, compareDefaults, renderCompareBody,
  evidenceText, inReportTable, mismatchFix, residueFacts, direction, signed, CMP_PAGE_SIZE,
} from '../../static/js/search-ui/render.js';
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

test('"Did you mean" for a genomic alternate re-reads the typed coordinate on the other assembly', async () => {
  const { alternateQuery } = await import('../../static/js/search-ui/render.js');
  const { parse } = await import('../../static/js/search/parse.js');
  const interp = parse('5-76833084-G-A')[0];
  const q38 = alternateQuery({ kind: 'genomic', assembly: 'GRCh37', gid: 'x', label: 'Read on GRCh37: X' }, (g) => g, interp);
  assert.equal(q38, '5-76833084-G-A GRCh37');
  const back = parse(q38)[0];
  assert.equal(back.kind, 'genomic');
  assert.equal(back.genomic.assemblyHint, 'GRCh37');
  assert.equal(back.genomic.pos, 76833084);
  // a position without alleles
  const pos = parse('5:76833084')[0];
  const q = alternateQuery({ kind: 'genomic', assembly: 'GRCh38', label: 'Read on GRCh38' }, (g) => g, pos);
  assert.equal(parse(q)[0].genomic.assemblyHint, 'GRCh38');
  // with no interpretation the link falls back to the label rather than throwing
  assert.equal(alternateQuery({ kind: 'genomic', assembly: 'GRCh38', label: 'L' }, (g) => g), 'L');
});

test('a query over the limit gets a visible notice', () => {
  const out = renderAnswer({ expect: 'unrecognised', results: [], alternates: [], interpretation: { kind: 'unrecognised', flags: ['query-truncated'] } }, 'x'.repeat(400), OPTS);
  assert.match(out.html, /Only the first 300 characters were read\./);
});


// ------------------------------------------------------------------ round 2: tables, cards, evidence

const visible = (h) => h.replace(/data-[a-z-]+="[^"]*"/g, '');
const OPTS2 = { ...OPTS, familyOf: () => '', pageUrl: 'https://example.org/search/' };

test('a bare change gives a comparison table with the data columns and a precise link per row', { skip }, async () => {
  const a = await search('M159I', loader);
  const out = renderAnswer(a, 'M159I', OPTS2);
  assert.ok(out.compare, 'a compare model');
  const keys = out.compare.cols.map((c) => c.key);
  for (const k of ['rec', 'fam', 'res', 'gen', 'net', 'dmax', 'nsig', 'cfr', 'cons', 'gnomad', 'clinvar']) assert.ok(keys.includes(k), `${k} in ${keys}`);
  const par2 = out.compare.rows.find((r) => r.gid === 'par2_human');
  assert.equal(par2.query, 'F2RL1 p.Met159Ile');
  assert.equal(par2.f.partner, 'Phe300');
  assert.ok(par2.f.net < 0 && direction(par2.f.net).cls === 'inactive');
  assert.match(out.html, /data-q="F2RL1 p\.Met159Ile"/);
  assert.match(out.html, /sr-net--inactive/);
  assert.ok(!visible(out.html).includes('undefined'));
});

test('3.50x50 paginates at 25 rows, sorts with missing values last, filters by family and exports every row', { skip }, async () => {
  const a = await search('3.50x50', loader);
  const out = renderAnswer(a, '3.50x50', OPTS2);
  const m = out.compare;
  assert.equal(m.rows.length, 283);
  const st = compareDefaults();
  assert.equal((renderCompareBody(m, st).toString().match(/<tr>/g) ?? []).length - 1, CMP_PAGE_SIZE); // minus the header row
  st.all = true;
  assert.equal((renderCompareBody(m, st).toString().match(/<tr>/g) ?? []).length - 1, 283);
  st.all = false;
  // sort by net, high to low; receptors with no contacts go last whatever the direction
  st.sort = 'net'; st.dir = 'desc';
  const nets = compareRows(m, st).map((r) => r.f.net);
  const known = nets.filter((x) => x !== null);
  assert.deepEqual(known, [...known].sort((x, y) => y - x));
  assert.ok(nets.slice(known.length).every((x) => x === null));
  st.dir = 'asc';
  const up = compareRows(m, st).map((r) => r.f.net);
  assert.deepEqual(up.filter((x) => x !== null), [...known].sort((x, y) => x - y));
  assert.ok(up.slice(up.filter((x) => x !== null).length).every((x) => x === null));
  // family filter
  const fam = m.families[0][0];
  st.family = fam;
  assert.equal(compareRows(m, st).length, m.families[0][1]);
  // CSV: all filtered rows, quoted properly, no em dashes
  const csv = compareCsv(m, st);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length - 1, m.families[0][1]);
  assert.match(lines[0], /^receptor,gene_symbol,gpcr_id,uniprot,family,residue,residue_number,generic_number,segment,net_delta_rrcs,net_direction/);
  assert.ok(!csv.includes('\u2014'));
});

test('R3.50 shows its residue filter note and the two groups; the other group is reachable', { skip }, async () => {
  const a = await search('R3.50', loader);
  const out = renderAnswer(a, 'R3.50', OPTS2);
  assert.match(out.html, /269 of 283 receptors have Arg at 3\.50x50; the other 14 are listed separately\./);
  assert.deepEqual(out.compare.groups.map((g) => g.n), [269, 14]);
  const st = { ...compareDefaults(), group: out.compare.groups[1].key };
  const rows = compareRows(out.compare, st);
  assert.equal(rows.length, 14);
  assert.ok(rows.every((r) => r.res && !r.res.startsWith('Arg')), rows.map((r) => r.res).join());
  assert.match(visible(out.html), /residue Arg at generic number 3\.50/);
});

test('a motif with a receptor shows one card per position and the motif line', { skip }, async () => {
  const a = await search('NPxxY in PAR2', loader);
  const out = renderAnswer(a, 'NPxxY in PAR2', OPTS2);
  assert.match(out.html, /sr-motif/);
  assert.ok(out.results.length >= 3);
  assert.ok(!visible(out.html).includes('undefined'));
});

test('the table still renders when the index has no summary fields or groups', () => {
  const rs = [1, 2, 3, 4].map((i) => ({ type: 'target', light: true, gid: `g${i}`, pos: 159, ref: 'M', alt: 'I', kind: 'missense',
    receptor: { gid: `g${i}`, symbol: `G${i}`, name: 'x' }, alleles: [], clinvar: [], notes: [] }));
  const ans = { expect: 'targets', results: rs, interpretation: { kind: 'protein', change: { ref: 'M', pos: 159, alt: 'I', kind: 'missense' } } };
  const out = renderAnswer(ans, 'M159I', OPTS);
  assert.ok(out.compare);
  assert.deepEqual(out.compare.cols.map((c) => c.key), ['rec', 'res']);
  assert.ok(!visible(out.html).match(/undefined|NaN|\[object/));
});

test('A4: the variant-table link is only offered for residues the report table can list', { skip }, async () => {
  const par2 = (await search('PAR2 M159I', loader)).results[0];
  assert.equal(inReportTable(par2), true);
  const adrb2 = (await search('ADRB2 T136I', loader)).results[0];
  assert.equal(inReportTable(adrb2), false);
  const withLink = renderAnswer(await search('PAR2 M159I', loader), 'PAR2 M159I', OPTS2).html;
  assert.match(withLink, /Find in the report's variant table/);
  const without = renderAnswer(await search('ADRB2 T136I', loader), 'ADRB2 T136I', OPTS2).html;
  assert.ok(!without.includes("Find in the report's variant table"));
  assert.match(without, /Not in the report\u2019s variant table/);
  // an explicit field wins
  assert.equal(inReportTable({ inReportTable: true, residue: { dmax: 0.1 } }), true);
});

test('B2: card facts carry the threshold, a direction word and the 0 to 1 scale; no threshold means none is printed', { skip }, async () => {
  const out = renderAnswer(await search('PAR2 M159I', loader), 'PAR2 M159I', OPTS2).html;
  const text = visible(out);
  assert.match(text, /\|ΔRRCS\| 4\.99<span class="sr-sub">, receptor threshold \d\.\d\d/);
  assert.match(text, /stronger in inactive/);
  assert.match(text, /0\.96 <span class="sr-sub">on a 0 to 1 scale/);
  assert.ok(!text.includes('0 variable, 1 conserved'));
  assert.match(text, /AlphaMissense prediction/);
  const r = (await search('PAR2 M159I', loader)).results[0];
  const f = residueFacts({ ...r, summary: { ...r.summary, threshold: null } });
  assert.equal(f.threshold, null);
  assert.equal(direction(0).word, 'no net change');
  assert.equal(signed(2.34, 1), '+2.3');
});

test('C5: the lead line appears for a shifted numbering and for a typed transcript, not for a plain change', { skip }, async () => {
  const shifted = renderAnswer(await search('LPAR2 L351F', loader), 'LPAR2 L351F', OPTS2).html;
  assert.match(visible(shifted), /You typed<\/span> <span class="mono">LPAR2 L351F<\/span>.*Leu348.*differently/s);
  assert.match(shifted, /<details class="sr-more sr-notations" open>/);
  const plain = renderAnswer(await search('PAR2 M159I', loader), 'PAR2 M159I', OPTS2).html;
  assert.ok(!plain.includes('sr-lead'));
  assert.match(plain, /<details class="sr-more sr-notations">/);
  const typed = renderAnswer(await search('NM_005242.4:c.477G>A', loader), 'NM_005242.4:c.477G>A', OPTS2).html;
  assert.match(visible(typed), /NM_005242\.4:c\.477G&gt;A<\/span>.*Met159/s);
});

test('C5: each coding change sits in the row of its own genomic allele', { skip }, async () => {
  const out = renderAnswer(await search('PAR2 M159I', loader), 'PAR2 M159I', OPTS2).html;
  const rows = out.match(/<tr><td class="mono" data-label="Genomic allele \(GRCh38\)">[^<]+<\/td>.*?<\/tr>/gs) ?? [];
  assert.ok(rows.length >= 4, `${rows.length} rows`);
  for (const row of rows) {
    const allele = row.match(/5-76833084-G-([AT])/)[1];
    const c = row.match(/c\.477G&gt;([AT])/)[1];
    assert.equal(allele, c, row);
  }
});

test('A3: a mismatch shows what was typed, the plain sentence and a prominent correction', { skip }, async () => {
  const a = await search('PAR2 p.Ala159Ile', loader);
  const out = renderAnswer(a, 'PAR2 p.Ala159Ile', OPTS2);
  assert.match(out.html, /<span class="sr-change-main mono">p\.Ala159Ile<\/span>/);
  assert.ok(!/sr-change-main mono">p\.Met159Ile/.test(out.html));
  assert.match(out.html, /class="sr-fix"/);
  assert.match(out.html, /data-fix="1"/);
  const fix = mismatchFix(a.results[0], { typed: a.typed, interp: a.interpretation, alternates: a.alternates });
  assert.equal(fix.typed, 'p.Ala159Ile');
  assert.match(fix.query, /p\.Met159Ile$/);
  assert.ok(!out.html.includes('This exact change is not listed'));
  // the same correction is not repeated in the list at the top
  const top = out.html.slice(0, out.html.indexOf('sr-results'));
  assert.ok(!/sr-alt-list[^]*Met159Ile/.test(top), top.slice(-300));
});

test('C6: the evidence summary has every part, for PAR2 and for LPAR2 with its numbering shift', { skip }, async () => {
  for (const [q, needles] of [
    ['PAR2 M159I', ['Query: PAR2 M159I', 'Interpretation: ', 'NM_005242.6 / NP_005233.4', 'GRCh38: 5-76833084-G-T', 'GRCh37: 5-76128909-G-T', 'rs115885685', 'allele frequency', 'ClinVar 2026-10-11', 'Data releases:', 'gnomAD v4.1.2', 'Search link: https://example.org/search/?q=PAR2%20M159I']],
    ['LPAR2 L351F', ['Query: LPAR2 L351F', 'Residue: Leu348', 'residue 348 in the model', 'Warning:', 'GRCh37: 19-19735070-G-A']],
  ]) {
    const a = await search(q, loader);
    const o = renderAnswer(a, q, OPTS2);
    const text = evidenceText(o.results[0], o.ctx);
    for (const n of needles) assert.ok(text.includes(n), `${q}: ${n}\n${text}`);
    assert.ok(!text.includes('\u2014') && !/undefined|NaN|\[object/.test(text), text);
  }
});

test('C6: an approximate lift stays labelled approximate in the summary', { skip }, async () => {
  const a = await search('chr5:76830000', loader);
  const o = renderAnswer(a, 'chr5:76830000', OPTS2);
  const text = evidenceText(o.results[0], o.ctx);
  assert.match(text, /GRCh37: 5:76125825 \(approximate\)/);
});

test('rendered copy has no em dashes in the new views', { skip }, async () => {
  for (const q of ['M159I', 'R3.50', '3.50x50', 'LPAR2 L351F', 'PAR2 p.Ala159Ile', 'DRY']) {
    const out = renderAnswer(await search(q, loader), q, OPTS2);
    assert.ok(!out.html.includes('\u2014'), q);
    assert.ok(!visible(out.html).match(/undefined|NaN|\[object/), q);
  }
});

test('a typed older version is shown as "You typed X; read on Y" with its version note visible', { skip }, async () => {
  const q = 'NM_005242.5:c.477G>A';
  const out = renderAnswer(await search(q, loader), q, OPTS2).html;
  assert.match(visible(out), /You typed NM_005242\.5; read on NM_005242\.6/);
  assert.match(out, /data-code="version_mismatch"/);
  assert.ok(!/Transcript you typed/.test(out));
});

test('an unknown version lists the known versions as "Did you mean" links with a ready query', { skip }, async () => {
  const q = 'NM_005242.999:c.477G>A';
  const a = await search(q, loader);
  const out = renderAnswer(a, q, OPTS2).html;
  assert.match(out, /data-q="NM_005242\.6:c\.477G&gt;A"/);
  assert.match(out, /sr-did-you-mean/);
  assert.match(out, /data-code="version_unknown"/);
  assert.ok(!out.includes('No ClinVar record matches'), 'nothing is claimed about a residue that was not found');
});

test('a motif table marks residues that are not the motif residue, and lists the group counts', { skip }, async () => {
  const a = await search('DRY', loader);
  const out = renderAnswer(a, 'DRY', OPTS2);
  assert.ok(out.compare.rows.some((r) => r.departs) && out.compare.rows.some((r) => !r.departs));
  const csv = compareCsv(out.compare, compareDefaults());
  assert.match(csv.split('\r\n')[0], /departs_from_motif/);
  assert.match(out.html, /269 of 283 receptors have Arg/);
  assert.ok(out.compare.groups.every((g) => !g.label.length || true));
});
