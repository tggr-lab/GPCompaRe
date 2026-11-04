// Search v2 resolver tests (P4). Run:
//   node --test GPCompaReports_v2/tests/search_v2/resolve.test.mjs
// Needs a built index: SEARCH2_DIR=<dir holding meta.json>, else <FREEZE_BUILD_DIR or output_v3_demo>/search2,
// else output/search2. Build only the index (about 10 s) with
//   .venv-test/bin/python -m GPCompaReports_v2.website.page_generators.search_index_v2 --output <dir> --batch-dir <batch>
// The suite skips when there is no index.
//
// 1. Every golden row (golden_queries.tsv) end to end: parse -> resolve against the built index, checking
//    expect, gid, pos, ref, alt, alleles and assembly.
// 2. Coordinate round trips in JS over every gnomAD allele: hgvsc -> GRCh38 on the gnomAD transcript,
//    GRCh38 -> c. back, and GRCh38 -> GRCh37 through the lift blocks.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { search } from '../../static/js/search/resolve.js';
import { shardsFor } from '../../static/js/search/shards.js';
import { cToG, gToC, lift38to37, mapPos, unmapPos, codonAt, translate, cText } from '../../static/js/search/txmap.js';

const here = (name) => new URL(name, import.meta.url);
const BASE = resolvePath(fileURLToPath(new URL('../..', import.meta.url)));
const candidates = [
  process.env.SEARCH2_DIR,
  join(process.env.FREEZE_BUILD_DIR ? resolvePath(BASE, process.env.FREEZE_BUILD_DIR) : join(BASE, 'output_v3_demo'), 'search2'),
  join(BASE, 'output', 'search2'),
].filter(Boolean);
const DIR = candidates.find((d) => existsSync(join(d, 'meta.json')));
const skip = DIR ? false : `no search2 index (looked in ${candidates.join(', ')})`;
const loader = async (p) => JSON.parse(await readFile(join(DIR, p), 'utf8'));

const readTsv = (name) => {
  const [head, ...lines] = readFileSync(here(name), 'utf8').replace(/\r/g, '').split('\n').filter((l) => l !== '');
  const cols = head.split('\t');
  return lines.map((l) => Object.fromEntries(l.split('\t').map((v, i) => [cols[i], v])));
};
const golden = readTsv('golden_queries.tsv');
const unescape = (q) => q.replace(/\\t/g, '\t');

/**
 * Golden cells this suite believes are wrong or under-specified; the named check is skipped and the
 * reason reported. Keep this list short and argued.
 */
const DISPUTED = new Map([
]);

const sameSet = (a, b) => assert.deepEqual([...new Set(a)].sort(), [...new Set(b)].sort());
const isMissenseLetter = (s) => /^[ACDEFGHIKLMNPQRSTVWY]$/.test(s);

