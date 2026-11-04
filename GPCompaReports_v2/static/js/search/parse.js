/**
 * Search v2: the query parser (pure, deterministic, no DOM, no network). Port and extension of the
 * Studio parser (`gpcompare_studio_web/src/app/search/query.ts`).
 *
 * `parse(query, ctx?)` returns every reasonable reading of what the reader typed, best first. It never
 * looks anything up except through the optional `ctx.matchReceptor` callback, so readings that need data
 * (which receptors have Met at 159, which assembly a bare position is on) are left to the resolver.
 *
 * Interpretation (fields present only when they apply):
 * ```
 * {
 *   kind: 'receptor'|'protein'|'residue'|'cdna'|'genomic'|'rsid'|'clinvar'|'generic'|'unrecognised',
 *   confidence: number,            // 0..1, the list is sorted on it
 *   why: string,                   // plain-language reason for this reading
 *   flags?: string[],              // e.g. 'possibly-receptor-name', 'rna-coordinate'
 *   receptorTerm?: string,         // the receptor as typed ('PAR2', 'β2AR', 'P55085', 'HGNC:3538')
 *   receptorId?: {type: 'uniprot'|'entry'|'ensg'|'hgnc'|'geneid', value, isoform?},
 *   receptorMatches?: [{gid, exact}],   // only when ctx.matchReceptor was given
 *   change?: {ref, pos, alt, kind, hgvsPrefix, end?, inserted?, newAa?, fsTer?, ext?, accession?, version?, label?},
 *   cdna?: {coord, transcript?, version?, pos, offset?, region, end?, op, ref, alt, inserted?, repeat?, legacy?},
 *   genomic?: {chrom, pos, end?, ref?, alt?, alts?, op?, inserted?, assemblyHint, accession?, version?, chromCode?, format},
 *   ids?: {rsid?, vcv?, variationId?, rcv?, version?, gnomad?, spdi?},
 *   generic?: {segment, bw, gpcrdb, display, form, residueLetter?, residueNumber?, partial?}
 * }
 * ```
 * `change.alt` is the one-letter residue for a missense change and otherwise the class token ('*', '=',
 * 'fs', 'del', 'dup', 'ins', 'delins', 'ext', '?'); null for a residue. `change.kind` is one of 'missense',
 * 'stop', 'synonymous', 'frameshift', 'indel', 'start', 'ext', 'residue'.
 *
 * Ranking rules (README "Ambiguity and ranking rules"): an exact receptor name beats a variant reading
 * (M1R, A2A, F2R, D2, H1); a receptor identifier beats a protein reading (P55085); a bare integer is never
 * a residue without a receptor; `6 48` is generic 6.48 first.
 *
 * @module search/parse
 */

import { normalizeQuery, isNameShaped } from './normalize.js';
import {
  parseProtein, parseGeneric, parseGenericSpaced, parseCoding, parseBareCoding, parseRsid, parseClinvar,
  parseReceptorId, aaThree,
} from './notation.js';
import { parseGenomic, extractAssembly } from './genomic.js';

export { normalizeQuery } from './normalize.js';

/** Longest query that is parsed; anything beyond it is ignored and the interpretation carries the flag 'query-truncated'. */
export const MAX_QUERY_LENGTH = 300;

/** @typedef {{matchReceptor?: (term: string) => Array<{gid: string, exact: boolean}>}} ParseContext */

const TX = /^((?:NM|NR|XM|XR|NG)_\d+|ENST\d{11}|LRG_\d+(?:t\d+)?)(?:\.(\d+))?(?:\s*\(\s*([^()]+?)\s*\))?\s*:\s*(.+)$/i;
const PX = /^((?:NP|XP)_\d+|ENSP\d{11})(?:\.(\d+))?(?:\s*\(\s*([^()]+?)\s*\))?\s*:\s*(.+)$/i;
const WITH_P = /^([cnr]\.\S+)\s*\(\s*(p\.\(?[^()]*\)?)\s*\)$/i;

