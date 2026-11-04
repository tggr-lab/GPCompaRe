/**
 * Search v2: the resolver. Maps parse() interpretations to answers using the lazily loaded index
 * shards (search2/, written by website/page_generators/search_index_v2.py). Pure apart from the
 * injected loader, so the same code runs in node tests and in the browser.
 *
 *   const answer = await search('F2RL1 p.Met159Ile', loader);
 *   // or: const ctx = await context(loader); resolve(parse(q, ctx), loader)
 *
 * Loader contract: `loader(path) -> Promise<object|null>`, `path` relative to the search2 root
 * ('meta.json', 'variants/par2_human.json'); see shards.js.
 *
 * Answer:
 * ```
 * {
 *   expect: 'target'|'targets'|'receptor'|'ambiguous'|'not_coding'|'not_in_resource'|'unrecognised',
 *   results: Result[],          // best first; one for 'target', several for 'targets'
 *   alternates: Alternate[],    // "Did you mean": {kind: 'receptor'|'change'|'residue'|'generic'|'clinvar'|
 *                               //   'gene_id'|'hgnc', gid?: string|'*', pos?, ref?, alt?, display?, id?, count?, label}
 *   assembly: 'GRCh38'|'GRCh37'|null,   // genomic input: the assembly read (detected or stated)
 *   message: string|null,       // plain-language line for the non-target answers
 *   interpretation: object|null // the parse() interpretation the answer came from
 * }
 * Result: {
 *   type: 'target'|'receptor'|'not_coding'|'not_in_resource',
 *   light?: true,               // bare generic number across receptors: no residue card, views or alleles
 *   gid, receptor: {gid, symbol, uniprot, entry, name},
 *   pos: number|null,           // model (pack) residue number = report and snake-plot numbering
 *   ref: string|null,           // one letter; for a named allele or ClinVar record, that record's reference
 *   alt: string|null,           // one letter for missense; '*', '=', 'fs', 'del', 'dup', 'ins', 'delins' else
 *   alts?: string[],            // several substitutions (one rsID, a locus)
 *   kind: 'missense'|'residue'|'stop'|'synonymous'|'frameshift'|'indel'|...,
 *   residue: {pos, aa, segment, generic, bw, gpcrdb, cfr, cfrRank, dmax, nsig, conservation, amMean}|null,
 *   alleles: Allele[],          // gnomAD alleles the query names (all alleles of a substitution)
 *   residueAlleles: Allele[],   // every gnomAD allele at the residue
 *   clinvar: ClinvarRecord[],   // ClinVar records for the query (any class; `packed` = the P/LP set)
 *   transcriptViews: [{role: 'mane'|'mane_ensembl'|'gnomad'|'typed', transcript, protein, c, p, allele?}],
 *   genomic: {grch38: string|null, grch37: string|null},  // gnomAD-style ids (or chrom:pos for a locus)
 *   notes: [{code, text}],      // version_mismatch, isoform_mapping, offset_mapping, gnomad_frame,
 *                               // model_conflict, reference_swap, reference_mismatch, typed_residue_differs,
 *                               // generic_number_differs, not_coding, not_in_resource, outside_model,
 *                               // no_coding_transcript, assembly_detected, liftover_approximate, par_y, ...
 *   releases: {gnomad, clinvar}
 * }
 * ```
 * Allele and ClinvarRecord are the decoded shard objects of shards.js (decodeVariants).
 *
 * @module search/resolve
 */

import { parse } from './parse.js';
import { aliasKey } from './normalize.js';
import { shardsFor, makeMatcher, three } from './shards.js';
import { cToG, gToC, cText, mapPos, unmapPos, lift38to37, lift37to38, baseAt, codonAt, translate, complement, cdsLength } from './txmap.js';

const NONMISSENSE = new Set(['stop', 'synonymous', 'frameshift', 'indel', 'start', 'ext']);
const PAR1 = { GRCh38: [10001, 2781479], GRCh37: [60001, 2699520] };
/** Flanking sequence read as 'near the gene' (outside the coding sequence). */
const FLANK = 10000;

const note = (code, text) => ({ code, text });

/** Meta and the receptor matcher for parse(), cached per loader. */
export async function context(loader) {
  const S = shardsFor(loader);
  const meta = await S.meta();
  if (!meta) throw new Error('search index: meta.json not found');
  if (!meta.matchReceptor) meta.matchReceptor = makeMatcher(meta);
  return { S, meta, matchReceptor: meta.matchReceptor };
}

/** Parse and resolve a typed query. */
export async function search(query, loader) {
  const ctx = await context(loader);
  return resolve(parse(query, { matchReceptor: ctx.matchReceptor }), loader, { ctx });
}

function answer(expect, results = [], extra = {}) {
  return { expect, results, alternates: extra.alternates ?? [], assembly: extra.assembly ?? null, message: extra.message ?? null, interpretation: extra.interpretation ?? null };
}

const POSITIVE = new Set(['target', 'targets', 'receptor', 'ambiguous']);
const VARIANT_KINDS = new Set(['protein', 'residue', 'cdna', 'genomic', 'rsid', 'clinvar', 'generic']);

/**
 * Resolve interpretations (from parse) to an answer.
 *
 * @param {object[]} interps parse() output, best first
 * @param {(path: string) => Promise<object|null>} loader
 * @param {{ctx?: object}} [opts]
 */
export async function resolve(interps, loader, opts = {}) {
  const ctx = opts.ctx ?? (await context(loader));
  const list = Array.isArray(interps) && interps.length ? interps : [{ kind: 'unrecognised', why: 'Nothing was typed.' }];
  const top = list[0];
  if (top.kind === 'unrecognised') return answer('unrecognised', [], { message: top.why, interpretation: top });

  // a bare integer: candidate identifiers, never a residue
  if (isBareInteger(list)) return resolveBareInteger(ctx, list);

  if (top.kind === 'receptor') return resolveReceptorQuery(ctx, list);

  let firstNegative = null;
  let firstPositive = null;
  for (const i of list) {
    if (!VARIANT_KINDS.has(i.kind)) continue;
    const a = await resolveOne(ctx, i);
    if (!a) continue;
    a.interpretation ??= i;
    if (POSITIVE.has(a.expect)) { firstPositive = a; break; }
    if (!firstNegative) firstNegative = a;
  }
  const out = firstPositive ?? firstNegative ?? answer('unrecognised', [], { message: top.why, interpretation: top });
  // the other readings that also resolve are offered as "Did you mean"
  if (out.expect === 'target' && out.interpretation?.generic?.form === 'space') {
    const alts = await alternatesFrom(ctx, list.filter((i) => i !== out.interpretation));
    out.alternates.push(...alts);
    out.expect = 'ambiguous';
  }
  return out;
}

async function resolveOne(ctx, i) {
  switch (i.kind) {
    case 'protein':
    case 'residue': return resolveChangeInterp(ctx, i);
    case 'cdna': return resolveCoding(ctx, i);
    case 'genomic': return resolveGenomic(ctx, i);
    case 'rsid': return resolveRsid(ctx, i);
    case 'clinvar': return resolveClinvar(ctx, i);
    case 'generic': return resolveGenericInterp(ctx, i);
    default: return null;
  }
}

// =============================================================================== receptors

function receptorInfo(meta, gid) {
  const r = meta.byGid.get(gid);
  return r ? { gid, symbol: r.symbol, uniprot: r.uniprot, entry: r.entry, name: r.name, idx: r.idx } : { gid };
}

/** Which receptors an interpretation names: {gids, status: 'exact'|'prefix'|'none'|'absent', term}. */
function receptorsOf(meta, i) {
  const term = i.receptorTerm;
  if (!term && !i.receptorId) return { gids: [], status: 'absent', term: null };
  const rid = i.receptorId;
  if (rid) {
    const field = { uniprot: 'uniprot', entry: 'entry', ensg: 'ensg', hgnc: 'hgnc', geneid: 'geneId' }[rid.type];
    const hit = meta.receptors.filter((r) => String(r[field] ?? '').toUpperCase() === String(rid.value).toUpperCase());
    if (hit.length) return { gids: hit.map((r) => r.gid), status: 'exact', term, rid };
  }
  const m = i.receptorMatches ?? meta.matchReceptor(term);
  const exact = m.filter((x) => x.exact).map((x) => x.gid);
  if (exact.length) return { gids: exact, status: 'exact', term };
  const prefix = m.filter((x) => !x.exact).map((x) => x.gid);
  if (prefix.length) return { gids: prefix, status: 'prefix', term };
  return { gids: [], status: 'none', term };
}

/** Why a receptor term names nothing: excluded receptor, a member number we do not know, or another gene. */
function unknownReceptor(meta, term, i) {
  const k = aliasKey(term);
  const ex = meta.excluded.find((e) => e.keys.includes(k));
  if (ex) {
    return answer('not_in_resource', [], { interpretation: i, message: `${ex.symbol} is a Class A receptor that is not in this database (${ex.reason}); it holds 283 human Class A GPCRs.` });
  }
  const t = String(term).trim();
  const fam = /^([A-Za-z]+)(\d+)$/.exec(t);
  if (fam) {
    const stem = fam[1].toUpperCase();
    const nums = meta.receptors.map((r) => new RegExp(`^${stem}(\\d+)$`).exec(String(r.symbol))).filter(Boolean).map((m) => Number(m[1]));
    if (nums.length >= 3 && Number(fam[2]) > Math.max(...nums)) {
      return answer('unrecognised', [], { interpretation: i, message: `No receptor is called "${t}". ${stem} receptors in this database run up to ${stem}${Math.max(...nums)}.` });
    }
  }
  if (/^[A-Z][A-Z0-9-]{1,14}$/.test(t) && /\d/.test(t)) {
    return answer('not_in_resource', [], { interpretation: i, message: `"${t}" is not one of the 283 human Class A GPCRs in this database.` });
  }
  return answer('unrecognised', [], { interpretation: i, message: `Could not read "${t}" as a receptor, variant or position.` });
}

