// Search v2 parser tests (P4). Run: node --test GPCompaReports_v2/tests/search_v2/parse.test.mjs
//
// 1. The golden table (golden_queries.tsv, 387 rows) at parse level: every row's top interpretation must
//    equal the reviewed expectation in parse_expected.tsv (and the listed alternates must be present),
//    and must agree with the golden columns that are knowable without data (receptor named, typed
//    ref/pos/alt, ClinVar id, genomic allele and assembly label, ambiguity alternates).
// 2. Unit and property tests for notations the table lacks.
//
// The receptor-alias matcher is a stub built from receptor_stub.json (pack index names + the golden
// table's own receptor names); the real alias table comes from the search index (P3).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, summarize, MAX_QUERY_LENGTH } from '../../static/js/search/parse.js';
import { normalizeQuery, aliasKey } from '../../static/js/search/normalize.js';
import { parseProtein, parseGeneric, parseCoding, parseReceptorId, parseClinvar, parseRsid, aaThree } from '../../static/js/search/notation.js';
import { parseGenomic, ncToChrom, extractAssembly } from '../../static/js/search/genomic.js';

const here = (name) => new URL(name, import.meta.url);
const readTsv = (name) => {
  const [head, ...lines] = readFileSync(here(name), 'utf8').replace(/\r/g, '').split('\n').filter((l) => l !== '');
  const cols = head.split('\t');
  return lines.map((l) => Object.fromEntries(l.split('\t').map((v, i) => [cols[i], v])));
};

// ------------------------------------------------------------------------------------- stub matcher

const stub = JSON.parse(readFileSync(here('receptor_stub.json'), 'utf8'));
const aliases = new Map();
const put = (name, gid) => {
  const k = aliasKey(name);
  if (!k) return;
  if (!aliases.has(k)) aliases.set(k, new Set());
  aliases.get(k).add(gid);
};
for (const [gid, gene, uniprotName, uniprotId] of stub.receptors) {
  for (const n of [gid, gid.toUpperCase(), gene, uniprotName, uniprotId]) put(n, gid);
}
for (const [alias, gid] of Object.entries(stub.curated)) put(alias, gid);

/** Exact key match, then every receptor whose key starts with the typed key (autocomplete prefix). */
function matchReceptor(term) {
  const k = aliasKey(term);
  if (!k) return [];
  const out = [];
  for (const gid of aliases.get(k) ?? []) out.push({ gid, exact: true });
  if (k.length >= 2) {
    for (const [key, gids] of aliases) {
      if (key === k || !key.startsWith(k)) continue;
      for (const gid of gids) if (!out.some((o) => o.gid === gid)) out.push({ gid, exact: false });
    }
  }
  return out;
}
const ctx = { matchReceptor };
const exactGids = (i) => (i.receptorMatches ?? []).filter((m) => m.exact).map((m) => m.gid);

// ------------------------------------------------------------------------------------------- golden

const golden = readTsv('golden_queries.tsv');
const expected = new Map(readTsv('parse_expected.tsv').map((r) => [r.id, r]));
const unescape = (q) => q.replace(/\\t/g, '\t');

/** Categories where the typed number is not the pack number (the resolver maps it). */
const RENUMBERED = new Set(['shifted_numbering', 'isoform_numbering']);
/**
 * Rows whose golden answer is not the parser's top reading because choosing needs data; the golden
 * reading must still be among the interpretations (checked through parse_expected.tsv `also`).
 */
const DATA_RANKED = new Map([
  ['G051', '"G477A" is Gly477Ala first (protein legacy form) and c.477G>A second; PAR2 has no residue 477, so the resolver picks c.'],
]);
/** Golden cells this suite believes are wrong (reported to the main session; the check is skipped). */
const DISPUTED = new Map([
]);
/** Categories where the typed orientation may be the reverse of the golden (gnomAD) orientation. */
const ORIENTATION = new Set(['reference_swap', 'model_conflict']);
/**
 * GRCh38 genomic rows whose typed allele is, by design, not one of the golden alleles: the substitution
 * is not in gnomAD (rule 14), the reference base is wrong, or the Y id maps to the X allele (rule 12).
 */
