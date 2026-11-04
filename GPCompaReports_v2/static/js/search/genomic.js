/**
 * Search v2: genomic notations (pure, no DOM, no network).
 *
 * Reads gnomAD-style ids with any separator (`5-76833084-G-A`, `chr5:76833084:G:A`, `chr5_76833084_G_A`,
 * `5:76833084 G>A`), VCF rows (`5 76833084 . G A`, tabs or spaces, extra columns allowed), HGVS g.
 * (`NC_000005.10:g.76833084G>A`, `chr5:g.76833084G>A`), SPDI (`NC_000005.10:76833083:G:A`, 0-based, read
 * as 1-based), positions (`chr5:76833084`, `5:76,833,084`) and ranges (`chr5:76833084-76833090`).
 * Chromosomes 1-22, X, Y, MT, and PLINK codes 23 (X), 24 (Y), 25 (X, pseudo-autosomal) and 26 (MT).
 *
 * The assembly is only reported when the input says it (`NC_000005.9` is GRCh37, `NC_000005.10` is
 * GRCh38, or a label such as `hg19`); otherwise `assemblyHint` is null and the resolver decides from
 * the gene windows.
 *
 * @module search/genomic
 */

import { readOp } from './notation.js';

/** RefSeq chromosome accession versions per assembly: index 0 = chr1 ... 21 = chr22, 22 = X, 23 = Y. */
const NC_GRCH38 = [11, 12, 12, 12, 10, 12, 14, 11, 12, 11, 10, 12, 11, 9, 10, 10, 11, 10, 10, 11, 9, 11, 11, 10];
const NC_GRCH37 = NC_GRCH38.map((v) => v - 1);

/**
 * Chromosome and assembly of a RefSeq chromosome accession.
 *
 * @param {string} acc e.g. 'NC_000005.10' or 'NC_000005'
 * @returns {null | {chrom: string, assembly: 'GRCh38'|'GRCh37'|null, accession: string, version: number|null}}
 */