function receptorResult(meta, gid, extraNotes = []) {
  return { type: 'receptor', gid, receptor: receptorInfo(meta, gid), pos: null, ref: null, alt: null, notes: extraNotes };
}

async function resolveReceptorQuery(ctx, list) {
  const { meta } = ctx;
  const top = list[0];
  const r = receptorsOf(meta, top);
  if (r.status === 'none' || r.status === 'absent') return unknownReceptor(meta, top.receptorTerm ?? '', top);
  // the variant readings of the same text (M1R = Met1Arg), offered as "Did you mean"
  const others = list.slice(1).filter((i) => (i.kind === 'protein' || i.kind === 'residue') && !i.receptorTerm);
  const alternates = [];
  for (const o of others) {
    const c = o.change;
    if (!c || c.pos === null || !c.ref) continue;
    const hits = await receptorsWithResidue(ctx, c.pos, c.ref);
    if (!hits.length) continue;
    const isChange = c.kind === 'missense' || (c.alt && c.alt.length === 1 && c.alt !== '=');
    alternates.push(isChange && c.kind === 'missense'
      ? { kind: 'change', gid: '*', pos: c.pos, ref: c.ref, alt: c.alt, count: hits.length, label: `p.${three(c.ref)}${c.pos}${three(c.alt)} in ${hits.length} receptor${hits.length === 1 ? '' : 's'}` }
      : { kind: 'residue', gid: '*', pos: c.pos, ref: c.ref, count: hits.length, label: `${three(c.ref)}${c.pos} in ${hits.length} receptor${hits.length === 1 ? '' : 's'}` });
  }
  if (r.status === 'exact' && r.gids.length === 1) {
    const res = [receptorResult(meta, r.gids[0])];
    if (alternates.length) return answer('ambiguous', res, { alternates, interpretation: top, message: `"${top.receptorTerm}" is read as a receptor name.` });
    return answer('receptor', res, { interpretation: top });
  }
  if (r.status === 'prefix' && r.gids.length === 1) return answer('receptor', [receptorResult(meta, r.gids[0])], { interpretation: top });
  const res = r.gids.map((g) => receptorResult(meta, g));
  const why = r.status === 'exact' ? `"${top.receptorTerm}" names ${r.gids.length} receptors.` : `${r.gids.length} receptor names start with "${top.receptorTerm}".`;
  return answer('ambiguous', res, { alternates, interpretation: top, message: why });
}

// ============================================================================ bare integers

function isBareInteger(list) {
  return list.length >= 2 && list.every((i) => (i.kind === 'clinvar' && i.ids?.variationId && !i.ids.vcv) || (i.kind === 'receptor' && ['geneid', 'hgnc'].includes(i.receptorId?.type)))
    && list.some((i) => i.kind === 'clinvar');
}

async function resolveBareInteger(ctx, list) {
  const { meta } = ctx;
  const cv = list.find((i) => i.kind === 'clinvar');
  const n = cv.ids.variationId;
  const alternates = [
    { kind: 'clinvar', id: n, label: `ClinVar Variation ID ${n}` },
    { kind: 'gene_id', id: String(n), label: `NCBI Gene ID ${n}` },
    { kind: 'hgnc', id: `HGNC:${n}`, label: `HGNC:${n}` },
  ];
  const results = [];
  const gene = meta.receptors.find((r) => String(r.geneId) === String(n));
  if (gene) {
    results.push(receptorResult(meta, gene.gid));
    alternates.splice(1, 1);
  }
  const rec = await clinvarRecord(ctx, n);
  if (rec) {
    const a = await clinvarAnswer(ctx, rec, cv);
    if (a?.results?.length) {
      if (gene) alternates[0] = { ...alternates[0], gid: rec.gid, pos: a.results[0].pos, label: `ClinVar ${rec.record.accession} (${rec.record.title})` };
      else results.push(...a.results);
    }
  }
  return answer('ambiguous', results, { alternates, interpretation: list[0], message: `A number on its own is not a residue. It could be one of these identifiers.` });
}

// ================================================================== shared residue helpers

async function receptorsWithResidue(ctx, pos, aa) {
  const seqs = await ctx.S.seq();
  const out = [];
  seqs.forEach((s, idx) => { if (s.length >= pos && (!aa || s[pos - 1] === aa)) out.push(ctx.meta.receptors[idx].gid); });
  return out;
}

async function loadGene(ctx, gid) {
  const [res, vars, txs, bases] = await Promise.all([ctx.S.residues(gid), ctx.S.variants(gid), ctx.S.transcripts(gid), ctx.S.bases(gid)]);
  return { gid, res, vars, txs, bases };
}

function txKey(t) { return `${t.id.split('@')[0]}${t.v ? `.${t.v}` : ''}`; }

function maneTx(txs, src = 'refseq') {
  return txs?.tx.find((t) => t.mane && t.asm === 'GRCh38' && t.src === src && t.chrom !== 'Y') ?? null;
}

function gnomadTx(txs) {
  if (!txs?.gnomadTx) return null;
  const [id, v] = txs.gnomadTx.split('.');
  return txs.tx.find((t) => t.id === id && t.v === Number(v) && t.asm === 'GRCh38' && t.chrom !== 'Y')
    ?? txs.tx.find((t) => t.id === id && t.asm === 'GRCh38' && (t.alsoV ?? []).includes(Number(v)))
    ?? txs.tx.find((t) => t.id === id && t.asm === 'GRCh38' && t.chrom !== 'Y') ?? null;
}

/** GRCh38 position of a transcript's own coordinate (GRCh37 transcripts are lifted). */
function toG38(gene, t) {
  if (t.asm !== 'GRCh37') return { f: (g) => g, strand: t.strand };
  let strand = t.strand;
  const f = (g) => {
    const r = lift37to38(gene.txs.lift, t.chrom, g);
    if (r && r.strand === -1) strand = -t.strand;
    return r ? r.pos : null;
  };
  // probe the strand relation once at the CDS start
  if (t.cds.length) f(t.cds[0][0]);
  return { f, strand };
}

function proteinText(ref, pos, alt) {
  if (!ref || !pos) return null;
  if (alt === null || alt === undefined) return `p.${three(ref)}${pos}`;
  if (alt.length === 1 && alt !== '=') return `p.${three(ref)}${pos}${three(alt)}`;
  if (alt === '=') return `p.${three(ref)}${pos}=`;
  return `p.${three(ref)}${pos}${alt}`;
}