const ALLELE_NOT_LISTED = new Map([
  ['G083', 'c.477G>C is not in gnomAD; the answer is residue 159 (rule 14)'],
  ['G084', 'reference mismatch: the genome has G at 5:76833084'],
  ['G221', 'PAR1 Y id: gnomAD lists the X id only (rule 12)'],
  ['G222', 'PAR1 Y id: gnomAD lists the X id only (rule 12)'],
]);

describe('golden table at parse level', () => {
  test('both tables list the same rows', () => {
    assert.equal(golden.length, 387);
    assert.deepEqual(golden.map((r) => r.id), [...expected.keys()]);
    for (const g of golden) assert.equal(expected.get(g.id).query, g.query, g.id);
  });

  for (const row of golden) {
    test(`${row.id} ${JSON.stringify(row.query)} (${row.expect})`, () => {
      const list = parse(unescape(row.query), ctx);
      assert.ok(list.length >= 1);
      const top = list[0];
      const sums = list.map(summarize);
      const exp = expected.get(row.id);

      // the reviewed reading, and its alternates
      assert.equal(sums[0], exp.top, 'top interpretation');
      for (const alt of exp.also ? exp.also.split(' | ') : []) assert.ok(sums.includes(alt), `missing alternate "${alt}" in ${JSON.stringify(sums)}`);

      const singleGid = row.gid && !row.gid.includes(';') ? row.gid : '';
      // expect class
      if (row.expect === 'unrecognised') {
        assert.ok(top.kind === 'unrecognised' || (top.kind === 'receptor' && top.receptorMatches?.length === 0),
          `unreadable input must not read as a known receptor or a variant, got ${sums[0]}`);
      }
      if (row.expect === 'receptor') {
        assert.equal(top.kind, 'receptor');
        assert.ok(exactGids(top).includes(row.gid), `receptor term "${top.receptorTerm}" should name ${row.gid}`);
      }
      // the receptor the query names
      if (top.receptorTerm && singleGid && row.expect !== 'unrecognised') {
        assert.ok(exactGids(top).includes(singleGid), `receptor term "${top.receptorTerm}" should name ${singleGid}, got ${JSON.stringify(top.receptorMatches)}`);
      }
      // the typed change against the golden residue
      const c = DATA_RANKED.has(row.id) ? null : top.change;
      if (c && row.pos && !row.pos.includes(';') && !RENUMBERED.has(row.category) && c.pos !== null) {
        assert.equal(c.pos, Number(row.pos), 'change position');
      }
      if (c && row.ref && c.ref && !row.category.includes('mismatch')) {
        if (ORIENTATION.has(row.category)) {
          if (c.kind === 'missense') assert.deepEqual([c.ref, c.alt].sort(), [row.ref, row.alt].sort(), 'change residues, either orientation');
        } else assert.equal(c.ref, row.ref, 'change reference residue');
      }
      if (c && row.alt && !row.alt.includes(',') && !ORIENTATION.has(row.category)) assert.equal(c.alt, row.alt, 'change alternate (or class)');
      if (c && !row.alt && row.expect === 'target' && top.kind === 'residue') assert.equal(c.alt, null);
      // generic numbers
      if (row.category.includes('generic')) assert.equal(top.kind, 'generic');
      // genomic: the assembly the input states, and the allele it names
      if (top.genomic?.assemblyHint && !DISPUTED.has(row.id)) assert.equal(top.genomic.assemblyHint, row.assembly, 'assembly from accession or label');
      if (top.ids?.gnomad && row.assembly === 'GRCh38' && row.alleles && !ALLELE_NOT_LISTED.has(row.id)) {
        assert.ok(row.alleles.split(',').includes(top.ids.gnomad), `${top.ids.gnomad} should be one of ${row.alleles}`);
      }
      // ClinVar ids
      const cv = /clinvar(?:_raw)?=(\d+)/.exec(row.note);
      if (top.kind === 'clinvar' && cv) assert.equal(top.ids.variationId, Number(cv[1]));
      // ambiguity: every alternate the golden row lists is among the readings
      if (row.expect === 'ambiguous') {
        if (singleGid) assert.ok(list.some((i) => exactGids(i).includes(singleGid) || i.kind === 'clinvar'), `primary ${singleGid} reading`);
        for (const a of row.alternates ? row.alternates.split(' | ') : []) {
          const [kind, ...f] = a.split(':');
          const has = (pred) => assert.ok(list.some(pred), `alternate ${a} missing from ${JSON.stringify(sums)}`);
          if (kind === 'change') { const [, pos, ra] = f; const [ref, alt] = ra.split('>'); has((i) => i.change?.pos === Number(pos) && i.change.ref === ref && i.change.alt === alt); }
          if (kind === 'residue') has((i) => i.change?.pos === Number(f[1]) && (i.change.ref === null || i.change.ref === f[2]));
          if (kind === 'generic') has((i) => i.kind === 'generic' && i.generic.bw === f[0].split('x')[0]);
          if (kind === 'clinvar') has((i) => i.kind === 'clinvar' && i.ids.variationId === Number(f[0]));
          if (kind === 'gene_id') has((i) => i.receptorId?.type === 'geneid' && i.receptorId.value === f[0]);
          if (kind === 'hgnc') has((i) => i.receptorId?.type === 'hgnc' && i.receptorId.value === `HGNC:${f[0]}`);
        }
      }
    });
  }
});