/** One reading of a fragment, before the receptor context sets its final confidence. */
const reading = (kind, rel, why, fields = {}) => ({ kind, rel, why, ...fields });

function proteinReading(c, rel, extraWhy = '') {
  const { ...change } = c;
  const kind = change.kind === 'residue' ? 'residue' : 'protein';
  const name = change.kind === 'residue'
    ? `residue ${change.ref ? aaThree(change.ref) : ''}${change.pos}`
    : `the protein change ${change.ref ? aaThree(change.ref) : ''}${change.pos}${change.alt && change.alt.length === 1 && change.alt !== '*' && change.alt !== '=' && change.alt !== '?' ? aaThree(change.alt) : change.alt ?? ''}`;
  return reading(kind, rel, `Read as ${name}${extraWhy}.`, { change });
}

function codingReading(cd, rel, why) {
  const flags = [];
  if (cd.coord === 'n') flags.push('non-coding-coordinate');
  if (cd.coord === 'r') flags.push('rna-coordinate');
  if (cd.region !== 'cds') flags.push('outside-coding-sequence');
  return reading('cdna', rel, why, { cdna: cd, flags });
}

/** c./n./r. with an optional ClinVar-style "(p.…)" after it. */
function readCoding(t) {
  let protein = null;
  let body = t;
  const wp = WITH_P.exec(t);
  if (wp) {
    body = wp[1];
    const p = parseProtein(wp[2]);
    if (p && !p.malformed) protein = p;
  }
  const cd = parseCoding(body);
  if (!cd) return null;
  if (cd.malformed) return cd;
  const r = codingReading(cd, 1, `Read as the ${cd.coord}. change ${body}.`);
  if (protein) r.change = protein;
  return r;
}

/** Transcript- or protein-accession-prefixed notations, and the ClinVar title form. */
function readAccessioned(t) {
  let m = TX.exec(t);
  if (m) {
    const transcript = m[1].toUpperCase().replace(/^(LRG_\d+)T(\d+)$/, '$1t$2');
    const rest = m[4].trim();
    const r = readCoding(rest);
    if (!r) return /^[cnrgp]\./i.test(rest) ? { malformed: `cannot read "${rest}" after ${transcript}` } : null;
    if (r.malformed) return r;
    r.cdna = { ...r.cdna, transcript, version: m[2] ? Number(m[2]) : null };
    r.why = `Read as ${r.cdna.coord}. change ${rest.split(/\s/)[0]} on transcript ${transcript}${m[2] ? `.${m[2]}` : ''}${m[3] ? ` (${m[3]})` : ''}.`;
    if (m[3]) r.receptorTerm = m[3];
    return r;
  }
  m = PX.exec(t);
  if (m) {
    const p = parseProtein(m[4]);
    if (!p || p.malformed) return { malformed: `cannot read "${m[4]}" after ${m[1]}` };
    const r = proteinReading({ ...p, accession: m[1].toUpperCase(), version: m[2] ? Number(m[2]) : null }, 1, ` on protein ${m[1].toUpperCase()}${m[2] ? `.${m[2]}` : ''}`);
    if (m[3]) r.receptorTerm = m[3];
    return r;
  }
  if (/^(?:NM|NR|XM|XR|NG|NP|XP)_|^ENS[TP]\d|^LRG_/i.test(t)) return { malformed: `cannot read "${t}"; expected an accession, ':' and a change` };
  return null;
}

/**
 * All readings of one fragment as a variant notation (no receptor). `tail` is true when a receptor was
 * already read in front of it: then a bare number is a residue and `residue 159` is accepted.
 *
 * @returns {{readings: object[], malformed: string|null, exclusive: boolean}}
 */