/** c./p. views of a target on MANE (RefSeq and Ensembl), the gnomAD transcript and the typed one. */
function transcriptViews(gene, pos, ref, alt, alleles, typed) {
  const views = [];
  const txs = gene.txs;
  if (!txs) return views;
  const seen = new Set();
  const add = (role, t, allele, cOverride) => {
    if (!t) return;
    const key = `${role}:${txKey(t)}:${allele?.id ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    const tp = unmapPos(t.map, pos);
    const view = { role, transcript: txKey(t), protein: t.p ? `${t.p}${t.pv ? `.${t.pv}` : ''}` : null, assembly: t.asm, c: null, p: null };
    if (allele) {
      view.allele = allele.id;
      const c = gToC(t, allele.g38);
      if (c && t.asm === 'GRCh38') {
        const r = t.strand === 1 ? allele.ref38 : complement(allele.ref38);
        const a = t.strand === 1 ? allele.alt38 : complement(allele.alt38);
        view.c = `c.${cText(c)}${r}>${a}`;
      }
    }
    if (cOverride) view.c = cOverride;
    view.p = tp ? proteinText(allele ? allele.ref : ref, tp, allele ? allele.alt : alt) : null;
    if (!tp) view.note = 'this residue is not in this transcript\'s protein';
    views.push(view);
  };
  const list = alleles.length ? alleles : [null];
  for (const a of list.slice(0, 4)) {
    add('mane', maneTx(txs, 'refseq'), a);
    add('mane_ensembl', maneTx(txs, 'ensembl'), a);
    const g = gnomadTx(txs);
    if (a && g) views.push({ role: 'gnomad', transcript: a.transcript, protein: null, assembly: 'GRCh38', c: a.hgvsc, p: a.hgvsp, allele: a.id });
    else if (g && !a) add('gnomad', g, null);
  }
  if (typed?.tx) add('typed', typed.tx, typed.allele ?? null, typed.c ?? null);
  return views;
}

/** Build a target-like result for gid at model position `pos`. */
async function makeResult(ctx, gid, pos, o = {}) {
  const gene = o.gene ?? (await loadGene(ctx, gid));
  const residue = pos ? gene.res?.residue(pos) ?? null : null;
  const alleles = o.alleles ?? [];
  const residueAlleles = pos ? gene.vars?.byPos.get(pos) ?? [] : [];
  let clinvar = o.clinvar;
  if (!clinvar && gene.vars) {
    const ids = new Set(alleles.map((a) => a.id));
    clinvar = gene.vars.clinvar.filter((c) => (c.gnomadId && ids.has(c.gnomadId)) || (pos && c.pos === pos && (o.alt ? c.alt === o.alt : o.kind === 'residue')));
  }
  let genomic = o.genomic ?? null;
  if (!genomic && alleles.length) genomic = { grch38: alleles[0].id, grch37: alleles[0].id37 };
  const r = {
    type: o.type ?? 'target', gid, receptor: receptorInfo(ctx.meta, gid), pos: pos ?? null,
    ref: o.ref ?? residue?.aa ?? null, alt: o.alt ?? null, kind: o.kind ?? (o.alt ? 'missense' : 'residue'),
    residue, alleles, residueAlleles, clinvar: clinvar ?? [],
    transcriptViews: pos ? transcriptViews(gene, pos, o.alt ? (o.ref ?? residue?.aa) : (residueAlleles[0]?.ref ?? o.ref ?? residue?.aa), o.alt, alleles, o.typed) : [],
    genomic: genomic ?? { grch38: null, grch37: null }, notes: o.notes ?? [],
    releases: { gnomad: ctx.meta.releases?.gnomad?.label, clinvar: ctx.meta.releases?.clinvar?.label },
  };
  if (o.alts) r.alts = o.alts;
  return r;
}

// =================================================================== protein changes, residues

/** Readings of a typed protein position on one receptor, best first. */
function readingsFor(gene, ch, accession) {
  const out = [];
  const txs = gene.txs;
  const add = (tier, pos, how, extra = {}) => { if (pos && !out.some((r) => r.pos === pos && r.tier <= tier)) out.push({ tier, pos, how, ...extra }); };
  if (accession) {
    const t = findProtein(txs, accession);
    if (t) {
      add(0, mapPos(t.map, ch.pos), 'accession', { tx: t, map: t.map });
      return out;
    }
  }
  add(1, ch.pos, 'model');
  // the allele's own numbering (gnomAD hgvsp, ClinVar RefSeq numbering)
  for (const a of gene.vars?.alleles ?? []) {
    if (a.txPos === ch.pos && a.ref === ch.ref && (ch.kind !== 'missense' || a.alt === ch.alt)) add(1, a.pos, 'allele_numbering', { allele: a });
  }
  if (txs) {
    const tier2 = [maneTx(txs, 'refseq'), maneTx(txs, 'ensembl'), gnomadTx(txs), txs.tx.find((t) => t.src === 'uniprot')];
    for (const t of tier2) if (t) add(2, mapPos(t.map, ch.pos), t.src === 'uniprot' ? 'uniprot' : 'mane', { tx: t, map: t.map });
    for (const t of txs.tx) if (t.map && t.src !== 'uniprot') add(3, mapPos(t.map, ch.pos), 'isoform', { tx: t, map: t.map });
  }
  return out;
}

function findProtein(txs, accession) {
  if (!txs) return null;
  const [acc, v] = String(accession).toUpperCase().split('.');
  const cands = txs.tx.filter((t) => t.p && t.p.toUpperCase() === acc.split('-')[0] || (t.src === 'uniprot' && t.id.toUpperCase() === acc));
  const exact = cands.find((t) => !v || t.pv === Number(v));
  if (exact) return exact;
  // harvested RefSeq versions (NP_683765.1 = NM_148962.4)
  for (const [nm, e] of Object.entries(txs.nm ?? {})) {
    if (e.np && e.np.toUpperCase() === `${acc}${v ? `.${v}` : ''}`) return { id: nm, p: e.np, src: 'refseq', asm: null, map: e.map, harvested: e };
  }
  return cands[0] ?? null;
}

/** Evaluate one reading at model position P. */
function evaluate(gene, ch, P) {
  const seq = gene.res?.seq ?? '';
  if (!(P >= 1 && P <= seq.length)) return { status: 'outside' };
  const model = seq[P - 1];
  const here = gene.vars?.byPos.get(P) ?? [];
  if (ch.kind === 'missense') {
    const exact = here.filter((a) => a.ref === ch.ref && a.alt === ch.alt);
    if (exact.length) return { status: 'allele', alleles: exact, ref: ch.ref, alt: ch.alt, model, conflict: exact.some((a) => a.conflict) };
    const swapped = here.filter((a) => a.ref === ch.alt && a.alt === ch.ref);
    const cvExact = (gene.vars?.clinvar ?? []).some((c) => c.pos === P && c.packed && c.ref === ch.ref && c.alt === ch.alt);
    if (model === ch.ref) {
      if (!cvExact && swapped.length && swapped.every((a) => a.conflict)) return { status: 'allele', alleles: swapped, ref: ch.alt, alt: ch.ref, model, conflict: true };
      return { status: cvExact ? 'allele' : 'model', alleles: [], ref: ch.ref, alt: ch.alt, model };
    }
    if (cvExact) return { status: 'allele', alleles: [], ref: ch.ref, alt: ch.alt, model, conflict: true };
    if (swapped.length) return { status: 'swap', alleles: swapped, ref: ch.alt, alt: ch.ref, model, conflict: swapped.some((a) => a.conflict) };
    return { status: 'mismatch', model };
  }
  if (!ch.ref || model === ch.ref) return { status: 'model', alleles: [], ref: model, model };
  const txRef = here.filter((a) => a.ref === ch.ref);
  if (txRef.length) return { status: 'model', alleles: [], ref: model, model, typedTxRef: true };
  if (ch.kind === 'residue') {
    const altMatch = here.filter((a) => a.alt === ch.ref);
    if (altMatch.length) return { status: 'alt_match', alleles: altMatch, ref: model, model };
  }
  return { status: 'mismatch', model };
}

const STATUS_GOOD = new Set(['allele', 'model']);

async function resolveChangeInterp(ctx, i) {
  const ch = i.change;
  const r = receptorsOf(ctx.meta, i);
  if (r.status === 'absent') {
    if (ch.accession) {
      const idx = (await ctx.S.txindex())?.[ch.accession.split('.')[0].toUpperCase()]?.[0];
      if (idx !== undefined) return resolveChange(ctx, ctx.meta.receptors[idx].gid, ch, i, `${ch.accession}${ch.version ? `.${ch.version}` : ''}`);
      return answer('not_in_resource', [], { interpretation: i, message: `${ch.accession} is not a protein of the 283 receptors in this database.` });
    }
    return resolveBareChange(ctx, i);
  }
  if (r.status === 'none') return unknownReceptor(ctx.meta, r.term, i);
  if (r.gids.length > 1 && r.status === 'exact') {
    const results = [];
    for (const g of r.gids) {
      const a = await resolveChange(ctx, g, ch, i, null);
      if (a.results[0]) results.push(a.results[0]);
    }
    return answer('ambiguous', results, { interpretation: i, message: `"${r.term}" names ${r.gids.length} receptors.` });
  }
  const accession = ch.accession ? `${ch.accession}${ch.version ? `.${ch.version}` : ''}` : (r.rid?.type === 'uniprot' ? r.rid.value : null);
  return resolveChange(ctx, r.gids[0], ch, i, accession);
}

async function resolveChange(ctx, gid, ch, i, accession) {
  const gene = await loadGene(ctx, gid);
  if (!gene.res) return answer('not_in_resource', [], { interpretation: i });
  const label = `${ctx.meta.byGid.get(gid)?.symbol ?? gid}`;
  if (ch.pos === null || ch.pos === undefined) {
    const res = await makeResult(ctx, gid, null, { gene, type: 'not_in_resource', alt: ch.alt, kind: ch.kind, notes: [note('not_in_resource', `${ch.label ?? 'This variant'} is a ${ch.alt === 'del' ? 'deletion' : 'non-missense change'}; the database analyses single-residue missense changes only.`)] });
    return answer('not_in_resource', [res], { interpretation: i, message: res.notes[0].text });
  }
  const readings = readingsFor(gene, ch, accession).map((rd) => ({ ...rd, ev: evaluate(gene, ch, rd.pos) }));
  const pick = (pred) => readings.find(pred);
  const t1 = readings.filter((x) => x.tier <= 1);
  let chosen = null;
  let alternates = [];
  const modelR = t1.find((x) => x.how === 'model' || x.how === 'accession');
  const t1Allele = t1.filter((x) => x.ev.status === 'allele');
  if (modelR && modelR.ev.status === 'allele') chosen = modelR;
  else if (t1Allele.length) {
    chosen = t1Allele[0];
    if (modelR && modelR.ev.status === 'model' && modelR.pos !== chosen.pos) {
      alternates.push({ kind: 'change', gid, pos: modelR.pos, ref: ch.ref, alt: ch.alt, label: `${label} ${proteinText(ch.ref, modelR.pos, ch.alt)} in model numbering (no allele recorded)` });
    }
  } else if (modelR && STATUS_GOOD.has(modelR.ev.status)) chosen = modelR;
  else chosen = pick((x) => x.tier === 2 && STATUS_GOOD.has(x.ev.status))
    ?? pick((x) => x.tier <= 1 && x.ev.status === 'swap')
    ?? pick((x) => x.tier === 1 && x.ev.status === 'alt_match')
    ?? pick((x) => x.tier === 3 && x.ev.status === 'allele' && x.ev.alleles.length)
    ?? pick((x) => x.tier === 2 && x.ev.status === 'swap');

  if (!chosen) {
    // a gnomAD allele the pack dropped (outside the modelled sequence)
    const typed = proteinText(ch.ref, ch.pos, ch.kind === 'missense' ? ch.alt : null);
    const drop = gene.vars?.dropped.find((d) => d[1] === typed);
    if (drop) {
      const res = await makeResult(ctx, gid, null, { gene, type: 'not_in_resource', ref: ch.ref, alt: ch.alt, kind: ch.kind, notes: [note('outside_model', `${label} ${typed} (gnomAD ${drop[0]}): ${drop[2]}.`)] });
      res.genomic = { grch38: drop[0], grch37: null };
      return answer('not_in_resource', [res], { interpretation: i, message: res.notes[0].text });
    }
    const P = modelR?.pos;
    const inModel = P >= 1 && P <= gene.res.length;
    const msg = inModel ? `Position ${P} is ${three(gene.res.seq[P - 1])} in ${label}, not ${three(ch.ref)}.` : `${label} has ${gene.res.length} residues; there is no residue ${ch.pos}.`;
    const res = await makeResult(ctx, gid, inModel ? P : null, { gene, type: 'not_in_resource', ref: inModel ? gene.res.seq[P - 1] : null, alt: ch.alt ?? null, kind: ch.kind, notes: [note('reference_mismatch', msg)] });
    if (!inModel) res.ref = null;
    return answer('not_in_resource', [res], { interpretation: i, message: msg });
  }

  const ev = chosen.ev;
  const notes = [];
  if (chosen.how === 'allele_numbering') notes.push(note('offset_mapping', `${proteinText(ch.ref, ch.pos, ch.alt)} is numbered on the gnomAD/ClinVar transcript; it is residue ${chosen.pos} in the model.`));
  if (chosen.how === 'mane' || chosen.how === 'uniprot') notes.push(note('offset_mapping', `Read in ${chosen.how === 'uniprot' ? 'UniProt' : `${txKey(chosen.tx)}`} numbering: residue ${ch.pos} there is residue ${chosen.pos} in the model.`));
  if (chosen.how === 'isoform') notes.push(note('isoform_mapping', `Residue ${ch.pos} of the isoform ${txKey(chosen.tx)} is residue ${chosen.pos} of the model (another protein isoform).`));
  if (chosen.how === 'accession' && chosen.map && chosen.map[0] !== '=') notes.push(note('offset_mapping', `Residue ${ch.pos} of ${accession} is residue ${chosen.pos} of the model.`));
  if (chosen.tx?.harvested) notes.push(note('version_mismatch', `${accession} is an older RefSeq version; read through its own protein.`));
  if (ev.status === 'swap') notes.push(note(ev.conflict ? 'model_conflict' : 'reference_swap', ev.conflict ? `The model residue at ${chosen.pos} differs from the reference genome.` : `Listed the other way round: the reference residue at ${chosen.pos} is ${three(ev.ref)}, so this is ${proteinText(ev.ref, chosen.pos, ev.alt)}.`));
  if (ev.conflict && ev.status !== 'swap') notes.push(note('model_conflict', `The model has ${three(ev.model)} at ${chosen.pos}; the reference genome transcript has ${three(ev.ref)}.`));
  if (ev.status === 'alt_match') notes.push(note('typed_residue_differs', `Position ${chosen.pos} is ${three(ev.model)} in ${label}; ${three(ch.ref)} is a recorded variant there.`));
  if (ev.typedTxRef) notes.push(note('model_conflict', `The model has ${three(ev.model)} at ${chosen.pos}; the reference genome transcript has ${three(ch.ref)}.`));

  if (NONMISSENSE.has(ch.kind)) {
    const res = await makeResult(ctx, gid, chosen.pos, { gene, type: 'not_in_resource', ref: gene.res.seq[chosen.pos - 1], alt: ch.alt, kind: ch.kind, notes: [...notes, note('not_in_resource', `${kindText(ch.kind)} changes are not analysed here; the residue is shown.`)] });
    return answer('not_in_resource', [res], { interpretation: i, message: res.notes[res.notes.length - 1].text, alternates });
  }
  if (ch.kind === 'residue') {
    const res = await makeResult(ctx, gid, chosen.pos, { gene, ref: gene.res.seq[chosen.pos - 1], alt: null, kind: 'residue', alleles: ev.status === 'alt_match' ? ev.alleles : [], notes });
    if (chosen.how === 'model') alternates = alternates.concat(otherNumberings(gene, ch, chosen.pos, label));
    return answer('target', [res], { interpretation: i, alternates });
  }
  const res = await makeResult(ctx, gid, chosen.pos, { gene, ref: ev.ref, alt: ev.alt, kind: 'missense', alleles: ev.alleles, notes });
  if (alternates.length) return answer('ambiguous', [res], { interpretation: i, alternates, message: 'Two numberings fit; the one that names a recorded allele is shown first.' });
  return answer('target', [res], { interpretation: i, alternates });
}

function kindText(k) {
  return { stop: 'Nonsense (stop)', synonymous: 'Synonymous', frameshift: 'Frameshift', indel: 'Insertion and deletion', start: 'Start-loss', ext: 'Extension' }[k] ?? 'These';
}

/** "Did you mean": the same residue number read on MANE / UniProt when they differ from the model. */
function otherNumberings(gene, ch, modelPos, label) {
  const out = [];
  for (const rd of readingsFor(gene, ch, null)) {
    if (rd.tier !== 2 || rd.pos === modelPos || !(rd.pos >= 1 && rd.pos <= gene.res.length)) continue;
    if (out.some((o) => o.pos === rd.pos)) continue;
    const aa = gene.res.seq[rd.pos - 1];
    out.push({ kind: 'residue', gid: gene.gid, pos: rd.pos, ref: aa, label: `${label} residue ${ch.pos} in ${rd.how === 'uniprot' ? 'UniProt' : txKey(rd.tx)} numbering = ${three(aa)}${rd.pos}` });
  }
  return out;
}

/** A change or residue with no receptor: every receptor with that residue at that position. */
async function resolveBareChange(ctx, i) {
  const ch = i.change;
  if (ch.pos === null) return answer('not_in_resource', [], { interpretation: i, message: 'Name the receptor for this variant.' });
  const gids = await receptorsWithResidue(ctx, ch.pos, ch.ref);
  if (!gids.length) return answer('not_in_resource', [], { interpretation: i, message: `No receptor in the database has ${three(ch.ref)} at position ${ch.pos}.` });
  const results = [];
  for (const gid of gids) {
    const gene = await loadGene(ctx, gid);
    const here = gene.vars?.byPos.get(ch.pos) ?? [];
    if (ch.kind === 'missense') {
      const al = here.filter((a) => a.ref === ch.ref && a.alt === ch.alt);
      const cv = (gene.vars?.clinvar ?? []).filter((c) => c.pos === ch.pos && c.alt === ch.alt);
      results.push(await makeResult(ctx, gid, ch.pos, { gene, ref: ch.ref, alt: ch.alt, alleles: al, clinvar: cv, kind: 'missense' }));
    } else if (ch.kind === 'residue') {
      results.push(await makeResult(ctx, gid, ch.pos, { gene, kind: 'residue' }));
    } else {
      results.push(await makeResult(ctx, gid, ch.pos, { gene, type: 'not_in_resource', alt: ch.alt, kind: ch.kind }));
    }
  }
  // README decision 3: observed substitution first, then a matching reference residue, then symbol
  results.sort((a, b) => (b.alleles.length + b.clinvar.length > 0) - (a.alleles.length + a.clinvar.length > 0) || String(a.receptor.symbol).localeCompare(String(b.receptor.symbol)));
  if (NONMISSENSE.has(ch.kind)) return answer('not_in_resource', results, { interpretation: i, message: `${kindText(ch.kind)} changes are not analysed here.` });
  return answer('targets', results, { interpretation: i });
}

// ======================================================================== generic numbers

async function resolveGenericInterp(ctx, i) {
  const g = i.generic;
  const r = receptorsOf(ctx.meta, i);
  if (r.status === 'none') return unknownReceptor(ctx.meta, r.term, i);
  if (r.status === 'absent') {
    if (g.form === 'space') return answer('ambiguous', [], { interpretation: i, alternates: [{ kind: 'generic', display: `${g.bw}x${g.bw.split('.')[1]}`, label: `generic residue number ${g.bw}` }], message: `Read "${g.display}" as the generic residue number ${g.bw}.` });
    return resolveBareGeneric(ctx, i);
  }
  const gid = r.gids[0];
  const gene = await loadGene(ctx, gid);
  const label = ctx.meta.byGid.get(gid)?.symbol ?? gid;
  const hits = gene.res.findGeneric(g.bw, g.gpcrdb);
  if (!hits.length) return answer('not_in_resource', [await makeResult(ctx, gid, null, { gene, type: 'not_in_resource', notes: [note('not_in_resource', `${label} has no residue at ${g.display}.`)] })], { interpretation: i, message: `${label} has no residue at ${g.display}.` });
  const P = hits[0];
  const aa = gene.res.seq[P - 1];
  const res = gene.res.residue(P);
  const notes = [];
  if (g.residueLetter && g.residueLetter !== aa) {
    const msg = `${g.display} is ${three(aa)}${P} in ${label}, not ${three(g.residueLetter)}.`;
    return answer('not_in_resource', [await makeResult(ctx, gid, P, { gene, type: 'not_in_resource', ref: aa, kind: 'residue', notes: [note('reference_mismatch', msg)] })], { interpretation: i, message: msg });
  }
  if (g.residueNumber && g.residueNumber !== P) notes.push(note('generic_number_differs', `${res.generic} is residue ${P} in ${label}; residue ${g.residueNumber} is ${three(gene.res.seq[g.residueNumber - 1] ?? '')} (the generic number is used).`));
  return answer('target', [await makeResult(ctx, gid, P, { gene, kind: 'residue', notes })], { interpretation: i });
}

async function resolveBareGeneric(ctx, i) {
  const g = i.generic;
  const shard = await ctx.S.generic(g.segment);
  const results = [];
  for (const [disp, rows] of Object.entries(shard ?? {})) {
    const [b, x] = disp.split('x');
    const gx = `${b.split('.')[0]}x${x}`;
    if ((g.bw && g.bw !== b) || (g.gpcrdb && g.gpcrdb !== gx)) continue;
    for (const [idx, pos, aa] of rows) {
      if (g.residueLetter && aa !== g.residueLetter) continue;
      // light results: no residue card, views or alleles (283 receptors); load the receptor for those
      results.push({ type: 'target', light: true, gid: ctx.meta.receptors[idx].gid, receptor: receptorInfo(ctx.meta, ctx.meta.receptors[idx].gid), pos, ref: aa, alt: null, kind: 'residue', generic: disp, residue: null, alleles: [], residueAlleles: [], clinvar: [], transcriptViews: [], genomic: { grch38: null, grch37: null }, notes: [] });
    }
  }
  if (!results.length) return answer('not_in_resource', [], { interpretation: i, message: `No receptor has a residue at ${g.display}${g.residueLetter ? ` with ${three(g.residueLetter)}` : ''}.` });
  results.sort((a, b) => String(a.receptor.symbol).localeCompare(String(b.receptor.symbol)));
  return answer('targets', results, { interpretation: i, message: `${results.length} receptors have a residue at ${g.display}. Load a receptor for its full card.` });
}

/** Alternate readings that also resolve (used for '6 48'-style ambiguity). */
async function alternatesFrom(ctx, list) {
  const out = [];
  for (const i of list) {
    if (i.kind !== 'residue' && i.kind !== 'protein') continue;
    const a = await resolveOne(ctx, i);
    const r = a?.results?.[0];
    if (a && POSITIVE.has(a.expect) && r) out.push({ kind: 'residue', gid: r.gid, pos: r.pos, ref: r.ref, label: `${r.receptor.symbol} residue ${three(r.ref)}${r.pos}` });
  }
  return out;
}

// ============================================================================ coding (c.)

/** Find the transcript a c. names: {gene, tx, notes} or an answer when it cannot be placed. */
async function codingTarget(ctx, i) {
  const cd = i.cdna;
  const notes = [];
  if (cd.transcript) {
    const acc = cd.transcript.toUpperCase();
    const idxs = (await ctx.S.txindex())?.[acc] ?? [];
    if (!idxs.length) return { answer: answer('not_in_resource', [], { interpretation: i, message: `${cd.transcript} is not a transcript of the 283 receptors in this database.` }) };
    // an accession two genes share (LTB4R/LTB4R2): the gene holding this exact version, else the first
    let gene = null;
    for (const idx of idxs) {
      const gn = await loadGene(ctx, ctx.meta.receptors[idx].gid);
      const has = gn.txs?.tx.some((t) => t.id.split('@')[0].toUpperCase() === acc && (cd.version == null || t.v === cd.version));
      if (has) { gene = gn; break; }
      gene ??= gn;
    }
    const gid = gene.gid;
    const txs = gene.txs;
    const same = txs.tx.filter((t) => t.id.split('@')[0].toUpperCase() === acc && t.src !== 'uniprot');
    const v = cd.version;
    let tx = null;
    if (v !== null && v !== undefined) {
      // exact version; the gnomAD-frame record wins the shared ENST label (README decision 6)
      tx = same.find((t) => t.v === v && !t.id.includes('@') && t.asm === 'GRCh38') ?? same.find((t) => t.v === v && !t.id.includes('@'))
        ?? same.find((t) => (t.alsoV ?? []).includes(v));
      if (tx && tx.frame === 'gnomad') notes.push(note('gnomad_frame', `${acc}.${v} is read in the frame gnomAD v4.1 uses, which starts ${txs.gnomadFrame?.cOffset ?? ''} nt upstream of today's Ensembl CDS.`));
      if (tx && tx.asm === 'GRCh37') notes.push(note('version_mismatch', `${acc}.${v} is the GRCh37 (Ensembl/RefSeq hg19) version; the current version is .${same.find((t) => t.asm === 'GRCh38')?.v ?? '?'}.`));
      if (!tx) {
        const h = txs.nm?.[`${acc}.${v}`];
        if (h) {
          if (['current', 'cds_identical'].includes(h.rel) && h.to) {
            const [tid, tv] = h.to.split('.');
            tx = txs.tx.find((t) => t.id === tid && t.v === Number(tv) && t.asm === h.toAsm) ?? txs.tx.find((t) => t.id === tid && t.v === Number(tv));
            if (tx) notes.push(note('version_mismatch', `${acc}.${v} has the same coding sequence as ${h.to}; read on ${h.to}.`));
          }
          if (!tx) return { answer: answer('not_in_resource', [await makeResult(ctx, gid, null, { gene, type: 'not_in_resource', notes: [note('version_mismatch', `${acc}.${v} differs from the current transcripts (${h.rel.replace('_', ' ')}); this version is not mapped.`)] })], { interpretation: i, message: `${acc}.${v} is not mapped: its coding sequence differs from the current version.` }) };
        }
      }
      if (!tx) {
        tx = same.find((t) => t.asm === 'GRCh38' && !t.id.includes('@')) ?? same[0];
        if (tx) notes.push(note('version_mismatch', `${acc}.${v} is not in our tables; read on ${txKey(tx)} (the change is checked against its reference base).`));
      }
    } else {
      tx = same.find((t) => t.asm === 'GRCh38' && !t.id.includes('@')) ?? same[0];
      if (tx) notes.push(note('version_mismatch', `No version given; read on ${txKey(tx)}.`));
    }
    if (!tx) return { answer: answer('not_in_resource', [], { interpretation: i, message: `${cd.transcript} is not mapped.` }) };
    return { gene, tx, notes };
  }
  const r = receptorsOf(ctx.meta, i);
  if (r.status === 'none') return { answer: unknownReceptor(ctx.meta, r.term, i) };
  if (r.status === 'absent') return { bare: true };
  const gid = r.gids[0];
  const gene = await loadGene(ctx, gid);
  if (!gene.txs) {
    // pseudogene: no transcript; the residue is the codon in model numbering
    const P = cd.region === 'cds' ? Math.ceil(cd.pos / 3) : null;
    const msg = `${ctx.meta.byGid.get(gid)?.symbol ?? gid} has no coding transcript in this resource (pseudogene); a c. change cannot be placed${P ? `, residue ${P} assumes the model numbering` : ''}.`;
    const res = await makeResult(ctx, gid, P && P <= gene.res.length ? P : null, { gene, type: 'not_in_resource', kind: 'residue', notes: [note('no_coding_transcript', msg)] });
    return { answer: answer('not_in_resource', [res], { interpretation: i, message: msg }) };
  }
  const tx = gnomadTx(gene.txs) ?? maneTx(gene.txs);
  return { gene, tx, notes };
}

