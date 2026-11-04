/**
 * Search v2: readers for single notations (pure, no DOM, no network). Each reader takes one already
 * normalised fragment and returns a parsed object, `null` when the fragment is not that notation, or
 * `{ malformed: why }` when it clearly tries to be that notation but cannot be read (`p.Met159Xyz`,
 * `M0I`, `c.477G>`). `parse.js` combines them; genomic forms live in `genomic.js`.
 *
 * Covered here: protein changes (HGVS p. and legacy forms), residues, generic numbers (BW and GPCRdb),
 * coding/non-coding/RNA changes (c., n., r.), rsIDs, ClinVar ids and receptor identifiers.
 *
 * @module search/notation
 */

/** Three-letter amino-acid codes to one letter. */
export const THREE = Object.freeze({
  ala: 'A', arg: 'R', asn: 'N', asp: 'D', cys: 'C', gln: 'Q', glu: 'E', gly: 'G', his: 'H', ile: 'I',
  leu: 'L', lys: 'K', met: 'M', phe: 'F', pro: 'P', ser: 'S', thr: 'T', trp: 'W', tyr: 'Y', val: 'V',
});
const ONE = 'ACDEFGHIKLMNPQRSTVWY';
const ONE_TO_THREE = Object.freeze(Object.fromEntries(Object.entries(THREE).map(([k, v]) => [v, k[0].toUpperCase() + k.slice(1)])));

/** 'M' or 'Met' (any case) to 'M'; null for anything else, stops included. */
export function aaOne(tok) {
  if (!tok) return null;
  if (tok.length === 1) return ONE.includes(tok.toUpperCase()) ? tok.toUpperCase() : null;
  return THREE[tok.toLowerCase()] ?? null;
}

/** Like aaOne, but 'Ter', '*', 'X' and 'Stop' read as the stop '*'. */
export function aaOrStop(tok) {
  if (!tok) return null;
  if (/^(?:ter|\*|x|stop)$/i.test(tok)) return '*';
  return aaOne(tok);
}

/** 'M' -> 'Met', '*' -> 'Ter'. */
export const aaThree = (one) => (one === '*' ? 'Ter' : ONE_TO_THREE[one] ?? one);

/** A positive integer with no leading zero, at most `max` digits; null otherwise. */
function posInt(s, max = 5) {
  if (!/^[1-9]\d*$/.test(s) || s.length > max) return null;
  return Number(s);
}

/** Read an amino-acid run ('HisGly', 'HG', 'Ter', '*') into one-letter codes, or null. */
function aaSeq(s) {
  if (!s) return null;
  if (/^(?:ter|\*|x)$/i.test(s)) return '*';
  if (s.length % 3 === 0 && /^[a-z]+$/i.test(s)) {
    const out = [];
    for (let i = 0; i < s.length; i += 3) {
      const a = aaOrStop(s.slice(i, i + 3));
      if (!a) { out.length = 0; break; }
      out.push(a);
    }
    if (out.length) return out.join('');
  }
  if (/^[a-z*]+$/i.test(s) && [...s].every((c) => aaOrStop(c))) return [...s].map((c) => aaOrStop(c)).join('');
  if (/^\d+$/.test(s)) return s; // a length ('ins5')
  return null;
}

const AA = '(\\*|[A-Za-z]{3}|[A-Za-z])';

/**
 * A protein change or residue. Accepts `p.Met159Ile`, `p.M159I`, `p.(Met159Ile)`, `Met159Ile`, `M159I`,
 * `P.MET159ILE`, `Met-159-Ile`, `M159>I` (and arrows, normalised to '>'), `159M>I`, stops (`Ter`, `*`,
 * `X`), `=`, `fs` (`Met159ProfsTer12`, `Leu211fs`), `del`, `dup`, `ins`, `delins`, ranges
 * (`Met159_Tyr160insHis`), `ext` and `Met1?`; residue only: `M159`, `Met159`, `p.Met159`.
 *
 * @param {string} s one fragment
 * @returns {null | {malformed: string} | {ref: string|null, pos: number, alt: string|null, kind: string,
 *   hgvsPrefix: boolean, end?: {ref: string, pos: number}, inserted?: string, newAa?: string, fsTer?: string,
 *   ext?: string}}
 *   `alt` is the one-letter residue for missense, else the class token: '*', '=', 'fs', 'del', 'dup',
 *   'ins', 'delins', 'ext', '?' (start); null for a residue.
 */