function readNotation(t, tail) {
  const out = [];
  let malformed = null;
  const ok = (r) => {
    if (r && r.malformed) { malformed ??= r.malformed; return null; }
    return r;
  };
  const only = (r) => ({ readings: [r], malformed: null, exclusive: true });

  const rs = ok(parseRsid(t));
  if (rs) return only(reading('rsid', 1, `Read as the dbSNP id ${rs}.`, { ids: { rsid: rs } }));
  const cv = ok(parseClinvar(t));
  if (cv) {
    const what = cv.vcv ?? cv.rcv ?? `Variation ID ${cv.variationId}`;
    return only(reading('clinvar', 1, `Read as the ClinVar record ${what}.`, { ids: cv }));
  }
  const asm = extractAssembly(t);
  const g = ok(parseGenomic(asm.text));
  if (g) {
    const flags = [];
    if (asm.assembly) { g.genomic.assemblyHint = asm.assembly; g.genomic.assemblyLabel = asm.label; flags.push('assembly-from-label'); } else if (g.genomic.assemblyHint) flags.push('assembly-from-accession');
    if (g.genomic.chromCode) flags.push('plink-chromosome-code');
    if (g.genomic.alts) flags.push('multi-allelic');
    if (g.genomic.format === 'spdi') flags.push('spdi-zero-based');
    const where = `${g.genomic.chrom}:${g.genomic.pos}${g.genomic.end && g.genomic.end !== g.genomic.pos ? `-${g.genomic.end}` : ''}`;
    return only(reading('genomic', 1, `Read as the genomic ${g.genomic.ref ? 'variant' : 'position'} at chromosome ${where} (${g.genomic.format}).`, { genomic: g.genomic, ids: g.ids, flags }));
  }
  const acc = ok(readAccessioned(t));
  if (acc) return only({ ...acc });
  if (malformed) return { readings: [], malformed, exclusive: true };

  const gen = parseGeneric(t);
  if (gen) {
    out.push(reading('generic', gen.partial ? 0.6 : 1, `Read as the generic residue number ${gen.display}${gen.residueLetter ? ` with residue ${gen.residueLetter}${gen.residueNumber ?? ''}` : ''}.`, { generic: gen, flags: gen.partial ? ['partial'] : [] }));
    return { readings: out, malformed: null, exclusive: false };
  }
  const sp = parseGenericSpaced(t);
  if (sp) {
    out.push(reading('generic', 0.9, `Read "${t}" as the generic residue number ${sp.display}.`, { generic: sp }));
    if (tail) {
      const n = Number(t.split(' ')[0]);
      out.push(reading('residue', 0.55, `Read as residue ${n}, ignoring the rest.`, { change: { ref: null, pos: n, alt: null, kind: 'residue', hgvsPrefix: false } }));
    }
    return { readings: out, malformed: null, exclusive: false };
  }

  if (/^[cnr]\./i.test(t)) {
    const c = ok(readCoding(t));
    if (c) out.push(c);
    return { readings: out, malformed, exclusive: false };
  }

  const p = ok(parseProtein(t));
  const bc = parseBareCoding(t);
  if (bc && bc.legacy === 'pos-first') {
    out.push(codingReading(bc, 1, `Read as the coding change c.${bc.pos}${bc.ref}>${bc.alt}.`));
    if (p) out.push({ ...proteinReading(p, 0.8, ', in the legacy position-first form'), flags: ['could-be-coding'] });
  } else if (bc) {
    if (p) out.push({ ...proteinReading(p, 1), flags: ['could-be-coding'] });
    out.push(codingReading(bc, 0.85, `Read as the coding change c.${bc.pos}${bc.ref}>${bc.alt} (legacy ${t}).`));
  } else if (p) out.push(proteinReading(p, 1));
  if (out.length) return { readings: out, malformed, exclusive: false };

  const d = /^(?:delta|del|d)\s*(\d{1,4})$/i.exec(t);
  if (d) {
    const change = { ref: null, pos: null, alt: 'del', kind: 'indel', hgvsPrefix: false, label: `delta${d[1]}` };
    return { readings: [reading('protein', tail ? 1 : 0.5, `Read as a named deletion (Δ${d[1]}).`, { change })], malformed: null, exclusive: false };
  }
  if (tail) {
    const m = /^(?:(?:residue|res|position|pos|aa|amino acid)\s*\.?\s*)?(\d{1,5})$/i.exec(t)
      ?? /^(?:residue|res|position|pos)\s*\.?\s*([A-Za-z]{3}\d+|[A-Za-z]\d+)$/i.exec(t);
    if (m) {
      if (/^\d+$/.test(m[1])) {
        const n = Number(m[1]);
        if (n >= 1 && !/^0/.test(m[1])) return { readings: [reading('residue', 0.95, `Read as residue ${n}.`, { change: { ref: null, pos: n, alt: null, kind: 'residue', hgvsPrefix: false } })], malformed: null, exclusive: false };
        return { readings: [], malformed: 'residue numbers start at 1', exclusive: false };
      }
      const q = ok(parseProtein(m[1]));
      if (q) return { readings: [proteinReading(q, 0.95)], malformed: null, exclusive: false };
    }
  }
  if (!malformed && /^(?:[pcgnmr]\.|chr|vcv|rcv|hgnc|ens[gtp]|n[mrpc]_)/i.test(t)) malformed = `cannot read "${t}"`;
  if (!malformed && /^\d+(?:\.\d+){2,}$/.test(t)) malformed = `cannot read "${t}" as a number`;
  return { readings: out, malformed, exclusive: false };
}