/** Last residue of a transcript's protein (CDS includes the stop codon). */
function lastResidue(tx) {
  return Math.floor(cdsLength(tx) / 3) - 1;
}

async function resolveCoding(ctx, i) {
  const cd = i.cdna;
  const where = await codingTarget(ctx, i);
  if (where.answer) return where.answer;
  if (where.bare) return resolveBareCoding(ctx, i);
  const { gene, tx } = where;
  const notes = [...where.notes];
  const gid = gene.gid;
  const label = ctx.meta.byGid.get(gid)?.symbol ?? gid;
  const lift = toG38(gene, tx);
  const typed = { tx };
  const modelOf = (txPos) => mapPos(tx.map, txPos);

  // outside the CDS: nearest residue
  if (cd.region !== 'cds' || (cd.offset ?? 0) !== 0) {
    let txPos;
    if (cd.region === '5utr' || (cd.region === 'intron' && cd.pos < 0)) txPos = 1;
    else if (cd.region === '3utr') txPos = lastResidue(tx);
    else txPos = Math.ceil(cd.pos / 3);
    const P = modelOf(txPos);
    const what = cd.region === '5utr' ? "the 5' UTR" : cd.region === '3utr' ? "the 3' UTR" : 'an intron';
    const msg = `${label} c.${cText({ pos: cd.pos, offset: cd.offset, region: cd.region })} lies in ${what}, outside the coding sequence; the nearest residue is ${P ? `${three(gene.res.seq[P - 1])}${P}` : 'outside the model'}.`;
    const g = cToG(tx, cd.pos, cd.offset ?? 0, cd.region === 'intron' ? 'cds' : cd.region);
    const g38 = g === null ? null : lift.f(g);
    const res = await makeResult(ctx, gid, P, { gene, type: 'not_coding', kind: 'residue', notes: [...notes, note('not_coding', msg)], typed, genomic: genomicIds(gene, g38, null, null) });
    return answer('not_coding', [res], { interpretation: i, message: msg });
  }

  const txPos = Math.ceil(cd.pos / 3);
  if (cd.pos > cdsLength(tx)) {
    const msg = `${txKey(tx)} has a ${cdsLength(tx)}-nt coding sequence; c.${cd.pos} is beyond it.`;
    return answer('not_in_resource', [await makeResult(ctx, gid, null, { gene, type: 'not_in_resource', notes: [...notes, note('not_in_resource', msg)] })], { interpretation: i, message: msg });
  }
  const P = modelOf(txPos);
  const g0 = cToG(tx, cd.pos);
  const g38 = g0 === null ? null : lift.f(g0);
  if (tx.asm === 'GRCh37') notes.push(note('assembly_detected', `${txKey(tx)} is placed on GRCh37 and lifted to GRCh38.`));
  // reference base
  const base38 = g38 === null ? null : baseAt(gene.bases, g38);
  const txBase = base38 === null ? null : (lift.strand === 1 ? base38 : complement(base38));
  const codon = codonAt(tx, txPos, gene.bases, lift.f, lift.strand);
  const refAA = codon.codon ? translate(codon.codon) : null;

  // non-substitution operations: the class comes from the (p.) part when given, else from the length
  if (cd.op !== 'sub') {
    let alt; let kind;
    if (i.change && i.change.kind) { alt = i.change.alt; kind = i.change.kind; }
    else if (cd.op === '=') { alt = '='; kind = 'synonymous'; }
    else {
      const len = cd.end ? cd.end.pos - cd.pos + 1 : 1;
      const ins = cd.inserted && /^[ACGT]+$/.test(cd.inserted) ? cd.inserted.length : null;
      const net = cd.op === 'del' ? -len : cd.op === 'dup' ? len : cd.op === 'ins' ? (ins ?? 1) : cd.op === 'delins' ? (ins ?? 0) - len : 0;
      alt = net % 3 !== 0 ? 'fs' : cd.op === 'repeat' ? 'dup' : cd.op;
      kind = net % 3 !== 0 ? 'frameshift' : 'indel';
    }
    const Pc = i.change?.pos ? modelOf(i.change.pos) ?? P : P;
    if (kind === 'missense') {
      const res = await makeResult(ctx, gid, Pc, { gene, ref: i.change.ref, alt, kind, notes: [...notes, note('multi_nucleotide', 'A multi-nucleotide change giving a single missense substitution.')], typed });
      return answer('target', [res], { interpretation: i });
    }
    const msg = `${kindText(kind)} changes are not analysed here; the residue is shown.`;
    const res = await makeResult(ctx, gid, Pc, { gene, type: 'not_in_resource', ref: Pc ? gene.res.seq[Pc - 1] : null, alt, kind, notes: [...notes, note('not_in_resource', msg)], typed });
    return answer('not_in_resource', [res], { interpretation: i, message: msg });
  }

  if (txBase && cd.ref && txBase !== cd.ref) {
    const msg = `${txKey(tx)} c.${cd.pos} is ${cd.ref} in your input but ${txBase} in the reference genome.`;
    const res = await makeResult(ctx, gid, P, { gene, type: 'not_in_resource', ref: P ? gene.res.seq[P - 1] : null, kind: 'residue', notes: [...notes, note('reference_mismatch', msg)], typed });
    return answer('not_in_resource', [res], { interpretation: i, message: msg });
  }
  let altAA = null;
  if (codon.codon) {
    const k = (cd.pos - 1) % 3;
    altAA = translate(codon.codon.slice(0, k) + cd.alt + codon.codon.slice(k + 1));
  } else if (i.change?.kind === 'missense') altAA = i.change.alt;
  if (!txBase) notes.push(note('reference_unchecked', 'The reference base could not be checked here.'));
  // the allele, when gnomAD has it
  let alleles = [];
  if (g38 !== null) {
    const r38 = lift.strand === 1 ? cd.ref : complement(cd.ref);
    const a38 = lift.strand === 1 ? cd.alt : complement(cd.alt);
    alleles = (gene.vars?.byG38.get(g38) ?? []).filter((a) => a.ref38 === r38 && a.alt38 === a38);
  }
  const ref = alleles[0]?.ref ?? refAA ?? (P ? gene.res.seq[P - 1] : null);
  if (alleles[0]?.conflict) notes.push(note('model_conflict', `The model has ${three(gene.res.seq[P - 1])} at ${P}; the reference genome transcript has ${three(alleles[0].ref)}.`));
  if (!P) {
    const msg = `Residue ${txPos} of ${txKey(tx)} is outside the modelled sequence of ${label}.`;
    const res = await makeResult(ctx, gid, null, { gene, type: 'not_in_resource', notes: [...notes, note('outside_model', msg)], typed, genomic: genomicIds(gene, g38, cd.ref, cd.alt, lift.strand) });
    return answer('not_in_resource', [res], { interpretation: i, message: msg });
  }
  if (tx.map && tx.map[0] !== '=') notes.push(note('offset_mapping', `Residue ${txPos} of ${txKey(tx)} is residue ${P} of the model.`));
  const genomic = alleles.length ? { grch38: alleles[0].id, grch37: alleles[0].id37 } : genomicIds(gene, g38, cd.ref, cd.alt, lift.strand);
  typed.c = `c.${cd.pos}${cd.ref}>${cd.alt}`;
  if (altAA === ref || altAA === null && refAA === null) {
    if (altAA === ref) {
      const msg = 'This change is synonymous; synonymous changes are not analysed here.';
      const res = await makeResult(ctx, gid, P, { gene, type: 'not_in_resource', ref: gene.res.seq[P - 1], alt: '=', kind: 'synonymous', notes: [...notes, note('not_in_resource', msg)], typed, genomic });
      return answer('not_in_resource', [res], { interpretation: i, message: msg });
    }
  }
  if (altAA === '*') {
    const msg = 'This change makes a stop codon; nonsense changes are not analysed here.';
    const res = await makeResult(ctx, gid, P, { gene, type: 'not_in_resource', ref: gene.res.seq[P - 1], alt: '*', kind: 'stop', notes: [...notes, note('not_in_resource', msg)], typed, genomic });
    return answer('not_in_resource', [res], { interpretation: i, message: msg });
  }
  const res = await makeResult(ctx, gid, P, { gene, ref, alt: altAA, kind: altAA ? 'missense' : 'residue', alleles, notes, typed, genomic });
  return answer('target', [res], { interpretation: i });
}

