// CFR neighbourhood tests (search/cfrhood.js) on fixtures: no index needed. Run:
//   node --test GPCompaReports_v2/tests/search_v2/cfrhood.test.mjs
//
// The rules: at = the residue's generic number is a top-30 CFR position; connected = an above-threshold contact
// whose partner is at a CFR position; near = within 2 residues of a CFR position along the chain, same segment;
// touch = a below-threshold modelled contact with a CFR residue. One group per residue, in that order.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cfrNeighbourhood, cfrVariantRows, NEAR_SEQ, CFR_GROUPS, isPlp } from '../../static/js/search/cfrhood.js';

/**
 * A 20-residue receptor: TM3 = 1..8, ICL2 = 9..10, TM4 = 11..20. CFR positions: 5 (rank 1, TM3) and 11 (rank 7, TM4).
 * Threshold-passing pairs: 2-5 (+3.1), 14-11 (-2.5), 5-11 (+4.0, CFR to CFR), 17-18 (no CFR).
 * Below-threshold CFR contacts: 15-5 (+0.4), 12-11 (-0.2).
 */
function fixture({ withTouch = true } = {}) {
  const seq = 'ACDEFGHIKLMNPQRSTVWY';
  const seg = (p) => (p <= 8 ? 'TM3' : p <= 10 ? 'ICL2' : 'TM4');
  const cfr = { 5: 1, 11: 7 };
  const res = {
    length: 20,
    residue: (p) => (p >= 1 && p <= 20 ? {
      aa: seq[p - 1], segment: seg(p), generic: p <= 8 ? `3.${45 + p}x${45 + p}` : p >= 11 ? `4.${39 + p}x${39 + p}` : '',
      cfr: !!cfr[p], cfrRank: cfr[p] ?? (p === 6 ? 40 : null),
    } : null),
  };
  const det = {
    pairs: [
      { a: 5, b: 11, delta: 4.0, active: 6, inactive: 2 },
      { a: 2, b: 5, delta: 3.1, active: 3.1, inactive: 0 },
      { a: 14, b: 11, delta: -2.5, active: 1, inactive: 3.5 },
      { a: 17, b: 18, delta: 2.2, active: 3, inactive: 0.8 },
    ],
    cfrContacts: withTouch ? [{ a: 5, b: 15, delta: 0.4 }, { a: 11, b: 12, delta: -0.2 }] : null,
  };
  return { res, det };
}

describe('the four rules', () => {
  const { res, det } = fixture();
  const hood = cfrNeighbourhood(res, det);

  test('the CFR positions are the residues flagged cfr (top 30), with their rank', () => {
    assert.deepEqual(hood.cfr.map((c) => [c.pos, c.rank]), [[5, 1], [11, 7]]);
    assert.equal(hood.of(6).at, false, 'a ranked position below the top 30 is not at a CFR');
  });

  test('at: the CFR residue itself, which also lists its CFR partner', () => {
    const h = hood.of(5);
    assert.equal(h.group, 'at');
    assert.equal(h.rank, 1);
    assert.deepEqual(h.connected.map((c) => [c.pos, c.delta]), [[11, 4.0]], 'a CFR-CFR contact is listed on both');
    assert.deepEqual(hood.of(11).connected.map((c) => c.pos), [5], '14 is connected to CFR 11, not a CFR itself');
  });

  test('connected: an above-threshold contact whose partner is at a CFR position', () => {
    const h = hood.of(2);
    assert.equal(h.group, 'connected');
    assert.deepEqual(h.connected.map((c) => ({ pos: c.pos, rank: c.rank, delta: c.delta, a: c.a, b: c.b })), [{ pos: 5, rank: 1, delta: 3.1, a: 2, b: 5 }]);
    assert.equal(hood.of(14).group, 'connected', 'the pair is read in either order (14-11)');
    assert.equal(hood.of(14).connected[0].delta, -2.5, 'the signed ΔRRCS is kept');
    assert.equal(hood.of(17).group, null, 'a contact between two residues that are not CFRs connects nothing');
  });

  test('connected wins over near: residue 3 is two from CFR 5 and residue 2 is also three away', () => {
    assert.equal(hood.of(3).group, 'near');
    assert.equal(hood.of(2).group, 'connected');
    assert.deepEqual(hood.of(2).near, [], 'residue 2 is three residues from CFR 5');
  });

  test(`near: within ±${NEAR_SEQ} residues of a CFR position, in the same segment`, () => {
    assert.deepEqual(hood.of(3).near.map((c) => [c.pos, c.offset]), [[5, 2]]);
    assert.deepEqual(hood.of(4).near.map((c) => [c.pos, c.offset]), [[5, 1]]);
    assert.deepEqual(hood.of(6).near.map((c) => [c.pos, c.offset]), [[5, -1]]);
    assert.deepEqual(hood.of(7).near.map((c) => [c.pos, c.offset]), [[5, -2]]);
    assert.equal(hood.of(8).group, null, 'three residues away is not near');
    assert.equal(hood.of(13).group, 'near');
  });

  test('near: a CFR two residues away across a segment boundary does not count', () => {
    // residue 9 and 10 are ICL2; CFR 11 is TM4, one and two residues on
    assert.deepEqual(hood.of(10).near, []);
    assert.deepEqual(hood.of(9).near, []);
    assert.equal(hood.of(10).group, null);
  });

  test('touch: a below-threshold modelled contact with a CFR residue, last in precedence', () => {
    assert.equal(hood.of(15).group, 'touch');
    assert.deepEqual(hood.of(15).touch.map((c) => [c.pos, c.delta]), [[5, 0.4]]);
    assert.equal(hood.of(12).group, 'near', 'near beats touch (12 is one from CFR 11 and touches it)');
    assert.deepEqual(hood.of(12).touch.map((c) => c.pos), [11]);
  });

  test('without the below-threshold contacts in the index, touch is unknown (null), never empty', () => {
    const f = fixture({ withTouch: false });
    const h2 = cfrNeighbourhood(f.res, f.det);
    assert.equal(h2.hasTouch, false);
    assert.equal(h2.of(15).touch, null);
    assert.equal(h2.of(15).group, null);
  });

  test('every residue has at most one group, in the precedence order', () => {
    for (let p = 1; p <= 20; p++) {
      const h = hood.of(p);
      assert.ok(h.group === null || CFR_GROUPS.includes(h.group));
      if (h.at) assert.equal(h.group, 'at');
      else if (h.connected.length) assert.equal(h.group, 'connected');
      else if (h.near.length) assert.equal(h.group, 'near');
    }
    assert.equal(hood.of(0), null);
    assert.equal(hood.of(21), null);
  });
});