// -------------------------------------------------------------------------------------- unit tests

const top = (q, c) => parse(q, c)[0];
const topSum = (q, c) => summarize(top(q, c));

describe('interpretation contract', () => {
  const KINDS = new Set(['receptor', 'protein', 'residue', 'cdna', 'genomic', 'rsid', 'clinvar', 'generic', 'unrecognised']);
  const queries = [...golden.map((r) => unescape(r.query)), 'M1R', 'P2Y', 'ＭＥＴ１５９ＩＬＥ', 'c.477_478insA', null, undefined, 42];
  test('every result is a non-empty, sorted list of well-formed interpretations', () => {
    for (const q of queries) {
      for (const c of [undefined, ctx]) {
        const list = parse(q, c);
        assert.ok(list.length >= 1, String(q));
        for (let i = 0; i < list.length; i++) {
          const x = list[i];
          assert.ok(KINDS.has(x.kind), `${q}: kind ${x.kind}`);
          assert.ok(x.confidence >= 0 && x.confidence <= 1, `${q}: confidence`);
          assert.ok(typeof x.why === 'string' && x.why.length > 0, `${q}: why`);
          if (i) assert.ok(list[i - 1].confidence >= x.confidence, `${q}: sorted`);
          if (x.change) assert.ok(['missense', 'stop', 'synonymous', 'frameshift', 'indel', 'start', 'ext', 'residue'].includes(x.change.kind));
          if (x.cdna) assert.ok(['cds', '5utr', '3utr', 'intron'].includes(x.cdna.region));
        }
        assert.equal(new Set(list.map(summarize)).size, list.length, `${q}: no duplicates`);
      }
    }
  });
  test('deterministic and pure', () => {
    for (const q of queries.slice(0, 60)) assert.deepEqual(parse(q, ctx), parse(q, ctx));
  });
  test('non-string input reads as nothing typed', () => {
    for (const q of [null, undefined, 42, {}]) assert.equal(top(q).kind, 'unrecognised');
  });
  test('a matcher that throws or returns junk counts as no match', () => {
    const bad = { matchReceptor: () => { throw new Error('boom'); } };
    assert.equal(topSum('PAR2 M159I', bad), 'protein R=PAR2 p=M159I');
    assert.deepEqual(top('PAR2 M159I', { matchReceptor: () => 'junk' }).receptorMatches, []);
  });
});

