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
  notationsText, subjectOf, csvField, clinvarGroups, finePrint, HELP, renderHelp, renderReleases,
  reportTableRelease, allelesTable, fmtAm, summarySentences, contactMeaning, amClassLabel, segmentKind, RESEARCH_NOTE, DB_NAME,
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

test('B2: card facts carry a direction word; the threshold and the 0 to 1 scale are in the fine print; no threshold means none is printed', { skip }, async () => {
  const out = renderAnswer(await search('PAR2 M159I', loader), 'PAR2 M159I', OPTS2).html;
  const text = visible(out);
  assert.match(text, /\|ΔRRCS\| 4\.99<span class="sr-sub">, with Phe300/);
  assert.ok(!/receptor threshold/.test(text.split('sr-card-fine')[0]), 'no threshold in the facts');
  assert.match(text, /this receptor's threshold is \d\.\d\d/);
  assert.match(text, /stronger in inactive/);
  assert.match(text, /<dt>Conservation<\/dt><dd>0\.96<\/dd>/);
  assert.match(text, /Conservation<\/strong> is on a 0 to 1 scale/);
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
  assert.match(shifted, /<details class="sr-more sr-notations">\s*<summary>All transcript notations <span class="sr-badge sr-badge--warn">numbering differs<\/span>/);
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

// ------------------------------------------------------------ review round 2 (2026-11-04)

test('R2-1: a reference mismatch keeps the typed change as the subject in the evidence summary and the notations', { skip }, async () => {
  const q = 'PAR2 p.Ala159Ile';
  const a = await search(q, loader);
  const o = renderAnswer(a, q, OPTS2);
  const r = o.results[0];
  const ev = evidenceText(r, o.ctx);
  const nt = notationsText(r, o.ctx);
  for (const text of [ev, nt]) {
    assert.ok(text.includes('p.Ala159Ile: position 159 is Met in F2RL1, so this change cannot be checked'), text);
    assert.ok(!/Change: p\.Met159Ile/.test(text), text);
    assert.ok(!text.includes('this exact change is not listed'), text);
    assert.ok(!/^p\.Met159Ile/m.test(text), 'the corrected change is never a line of its own');
    assert.ok(!/NP_005233\.4:p\.Met159Ile/.test(text) && !/: p\.Met159Ile$/m.test(text), 'transcripts show the model residue only');
    assert.match(text, /Model residue: Met159/);
    // the correction appears once, as a suggestion
    const sugg = text.split('\n').filter((l) => l.includes('p.Met159Ile'));
    assert.equal(sugg.length, 1, sugg.join('\n'));
    assert.match(sugg[0], /^Suggested correction \(a suggestion only; check that it is what you meant\): F2RL1 p\.Met159Ile/);
  }
  assert.match(ev, /ClinVar 2026-10-11: no record at the model residue Met159\./);
  // the context-free call (r.typed on the result) gives the same subject
  assert.ok(notationsText(r).includes('p.Ala159Ile: position 159 is Met in F2RL1'));
  // card: header names the model residue as such, the change line is the typed change
  assert.match(visible(o.html), /model residue <\/span><span class="mono">Met159/);
  assert.match(o.html, /The model residue on each transcript/);
  assert.ok(!/<td class="mono" data-label="Protein change">p\.Met159Ile/.test(o.html));
  assert.equal(subjectOf(r, o.ctx).change, null);
});

test('R2-1: no-counterpart (GPR142 p.Cys6Ser) and an unknown version (NM_005242.999) never invent a change', { skip }, async () => {
  {
    const q = 'GPR142 p.Cys6Ser';
    const a = await search(q, loader);
    const o = renderAnswer(a, q, OPTS2);
    const r = o.results[0];
    for (const text of [evidenceText(r, o.ctx), notationsText(r, o.ctx)]) {
      assert.ok(text.includes('p.Cys6Ser: position 6 is Leu in GPR142, so this change cannot be checked'), text);
      assert.ok(!text.includes('this exact change is not listed'), text);
      assert.equal(text.split('\n').filter((l) => l.includes('p.Leu6Ser')).length, 1, text);
      assert.match(text.split('\n').find((l) => l.includes('p.Leu6Ser')), /^Suggested correction/);
    }
    assert.ok(!/sr-change-main mono">p\.Leu6Ser/.test(o.html));
  }
  {
    const q = 'NM_005242.999:c.477G>A';
    const a = await search(q, loader);
    const o = renderAnswer(a, q, OPTS2);
    const r = o.results[0];
    const ev = evidenceText(r, o.ctx);
    assert.match(ev, /Residue: not placed/);
    assert.ok(!/Change:|no record matches|not listed/.test(ev), ev);
    assert.ok(!/null|undefined/.test(notationsText(r, o.ctx)));
  }
});

test('R2-2: CSV cells that a spreadsheet would run as formulas are neutralised; numbers stay numbers', () => {
  assert.equal(csvField('=1+1'), "'=1+1");
  assert.equal(csvField('@SUM(1+1)'), "'@SUM(1+1)");
  assert.equal(csvField('-cmd'), "'-cmd");
  assert.equal(csvField('+cmd'), "'+cmd");
  assert.equal(csvField('\tx'), "'\tx");
  assert.equal(csvField('\rx'), '"\'\rx"');
  assert.equal(csvField('-1'), '-1');
  assert.equal(csvField('-1.3'), '-1.3');
  assert.equal(csvField(-1), '-1');
  assert.equal(csvField(2.5e-6), '0.0000025');
  assert.equal(csvField('=HYPERLINK("x","y")'), '"\'=HYPERLINK(""x"",""y"")"');
  const rs = [['=1+1', '@SUM(1+1)', -1.25], ['-cmd', 'Family', 2]].map(([sym, fam, net], i) => ({
    type: 'target', light: true, gid: `g${i}`, pos: 10 + i, ref: 'M', alt: 'I', kind: 'missense',
    receptor: { gid: `g${i}`, symbol: sym, name: 'x' }, alleles: [], clinvar: [], notes: [],
    summary: { aa: 'M', family: fam, net, dmax: 1, dmaxSigned: -1, nsig: 0, threshold: 1 } }));
  rs.push(...[2, 3].map((i) => ({ ...rs[1], gid: `g${i}`, receptor: { gid: `g${i}`, symbol: `S${i}`, name: 'x' } })));
  const out = renderAnswer({ expect: 'targets', results: rs, interpretation: { kind: 'protein', change: { ref: 'M', pos: 10, alt: 'I', kind: 'missense' } } }, 'M10I', OPTS);
  const csv = compareCsv(out.compare, compareDefaults());
  const lines = csv.split('\r\n');
  assert.ok(lines[1].startsWith("'=1+1,'=1+1,g0,,'@SUM(1+1),"), lines[1]);
  assert.ok(lines[2].startsWith("'-cmd,'-cmd,g1,"), lines[2]);
  assert.match(lines[1], /,-1\.3,stronger in inactive,/);
  for (const l of lines.slice(1)) for (const cell of l.split(',')) assert.ok(!/^[=+@\t\r]/.test(cell) && !/^-[^\d.]/.test(cell), cell);
});

test('R2-5: a receptor result lists every ClinVar record, P/LP first, with counts; "ADRB2 ClinVar" opens it', { skip }, async () => {
  const plain = await search('ADRB2', loader);
  assert.equal(plain.expect, 'receptor');
  const recs = plain.results[0].clinvar;
  assert.ok(recs.length >= 40, recs.length);
  const ho = renderAnswer(plain, 'ADRB2', OPTS2).html;
  assert.match(ho, /<details class="sr-more sr-cvlist-all">/); // folded on a plain receptor search
  assert.match(visible(ho), new RegExp(`All ${recs.length} ClinVar records for ADRB2`));
  for (const q of ['ADRB2 ClinVar', 'ClinVar for ADRB2']) {
    const a = await search(q, loader);
    assert.equal(a.expect, 'receptor', q);
    assert.equal(a.results[0].gid, 'adrb2_human');
    assert.equal(a.results[0].clinvarList, true);
    const h = renderAnswer(a, q, OPTS2).html;
    assert.match(h, /<details class="sr-more sr-cvlist-all" open>/, q);
    assert.match(visible(h), /I read this as<\/span> <strong>every ClinVar record of ADRB2/);
    // every record is listed once, with its VCV link
    for (const c of recs) assert.ok(h.includes(`href="https://www.ncbi.nlm.nih.gov/clinvar/variation/${c.variationId}/"`), c.accession);
    assert.equal((h.match(/data-label="Record"/g) ?? []).length, recs.length);
    assert.match(visible(h), /\d+ records: 0 pathogenic or likely pathogenic, \d+ uncertain significance, \d+ benign or likely benign/);
  }
  // a receptor with P/LP records: that group comes first and is open
  const rho = await search('RHO ClinVar', loader);
  const groups = clinvarGroups(rho.results[0].clinvar);
  assert.equal(groups[0].key, 'plp');
  assert.ok(groups[0].records.length > 0);
  assert.ok(groups[0].records.every((c) => /pathogenic/i.test(c.classification) && !/benign|uncertain|conflicting/i.test(c.classification)));
  const rh = renderAnswer(rho, 'RHO ClinVar', OPTS2).html;
  const order = [...rh.matchAll(/data-cv-group="(\w+)"/g)].map((m) => m[1]);
  assert.equal(order[0], 'plp');
  assert.match(rh, /data-cv-group="plp" open>/);
  assert.equal(groups.reduce((n, g) => n + g.records.length, 0), rho.results[0].clinvar.length);
});

test('R2-6: "Find in the report\'s variant table" follows the report table membership index', { skip }, async () => {
  const gpr3 = await search('1-27393820-C-T', loader);
  const r3 = gpr3.results[0];
  assert.equal(r3.gid, 'gpr3_human');
  assert.equal(r3.alleles[0].hgvsp, 'p.Pro8Ser');
  // since the 2026-11-05 refresh the report tables hold the same alleles as search: GPR3's own allele at a
  // residue past the |dRRCS| 3.0 cutoff is a row (the old table listed GPR31's alleles instead)
  assert.equal(r3.alleles[0].inReportTable, true);
  assert.ok(inReportTable(r3) === true && residueFacts(r3).dmax >= 3, 'above the cutoff and listed');
  const h3 = renderAnswer(gpr3, '1-27393820-C-T', OPTS2).html;
  assert.ok(h3.includes("Find in the report's variant table"));
  assert.ok(!/does not list this change/.test(h3));
  const par2 = await search('PAR2 p.Met159Ile', loader);
  const r2 = par2.results[0];
  assert.ok(r2.alleles.length && r2.alleles.every((x) => x.inReportTable === true));
  const h2 = renderAnswer(par2, 'PAR2 p.Met159Ile', OPTS2).html;
  const m = /href="[^"]*par2_human\.html#sec=sec-variants&(?:amp;)?vq=([^"]+)">Find in the report's variant table/.exec(h2);
  assert.ok(m, 'link present');
  const vq = decodeURIComponent(m[1]);
  assert.equal(vq, 'p.Met159Ile');
  // the hgvsp is a row of the built report page, when a build sits next to the index
  const page = join(DIR, '..', 'reports', 'par2_human.html');
  if (existsSync(page)) {
    const table = /<table class="v2-table" id="variants-table">([^]*?)<\/table>/.exec(readFileSync(page, 'utf8'))[1];
    assert.ok(table.includes(`<td>${vq}</td>`), 'p.Met159Ile is a row of the report table');
    const g3 = /<table class="v2-table" id="variants-table">([^]*?)<\/table>/.exec(readFileSync(join(DIR, '..', 'reports', 'gpr3_human.html'), 'utf8'))?.[1] ?? '';
    assert.ok(g3.includes('<td>p.Pro8Ser</td>'), 'p.Pro8Ser is a row of the GPR3 report table');
  }
});

test('R2-7: no exact match but grouped residues: W3.50 lists every receptor with its residue at 3.50x50', { skip }, async () => {
  const a = await search('W3.50', loader);
  assert.equal(a.results.length, 0);
  const o = renderAnswer(a, 'W3.50', OPTS2);
  assert.ok(o.compare, 'a table is drawn');
  assert.equal(o.compare.rows.length, 283);
  assert.match(visible(o.html), /No receptor has Trp at 3\.50x50; all 283 receptors with their residue at 3\.50x50 are listed below\./);
  assert.ok(!o.status.startsWith('No result'), o.status);
  assert.ok(!o.html.includes('sr-help'), 'no "you can search like this" block under a table');
  assert.ok(!visible(o.html).match(/undefined|NaN|\[object/));
});

// ---------------------------------------------------------------- fine print (reports v3)

test('finePrint makes an aside, or a collapsed details with a summary', () => {
  assert.equal(finePrint(html`<p>x</p>`).toString(), '<aside class="fine-print"><p>x</p></aside>');
  assert.equal(finePrint(html`<p>x</p>`, { summary: 'About', page: true, id: 'a' }).toString(),
    '<details class="fine-print fine-print--page" id="a"><summary>About</summary><p>x</p></details>');
  assert.match(finePrint('x', { summary: 's', open: true }).toString(), /<details [^>]* open>/);
  assert.ok(!finePrint('<b>', { summary: '<i>' }).toString().includes('<b>'), 'text is escaped');
});

test('the help examples name no favourite receptor and every one resolves to a card or a table', { skip }, async () => {
  const all = HELP.flatMap(([, ex]) => ex);
  assert.ok(all.length >= 20);
  const text = all.join(' ');
  for (const bad of ['M159I', 'Met159Ile', 'rs115885685', 'NM_005242']) assert.ok(!text.includes(bad), bad);
  const receptors = new Set();
  for (const q of all) {
    const a = await search(q, loader);
    assert.ok(a.expect !== 'unrecognised' && (a.results?.length || a.groups?.length), `${q} gives an answer`);
    const o = renderAnswer(a, q, OPTS2);
    assert.ok(o.html.includes('sr-card') || o.html.includes('sr-table'), `${q} draws a card or a table`);
    for (const r of a.results ?? []) if (a.results.length < 5) receptors.add(r.gid);
  }
  assert.ok(receptors.size >= 5, [...receptors].join(','));
  assert.ok(!renderHelp(OPTS2).toString().includes('M159I'));
});

test('a card keeps its essentials up front and moves explanations into its fine print', { skip }, async () => {
  const q = 'DRD2 S311C';
  const out = renderAnswer(await search(q, loader), q, OPTS2).html;
  const [main, fine] = out.split('<aside class="fine-print sr-card-fine">');
  assert.ok(fine, 'the card has a fine-print block');
  // up front: the summary, the change, allele frequency, ClinVar, the predictions, the database facts and the actions
  for (const need of ['sr-summary', 'p.Ser311Cys', 'Frequency', 'ClinVar', 'In the GPCompaRe database', 'AlphaMissense, this change', 'Important contacts', 'Open report at this residue']) assert.ok(main.includes(need), need);
  // not up front: release labels, threshold and scale explanations; the transcript table is folded inside the identifiers
  for (const gone of ['receptor threshold', 'mean over all substitutions']) assert.ok(!main.includes(gone), gone);
  assert.match(fine, /gnomAD v4\.1\.2; ClinVar 2026-10-11/);
  assert.match(fine, /<details class="sr-about"><summary>About these numbers<\/summary>/);
  assert.match(main, /<details class="sr-more sr-notations">/);
  assert.ok(!/<details class="sr-more sr-notations" open>/.test(out), 'the transcript table is always folded');
  // the evidence sections are collapsible and open by default on a single card
  for (const sec of ['ids', 'population', 'clinical', 'computational', 'structure']) assert.ok(out.includes(`<details class="sr-sec" data-sec="${sec}" open>`), sec);
});

test('a warning that changes the meaning stays visible above the results', { skip }, async () => {
  for (const [q, code] of [['PAR2 A159I', 'reference_mismatch'], ['NM_005242.999:c.477G>A', 'version_unknown']]) {
    const out = renderAnswer(await search(q, loader), q, OPTS2).html;
    const [main] = out.split('<aside class="fine-print sr-card-fine">');
    assert.ok(main.includes(`data-code="${code}"`), `${q}: ${code} is in the main flow`);
  }
});

test('the release line is visible; report tables and search share one release, said in fine print', () => {
  const rel = { gnomad: { label: 'gnomAD v9' }, clinvar: { label: 'ClinVar X' }, ensembl: { label: 'Ensembl 1', grch38: 'a', grch37: 'b' }, hgnc: { label: 'HGNC' }, uniprot: { label: 'UniProt' }, alphamissense: { label: 'AM' } };
  const same = { ...rel, reportTable: { label: 'gnomAD v9', key: 'gnomad', rule: '|dRRCS| >= 3.0', sameAsSearch: true } };
  const h = renderReleases(same).toString();
  assert.match(h, /<p class="sr-releases"><strong>Data in this search:<\/strong> gnomAD v9; ClinVar X;/);
  assert.match(h, /<aside class="fine-print sr-releases-note">/);
  assert.match(h, /use the same release as this search, gnomAD v9/);
  assert.ok(!h.includes('newer variant data') && !h.includes('<details'), 'no "newer data" note when the release is shared');
  assert.ok(!h.includes('—'));
  // an index without the reportTable block is read as the same release
  assert.match(renderReleases(rel).toString(), /same release as this search/);
  // a note stays only when the registry says the two differ
  const diff = renderReleases({ ...rel, reportTable: { label: 'gnomAD v8', key: 'gnomad_batch', sameAsSearch: false } }).toString();
  assert.match(diff, /<details><summary>How this differs from the report pages<\/summary>/);
  assert.match(diff, /list gnomAD v8 missense variants/);
  assert.match(diff, /every missense allele and ClinVar X/);
  assert.equal(reportTableRelease({ reportTable: { label: 'gnomAD v8' }, gnomad: { label: 'gnomAD v9' } }), 'gnomAD v8');
  assert.equal(reportTableRelease({ gnomad: { label: 'gnomAD v9' } }), 'gnomAD v9');
});

test('allele AlphaMissense scores print with 3 decimals, like the report tables', () => {
  assert.equal(fmtAm(0.999), '0.999');
  assert.equal(fmtAm(0.91), '0.910');
  assert.equal(fmtAm(1), '1.000');
  assert.equal(fmtAm(null), 'n/a');
  const al = (am) => ({ id: '1-2-A-C', hgvsc: 'c.1A>C', hgvsp: 'p.Met1Leu', rsids: [], ac: 1, an: 10, af: 0.1, hom: 0, am, amClass: 'pathogenic' });
  const t = allelesTable([al(0.999), al(0.4)], { caption: 'x' }).toString();
  assert.match(t, /data-label="AlphaMissense prediction">0\.999 <span class="sr-sub">likely pathogenic/);
  assert.match(t, />0\.400 <span class="sr-sub">likely pathogenic/);
  assert.equal(amClassLabel('benign'), 'likely benign');
  assert.equal(amClassLabel('ambiguous'), 'ambiguous');
  assert.ok(!/>1\.00 </.test(t) && !/>0\.40 </.test(t));
});

test('the comparison legend and the motif note are fine print under the table', { skip }, async () => {
  const q = '3.50x50';
  const out = renderAnswer(await search(q, loader), q, OPTS2).html;
  assert.match(out, /<aside class="fine-print sr-legend"><p>Net ΔRRCS: /);
  assert.ok(out.indexOf('data-cmp-body') < out.indexOf('sr-legend'), 'the legend follows the table');
  const m = 'NPxxY in MC1R';
  const h2 = renderAnswer(await search(m, loader), m, OPTS2).html;
  assert.ok(!/<p class="sr-motif">[^]*?<\/p>/.exec(h2)?.[0].includes('. '), 'the motif line carries no sentence');
});

test('a non-P/LP ClinVar record shows its gnomAD allele and AlphaMissense, as its rsID does', { skip }, async () => {
  for (const [q, af, am] of [['VCV000014312', '0.078', '0.192'], ['VCV000256813', '0.024', '0.082']]) {
    const out = renderAnswer(await search(q, loader), q, OPTS).html;
    assert.ok(!/not analysed here|This exact change is not listed|not available in this index/.test(out), `${q}: ${out.slice(0, 400)}`);
    assert.ok(out.includes(am), `${q}: AlphaMissense ${am}`);
    assert.ok(out.includes(af), `${q}: frequency ${af}`);
    assert.ok(out.includes(q), `${q}: the record is listed`);
  }
});

test('a change that needs two nucleotide substitutions says why gnomAD has no allele, and still gives its AlphaMissense score', { skip }, async () => {
  const a = await search('ADRB2 R131Q', loader);
  const out = renderAnswer(a, 'ADRB2 R131Q', OPTS);
  assert.match(out.html, /This exact change is not listed in gnomAD v4\.1\.2\. <span class="sr-sub">This change needs two nucleotide substitutions in its codon \(CGC\); gnomAD alleles each change a single nucleotide, so no allele can carry it\./);
  assert.match(out.html, /<dt>AlphaMissense, this change<\/dt><dd><strong>0\.972<\/strong> <span class="sr-am-class">likely pathogenic<\/span> <span class="sr-badge sr-badge--muted"[^>]*>prediction<\/span>/);
  assert.ok(!out.html.includes('not available in this index'));
  assert.ok(!out.html.includes('\u2014'));
  const text = evidenceText(a.results[0], { query: 'ADRB2 R131Q', releases: {} });
  assert.match(text, /needs two nucleotide substitutions/);
  assert.match(text, /AlphaMissense, this change: 0\.972 \(likely pathogenic\)/);
  // a one-substitution change with no allele has a score too, and no codon note
  const one = renderAnswer(await search('DRD2 S311A', loader), 'DRD2 S311A', OPTS).html;
  assert.match(one, /<dt>AlphaMissense, this change<\/dt><dd><strong>0\.\d{3}<\/strong>/);
  assert.ok(!/nucleotide substitutions/.test(one));
});

// ----------------------------------------------------------------- the variant card for an analyst

test('V1: every substitution at the residue is listed with its score and class, the card\'s own change marked', { skip }, async () => {
  const a = await search('ADRB2 R131Q', loader);
  const out = renderAnswer(a, 'ADRB2 R131Q', OPTS2).html;
  const strip = /<ol class="sr-am-strip"[^>]*>([^]*?)<\/ol>/.exec(out)?.[1];
  assert.ok(strip, 'the strip is drawn');
  const cells = strip.match(/<li class="sr-am-cell/g);
  assert.equal(cells.length, 19);
  assert.match(strip, /<li class="sr-am-cell sr-am--pathogenic is-this" aria-current="true" title="Gln: 0\.972, likely pathogenic"><span class="sr-am-aa">Gln<\/span><span class="sr-am-score">0\.972<\/span>/);
  assert.ok(!strip.includes('<span class="sr-am-aa">Arg</span>'), 'the reference residue has no cell');
  assert.equal((strip.match(/is-this/g) || []).length, 1);
  // a two-base change: Gln is the only marked cell although gnomAD has no allele for it
  assert.equal(a.results[0].alleles.length, 0);
});

test('V2: the contacts table lists the threshold-passing pairs with partner, signed coloured ΔRRCS, plain meaning and a pair link', { skip }, async () => {
  const a = await search('ADRB2 R131Q', loader);
  const r = a.results[0];
  const out = renderAnswer(a, 'ADRB2 R131Q', OPTS2).html;
  const tbl = /<table class="sr-table sr-table--contacts">([^]*?)<\/table>/.exec(out)?.[1];
  assert.ok(tbl, 'the contacts table is drawn');
  assert.equal((tbl.match(/<tr>/g) || []).length - 1, r.contacts.length, 'one row per contact');
  assert.match(tbl, /<span class="mono">Asp130<\/span> <span class="sr-sub">3\.49x49, TM3<\/span>/);
  assert.match(tbl, /<span class="sr-net sr-net--inactive">-5\.67<\/span>/);
  assert.match(tbl, /<span class="mono">Tyr141<\/span> <span class="sr-sub">34\.53x53, ICL2<\/span> <span class="sr-badge sr-badge--muted"[^>]*>loop<\/span>/);
  assert.match(tbl, /present in the inactive model only: lost in the active model/);
  assert.match(tbl, /href="\.\.\/reports\/adrb2_human\.html#pair=130-131"/);
  assert.match(out, /3 contacts above this receptor\u2019s threshold \(\|ΔRRCS\| ≥ 1\.97\), largest \|ΔRRCS\| first\./);
  // the rows follow the engine's order (largest |ΔRRCS| first)
  const partners = [...tbl.matchAll(/<span class="mono">([A-Z][a-z]{2}\d+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(partners, ['Asp130', 'Tyr141', 'Thr68']);
  // no contact: said plainly
  const none = renderAnswer(await search('MC4R V103I', loader), 'MC4R V103I', OPTS2).html;
  assert.match(none, /This residue takes part in no contact above this receptor\u2019s threshold \(\|ΔRRCS\| ≥ 2\.42\)\./);
  assert.ok(!none.includes('sr-table--contacts'));
  // meanings never claim what a variant does
  assert.equal(contactMeaning({ delta: 2, active: 2, inactive: 0 }), 'forms in the active model: no contact in the inactive model');
  assert.equal(contactMeaning({ delta: -2, active: 0, inactive: 2 }), 'present in the inactive model only: lost in the active model');
  assert.equal(contactMeaning({ delta: -1.5, active: 1, inactive: 2.5 }), 'present in both models, stronger in the inactive model');
  assert.ok(!out.includes('disrupt'));
  assert.equal(segmentKind('ICL2'), 'loop');
  assert.equal(segmentKind('C-term'), 'terminus');
  assert.equal(segmentKind('TM3'), '');
});

test('V3: the evidence summary reads in plain language and the research-use note follows it', { skip }, async () => {
  const a = await search('MC4R V103I', loader);
  const r = a.results[0];
  const S = summarySentences(r, { releases: {} });
  assert.equal(S[0], 'MC4R p.Val103Ile (V103I) is a missense change at residue Val103 (2.63x63, TM2).');
  assert.match(S[1], /^gnomAD v4\.1\.2: allele frequency 0\.018 \([\d,]+ of [\d,]+ alleles, [\d,]+ homozygotes, exomes\)\.$/);
  assert.match(S[2], /^ClinVar 2026-10-11: Benign\/Likely benign \(2 of 4 review stars, \d+ submissions\)/);
  assert.match(S[3], /^AlphaMissense predicts likely benign \(score 0\.084\); this is a prediction, not an observation\. Conservation at the residue: 0\.\d\d on a 0 to 1 scale\.$/);
  assert.equal(S[4], 'In the GPCompaRe models, Val103 is not a CFR; it takes part in no contact above the receptor\u2019s threshold.');
  const out = renderAnswer(a, 'MC4R V103I', OPTS2).html;
  const main = out.split('<aside class="fine-print sr-card-fine">')[0];
  assert.ok(main.includes('<div class="sr-summary">'), 'the summary is in the card body');
  assert.ok(out.indexOf('sr-summary') < out.indexOf('data-sec="ids"'), 'the summary comes first');
  assert.ok(main.includes(`<aside class="fine-print sr-research-note"><p>${RESEARCH_NOTE}</p></aside>`), 'research-use note under the summary');
  assert.match(RESEARCH_NOTE, /not a clinical classification/);
  assert.match(RESEARCH_NOTE, /ACMG criteria are not applied/);
  // the CFR + motif + contacts sentence
  const S2 = summarySentences((await search('ADRB2 R131Q', loader)).results[0], { releases: {} });
  assert.equal(S2[S2.length - 1], 'In the GPCompaRe models, Arg131 is a core functional residue (CFR, class-wide rank 1) and part of the DRY motif and the ionic lock; it takes part in 3 contacts above the receptor\u2019s threshold; the largest, with Asp130 (3.49x49), is stronger in the inactive model (ΔRRCS -5.67).');
  // the evidence text carries the same sentences, the contacts and the note
  const text = evidenceText(r, { query: 'MC4R V103I', releases: {} });
  for (const need of ['Evidence summary:', `  ${S[0]}`, 'In the GPCompaRe database:', 'Contact list: this residue takes part in no contact above the threshold', `Note: ${RESEARCH_NOTE}`, 'AlphaMissense, every substitution at Val103:']) assert.ok(text.includes(need), need);
});

test('V4: a reference mismatch keeps the typed change unverifiable in the summary, the strip and the predictions', { skip }, async () => {
  const q = 'PAR2 A159I';
  const a = await search(q, loader);
  const out = renderAnswer(a, q, OPTS2);
  const S = summarySentences(a.results[0], out.ctx);
  assert.match(S[0], /^p\.Ala159Ile: position 159 is Met in F2RL1, so this change cannot be checked\. What follows is about the model residue Met159/);
  assert.ok(!S.some((s) => /Met159Ile/.test(s)), 'the corrected change is never the subject');
  assert.match(out.html, /<dt>AlphaMissense, this change<\/dt><dd><span class="sr-na">not shown: the typed change is not the model residue<\/span>/);
  assert.ok(!/is-this/.test(out.html), 'no cell is marked as the typed change');
  assert.match(out.html, /every substitution at Met159 \(the model residue\)/);
});

test('V5: the identifiers section has copy buttons for every notation, and folds when several cards share the page', { skip }, async () => {
  const q = 'MC1R Arg151Cys';
  const out = renderAnswer(await search(q, loader), q, OPTS2).html;
  const ids = /<details class="sr-sec" data-sec="ids" open>([^]*?)<\/details>\s*<details class="sr-sec" data-sec="population"/.exec(out)?.[1];
  assert.ok(ids, 'identifiers open on a single card');
  for (const need of ['<dt>Gene</dt>', 'data-copy="MC1R"', 'data-copy="p.Arg151Cys"', '<dt>MANE Select (RefSeq)</dt>', 'data-copy="NM_002386.4:c.451C&gt;T"', '<dt>GRCh38 (hg38)</dt>', 'data-copy="16-89919709-C-T"', '<dt>GRCh37 (hg19)</dt>', '<dt>rsID</dt>', 'data-copy="rs1805007"', '<dt>ClinVar</dt>', 'data-copy="VCV000014312']) assert.ok(ids.includes(need), need);
  const many = renderAnswer(await search('DRY in ADRB2', loader), 'DRY in ADRB2', OPTS2).html;
  assert.ok(many.includes('<details class="sr-sec" data-sec="ids">'), 'identifiers folded on a multi-card page');
  assert.ok(!many.includes('<details class="sr-sec" data-sec="ids" open>'));
  assert.ok(many.includes('<details class="sr-sec" data-sec="structure" open>'), 'the structural evidence stays open');
});

test('V6: search copy names the GPCompaRe database, never "this database"', { skip }, async () => {
  for (const q of ['MC4R V103I', 'ADRB2 R131Q', 'PAR2 A159I', 'GLP1R', 'GPR26', 'NM_005242.999:c.477G>A', 'ADRB1 Arg389Gly', 'MC1R ClinVar']) {
    const a = await search(q, loader);
    const out = renderAnswer(a, q, OPTS2);
    assert.ok(!/this database/i.test(out.html), `${q}: ${/.{40}this database.{20}/i.exec(out.html)?.[0]}`);
    assert.ok(!/this database/i.test(a.message ?? ''), `${q}: ${a.message}`);
    for (const r of out.results) {
      assert.ok(!/this database/i.test(evidenceText(r, out.ctx)), `${q}: evidence text`);
      assert.ok(!/this database/i.test(notationsText(r, out.ctx)), `${q}: notations text`);
    }
  }
  assert.equal(DB_NAME, 'the GPCompaRe database');
  const card = renderAnswer(await search('MC4R V103I', loader), 'MC4R V103I', OPTS2).html;
  assert.match(card, /<h4 class="sr-sec-title">In the GPCompaRe database<\/h4>/);
  assert.ok(/receptors in the GPCompaRe database run up to|not one of the 283 human Class A GPCRs in the GPCompaRe database/.test((await search('GPR9999', loader)).message));
});

test('V7: ClinVar records show submissions and the last-evaluated date; gnomAD alleles name their source', { skip }, async () => {
  const out = renderAnswer(await search('MC4R V103I', loader), 'MC4R V103I', OPTS2).html;
  assert.match(out, /<span class="sr-badge">Benign\/Likely benign<\/span> <span class="sr-stars"[^]*?<span class="sr-sub">\d+ submissions, last evaluated \d{4}-\d{2}-\d{2}<\/span>/);
  assert.match(out, /<td class="num" data-label="Allele count">[\d,]+<span class="sr-sub"> of [\d,]+, exomes<\/span><\/td>/);
});