export function ncToChrom(acc) {
  const m = /^NC_0*(\d+)(?:\.(\d+))?$/i.exec(acc.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const version = m[2] ? Number(m[2]) : null;
  const accession = `NC_${m[1].padStart(6, '0')}`;
  if (n === 12920) return { chrom: 'MT', assembly: null, accession, version };
  if (n < 1 || n > 24) return null;
  const chrom = n === 23 ? 'X' : n === 24 ? 'Y' : String(n);
  let assembly = null;
  if (version === NC_GRCH38[n - 1]) assembly = 'GRCh38';
  else if (version === NC_GRCH37[n - 1]) assembly = 'GRCh37';
  return { chrom, assembly, accession, version };
}

/** A typed chromosome ('chr5', '5', 'X', '23', 'chrMT') as gnomAD writes it, or null. */
export function chromOf(tok) {
  const t = tok.replace(/^chr/i, '').toUpperCase();
  if (/^(?:[1-9]|1\d|2[0-2])$/.test(t)) return { chrom: t };
  if (t === 'X' || t === 'Y') return { chrom: t };
  if (t === 'M' || t === 'MT') return { chrom: 'MT' };
  if (t === '23' || t === '25') return { chrom: 'X', chromCode: t };
  if (t === '24') return { chrom: 'Y', chromCode: t };
  if (t === '26') return { chrom: 'MT', chromCode: t };
  return null;
}

const LABEL = '(grch3[78](?:\\.p\\d+)?|hg19|hg38|b37|b38|hs37d5)';
const LABEL_FIRST = new RegExp(`^\\(?${LABEL}\\)?\\s*[:,]?\\s+(.+)$`, 'i');
const LABEL_LAST = new RegExp(`^(.+?)[\\s,]+\\(?${LABEL}\\)?$`, 'i');

/**
 * Pull an assembly label off either end of the query: `GRCh38 5:76833084 G>A`, `hg19 chr5:...`,
 * `5-76128909-G-A (GRCh37)`.
 *
 * @param {string} s
 * @returns {{text: string, assembly: 'GRCh37'|'GRCh38'|null, label: string|null}}
 */
export function extractAssembly(s) {
  let label = null; let text = s;
  let m = LABEL_FIRST.exec(s);
  if (m) [label, text] = [m[1], m[2]];
  else if ((m = LABEL_LAST.exec(s))) [label, text] = [m[2], m[1]];
  if (!label) return { text: s, assembly: null, label: null };
  return { text: text.trim(), assembly: /37|19|hs37/i.test(label) ? 'GRCh37' : 'GRCh38', label };
}

const CHROM_CORE = '([0-9]{1,2}|X|Y|MT?)';
const CHROM = `(?:chr)?${CHROM_CORE}`;
const POS = '(\\d{1,3}(?:,\\d{3})+|\\d+)';
const BASES = '([ACGTN]+)';
const num = (s) => Number(s.replace(/,/g, ''));

function snv(c, pos, ref, alt, format, extra = {}) {
  if (!c || !(pos > 0)) return null;
  const g = { ...c, pos, format, assemblyHint: null, ...extra };
  if (ref != null) g.ref = ref.toUpperCase();
  if (alt != null) g.alt = alt.toUpperCase();
  return g;
}

/** The gnomAD id ('5-76833084-G-A') for a genomic object with ref and alt, else null. */
export function gnomadIdOf(g) {
  return g && g.ref && g.alt && !g.alts && /^[ACGTN]+$/.test(g.ref) && /^[ACGTN]+$/.test(g.alt)
    ? `${g.chrom}-${g.pos}-${g.ref}-${g.alt}` : null;
}

/**
 * A genomic notation.
 *
 * @param {string} s normalised query (an assembly label already removed)
 * @returns {null | {malformed: string} | {genomic: object, ids?: object}}
 *   genomic: {chrom, pos, end?, ref?, alt?, alts?, op?, inserted?, assemblyHint, accession?, version?,
 *   chromCode?, format: 'gnomad'|'vcf'|'hgvs_g'|'spdi'|'locus'|'range'}
 */
export function parseGenomic(s) {
  const t = s.trim();
  let m;

  // HGVS g. on a RefSeq chromosome or a chromosome name
  m = /^(NC_\d+(?:\.\d+)?)(?:\([^)]*\))?\s*:\s*g\.\s*(.*)$/i.exec(t) ?? new RegExp(`^${CHROM}\\s*:\\s*g\\.\\s*(.*)$`, 'i').exec(t);
  if (m) {
    const nc = /^NC_/i.test(m[1]) ? ncToChrom(m[1]) : null;
    const c = nc ? { chrom: nc.chrom } : chromOf(m[1]);
    if (!c) return { malformed: `unknown chromosome "${m[1]}"` };
    const b = /^(\d+)(?:_(\d+))?(.*)$/.exec(m[2]);
    if (!b) return { malformed: `cannot read the position in "${t}"` };
    const pos = Number(b[1]);
    const extra = nc ? { accession: nc.accession, version: nc.version } : {};
    if (b[2]) extra.end = Number(b[2]);
    let g;
    if (b[3] === '') g = snv(c, pos, null, null, 'hgvs_g', extra);
    else {
      const op = readOp(b[3]);
      if (!op) return { malformed: `cannot read the change "${b[3]}" in "${t}"` };
      g = snv(c, pos, op.op === 'sub' || op.op === 'delins' ? op.ref : null, op.op === 'sub' ? op.alt : null, 'hgvs_g', { ...extra, op: op.op });
      if (op.inserted) g.inserted = op.inserted;
    }
    if (!g) return { malformed: `cannot read "${t}"` };
    g.assemblyHint = nc ? nc.assembly : null;
    return withIds(g);
  }

  // SPDI: sequence:position(0-based):deletion:insertion
  m = /^(NC_\d+(?:\.\d+)?)\s*:\s*(\d+)\s*:\s*([ACGTN]*|\d+)\s*:\s*([ACGTN]*)$/i.exec(t);
  if (m) {
    const nc = ncToChrom(m[1]);
    if (!nc) return { malformed: `unknown sequence "${m[1]}"` };
    const del = /^\d+$/.test(m[3]) ? null : m[3].toUpperCase();
    const g = snv({ chrom: nc.chrom }, Number(m[2]) + 1, del || null, m[4] || null, 'spdi', { accession: nc.accession, version: nc.version });
    if (!g) return { malformed: `cannot read "${t}"` };
    if (/^\d+$/.test(m[3])) g.deletedLength = Number(m[3]);
    g.assemblyHint = nc.assembly;
    const out = withIds(g);
    out.ids = { ...(out.ids ?? {}), spdi: `${nc.accession}${nc.version ? `.${nc.version}` : ''}:${m[2]}:${m[3].toUpperCase()}:${m[4].toUpperCase()}` };
    return out;
  }

  // VCF row: CHROM POS ID REF ALT [QUAL FILTER INFO ...]
  const cols = t.split(' ');
  if (cols.length >= 5) {
    const c = chromOf(cols[0]);
    if (c && /^\d+$/.test(cols[1]) && /^[ACGTN]+$/i.test(cols[3]) && /^(?:[ACGTN]+|\*)(?:,(?:[ACGTN]+|\*))*$/i.test(cols[4])) {
      const alts = cols[4].toUpperCase().split(',');
      const g = snv(c, Number(cols[1]), cols[3], alts[0], 'vcf');
      if (g) {
        if (alts.length > 1) g.alts = alts;
        const out = withIds(g);
        if (/^rs\d+$/i.test(cols[2])) out.ids = { ...(out.ids ?? {}), rsid: cols[2].toLowerCase() };
        return out;
      }
    }
  }

  // gnomAD-style id with any separator
  m = new RegExp(`^${CHROM}\\s*[-:_ ]\\s*${POS}\\s*[-:_ ]\\s*${BASES}\\s*[-:_>/ ]\\s*${BASES}$`, 'i').exec(t);
  if (m) {
    const g = snv(chromOf(m[1]), num(m[2]), m[3], m[4], 'gnomad');
    if (!g) return { malformed: `unknown chromosome "${m[1]}"` };
    if (g.ref === g.alt) return { malformed: 'the reference and the alternate base are the same' };
    return withIds(g);
  }

  // a position or a range: needs ':' (or a 'chr' prefix) so '6 48' stays a generic number
  m = new RegExp(`^${CHROM}\\s*:\\s*${POS}(?:\\s*[-_]\\s*${POS})?$`, 'i').exec(t) ?? new RegExp(`^chr${CHROM_CORE}\\s*[-_ ]\\s*${POS}(?:\\s*[-_]\\s*${POS})?$`, 'i').exec(t);
  if (m) {
    const c = chromOf(m[1]);
    if (!c) return { malformed: `unknown chromosome "${m[1]}"` };
    const pos = num(m[2]);
    const end = m[3] ? num(m[3]) : null;
    if (!(pos > 0) || (end !== null && end < pos)) return { malformed: 'cannot read the position range' };
    const g = snv(c, pos, null, null, end !== null && end !== pos ? 'range' : 'locus');
    if (end !== null) g.end = end;
    return { genomic: g };
  }

  // looks like a genomic id but is incomplete ('5-76833084-G', 'chr5:')
  if (/^chr(?:[0-9]{1,2}|X|Y|MT?)?\b/i.test(t) || /^NC_\d/i.test(t) || /^(?:[0-9]{1,2}|X|Y)[-:_]\d{3,}/i.test(t)) {
    return { malformed: `cannot read "${t}" as a genomic position or variant` };
  }
  return null;
}

function withIds(g) {
  const id = gnomadIdOf(g);
  return id ? { genomic: g, ids: { gnomad: id } } : { genomic: g };
}