export function parseProtein(s) {
  let t = s.trim();
  const hgvsPrefix = /^p\.\s*/i.test(t);
  if (hgvsPrefix) t = t.replace(/^p\.\s*/i, '');
  if (/^\(.*\)$/.test(t)) t = t.slice(1, -1).trim();
  const bad = (why) => (hgvsPrefix ? { malformed: why } : null);
  if (!t) return bad('nothing after "p."');

  let m = /^(\d+)\s*([A-Za-z]{3}|[A-Za-z])\s*>\s*([A-Za-z]{3}|[A-Za-z]|\*)$/.exec(t); // 159M>I
  if (m) return single(m[2], m[1], m[3], hgvsPrefix);
  m = new RegExp(`^${AA}(\\d+)\\s*>\\s*([A-Za-z]{3}|[A-Za-z]|\\*)$`).exec(t); // M159>I
  if (m) return single(m[1], m[2], m[3], hgvsPrefix);
  m = new RegExp(`^${AA}-(\\d+)-([A-Za-z]{3}|[A-Za-z]|\\*|=)$`).exec(t); // Met-159-Ile
  if (m) return single(m[1], m[2], m[3], hgvsPrefix);

  m = new RegExp(`^${AA}(\\d+)_${AA}(\\d+)(delins|del|dup|ins)([A-Za-z*]*|\\d*)$`, 'i').exec(t); // ranges
  if (m) {
    const ref = aaOrStop(m[1]); const pos = posInt(m[2]); const ref2 = aaOrStop(m[3]); const pos2 = posInt(m[4]);
    const op = m[5].toLowerCase();
    if (!ref || !pos || !ref2 || !pos2 || pos2 <= pos) return bad(`cannot read the range "${t}"`);
    const out = { ref, pos, alt: op, kind: 'indel', hgvsPrefix, end: { ref: ref2, pos: pos2 } };
    if (op === 'ins' || op === 'delins') {
      const ins = aaSeq(m[6]);
      if (!ins) return bad(`cannot read the inserted residues "${m[6]}"`);
      out.inserted = ins;
    } else if (m[6] && !/^\d+$/.test(m[6])) return bad(`cannot read "${m[6]}" after ${op}`);
    return out;
  }

  m = new RegExp(`^${AA}(\\d+)(.*)$`).exec(t);
  if (!m) return bad(`cannot read "${t}" as a protein change`);
  const refTok = m[1];
  const ref = aaOrStop(refTok);
  if (!ref) return bad(`"${refTok}" is not an amino acid`);
  if (/^0+$/.test(m[2])) return { malformed: 'residue numbers start at 1' };
  const pos = posInt(m[2]);
  if (!pos) return bad(`cannot read the residue number "${m[2]}"`);
  const rest = m[3];
  const r = restOf(ref, pos, rest, hgvsPrefix);
  if (r) return r;
  // a three-letter start that fails ('Met159Xyz') is an attempt at a change, not a gene symbol
  if (hgvsPrefix || (refTok.length === 3 && /^[A-Za-z]{1,4}$/.test(rest))) return { malformed: `cannot read "${rest}" in "${t}"` };
  return null;
}

/** One residue then what happens to it (already split). */
function single(refTok, posTok, altTok, hgvsPrefix) {
  const ref = aaOrStop(refTok);
  const pos = posInt(posTok);
  if (!ref || ref === '*') return hgvsPrefix ? { malformed: `"${refTok}" is not an amino acid` } : null;
  if (!pos) return /^0+$/.test(posTok) ? { malformed: 'residue numbers start at 1' } : null;
  return restOf(ref, pos, altTok, hgvsPrefix) ?? (hgvsPrefix || refTok.length === 3 ? { malformed: `cannot read "${altTok}"` } : null);
}