describe('the variant rows', () => {
  const { res, det } = fixture();
  const hood = cfrNeighbourhood(res, det);
  const allele = (pos, ref, alt, id, am = 0.5, amClass = 'ambiguous') => ({ pos, ref, alt, id, af: 1e-5, ac: 1, an: 1e5, am, amClass, rsids: [] });
  const vars = {
    alleles: [allele(5, 'F', 'L', 'a5K'), allele(2, 'C', 'Y', 'a2Y', null, null), allele(8, 'I', 'T', 'a8R'), allele(3, 'D', 'N', 'a3N'), allele(15, 'R', 'W', 'a15W')],
    clinvar: [
      { variationId: 1, pos: 5, ref: 'F', alt: 'L', kind: 'missense', gnomadId: 'a5K', classification: 'Likely pathogenic', stars: 1 },
      { variationId: 2, pos: 4, ref: 'E', alt: 'L', kind: 'missense', gnomadId: null, classification: 'Uncertain significance', stars: 1 },
      { variationId: 3, pos: 6, ref: 'G', alt: '=', kind: 'synonymous', gnomadId: null, classification: 'Benign', stars: 2 },
      { variationId: 4, pos: 9, ref: 'K', alt: 'E', kind: 'missense', gnomadId: null, classification: 'Pathogenic', stars: 2 },
      { variationId: 5, pos: null, ref: null, alt: null, kind: 'noncoding', gnomadId: null, classification: 'Benign', stars: 1 },
    ],
  };
  const amAt = (pos) => (pos === 2 ? { Y: { am: 0.91, amClass: 'pathogenic' } } : pos === 4 ? { L: { am: 0.2, amClass: 'benign' } } : null);
  const { rows, skipped } = cfrVariantRows(hood, vars, amAt);

  test('one row per gnomAD allele in a group, ClinVar records joined by gnomAD id', () => {
    const r5 = rows.find((r) => r.pos === 5);
    assert.equal(r5.group, 'at');
    assert.deepEqual(r5.clinvar.map((c) => c.variationId), [1]);
    assert.equal(rows.filter((r) => r.clinvar.some((c) => c.variationId === 1)).length, 1, 'the joined record has no row of its own');
    assert.ok(!rows.some((r) => r.pos === 8), 'residue 8 is in no group');
  });

  test('a ClinVar missense record without a gnomAD allele has its own row; other kinds are only counted', () => {
    const r4 = rows.filter((r) => r.pos === 4);
    assert.equal(r4.length, 1);
    assert.equal(r4[0].allele, null);
    assert.equal(r4[0].group, 'near');
    assert.deepEqual([r4[0].am, r4[0].amClass], [0.2, 'benign'], 'AlphaMissense from the per-residue table');
    assert.equal(skipped, 1, 'the synonymous record at residue 6');
    assert.ok(!rows.some((r) => r.pos === 9), 'residue 9 (ICL2) is in no group, so its record is not listed');
  });

  test('an allele without its own score takes the per-residue table score', () => {
    const r2 = rows.find((r) => r.pos === 2);
    assert.deepEqual([r2.group, r2.am, r2.amClass], ['connected', 0.91, 'pathogenic']);
  });

  test('rows run in group order, then residue', () => {
    assert.deepEqual(rows.map((r) => `${r.group}:${r.pos}`), ['at:5', 'connected:2', 'near:3', 'near:4', 'touch:15']);
  });

  test('P/LP is "Pathogenic" or "Likely pathogenic", not conflicting', () => {
    assert.ok(isPlp({ classification: 'Likely pathogenic' }));
    assert.ok(isPlp({ classification: 'Pathogenic/Likely pathogenic' }));
    assert.ok(!isPlp({ classification: 'Conflicting classifications of pathogenicity' }));
    assert.ok(!isPlp({ classification: 'Uncertain significance' }));
  });

  test('no shard, no rows', () => {
    assert.deepEqual(cfrVariantRows(hood, null), { rows: [], skipped: 0 });
  });
});