function checkRow(row, ans) {
  const top = ans.results[0];
  const skipCheck = DISPUTED.get(row.id)?.skip ?? [];
  const gids = row.gid ? row.gid.split(';') : [];
  const poss = row.pos ? row.pos.split(';').map(Number) : [];
  if (!skipCheck.includes('expect')) assert.equal(ans.expect, row.expect, `expect (message: ${ans.message})`);
  if (row.assembly !== 'na' && !skipCheck.includes('assembly')) assert.equal(ans.assembly, row.assembly, 'assembly');

  switch (row.expect) {
    case 'target': {
      assert.ok(top, 'a result');
      assert.equal(top.gid, gids[0], 'gid');
      if (!skipCheck.includes('pos')) assert.equal(top.pos, poss[0], 'pos');
      if (row.ref && !skipCheck.includes('ref')) assert.equal(top.ref, row.ref, 'ref');
      if (row.alt && !skipCheck.includes('alt')) {
        if (row.alt.includes(',')) sameSet(top.alts ?? [top.alt], row.alt.split(','));
        else assert.equal(top.alt, row.alt, 'alt');
      }
      if (!skipCheck.includes('alleles')) {
        if (row.alleles) sameSet(top.alleles.map((a) => a.id), row.alleles.split(','));
        else if (isMissenseLetter(row.alt)) assert.deepEqual(top.alleles.map((a) => a.id), [], 'no allele expected');
      }
      break;
    }
    case 'targets': {
      assert.ok(ans.results.length >= 1, 'results');
      sameSet(ans.results.map((r) => `${r.gid}:${r.pos}`), gids.map((g, k) => `${g}:${poss[k]}`));
      if (row.ref && !/refs differ/.test(row.note) && !skipCheck.includes('ref')) for (const r of ans.results) assert.equal(r.ref, row.ref, `ref of ${r.gid}`);
      if (row.alt && !skipCheck.includes('alt')) sameSet(ans.results.flatMap((r) => r.alts ?? [r.alt]), row.alt.split(','));
      if (row.alleles && !skipCheck.includes('alleles')) sameSet(ans.results.flatMap((r) => r.alleles.map((a) => a.id)), row.alleles.split(','));
      break;
    }
    case 'receptor':
      if (!skipCheck.includes('expect')) assert.equal(top?.type, 'receptor', 'receptor result');
      assert.equal(top.gid, gids[0], 'gid');
      break;
    case 'ambiguous': {
      if (gids.length > 1) for (const g of gids) assert.ok(ans.results.some((r) => r.gid === g), `primary list holds ${g}`);
      else if (gids.length === 1) {
        assert.equal(top?.gid, gids[0], 'primary gid');
        if (poss.length) assert.equal(top.pos, poss[0], 'primary pos');
        if (row.ref) assert.equal(top.ref, row.ref, 'primary ref');
        if (row.alt) assert.equal(top.alt, row.alt, 'primary alt');
        if (row.alleles) sameSet(top.alleles.map((a) => a.id), row.alleles.split(','));
      }
      for (const a of row.alternates ? row.alternates.split(' | ') : []) {
        const [kind, ...f] = a.split(':');
        const has = (pred) => assert.ok(ans.alternates.some(pred), `alternate ${a} missing from ${JSON.stringify(ans.alternates)}`);
        if (kind === 'change') { const [g, pos, ra] = f; const [ref, alt] = ra.split('>'); has((x) => x.kind === 'change' && x.gid === g && x.pos === Number(pos) && x.ref === ref && x.alt === alt); }
        if (kind === 'residue') { const [g, pos, aa] = f; has((x) => x.kind === 'residue' && x.gid === g && x.pos === Number(pos) && (!aa || x.ref === aa)); }
        if (kind === 'generic') has((x) => x.kind === 'generic' && x.display === f.join(':'));
        if (kind === 'clinvar') has((x) => x.kind === 'clinvar' && x.id === Number(f[0]));
        if (kind === 'gene_id') has((x) => x.kind === 'gene_id' && x.id === f[0]);
        if (kind === 'hgnc') has((x) => x.kind === 'hgnc' && x.id === `HGNC:${f[0]}`);
      }
      break;
    }
    case 'not_coding':
    case 'not_in_resource': {
      if (gids.length) {
        assert.equal(top?.gid, gids[0], 'gid');
        if (!skipCheck.includes('pos')) assert.equal(top.pos ?? null, poss.length ? poss[0] : null, 'pos');
        if (row.ref && !skipCheck.includes('ref')) assert.equal(top.ref, row.ref, 'ref');
        if (row.alt && !skipCheck.includes('alt')) assert.equal(top.alt, row.alt, 'alt');
      } else {
        assert.equal(ans.results.length, 0, `no receptor expected, got ${top?.gid}`);
      }
      break;
    }
    case 'unrecognised':
      assert.equal(ans.results.length, 0, 'no results');
      assert.ok(ans.message, 'a plain-language message');
      break;
    default:
      assert.fail(`unknown expect ${row.expect}`);
  }
}

describe('golden table end to end', { skip }, () => {
  test('table size', () => assert.equal(golden.length, 387));
  for (const row of golden) {
    test(`${row.id} ${JSON.stringify(row.query)} -> ${row.expect}`, async () => {
      const ans = await search(unescape(row.query), loader);
      checkRow(row, ans);
    });
  }
  test('disputed rows are listed with reasons', () => {
    for (const [id, d] of DISPUTED) assert.ok(d.reason && golden.some((r) => r.id === id), id);
  });
});