/** gnomAD-style ids for a GRCh38 position (and its GRCh37 lift). */
function genomicIds(gene, g38, ref, alt, strand = 1) {
  if (g38 === null || g38 === undefined) return { grch38: null, grch37: null };
  const chrom = gene.vars?.chrom ?? gene.bases?.chrom ?? gene.txs?.tx[0]?.chrom;
  const l = lift38to37(gene.txs?.lift, g38);
  if (!ref || !alt) return { grch38: `${chrom}:${g38}`, grch37: l ? `${l.chrom}:${l.pos}` : null };
  const r = strand === 1 ? ref : complement(ref);
  const a = strand === 1 ? alt : complement(alt);
  const r37 = l && l.strand === -1 ? complement(r) : r;
  const a37 = l && l.strand === -1 ? complement(a) : a;
  return { grch38: `${chrom}-${g38}-${r}-${a}`, grch37: l ? `${l.chrom}-${l.pos}-${r37}-${a37}` : null };
}

/** A c. with no transcript and no receptor: every receptor whose gnomAD transcript has that change. */
async function resolveBareCoding(ctx, i) {
  const cd = i.cdna;
  if (cd.op !== 'sub' || cd.region !== 'cds' || cd.offset) return answer('not_in_resource', [], { interpretation: i, message: 'Name the receptor or transcript for this c. change.' });
  const shard = await ctx.S.hgvsc(cd.pos);
  const idxs = shard[`${cd.pos}${cd.ref}>${cd.alt}`] ?? [];
  if (!idxs.length) return answer('not_in_resource', [], { interpretation: i, message: `No gnomAD allele c.${cd.pos}${cd.ref}>${cd.alt} on any receptor's gnomAD transcript; name the receptor.` });
  const results = [];
  for (const idx of idxs) {
    const gid = ctx.meta.receptors[idx].gid;
    const a = await resolveCoding(ctx, { ...i, receptorTerm: gid, receptorMatches: [{ gid, exact: true }] });
    if (a.results[0]) results.push(a.results[0]);
  }
  results.sort((a, b) => String(a.receptor.symbol).localeCompare(String(b.receptor.symbol)));
  return answer('targets', results, { interpretation: i, message: `c.${cd.pos}${cd.ref}>${cd.alt} is a gnomAD allele in ${results.length} receptors.` });
}