/** Receptor ranking context: how well a typed term matches a receptor, via ctx. */
function matchOf(term, matcher) {
  if (!matcher) return { status: 'unknown', matches: undefined };
  let matches = [];
  try {
    const r = matcher(term);
    matches = Array.isArray(r) ? r.filter((x) => x && x.gid).map((x) => ({ gid: x.gid, exact: !!x.exact })) : [];
  } catch { matches = []; }
  const status = matches.some((x) => x.exact) ? 'exact' : matches.length ? 'prefix' : 'none';
  return { status, matches };
}

const RECEPTOR_BASE = { unknown: 0.85, exact: 0.95, prefix: 0.75, none: 0.6 };

/** Turn a reading into a final interpretation (confidence and receptor fields). */
function finish(r, confidence, receptor) {
  const out = { kind: r.kind, confidence: Math.round(confidence * 1000) / 1000, why: r.why };
  const flags = [...(r.flags ?? [])];
  const term = receptor?.term ?? r.receptorTerm;
  if (term) {
    out.receptorTerm = term;
    const rid = receptor?.rid ?? parseReceptorId(term);
    if (rid) out.receptorId = rid;
    if (receptor?.match?.matches) out.receptorMatches = receptor.match.matches;
  }
  for (const k of ['change', 'cdna', 'genomic', 'ids', 'generic']) if (r[k]) out[k] = r[k];
  if (receptor?.flags) flags.push(...receptor.flags);
  if (flags.length) out.flags = [...new Set(flags)];
  return out;
}

function receptorInterp(term, rid, match, confidence, why, flags = []) {
  return finish(reading('receptor', 1, why, { flags }), confidence, { term, rid, match });
}