describe('answer contract', { skip }, () => {
  test('every answer has the documented shape', async () => {
    const EXPECT = new Set(['target', 'targets', 'receptor', 'ambiguous', 'not_coding', 'not_in_resource', 'unrecognised']);
    for (const row of golden.slice(0, 120)) {
      const a = await search(unescape(row.query), loader);
      assert.ok(EXPECT.has(a.expect));
      assert.ok(Array.isArray(a.results) && Array.isArray(a.alternates));
      for (const r of a.results) {
        assert.ok(['target', 'receptor', 'not_coding', 'not_in_resource'].includes(r.type), r.type);
        assert.ok(r.gid && r.receptor);
        if (r.type !== 'receptor' && r.notes) for (const n of r.notes) assert.ok(n.code && n.text);
      }
    }
  });
  test('PAR2 M159I card: both alleles, MANE views, both assemblies, release labels', async () => {
    const a = await search('F2RL1 p.Met159Ile', loader);
    const r = a.results[0];
    assert.equal(r.residue.generic, '3.36x36');
    assert.equal(r.residue.segment, 'TM3');
    const byId = Object.fromEntries(r.alleles.map((x) => [x.id, x]));
    assert.equal(byId['5-76833084-G-A'].id37, '5-76128909-G-A');
    assert.equal(byId['5-76833084-G-A'].hgvsc, 'c.477G>A');
    assert.deepEqual(byId['5-76833084-G-A'].rsids, ['rs115885685']);
    assert.ok(r.transcriptViews.some((v) => v.role === 'mane' && v.transcript === 'NM_005242.6' && v.c === 'c.477G>A' && v.p === 'p.Met159Ile'));
    assert.match(r.releases.gnomad, /4\.1\.2/);
  });
  test('typed transcript view and genome builds for a c. query', async () => {
    const a = await search('NM_005242.6:c.477G>A', loader);
    const r = a.results[0];
    assert.equal(r.genomic.grch38, '5-76833084-G-A');
    assert.equal(r.genomic.grch37, '5-76128909-G-A');
    assert.ok(r.transcriptViews.some((v) => v.role === 'typed' && v.transcript === 'NM_005242.6'));
  });
});

describe('coordinate round trips over every gnomAD allele (JS)', { skip }, () => {
  test('hgvsc <-> GRCh38 on the gnomAD transcript, GRCh38 -> GRCh37', async () => {
    const S = shardsFor(loader);
    const meta = await S.meta();
    let n = 0; let n37 = 0;
    const bad = [];
    for (const rec of meta.receptors) {
      const v = await S.variants(rec.gid);
      const t = await S.transcripts(rec.gid);
      if (!v || !t || !v.alleles.length) continue;
      const [id, ver] = t.gnomadTx.split('.');
      const tx = t.tx.find((x) => x.id === id && x.v === Number(ver) && x.asm === 'GRCh38' && x.chrom === v.chrom)
        ?? t.tx.find((x) => x.id === id && x.asm === 'GRCh38' && x.chrom === v.chrom);
      for (const a of v.alleles) {
        const m = /^c\.(\d+)[ACGT]>[ACGT]$/.exec(a.hgvsc ?? '');
        if (!m) continue;
        n += 1;
        const g = cToG(tx, Number(m[1]));
        if (g !== a.g38) { bad.push(`${rec.gid} ${a.id} ${a.hgvsc} -> ${g}`); continue; }
        const c = gToC(tx, a.g38);
        if (!c || c.pos !== Number(m[1]) || c.region !== 'cds') bad.push(`${rec.gid} ${a.id} back ${JSON.stringify(c)}`);
        if (a.id37) {
          n37 += 1;
          const l = lift38to37(t.lift, a.g38);
          const [c37, p37] = a.id37.split('-');
          if (!l || l.approximate || String(l.pos) !== p37 || String(l.chrom) !== c37) bad.push(`${rec.gid} ${a.id} lift ${JSON.stringify(l)} != ${a.id37}`);
        }
      }
    }
    assert.ok(n > 140000, `alleles checked: ${n}`);
    assert.ok(n37 > 140000, `GRCh37 checked: ${n37}`);
    assert.deepEqual(bad.slice(0, 20), []);
  });
});