// ========================================================================== genomic (g.)

function inWindow(w, chrom, pos) { return String(w[0]) === String(chrom) && w[1] <= pos && pos <= w[2]; }

async function resolveGenomic(ctx, i) {
  const g = { ...i.genomic };
  const notes = [];
  const meta = ctx.meta;
  // PAR1 on Y: gnomAD lists the X copy only (README rule 12)
  if (g.chrom === 'Y') {
    const asm = g.assemblyHint ?? 'GRCh38';
    const [lo, hi] = PAR1[asm];
    if (g.pos >= lo && g.pos <= hi) { g.chrom = 'X'; notes.push(note('par_y', 'A pseudo-autosomal (PAR1) position on Y; gnomAD lists it on X.')); }
  }
  const windows = (asm, flank) => meta.windows[asm].filter((w) => inWindow(flank ? [w[0], w[1] - flank, w[2] + flank] : w, g.chrom, g.pos));
  const onAssembly = async (asm, flank) => {
    const hits = windows(asm, flank);
    let last = null;
    for (const w of hits) {
      const a = await genomicOnGene(ctx, i, g, meta.receptors[w[3]].gid, asm, notes);
      a.assembly = asm;
      if (POSITIVE.has(a.expect)) return a;
      last ??= a;
    }
    return last;
  };
  const flag = (a, text) => { for (const r of a.results) r.notes = [note('assembly_detected', text), ...(r.notes ?? [])]; return a; };
  if (g.assemblyHint) {
    return (await onAssembly(g.assemblyHint, 0)) ?? (await onAssembly(g.assemblyHint, FLANK))
      ?? answer('not_in_resource', [], { interpretation: i, assembly: g.assemblyHint, message: `${g.chrom}:${g.pos} (${g.assemblyHint}) is not inside any of the 283 receptor genes.` });
  }
  // README rule 11: GRCh38 unless the position only makes sense on GRCh37. A GRCh37 position can fall
  // inside the same gene's GRCh38 window (genes that moved little); then GRCh38 lands outside the coding
  // sequence or on another base, and the GRCh37 reading that does land on the coding sequence wins.
  const a38 = await onAssembly('GRCh38', 0);
  const named = (a) => a.results.some((r) => r.alleles?.length || r.clinvar?.length);
  const a37 = windows('GRCh37', 0).length ? await onAssembly('GRCh37', 0) : null;
  if (a38 && POSITIVE.has(a38.expect) && (named(a38) || !g.ref)) {
    // the same coordinate also names a different recorded allele on GRCh37: offer that reading
    const r37 = a37 && POSITIVE.has(a37.expect) && named(a37) ? a37.results[0] : null;
    const r38 = a38.results[0];
    if (r37 && (r37.gid !== r38.gid || r37.pos !== r38.pos || r37.alleles[0]?.id !== r38.alleles[0]?.id)) {
      a38.alternates.push({ kind: 'genomic', assembly: 'GRCh37', gid: r37.gid, pos: r37.pos, ref: r37.ref, alt: r37.alt, allele: r37.alleles[0]?.id ?? null, label: `Read on GRCh37: ${r37.receptor.symbol} ${proteinText(r37.ref, r37.pos, r37.alt) ?? ''}${r37.alleles[0] ? ` (${r37.alleles[0].id})` : ''}` });
    }
    return a38;
  }
  if (a38 && POSITIVE.has(a38.expect)) {
    // GRCh38 lands on the coding sequence but names no recorded allele; GRCh37 names one
    if (a37 && POSITIVE.has(a37.expect) && named(a37)) {
      const r38 = a38.results[0];
      a37.alternates.push({ kind: 'genomic', assembly: 'GRCh38', gid: r38.gid, pos: r38.pos, ref: r38.ref, alt: r38.alt, label: `Read on GRCh38: ${r38.receptor.symbol} ${proteinText(r38.ref, r38.pos, r38.alt) ?? ''} (no recorded allele)` });
      return flag(a37, 'Read as GRCh37: this is a recorded allele on GRCh37, while on GRCh38 the same coordinate names no recorded allele.');
    }
    return a38;
  }
  if (a37 && POSITIVE.has(a37.expect)) {
    return flag(a37, a38 ? `Read as GRCh37: on GRCh38 this position ${a38.expect === 'not_coding' ? 'is outside the coding sequence' : 'does not match the reference'}.` : 'This position is outside every receptor on GRCh38 and inside one on GRCh37, so it is read as GRCh37.');
  }
  if (a38) return a38;
  if (a37) return flag(a37, 'This position is outside every receptor on GRCh38 and inside one on GRCh37, so it is read as GRCh37.');
  // near a gene (promoter, flanking sequence)
  const n38 = await onAssembly('GRCh38', FLANK);
  if (n38) return n38;
  const n37 = await onAssembly('GRCh37', FLANK);
  if (n37) return n37;
  return answer('not_in_resource', [], { interpretation: i, assembly: 'GRCh38', message: `${g.chrom}:${g.pos} is not inside any of the 283 receptor genes.` });
}

