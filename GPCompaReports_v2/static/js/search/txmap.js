/**
 * Search v2: transcript coordinate maps (pure, no DOM, no network). Mirrors
 * website/page_generators/search_index_v2.py (make_tx, c_to_g, g_to_c), which the Python tests check
 * against every gnomAD allele.
 *
 * A transcript record from `transcripts/<gid>.json`:
 *   {id, v, src: 'ensembl'|'refseq'|'uniprot', asm: 'GRCh38'|'GRCh37', chrom, strand: 1|-1,
 *    ex: [[lo, hi], ...] ascending genomic exons, cds: [[gLo, gHi, cStart, cEnd], ...] by c.,
 *    p?, pv?, mane?, canon?, frame?: 'gnomad', map?: ['='] | ['+', offset] | ['b', [[txStart, modelStart, n]]]}
 *
 * c. positions follow HGVS: CDS 1..L ('cds'), `c.-n` ('5utr', pos -n), `c.*n` ('3utr', pos n), and an
 * intronic offset from the nearest exon edge (`c.477+1`: pos 477, offset 1).
 *
 * @module search/txmap
 */

/** Genomic position of CDS base `c` inside segment `s`. */
function segG(tx, s, c) {
  return tx.strand === 1 ? s[0] + (c - s[2]) : s[1] - (c - s[2]);
}

/** CDS length (stop codon included). */
export function cdsLength(tx) {
  return tx.cds.length ? tx.cds[tx.cds.length - 1][3] : 0;
}

/** Exons in transcript order with transcript coordinates: [[lo, hi, tStart], ...]. */
function txExons(tx) {
  if (tx._tex) return tx._tex;
  const ex = tx.strand === 1 ? tx.ex : [...tx.ex].reverse();
  const out = [];
  let t = 1;
  for (const [a, b] of ex) { out.push([a, b, t]); t += b - a + 1; }
  Object.defineProperty(tx, '_tex', { value: out, enumerable: false });
  return out;
}

function gToT(tx, g) {
  for (const [a, b, t] of txExons(tx)) if (a <= g && g <= b) return t + (tx.strand === 1 ? g - a : b - g);
  return null;
}

function tToG(tx, t) {
  for (const [a, b, t0] of txExons(tx)) {
    const n = b - a + 1;
    if (t0 <= t && t < t0 + n) return tx.strand === 1 ? a + (t - t0) : b - (t - t0);
  }
  return null;
}

/**
 * c. position to genomic position on the transcript's own assembly.
 *
 * @param {object} tx transcript record
 * @param {number} pos c. position (negative for 5'UTR, positive with region '3utr' for c.*n)
 * @param {number} [offset] intronic offset (c.477+1 -> 1)
 * @param {string} [region] 'cds' | 'intron' | '5utr' | '3utr'
 * @returns {number|null}
 */
export function cToG(tx, pos, offset = 0, region = 'cds') {
  if (!tx.cds.length) return null;
  const L = cdsLength(tx);
  let g = null;
  if (region === 'cds' || region === 'intron') {
    if (pos < 1 || pos > L) return null;
    for (const s of tx.cds) if (s[2] <= pos && pos <= s[3]) { g = segG(tx, s, pos); break; }
  } else if (region === '5utr') {
    const t1 = gToT(tx, segG(tx, tx.cds[0], 1));
    g = t1 === null ? null : tToG(tx, t1 + pos);
  } else if (region === '3utr') {
    const tl = gToT(tx, segG(tx, tx.cds[tx.cds.length - 1], L));
    g = tl === null ? null : tToG(tx, tl + pos);
  }
  return g === null ? null : g + (offset || 0) * tx.strand;
}

function exonicC(tx, g) {
  for (const s of tx.cds) {
    if (s[0] <= g && g <= s[1]) return { pos: s[2] + (tx.strand === 1 ? g - s[0] : s[1] - g), region: 'cds' };
  }
  const t = gToT(tx, g);
  if (t === null) return null;
  const t1 = gToT(tx, segG(tx, tx.cds[0], 1));
  const tl = gToT(tx, segG(tx, tx.cds[tx.cds.length - 1], cdsLength(tx)));
  if (t1 !== null && t < t1) return { pos: t - t1, region: '5utr' };
  if (tl !== null && t > tl) return { pos: t - tl, region: '3utr' };
  return null;
}

/**
 * Genomic position to c. on this transcript: {pos, offset, region} or null outside the transcript.
 * region is 'cds', '5utr', '3utr' or 'intron' (then `edgeRegion` says where the nearest exon edge is).
 */
export function gToC(tx, g) {
  if (!tx.cds.length) return null;
  const hit = exonicC(tx, g);
  if (hit) return { ...hit, offset: 0 };
  const ex = tx.ex;
  if (g < ex[0][0] || g > ex[ex.length - 1][1]) return null;
  for (let i = 0; i + 1 < ex.length; i++) {
    const b1 = ex[i][1]; const a2 = ex[i + 1][0];
    if (b1 < g && g < a2) {
      const dl = g - b1; const dr = a2 - g;
      let edge; let dist;
      if (dl < dr) { edge = b1; dist = dl; } else if (dr < dl) { edge = a2; dist = dr; } else if (tx.strand === 1) { edge = b1; dist = dl; } else { edge = a2; dist = dr; }
      const e = exonicC(tx, edge);
      if (!e) return null;
      const sign = (g > edge) === (tx.strand === 1) ? 1 : -1;
      return { pos: e.pos, region: e.region === 'cds' ? 'intron' : e.region, offset: sign * dist, edgeRegion: e.region };
    }
  }
  return null;
}