/** The part after `Met159`: '', an amino acid, '=', '?', del, dup, fs, delins, ext. */
function restOf(ref, pos, rest, hgvsPrefix) {
  const base = { ref, pos, hgvsPrefix };
  if (rest === '') return ref === '*' ? null : { ...base, alt: null, kind: 'residue' };
  if (rest === '=') return { ...base, alt: '=', kind: 'synonymous' };
  if (rest === '?') return pos === 1 && ref === 'M' ? { ...base, alt: '?', kind: 'start' } : null;
  let m = /^([A-Za-z]{3}|[A-Za-z]|\*|stop)$/i.exec(rest);
  const alt = m ? aaOrStop(m[1]) : null;
  if (alt) {
    if (ref === '*') return { ...base, alt: 'ext', kind: 'ext', newAa: alt };
    if (alt === '*') return { ...base, alt: '*', kind: 'stop' };
    if (alt === ref) return { ...base, alt: '=', kind: 'synonymous' };
    return { ...base, alt, kind: 'missense' };
  }
  if (/^del$/i.test(rest)) return { ...base, alt: 'del', kind: 'indel' };
  if (/^dup$/i.test(rest)) return { ...base, alt: 'dup', kind: 'indel' };
  m = /^([A-Za-z]{3}|[A-Za-z])?fs(?:(?:ter|\*|x)(\d+|\?))?$/i.exec(rest);
  if (m) {
    const out = { ...base, alt: 'fs', kind: 'frameshift' };
    if (m[1]) { const a = aaOrStop(m[1]); if (!a) return null; out.newAa = a; }
    if (m[2]) out.fsTer = m[2];
    return out;
  }
  m = /^delins([A-Za-z*]+)$/i.exec(rest);
  if (m) { const ins = aaSeq(m[1]); return ins ? { ...base, alt: 'delins', kind: 'indel', inserted: ins } : null; }
  m = /^ins([A-Za-z*]+)$/i.exec(rest);
  if (m) { const ins = aaSeq(m[1]); return ins ? { ...base, alt: 'ins', kind: 'indel', inserted: ins } : null; }
  m = /^([A-Za-z]{3}|[A-Za-z])?ext(.*)$/i.exec(rest);
  if (m) {
    const out = { ...base, alt: 'ext', kind: 'ext' };
    if (m[1]) { const a = aaOrStop(m[1]); if (!a) return null; out.newAa = a; }
    if (m[2]) out.ext = m[2];
    return out;
  }
  return null;
}

// ---------------------------------------------------------------------------------- generic numbers

const LOOPS = Object.freeze({ icl1: '12', ecl1: '23', icl2: '34', ecl2: '45', icl3: '56', ecl3: '67' });
const SEGMENTS = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '12', '23', '34', '45', '56', '67']);
const GN = '(?:(TM|ECL|ICL)\\s*)?(\\d{1,2})(?:\\.(\\d{1,3}))?(?:x(\\d{1,3}))?';

/** Build the generic object from GN regex groups, or null. */
function genericOf(prefix, seg, bw, x) {
  if (bw === undefined && x === undefined) return null;
  let segment = seg;
  if (prefix) {
    const p = prefix.toLowerCase();
    if (p === 'tm') { if (!/^[1-7]$/.test(seg)) return null; } else {
      segment = LOOPS[`${p}${seg}`];
      if (!segment) return null;
    }
  }
  segment = String(Number(segment));
  if (!SEGMENTS.has(segment)) return null;
  const out = {
    segment,
    bw: bw !== undefined ? `${segment}.${bw}` : null,
    gpcrdb: x !== undefined ? `${segment}x${x}` : null,
    display: '',
    form: bw !== undefined && x !== undefined ? 'both' : bw !== undefined ? 'dot' : 'x',
  };
  out.display = out.form === 'both' ? `${out.bw}x${x}` : out.bw ?? out.gpcrdb;
  if ((bw ?? x).length < 2) out.partial = true;
  return out;
}

/**
 * A generic residue number: `3.50`, `3x50`, `3.50x50`, `45.50`, `ECL2.50`, `TM3.50`, `8x50`, with or
 * without a residue: `R3.50`, `R^3.50`, `R^{3.50}`, `Arg131(3.50)`, `R131^3.50`, `F6.48`. `H1` is never
 * helix 1 (it is HRH1).
 *
 * @param {string} s
 * @returns {null | {segment: string, bw: string|null, gpcrdb: string|null, display: string,
 *   form: 'dot'|'x'|'both'|'space', residueLetter?: string, residueNumber?: number, partial?: true}}
 */
export function parseGeneric(s) {
  const t = s.trim();
  let m = new RegExp(`^${GN}$`, 'i').exec(t);
  if (m) return genericOf(m[1], m[2], m[3], m[4]);
  m = new RegExp(`^([A-Za-z]{3}|[A-Za-z])(\\d+)?\\s*(?:\\^\\s*\\{?|\\(|\\[)\\s*${GN}\\s*[})\\]]?$`, 'i').exec(t);
  if (!m) m = new RegExp(`^([A-Za-z]{3}|[A-Za-z])()${GN}$`, 'i').exec(t);
  if (!m) return null;
  const letter = aaOne(m[1]);
  if (!letter) return null;
  const g = genericOf(m[3], m[4], m[5], m[6]);
  if (!g) return null;
  g.residueLetter = letter;
  if (m[2]) { const n = posInt(m[2]); if (!n) return null; g.residueNumber = n; }
  return g;
}