describe('property: every notation of an allele reaches the same residue', { skip }, () => {
  // SEARCH2_PROPERTY_N / SEARCH2_PROPERTY_SEED widen the sample (default 300 alleles, seed 20261104)
  const N = Number(process.env.SEARCH2_PROPERTY_N ?? 300);
  test(`${N} seeded alleles: gnomAD id, GRCh37 id, rsID, protein change and MANE c.`, async () => {
    const S = shardsFor(loader);
    const meta = await S.meta();
    let seed = Number(process.env.SEARCH2_PROPERTY_SEED ?? 20261104);
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const failures = [];
    let checked = 0;
    for (let k = 0; k < N; k++) {
      const rec = meta.receptors[Math.floor(rnd() * meta.receptors.length)];
      const v = await S.variants(rec.gid);
      if (!v || !v.alleles.length) continue;
      const a = v.alleles[Math.floor(rnd() * v.alleles.length)];
      const t = await S.transcripts(rec.gid);
      const mane = t.tx.find((x) => x.mane && x.src === 'refseq' && x.asm === 'GRCh38' && x.chrom === a.chrom);
      const queries = [a.id, `${rec.symbol} ${a.hgvsp}`];
      if (a.id37) queries.push(a.id37);
      if (a.rsids.length === 1) queries.push(a.rsids[0]);
      if (mane && t.nmUsable !== false) {
        const c = gToC(mane, a.g38);
        if (c && c.region === 'cds') queries.push(`${mane.id}.${mane.v}:c.${c.pos}${mane.strand === 1 ? a.ref38 : { A: 'T', C: 'G', G: 'C', T: 'A' }[a.ref38]}>${mane.strand === 1 ? a.alt38 : { A: 'T', C: 'G', G: 'C', T: 'A' }[a.alt38]}`);
      }
      for (const q of queries) {
        const ans = await search(q, loader);
        let hit = ans.results.find((r) => r.gid === rec.gid && r.pos === a.pos);
        checked += 1;
        // a GRCh37 id whose coordinate is also a recorded allele on GRCh38: GRCh38 wins, GRCh37 is offered
        if (q === a.id37 && ans.alternates.some((x) => x.kind === 'genomic' && x.assembly === 'GRCh37' && x.gid === rec.gid && x.pos === a.pos && x.allele === a.id)) continue;
        // a shifted receptor's hgvsp that is also a stored allele in model numbering: the other reading is offered
        if (q === `${rec.symbol} ${a.hgvsp}` && ans.expect === 'ambiguous' && ans.alternates.some((x) => x.kind === 'change' && x.gid === rec.gid && x.pos === a.pos)) continue;
        if (!hit || !POSITIVE_EXPECT.has(ans.expect)) { failures.push(`${q} -> ${ans.expect} ${ans.results.map((r) => `${r.gid}:${r.pos}`).join(',')} (want ${rec.gid}:${a.pos}) ${ans.message ?? ''}`); continue; }
        if (q !== `${rec.symbol} ${a.hgvsp}` && !hit.alleles.some((x) => x.id === a.id)) failures.push(`${q}: allele ${a.id} missing`);
        // the c. codon map and the allele never disagree (review 2026-11-04: the resolver would trust the allele)
        if (hit.notes?.some((n) => n.code === 'numbering_conflict')) failures.push(`${q}: numbering conflict`);
      }
    }
    assert.ok(checked > 3 * N, `queries checked: ${checked}`);
    assert.deepEqual(failures.slice(0, 40), []);
  });
});

const POSITIVE_EXPECT = new Set(['target', 'targets', 'ambiguous']);