/** Every split of "receptor + notation" (head first, a "(GENE)" suffix, or notation first). */
function splits(text, matcher) {
  const cands = [];
  const seen = new Set();
  const add = (head, tail, order) => {
    head = head.trim(); tail = tail.trim();
    if (!head || !tail || seen.has(`${head}\u0000${tail}`)) return;
    seen.add(`${head}\u0000${tail}`);
    const rid = parseReceptorId(head);
    if (!rid && !isNameShaped(head)) return;
    cands.push({ head, tail, rid, order });
  };
  const paren = /^(.+?)\s*\(\s*([^()]+?)\s*\)$/.exec(text);
  if (paren) add(paren[2], paren[1], 'suffix');
  for (let i = 1; i < text.length; i++) {
    if (!/[\s:,]/.test(text[i]) || /[\s:,]/.test(text[i - 1])) continue;
    add(text.slice(0, i).replace(/[\s:,]+$/, ''), text.slice(i).replace(/^[\s:,]+/, ''), 'prefix');
  }
  const rev = /^(\S+)\s+(.+)$/.exec(text);
  if (rev) add(rev[2], rev[1], 'reversed');

  const usable = [];
  let malformedTail = null;
  for (const c of cands) {
    const n = readNotation(c.tail, true);
    if (!n.readings.length) {
      if (n.malformed && c.order === 'prefix' && !malformedTail) malformedTail = { ...c, why: n.malformed };
      continue;
    }
    if (c.order === 'reversed' && n.readings.every((r) => r.kind === 'residue' && r.change?.ref === null)) continue;
    usable.push({ ...c, readings: n.readings, match: matchOf(c.head, matcher) });
  }
  let keep;
  if (matcher) {
    const exact = usable.filter((c) => c.match.status === 'exact');
    keep = exact.length ? exact : usable.slice(0, 1);
  } else keep = usable.slice(0, 1);
  return { keep, malformedTail };
}

/**
 * Parse a search query into ranked interpretations.
 *
 * @param {string} query what the reader typed
 * @param {ParseContext} [ctx] optional receptor-alias matcher: `matchReceptor(term)` returns
 *   `[{gid, exact}]` for the receptors the term names (exact name/alias/id match, or a prefix match).
 * @returns {Array<object>} interpretations, best first; never empty (an unreadable query gives one
 *   'unrecognised' interpretation)
 */
export function parse(query, ctx) {
  if (typeof query !== 'string' || query.length <= MAX_QUERY_LENGTH) return parseText(query, ctx);
  const raw = query;
  // the split search below is quadratic in the query length: read only the first MAX_QUERY_LENGTH characters
  let cut = raw.slice(0, MAX_QUERY_LENGTH);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1); // never end on half a surrogate pair
  return parseText(cut, ctx).map((i) => ({ ...i, flags: [...new Set([...(i.flags ?? []), 'query-truncated'])] }));
}