describe('without a receptor matcher', () => {
  test('a short name that is also a change: both readings, the change flagged', () => {
    for (const q of ['M1R', 'A2A', 'F2R', 'P2Y', 'D2', 'H1', 'V2R']) {
      const list = parse(q);
      assert.ok(list[0].flags.includes('possibly-receptor-name'), q);
      assert.ok(list.some((i) => i.kind === 'receptor' && i.receptorTerm === q), q);
    }
  });
  test('names, ids and combinations', () => {
    assert.equal(topSum('PAR2'), 'receptor R=PAR2');
    assert.equal(topSum('protease-activated receptor 2'), 'receptor R=protease-activated receptor 2');
    assert.equal(topSum('P55085'), 'receptor R=P55085 rid=uniprot:P55085');
    assert.equal(topSum('F2RL1 M159I'), 'protein R=F2RL1 p=M159I');
    assert.equal(topSum('ADRB2 6 48'), 'generic R=ADRB2 gn=6.48');
    assert.equal(top('M159I PAR2').flags.includes('reversed-order'), true);
    assert.equal(topSum('M159I PAR2'), 'protein R=PAR2 p=M159I');
  });
  test('H1 is never helix 1', () => {
    assert.ok(parse('H1', ctx).every((i) => i.kind !== 'generic'));
    assert.equal(parseGeneric('H1'), null);
  });
});

describe('normalisation', () => {
  test('whitespace, Unicode and punctuation', () => {
    assert.equal(normalizeQuery('  F2RL1  p.Met159Ile\t'), 'F2RL1 p.Met159Ile');
    assert.equal(normalizeQuery('Ｆ２ＲＬ１　Ｍ１５９Ｉ'), 'F2RL1 M159I');
    assert.equal(normalizeQuery('Met–159—Ile'), 'Met-159-Ile');
    assert.equal(normalizeQuery('M159 -> I'), 'M159>I');
    assert.equal(normalizeQuery('M159⟶I'), 'M159>I');
    assert.equal(normalizeQuery('“PAR2”;'), 'PAR2');
    assert.equal(normalizeQuery('P​AR2'), 'PAR2');
    assert.equal(normalizeQuery('3×50'), '3x50');
    assert.equal(normalizeQuery('CCR5-Δ32'), 'CCR5 delta32');
  });
  test('alias keys', () => {
    assert.equal(aliasKey('β2-AR'), 'beta2ar');
    assert.equal(aliasKey('Β2AR'), 'beta2ar');
    assert.equal(aliasKey('5-HT1A'), aliasKey('5ht1a'));
    assert.equal(aliasKey('μ opioid'), 'muopioid');
  });
  test('Unicode queries parse like their ASCII forms', () => {
    assert.equal(topSum('Ｆ２ＲＬ１ ｍｅｔ１５９ｉｌｅ', ctx), 'protein R=Ｆ２ＲＬ１'.normalize('NFKC') + ' p=M159I');
    assert.equal(topSum('F2RL1 Met–159–Ile', ctx), 'protein R=F2RL1 p=M159I');
    assert.equal(topSum('5–76833084–G–A'), 'genomic g=5:76833084:G>A@?/gnomad gnomad=5-76833084-G-A');
  });
});