describe('ClinVar records by accession', { skip }, () => {
  test('all 488 packed P/LP records are targets at their residue; 400 other records keep their residue', async () => {
    const S = shardsFor(loader);
    const meta = await S.meta();
    const failures = [];
    let packed = 0; let others = 0;
    for (const rec of meta.receptors) {
      const v = await S.variants(rec.gid);
      for (const c of v?.clinvar ?? []) {
        const want = c.packed || (c.pos && c.variationId % 50 === 0);
        if (!want) continue;
        const ans = await search(c.accession, loader);
        const r = ans.results[0];
        if (c.packed) {
          packed += 1;
          if (ans.expect !== 'target' || r?.gid !== rec.gid || r.pos !== c.pos || r.ref !== c.ref || r.alt !== c.alt) failures.push(`${c.accession} -> ${ans.expect} ${r?.gid}:${r?.pos} ${r?.ref}>${r?.alt} (want ${rec.gid}:${c.pos} ${c.ref}>${c.alt})`);
        } else {
          others += 1;
          if (ans.expect !== 'not_in_resource' || r?.gid !== rec.gid || r.pos !== c.pos) failures.push(`${c.accession} -> ${ans.expect} ${r?.gid}:${r?.pos} (want ${rec.gid}:${c.pos})`);
        }
      }
    }
    assert.equal(packed, 488);
    assert.ok(others > 300, `other records checked: ${others}`);
    assert.deepEqual(failures.slice(0, 20), []);
  });
});

// ------------------------------------------------------------- review 2026-11-04 (codon maps and resolver)