/** `6 48`: a generic number typed with a space (TM 1-8 then a two- or three-digit position). */
export function parseGenericSpaced(s) {
  const m = /^([1-8])\s+(\d{2,3})$/.exec(s.trim());
  if (!m) return null;
  return { segment: m[1], bw: `${m[1]}.${m[2]}`, gpcrdb: null, display: `${m[1]}.${m[2]}`, form: 'space' };
}

// ------------------------------------------------------------------------------- c. / n. / r. changes

const NT = '[ACGTUN]';
const CPOS = '([-*]?)(\\d+)(?:([+-])(\\d+))?';

/** Read a c./n./r. position from regex groups. */
function cpos(sign, num, osign, onum) {
  const n = Number(num);
  if (!Number.isInteger(n) || (n === 0 && !onum)) return null;
  const out = { pos: sign === '-' ? -n : n, region: sign === '-' ? '5utr' : sign === '*' ? '3utr' : 'cds' };
  if (onum) { out.offset = osign === '-' ? -Number(onum) : Number(onum); out.region = 'intron'; }
  return out;
}

/**
 * A c., n. or r. change, with the prefix: `c.477G>A`, `C.477g>a`, `c.477+1G>A`, `c.-23C>T`, `c.*45G>A`,
 * `c.79=`, `c.549dup`, `c.631_634del`, `c.404_405delinsTT`, `c.789CTG[1]`, `n.123A>G`, `r.477g>a`.
 * Positions keep their sign: `c.-23` is pos -23 in region '5utr', `c.*45` is pos 45 in region '3utr',
 * `c.477+1` is pos 477, offset +1, region 'intron'.
 *
 * @param {string} s
 * @returns {null | {malformed: string} | {coord: 'c'|'n'|'r', pos: number, offset?: number, region: string,
 *   end?: {pos: number, offset?: number, region: string}, op: string, ref: string|null, alt: string|null,
 *   inserted?: string, repeat?: {unit: string, count: number}}}
 */
export function parseCoding(s) {
  const t = s.trim();
  const pm = /^([cnr])\.\s*(.*)$/i.exec(t);
  if (!pm) return null;
  const coord = pm[1].toLowerCase();
  const body = pm[2];
  const m = new RegExp(`^${CPOS}(?:_${CPOS})?(.*)$`, 'i').exec(body);
  if (!m) return { malformed: `cannot read the position in "${t}"` };
  const start = cpos(m[1], m[2], m[3], m[4]);
  if (!start) return { malformed: `cannot read the position in "${t}"` };
  const out = { coord, ...start };
  if (m[6]) {
    const end = cpos(m[5], m[6], m[7], m[8]);
    if (!end) return { malformed: `cannot read the range in "${t}"` };
    out.end = end;
  }
  const op = readOp(m[9]);
  if (!op) return { malformed: `cannot read the change "${m[9] || '(missing)'}" in "${t}"` };
  if (op.op === 'sub' && out.end) return { malformed: 'a substitution names one position, not a range' };
  return { ...out, ...op };
}

/** The operation after a c./g. position. */
export function readOp(rest) {
  const r = rest.trim();
  let m = new RegExp(`^(${NT})>(${NT})$`, 'i').exec(r);
  if (m) {
    const ref = m[1].toUpperCase(); const alt = m[2].toUpperCase();
    return ref === alt ? null : { op: 'sub', ref, alt };
  }
  if (r === '=') return { op: '=', ref: null, alt: null };
  m = new RegExp(`^(del|dup|inv)(${NT}+|\\d+)?$`, 'i').exec(r);
  if (m) return { op: m[1].toLowerCase(), ref: m[2] && /\D/.test(m[2]) ? m[2].toUpperCase() : null, alt: null };
  m = new RegExp(`^(delins|ins)(${NT}+|\\d+|\\(\\d+\\))$`, 'i').exec(r);
  if (m) return { op: m[1].toLowerCase(), ref: null, alt: null, inserted: m[2].toUpperCase() };
  m = new RegExp(`^(${NT}+)\\[(\\d+)\\]$`, 'i').exec(r);
  if (m) return { op: 'repeat', ref: null, alt: null, repeat: { unit: m[1].toUpperCase(), count: Number(m[2]) } };
  m = new RegExp(`^(${NT}{2,})>(${NT}+)$`, 'i').exec(r);
  if (m) return { op: 'delins', ref: m[1].toUpperCase(), alt: null, inserted: m[2].toUpperCase() };
  return null;
}

/**
 * A coding change typed without `c.`: `477G>A` (read as coding first) and `G477A` (read as a protein
 * change first, see parse.js). Only A, C, G, T count as bases.
 *
 * @returns {null | {coord: 'c', pos: number, region: 'cds', op: 'sub', ref: string, alt: string, legacy: string}}
 */