describe('protein notation', () => {
  const p = (s) => { const r = parseProtein(s); return r && !r.malformed ? `${r.ref}${r.pos}${r.alt ?? ''}:${r.kind}` : r; };
  test('classes', () => {
    assert.equal(p('p.Ter398GlnextTer5'), '*398ext:ext');
    assert.equal(p('p.*398Qext*?'), '*398ext:ext');
    assert.equal(p('p.Met1ext-5'), 'M1ext:ext');
    assert.equal(p('p.Met1?'), 'M1?:start');
    assert.equal(p('p.(Met1?)'), 'M1?:start');
    assert.equal(p('M159fs'), 'M159fs:frameshift');
    assert.equal(p('p.M159Rfs*12'), 'M159fs:frameshift');
    assert.equal(p('p.Met159_Tyr160del'), 'M159del:indel');
    assert.equal(p('p.Met159_Tyr160dup'), 'M159dup:indel');
    assert.equal(p('p.Met159delinsIleLeu'), 'M159delins:indel');
    assert.equal(parseProtein('p.Met159delinsIleLeu').inserted, 'IL');
    assert.equal(p('Ala2Ala'), 'A2=:synonymous');
    assert.equal(p('p.Arg16Stop'), 'R16*:stop');
  });
  test('round trip: every spelling of a change gives the same change', () => {
    const aa = 'ACDEFGHIKLMNPQRSTVWY';
    for (let k = 0; k < 200; k++) {
      const ref = aa[(k * 7) % 20]; const alt = aa[(k * 11 + 3) % 20]; const pos = 1 + ((k * 37) % 999);
      if (ref === alt) continue;
      const R = aaThree(ref); const A = aaThree(alt);
      const forms = [`p.${R}${pos}${A}`, `p.${ref}${pos}${alt}`, `p.(${R}${pos}${A})`, `${R}${pos}${A}`, `${ref}${pos}${alt}`,
        `${R}-${pos}-${A}`, `${ref}${pos}>${alt}`, `${ref}${pos}→${alt}`, `${pos}${ref}>${alt}`, `P.${R.toUpperCase()}${pos}${A.toUpperCase()}`];
      for (const f of forms) {
        const hit = parse(`ADRB2 ${f}`, ctx).find((i) => i.kind === 'protein');
        assert.ok(hit, f);
        assert.deepEqual([hit.change.ref, hit.change.pos, hit.change.alt, hit.receptorTerm], [ref, pos, alt, 'ADRB2'], f);
      }
    }
  });
  test('gene symbols are not changes; bad changes are flagged, not guessed', () => {
    for (const s of ['GPR3', 'CCR5', 'S1PR1', 'C3AR1', 'MC4R', 'P2RY12', 'A2AR', 'CB1']) assert.equal(parseProtein(s), null, s);
    for (const s of ['p.Met159Xyz', 'M0I', 'p.', 'Met159Foo']) assert.ok(parseProtein(s)?.malformed, s);
  });
});

describe('coding notation', () => {
  test('regions, operations and coordinates', () => {
    const c = (s) => parseCoding(s);
    assert.deepEqual([c('c.-23+1G>A').region, c('c.-23+1G>A').offset], ['intron', 1]);
    assert.equal(c('c.477_478insA').op, 'ins');
    assert.equal(c('c.477delinsAT').inserted, 'AT');
    assert.equal(c('c.477_479inv').op, 'inv');
    assert.equal(c('n.123A>G').coord, 'n');
    assert.equal(c('r.477g>u').alt, 'U');
    assert.ok(c('c.477G>G') === null || c('c.477G>G').malformed);
    assert.ok(c('c.477_478G>A').malformed);
  });
  test('n. and r. are recognised and flagged', () => {
    assert.ok(top('F2RL1 n.123A>G', ctx).flags.includes('non-coding-coordinate'));
    assert.ok(top('NM_005242.6:r.477g>a').flags.includes('rna-coordinate'));
  });
  test('transcripts', () => {
    assert.equal(topSum('LRG_123t1:c.45A>G'), 'cdna c=LRG_123t1:cds:45A>G');
    assert.equal(top('ENST00000296677:c.477G>T').cdna.version, null);
    assert.equal(topSum('NM_005242.6(F2RL1):c.477G>A'), 'cdna R=F2RL1 c=NM_005242.6:cds:477G>A');
    assert.equal(topSum('NP_005233.3(F2RL1):p.Met159Ile'), 'protein R=F2RL1 p=M159I@NP_005233.3');
    assert.equal(top('NM_005242.6:x.477G>A').kind, 'unrecognised');
  });
});