describe('transcript -> model maps from shared genomic codons (review finding 1)', { skip }, () => {
  test('every gnomAD allele x every transcript holding it: map, c./p. and codon agree (both assemblies)', async () => {
    const S = shardsFor(loader);
    const meta = await S.meta();
    const C = { A: 'T', C: 'G', G: 'C', T: 'A' };
    let n38 = 0; let n37 = 0; let mapped = 0; let aaChecked = 0;
    const bad = [];
    for (const rec of meta.receptors) {
      const v = await S.variants(rec.gid);
      const t = await S.transcripts(rec.gid);
      const bases = await S.bases(rec.gid);
      if (!v || !t || !v.alleles.length) continue;
      for (const tx of t.tx) {
        if (tx.src === 'uniprot' || !tx.map || !tx.cds.length) continue;
        const sameChrom = String(tx.chrom) === String(v.chrom) || (tx.chrom === 'Y' && v.chrom === 'X');
        if (tx.asm === 'GRCh38' && !sameChrom) continue;
        for (const a of v.alleles) {
          let g = a.g38; let r = a.ref38; let al = a.alt38;
          if (tx.asm === 'GRCh37') {
            const m = /^([^-]+)-(\d+)-([ACGT])-([ACGT])$/.exec(a.id37 ?? '');
            if (!m || m[1] !== String(tx.chrom)) continue;
            g = Number(m[2]); r = m[3]; al = m[4];
          }
          const c = gToC(tx, g);
          const back = unmapPos(tx.map, a.pos);
          const inCds = c && c.region === 'cds' && !c.offset;
          if (!inCds) {
            if (back !== null && c) bad.push(`${rec.gid} ${tx.id}.${tx.v} ${tx.asm} ${a.id}: residue ${a.pos} maps to tx ${back} but the allele is at c.${cText(c)}`);
            continue;
          }
          if (tx.asm === 'GRCh38') n38 += 1; else n37 += 1;
          const tp = Math.ceil(c.pos / 3);
          const P = mapPos(tx.map, tp);
          if (P === null) { if (back !== null) bad.push(`${rec.gid} ${tx.id}.${tx.v} ${a.id}: model ${a.pos} -> tx ${back}, allele in tx ${tp}`); continue; }
          mapped += 1;
          if (P !== a.pos || back !== tp) { bad.push(`${rec.gid} ${tx.id}.${tx.v} ${tx.asm} ${a.id}: tx ${tp} -> model ${P}, allele at ${a.pos}`); continue; }
          if (tx.asm === 'GRCh38') {
            // genomic truth: the transcript's codon on the reference genome
            const cod = codonAt(tx, tp, bases);
            if (!cod.codon) continue;
            const k = (c.pos - 1) % 3;
            const ab = tx.strand === 1 ? al : C[al];
            aaChecked += 1;
            const ra = translate(cod.codon); const aa = translate(cod.codon.slice(0, k) + ab + cod.codon.slice(k + 1));
            if (ra !== a.ref || aa !== a.alt) bad.push(`${rec.gid} ${tx.id}.${tx.v} ${a.id}: codon ${cod.codon} reads ${ra}>${aa}, allele ${a.ref}>${a.alt}`);
          }
        }
      }
    }
    if (process.env.SEARCH2_VERBOSE) console.log({ n38, n37, mapped, aaChecked, bad: bad.length });
    assert.deepEqual(bad.slice(0, 20), [], `${bad.length} disagreements`);
    assert.ok(n38 > 1000000 && mapped > 1000000 && aaChecked > 1000000, `${n38} GRCh38, ${n37} GRCh37, ${mapped} mapped, ${aaChecked} codons`);
    assert.ok(n37 > 300000, `GRCh37 checks: ${n37}`);
  });

  test('allele views: p. only where the allele is in that transcript\'s CDS; no allele contradicts its codon map', async () => {
    const S = shardsFor(loader);
    const meta = await S.meta();
    let seed = 20261104;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const bad = [];
    let views = 0;
    for (let k = 0; k < 400; k++) {
      const rec = meta.receptors[Math.floor(rnd() * meta.receptors.length)];
      const v = await S.variants(rec.gid);
      if (!v?.alleles.length) continue;
      const a = v.alleles[Math.floor(rnd() * v.alleles.length)];
      const ans = await search(a.id, loader);
      const r = ans.results.find((x) => x.gid === rec.gid && x.pos === a.pos);
      if (!r) { bad.push(`${a.id}: no result at ${rec.gid}:${a.pos}`); continue; }
      if (r.notes.some((n) => n.code === 'numbering_conflict')) bad.push(`${a.id}: numbering conflict`);
      for (const w of r.transcriptViews) {
        if (!w.allele || w.role === 'gnomad') continue;
        views += 1;
        const m = /^c\.(\d+)[ACGT]>[ACGT]$/.exec(w.c ?? '');
        const pm = /^p\.[A-Z][a-z]{2}(\d+)/.exec(w.p ?? '');
        if (pm && (!m || Math.ceil(Number(m[1]) / 3) !== Number(pm[1]))) bad.push(`${a.id} ${w.transcript}: ${w.c} with ${w.p}`);
        if (m && !w.p) bad.push(`${a.id} ${w.transcript}: ${w.c} in the CDS but no p.`);
      }
    }
    assert.ok(views > 400, `views checked: ${views}`);
    assert.deepEqual(bad.slice(0, 20), []);
  });

  test('the review repros', async () => {
    let a = await search('NM_001331076.1:c.18C>T', loader);   // GPR142 MANE p.Cys6= (was residue 49)
    assert.notEqual(a.results[0]?.pos, 49);
    assert.ok(a.message.includes('p.Cys6='), a.message);
    assert.equal(a.results[0].pos, 112);   // the same base is in the model's Arg112 codon (gnomAD p.Arg112Trp)
    a = await search('GPR142 p.Cys6Ser', loader);
    assert.notEqual(a.results[0]?.pos, 49);
    assert.match(a.message, /no counterpart/);
    a = await search('VCV3855089', loader);
    assert.equal(a.results[0].pos, 112);
    assert.ok(a.results[0].notes.some((n) => n.code === 'other_frame'));
    a = await search('ENST00000612998.1:c.323A>G', loader);   // HTR2A: the old 1-aa block [108, 224, 1]
    assert.equal(a.expect, 'not_in_resource');
    assert.equal(a.results[0].pos, null);
    assert.match(a.message, /Residue 108 of ENST00000612998\.1 has no counterpart/);
    for (const q of ['VCV3427503', 'VCV3427504', 'VCV2535411', 'VCV4465344']) {   // PTGER3 NM_198718.2 C-terminus
      a = await search(q, loader);
      assert.equal(a.results[0].pos, null, q);
    }
    a = await search('3-46359723-C-T', loader);   // CCR2 p.Pro330Ser: in the MANE 3'UTR
    const mane = a.results[0].transcriptViews.find((w) => w.role === 'mane');
    assert.equal(mane.c, 'c.*1113C>T');
    assert.equal(mane.p, null);
  });
});

