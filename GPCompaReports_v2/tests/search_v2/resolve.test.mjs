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
  test('table size', () => assert.equal(golden.length, 396));
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
  test('all 488 packed P/LP records are targets at their residue; every class of missense record reads as its allele; other records keep their residue', async () => {
    const S = shardsFor(loader);
    const meta = await S.meta();
    const failures = [];
    let packed = 0; let others = 0; let missense = 0; let joined = 0;
    for (const rec of meta.receptors) {
      const v = await S.variants(rec.gid);
      for (const c of v?.clinvar ?? []) {
        const want = c.packed || (c.pos && c.variationId % 50 === 0);
        if (!want) continue;
        const ans = await search(c.accession, loader);
        const r = ans.results[0];
        const own = c.gnomadId ? v.byId.get(c.gnomadId) : null;
        if (c.packed) {
          packed += 1;
          if (ans.expect !== 'target' || r?.gid !== rec.gid || r.pos !== c.pos || r.ref !== (own?.ref ?? c.ref) || r.alt !== c.alt) failures.push(`${c.accession} -> ${ans.expect} ${r?.gid}:${r?.pos} ${r?.ref}>${r?.alt} (want ${rec.gid}:${c.pos} ${c.ref}>${c.alt})`);
        } else if (c.kind === 'missense') {
          // any class (VUS, benign, conflicting...): the allele's own result, as its rsID or genomic id gives it
          missense += 1;
          if (ans.expect !== 'target' || r?.gid !== rec.gid || r.pos !== c.pos || r.alt !== (own?.alt ?? c.alt)) failures.push(`${c.accession} -> ${ans.expect} ${r?.gid}:${r?.pos} ${r?.ref}>${r?.alt} (want ${rec.gid}:${c.pos} >${c.alt}) ${ans.message ?? ''}`);
          if (own) {
            joined += 1;
            if (!r?.alleles.some((a) => a.id === own.id)) failures.push(`${c.accession}: gnomAD allele ${own.id} dropped`);
          }
        } else {
          others += 1;
          if (ans.expect !== 'not_in_resource' || r?.gid !== rec.gid || r.pos !== c.pos) failures.push(`${c.accession} -> ${ans.expect} ${r?.gid}:${r?.pos} (want ${rec.gid}:${c.pos})`);
        }
        if (r && r.clinvar[0]?.variationId !== c.variationId) failures.push(`${c.accession}: the record is not listed first`);
      }
    }
    assert.ok(missense > 200 && joined > 50, `missense records checked: ${missense}, with a gnomAD allele: ${joined}`);
    assert.equal(packed, 488);
    assert.ok(others > 20, `other records checked: ${others}`);
    assert.deepEqual(failures.slice(0, 20), []);
  });

  test('a VCV query gives what the rsID and the protein change give for the same allele, plus the record', async () => {
    // VCV000014312 (Conflicting) and VCV000256813 (Benign) once lost their gnomAD allele and AlphaMissense
    const strip = (r) => ({ gid: r.gid, pos: r.pos, ref: r.ref, alt: r.alt, kind: r.kind, type: r.type,
      alleles: r.alleles.map((a) => [a.id, a.ac, a.af, a.am, a.amClass]), genomic: r.genomic,
      tx: r.transcriptViews.map((t) => [t.role, t.transcript, t.p]), clinvar: r.clinvar.map((c) => c.variationId).sort() });
    for (const [vcv, rs, prot] of [['VCV000014312', 'rs1805007', 'MC1R Arg151Cys'], ['VCV000256813', 'rs1801028', 'DRD2 Ser311Cys']]) {
      const [a, b, p] = [await search(vcv, loader), await search(rs, loader), await search(prot, loader)];
      assert.equal(a.expect, 'target', `${vcv}: ${a.message}`);
      assert.ok(a.results[0].alleles[0]?.am != null && a.results[0].alleles[0].af > 0.01, `${vcv}: gnomAD AF and AlphaMissense`);
      assert.deepEqual(strip(a.results[0]), strip(b.results[0]), `${vcv} vs ${rs}`);
      assert.deepEqual(strip(a.results[0]), strip(p.results[0]), `${vcv} vs ${prot}`);
      assert.equal(a.results[0].clinvar[0].accession.slice(0, 12), vcv);
    }
  });
});