async function genomicOnGene(ctx, i, g, gid, assembly, notesIn) {
  const notes = [...notesIn];
  const gene = await loadGene(ctx, gid);
  const label = ctx.meta.byGid.get(gid)?.symbol ?? gid;
  let g38 = g.pos;
  let strand37 = 1;
  if (assembly === 'GRCh37') {
    const l = lift37to38(gene.txs?.lift, g.chrom, g.pos);
    if (!l) return answer('not_in_resource', [], { interpretation: i, message: `${g.chrom}:${g.pos} (GRCh37) could not be lifted to GRCh38.` });
    g38 = l.pos;
    strand37 = l.strand;
    if (l.approximate) notes.push(note('liftover_approximate', 'GRCh37 to GRCh38 used the nearest mapped block (outside the coding exons).'));
  }
  let ref = g.ref ?? null;
  let alt = g.alt ?? null;
  if (strand37 === -1 && ref) { ref = complement(ref); alt = alt ? complement(alt) : alt; }
  const here = gene.vars?.byG38.get(g38) ?? [];
  const snv = ref && alt && ref.length === 1 && alt.length === 1;
  // the gnomAD allele itself
  if (snv) {
    const al = here.filter((a) => a.ref38 === ref && a.alt38 === alt);
    if (al.length) {
      const a = al[0];
      const n = [...notes];
      if (a.conflict) n.push(note('model_conflict', `The model has ${three(gene.res.seq[a.pos - 1])} at ${a.pos}; the reference genome transcript has ${three(a.ref)}.`));
      const res = await makeResult(ctx, gid, a.pos, { gene, ref: a.ref, alt: a.alt, kind: 'missense', alleles: al, notes: n });
      return answer('target', [res], { interpretation: i });
    }
    const dropped = gene.vars?.dropped.find((d) => d[0] === `${g.chrom}-${g38}-${ref}-${alt}`);
    if (dropped) {
      const msg = `${label} ${dropped[1]} (${dropped[0]}): ${dropped[2]}.`;
      const res = await makeResult(ctx, gid, null, { gene, type: 'not_in_resource', notes: [...notes, note('outside_model', msg)], genomic: { grch38: dropped[0], grch37: null } });
      return answer('not_in_resource', [res], { interpretation: i, message: msg });
    }
  }
  // place it on a transcript: the gnomAD one, MANE, then any other with this position in its CDS
  const cands = [gnomadTx(gene.txs), maneTx(gene.txs), ...(gene.txs?.tx ?? []).filter((t) => t.asm === 'GRCh38' && t.src !== 'uniprot')].filter(Boolean);
  let tx = null; let c = null;
  for (const t of cands) {
    if (String(t.chrom) !== String(g.chrom)) continue;
    const cc = gToC(t, g38);
    if (cc && cc.region === 'cds' && cc.offset === 0) { tx = t; c = cc; break; }
  }
  if (!tx) {
    const t0 = cands.find((t) => String(t.chrom) === String(g.chrom));
    const cc = t0 ? gToC(t0, g38) : null;
    let near = null;
    if (cc && t0) {
      const txPos = cc.region === '5utr' || (cc.region === 'intron' && cc.pos < 0) ? 1 : cc.region === '3utr' || cc.edgeRegion === '3utr' ? lastResidue(t0) : Math.ceil(cc.pos / 3);
      near = mapPos(t0.map, txPos);
    }
    const msg = `${g.chrom}:${g.pos} (${assembly}) is in ${label} but outside its coding sequence${cc && t0 ? ` (${txKey(t0)} c.${cText(cc)})` : ''}${near ? `; the nearest residue is ${three(gene.res.seq[near - 1])}${near}` : ''}.`;
    const indel = g.op && g.op !== 'sub';
    const res = await makeResult(ctx, gid, indel ? null : near, { gene, type: 'not_coding', kind: 'residue', notes: [...notes, note('not_coding', msg)], genomic: genomicIds(gene, g38, null, null) });
    return answer('not_coding', [res], { interpretation: i, message: msg });
  }
  const txPos = Math.ceil(c.pos / 3);
  const P = mapPos(tx.map, txPos);
  const base = baseAt(gene.bases, g38);
  const typed = { tx };
  if (!P) {
    const msg = `${g.chrom}:${g.pos} is residue ${txPos} of ${txKey(tx)}, outside the modelled sequence of ${label}.`;
    return answer('not_in_resource', [await makeResult(ctx, gid, null, { gene, type: 'not_in_resource', notes: [...notes, note('outside_model', msg)], typed })], { interpretation: i, message: msg });
  }
  if (ref && base && ref.length === 1 && ref !== base) {
    const msg = `The reference genome has ${base} at ${g.chrom}:${g38} (GRCh38), not ${ref}.`;
    const res = await makeResult(ctx, gid, P, { gene, type: 'not_in_resource', ref: gene.res.seq[P - 1], kind: 'residue', notes: [...notes, note('reference_mismatch', msg)] });
    return answer('not_in_resource', [res], { interpretation: i, message: msg });
  }
  if (g.op && g.op !== 'sub') {
    const msg = 'Insertions, deletions and duplications are not analysed here; the residue is shown.';
    const res = await makeResult(ctx, gid, P, { gene, type: 'not_in_resource', ref: gene.res.seq[P - 1], alt: g.op, kind: 'indel', notes: [...notes, note('not_in_resource', msg)] });
    return answer('not_in_resource', [res], { interpretation: i, message: msg });
  }
  if (!snv) {
    // a locus: the residue and every allele at that position
    const alts = [...new Set(here.map((a) => a.alt))];
    const res = await makeResult(ctx, gid, P, { gene, ref: here[0]?.ref ?? gene.res.seq[P - 1], alt: alts.length === 1 ? alts[0] : null, alts: alts.length > 1 ? alts : undefined, kind: alts.length ? 'missense' : 'residue', alleles: here, notes, genomic: genomicIds(gene, g38, null, null) });
    return answer('target', [res], { interpretation: i });
  }
  // a substitution gnomAD does not list: derive the amino-acid change from the codon
  const codon = codonAt(tx, txPos, gene.bases);
  let refAA = null; let altAA = null;
  if (codon.codon) {
    const k = (c.pos - 1) % 3;
    const altBase = tx.strand === 1 ? alt : complement(alt);
    refAA = translate(codon.codon);
    altAA = translate(codon.codon.slice(0, k) + altBase + codon.codon.slice(k + 1));
  }
  const genomic = genomicIds(gene, g38, ref, alt);
  const cv = (gene.vars?.clinvar ?? []).filter((r) => r.gnomadId === genomic.grch38);
  if (cv.length) notes.push(note('clinvar_only', 'In ClinVar, not in gnomAD.'));
  if (altAA === refAA && altAA) {
    const msg = 'This change is synonymous; synonymous changes are not analysed here.';
    return answer('not_in_resource', [await makeResult(ctx, gid, P, { gene, type: 'not_in_resource', ref: gene.res.seq[P - 1], alt: '=', kind: 'synonymous', notes: [...notes, note('not_in_resource', msg)], genomic, clinvar: cv })], { interpretation: i, message: msg });
  }
  if (altAA === '*') {
    const msg = 'This change makes a stop codon; nonsense changes are not analysed here.';
    return answer('not_in_resource', [await makeResult(ctx, gid, P, { gene, type: 'not_in_resource', ref: gene.res.seq[P - 1], alt: '*', kind: 'stop', notes: [...notes, note('not_in_resource', msg)], genomic, clinvar: cv })], { interpretation: i, message: msg });
  }
  const res = await makeResult(ctx, gid, P, { gene, ref: refAA ?? gene.res.seq[P - 1], alt: altAA, kind: altAA ? 'missense' : 'residue', alleles: [], notes: [...notes, note('not_in_gnomad', 'This substitution is not in gnomAD; the amino-acid change is read from the codon.')], genomic, clinvar: cv.length ? cv : undefined, typed: { tx, c: `c.${c.pos}${tx.strand === 1 ? ref : complement(ref)}>${tx.strand === 1 ? alt : complement(alt)}` } });
  return answer('target', [res], { interpretation: i });
}