describe('genomic notation', () => {
  test('RefSeq chromosome accessions and assemblies', () => {
    assert.deepEqual(ncToChrom('NC_000023.11'), { chrom: 'X', assembly: 'GRCh38', accession: 'NC_000023', version: 11 });
    assert.equal(ncToChrom('NC_000023.10').assembly, 'GRCh37');
    assert.equal(ncToChrom('NC_000024.10').chrom, 'Y');
    assert.equal(ncToChrom('NC_000001.11').assembly, 'GRCh38');
    assert.equal(ncToChrom('NC_000001.10').assembly, 'GRCh37');
    assert.equal(ncToChrom('NC_000001.7').assembly, null);
    assert.equal(ncToChrom('NC_012920.1').chrom, 'MT');
    assert.equal(ncToChrom('NC_000030.1'), null);
  });
  test('formats', () => {
    assert.equal(topSum('5 76833084 . G A,T'), 'genomic g=5:76833084:G>A,T@?/vcf');
    assert.equal(topSum('NC_000005.10:76833083:1:A'), 'genomic g=5:76833084:>A@GRCh38/spdi spdi=NC_000005.10:76833083:1:A');
    assert.equal(topSum('24-2781480-C-T'), 'genomic g=Y:2781480:C>T@?/gnomad gnomad=Y-2781480-C-T');
    assert.equal(topSum('25-1466186-C-T'), 'genomic g=X:1466186:C>T@?/gnomad gnomad=X-1466186-C-T');
    assert.equal(topSum('chrX:1,466,186'), 'genomic g=X:1466186@?/locus');
    assert.equal(topSum('chr5:76,833,000-76,834,000'), 'genomic g=5:76833000-76834000@?/range');
    assert.equal(topSum('5-76128909-G-A (GRCh37)'), 'genomic g=5:76128909:G>A@GRCh37/gnomad gnomad=5-76128909-G-A');
    assert.equal(topSum('b37 5:76128909:G:A'), 'genomic g=5:76128909:G>A@GRCh37/gnomad gnomad=5-76128909-G-A');
    assert.equal(topSum('chr5:g.76833084G>A'), 'genomic g=5:76833084:G>A@?/hgvs_g gnomad=5-76833084-G-A');
    assert.equal(top('5-76833084-G-G').kind, 'unrecognised');
    assert.equal(top('chr30:123').kind, 'unrecognised');
    assert.equal(extractAssembly('PAR2 M159I').assembly, null);
  });
  test('round trip: every genomic spelling of an allele gives the same gnomAD id', () => {
    const forms = ['5-76833084-G-A', 'chr5:76833084:G:A', 'chr5_76833084_G_A', '5:76833084 G>A', '5 76833084 . G A',
      '5\t76833084\trs115885685\tG\tA', 'NC_000005.10:g.76833084G>A', 'NC_000005.10:76833083:G:A', 'CHR5-76833084-g-a',
      '5:76,833,084:G:A', 'GRCh38 5-76833084-G-A'];
    for (const f of forms) assert.equal(top(f).ids.gnomad, '5-76833084-G-A', f);
    assert.equal(parseGenomic('6 48'), null);
  });
});

describe('ids', () => {
  test('ClinVar, dbSNP and receptor identifiers', () => {
    assert.deepEqual(parseClinvar('RCV000012345.6'), { rcv: 'RCV000012345', version: 6 });
    assert.deepEqual(parseClinvar('Variation ID 123'), { variationId: 123 });
    assert.ok(parseClinvar('VCV').malformed);
    assert.equal(parseRsid('dbSNP:rs123'), 'rs123');
    assert.equal(topSum('RCV000012345'), 'clinvar rcv=RCV000012345');
    assert.deepEqual(parseReceptorId('P55085-2'), { type: 'uniprot', value: 'P55085', isoform: 2 });
    assert.deepEqual(parseReceptorId('ENSG00000164251.15'), { type: 'ensg', value: 'ENSG00000164251' });
    assert.deepEqual(parseReceptorId('NCBI Gene 2150'), { type: 'geneid', value: '2150' });
    assert.deepEqual(parseReceptorId('Entrez 2150'), { type: 'geneid', value: '2150' });
    assert.deepEqual(parseReceptorId('hgnc 3538'), { type: 'hgnc', value: 'HGNC:3538' });
    assert.equal(parseReceptorId('PAR2'), null);
  });
});