function parseText(query, ctx) {
  const text = normalizeQuery(query);
  const matcher = ctx && typeof ctx.matchReceptor === 'function' ? ctx.matchReceptor : null;
  if (!text) return [{ kind: 'unrecognised', confidence: 1, why: 'Nothing was typed.' }];
  const out = [];

  // 1. a receptor identifier on its own (UniProt accession, entry name, ENSG, HGNC:, GeneID)
  const rid = parseReceptorId(text);
  if (rid) {
    out.push(receptorInterp(text, rid, matchOf(text, matcher), 0.97, `Read as the receptor identifier ${rid.value} (${rid.type}).`));
    const p = parseProtein(text);
    if (p && !p.malformed) out.push(finish({ ...proteinReading(p, 1), flags: ['possibly-identifier'] }, 0.25));
    return rank(out);
  }

  // 2. a bare integer: never a residue without a receptor; offer the id readings
  if (/^\d{1,12}$/.test(text) && !/^0/.test(text)) {
    const n = Number(text);
    out.push(finish(reading('clinvar', 1, `Read ${n} as a ClinVar Variation ID.`, { ids: { variationId: n } }), 0.42));
    // an NCBI Gene ID that names a receptor in the database is the likeliest reading (2150 = F2RL1);
    // a bare HGNC number is not (HGNC ids are written with their prefix)
    const gene = matchOf(`GeneID:${n}`, matcher);
    out.push(receptorInterp(`GeneID:${n}`, { type: 'geneid', value: String(n) }, gene, gene.status === 'exact' ? 0.6 : 0.41, `Read ${n} as an NCBI Gene ID.`));
    out.push(receptorInterp(`HGNC:${n}`, { type: 'hgnc', value: `HGNC:${n}` }, matchOf(`HGNC:${n}`, matcher), 0.4, `Read ${n} as an HGNC id.`));
    return rank(out);
  }

  // 3. the whole query as a notation without a receptor
  const alone = readNotation(text, false);
  const base = { protein: 0.88, residue: 0.85, cdna: 0.9, generic: 0.9 };
  for (const r of alone.readings) {
    let c = r.kind in base ? base[r.kind] : 0.97;
    if ((r.kind === 'protein' || r.kind === 'residue') && r.change?.hgvsPrefix) c = 0.92;
    if (r.generic?.form === 'space') c = 0.5;
    // a gene in brackets (`NM_005242.6(F2RL1):c.…`) is matched like any receptor term
    out.push(finish(r, c * r.rel, r.receptorTerm ? { term: r.receptorTerm, match: matchOf(r.receptorTerm, matcher) } : undefined));
  }
  if (alone.exclusive && out.length) return rank(out);
  if (alone.exclusive && alone.malformed && !/\s/.test(text)) {
    return [{ kind: 'unrecognised', confidence: 1, why: `Could not read "${text}": ${alone.malformed}.` }];
  }

  // 4. the whole query as a receptor name, weighed against a variant reading of the same text
  const nameLike = isNameShaped(text) && !/^[pcgnr]\./i.test(text);
  if (nameLike) {
    const match = matchOf(text, matcher);
    const shortName = !/\s/.test(text) && text.length <= 4;
    if (match.status === 'exact' || match.status === 'prefix') {
      const exact = match.status === 'exact';
      for (const o of out) {
        o.confidence = Math.min(o.confidence, exact ? 0.45 : 0.5);
        o.flags = [...new Set([...(o.flags ?? []), 'possibly-receptor-name'])];
      }
      out.push(receptorInterp(text, null, match, exact ? 0.97 : 0.7, exact ? `"${text}" is a receptor name.` : `"${text}" starts the name of ${match.matches.length} receptor${match.matches.length === 1 ? '' : 's'}.`));
    } else if (match.status === 'unknown' && shortName && out.some((o) => o.kind === 'protein' || o.kind === 'residue')) {
      for (const o of out) {
        o.confidence = Math.min(o.confidence, 0.6);
        o.flags = [...new Set([...(o.flags ?? []), 'possibly-receptor-name'])];
      }
      out.push(receptorInterp(text, null, match, 0.55, `"${text}" may be a receptor name.`));
    }
  }

  // 5. receptor + notation
  const { keep, malformedTail } = splits(text, matcher);
  for (const c of keep) {
    let b = RECEPTOR_BASE[c.match.status] * (c.order === 'reversed' ? 0.85 : 1);
    const flags = c.order === 'reversed' ? ['reversed-order'] : [];
    // 'protease-activated receptor 2' without ctx: a multi-word name ending in a number is more
    // likely the name than residue 2 of 'protease-activated receptor'
    if (!matcher && /\s/.test(c.head) && c.readings.every((r) => r.kind === 'residue' && r.change?.ref === null)) {
      b *= 0.6;
      out.push(receptorInterp(text, null, matchOf(text, null), 0.8, `Read as the receptor name "${text}".`));
    }
    for (const r of c.readings) out.push(finish(r, b * r.rel, { term: c.head, rid: c.rid, match: c.match, flags }));
  }

  // 6. nothing read as a variant: the whole query as a receptor name, or unrecognised
  if (!out.length) {
    if (malformedTail) {
      out.push(finish(reading('unrecognised', 1, `Could not read "${malformedTail.tail}": ${malformedTail.why}.`), 0.6, { term: malformedTail.head, rid: malformedTail.rid, match: matchOf(malformedTail.head, matcher) }));
      out.push(receptorInterp(malformedTail.head, malformedTail.rid, matchOf(malformedTail.head, matcher), 0.4, `Only the receptor "${malformedTail.head}" could be read.`));
    } else if (nameLike && !alone.malformed) {
      const match = matchOf(text, matcher);
      const c = match.status === 'none' ? 0.3 : 0.8;
      out.push(receptorInterp(text, null, match, c, match.status === 'none' ? `No receptor in the database is called "${text}".` : `Read as the receptor name "${text}".`));
    } else {
      out.push({ kind: 'unrecognised', confidence: 1, why: alone.malformed ? `Could not read "${text}": ${alone.malformed}.` : `Could not read "${text}".` });
    }
  }
  return rank(out);
}