// ================================================================================= rsIDs

async function resolveRsid(ctx, i) {
  const rs = i.ids.rsid;
  const n = Number(rs.slice(2));
  const map = await ctx.S.rsid(n);
  let idxs = map.get(n) ?? [];
  const r = receptorsOf(ctx.meta, i);
  if (r.status === 'exact') idxs = idxs.filter((x) => r.gids.includes(ctx.meta.receptors[x].gid));
  if (!idxs.length) return answer('not_in_resource', [], { interpretation: i, message: `${rs} is not a missense allele held here (gnomAD v4.1.2 missense alleles of the 283 receptors).` });
  const groups = [];
  for (const idx of idxs) {
    const gid = ctx.meta.receptors[idx].gid;
    const gene = await loadGene(ctx, gid);
    for (const a of gene.vars.alleles.filter((x) => x.rsids.includes(rs))) {
      const k = `${gid}:${a.pos}`;
      let grp = groups.find((x) => x.k === k);
      if (!grp) { grp = { k, gid, gene, pos: a.pos, alleles: [] }; groups.push(grp); }
      grp.alleles.push(a);
    }
  }
  const results = [];
  for (const grp of groups) {
    const alts = [...new Set(grp.alleles.map((a) => a.alt))];
    const a0 = grp.alleles[0];
    const notes = a0.conflict ? [note('model_conflict', `The model has ${three(grp.gene.res.seq[a0.pos - 1])} at ${a0.pos}; the reference genome transcript has ${three(a0.ref)}.`)] : [];
    results.push(await makeResult(ctx, grp.gid, grp.pos, { gene: grp.gene, ref: a0.ref, alt: alts.length === 1 ? alts[0] : null, alts: alts.length > 1 ? alts : undefined, kind: 'missense', alleles: grp.alleles, notes }));
  }
  const multi = results.length > 1 || results.some((x) => x.alts);
  return answer(multi ? 'targets' : 'target', results, { interpretation: i });
}

// ============================================================================== ClinVar

async function clinvarRecord(ctx, id) {
  const shard = await ctx.S.clinvar(id);
  const idx = shard[String(id)];
  if (idx === undefined) return null;
  const gid = ctx.meta.receptors[idx].gid;
  const vars = await ctx.S.variants(gid);
  const record = vars?.clinvarById.get(id);
  return record ? { gid, record } : null;
}

async function clinvarAnswer(ctx, hit, i) {
  const { gid, record: c } = hit;
  const gene = await loadGene(ctx, gid);
  const notes = [];
  if (i?.ids?.version && c.version && i.ids.version !== c.version) notes.push(note('version_mismatch', `You typed version ${i.ids.version}; the record is at version ${c.version} in ClinVar 2026-10-11.`));
  const cls = `${c.classification}${c.stars ? `, ${c.stars} star${c.stars === 1 ? '' : 's'}` : ''}`;
  if (c.packed) {
    const alleles = c.gnomadId ? (gene.vars.byId.get(c.gnomadId) ? [gene.vars.byId.get(c.gnomadId)] : []) : [];
    if (c.ref !== gene.res.seq[c.pos - 1]) notes.push(note('model_conflict', `The model has ${three(gene.res.seq[c.pos - 1])} at ${c.pos}; the ClinVar transcript has ${three(c.ref)}.`));
    if (!alleles.length) notes.push(note('clinvar_only', 'In ClinVar, not in gnomAD.'));
    const res = await makeResult(ctx, gid, c.pos, { gene, ref: c.ref, alt: c.alt, kind: 'missense', alleles, clinvar: [c], notes, genomic: c.gnomadId ? { grch38: c.gnomadId, grch37: alleles[0]?.id37 ?? null } : undefined });
    return answer('target', [res], { interpretation: i, message: `ClinVar ${c.accession}: ${c.title} (${cls}).` });
  }
  if (c.pos) {
    const msg = `ClinVar ${c.accession} is ${c.title} (${cls}). ${c.kind === 'missense' ? 'It is not among the pathogenic or likely pathogenic missense records the database uses; the residue is shown.' : `${kindText(c.kind)} changes are not analysed here; the residue is shown.`}`;
    const res = await makeResult(ctx, gid, c.pos, { gene, type: 'not_in_resource', ref: gene.res.seq[c.pos - 1], alt: c.alt, kind: c.kind, clinvar: [c], notes: [...notes, note('not_in_resource', msg)] });
    return answer('not_in_resource', [res], { interpretation: i, message: msg });
  }
  // no residue in the record: read its title (c. on a transcript) for the nearest residue
  if (c.nm) {
    const sub = parse(c.title, { matchReceptor: ctx.matchReceptor }).find((x) => x.kind === 'cdna');
    if (sub) {
      const a = await resolveCoding(ctx, sub);
      if (a.results[0]) {
        a.results[0].clinvar = [c];
        a.message = `ClinVar ${c.accession} is ${c.title} (${cls}). ${a.message ?? ''}`.trim();
        a.interpretation = i;
        if (a.expect === 'target') a.expect = 'not_in_resource';
        return a;
      }
    }
  }
  const msg = `ClinVar ${c.accession} is ${c.title} (${cls}); it does not name a residue.`;
  return answer('not_in_resource', [await makeResult(ctx, gid, null, { gene, type: 'not_in_resource', clinvar: [c], notes: [...notes, note('not_in_resource', msg)] })], { interpretation: i, message: msg });
}

async function resolveClinvar(ctx, i) {
  const ids = i.ids;
  if (ids.rcv) return answer('not_in_resource', [], { interpretation: i, message: 'RCV accessions are not indexed; search the VCV accession or the variant itself.' });
  const hit = await clinvarRecord(ctx, ids.variationId);
  if (!hit) return answer('not_in_resource', [], { interpretation: i, message: `ClinVar ${ids.vcv ?? ids.variationId} is not a single-gene record of the 283 receptors (multi-gene and copy-number records are not indexed).` });
  return clinvarAnswer(ctx, hit, i);
}