describe('resolver fixes (review findings 2, 4, 8 to 11)', { skip }, () => {
  test('intronic offsets must start at an exon edge', async () => {
    let a = await search('F2RL1 c.477+1G>A', loader);
    assert.equal(a.expect, 'not_in_resource');
    assert.match(a.message, /c\.477 is not at an exon boundary of ENST00000296677\.5/);
    a = await search('NM_005242.6:c.82+1G>A', loader);
    assert.equal(a.expect, 'not_coding');
    assert.equal(a.results[0].pos, 28);
    assert.equal(a.results[0].genomic.grch38, '5:76819265');
    a = await search('NM_005242.6:c.83-1G>A', loader);
    assert.equal(a.expect, 'not_coding');
    assert.equal(a.results[0].genomic.grch38, '5:76832689');
    a = await search('NM_005242.6:c.83+1G>A', loader);
    assert.equal(a.expect, 'not_in_resource');
  });

  test('bare residues and changes load at most 10 files', async () => {
    for (const q of ['Met1', 'p.Met1Val', 'L100', 'M159I']) {
      const seen = new Set();
      const counting = async (p) => { seen.add(p); return loader(p); };
      const a = await search(q, counting);
      assert.equal(a.expect, 'targets', q);
      if (q !== 'M159I') assert.ok(seen.size <= 10, `${q}: ${seen.size} files (${[...seen].join(', ')})`);
      assert.ok(a.results.every((r) => r.light), q);
    }
    const a = await search('M159I', loader);
    assert.ok(a.results[0].observed && a.results[0].alleles.length, 'observed receptors first, with alleles');
  });

  test('a multi-alt VCF row resolves every alternate', async () => {
    let a = await search('5 76833084 . G A,T', loader);
    assert.equal(a.expect, 'target');
    assert.deepEqual(a.results[0].alleles.map((x) => x.id).sort(), ['5-76833084-G-A', '5-76833084-G-T']);
    a = await search('5\t76833084\t.\tG\tA,C', loader);   // G>C is p.Met159Ile too (ATG>ATC), not in gnomAD
    assert.equal(a.results.length, 1);
    assert.deepEqual(a.results[0].alleles.map((x) => x.id), ['5-76833084-G-A']);
  });

  test('a locus names no change', async () => {
    const a = await search('5:76833085', loader);
    const r = a.results[0];
    assert.equal(r.pos, 160);
    assert.equal(r.alt, null);
    assert.equal(r.kind, 'residue');
    assert.deepEqual(r.alleles.map((x) => x.id), ['5-76833085-T-C']);
    assert.ok(r.notes.some((n) => n.code === 'locus'));
  });

  test('an approximate GRCh37 position is flagged', async () => {
    const a = await search('NM_005242.6:c.82+1G>A', loader);
    const r = a.results[0];
    assert.equal(r.genomic.grch37Approximate, true);
    assert.ok(r.notes.some((n) => n.code === 'liftover_approximate'));
    const b = await search('F2RL1 p.Met159Ile', loader);
    assert.ok(!b.results[0].genomic.grch37Approximate);
  });

  test('c. reference swap like p., family and isoform names', async () => {
    let a = await search('NM_000024.6:c.46A>G', loader);   // literature ADRB2 Arg16Gly
    assert.equal(a.expect, 'target');
    assert.deepEqual([a.results[0].pos, a.results[0].ref, a.results[0].alt], [16, 'G', 'R']);
    assert.deepEqual(a.results[0].alleles.map((x) => x.id), ['5-148826877-G-A']);
    assert.ok(a.results[0].notes.some((n) => n.code === 'reference_swap'));
    a = await search('5-HT2', loader);
    assert.equal(a.expect, 'ambiguous');
    assert.deepEqual(a.results.map((r) => r.gid).sort(), ['5ht2a_human', '5ht2b_human', '5ht2c_human']);
    a = await search('CCR2B', loader);
    assert.equal(a.expect, 'receptor');
    assert.equal(a.results[0].gid, 'ccr2_human');
  });
});