export function parseBareCoding(s) {
  const t = s.trim();
  let m = /^(\d+)([ACGT])>([ACGT])$/i.exec(t);
  let legacy = 'pos-first';
  if (!m) { m = /^([ACGT])(\d+)([ACGT])$/i.exec(t); legacy = 'ref-first'; if (m) m = [m[0], m[2], m[1], m[3]]; }
  if (!m) return null;
  const pos = posInt(m[1], 6);
  const ref = m[2].toUpperCase(); const alt = m[3].toUpperCase();
  if (!pos || ref === alt) return null;
  return { coord: 'c', pos, region: 'cds', op: 'sub', ref, alt, legacy };
}

// ------------------------------------------------------------------------------------------- ids

/** `rs115885685`, `RS115885685`, `rs 115885685`, `dbSNP:rs115885685`. */
export function parseRsid(s) {
  const t = s.trim();
  const m = /^(?:dbsnp\s*[:#]?\s*)?rs\s*(\d{1,12})$/i.exec(t);
  if (m) return posInt(m[1], 12) ? `rs${Number(m[1])}` : { malformed: 'rsIDs are "rs" followed by a number' };
  if (/^(?:dbsnp[:#]?)?rs(?:\d\S*)?$/i.test(t)) return { malformed: 'rsIDs are "rs" followed by a number' };
  return null;
}

/**
 * ClinVar ids: `VCV000718860`, `VCV000718860.3`, `RCV000012345.6`, `ClinVar 718860`, `clinvar:718860`,
 * `Variation ID 718860`, `ClinVar VCV000718860`.
 *
 * @returns {null | {malformed: string} | {variationId?: number, vcv?: string, rcv?: string, version?: number}}
 */
export function parseClinvar(s) {
  const t = s.trim();
  let m = /^(?:clinvar\s*[:#]?\s*)?(VCV|RCV)\s*(\d{1,12})(?:\.(\d+))?$/i.exec(t);
  if (m) {
    const n = Number(m[2]);
    if (!n) return { malformed: 'ClinVar accessions have a number after VCV or RCV' };
    const acc = `${m[1].toUpperCase()}${String(n).padStart(9, '0')}`;
    const out = m[1].toUpperCase() === 'VCV' ? { vcv: acc, variationId: n } : { rcv: acc };
    if (m[3]) out.version = Number(m[3]);
    return out;
  }
  m = /^(?:clinvar(?:\s*(?:variation)?\s*id)?|variation\s*id)\s*[:#]?\s*(\d{1,12})$/i.exec(t);
  if (m) return Number(m[1]) ? { variationId: Number(m[1]) } : { malformed: 'ClinVar Variation IDs start at 1' };
  if (/^(?:vcv|rcv|scv)\d*$|^clinvar\W*$/i.test(t)) return { malformed: 'a ClinVar id needs its number' };
  return null;
}

const UNIPROT = /^([OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})(?:-(\d+))?$/;

/**
 * A receptor identifier: UniProt accession (`P55085`, `P55085-2`), UniProt entry name (`PAR2_HUMAN`),
 * Ensembl gene (`ENSG00000164251[.v]`), HGNC id (`HGNC:3538`), NCBI Gene id (`GeneID:2150`,
 * `Gene ID 2150`, `NCBI Gene 2150`, `Entrez 2150`).
 *
 * @returns {null | {type: 'uniprot'|'entry'|'ensg'|'hgnc'|'geneid', value: string, isoform?: number}}
 */
export function parseReceptorId(s) {
  const t = s.trim();
  let m = UNIPROT.exec(t.toUpperCase());
  if (m && /\d/.test(t) && t.length >= 6) return m[2] ? { type: 'uniprot', value: m[1], isoform: Number(m[2]) } : { type: 'uniprot', value: m[1] };
  m = /^([A-Z0-9]{1,10})_(HUMAN)$/i.exec(t);
  if (m) return { type: 'entry', value: `${m[1].toUpperCase()}_HUMAN` };
  m = /^(ENSG\d{11})(?:\.\d+)?$/i.exec(t);
  if (m) return { type: 'ensg', value: m[1].toUpperCase() };
  m = /^HGNC\s*[:#]?\s*(\d{1,7})$/i.exec(t);
  if (m) return { type: 'hgnc', value: `HGNC:${Number(m[1])}` };
  m = /^(?:NCBI\s*)?(?:gene\s*id|geneid|entrez(?:\s*gene)?(?:\s*id)?|ncbi\s*gene)\s*[:#]?\s*(\d{1,10})$/i.exec(t);
  if (m) return { type: 'geneid', value: String(Number(m[1])) };
  return null;
}