describe('changes no single-nucleotide variant gives', { skip }, () => {
  test('ADRB2 R131Q (codon CGC) needs two substitutions; a one-substitution change does not get the reason', async () => {
    const r = (await search('ADRB2 R131Q', loader)).results[0];
    assert.equal(r.alleles.length, 0);
    assert.equal(r.codon?.codon, 'CGC');
    assert.equal(r.codon.steps.Q, 2);
    assert.equal(r.codon.steps.H, 1);
    const one = (await search('DRD2 S311A', loader)).results[0];
    assert.equal(one.alleles.length, 0);
    assert.equal(one.codon.steps.A, 1);
    // an allele held: no codon field
    assert.equal((await search('MC1R Arg151Cys', loader)).results[0].codon, undefined);
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

// ------------------------------------------------------------------ engine round 2 (review A2, A3, A6/C1, A7, C7)

const counted = () => {
  const seen = new Set();
  const f = async (p) => { seen.add(p); return loader(p); };
  return { f, seen };
};

describe('A2 transcript and protein versions are never silently substituted', { skip }, () => {
  test('a version above every known one is answered with the known versions', async () => {
    for (const [q, acc, want] of [
      ['NM_005242.999:c.477G>A', 'NM_005242', ['NM_005242.6:c.477G>A']],
      ['NP_005233.999:p.Met159Ile', 'NP_005233', ['NP_005233.4:p.Met159Ile']],
      ['ENST00000296677.99:c.477G>A', 'ENST00000296677', ['ENST00000296677.5:c.477G>A', 'ENST00000296677.4:c.477G>A']],
    ]) {
      const a = await search(q, loader);
      assert.equal(a.expect, 'not_in_resource', q);
      assert.equal(a.results.length, 1);
      assert.equal(a.results[0].gid, 'par2_human');
      assert.equal(a.results[0].pos, null, `${q}: no residue is claimed`);
      assert.ok(a.results[0].notes.some((n) => n.code === 'version_unknown'), q);
      assert.match(a.message, new RegExp(`${acc}\\.\\d+ is not a known version of ${acc}`));
      assert.deepEqual(a.alternates.map((x) => x.kind), want.map(() => 'transcript'), q);
      assert.deepEqual(a.alternates.map((x) => x.query), want, q);
      for (const alt of a.alternates) {
        const b = await search(alt.query, loader);
        assert.equal(b.expect, 'target', alt.query);
        assert.equal(b.results[0].pos, 159);
      }
    }
  });
  test('an older version resolves on the current one with a note and a read_on view, not a typed one', async () => {
    let a = await search('NM_005242.5:c.477G>A', loader);
    assert.equal(a.expect, 'target');
    assert.ok(a.results[0].notes.some((n) => n.code === 'version_mismatch' && /NM_005242\.5 is not in our version tables/.test(n.text)));
    assert.ok(!a.results[0].transcriptViews.some((v) => v.role === 'typed'), 'no typed view for a substituted version');
    assert.ok(a.results[0].transcriptViews.some((v) => v.role === 'read_on' && v.transcript === 'NM_005242.6' && v.typedAs === 'NM_005242.5'));
    a = await search('NP_005233.3:p.Met159Ile', loader);
    assert.equal(a.expect, 'target');
    assert.ok(a.results[0].notes.some((n) => n.code === 'version_mismatch' && /NP_005233\.3/.test(n.text)));
  });
  test('the "typed" view role appears only when a transcript was typed', async () => {
    for (const q of ['ADRB2 c.491C>T', 'F2RL1 c.477G>A', '5-76833084-G-C', 'chr5:148206801C>T', 'ADRB2 p.Thr164Ile']) {
      const a = await search(q, loader);
      assert.ok(POSITIVE_EXPECT.has(a.expect), `${q}: ${a.expect}`);
      for (const r of a.results) assert.ok(!r.transcriptViews.some((v) => v.role === 'typed'), `${q}: ${JSON.stringify(r.transcriptViews.map((v) => v.role))}`);
    }
    const a = await search('ADRB2 c.491C>T', loader);
    assert.ok(a.results[0].transcriptViews.some((v) => v.role === 'gnomad' && v.c === 'c.491C>T'));
    for (const q of ['NM_005242.6:c.477G>A', 'ENST00000296677.5:c.477G>A']) {
      const b = await search(q, loader);
      assert.ok(b.results[0].transcriptViews.some((v) => v.role === 'typed' && q.startsWith(v.transcript)), q);
    }
  });
});

describe('A3 a reference mismatch keeps the typed change and offers the correction', { skip }, () => {
  test('PAR2 p.Ala159Ile', async () => {
    const a = await search('PAR2 p.Ala159Ile', loader);
    assert.equal(a.expect, 'not_in_resource');
    assert.deepEqual(a.typed, { ref: 'A', pos: 159, alt: 'I' });
    assert.match(a.message, /159 is Met/);
    assert.doesNotMatch(a.message, /not listed/i);
    const c = a.alternates[0];
    assert.deepEqual([c.kind, c.gid, c.pos, c.ref, c.alt, c.count, c.observed], ['change', 'par2_human', 159, 'M', 'I', 2, true]);
    const b = await search(c.query, loader);
    assert.equal(b.expect, 'target');
    assert.deepEqual(b.results[0].alleles.map((x) => x.id).sort(), ['5-76833084-G-A', '5-76833084-G-T']);
  });
  test('an unrecorded correction says so; a generic mismatch offers the model residue', async () => {
    let a = await search('F2RL1 p.Trp159Ala', loader);
    assert.deepEqual(a.typed, { ref: 'W', pos: 159, alt: 'A' });
    assert.deepEqual([a.alternates[0].kind, a.alternates[0].count, a.alternates[0].observed], ['change', 0, false]);
    assert.match(a.alternates[0].label, /not recorded/);
    a = await search('PAR2 F3.36', loader);
    assert.equal(a.typed.ref, 'F');
    assert.equal(a.typed.generic, '3.36');
    assert.deepEqual([a.alternates[0].kind, a.alternates[0].pos, a.alternates[0].ref], ['residue', 159, 'M']);
    a = await search('F2RL1 M999I', loader);
    assert.equal(a.alternates.length, 0, 'no correction outside the model');
  });
});

describe('A6/C1 cross-receptor results carry a residue summary', { skip }, () => {
  const SUMMARY_KEYS = ['aa', 'generic', 'segment', 'net', 'dmax', 'dmaxSigned', 'dmaxPartner', 'dmaxPartnerPos', 'nsig', 'threshold', 'cfr', 'cfrRank', 'conservation', 'family'];
  test('M159I: summary on every receptor, observed counts on each', async () => {
    const a = await search('M159I', loader);
    for (const r of a.results) {
      for (const k of SUMMARY_KEYS) assert.ok(k in r.summary, `${r.gid} summary.${k}`);
      assert.equal(r.summary.aa, 'M');
      assert.deepEqual(r.summary.observed, { gnomad: r.alleles.length, clinvar: r.clinvar.length });
    }
    const p = a.results.find((r) => r.gid === 'par2_human').summary;
    assert.deepEqual([p.generic, p.segment, p.dmaxPartner, p.cfr, p.family], ['3.36x36', 'TM3', 'F300', true, 'Proteinase-activated receptors']);
    assert.equal(p.observed.gnomad, 2);
    assert.ok(p.dmax > p.threshold && p.nsig >= 1);
  });
  test('summaries agree with the full residue card (residues shard) for every receptor at 3.50x50', async () => {
    const S = shardsFor(loader);
    const a = await search('3.50x50', loader);
    assert.equal(a.results.length, 283);
    for (const r of a.results) {
      const full = (await S.residues(r.gid)).residue(r.pos);
      const s = r.summary;
      assert.equal(s.generic, full.generic, r.gid);
      assert.equal(s.segment, full.segment, r.gid);
      assert.equal(s.nsig, full.nsig, r.gid);
      assert.equal(s.cfrRank, full.cfrRank, r.gid);
      assert.equal(s.cfr, full.cfr, r.gid);
      if (full.dmax === null) assert.equal(s.dmax, null, r.gid);
      else assert.ok(Math.abs(s.dmax - full.dmax) <= 0.051, `${r.gid} dmax ${s.dmax} vs ${full.dmax}`);
      if (full.conservation !== null) assert.ok(Math.abs(s.conservation - full.conservation) <= 0.051, r.gid);
    }
  });
  test('a full card carries the same summary as the light result', async () => {
    const light = (await search('M159I', loader)).results.find((r) => r.gid === 'par2_human').summary;
    const full = (await search('PAR2 M159I', loader)).results[0].summary;
    const { observed, ...rest } = light;
    assert.ok(observed);
    assert.deepEqual(full, rest);
  });
  test('3.50x50 loads at most 3 files; a bare residue still at most 10', async () => {
    let c = counted();
    await search('3.50x50', c.f);
    assert.ok(c.seen.size <= 3, [...c.seen].join(', '));
    c = counted();
    const a = await search('L100', c.f);
    assert.ok(c.seen.size <= 10, [...c.seen].join(', '));
    assert.ok(a.results.every((r) => r.summary && r.summary.aa === 'L'));
  });
  test('R3.50 filters to Arg and says so; the other receptors are a separate group', async () => {
    const a = await search('R3.50', loader);
    assert.equal(a.expect, 'targets');
    assert.equal(a.results.length, 269);
    assert.ok(a.results.every((r) => r.ref === 'R'));
    assert.deepEqual(a.groups.map((g) => [g.key, g.results.length]), [['match', 269], ['other', 14]]);
    assert.ok(a.groups[1].results.every((r) => r.ref !== 'R' && r.summary));
    assert.equal(a.filterNote, '269 of 283 receptors have Arg at 3.50x50; the other 14 are listed separately.');
    const b = await search('3.50x50', loader);
    assert.equal(b.filterNote, undefined);
  });
});

describe('A7 VarSome / Alamut genomic forms', { skip }, () => {
  test('chr5:148206801C>T and friends read as the ADRB2 T136I allele (GRCh37)', async () => {
    for (const q of ['chr5:148206801C>T', 'chr5:148206801 C>T', '5:148206801C>T', 'chr5:g.148206801C>T']) {
      const a = await search(q, loader);
      assert.equal(a.expect, 'target', q);
      assert.equal(a.assembly, 'GRCh37', q);
      assert.deepEqual([a.results[0].gid, a.results[0].pos, a.results[0].ref, a.results[0].alt], ['adrb2_human', 136, 'T', 'I'], q);
    }
    const a = await search('chr5:76833084G>A', loader);
    assert.equal(a.assembly, 'GRCh38');
    assert.deepEqual(a.results[0].alleles.map((x) => x.id), ['5-76833084-G-A']);
  });
});

describe('C7 motif words', { skip }, () => {
  test('DRY across receptors: light results grouped by position, motif named', async () => {
    const c = counted();
    const a = await search('DRY', c.f);
    assert.equal(a.expect, 'targets');
    assert.equal(a.motif.key, 'dry');
    assert.deepEqual(a.motif.positions, ['3.49', '3.50', '3.51']);
    assert.match(a.message, /DRY motif/);
    assert.deepEqual(a.groups.map((g) => g.key), ['3.49', '3.50', '3.51']);
    assert.equal(a.groups[1].results.length, 283);
    assert.match(a.groups[1].label, /269 of 283 receptors have Arg/);
    assert.ok(a.results.every((r) => r.light && r.summary && a.motif.positions.includes(r.generic.split('x')[0])));
    assert.ok(c.seen.size <= 3, [...c.seen].join(', '));
  });
  test('a motif in one receptor gives its residues as full results', async () => {
    let a = await search('ADRB2 DRY', loader);
    assert.equal(a.expect, 'targets');
    assert.deepEqual(a.results.map((r) => [r.gid, r.pos, r.ref]), [['adrb2_human', 130, 'D'], ['adrb2_human', 131, 'R'], ['adrb2_human', 132, 'Y']]);
    assert.ok(a.results.every((r) => r.residue && r.summary && r.notes.some((n) => n.code === 'motif')));
    a = await search('NPxxY in PAR2', loader);
    assert.equal(a.motif.key, 'npxxy');
    assert.deepEqual(a.results.map((r) => r.residue.bw), ['7.49', '7.50', '7.51', '7.52', '7.53']);
    assert.ok(a.results.every((r) => r.gid === 'par2_human'));
  });
  test('every motif word resolves; positions follow the database definitions', async () => {
    const want = {
      CWxP: ['6.47', '6.48', '6.49', '6.50'], PIF: ['3.40', '5.50', '6.44'], NPXXY: ['7.49', '7.50', '7.51', '7.52', '7.53'],
      'ionic lock': ['3.50', '6.30'], 'toggle switch': ['6.48'], 'sodium pocket': ['2.50', '3.39', '7.45', '7.46', '7.49'],
      'Na+ pocket': ['2.50', '3.39', '7.45', '7.46', '7.49'], 'DRY motif': ['3.49', '3.50', '3.51'],
    };
    for (const [q, pos] of Object.entries(want)) {
      const a = await search(q, loader);
      assert.equal(a.expect, 'targets', q);
      assert.deepEqual(a.motif.positions, pos, q);
      assert.deepEqual(a.groups.map((g) => g.key), pos, q);
    }
    const a = await search('XYZ9 DRY', loader);
    assert.equal(a.results.length, 0);
  });
});

describe('variant card evidence: per-substitution AlphaMissense, contacts, motifs (detail/ shard)', { skip }, () => {
  const counted = () => { const seen = new Set(); return { seen, f: async (p) => { seen.add(p); return loader(p); } }; };

  test('a two-nucleotide change carries the AlphaMissense prediction of its substitution', async () => {
    const r = (await search('ADRB2 R131Q', loader)).results[0];
    assert.equal(r.codon?.steps?.Q, 2, 'no single-nucleotide allele gives Gln');
    assert.equal(r.alleles.length, 0);
    assert.deepEqual(r.amThis, { am: 0.972, amClass: 'pathogenic' });
    assert.equal(Object.keys(r.amAll).length, 19, 'every substitution but the reference residue');
    assert.ok(!('R' in r.amAll));
    for (const v of Object.values(r.amAll)) assert.ok(v.am >= 0 && v.am <= 1 && ['benign', 'ambiguous', 'pathogenic'].includes(v.amClass));
  });

  test('the per-substitution table agrees with the allele scores and the residue mean', async () => {
    for (const q of ['MC1R Arg151Cys', 'DRD2 S311C', 'PAR2 M159I']) {
      const r = (await search(q, loader)).results[0];
      assert.ok(r.amAll, q);
      for (const a of r.residueAlleles) if (a.am !== null) assert.equal(r.amAll[a.alt].am, a.am, `${q} ${a.id}`);
      const mean = Object.values(r.amAll).reduce((s, v) => s + v.am, 0) / Object.keys(r.amAll).length;
      assert.ok(Math.abs(mean - r.residue.amMean) < 0.011, `${q}: mean ${mean} vs ${r.residue.amMean}`);
    }
  });

  test('contacts are the threshold-passing pairs of the residue, largest |ΔRRCS| first, with the partner named', async () => {
    const r = (await search('ADRB2 R131Q', loader)).results[0];
    assert.equal(r.contacts.length, r.summary.nsig);
    assert.equal(r.contacts.length, r.residue.nsig);
    const abs = r.contacts.map((c) => Math.abs(c.delta));
    assert.deepEqual(abs, [...abs].sort((a, b) => b - a));
    assert.deepEqual(r.contacts.map((c) => c.partnerPos), [130, 141, 68]);
    assert.deepEqual(r.contacts[0], { a: 130, b: 131, partnerPos: 130, partnerAa: 'D', partnerGeneric: '3.49x49', partnerSegment: 'TM3', delta: -5.67, active: 0.38, inactive: 6.05 });
    for (const c of r.contacts) {
      assert.ok(Math.abs(c.delta) >= r.summary.threshold - 0.005, 'above the threshold');
      assert.ok(Math.abs(c.active - c.inactive - c.delta) < 0.011, 'ΔRRCS = active - inactive');
      assert.ok(c.a === 131 || c.b === 131);
    }
    assert.equal(Math.round(Math.abs(r.contacts[0].delta) * 10) / 10, r.summary.dmax);
  });

  test('a residue without a threshold-passing contact gets an empty list, not a missing one', async () => {
    const r = (await search('MC4R V103I', loader)).results[0];
    assert.deepEqual(r.contacts, []);
    assert.equal(r.summary.nsig, 0);
    assert.deepEqual(r.amThis, { am: 0.084, amClass: 'benign' });
    assert.deepEqual(r.motifs, []);
  });

  test('motif membership follows the database definitions by BW number', async () => {
    const r131 = (await search('ADRB2 R131Q', loader)).results[0];
    assert.deepEqual(r131.motifs.map((m) => [m.key, m.position, m.canonical]), [['dry', '3.50', 'R'], ['ioniclock', '3.50', 'R']]);
    const w = (await search('ADRB2 W286', loader)).results[0];
    assert.deepEqual(w.motifs.map((m) => m.key).sort(), ['cwxp', 'toggle']);
    const n = (await search('ADRB2 N322', loader)).results[0];
    assert.deepEqual(n.motifs.map((m) => m.key).sort(), ['npxxy', 'sodium']); // 7.49 is in NPxxY and in the sodium pocket
  });

  test('ClinVar records carry the number of submissions and the last-evaluated date', async () => {
    const r = (await search('MC4R V103I', loader)).results[0];
    assert.ok(r.clinvar.length >= 1);
    const c = r.clinvar[0];
    assert.ok(Number.isInteger(c.scv) && c.scv >= 1, 'scv');
    assert.match(c.evaluated, /^\d{4}-\d{2}-\d{2}$/);
  });

  test('a full card loads the detail shard once and at most 12 files in all', async () => {
    const c = counted();
    await search('ADRB2 R131Q', c.f);
    assert.ok([...c.seen].filter((p) => p.startsWith('detail/')).length === 1, [...c.seen].join(', '));
    assert.ok(c.seen.size <= 12, [...c.seen].join(', '));
    // a bare change across receptors never loads it
    const d = counted();
    await search('M159I', d.f);
    assert.ok(![...d.seen].some((p) => p.startsWith('detail/')));
  });
});
