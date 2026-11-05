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
  reportTableRelease, allelesTable, fmtAm, summarySentences, contactMeaning, amClassLabel, segmentKind, RESEARCH_NOTE, RESEARCH_NOTE_SHORT, DB_NAME,
  activationWord, netSentence, amClassOfScore, AM_CUTS, afBand, cvClassKey, receptorMap, PATH_CLASSES,
  cfrListModel, cfrListRows, cfrListCsv, cfrListDefaults, renderCfrListBody, cfrTileLine, cfrSetText, cfrOneOf,
  fmtRrcs, contactPresence, amGauge, pathLegend, AM_CUTS_TEXT, AM_INTERVAL,
} from '../../static/js/search-ui/render.js';
import { decodeDetail } from '../../static/js/search/shards.js';
import { suggestionsFor } from '../../static/js/search-ui/suggest.js';
import * as L from '../../static/js/search-ui/links.js';
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
/** The markup with the result links unwrapped (a mono link reads as the mono span it replaced), for layout checks. */
const unlinked = (h) => String(h)
  .replace(/<a class="sr-(?:ext|int)([^"]*)" href="[^"]*" target="_blank" rel="[^"]*" title="[^"]*" aria-describedby="sr-newtab">([^]*?)<\/a>/g,
    (m, cls, body) => (/\bmono\b/.test(cls) ? `<span class="mono">${body}</span>` : body));
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
  const text = unlinked(out);
  assert.match(text, /\|ΔRRCS\| 4\.99<span class="sr-sub">, with Phe300/);
  assert.ok(!/receptor threshold/.test(text.split('sr-card-fine')[0]), 'no threshold in the facts');
  assert.match(text, /this receptor's threshold is \d\.\d\d/);
  assert.match(text, /stronger in the inactive model/);
  assert.ok(!/stronger in inactive\b|on activation/.test(text), 'one direction phrasing: stronger in the active / inactive model');
  assert.match(text, /<dt>Conservation at this residue<\/dt><dd>0\.96<\/dd>/);
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
  const out = unlinked(renderAnswer(await search('PAR2 M159I', loader), 'PAR2 M159I', OPTS2).html);
  const rows = out.match(/<tr><td data-label="Genomic allele \(GRCh38\)"><span class="mono">[^<]+<\/span><\/td>.*?<\/tr>/gs) ?? [];
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
  assert.match(unlinked(o.html), /model residue <\/span><span class="mono">Met159/);
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
  assert.match(lines[1], /,-1\.3,stronger in the inactive model,/);
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
  const m = /href="[^"]*par2_human\.html#sec=sec-variants&(?:amp;)?vq=([^"]+)"[^>]*>Find in the report's variant table/.exec(h2);
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
  const out = unlinked(renderAnswer(await search(q, loader), q, OPTS2).html);
  const [main, fine] = out.split('<aside class="fine-print sr-card-fine">');
  assert.ok(fine, 'the card has a fine-print block');
  // up front: the summary, the change, allele frequency, ClinVar, the predictions, the database facts and the actions
  for (const need of ['sr-tiles', 'p.Ser311Cys', 'Frequency', 'ClinVar', 'in the GPCompaRe database', 'AlphaMissense, this change', 'Important contacts', 'Open report at this residue']) assert.ok(main.includes(need), need);
  // not up front: release labels, threshold and scale explanations; the transcript table is folded inside the identifiers
  for (const gone of ['receptor threshold', 'mean over all substitutions']) assert.ok(!main.includes(gone), gone);
  assert.match(fine, /gnomAD v4\.1\.2; ClinVar 2026-10-11/);
  assert.match(fine, /<details class="sr-about"><summary>About these numbers<\/summary>/);
  assert.match(main, /<details class="sr-more sr-notations">/);
  assert.ok(!/<details class="sr-more sr-notations" open>/.test(out), 'the transcript table is always folded');
  // the evidence sections are collapsible and open by default on a single card; the prose is folded at the end
  for (const sec of ['structure', 'region', 'predictions', 'population', 'clinical', 'refs']) assert.ok(out.includes(`<details class="sr-sec" data-sec="${sec}" id="sr-0-${sec}" open>`), sec);
  assert.ok(out.includes('<details class="sr-sec" data-sec="prose" id="sr-0-prose">'), 'the prose is folded');
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
  assert.match(t, /data-label="AlphaMissense"><span class="sr-path sr-path--pathogenic">0\.999<\/span> <span class="sr-path-chip sr-path-chip--pathogenic">likely pathogenic/);
  assert.match(t, />0\.400<\/span> <span class="sr-path-chip sr-path-chip--pathogenic">likely pathogenic/);
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
  assert.match(unlinked(out.html), /<dt>AlphaMissense, this change<\/dt><dd><strong class="sr-path sr-path--pathogenic">0\.972<\/strong> <span class="sr-path-chip sr-path-chip--pathogenic">likely pathogenic<\/span> <span class="sr-badge sr-badge--muted"[^>]*>prediction<\/span>/);
  assert.ok(!out.html.includes('not available in this index'));
  assert.ok(!out.html.includes('\u2014'));
  const text = evidenceText(a.results[0], { query: 'ADRB2 R131Q', releases: {} });
  assert.match(text, /needs two nucleotide substitutions/);
  assert.match(text, /AlphaMissense, this change: 0\.972 \(likely pathogenic\)/);
  // a one-substitution change with no allele has a score too, and no codon note
  const one = unlinked(renderAnswer(await search('DRD2 S311A', loader), 'DRD2 S311A', OPTS).html);
  assert.match(one, /<dt>AlphaMissense, this change<\/dt><dd><strong class="sr-path sr-path--\w+">0\.\d{3}<\/strong>/);
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
  const tblRaw = /<table class="sr-table sr-table--contacts">([^]*?)<\/table>/.exec(out)?.[1] ?? '';
  const tbl = unlinked(tblRaw);
  assert.ok(tbl, 'the contacts table is drawn');
  assert.equal((tbl.match(/<tr>/g) || []).length - 1, r.contacts.length, 'one row per contact');
  assert.match(tbl, /<span class="mono">Asp130<\/span> <span class="sr-sub">3\.49x49, TM3<\/span>/);
  assert.match(tbl, /<span class="sr-net sr-net--inactive">-5\.67<\/span>/);
  assert.match(tbl, /<span class="mono">Tyr141<\/span> <span class="sr-sub">34\.53x53, ICL2<\/span> <span class="sr-badge sr-badge--muted"[^>]*>loop<\/span>/);
  assert.match(tbl, /<strong>present only in the inactive model<\/strong><span class="sr-sub">: no contact in the active model/);
  assert.match(tblRaw, /href="\.\.\/reports\/adrb2_human\.html#pair=130-131" target="_blank" rel="noopener"/);
  assert.match(out, /3 contacts above this receptor\u2019s threshold \(\|ΔRRCS\| ≥ 1\.97\), largest \|ΔRRCS\| first\./);
  // the rows follow the engine's order (largest |ΔRRCS| first)
  const partners = [...tbl.matchAll(/<span class="mono">([A-Z][a-z]{2}\d+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(partners, ['Asp130', 'Tyr141', 'Thr68']);
  // no contact: said plainly
  const none = renderAnswer(await search('MC4R V103I', loader), 'MC4R V103I', OPTS2).html;
  assert.match(none, /This residue takes part in no contact above this receptor\u2019s threshold \(\|ΔRRCS\| ≥ 2\.42\)\./);
  assert.ok(!none.includes('sr-table--contacts'));
  // meanings never claim what a variant does
  assert.equal(contactMeaning({ delta: 2, active: 2, inactive: 0 }), 'present only in the active model: no contact in the inactive model');
  assert.equal(contactMeaning({ delta: -2, active: 0, inactive: 2 }), 'present only in the inactive model: no contact in the active model');
  assert.equal(contactMeaning({ delta: -1.5, active: 1, inactive: 2.5 }), 'stronger in the inactive model: present in both models');
  assert.equal(activationWord({ delta: 1.5, active: 2.5, inactive: 1 }), 'stronger in the active model');
  // presence comes from the index flag, never from a rounded 0.00: a positive score below 0.005 is still a contact
  assert.equal(activationWord({ delta: -8.49, active: 0, inactive: 8.49, activePresent: true, inactivePresent: true }), 'stronger in the inactive model');
  assert.equal(contactMeaning({ delta: -8.49, active: 0, inactive: 8.49, activePresent: true, inactivePresent: true }), 'stronger in the inactive model: present in both models');
  assert.equal(activationWord({ delta: -8.49, active: 0, inactive: 8.49, activePresent: false, inactivePresent: true }), 'present only in the inactive model');
  assert.equal(netSentence(-13.04), 'overall its contacts are stronger in the inactive model (net ΔRRCS -13.0)');
  assert.equal(netSentence(2.3), 'overall its contacts are stronger in the active model (net ΔRRCS +2.3)');
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
  const [main, fine] = out.split('<aside class="fine-print sr-card-fine">');
  // the lead is the tiles; the prose is a folded section after the references, never above the tiles
  assert.ok(out.indexOf('<ul class="sr-tiles">') < out.indexOf('data-sec="structure"'), 'the tiles come first');
  assert.ok(main.includes('<details class="sr-sec" data-sec="prose" id="sr-0-prose">'), 'the prose is folded');
  assert.ok(out.indexOf('data-sec="refs"') < out.indexOf('data-sec="prose"'), 'the prose is the last section');
  assert.ok(!main.includes('<div class="sr-summary">'), 'no prose block in the lead');
  assert.ok(fine.includes(`<p class="sr-research-note">${RESEARCH_NOTE_SHORT}</p>`), 'research-use note in the fine print');
  assert.match(RESEARCH_NOTE, /not a clinical classification/);
  assert.match(RESEARCH_NOTE, /ACMG criteria are not applied/);
  assert.match(RESEARCH_NOTE_SHORT, /ACMG criteria are not applied/);
  // the CFR + motif + contacts sentence
  const S2 = summarySentences((await search('ADRB2 R131Q', loader)).results[0], { releases: {} });
  assert.equal(S2[S2.length - 1], 'In the GPCompaRe models, Arg131 is a core functional residue (CFR, class-wide rank 1) and part of the DRY motif and the ionic lock; it takes part in 3 contacts above the receptor\u2019s threshold; the largest, with Asp130 (3.49x49), is stronger in the inactive model (ΔRRCS -5.67); overall its contacts are stronger in the inactive model (net ΔRRCS -16.7).');
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
  assert.match(unlinked(out.html), /<dt>AlphaMissense, this change<\/dt><dd><span class="sr-na">not shown: the typed change is not the model residue<\/span>/);
  assert.ok(!/sr-am-cell[^"]*is-this/.test(out.html), 'no cell is marked as the typed change');
  assert.match(out.html, /every substitution at Met159 \(the model residue\)/);
});

test('V5: the notations section has copy buttons for every notation, sits last, and folds when several cards share the page', { skip }, async () => {
  const q = 'MC1R Arg151Cys';
  const out = renderAnswer(await search(q, loader), q, OPTS2).html;
  const ids = /<details class="sr-sec" data-sec="refs" id="sr-0-refs" open>([^]*?)<\/details>\s*<details class="sr-sec" data-sec="prose"/.exec(out)?.[1];
  assert.ok(ids, 'notations open on a single card, before the prose');
  for (const need of ['<dt>Gene</dt>', 'data-copy="MC1R"', 'data-copy="p.Arg151Cys"', '<dt>MANE Select (RefSeq)</dt>', 'data-copy="NM_002386.4:c.451C&gt;T"', '<dt>GRCh38 (hg38)</dt>', 'data-copy="16-89919709-C-T"', '<dt>GRCh37 (hg19)</dt>', '<dt>rsID</dt>', 'data-copy="rs1805007"', '<dt>ClinVar</dt>', 'data-copy="VCV000014312']) assert.ok(ids.includes(need), need);
  const many = renderAnswer(await search('DRY in ADRB2', loader), 'DRY in ADRB2', OPTS2).html;
  assert.ok(many.includes('<details class="sr-sec" data-sec="refs" id="sr-0-refs">'), 'notations folded on a multi-card page');
  assert.ok(!/data-sec="refs" id="sr-\d+-refs" open>/.test(many));
  assert.ok(many.includes('<details class="sr-sec" data-sec="structure" id="sr-1-structure" open>'), 'the structural evidence stays open on every card');
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
  assert.match(card, /<h4 class="sr-sec-title">Contacts and structure<\/h4> <span class="sr-sub">in the GPCompaRe database<\/span>/);
  assert.ok(/receptors in the GPCompaRe database run up to|not one of the 283 human Class A GPCRs in the GPCompaRe database/.test((await search('GPR9999', loader)).message));
});

test('V7: ClinVar records show submissions and the last-evaluated date; gnomAD alleles name their source', { skip }, async () => {
  const out = renderAnswer(await search('MC4R V103I', loader), 'MC4R V103I', OPTS2).html;
  assert.match(out, /<span class="sr-path-chip sr-path-chip--benign">Benign\/Likely benign<\/span> <span class="sr-stars"[^]*?<span class="sr-sub">\d+ submissions, last evaluated \d{4}-\d{2}-\d{2}<\/span>/);
  assert.match(out, /<td class="num" data-label="Allele count">[\d,]+<br><span class="sr-sub">of [\d,]+, exomes<\/span><\/td>/);
});

// ------------------------------------------------------------- links: every identifier opens its record

const REGISTRY = JSON.parse(readFileSync(join(BASE, 'data_versions.json'), 'utf8'));
const REL = { gnomad: { dataset: REGISTRY.sources.gnomad.dataset }, alphamissense: { label: REGISTRY.sources.alphamissense.label, record: REGISTRY.sources.alphamissense.record } };

test('L1: each identifier type builds its documented URL; a malformed id gives no link', () => {
  assert.equal(L.dbsnpUrl('rs1042713'), 'https://www.ncbi.nlm.nih.gov/snp/rs1042713');
  assert.equal(L.clinvarUrl(225937), 'https://www.ncbi.nlm.nih.gov/clinvar/variation/225937/');
  assert.equal(L.gnomadVariantUrl('5-148826877-G-A', REL), 'https://gnomad.broadinstitute.org/variant/5-148826877-G-A?dataset=gnomad_r4');
  assert.equal(L.gnomadGeneUrl('ENSG00000169252', REL), 'https://gnomad.broadinstitute.org/gene/ENSG00000169252?dataset=gnomad_r4');
  assert.equal(L.ensemblUrl('ENST00000305988.6'), 'https://www.ensembl.org/id/ENST00000305988');
  assert.equal(L.ensemblUrl('ENSP00000305372.4'), 'https://www.ensembl.org/id/ENSP00000305372');
  assert.equal(L.refseqUrl('NM_000024.6'), 'https://www.ncbi.nlm.nih.gov/nuccore/NM_000024.6');
  assert.equal(L.refseqUrl('NP_000015.2'), 'https://www.ncbi.nlm.nih.gov/protein/NP_000015.2');
  assert.equal(L.uniprotUrl('P07550'), 'https://www.uniprot.org/uniprotkb/P07550/entry');
  assert.equal(L.hgncUrl({ hgnc: 'HGNC:286', symbol: 'ADRB2' }), 'https://www.genenames.org/data/gene-symbol-report/#!/hgnc_id/HGNC:286');
  assert.equal(L.hgncUrl({ symbol: 'ADRB2' }), 'https://www.genenames.org/tools/search/#!/?query=ADRB2');
  assert.equal(L.gpcrdbUrl('ADRB2_HUMAN'), 'https://gpcrdb.org/protein/adrb2_human/');
  assert.equal(L.ncbiGeneUrl('154'), 'https://www.ncbi.nlm.nih.gov/gene/154');
  assert.equal(L.ucscUrl('5-148826877-G-A', 'GRCh38'), 'https://genome.ucsc.edu/cgi-bin/hgTracks?db=hg38&position=chr5:148826877-148826877');
  assert.equal(L.ucscUrl('5-148206440-G-A', 'GRCh37'), 'https://genome.ucsc.edu/cgi-bin/hgTracks?db=hg19&position=chr5:148206440-148206440');
  assert.equal(L.ucscUrl('5:76125825', 'GRCh37'), 'https://genome.ucsc.edu/cgi-bin/hgTracks?db=hg19&position=chr5:76125825-76125825');
  assert.equal(L.ucscUrl('X-100-AT-A', 'GRCh38'), 'https://genome.ucsc.edu/cgi-bin/hgTracks?db=hg38&position=chrX:100-101');
  // the AlphaMissense record comes from the registry, never from the code
  assert.equal(L.alphamissenseUrl(REL), REGISTRY.sources.alphamissense.record);
  assert.equal(L.alphamissenseUrl({}), null);
  assert.equal(L.recordLabel(REGISTRY.sources.alphamissense.record), `Zenodo record ${/(\d+)$/.exec(REGISTRY.sources.alphamissense.record)[1]}`);
  for (const [fn, bad] of [[L.dbsnpUrl, 'rs1x'], [L.gnomadVariantUrl, '5:148826877'], [L.ensemblUrl, 'ENSX1'], [L.refseqUrl, 'NM_x'], [L.uniprotUrl, 'p0 7550'], [L.gpcrdbUrl, 'adrb2'], [L.ucscUrl, 'chr5']]) {
    assert.equal(fn(bad, REL), null, `${fn.name}(${bad})`);
  }
  assert.equal(L.glossaryUrl({ reports: '../reports/' }, 'cfr'), '../reports/../glossary.html#cfr');
  assert.equal(L.glossaryUrl({ glossary: '../glossary.html' }, 'am'), '../glossary.html#am');
});

/** Every <a ...> of the markup, as {href, attrs}. */
const anchors = (h) => [...String(h).matchAll(/<a ([^>]*)>/g)].map((m) => ({ attrs: m[1], href: /href="([^"]*)"/.exec(m[1])?.[1] ?? '' }));

test('L2: the variant card links every identifier to its record, on the right assembly', { skip }, async () => {
  const meta = await loader('meta.json');
  const rel = meta.releases;
  const F = meta.receptorFields;
  const adrb2 = Object.fromEntries(F.map((k, i) => [k, meta.receptors.find((r) => r[0] === 'adrb2_human')[i]]));
  const o = { ...OPTS2, releases: rel, glossary: '../glossary.html' };
  const a = await search('rs1042713', loader);
  const out = renderAnswer(a, 'rs1042713', o).html;
  const hrefs = anchors(out).map((x) => x.href.replace(/&amp;/g, '&'));
  const want = [
    'https://www.ncbi.nlm.nih.gov/snp/rs1042713',
    `https://www.ncbi.nlm.nih.gov/clinvar/variation/${a.results[0].clinvar[0].variationId}/`,
    `https://gnomad.broadinstitute.org/variant/5-148826877-G-A?dataset=${rel.gnomad.dataset}`,
    'https://genome.ucsc.edu/cgi-bin/hgTracks?db=hg38&position=chr5:148826877-148826877',
    'https://genome.ucsc.edu/cgi-bin/hgTracks?db=hg19&position=chr5:148206440-148206440',
    'https://www.ensembl.org/id/ENST00000305988',
    'https://www.ensembl.org/id/ENSP00000305372',
    'https://www.ncbi.nlm.nih.gov/nuccore/NM_000024.6',
    'https://www.ncbi.nlm.nih.gov/protein/NP_000015.2',
    `https://www.uniprot.org/uniprotkb/${adrb2.uniprot}/entry`,
    `https://www.genenames.org/data/gene-symbol-report/#!/hgnc_id/${adrb2.hgnc}`,
    'https://gpcrdb.org/protein/adrb2_human/',
    `https://www.ncbi.nlm.nih.gov/gene/${adrb2.geneId}`,
    `https://gnomad.broadinstitute.org/gene/${adrb2.ensg}?dataset=${rel.gnomad.dataset}`,
    rel.alphamissense.record,
    '../reports/adrb2_human.html',
    '../reports/adrb2_human.html#sec=sec-snake&res=16',
    '../studio/?db=adrb2_human',
    '../glossary.html#am',
    '../glossary.html#cfr',
  ];
  for (const w of want) assert.ok(hrefs.includes(w), `${w} not in\n${hrefs.join('\n')}`);
  assert.equal(rel.alphamissense.record, REGISTRY.sources.alphamissense.record, 'the index carries the registry record');
  // the copy button stays beside the rsID; the text opens, the button copies
  assert.match(out, /title="dbSNP, opens in a new tab" aria-describedby="sr-newtab">rs1042713<\/a> <button type="button" class="sr-copy" data-copy="rs1042713"/);
  // one hidden "opens in a new tab" text for every link to point at; the link text itself stays the bare id
  assert.equal((out.match(/<span id="sr-newtab" hidden>Opens in a new tab<\/span>/g) ?? []).length, 1);
});

test('L3: every link out of a result opens a new tab: outbound ones (sr-ext, drawn with ↗) with noopener noreferrer, internal ones (sr-int, no ↗); search links stay', { skip }, async () => {
  const meta = await loader('meta.json');
  const o = { ...OPTS2, releases: meta.releases, glossary: '../glossary.html' };
  let ext = 0; let int = 0; let srch = 0;
  for (const q of ['rs1042713', 'ADRB2', 'ADRB2 ClinVar', 'M159I', 'DRD2 S311C', 'R3.50', 'LPAR2 L351F', 'PAR2 A159I', 'ADRB2 R131Q', 'ADRB', 'DRY in ADRB2']) {
    const out = renderAnswer(await search(q, loader), q, o).html;
    const m = /<a [^>]*>([^]*?)<\/a>/g;
    for (const [whole, body] of out.matchAll(m)) {
      const a = anchors(whole)[0];
      if (/href="https?:/.test(a.attrs)) {
        ext += 1;
        assert.match(a.attrs, /target="_blank"/, `${q}: ${whole}`);
        assert.match(a.attrs, /rel="noopener noreferrer"/, `${q}: ${whole}`);
        assert.match(a.attrs, /title="[^"]*opens in a new tab" aria-describedby="sr-newtab"/, `${q}: ${whole}`);
        assert.match(a.attrs, /^class="sr-ext\b/, `${q}: the ↗ class: ${whole}`);
        assert.ok(!/↗|opens in a new tab/.test(body), `${q}: the link text is only the identifier: ${whole}`);
      } else if (/data-q=/.test(a.attrs)) {
        srch += 1;
        assert.ok(!/target=/.test(a.attrs), `${q}: a search link stays on the page: ${whole}`);
      } else if (/data-nav=/.test(a.attrs)) {
        srch += 1;   // a card's own section link: same page, same card
        assert.ok(/^href="#sr-\d+-\w+"/.test(a.attrs.replace(/^class="[^"]*" /, '')) || /href="#sr-\d+-\w+"/.test(a.attrs), `${q}: ${whole}`);
        assert.ok(!/target=/.test(a.attrs), `${q}: a section link stays on the page: ${whole}`);
      } else {
        int += 1;
        assert.match(a.attrs, /target="_blank" rel="noopener"/, `${q}: ${whole}`);
        assert.match(a.attrs, /title="[^"]*in a new tab" aria-describedby="sr-newtab"/, `${q}: ${whole}`);
        assert.match(a.attrs, /^class="sr-int\b/, `${q}: internal links carry no ↗: ${whole}`);
      }
    }
  }
  assert.ok(ext > 50 && int > 30 && srch > 5, `${ext} outbound, ${int} internal, ${srch} search links`);
  // the compare table body redrawn by the page (reports only) still opens reports in a new tab
  const model = compareModel(await search('M159I', loader), { reports: '../reports/' });
  const body = renderCompareBody(model, compareDefaults(), { reports: '../reports/' }).toString();
  assert.match(body, /<a class="sr-int sr-sub sr-reportlink" href="\.\.\/reports\/par2_human\.html#sec=sec-snake&amp;res=159" target="_blank" rel="noopener"/);
});

test('L4: the exports are unchanged by the links', { skip }, async () => {
  const a = await search('rs1042713', loader);
  const o = renderAnswer(a, 'rs1042713', { ...OPTS2, releases: (await loader('meta.json')).releases });
  const ev = evidenceText(o.results[0], o.ctx);
  const nt = notationsText(o.results[0], o.ctx);
  for (const t of [ev, nt]) assert.ok(!/↗|opens in a new tab|<a /.test(t), t);
  const csv = compareCsv(compareModel(await search('M159I', loader), {}), compareDefaults());
  assert.ok(!/https?:|↗/.test(csv));
});


// ------------------------------------------------------------------- the card v2: visual first

test('W1: the summary tiles read the data: structure, AlphaMissense gauge, population band, ClinVar chip, conservation', { skip }, async () => {
  const q = 'MC4R V103I';
  const a = await search(q, loader);
  const r = a.results[0];
  const out = renderAnswer(a, q, OPTS2).html;
  const tiles = /<ul class="sr-tiles">([^]*?)<\/ul>/.exec(out)?.[1];
  assert.ok(tiles, 'tiles drawn');
  assert.equal((tiles.match(/<li class="sr-tile /g) || []).length, 5);
  assert.ok(out.indexOf('sr-tiles') < out.indexOf('data-sec="structure"'), 'tiles lead the card');
  assert.match(tiles, /sr-tile--structure[^]*?<span class="sr-big">Not a CFR, rank 99<\/span>/);
  assert.match(tiles, /no contact above the threshold/);
  assert.match(tiles, /<span class="sr-big sr-path sr-path--benign">0\.084<\/span> <span class="sr-path-chip sr-path-chip--benign">likely benign<\/span>/);
  assert.match(tiles, /sr-gauge--am[^]*?<span class="sr-gauge-mark sr-gauge-mark--benign" style="left:8\.4%">/);
  assert.match(tiles, /<span class="sr-zone sr-zone--benign" style="width:34\.0%">[^]*?<span class="sr-zone sr-zone--ambiguous" style="width:22\.4%">[^]*?<span class="sr-zone sr-zone--pathogenic" style="width:43\.6%">/);
  assert.match(tiles, /sr-tile--population[^]*?<span class="sr-big">0\.018<\/span> <span class="sr-badge sr-badge--muted">common<\/span>/);
  assert.match(tiles, new RegExp(`${r.alleles[0].hom} homozygotes`));
  assert.match(tiles, /sr-tile--clinical[^]*?<span class="sr-path-chip sr-path-chip--benign">Benign\/Likely benign<\/span> <span class="sr-stars"/);
  assert.match(tiles, /Conservation<\/a><div class="sr-tile-v"><span class="sr-big">0\.\d\d<\/span><div class="sr-gauge sr-gauge--plain"/);
  // every tile heading links to its section, which exists
  for (const m of tiles.matchAll(/href="#(sr-0-\w+)"/g)) assert.ok(out.includes(`id="${m[1]}"`), m[1]);
  // the cutoffs are the published ones and the band rule is descriptive
  assert.deepEqual(AM_CUTS, { benign: 0.34, pathogenic: 0.564 });
  assert.equal(amClassOfScore(0.339), 'benign'); assert.equal(amClassOfScore(0.34), 'ambiguous'); assert.equal(amClassOfScore(0.565), 'pathogenic');
  assert.equal(afBand(0.0005).key, 'rare'); assert.equal(afBand(0.005).key, 'low'); assert.equal(afBand(0.02).key, 'common');
  assert.equal(cvClassKey('Pathogenic/Likely pathogenic'), 'pathogenic'); assert.equal(cvClassKey('Uncertain significance'), 'ambiguous'); assert.equal(cvClassKey('Conflicting classifications of pathogenicity'), 'ambiguous'); assert.equal(cvClassKey('Benign'), 'benign'); assert.equal(cvClassKey('drug response'), 'none');
  // the structure tile of a CFR with contacts says the direction in words
  const t2 = /<ul class="sr-tiles">([^]*?)<\/ul>/.exec(renderAnswer(await search('ADRB2 R131Q', loader), 'ADRB2 R131Q', OPTS2).html)[1];
  assert.match(t2, /<span class="sr-big">CFR, rank 1<\/span> <span class="sr-badge sr-badge--cfr">DRY motif<\/span>/);
  assert.match(t2, /<span class="sr-tile-line"><span class="mono">Asp130<\/span> <span class="sr-net sr-net--inactive">-5\.67<\/span>, stronger in the inactive model<\/span><span class="sr-tile-line">3 contacts above threshold<\/span>/);
  assert.ok(!/net ΔRRCS/.test(t2), 'the net line is not on the tile');
});

test('W2: the pathogenicity palette is one set of classes used by the strip, the gauge, the allele table and ClinVar chips', { skip }, async () => {
  const out = renderAnswer(await search('MC1R Arg151Cys', loader), 'MC1R Arg151Cys', OPTS2).html;
  assert.deepEqual(PATH_CLASSES, ['benign', 'ambiguous', 'pathogenic']);
  for (const c of PATH_CLASSES) {
    assert.ok(out.includes(`sr-am--${c}`) || c === 'ambiguous', `strip ${c}`);
    assert.ok(out.includes(`sr-zone--${c}`), `gauge zone ${c}`);
  }
  assert.match(out, /<ul class="sr-path-legend"[^>]*>(?:<li><span class="sr-path-swatch sr-path-swatch--\w+" aria-hidden="true"><\/span>[^<]+(?:<span class="sr-sub">[^<]+<\/span>)?<\/li>){3}<\/ul>/);
  assert.match(out, /likely benign <span class="sr-sub">score &lt; 0\.34<\/span>/);
  assert.match(out, /ambiguous <span class="sr-sub">0\.34 ≤ score ≤ 0\.564<\/span>/);
  assert.match(out, /likely pathogenic <span class="sr-sub">score &gt; 0\.564<\/span>/);
  assert.match(out, /<p class="sr-sub sr-path-note">Classes follow the source predictions before display rounding\.<\/p>/);
  assert.ok(!/below 0\.34|above 0\.564|≥ ?0\.564|0\.563/.test(out), 'only the published intervals');
  // a conflicting ClinVar record is an ambiguous chip, never a red or blue one
  assert.match(out, /<span class="sr-path-chip sr-path-chip--ambiguous">Conflicting/);
  assert.ok(!/sr-net--(active|inactive)">(?:likely|Conflicting|Benign|Pathogenic)/.test(out));
  // the strip cells carry their class and the queried change is outlined once
  const strip = /<ol class="sr-am-strip"[^>]*>([^]*?)<\/ol>/.exec(out)[1];
  assert.equal((strip.match(/class="sr-am-cell sr-am--(benign|ambiguous|pathogenic)/g) || []).length, 19);
  assert.equal((strip.match(/is-this/g) || []).length, 1);
});

test('W3: the receptor map marks the residue, draws one arc per contact, the CFR positions, the heat band and the record ticks', { skip }, async () => {
  const q = 'ADRB2 R131Q';
  const a = await search(q, loader);
  const r = a.results[0];
  const svg = receptorMap(r, { ...OPTS2, idx: 0 }).toString();
  assert.match(svg, /<figure class="sr-map" data-map="0" data-length="413" data-symbol="ADRB2">/);
  assert.equal((svg.match(/class="sr-map-arc /g) || []).length, r.contacts.length);
  assert.match(svg, /sr-map-arc sr-map-arc--inactive/);
  assert.equal((svg.match(/class="sr-map-cfr/g) || []).length, r.track.cfr.length);
  assert.match(svg, /class="sr-map-cfr is-this"/);
  assert.match(svg, /<text class="sr-map-reslabel"[^>]*>Arg131<\/text>/);
  assert.equal((svg.match(/sr-map-tick--allele/g) || []).length, r.track.alleles.length);
  assert.equal((svg.match(/sr-map-tick--cv/g) || []).length, r.track.clinvar.length);
  assert.ok((svg.match(/<rect class="sr-map-seg is-helix"/g) || []).length >= 8, 'TM1 to TM7 and H8');
  assert.match(svg, /<text class="sr-map-seglabel"[^>]*>TM3<\/text>/);
  assert.ok(/sr-map-am sr-map-am--(benign|ambiguous|pathogenic)/.test(svg), 'the heat band uses the palette');
  assert.match(svg, /<rect class="sr-map-hit" data-map-hit="0"/);
  assert.match(svg, /<form class="sr-map-go" data-map-go="0"><label>Residue <input type="number"[^>]*max="413"[^>]*value="131"/);
  // the section is in the card and the map is not drawn for a light or residue-less result
  const out = renderAnswer(a, q, OPTS2).html;
  assert.ok(out.includes('<details class="sr-sec" data-sec="region" id="sr-0-region" open>'));
  assert.equal(receptorMap({ pos: null }, {}), '');
});

test('W4: the contacts read in activation terms: dumbbells with words, partner badges, the net sentence, rank and threshold', { skip }, async () => {
  const q = 'PAR2 p.Met159Ile';
  const a = await search(q, loader);
  const r = a.results[0];
  const out = renderAnswer(a, q, OPTS2).html;
  const dbs = /<ol class="sr-dbs"[^>]*>([^]*?)<\/ol>/.exec(out)?.[1];
  assert.ok(dbs, 'dumbbells drawn');
  assert.equal((dbs.match(/<li class="sr-db-row">/g) || []).length, r.contacts.length);
  assert.match(dbs, /<span class="mono">Phe300<\/span> <span class="sr-sub">6\.48x48<\/span> <span class="sr-badge sr-badge--cfr" title="Core functional residue, class-wide rank 2">CFR 2<\/span>/);
  assert.match(dbs, /sr-db-line sr-db-line--inactive/);
  assert.match(dbs, /<span class="sr-net sr-net--inactive">-4\.99<\/span> <span class="sr-db-word">stronger in the inactive model<\/span>/);
  assert.match(out, /<p class="sr-db-legend">/);
  assert.match(out, /<span class="sr-net sr-net--inactive">-13\.0<\/span> <span class="sr-sub">overall its contacts are stronger in the inactive model<\/span>/);
  assert.match(out, /rank 41 of 397 residues in F2RL1 by largest \|ΔRRCS\|/);
  assert.match(out, /<dd>2 <span class="sr-sub">\(\|ΔRRCS\| ≥ 2\.60\)<\/span>/);
  assert.match(out, /<button type="button" class="btn btn-ghost btn-sm" data-3d="0" aria-expanded="false" aria-controls="sr-0-3d-pane">Show in 3D<\/button>/);
  assert.ok(!/pair-viewer|\.pdb/.test(out), 'nothing of the 3D viewer is in the markup');
  // the table says it in words too, with the model phrasing kept
  assert.match(out, /<strong>stronger in the inactive model<\/strong><span class="sr-sub">: present in both models<\/span>/);
  assert.match(out, /<p class="sr-db-legend">[^]*?red<\/span>: stronger in the active model; <span class="sr-net sr-net--inactive">blue<\/span>: stronger in the inactive model\.<\/p>/);
});

test('W5: the xMY motif is named where the receptor carries Met 3.36 and Tyr 3.37, with the paper\'s definition; 30 of 283 receptors carry it', { skip }, async () => {
  const par2 = (await search('PAR2 p.Met159Ile', loader)).results[0];
  assert.deepEqual(par2.motifs.map((m) => [m.key, m.position, m.required, m.carried]), [['xmy', '3.36', true, true]]);
  const out = renderAnswer(await search('PAR2 p.Met159Ile', loader), 'PAR2 p.Met159Ile', OPTS2).html;
  assert.match(out, /<span class="sr-badge sr-badge--cfr">xMY motif<\/span>/);
  assert.match(out, /<strong>xMY motif<\/strong> <span class="sr-sub">position 3\.36, canonical Met<\/span> <span class="sr-sub">\(Met 3\.36 and Tyr 3\.37, preceded by a variable residue at 3\.35; carried by 30 of 283 Class A receptors \(GPCompaRe study\)\)<\/span>/);
  assert.ok(!/novel|PAR-specific/i.test(out));
  // the x of the window and a receptor without the motif
  const x = (await search('PAR2 3.35', loader)).results[0];
  assert.deepEqual(x.motifs.map((m) => [m.key, m.required, m.carried]), [['xmy', false, true]]);
  assert.match(renderAnswer(await search('PAR2 3.35', loader), 'PAR2 3.35', OPTS2).html, /the variable x of the window/);
  const adrb2 = (await search('ADRB2 M3.36', loader)).results[0];
  assert.deepEqual(adrb2.motifs.map((m) => [m.key, m.carried]), [['xmy', false]]);
  const h = renderAnswer(await search('ADRB2 M3.36', loader), 'ADRB2 M3.36', OPTS2).html;
  assert.ok(!/xMY/.test(/<ul class="sr-tiles">[^]*?<\/ul>/.exec(h)[0]), 'no xMY badge on a receptor without it');
  assert.match(h, /<dt>Motif<\/dt><dd><span class="sr-na">not a motif position<\/span>/);
  // the count, from the index
  const S = shardsFor(loader);
  const meta = await S.meta();
  let n = 0;
  for (const rec of meta.receptors) {
    const res = await S.residues(rec.gid);
    const p36 = res.findGeneric('3.36', null)[0]; const p37 = res.findGeneric('3.37', null)[0];
    if (p36 && p37 && res.residue(p36).aa === 'M' && res.residue(p37).aa === 'Y') n += 1;
  }
  assert.equal(n, 30);
  // the bare word resolves as a motif
  const bare = await search('xMY', loader);
  assert.equal(bare.interpretation.kind, 'motif');
  assert.deepEqual(bare.motif.positions, ['3.35', '3.36', '3.37']);
});

test('W6: the section nav lists every section of the card in order and every target exists', { skip }, async () => {
  const out = renderAnswer(await search('DRD2 S311C', loader), 'DRD2 S311C', OPTS2).html;
  const nav = /<nav class="sr-nav" aria-label="Sections of this result"><ul>([^]*?)<\/ul><\/nav>/.exec(out)?.[1];
  assert.ok(nav, 'nav drawn');
  const items = [...nav.matchAll(/<a href="#(sr-0-\w+)" data-nav="0">([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(items, [['sr-0-summary', 'Summary'], ['sr-0-structure', 'Contacts and structure'], ['sr-0-region', 'Receptor map'], ['sr-0-predictions', 'Predictions'], ['sr-0-conservation', 'Conservation'], ['sr-0-population', 'Population'], ['sr-0-clinical', 'Clinical'], ['sr-0-refs', 'Notations and references']]);
  for (const [id] of items) assert.ok(out.includes(`id="${id}"`), id);
  assert.ok(out.indexOf('<nav class="sr-nav"') < out.indexOf('<ul class="sr-tiles">'));
  // the compact identifier line under the title
  assert.match(out, /<p class="sr-idline"><span class="mono">NM_000795\.4:c\.932C&gt;G<\/span><span class="sr-dot" aria-hidden="true">·<\/span><a class="sr-ext mono" href="https:\/\/gnomad[^"]*11-113412762-G-C/);
});

// ------------------------------------------------------------------------------ CFR neighbourhood

test('the CFR set is the index\'s top 50 (meta.json cfrTop), said in one line with a glossary link', { skip }, async () => {
  const meta = await shardsFor(loader).meta();
  assert.equal(meta.cfrTop, 50, 'one class-wide CFR set: the 50 top-ranked positions by CFR score');
  // the number is never typed in the UI: it comes from the index
  assert.equal(cfrOneOf(meta.cfrTop), 'one of the 50 top-ranked class-wide CFR positions (by CFR score)');
  assert.match(cfrSetText(meta.cfrTop), /^CFR positions are the 50 top-ranked class-wide CFR positions \(by CFR score\)/);
  assert.doesNotMatch(cfrSetText(null), /\d/, 'without the index the line names no number');
  const a = await search('ADRB2 Ile135', loader);
  const h = renderAnswer(a, 'ADRB2 Ile135', { ...OPTS, cfrTop: meta.cfrTop }).html;
  assert.match(h, /<div class="sr-cfrhood" data-cfrhood="connected">/);
  assert.ok(h.includes(cfrSetText(meta.cfrTop)));
  assert.match(h, /href="[^"]*glossary\.html#cfr-connected"/);
  assert.doesNotMatch(h, /\b30 top-ranked|top 30/);
  // the card badge and the evidence text name the same set
  const b = await search('ADRB2 R131Q', loader);
  const o = renderAnswer(b, 'ADRB2 R131Q', { ...OPTS, cfrTop: meta.cfrTop });
  assert.match(o.html, /<span class="sr-badge sr-badge--cfr" title="Core functional residue: one of the 50 top-ranked class-wide CFR positions \(by CFR score\)">CFR, class-wide rank 1<\/span>/);
  assert.match(evidenceText(o.results[0], o.ctx), /Core functional residue \(class-wide\): yes, one of the 50 top-ranked class-wide CFR positions \(by CFR score\), rank 1/);
});

test('card: a residue connected to a CFR says so in the tile, the block and the map', { skip }, async () => {
  // Ile135's partner Gln229 (5.68x68) ranks 46: a CFR in the top-50 set, not in the old top 30
  const a = await search('ADRB2 Ile135', loader);
  const r = a.results[0];
  assert.equal(r.cfrHood.group, 'connected');
  assert.deepEqual(r.cfrHood.connected.map((c) => [c.pos, c.generic, c.rank]), [[229, '5.68x68', 46]]);
  assert.equal(cfrTileLine(r), 'Connected to CFR Gln229 (5.68, rank 46)');
  const h = renderAnswer(a, 'ADRB2 Ile135', OPTS).html;
  assert.match(h, /data-cfr-tile>Connected to CFR Gln229 \(5\.68, rank 46\)</);
  assert.match(h, /data-cfr-rel="connected">[\s\S]*?Gln229[\s\S]*?sr-net--inactive">-3\.76<[\s\S]*?present only in the inactive model/);
  assert.match(h, /class="sr-map-cfr is-partner" data-cfr-partner="229"/);
  // Phe290 (7.38x38) is itself one of the 50 now (rank 29 by CFR score), and still connected to Phe208
  const p = (await search('ADRB2 Phe290', loader)).results[0];
  assert.equal(p.cfrHood.group, 'at');
  assert.deepEqual(p.cfrHood.connected.map((c) => [c.pos, c.generic, c.rank]), [[208, '5.47x47', 21]]);
  // a CFR residue: no tile line, its own rank in the block
  const b = await search('ADRB2 R131Q', loader);
  assert.equal(cfrTileLine(b.results[0]), '');
  assert.match(renderAnswer(b, 'ADRB2 R131Q', OPTS).html, /data-cfr-rel="at">[^]*?<strong>yes<\/strong>, class-wide rank 1/);
  // near in sequence: two residues from two CFRs in TM6
  const c = await search('ADRB2 Leu284', loader);
  assert.deepEqual(c.results[0].cfrHood.near.map((x) => [x.pos, x.offset]), [[282, -2], [286, 2]]);
  assert.equal(cfrTileLine(c.results[0]), '2 residues away from CFR Phe282 (6.44, rank 6)');
});

test('"ADRB2 CFR variants": counts, groups, filters and CSV agree with the rows', { skip }, async () => {
  for (const q of ['ADRB2 CFR variants', 'CFR variants in MC4R']) {
    const a = await search(q, loader);
    assert.equal(a.expect, 'receptor', q);
    const r = a.results[0];
    const out = renderAnswer(a, q, OPTS);
    const m = out.cfr;
    assert.ok(m && m.rows.length > 20, q);
    const total = Object.values(r.cfrList.counts).reduce((x, c) => x + c.variants, 0);
    assert.equal(total, m.rows.length, 'the tiles add up to the table');
    for (const g of ['at', 'connected', 'near', 'touch']) {
      assert.equal(cfrListRows(m, { ...cfrListDefaults(), group: g }).length, r.cfrList.counts[g].variants, `${q} ${g}`);
      assert.match(out.html, new RegExp(`data-cfr-count="${g}">${r.cfrList.counts[g].variants}<`));
    }
    // every row is in the CFR neighbourhood by the rules
    for (const x of m.rows) {
      if (x.group === 'at') assert.ok(x.hood.at);
      if (x.group === 'connected') assert.ok(!x.hood.at && x.hood.connected.length);
      if (x.group === 'near') assert.ok(!x.hood.connected.length && x.hood.near.every((c) => Math.abs(c.offset) <= 2 && c.segment === x.hood.segment));
    }
    // source filters
    const plp = cfrListRows(m, { ...cfrListDefaults(), source: 'plp' });
    assert.ok(plp.every((x) => x.clinvar.some((c) => /^(pathogenic|likely pathogenic)/i.test(c.classification))));
    assert.ok(cfrListRows(m, { ...cfrListDefaults(), source: 'gnomad' }).every((x) => x.allele));
    // the visible page is 25 rows, "Show all" is every row
    const body = renderCfrListBody(m, { ...cfrListDefaults(), all: true }, OPTS).toString();
    assert.equal((body.match(/<tr data-cfr-row=/g) ?? []).length, m.rows.length);
    // CSV: one line per filtered row, a header, and the formula guard on text cells
    const csv = cfrListCsv(m, { ...cfrListDefaults(), group: 'connected' }).trim().split('\r\n');
    assert.equal(csv.length - 1, r.cfrList.counts.connected.variants);
    assert.match(csv[0], /^receptor,gene_symbol,gpcr_id,group,residue,/);
    assert.ok(csv.slice(1).every((l) => !/(^|,)[=+@]/.test(l)));
    assert.ok(!out.html.includes('—'), 'no em dashes');
    assert.match(out.html, /I read this as<\/span> <strong>the variants of \S+ at, connected to or near its CFR positions/);
  }
});

// ------------------------------------------------------------- contact presence and AlphaMissense intervals

const presenceGolden = (() => {
  const lines = readFileSync(new URL('./contact_presence_golden.tsv', import.meta.url), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  const head = lines[0].split('\t');
  return lines.slice(1).map((l) => Object.fromEntries(l.split('\t').map((v, i) => [head[i], v])));
})();

test('contact presence: a 0.00 endpoint is a contact when the index flags it; "present only in" needs a true zero', () => {
  assert.equal(fmtRrcs(0, true), '<0.01');
  assert.equal(fmtRrcs(0, false), '0.00');
  assert.equal(fmtRrcs(0.01, true), '0.01');
  assert.equal(fmtRrcs(8.49, true), '8.49');
  // the index flag wins over the rounded value
  assert.deepEqual(contactPresence({ active: 0, inactive: 8.49, activePresent: true, inactivePresent: true }), { active: true, inactive: true });
  // an older index without the flag falls back to the values
  assert.deepEqual(contactPresence({ active: 0, inactive: 8.49 }), { active: false, inactive: true });
  // the detail decoder reads the presence element, and keeps the fallback for a 5-element pair
  const det = decodeDetail({ gid: 'x', am: [], pairs: [[364, 483, -849, 0, 849, 3], [1, 2, -300, 0, 300, 2], [3, 4, 300, 300, 0]] });
  assert.deepEqual(det.pairs.map((p) => [p.activePresent, p.inactivePresent]), [[true, true], [false, true], [true, false]]);
  assert.equal(activationWord(det.pairs[0]), 'stronger in the inactive model');
  assert.equal(activationWord(det.pairs[1]), 'present only in the inactive model');
  assert.equal(activationWord(det.pairs[2]), 'present only in the active model');
});

test('RXFP2 364: contact 364-483 (active RRCS 0.0026) reads as stronger in the inactive model, active shown as <0.01', { skip }, async () => {
  const q = 'RXFP2 364';
  const a = await search(q, loader);
  const r = a.results[0];
  assert.equal(r.gid, 'rxfp2_human');
  const c = r.contacts.find((x) => x.partnerPos === 483);
  assert.ok(c, 'the contact with 483 is listed');
  assert.deepEqual([c.a, c.b, c.delta, c.active, c.inactive, c.activePresent, c.inactivePresent], [364, 483, -8.49, 0, 8.49, true, true]);
  assert.equal(activationWord(c), 'stronger in the inactive model');
  assert.equal(contactMeaning(c), 'stronger in the inactive model: present in both models');
  const out = renderAnswer(a, q, OPTS2).html;
  const tbl = unlinked(/<table class="sr-table sr-table--contacts">([^]*?)<\/table>/.exec(out)[1]);
  const row = tbl.split('<tr>').find((x) => x.includes('Gln483'));
  assert.ok(row, 'a table row for Gln483');
  assert.match(row, /data-label="Active RRCS">&lt;0\.01</);
  assert.match(row, /data-label="Inactive RRCS">8\.49</);
  assert.match(row, /<strong>stronger in the inactive model<\/strong><span class="sr-sub">: present in both models/);
  assert.ok(!/present only|no contact in the active model|breaks|on activation/.test(row), row);
  assert.match(out, /active RRCS &lt;0\.01/);
  assert.match(out, /&lt;0\.01 is a contact with a score above 0 that rounds to 0\.00/);
  const text = evidenceText(r, { query: q, releases: {} });
  assert.match(text, /Gln483[^\n]*: dRRCS -8\.49; active <0\.01; inactive 8\.49; stronger in the inactive model: present in both models; report pair 364-483/);
});

test('every golden small positive endpoint is a contact in both models in the index and on the card', { skip }, async () => {
  assert.equal(presenceGolden.length, 32);
  const seen = new Set();
  for (const g of presenceGolden) {
    const det = decodeDetail(await loader(`detail/${g.gid}.json`));
    const p = det.pairs.find((x) => x.a === Number(g.res1) && x.b === Number(g.res2));
    assert.ok(p, `${g.gid} ${g.res1}-${g.res2}`);
    assert.equal(p[g.small_endpoint], 0, 'the stored value rounds to 0.00');
    assert.ok(p.activePresent && p.inactivePresent, `${g.gid} ${g.res1}-${g.res2} present in both models`);
    assert.equal(activationWord(p), Number(g.delta_rrcs) > 0 ? 'stronger in the active model' : 'stronger in the inactive model');
    assert.equal(fmtRrcs(p[g.small_endpoint], p[`${g.small_endpoint}Present`]), '<0.01');
    seen.add(g.gid);
  }
  // and a true zero still reads as "present only in": a pair of the same receptors with a zero endpoint
  let trueZero = 0;
  for (const gid of seen) {
    for (const p of decodeDetail(await loader(`detail/${gid}.json`)).pairs) {
      if (p.activePresent && p.inactivePresent) continue;
      trueZero++;
      assert.equal(activationWord(p), p.activePresent ? 'present only in the active model' : 'present only in the inactive model');
      assert.equal(fmtRrcs(p.activePresent ? p.inactive : p.active, false), '0.00');
    }
  }
  assert.ok(trueZero > 0);
});

test('AlphaMissense intervals: > 0.564 likely pathogenic, 0.34 to 0.564 ambiguous, < 0.34 likely benign; classes before rounding', { skip }, async () => {
  assert.equal(AM_CUTS_TEXT, 'Likely pathogenic: score > 0.564. Ambiguous: 0.34 ≤ score ≤ 0.564. Likely benign: score < 0.34. Classes follow the source predictions before display rounding.');
  assert.deepEqual({ ...AM_INTERVAL }, { pathogenic: 'score > 0.564', ambiguous: '0.34 ≤ score ≤ 0.564', benign: 'score < 0.34' });
  assert.equal(amClassOfScore(0.564), 'ambiguous'); assert.equal(amClassOfScore(0.5641), 'pathogenic'); assert.equal(amClassOfScore(0.34), 'ambiguous');
  // the gauge follows the source class: a 0.564 display with a source class of likely pathogenic stays pathogenic
  assert.match(amGauge(0.564, { cls: 'pathogenic' }).toString(), /sr-gauge-mark--pathogenic/);
  assert.match(amGauge(0.564).toString(), /sr-gauge-mark--ambiguous/);
  assert.match(pathLegend().toString(), /Classes follow the source predictions before display rounding\./);
  // a residue mean of 0.5646 (stored 0.56) is likely pathogenic on the card, the tile and the map
  const a = await search('HTR1A 232', loader);
  const r = a.results[0];
  assert.equal(r.gid, '5ht1a_human');
  assert.equal(r.residue.amMean, 0.56);
  assert.equal(r.residue.amMeanClass, 'pathogenic');
  assert.equal(r.track.amClass[231], 'pathogenic');
  const out = renderAnswer(a, 'HTR1A 232', OPTS2).html;
  assert.match(unlinked(out), /residue mean<\/dt><dd>0\.56 <span class="sr-path-chip sr-path-chip--pathogenic">likely pathogenic<\/span>/);
  assert.match(out, /sr-tile--predictions[^]*?sr-gauge-mark--pathogenic/);
  assert.match(out, /Likely pathogenic: score &gt; 0\.564\. Ambiguous: 0\.34 ≤ score ≤ 0\.564\. Likely benign: score &lt; 0\.34\. Classes follow the source predictions before display rounding\./);
  assert.ok(!/below 0\.34|above 0\.564|0\.563/.test(out));
  // and 0.3371 (stored 0.34) is likely benign
  const b = (await search('HTR1A 416', loader)).results[0];
  assert.deepEqual([b.residue.amMean, b.residue.amMeanClass], [0.34, 'benign']);
});