/** Sort best-first (stable) and drop duplicate readings. */
function rank(list) {
  const seen = new Set();
  return list
    .map((x, i) => [x, i])
    .sort((a, b) => b[0].confidence - a[0].confidence || a[1] - b[1])
    .map(([x]) => x)
    .filter((x) => {
      const key = summarize(x);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * A compact, stable one-line description of an interpretation, for tests, logs and debugging:
 * `protein R=F2RL1 p=M159I`, `cdna c=NM_005242.6:cds:477G>A`, `genomic g=5:76833084:G>A@GRCh38/gnomad`.
 *
 * @param {object} i an interpretation from `parse`
 * @returns {string}
 */
export function summarize(i) {
  const parts = [i.kind];
  if (i.receptorTerm) parts.push(`R=${i.receptorTerm}`);
  if (i.receptorId) parts.push(`rid=${i.receptorId.type}:${i.receptorId.value}`);
  const c = i.change;
  if (c) {
    const range = c.end ? `_${c.end.ref}${c.end.pos}` : '';
    parts.push(`p=${c.ref ?? '?'}${c.pos ?? '?'}${range}${c.alt ?? ''}${c.inserted ? `[${c.inserted}]` : ''}${c.label ? `(${c.label})` : ''}${c.accession ? `@${c.accession}${c.version ? `.${c.version}` : ''}` : ''}`);
  }
  const d = i.cdna;
  if (d) {
    const tx = d.transcript ? `${d.transcript}${d.version ? `.${d.version}` : ''}:` : '';
    const off = d.offset ? (d.offset > 0 ? `+${d.offset}` : `${d.offset}`) : '';
    const end = d.end ? `_${d.end.pos}${d.end.offset ? (d.end.offset > 0 ? `+${d.end.offset}` : d.end.offset) : ''}` : '';
    const what = d.op === 'sub' ? `${d.ref}>${d.alt}` : `${d.op}${d.inserted ?? ''}${d.repeat ? `${d.repeat.unit}[${d.repeat.count}]` : ''}`;
    parts.push(`${d.coord}=${tx}${d.region}:${d.pos}${off}${end}${what}`);
  }
  const g = i.genomic;
  if (g) {
    const what = g.ref || g.alt ? `:${g.ref ?? ''}>${g.alts ? g.alts.join(',') : g.alt ?? ''}` : '';
    parts.push(`g=${g.chrom}:${g.pos}${g.end && g.end !== g.pos ? `-${g.end}` : ''}${what}${g.op && g.op !== 'sub' ? `:${g.op}` : ''}@${g.assemblyHint ?? '?'}/${g.format}`);
  }
  if (i.ids) {
    for (const k of ['rsid', 'vcv', 'rcv', 'variationId', 'gnomad', 'spdi']) if (i.ids[k] !== undefined) parts.push(`${k}=${i.ids[k]}`);
  }
  if (i.generic) {
    const gn = i.generic;
    parts.push(`gn=${gn.display}${gn.residueLetter ? `/${gn.residueLetter}${gn.residueNumber ?? ''}` : ''}`);
  }
  return parts.join(' ');
}