/** HGVS text for a c. position object: 477, 477+1, -23, *45, -15+3. */
export function cText(c) {
  if (!c) return '';
  const base = c.region === '3utr' || c.edgeRegion === '3utr' ? `*${c.pos}` : `${c.pos}`;
  const off = c.offset ? (c.offset > 0 ? `+${c.offset}` : `${c.offset}`) : '';
  return base + off;
}

/** Protein position through a compact map (['='], ['+', off], ['b', blocks]); null when unaligned. */
export function mapPos(m, p) {
  if (!m || p === null || p === undefined) return null;
  if (m[0] === '=') return p;
  if (m[0] === '+') return p + m[1];
  if (m[0] === 'b') for (const [ts, ms, n] of m[1]) if (ts <= p && p < ts + n) return ms + (p - ts);
  return null;
}

/** Model position back to the transcript's protein position; null when the model residue has none. */
export function unmapPos(m, q) {
  if (!m || q === null || q === undefined) return null;
  if (m[0] === '=') return q;
  if (m[0] === '+') return q - m[1];
  if (m[0] === 'b') for (const [ts, ms, n] of m[1]) if (ms <= q && q < ms + n) return ts + (q - ms);
  return null;
}

// ------------------------------------------------------------------------------- GRCh37 lift

function lift1(b, g) {
  if (g < b[0] || g > b[1]) return null;
  return b[4] === 1 ? b[2] + (g - b[0]) : b[3] - (g - b[0]);
}

/**
 * GRCh38 -> GRCh37 through the gene's blocks [o38Lo, o38Hi, m37Lo, m37Hi, strand, chrom37].
 * Exact inside a block; otherwise the nearest block's offset within `maxGap` bases, flagged approximate.
 *
 * @returns {{chrom: string, pos: number, strand: number, approximate: boolean}|null}
 */
export function lift38to37(lift, g, maxGap = 200000) {
  let best = null;
  for (const b of lift ?? []) {
    const p = lift1(b, g);
    if (p !== null) return { chrom: b[5], pos: p, strand: b[4], approximate: false };
    const d = g < b[0] ? b[0] - g : g - b[1];
    if (b[4] === 1 && d <= maxGap && (!best || d < best.d)) best = { b, d };
  }
  if (!best) return null;
  return { chrom: best.b[5], pos: best.b[2] + (g - best.b[0]), strand: 1, approximate: true };
}

/** GRCh37 -> GRCh38 through the same blocks (inverse). */
export function lift37to38(lift, chrom37, g, maxGap = 200000) {
  let best = null;
  for (const b of lift ?? []) {
    if (String(b[5]) !== String(chrom37)) continue;
    if (b[2] <= g && g <= b[3]) {
      const p = b[4] === 1 ? b[0] + (g - b[2]) : b[0] + (b[3] - g);
      return { pos: p, strand: b[4], approximate: false };
    }
    const d = g < b[2] ? b[2] - g : g - b[3];
    if (b[4] === 1 && d <= maxGap && (!best || d < best.d)) best = { b, d };
  }
  if (!best) return null;
  return { pos: best.b[0] + (g - best.b[2]), strand: 1, approximate: true };
}

// ------------------------------------------------------------------------------- bases, codons

const COMP = { A: 'T', C: 'G', G: 'C', T: 'A', N: 'N' };
export const complement = (s) => [...s].map((c) => COMP[c] ?? 'N').join('');

/** GRCh38 plus-strand base from a `cds/<gid>.json` shard, or null when not stored. */
export function baseAt(bases, g) {
  if (!bases) return null;
  const iv = bases.iv;
  let lo = 0; let hi = iv.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [s, b] = iv[mid];
    if (g < s) hi = mid - 1;
    else if (g >= s + b.length) lo = mid + 1;
    else return b[g - s];
  }
  return null;
}

const CODONS = (() => {
  const b = 'TCAG';
  const aas = 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG';
  const m = {};
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) m[b[i] + b[j] + b[k]] = aas[i * 16 + j * 4 + k];
  return m;
})();

/** One-letter amino acid of a codon ('*' stop), null for unknown bases. */
export const translate = (codon) => CODONS[codon] ?? null;

/**
 * The codon of transcript residue `aaPos` on GRCh38: {g: [3 genomic positions], codon} (transcript
 * strand). `codon` is null when a base is not stored. `toG38` converts the transcript's own genomic
 * coordinates to GRCh38 (identity for GRCh38 transcripts); `strand38` is the transcript's strand on
 * GRCh38 (differs from tx.strand only for GRCh37 transcripts in an inverted region).
 */
export function codonAt(tx, aaPos, bases, toG38 = (g) => g, strand38 = tx.strand) {
  const gs = [];
  let codon = '';
  for (let k = 0; k < 3; k++) {
    const g0 = cToG(tx, 3 * aaPos - 2 + k);
    const g = g0 === null ? null : toG38(g0);
    gs.push(g);
    const b = g === null ? null : baseAt(bases, g);
    codon = codon === null || b === null ? null : codon + (strand38 === 1 ? b : COMP[b]);
  }
  return { g: gs, codon };
}