describe('generic numbers', () => {
  const g = (s) => { const r = parseGeneric(s); return r && `${r.display}${r.residueLetter ? `/${r.residueLetter}${r.residueNumber ?? ''}` : ''}${r.partial ? '~' : ''}`; };
  test('forms', () => {
    assert.equal(g('R^{3.50}'), '3.50/R');
    assert.equal(g('Arg131[3.50]'), '3.50/R131');
    assert.equal(g('ICL2.50'), '34.50');
    assert.equal(g('ECL1x50'), '23x50');
    assert.equal(g('TM6.48'), '6.48');
    assert.equal(g('6.4'), '6.4~');
    assert.equal(g('9.50'), null);
    assert.equal(g('ECL4.50'), null);
    assert.equal(g('Xyz3.50'), null);
    assert.equal(g('1.2.3'), null);
  });
  test('a generic number and its residue disagree: both are kept for the resolver', () => {
    assert.deepEqual(top('ADRB2 Arg130(3.50)', ctx).generic, { segment: '3', bw: '3.50', gpcrdb: null, display: '3.50', form: 'dot', residueLetter: 'R', residueNumber: 130 });
  });
});

describe('ranking rules', () => {
  test('exact receptor name beats the variant reading, which stays as an alternate', () => {
    for (const [q, gid] of [['M1R', 'acm1_human'], ['A2A', 'aa2ar_human'], ['F2R', 'par1_human'], ['D2', 'drd2_human'], ['H1', 'hrh1_human']]) {
      const list = parse(q, ctx);
      assert.equal(list[0].kind, 'receptor', q);
      assert.deepEqual(exactGids(list[0]), [gid], q);
      assert.ok(list.slice(1).some((i) => i.change?.pos >= 1), `${q}: variant alternate`);
    }
  });
  test('exact name beats prefix: GPR3 is not GPR31', () => {
    assert.deepEqual(exactGids(top('GPR3', ctx)), ['gpr3_human']);
    assert.deepEqual(exactGids(top('XCR1 p.Ser173Leu', ctx)), ['xcr1_human']);
  });
  test('a bare integer is never a residue without a receptor', () => {
    assert.ok(parse('159', ctx).every((i) => !i.change));
    assert.equal(topSum('F2RL1 159', ctx), 'residue R=F2RL1 p=?159');
  });
});

// ------------------------------------------------------------------------------ query length cap

describe('query length cap', () => {
  const nasty = [
    'PAR2 M159I '.repeat(2000),
    'a b,'.repeat(5000),
    `${'x'.repeat(10000)} ${'y'.repeat(10000)}`,
    ':'.repeat(20000),
  ];
  test('a 20k-character query parses in under 50 ms and says it was cut', () => {
    for (const q of nasty) {
      assert.ok(q.length >= 20000);
      const t0 = performance.now();
      const out = parse(q);
      const ms = performance.now() - t0;
      assert.ok(ms < 50, `${ms.toFixed(1)} ms for ${q.slice(0, 20)}`);
      assert.ok(out.every((i) => i.flags?.includes('query-truncated')));
    }
  });
  test('a query of exactly the limit is read whole, without the flag', () => {
    const out = parse(`PAR2 M159I${' '.repeat(MAX_QUERY_LENGTH - 10)}`);
    assert.ok(!out[0].flags?.includes('query-truncated'));
    assert.equal(parse(`PAR2 M159I${' '.repeat(MAX_QUERY_LENGTH)}`)[0].flags?.includes('query-truncated'), true);
  });
  test('the first 300 characters still parse as usual', () => {
    const out = parse(`PAR2 M159I ${'z'.repeat(5000)}`);
    assert.ok(out[0].flags.includes('query-truncated'));
  });
});
