/**
 * Search v2 UI: turns an engine answer (static/js/search/resolve.js) into HTML.
 *
 * Pure: no DOM, no network, so it also runs under node. Every dynamic value goes through the
 * `html` tag, which escapes by default, so a typed query can never inject markup.
 *
 *   renderAnswer(answer, query, {reports: '../reports/', studio: '../studio/', releases})  -> string
 *   renderHelp()  -> string        ("you can search like this")
 *   renderReleases(releases)  -> string
 *
 * @module search-ui/render
 */

import { three } from '../search/shards.js';
import { gnomadIdOf } from '../search/genomic.js';
import { MAX_QUERY_LENGTH } from '../search/parse.js';
import { CFR_GROUPS, NEAR_SEQ, isPlp } from '../search/cfrhood.js';
import * as L from './links.js';

// ------------------------------------------------------------------------------ html helper

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s));

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Tagged template that escapes interpolations; arrays join; null/undefined/false drop; Raw passes. */
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += part(v) + strings[i + 1]; });
  return new Raw(out);
}
function part(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(part).join('');
  return esc(v);
}

/**
 * The fine-print component (static/css/fine-print.css; Jinja twin: templates/_partials/fine_print.html).
 * Small, muted prose that supports a block without competing with it. With `summary` it is a collapsed
 * <details>; without, an <aside>. `page` adds the page-bottom rule. `body` is markup (Raw) or text.
 */
export function finePrint(body, { summary = null, open = false, page = false, cls = '', id = null } = {}) {
  const k = `fine-print${page ? ' fine-print--page' : ''}${cls ? ` ${cls}` : ''}`;
  const idAttr = id ? html` id="${id}"` : '';
  return summary
    ? html`<details class="${k}"${idAttr}${open ? raw(' open') : ''}><summary>${summary}</summary>${body}</details>`
    : html`<aside class="${k}"${idAttr}>${body}</aside>`;
}

// --------------------------------------------------------------------------------- formatting

const nf = new Intl.NumberFormat('en-US');
export const fmtInt = (n) => (n === null || n === undefined ? 'n/a' : nf.format(n));

export function fmtAf(af) {
  if (af === null || af === undefined) return 'n/a';
  if (af === 0) return '0';
  if (af < 0.0001) return af.toExponential(1).replace('e-', 'e-').replace('+', '');
  if (af < 0.1) return String(Number(af.toPrecision(2)));
  return String(Number(af.toFixed(3)));
}
/** Allele AlphaMissense scores print with 3 decimals, as on the report pages (the index keeps 3; the residue mean is kept at 2). */
export const AM_DECIMALS = 3;
export const fmtAm = (x) => (x === null || x === undefined ? 'n/a' : x.toFixed(AM_DECIMALS));

/** Short receptor label: "PAR2 (F2RL1)" or just the symbol when the entry name adds nothing. */
export function recShort(r) {
  const stem = String(r.entry ?? '').replace(/_HUMAN$/, '');
  if (stem && stem.toUpperCase() !== String(r.symbol).toUpperCase()) return `${stem} (${r.symbol})`;
  return r.symbol || r.gid;
}
const recFull = (r) => {
  const stem = String(r.entry ?? '').replace(/_HUMAN$/, '');
  const names = [stem && stem.toUpperCase() !== String(r.symbol).toUpperCase() ? stem : null, r.symbol].filter(Boolean);
  return `${names.length > 1 ? `${names[0]} (${names[1]}` : (names[0] ?? r.gid)}${r.uniprot ? `, ${r.uniprot}` : ''}${names.length > 1 ? ')' : ''}`;
};

const ALT_WORD = { '*': 'Ter', '=': '=', fs: 'fs', del: 'del', dup: 'dup', ins: 'ins', delins: 'delins' };
const resText = (ref, pos) => `${ref ? three(ref) : ''}${pos}`;
const altText = (a) => ALT_WORD[a] ?? three(a);
const hgvsP = (r) => (r.alt ? `p.${three(r.ref)}${r.pos}${altText(r.alt)}` : `p.${three(r.ref)}${r.pos}`);

const KIND_LABEL = {
  missense: 'Missense change', residue: 'Residue', stop: 'Nonsense (stop gained)', synonymous: 'Synonymous change',
  frameshift: 'Frameshift', indel: 'Insertion or deletion', start: 'Start codon change', ext: 'Stop-loss extension',
};
const kindLabel = (k) => KIND_LABEL[k] ?? 'Change';

const ROLE_LABEL = {
  mane: 'MANE Select (RefSeq)', mane_ensembl: 'MANE Select (Ensembl)', gnomad: 'gnomAD transcript', typed: 'Transcript you typed',
};

/** "MANE Select (RefSeq)", or for a typed older version "You typed NM_005242.5; read on NM_005242.6". */
const roleLabel = (t) => (t.role === 'read_on'
  ? `${t.typedAs ? `You typed ${t.typedAs}; read` : 'Read'} on ${t.transcript}`
  : (ROLE_LABEL[t.role] ?? t.role));

const WARN_NOTES = new Set([
  'model_conflict', 'reference_swap', 'reference_mismatch', 'version_mismatch', 'typed_residue_differs',
  'generic_number_differs', 'offset_mapping', 'isoform_mapping', 'liftover_approximate', 'no_coding_transcript', 'outside_model',
  'version_unknown', 'numbering_conflict', 'other_frame',
]);

// ------------------------------------------------------------------------ query text builders

/** The query string that reproduces one result (used by "Details" links and "Did you mean"). */
export function queryFor(r, interp) {
  const sym = r.receptor?.symbol ?? r.gid;
  if (r.type === 'receptor') return sym;
  // a typed change whose residue is not the model's: reproduce what was typed, never the corrected change
  if (r.typed && hasNote(r, 'reference_mismatch')) return `${sym} ${typedChangeText(r.typed) ?? ''}`.trim();
  if (r.alt && r.kind === 'missense') return `${sym} ${hgvsP(r)}`;
  // a generic number or a motif position: name the position, so every row reads the same way
  const gn = r.summary?.generic ?? r.generic;
  if (r.light && gn && (interp?.kind === 'generic' || interp?.kind === 'motif')) return `${sym} ${gn}`;
  if (r.light && interp?.generic) return `${sym} ${interp.generic.display ?? ''}`.trim();
  if (r.pos) return `${sym} ${three(r.ref)}${r.pos}`;
  return sym;
}

/** Link target for an alternate ("Did you mean"). */
export function alternateQuery(a, symbolOf, interp) {
  if (a.query) return a.query;
  const sym = a.gid && a.gid !== '*' ? (symbolOf?.(a.gid) ?? a.gid) : '';
  switch (a.kind) {
    case 'receptor': return sym || a.display || a.label;
    case 'change': return `${sym} p.${three(a.ref)}${a.pos}${three(a.alt)}`.trim();
    case 'residue': return `${sym} ${three(a.ref ?? a.aa)}${a.pos}`.trim();
    case 'generic': return a.display;
    case 'clinvar': return `VCV${String(a.id).padStart(9, '0')}`;
    case 'transcript': return a.transcript ?? a.label;
    case 'genomic': {
      // the same coordinate the reader typed, read on the other assembly
      const g = interp?.genomic;
      if (!g || !a.assembly) return a.label;
      return `${gnomadIdOf(g) ?? `${g.chrom}:${g.pos}`} ${a.assembly}`;
    }
    case 'hgnc': return String(a.id);
    case 'gene_id': return `GeneID:${a.id}`;
    default: return a.display ?? a.label;
  }
}

// ----------------------------------------------------------------------- "I read this as ..."

function cdnaText(cd) {
  const pos = `${cd.region === '3utr' ? '*' : ''}${cd.pos}${cd.offset ? (cd.offset > 0 ? `+${cd.offset}` : cd.offset) : ''}`;
  const tail = cd.op === 'sub' && cd.ref ? `${cd.ref}>${cd.alt}` : (cd.op && cd.op !== 'sub' ? cd.op : '');
  const acc = cd.transcript ? `${cd.transcript}${cd.version ? `.${cd.version}` : ''}:` : '';
  return `${acc}${cd.coord ?? 'c'}.${pos}${tail}`;
}

function typedChange(i) {
  const c = i.change;
  if (!c) return null;
  if (c.pos === null || c.pos === undefined) return `${c.kind === 'indel' ? 'deletion or insertion' : 'change'} ${c.label ?? ''}`.trim();
  const alt = c.alt === undefined || c.alt === null ? '' : altText(c.alt);
  const what = { missense: 'protein change', stop: 'stop-gain', synonymous: 'synonymous change', frameshift: 'frameshift', indel: 'insertion or deletion' }[c.kind] ?? 'protein change';
  return `${what} ${resText(c.ref, c.pos)}${alt}`;
}

/**
 * Plain-words reading of the query, as a sentence (no markup). Null when the query was not understood.
 */
export function readAsText(answer, query) {
  const i = answer.interpretation;
  if (!i || i.kind === 'unrecognised') return null;
  const rs = answer.results ?? [];
  const first = rs[0];
  const sameRec = first?.receptor && rs.every((r) => r.gid === first.gid);
  const rec = sameRec ? recShort(first.receptor) : null;
  const where = !rec && rs.length > 1 ? `${rs.length} receptors` : null;
  const parts = [];
  const asm = answer.assembly ? ` on ${answer.assembly}` : '';
  switch (i.kind) {
    case 'receptor': {
      const t = i.receptorId ? `the ${({ uniprot: 'UniProt accession', entry: 'UniProt entry name', ensg: 'Ensembl gene ID', hgnc: 'HGNC ID', geneid: 'NCBI Gene ID' })[i.receptorId.type] ?? 'identifier'} ${i.receptorId.value}` : `the name “${i.receptorTerm ?? query}”`;
      if (rs.length > 1) return `${rs.length} receptors whose names start with “${i.receptorTerm ?? query}”`;
      if (rec && first.clinvarList) return `every ClinVar record of ${rec}`;
      if (rec && first.cfrList !== undefined) return `the variants of ${rec} at, connected to or near its CFR positions`;
      return rec ? `the receptor ${rec}, from ${t}` : `a receptor, from ${t}`;
    }
    case 'protein':
    case 'residue': {
      const c = i.change;
      const what = i.kind === 'protein' ? (typedChange(i) ?? 'protein change') : (c ? `residue ${resText(c.ref, c.pos)}` : 'a residue');
      if (rec) parts.push(rec, what);
      else parts.push(what, c && rs.length > 1 ? `in any receptor (${rs.length} ${c.ref ? 'have ' + three(c.ref) + c.pos : 'have residue ' + c.pos})` : 'in any receptor');
      break;
    }
    case 'cdna': {
      parts.push(rec ?? where ?? 'a receptor');
      if (first?.alt && first.kind === 'missense') parts.push(`protein change ${three(first.ref)}${first.pos}${three(first.alt)}`);
      else if (first?.pos) parts.push(`residue ${three(first.ref)}${first.pos}`);
      parts.push(`from ${cdnaText(i.cdna)}${asm}`);
      return parts.join(', ');
    }
    case 'genomic': {
      const g = i.genomic;
      parts.push(rec ?? where ?? 'a receptor');
      if (first?.alt && first.kind === 'missense') parts.push(`protein change ${three(first.ref)}${first.pos}${three(first.alt)}`);
      else if (first?.alts?.length) parts.push(`residue ${three(first.ref)}${first.pos}`);
      else if (first?.pos) parts.push(`residue ${three(first.ref)}${first.pos}`);
      const spot = i.ids?.gnomad ?? `chromosome ${g.chrom}, position ${g.pos}`;
      parts.push(`from ${spot}${asm}`);
      return parts.join(', ');
    }
    case 'rsid':
    case 'clinvar': {
      parts.push(rec ?? where ?? 'a receptor');
      if (first?.alt && first.kind === 'missense') parts.push(`protein change ${three(first.ref)}${first.pos}${three(first.alt)}`);
      else if (first?.pos) parts.push(`${first.kind === 'residue' ? 'residue' : kindLabel(first.kind).toLowerCase()} ${three(first.ref)}${first.pos}`);
      parts.push(i.kind === 'rsid' ? `from ${i.ids.rsid}` : `from ClinVar record ${i.ids.vcv ?? i.ids.variationId}`);
      return parts.join(', ');
    }
    case 'generic': {
      const g = i.generic;
      parts.push(rec ?? 'every receptor');
      parts.push(g.residueLetter && !rec ? `residue ${three(g.residueLetter)} at generic number ${g.display}` : `generic residue number ${g.display}`);
      // a typed residue that is not the model's (PAR2 F3.36) stays as typed
      if (sameRec && first.pos && !hasNote(first, 'reference_mismatch')) parts[1] = `residue ${three(first.ref)}${first.pos} at generic number ${first.residue?.generic || g.display}`;
      else if (sameRec && g.residueLetter) parts[1] = `residue ${three(g.residueLetter)} at generic number ${g.display}`;
      return parts.join(', ');
    }
    case 'motif': {
      const m = i.motif;
      return rec ? `${rec}, the ${m?.name ?? 'motif'}` : `the ${m?.name ?? 'motif'} in every receptor`;
    }
    default:
      return null;
  }
  return parts.join(', ');
}

function alternatesBlock(answer, symbolOf, base, skip = new Set()) {
  const interp = answer.interpretation;
  const alts = (answer.alternates ?? []).filter((a) => !skip.has(alternateQuery(a, symbolOf, interp)));
  if (!alts.length) return '';
  return html`<div class="sr-did-you-mean"><span class="sr-label">Did you mean</span>
    <ul class="sr-alt-list">${alts.map((a) => {
      const q = alternateQuery(a, symbolOf, interp);
      return html`<li><a href="${base}?q=${encodeURIComponent(q)}" data-q="${q}">${a.label ?? q}</a></li>`;
    })}</ul></div>`;
}

// ---------------------------------------------------------------------------------- the cards

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A card carrying one of these notes opens "All transcript notations" by default. */
const MAPPING_WARN = new Set([
  'version_mismatch', 'isoform_mapping', 'offset_mapping', 'typed_residue_differs', 'other_frame',
  'numbering_conflict', 'liftover_approximate', 'model_conflict',
]);
const hasNote = (r, codes) => (r.notes ?? []).some((n) => (codes instanceof Set ? codes.has(n.code) : n.code === codes));

/** The report's variant table lists variants at residues with a contact change this large or larger. */
export const REPORT_TABLE_DELTA = 3.0;

/** "F300" (one letter and model number) as "Phe300". */
export function partnerText(p) {
  const m = /^([A-Z])(\d+)$/.exec(String(p ?? ''));
  return m ? `${three(m[1])}${m[2]}` : (p ?? null);
}

/**
 * Residue facts, read through one place so the card, the table and the evidence summary agree.
 * `summary` (engine contract) is the cross-receptor table row; `residue` is the full card object.
 */
export function residueFacts(r) {
  const x = r.residue ?? {};
  const s = r.summary ?? {};
  return {
    dmax: num(x.dmax ?? s.dmax),
    dmaxSigned: num(s.dmaxSigned),
    partner: partnerText(s.dmaxPartner),
    threshold: num(s.threshold ?? x.threshold),
    net: num(s.net),
    nsig: num(x.nsig ?? s.nsig),
    cfr: x.cfr ?? s.cfr ?? null,
    cfrRank: num(x.cfrRank ?? s.cfrRank),
    conservation: num(x.conservation ?? s.conservation),
    amMean: num(x.amMean),
    amMeanClass: x.amMeanClass ?? null,
    family: s.family ?? null,
    generic: x.generic || s.generic || null,
    segment: x.segment || s.segment || null,
    aa: x.aa ?? s.aa ?? r.ref ?? null,
  };
}

/** Direction of a net ΔRRCS: red = stronger in the active model, blue = stronger in the inactive model. */
export function direction(net) {
  if (net === null || net === undefined) return null;
  if (net > 0) return { cls: 'active', word: 'stronger in the active model', short: 'active' };
  if (net < 0) return { cls: 'inactive', word: 'stronger in the inactive model', short: 'inactive' };
  return { cls: 'none', word: 'no net change', short: 'none' };
}
export const signed = (x, nd = 2) => (x > 0 ? '+' : '') + x.toFixed(nd);

function netHtml(net, { word = true, nd = 1 } = {}) {
  const d = direction(net);
  if (!d) return html`<span class="sr-na">not available</span>`;
  return html`<span class="sr-net sr-net--${d.cls}">${signed(net, nd)}</span>${word ? html` <span class="sr-sub">${d.word}</span>` : ''}`;
}

function stars(n) {
  const k = Math.max(0, Math.min(4, Number(n) || 0));
  return html`<span class="sr-stars" role="img" aria-label="${k} of 4 review stars" title="${k} of 4 review stars">${'★'.repeat(k)}${'☆'.repeat(4 - k)}</span>`;
}

function copyBtn(text, label) {
  return html`<button type="button" class="sr-copy" data-copy="${text}" aria-label="Copy ${label ?? text}" title="Copy">Copy</button>`;
}

// ------------------------------------------------------------------------------------ links
// Every link out of a result opens in a new tab, so the search stays where it is. URLs come from links.js.

/** The id of the hidden "opens in a new tab" text every result link points at (aria-describedby). */
export const NEW_TAB_ID = 'sr-newtab';
const newTabNote = () => html`<span id="${NEW_TAB_ID}" hidden>Opens in a new tab</span>`;

/**
 * A link to another site. CSS draws its ↗ (static/css/search-ui.css .sr-ext::after), so selecting and copying
 * the text gives the bare identifier; the new-tab hint is the title and, for screen readers, aria-describedby.
 * rel noreferrer: the other site is not told the search address. Without `href` (an id of the wrong shape)
 * the text is shown plain.
 */
export function extLink(href, text, site, { cls = 'mono' } = {}) {
  if (!href) return cls ? html`<span class="${cls}">${text}</span>` : html`${text}`;
  return html`<a class="sr-ext${cls ? ` ${cls}` : ''}" href="${href}" target="_blank" rel="noopener noreferrer" title="${site}, opens in a new tab" aria-describedby="${NEW_TAB_ID}">${text}</a>`;
}

/** A link to another page of this site (report, Studio, glossary): a new tab as well, but no ↗. */
export function intLink(href, text, { cls = '', title = null } = {}) {
  return html`<a class="sr-int${cls ? ` ${cls}` : ''}" href="${href}" target="_blank" rel="noopener" title="${title ? `${title}, opens` : 'Opens'} in a new tab" aria-describedby="${NEW_TAB_ID}">${text}</a>`;
}

/** A term that links to its glossary entry (ids from website/glossary.py). */
const term = (o, id, text) => intLink(L.glossaryUrl(o, id), text, { cls: 'sr-term', title: 'Glossary entry' });

/** An identifier that opens its record, with its copy button beside it. */
const idLink = (href, text, site, label) => html`${extLink(href, text, site)} ${copyBtn(text, label ?? text)}`;

const SITE = { gnomad: 'gnomAD browser', dbsnp: 'dbSNP', clinvar: 'ClinVar', ucsc38: 'UCSC Genome Browser, hg38', ucsc37: 'UCSC Genome Browser, hg19' };

/** A GRCh38 genome id: gnomAD for an allele id, else the genome browser. */
function g38Link(id, rel) {
  const gn = L.gnomadVariantUrl(id, rel);
  return gn ? extLink(gn, id, SITE.gnomad) : extLink(L.ucscUrl(id, 'GRCh38'), id, SITE.ucsc38);
}
/** The same id in the genome browser, as a short second link (gnomAD ids only). */
function g38Browser(id, rel) {
  return L.gnomadVariantUrl(id, rel) ? extLink(L.ucscUrl(id, 'GRCh38'), 'UCSC', SITE.ucsc38, { cls: 'sr-ext-alt' }) : '';
}
const g37Link = (id) => extLink(L.ucscUrl(id, 'GRCh37'), id, SITE.ucsc37);

/** "NM_000024.6:c.46G>A": the accession opens its record, the rest is text; the copy button takes the whole. */
function notationLink(acc, rest) {
  const full = `${acc}:${rest}`;
  return html`${extLink(L.accessionUrl(acc), acc, L.accessionSite(acc))}<span class="mono">:${rest}</span> ${copyBtn(full)}`;
}

/** The receptor's records elsewhere, as short links: HGNC, UniProt, GPCRdb, NCBI Gene, Ensembl, gnomAD gene page. */
function receptorLinks(rec, o) {
  const items = [
    ['HGNC', L.hgncUrl(rec), rec.hgnc ?? rec.symbol],
    ['UniProt', L.uniprotUrl(rec.uniprot), rec.uniprot],
    ['GPCRdb', L.gpcrdbUrl(rec.entry), String(rec.entry ?? '').toLowerCase()],
    ['NCBI Gene', L.ncbiGeneUrl(rec.geneId), rec.geneId],
    ['Ensembl', L.ensemblUrl(rec.ensg), rec.ensg],
    ['gnomAD gene page', L.gnomadGeneUrl(rec.ensg, o.releases), rec.symbol],
  ].filter(([, href]) => href);
  if (!items.length) return '';
  return html`<ul class="sr-extlinks">${items.map(([site, href, id]) => html`<li>${extLink(href, html`${site} <span class="sr-sub mono">${id}</span>`, site, { cls: '' })}</li>`)}</ul>`;
}

/** AlphaMissense's own class words: the index keeps benign | ambiguous | pathogenic. */
export const AM_CLASS_LABEL = { benign: 'likely benign', ambiguous: 'ambiguous', pathogenic: 'likely pathogenic' };
export const amClassLabel = (c) => AM_CLASS_LABEL[c] ?? (c ?? '');

function amCell(a) {
  if (a.am === null || a.am === undefined) return html`<span class="sr-na">no score</span>`;
  return html`<span class="sr-path sr-path--${a.amClass}">${fmtAm(a.am)}</span> ${pathChip(a.amClass)}`;
}

const sourceWord = (s) => (s === 'exome' ? 'exomes' : s === 'genome' ? 'genomes' : null);

export function allelesTable(alleles, { caption, rel = null, o = {} }) {
  return html`<div class="sr-table-wrap"><table class="sr-table">
    <caption class="sr-sr-only">${caption}</caption>
    <thead><tr><th scope="col">gnomAD allele (GRCh38)</th><th scope="col">Change</th><th scope="col">rsID</th><th scope="col" class="num">Allele count</th><th scope="col" class="num">Frequency</th><th scope="col" class="num">Homozygotes</th><th scope="col">${term(o, 'am', 'AlphaMissense')}</th></tr></thead>
    <tbody>${alleles.map((a) => html`<tr>
      <td data-label="gnomAD allele (GRCh38)">${g38Link(a.id, rel)}${a.id37 ? html`<br><span class="sr-sub">GRCh37 ${g37Link(a.id37)}</span>` : ''}</td>
      <td data-label="Change"><span class="mono">${a.hgvsc ?? ''}</span>${a.hgvsc ? html`<br>` : ''}<span class="sr-sub mono">${a.hgvsp ?? ''}</span>${a.conflict ? html` <span class="sr-badge sr-badge--warn" title="The model has the other residue here">model differs</span>` : ''}</td>
      <td data-label="rsID">${a.rsids?.length ? a.rsids.map((x, i) => html`${i ? ', ' : ''}${extLink(L.dbsnpUrl(x), x, SITE.dbsnp)}`) : 'none'}</td>
      <td class="num" data-label="Allele count">${fmtInt(a.ac)}<br><span class="sr-sub">of ${fmtInt(a.an)}${sourceWord(a.source) ? html`, ${sourceWord(a.source)}` : ''}</span></td>
      <td class="num" data-label="Frequency">${fmtAf(a.af)}</td>
      <td class="num" data-label="Homozygotes">${fmtInt(a.hom)}</td>
      <td data-label="AlphaMissense">${amCell(a)}</td></tr>`)}</tbody></table></div>`;
}

// ------------------------------------------------------- "You typed X -> model residue Y"

const MAPPED_KINDS = new Set(['cdna', 'genomic', 'rsid', 'clinvar', 'generic']);

function modelText(r) {
  const res = `${three(r.residue?.aa ?? r.ref)}${r.pos}`;
  return r.alt && r.kind === 'missense' ? { res, change: hgvsP(r) } : { res, change: null };
}

export function leadReason(r, i) {
  if (hasNote(r, 'offset_mapping')) return 'the transcript you typed numbers this residue differently from the model';
  if (hasNote(r, 'isoform_mapping')) return 'mapped from another isoform of this receptor';
  if (hasNote(r, 'version_mismatch')) return 'the transcript version differs from the one in the GPCompaRe database';
  if (hasNote(r, 'typed_residue_differs')) return 'the residue you typed differs from the model residue';
  if (hasNote(r, 'other_frame')) return 'the base sits in a codon that the transcript you typed does not share';
  if (hasNote(r, 'reference_swap')) return 'reference and alternate residue were read the other way round';
  switch (i?.kind) {
    case 'cdna': return 'mapped through the transcript';
    case 'genomic': return 'mapped from the genome position';
    case 'rsid': return 'found by its rsID';
    case 'clinvar': return 'found by its ClinVar record';
    case 'generic': return 'found by its generic residue number';
    default: return 'residue numbering differs';
  }
}

/** True when the typed text and the model residue are not plainly the same thing. */
function leadNeeded(r, i) {
  if (!i || r.light || !r.pos || r.type === 'not_coding') return false;
  if (MAPPED_KINDS.has(i.kind)) return true;
  if (r.notes?.some((n) => MAPPING_WARN.has(n.code) || n.code === 'reference_swap')) return true;
  const c = i.change;
  return !!(c && c.pos !== null && c.pos !== undefined && c.pos !== r.pos);
}

function leadLine(r, o) {
  if (!leadNeeded(r, o.interp)) return '';
  const m = modelText(r);
  if (subjectOf(r, o).mismatch) m.change = null; // the change on the model residue is only ever a suggestion
  const q = String(o.query ?? '').trim();
  const typed = q.length > 90 ? `${q.slice(0, 87)}...` : q;
  return html`<p class="sr-lead"><span class="sr-label">You typed</span> <span class="mono">${typed}</span> <span class="sr-arrow" aria-hidden="true">→</span><span class="sr-sr-only"> which is </span> <span class="sr-label">model residue</span> <strong class="mono">${m.res}</strong>${m.change ? html`<span class="sr-sub">, </span><span class="mono">${m.change}</span>` : ''} </p>`;
}

// ------------------------------------------------------ transcripts, assemblies (folded away)

function transcriptTable(r, rel) {
  const tv = r.transcriptViews ?? [];
  if (!tv.length) return '';
  const anyAllele = tv.some((t) => t.allele);
  const anyC = tv.some((t) => t.c);
  const maneP = (allele) => tv.find((x) => x.role === 'mane' && (x.allele ?? '') === (allele ?? ''))?.p;
  // one row per transcript and allele; the roles that share a row are listed together
  const rows = [];
  for (const t of tv) {
    const k = `${t.allele ?? ''}|${t.transcript}`;
    let row = rows.find((x) => x.k === k);
    if (!row) { row = { k, t, roles: [], protein: null, c: null, p: null, differs: false }; rows.push(row); }
    if (!row.roles.some((x) => x.role === t.role)) row.roles.push(t);
    row.protein = row.protein ?? t.protein ?? null;
    row.c = row.c ?? t.c ?? null;
    row.p = row.p ?? t.p ?? null;
    const mp = maneP(t.allele);
    if (mp && t.p && t.p !== mp) row.differs = true;
  }
  return html`<div class="sr-table-wrap"><table class="sr-table sr-table--tx">
    <caption class="sr-sr-only">The change on each transcript, with the genomic allele it comes from</caption>
    <thead><tr>${anyAllele ? html`<th scope="col">Genomic allele (GRCh38)</th>` : ''}<th scope="col">View</th><th scope="col">Transcript</th><th scope="col">Protein</th>${anyC ? html`<th scope="col">Coding change</th>` : ''}<th scope="col">Protein change</th></tr></thead>
    <tbody>${rows.map((row) => html`<tr>${anyAllele ? html`<td data-label="Genomic allele (GRCh38)">${row.t.allele ? g38Link(row.t.allele, rel) : ''}</td>` : ''}
      <td data-label="View">${row.roles.map(roleLabel).join(', ')}</td>
      <td data-label="Transcript">${extLink(L.accessionUrl(row.t.transcript), row.t.transcript, L.accessionSite(row.t.transcript))}</td><td data-label="Protein">${row.protein ? extLink(L.accessionUrl(row.protein), row.protein, L.accessionSite(row.protein)) : ''}</td>
      ${anyC ? html`<td class="mono" data-label="Coding change">${row.c ?? ''}</td>` : ''}
      <td class="mono" data-label="Protein change">${row.p ?? ''}${row.differs ? html` <span class="sr-badge sr-badge--warn">numbered differently</span>` : ''}</td></tr>`)}</tbody></table></div>`;
}

function genomeTable(r, rel) {
  const alleles = r.alleles ?? [];
  const g = r.genomic ?? {};
  const items = [];
  if (alleles.length) {
    for (const a of alleles) items.push({ g38: a.id, g37: a.id37 });
  } else if (g.grch38 || g.grch37) {
    items.push({ g38: g.grch38, g37: g.grch37 });
  }
  if (!items.length) return '';
  const show = (v, approx, asm) => (v
    ? html`${asm === 'GRCh37' ? g37Link(v) : g38Link(v, rel)}${approx ? html` <span class="sr-badge sr-badge--warn" title="Lifted by the nearest alignment block, not checked base by base">approximate</span>` : ''} ${copyBtn(v)}${asm === 'GRCh38' ? html` ${g38Browser(v, rel)}` : ''}`
    : html`<span class="sr-na">not mapped</span>`);
  return html`<div class="sr-table-wrap"><table class="sr-table">
      <caption class="sr-sr-only">Genomic positions on both assemblies</caption>
      <thead><tr><th scope="col">GRCh38 (hg38)</th><th scope="col">GRCh37 (hg19)</th></tr></thead>
      <tbody>${items.map((x) => html`<tr><td data-label="GRCh38">${show(x.g38, g.grch38Approximate, 'GRCh38')}</td><td data-label="GRCh37">${show(x.g37, g.grch37Approximate, 'GRCh37')}</td></tr>`)}</tbody></table></div>
    <p class="sr-sub">IDs read chromosome-position-reference-alternate, on the forward strand.</p>`;
}

/** The transcript and genome tables: folded away inside the card's fine print; the numbering warning stays on the summary. */
function notationsDetails(r, mismatch = false, rel = null) {
  const tx = transcriptTable(r, rel);
  const gen = genomeTable(r, rel);
  if (!tx && !gen) return '';
  const differs = hasNote(r, MAPPING_WARN);
  return html`<details class="sr-more sr-notations">
    <summary>${mismatch ? 'The model residue on each transcript' : 'All transcript notations'}${differs ? html` <span class="sr-badge sr-badge--warn">numbering differs</span>` : ''}</summary>
    ${tx}${gen}</details>`;
}

/** "gnomAD v4.1.2" -> "gnomAD", "ClinVar 2026-10-11" -> "ClinVar": the release itself goes to the fine print. */
const sourceName = (label) => String(label ?? '').split(' ')[0] || String(label ?? '');

const NUM_WORDS = { 2: 'two', 3: 'three' };

/**
 * Why a missense change has no gnomAD allele, when the reason is the codon: gnomAD alleles are single
 * nucleotide substitutions, so a change that needs two or three can never be one of them. Null for a
 * one-substitution change. (The AlphaMissense prediction is per amino-acid substitution and does not depend
 * on this; the card reads it from the per-residue table.)
 */
export function codonReason(r) {
  const n = r?.codon?.steps?.[r.alt];
  if (!(n > 1)) return null;
  return `This change needs ${NUM_WORDS[n]} nucleotide substitutions in its codon (${r.codon.codon}); gnomAD alleles each change a single nucleotide, so no allele can carry it.`;
}
export const amUnavailableReason = codonReason;

/** The brand text of the database, as it reads in sentences. */
export const DB_NAME = 'the GPCompaRe database';

/**
 * A collapsible evidence section of a card: a <details> whose summary carries the heading, open by default for
 * the decision-relevant evidence. `key` is the data-sec hook for tests and styles.
 */
function section(key, title, sub, body, { open = true, idx = 0 } = {}) {
  return html`<details class="sr-sec" data-sec="${key}" id="sr-${idx}-${key}"${open ? raw(' open') : ''}>
    <summary><h4 class="sr-sec-title">${title}</h4>${sub ? html` <span class="sr-sub">${sub}</span>` : ''}</summary>
    <div class="sr-sec-body">${body}</div></details>`;
}

const cell = (k, v) => html`<div class="sr-fact"><dt>${k}</dt><dd>${v}</dd></div>`;
const HELICES = new Set(['TM1', 'TM2', 'TM3', 'TM4', 'TM5', 'TM6', 'TM7', 'H8']);
/** '' for a helix residue, 'terminus' for N- or C-term, 'loop' otherwise (the report's tail rule). */
export const segmentKind = (seg) => (!seg || HELICES.has(seg) ? '' : (seg === 'N-term' || seg === 'C-term' ? 'terminus' : 'loop'));

// ------------------------------------------------------------------------------ identifiers

/** "Notations and references": gene, HGVS on every transcript held, genome ids on both assemblies, rsID, ClinVar, records elsewhere. */
function refsSection(r, sub, o, open) {
  const rec = r.receptor ?? {};
  const rel = o.releases;
  const rows = [];
  const entry = String(rec.entry ?? '').replace(/_HUMAN$/, '');
  const sym = rec.symbol ?? r.gid;
  rows.push(['Gene', html`<strong>${extLink(L.hgncUrl(rec), sym, 'HGNC')}</strong> ${copyBtn(sym, 'gene symbol')}${rec.uniprot ? html` <span class="sr-sub">UniProt</span> ${extLink(L.uniprotUrl(rec.uniprot), rec.uniprot, 'UniProt')}${entry && entry.toUpperCase() !== String(rec.symbol).toUpperCase() ? html`<span class="sr-sub"> (${entry})</span>` : ''} ${copyBtn(rec.uniprot, 'UniProt accession')}` : ''}`]);
  const recLinks = receptorLinks(rec, o);
  if (recLinks) rows.push(['Records elsewhere', recLinks]);
  // the model residue opens the report there
  const modelRes = `${three(r.residue?.aa ?? r.ref)}${r.pos}`;
  const atRes = (text) => html`${intLink(L.residueUrl(o, r.gid, r.pos), text, { cls: 'mono', title: 'Report at this residue' })} ${copyBtn(text)}`;
  if (sub.mismatch) rows.push(['Model residue', html`${atRes(modelRes)} <span class="sr-sub">the typed ${sub.what} is not checkable here</span>`]);
  else if (sub.change && r.kind === 'missense') rows.push(['Protein change, model numbering', html`${atRes(hgvsP(r))} <span class="sr-sub">(${r.ref}${r.pos}${r.alt})</span>`]);
  else if (sub.change) rows.push(['Change, model numbering', atRes(hgvsP(r))]);
  else rows.push(['Residue, model numbering', atRes(modelRes)]);
  // one row per transcript role; the notations of every allele that shares the role go together
  const byRole = new Map();
  for (const t of r.transcriptViews ?? []) {
    const items = [];
    if (t.c) items.push([t.transcript, t.c]);
    if (t.protein && t.p) items.push([t.protein, t.p]);
    if (!items.length) continue;
    const k = roleLabel(t);
    if (!byRole.has(k)) byRole.set(k, []);
    const list = byRole.get(k);
    for (const it of items) if (!list.some((x) => x[0] === it[0] && x[1] === it[1])) list.push(it);
  }
  for (const [k, items] of byRole) rows.push([k, html`<span class="sr-id-list">${items.map(([acc, rest]) => html`<span class="sr-id-item">${notationLink(acc, rest)}</span>`)}</span>`]);
  const g = r.genomic ?? {};
  const alleles = r.alleles ?? [];
  const approx = (flag) => (flag ? html` <span class="sr-badge sr-badge--warn" title="Lifted by the nearest alignment block, not checked base by base">approximate</span>` : '');
  const ids38 = alleles.length ? alleles.map((a) => a.id) : (g.grch38 ? [g.grch38] : []);
  const ids37 = alleles.length ? alleles.map((a) => a.id37).filter(Boolean) : (g.grch37 ? [g.grch37] : []);
  if (ids38.length) rows.push(['GRCh38 (hg38)', html`<span class="sr-id-list">${ids38.map((s) => html`<span class="sr-id-item">${g38Link(s, rel)}${approx(g.grch38Approximate)} ${copyBtn(s)} ${g38Browser(s, rel)}</span>`)}</span>`]);
  if (ids37.length || ids38.length) rows.push(['GRCh37 (hg19)', ids37.length ? html`<span class="sr-id-list">${ids37.map((s) => html`<span class="sr-id-item">${g37Link(s)}${approx(g.grch37Approximate)} ${copyBtn(s)}</span>`)}</span>` : html`<span class="sr-na">not mapped</span>`]);
  const rsids = [...new Set(alleles.flatMap((a) => a.rsids ?? []))];
  if (alleles.length) rows.push(['rsID', rsids.length ? html`<span class="sr-id-list">${rsids.map((s) => html`<span class="sr-id-item">${idLink(L.dbsnpUrl(s), s, SITE.dbsnp)}</span>`)}</span>` : html`<span class="sr-na">none</span>`]);
  const cv = (r.clinvar ?? []);
  if (cv.length) rows.push(['ClinVar', html`<span class="sr-id-list">${cv.map((c) => html`<span class="sr-id-item">${idLink(c.url ?? L.clinvarUrl(c.variationId), c.accession, SITE.clinvar)}</span>`)}</span>`]);
  const body = html`<dl class="sr-ids">${rows.map(([k, v]) => html`<div class="sr-id"><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>
    ${ids38.length ? html`<p class="sr-sub">Genome ids read chromosome-position-reference-alternate on the forward strand. GRCh38 allele ids open in the gnomAD browser; UCSC opens the genome browser at the same position.</p>` : ''}
    ${notationsDetails(r, sub.mismatch, rel)}`;
  return section('refs', 'Notations and references', 'gene, transcripts, genome, rsID, ClinVar, records elsewhere', body, { open, idx: o.idx });
}

// ------------------------------------------------------------------------------- population

function populationSection(r, o, mismatch) {
  const releases = o.releases;
  const alleles = r.alleles ?? [];
  const resid = r.residueAlleles ?? [];
  const names = new Set(alleles.map((a) => a.id));
  const others = resid.filter((a) => !names.has(a.id));
  const label = r.releases?.gnomad ?? releases?.gnomad?.label ?? 'gnomAD';
  let body;
  if (alleles.length) {
    body = html`${afBars(r)}${allelesTable(alleles, { caption: `${label} alleles for this change`, rel: releases, o })}`;
  } else if (mismatch) {
    // the residue is not the one typed: nothing is claimed about the typed change
    body = html`<p>Not looked up: the residue you typed is not the model residue.</p>`;
  } else if (r.kind === 'missense' && r.alt) {
    body = html`<p>This exact change is not listed in ${label}.${codonReason(r) ? html` <span class="sr-sub">${codonReason(r)}</span>` : ''}</p>`;
  } else if (!resid.length) {
    body = html`<p>No ${label} missense allele at this residue.</p>`;
  } else body = '';
  const where = mismatch && r.pos ? `the model residue ${three(r.residue?.aa ?? r.ref)}${r.pos}` : 'this residue';
  const more = others.length
    ? html`<details class="sr-more"><summary>${alleles.length ? 'Other' : 'All'} ${others.length} ${label} missense allele${others.length === 1 ? '' : 's'} at ${where}</summary>${allelesTable(others, { caption: `Other ${label} alleles at this residue`, rel: releases, o })}</details>`
    : '';
  return section('population', 'Population', label, html`${body}${more}`, { idx: o.idx });
}

// --------------------------------------------------------------------------------- clinical

function clinvarRecord(c) {
  const facts = [];
  if (c.scv) facts.push(`${c.scv} ${c.scv === 1 ? 'submission' : 'submissions'}`);
  if (c.evaluated) facts.push(`last evaluated ${c.evaluated}`);
  return html`<li>
        ${extLink(c.url ?? L.clinvarUrl(c.variationId), c.accession, SITE.clinvar)}
        ${pathChip(cvClassKey(c.classification), c.classification || 'no classification')} ${stars(c.stars)}${facts.length ? html` <span class="sr-sub">${facts.join(', ')}</span>` : ''}
        ${c.conditions?.length ? html`<div class="sr-sub">${c.conditions.join('; ')}</div>` : ''}
        <div class="sr-sub">${c.title}</div></li>`;
}

function clinicalSection(r, o, mismatch = false) {
  const releases = o.releases;
  const recs = r.clinvar ?? [];
  const label = r.releases?.clinvar ?? releases?.clinvar?.label ?? 'ClinVar';
  const at = mismatch && r.pos ? `the model residue ${three(r.residue?.aa ?? r.ref)}${r.pos}` : null;
  const body = recs.length
    ? html`${at ? html`<p class="sr-sub">Records at ${at}, not of the change you typed:</p>` : ''}<ul class="sr-list">${recs.map(clinvarRecord)}</ul>`
    : html`<p>${at ? `No ClinVar record at ${at}.` : 'No ClinVar record matches this query.'}</p>`;
  return section('clinical', 'Clinical', label, body, { idx: o.idx });
}

// ---------------------------------------------------------------------------- computational

/** The AlphaMissense prediction the card is about: the change's own, else the first allele's. Null when none. */
export function amForChange(r, sub) {
  if (sub?.mismatch) return null;
  if (r.amThis && r.amThis.am !== null && r.amThis.am !== undefined) return r.amThis;
  const a = (r.alleles ?? []).find((x) => x.am !== null && x.am !== undefined);
  return a ? { am: a.am, amClass: a.amClass } : null;
}

/** Every substitution at the residue, one cell each, the card's own change marked. */
function amStrip(r, sub) {
  const all = r.amAll;
  if (all === undefined) return '';
  const res = `${three(r.residue?.aa ?? r.ref)}${r.pos}`;
  if (!all) return html`<p>No AlphaMissense prediction at ${res}.</p>`;
  const mark = !sub.mismatch && r.kind === 'missense' ? r.alt : null;
  const letters = Object.keys(all).sort();
  return html`<div class="sr-am-all">
    <p class="sr-sub">AlphaMissense prediction for every substitution at ${res}${sub.mismatch ? ' (the model residue)' : ''}:</p>
    <ol class="sr-am-strip" aria-label="AlphaMissense prediction for every substitution at ${res}">${letters.map((a) => {
      const v = all[a];
      const me = a === mark;
      return html`<li class="sr-am-cell sr-am--${v.amClass}${me ? ' is-this' : ''}"${me ? raw(' aria-current="true"') : ''} title="${three(a)}: ${fmtAm(v.am)}, ${amClassLabel(v.amClass)}"><span class="sr-am-aa">${three(a)}</span><span class="sr-am-score">${fmtAm(v.am)}</span><span class="sr-sr-only"> ${amClassLabel(v.amClass)}${me ? ' (this change)' : ''}</span></li>`;
    })}</ol></div>`;
}

/** Where the AlphaMissense scores come from: the record named in data_versions.json. */
function amSource(o) {
  const u = L.alphamissenseUrl(o.releases);
  if (!u) return '';
  return html`<p class="sr-sub sr-am-source">Scores from ${o.releases?.alphamissense?.label ?? 'AlphaMissense'}, ${extLink(u, L.recordLabel(u), 'Zenodo', { cls: '' })}.</p>`;
}

function predictionsSection(r, sub, o) {
  const f = residueFacts(r);
  const am = amForChange(r, sub);
  let amThis;
  if (sub.mismatch) amThis = html`<span class="sr-na">not shown: the typed ${sub.what} is not the model residue</span>`;
  else if (am) amThis = html`<strong class="sr-path sr-path--${am.amClass}">${fmtAm(am.am)}</strong> ${pathChip(am.amClass)} <span class="sr-badge sr-badge--muted" title="A computational prediction, not an observation">prediction</span>`;
  else if (r.kind === 'missense' && r.alt) amThis = html`<span class="sr-na">not available in this index</span>`;
  else amThis = html`<span class="sr-na">not a missense change</span>`;
  const body = html`<dl class="sr-facts">
    ${r.alt || sub.mismatch ? cell(html`${term(o, 'am', 'AlphaMissense')}, this change`, amThis) : ''}
    ${cell(html`${term(o, 'am', 'AlphaMissense')}, residue mean`, f.amMean === null ? html`<span class="sr-na">not available</span>` : html`${f.amMean.toFixed(2)}${f.amMeanClass ? html` ${pathChip(f.amMeanClass)}` : ''}`)}
  </dl>
  <div class="sr-gauge-row"><span class="sr-gauge-label">${sub.mismatch ? 'Residue mean' : (am ? 'This change' : 'Residue mean')}</span>${sub.mismatch || !am ? amGauge(f.amMean, { cls: f.amMeanClass }) : amGauge(am.am, { cls: am.amClass })}</div>
  ${amStrip(r, sub)}${pathLegend()}${amSource(o)}`;
  return section('predictions', 'Predictions', 'AlphaMissense', body, { idx: o.idx });
}

/** Conservation is measured from aligned homologous sequences: an observation, not a prediction, so it has its own section. */
function conservationSection(r, o) {
  const f = residueFacts(r);
  const src = o.releases?.conservation?.label;
  const body = html`<dl class="sr-facts">
    ${cell(term(o, 'conservation', 'Conservation at this residue'), f.conservation === null ? html`<span class="sr-na">not available</span>` : f.conservation.toFixed(2))}
  </dl>
  <div class="sr-gauge-row"><span class="sr-gauge-label">0 variable to 1 conserved</span>${plainGauge(f.conservation, 'Conservation')}</div>
  <p class="sr-sub">Measured from aligned homologous sequences${src ? `, ${src}` : ''}.</p>`;
  return section('conservation', 'Conservation', 'across homologous sequences', body, { idx: o.idx });
}

// --------------------------------------------------------------------------------- structure

/**
 * Whether each model has the contact at all: RRCS > 0 before rounding. The index carries this as a flag
 * (detail/ pairs), because a positive score below 0.005 is stored as 0.00 (RXFP2 364-483: active RRCS 0.0026);
 * absence is never read from a rounded value when the flag is there.
 */
export function contactPresence(c) {
  return {
    active: typeof c.activePresent === 'boolean' ? c.activePresent : c.active > 0,
    inactive: typeof c.inactivePresent === 'boolean' ? c.inactivePresent : c.inactive > 0,
  };
}

/** An RRCS endpoint for display: two decimals; a present contact whose score rounds to 0.00 shows as "<0.01". */
export function fmtRrcs(v, present = v > 0) {
  if (v === null || v === undefined) return 'n/a';
  const t = v.toFixed(2);
  return present && Number(t) === 0 ? '<0.01' : t;
}

/**
 * What the two models show for one contact, in a few words: "present only in the active model" when the inactive
 * model has no contact at all (and the reverse), else "stronger in the active model" or "stronger in the inactive
 * model" by the sign of ΔRRCS.
 */
export function activationWord(c) {
  const p = contactPresence(c);
  if (p.active && !p.inactive) return 'present only in the active model';
  if (p.inactive && !p.active) return 'present only in the inactive model';
  if (c.delta > 0) return 'stronger in the active model';
  if (c.delta < 0) return 'stronger in the inactive model';
  return 'the same in both models';
}

/** Plain words for one contact: what the two models show, never what the variant does. */
export function contactMeaning(c) {
  const p = contactPresence(c);
  if (p.active && !p.inactive) return 'present only in the active model: no contact in the inactive model';
  if (p.inactive && !p.active) return 'present only in the inactive model: no contact in the active model';
  if (c.delta > 0) return 'stronger in the active model: present in both models';
  if (c.delta < 0) return 'stronger in the inactive model: present in both models';
  return 'the same in both models: present in both at the same strength';
}

/** The net ΔRRCS of a residue in words: "overall its contacts are stronger in the inactive model (net ΔRRCS -13.0)". */
export function netSentence(net, { value = true } = {}) {
  if (net === null || net === undefined) return 'no contact in either model';
  const w = net > 0 ? 'are stronger in the active model' : net < 0 ? 'are stronger in the inactive model' : 'are balanced between the two models';
  return `overall its contacts ${w}${value ? ` (net ΔRRCS ${signed(net, 1)})` : ''}`;
}

/** A partner's own badges: CFR rank and the motifs it carries. */
function partnerBadges(c) {
  const b = [];
  if (c.partnerCfr) b.push(html`<span class="sr-badge sr-badge--cfr" title="Core functional residue, class-wide rank ${c.partnerCfrRank}">CFR ${c.partnerCfrRank}</span>`);
  for (const m of c.partnerMotifs ?? []) b.push(html`<span class="sr-badge sr-badge--cfr">${m}</span>`);
  return b.length ? html` ${b}` : '';
}

const partnerName = (c) => `${c.partnerAa ? three(c.partnerAa) : ''}${c.partnerPos}`;

function contactsTable(r, o) {
  const list = r.contacts;
  const thr = residueFacts(r).threshold;
  const thrText = thr === null ? 'this receptor’s threshold' : `this receptor’s threshold (|ΔRRCS| ≥ ${thr.toFixed(2)})`;
  if (list === undefined) return html`<p class="sr-na">The contact list is not available in this index.</p>`;
  if (!list.length) return html`<p>This residue takes part in no contact above ${thrText}.</p>`;
  const rows = list.map((c) => {
    const d = direction(c.delta);
    const kind = segmentKind(c.partnerSegment);
    return html`<tr>
      <td data-label="Partner">${intLink(L.residueUrl(o, r.gid, c.partnerPos), partnerName(c), { cls: 'mono', title: 'Report at this residue' })}${c.partnerGeneric || c.partnerSegment ? html` <span class="sr-sub">${[c.partnerGeneric, c.partnerSegment].filter(Boolean).join(', ')}</span>` : ''}${kind ? html` <span class="sr-badge sr-badge--muted" title="${kind === 'terminus' ? 'A residue in a terminus' : 'A residue in a loop'}: loops and termini are less reliably modeled">${kind}</span>` : ''}${partnerBadges(c)}</td>
      <td class="num" data-label="ΔRRCS"><span class="sr-net sr-net--${d.cls}">${signed(c.delta)}</span><span class="sr-sr-only"> (${d.word})</span></td>
      <td class="num" data-label="Active RRCS">${fmtRrcs(c.active, contactPresence(c).active)}</td>
      <td class="num" data-label="Inactive RRCS">${fmtRrcs(c.inactive, contactPresence(c).inactive)}</td>
      <td data-label="What the models show"><strong>${activationWord(c)}</strong><span class="sr-sub">: ${contactMeaning(c).split(': ')[1] ?? ''}</span></td>
      <td data-label="Report">${intLink(L.reportUrl(o, r.gid, `pair=${c.a}-${c.b}`), `pair ${c.a}-${c.b}`, { title: 'Report at this contact pair' })}</td></tr>`;
  });
  return html`<p class="sr-sub">${list.length} contact${list.length === 1 ? '' : 's'} above ${thrText}, largest |ΔRRCS| first.</p>
    <div class="sr-table-wrap"><table class="sr-table sr-table--contacts">
    <caption class="sr-sr-only">Contacts of this residue above the threshold</caption>
    <thead><tr><th scope="col">Partner</th><th scope="col" class="num">${term(o, 'delta', 'ΔRRCS')}</th><th scope="col" class="num">Active RRCS</th><th scope="col" class="num">Inactive RRCS</th><th scope="col">What the models show</th><th scope="col">Report</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    ${finePrint(html`<p><span class="sr-net sr-net--active">Red, positive</span>: stronger in the active model. <span class="sr-net sr-net--inactive">Blue, negative</span>: stronger in the inactive model. RRCS is the residue-residue contact score of each GPCRdb model (AlphaFold-Multistate, with plain AlphaFold2 for some states; the receptor report names the method of each); &lt;0.01 is a contact with a score above 0 that rounds to 0.00. “Present only in” one model means the other model has no contact at all.</p>`, { cls: 'sr-contacts-legend' })}`;
}

/** "Show in 3D": a button and an empty pane; search-page.js mounts the Studio pair viewer into it on demand. */
function show3dBlock(r, o) {
  if (!r.pos || !r.residue) return '';
  const idx = o.idx ?? 0;
  const n = r.contacts?.length ?? 0;
  return html`<div class="sr-3d" data-3d-box="${idx}">
    <button type="button" class="btn btn-ghost btn-sm" data-3d="${idx}" aria-expanded="false" aria-controls="sr-${idx}-3d-pane">Show in 3D</button>
    <span class="sr-sub">the two models superposed, ${three(r.residue.aa)}${r.pos} framed${n ? `, its ${n} contact${n === 1 ? '' : 's'} drawn red and blue` : ''}; loads the viewer and the models only when pressed</span>
    <span class="sr-3d-status" role="status" aria-live="polite"></span>
    <div class="sr-3d-pane rx-3d-pane" id="sr-${idx}-3d-pane" hidden role="group" aria-label="Active and inactive models of ${r.receptor?.symbol ?? r.gid}, superposed"></div>
  </div>`;
}

/** A motif as a badge; a motif the receptor does not carry is said so; the x of xMY is a window position. */
function motifBadge(m, aa) {
  const carried = m.carried !== false;
  const variable = !m.required;
  return html`<strong>${m.name}</strong> <span class="sr-sub">position ${m.position}${variable ? ' (the variable x of the window)' : m.canonical ? (m.canonical.includes(aa) ? `, canonical ${three(aa)}` : `, canonical ${m.canonical.split('').map(three).join(' or ')}; this receptor has ${three(aa)}`) : ''}${m.carried === false ? '; this receptor does not carry the full motif' : ''}</span>${m.key === 'xmy' && carried ? html` <span class="sr-sub">(${m.note})</span>` : ''}`;
}

function motifsCell(r) {
  const ms = r.motifs;
  if (ms === undefined) return '';
  const shown = ms.filter((m) => m.key !== 'xmy' || m.carried !== false);   // xMY is named only where the receptor carries it
  if (!shown.length) return cell('Motif', html`<span class="sr-na">not a motif position</span>`);
  const aa = r.residue?.aa ?? r.ref;
  return cell('Motif', html`${shown.map((m, i) => html`${i ? raw(', ') : ''}${motifBadge(m, aa)}`)}`);
}

// ------------------------------------------------------------------------ CFR neighbourhood

/**
 * The class-wide CFR set, named the same way everywhere: "one of the N top-ranked class-wide CFR positions (by CFR score)".
 * N is never typed here: it is meta.json `cfrTop` (search_index_v2 CFR_TOP = analysis/cfr_analysis.py CFR_TOP_N, the
 * size the report pages and the Statistics page use), passed in as `o.cfrTop` (search-page.js) or `ctx.cfrTop`.
 * @param {number|null|undefined} n
 */
export const cfrOneOf = (n) => `one of the ${n ? `${n} ` : ''}top-ranked class-wide CFR positions (by CFR score)`;
/** The CFR set in one plain line. */
export const cfrSetText = (n) => `CFR positions are the ${n ? `${n} ` : ''}top-ranked class-wide CFR positions (by CFR score), the positions search, the report snake plots and the Statistics page mark as CFR.`;
/** The group names of the CFR neighbourhood (search/cfrhood.js), as headings. */
export const CFR_GROUP_LABEL = Object.freeze({
  at: 'At a CFR position', connected: 'Connected to a CFR', near: 'Near a CFR in sequence', touch: 'In contact with a CFR, below threshold',
});
/** The same, in a few words, for chips and tiles. */
export const CFR_GROUP_SHORT = Object.freeze({ at: 'At a CFR', connected: 'Connected to a CFR', near: 'Near in sequence', touch: 'Contact below threshold' });
/** What each group means, in one sentence each (the glossary entries say the same). */
export const CFR_GROUP_DEF = Object.freeze({
  at: 'the residue sits at a CFR position.',
  connected: 'the residue takes part in a contact above the receptor’s ΔRRCS threshold whose partner sits at a CFR position.',
  near: `the residue is within ${NEAR_SEQ} residues of a CFR position along the chain, in the same segment.`,
  touch: 'the residue has a contact with a CFR residue in at least one model (RRCS above 0), below the threshold.',
});
const bwOf = (g) => (g ? String(g).split('x')[0] : null);
/** "Phe300 (6.48, rank 3)": a CFR residue with its BW number and class-wide rank. */
export const cfrName = (c) => {
  const bits = [bwOf(c.generic), c.rank ? `rank ${c.rank}` : null].filter(Boolean);
  return `${c.aa ? three(c.aa) : ''}${c.pos}${bits.length ? ` (${bits.join(', ')})` : ''}`;
};
const awayText = (k) => `${Math.abs(k)} residue${Math.abs(k) === 1 ? '' : 's'} away`;

/** One line for the Structure tile when the residue is not a CFR: connected to one, else near one in sequence. */
export function cfrTileLine(r) {
  const h = r.cfrHood;
  if (!h || h.at) return '';
  if (h.connected.length) return `Connected to CFR ${cfrName(h.connected[0])}${h.connected.length > 1 ? ` and ${h.connected.length - 1} more` : ''}`;
  if (h.near.length) return `${awayText(h.near[0].offset)} from CFR ${cfrName(h.near[0])}`;
  return '';
}

/** The residue's relation to the CFR positions in plain words, for the evidence summary and the copied text. */
export function cfrHoodSentence(r) {
  const h = r.cfrHood;
  if (!h) return null;
  const bits = [];
  if (h.connected.length) bits.push(`connected by ${h.connected.length === 1 ? 'a contact' : 'contacts'} above the threshold to CFR ${h.connected.map((c) => `${cfrName(c)} (ΔRRCS ${signed(c.delta)}, ${activationWord(c)})`).join(', ')}`);
  if (h.near.length) bits.push(`within ${NEAR_SEQ} residues in sequence of CFR ${h.near.map((c) => `${cfrName(c)}, ${awayText(c.offset)}`).join('; ')}`);
  if (h.touch?.length) bits.push(`in contact below the threshold with CFR ${h.touch.map((c) => cfrName(c)).join(', ')}`);
  if (!bits.length) return h.at ? null : `not connected to a CFR, not within ${NEAR_SEQ} residues of one${h.touch ? ' and not in contact with one' : ''}`;
  return bits.join('; ');
}

/**
 * "CFR neighbourhood" in the Contacts and structure section: whether the residue is at a CFR position, the CFR
 * residues it is connected to by above-threshold contacts (with ΔRRCS and the activation words), the CFR positions
 * within NEAR_SEQ residues in the same segment, and the CFR residues it touches below the threshold. What the models
 * show, nothing about what a variant does.
 */
function cfrHoodBlock(r, o) {
  const h = r.cfrHood;
  if (!h) return '';
  const res = `${three(r.residue?.aa ?? r.ref)}${r.pos}`;
  const items = [];
  items.push(html`<li data-cfr-rel="at"><span class="sr-cfrhood-k">At a CFR position</span> ${h.at ? html`<strong>yes</strong>, class-wide rank ${h.rank}` : 'no'}</li>`);
  if (h.connected.length) {
    const rows = h.connected.map((c) => {
      const d = direction(c.delta);
      return html`<tr>
        <td data-label="CFR partner">${intLink(L.residueUrl(o, r.gid, c.pos), `${three(c.aa)}${c.pos}`, { cls: 'mono', title: 'Report at this residue' })}${c.generic ? html` <span class="sr-sub">${c.generic}${c.segment ? `, ${c.segment}` : ''}</span>` : ''}</td>
        <td class="num" data-label="CFR rank">${c.rank ?? ''}</td>
        <td class="num" data-label="ΔRRCS"><span class="sr-net sr-net--${d.cls}">${signed(c.delta)}</span><span class="sr-sr-only"> (${d.word})</span></td>
        <td data-label="What the models show"><strong>${activationWord(c)}</strong></td>
        <td data-label="Report">${intLink(L.reportUrl(o, r.gid, `pair=${c.a}-${c.b}`), `pair ${c.a}-${c.b}`, { title: 'Report at this contact pair' })}</td></tr>`;
    });
    items.push(html`<li data-cfr-rel="connected"><span class="sr-cfrhood-k">${term(o, 'cfr-connected', 'Connected to a CFR')}</span> ${h.connected.length} CFR partner${h.connected.length === 1 ? '' : 's'} by contacts above the threshold
      <div class="sr-table-wrap"><table class="sr-table sr-table--cfrhood">
      <caption class="sr-sr-only">CFR residues connected to ${res} by contacts above the threshold</caption>
      <thead><tr><th scope="col">CFR partner</th><th scope="col" class="num">CFR rank</th><th scope="col" class="num">${term(o, 'delta', 'ΔRRCS')}</th><th scope="col">What the models show</th><th scope="col">Report</th></tr></thead>
      <tbody>${rows}</tbody></table></div></li>`);
  } else items.push(html`<li data-cfr-rel="connected"><span class="sr-cfrhood-k">${term(o, 'cfr-connected', 'Connected to a CFR')}</span> no contact above the threshold with a CFR residue</li>`);
  items.push(html`<li data-cfr-rel="near"><span class="sr-cfrhood-k">${term(o, 'cfr-near', 'Near a CFR in sequence')}</span> ${h.near.length
    ? html`${h.near.map((c, i) => html`${i ? '; ' : ''}${intLink(L.residueUrl(o, r.gid, c.pos), `${three(c.aa)}${c.pos}`, { cls: 'mono', title: 'Report at this residue' })} <span class="sr-sub">(${[bwOf(c.generic), c.rank ? `rank ${c.rank}` : null].filter(Boolean).join(', ')})</span>, ${awayText(c.offset)}`)} <span class="sr-sub">in ${r.residue?.segment ?? 'the same segment'}</span>`
    : `no CFR position within ${NEAR_SEQ} residues in the same segment`}</li>`);
  if (h.touch) {
    items.push(html`<li data-cfr-rel="touch"><span class="sr-cfrhood-k">${term(o, 'cfr-touch', 'In contact, below threshold')}</span> ${h.touch.length
      ? html`${h.touch.map((c, i) => { const d = direction(c.delta); return html`${i ? '; ' : ''}${intLink(L.residueUrl(o, r.gid, c.pos), `${three(c.aa)}${c.pos}`, { cls: 'mono', title: 'Report at this residue' })} <span class="sr-sub">(${[bwOf(c.generic), c.rank ? `rank ${c.rank}` : null].filter(Boolean).join(', ')})</span> <span class="sr-net sr-net--${d.cls}">${signed(c.delta)}</span>`; })}`
      : (h.connected.length ? 'no other contact with a CFR residue in either model' : 'no contact with a CFR residue in either model')}</li>`);
  }
  return html`<div class="sr-cfrhood" data-cfrhood="${h.group ?? 'none'}">
    <h5 class="sr-subhead">CFR neighborhood</h5>
    <p class="sr-sub sr-cfrhood-set">${cfrSetText(o.cfrTop)} ${term(o, 'cfr', 'What is a CFR?')}</p>
    <ul class="sr-cfrhood-list">${items}</ul>
    ${finePrint(html`<p>${CFR_GROUP_LABEL.connected}: ${CFR_GROUP_DEF.connected} ${CFR_GROUP_LABEL.near}: ${CFR_GROUP_DEF.near} ${CFR_GROUP_LABEL.touch}: ${CFR_GROUP_DEF.touch} These describe the two models, not the effect of a variant. <span class="sr-net sr-net--active">Red, positive</span> ΔRRCS: stronger in the active model; <span class="sr-net sr-net--inactive">blue, negative</span>: stronger in the inactive model.</p>`, { cls: 'sr-cfrhood-note' })}
  </div>`;
}

function structureSection(r, o) {
  const x = r.residue;
  if (!x) return '';
  const f = residueFacts(r);
  const cfr = x.cfr
    ? html`<strong>Yes</strong>, class-wide rank ${f.cfrRank}`
    : (f.cfrRank ? html`No, class-wide rank ${f.cfrRank}` : html`Not ranked`);
  const largest = f.dmax === null
    ? html`<span class="sr-na">no contacts</span>`
    : html`|ΔRRCS| ${f.dmax.toFixed(2)}${f.partner ? html`<span class="sr-sub">, with ${f.partner}</span>` : ''}`;
  const body = html`<dl class="sr-facts">
    ${cell(term(o, 'gn', 'Numbering'), html`${x.generic ? html`<span class="mono">${x.generic}</span> ` : ''}${x.bw ? html`<span class="sr-sub">BW ${x.bw}, GPCRdb ${x.gpcrdb}, ${x.segment}</span>` : html`<span class="sr-na">no generic number (${x.segment || 'outside the helices'})</span>`}`)}
    ${cell(html`Core functional residue (${term(o, 'cfr', 'CFR')}), class-wide`, cfr)}
    ${motifsCell(r)}
    ${cell(term(o, 'maxdelta', 'Largest contact change'), html`${largest}${r.rank?.rank ? html`<br><span class="sr-sub">rank ${r.rank.rank} of ${r.rank.of} residues in ${r.receptor?.symbol ?? r.gid} by largest |ΔRRCS|</span>` : ''}`)}
    ${f.net !== null ? cell(html`${term(o, 'signed', 'Net ΔRRCS')} over this residue’s contacts`, html`${netHtml(f.net, { word: false })} <span class="sr-sub">${netSentence(f.net, { value: false })}</span>`) : ''}
    ${cell(html`Contacts above this receptor’s ${term(o, 'threshold', 'threshold')}`, html`${f.nsig ?? 0}${f.threshold !== null ? html` <span class="sr-sub">(|ΔRRCS| ≥ ${f.threshold.toFixed(2)})</span>` : ''}`)}
  </dl>
  <h5 class="sr-subhead">Important contacts</h5>
  ${contactDumbbells(r)}
  ${contactsTable(r, o)}
  ${cfrHoodBlock(r, o)}
  ${show3dBlock(r, o)}`;
  return section('structure', 'Contacts and structure', `in ${DB_NAME}`, body, { idx: o.idx });
}

// --------------------------------------------------------------------------- evidence summary

/** 'Ionic lock' reads 'ionic lock' inside a sentence; acronym names (DRY, NPxxY) keep their case. */
const motifPhrase = (name) => (/^[A-Z][a-z]/.test(name) ? name[0].toLowerCase() + name.slice(1) : name);

/**
 * The plain-language evidence summary at the top of a card, as sentences (no markup): what the change is,
 * the population, clinical and computational evidence, and what the models show. On a reference mismatch the
 * typed change is reported as not checkable and the rest is about the model residue.
 */
export function summarySentences(r, o = {}) {
  const S = [];
  if (!r.pos) return S;
  const sub = subjectOf(r, o);
  const f = residueFacts(r);
  const x = r.residue;
  const sym = r.receptor?.symbol ?? r.gid;
  const res = `${three(x?.aa ?? r.ref)}${r.pos}`;
  const where = x?.generic ? `${x.generic}, ${x.segment}` : (x?.segment ? `${x.segment}, no generic number` : '');
  if (sub.mismatch) S.push(`${sub.unverifiable}. What follows is about the model residue ${res}${where ? ` (${where})` : ''}.`);
  else if (sub.change && r.kind === 'missense') S.push(`${sym} ${hgvsP(r)} (${r.ref}${r.pos}${r.alt}) is a missense change at residue ${res}${where ? ` (${where})` : ''}.`);
  else if (sub.change) S.push(`${sym} ${hgvsP(r)} is a ${kindLabel(r.kind).toLowerCase()} at residue ${res}${where ? ` (${where})` : ''}; the predictions and contacts below describe the residue, not this change.`);
  else S.push(`${sym} residue ${res}${where ? ` (${where})` : ''}.`);
  const gl = r.releases?.gnomad ?? o.releases?.gnomad?.label ?? 'gnomAD';
  const alleles = r.alleles ?? [];
  if (alleles.length) {
    const one = (a) => `allele frequency ${fmtAf(a.af)} (${fmtInt(a.ac)} of ${fmtInt(a.an)} alleles, ${fmtInt(a.hom)} ${a.hom === 1 ? 'homozygote' : 'homozygotes'}${sourceWord(a.source) ? `, ${sourceWord(a.source)}` : ''})`;
    S.push(alleles.length === 1 ? `${gl}: ${one(alleles[0])}.` : `${gl}: ${alleles.length} alleles give this change: ${alleles.map((a) => `${a.id} ${one(a)}`).join('; ')}.`);
  } else if (!sub.mismatch && r.kind === 'missense' && r.alt) S.push(`Not listed in ${gl}.`);
  else if (!sub.mismatch && (r.residueAlleles ?? []).length) S.push(`${gl}: ${r.residueAlleles.length} missense allele${r.residueAlleles.length === 1 ? '' : 's'} at this residue.`);
  const cl = r.releases?.clinvar ?? o.releases?.clinvar?.label ?? 'ClinVar';
  const cv = r.clinvar ?? [];
  if (cv.length && !sub.mismatch) {
    const c = cv[0];
    const bits = [`${c.stars ?? 0} of 4 review stars`];
    if (c.scv) bits.push(`${c.scv} ${c.scv === 1 ? 'submission' : 'submissions'}`);
    S.push(`${cl}: ${c.classification || 'no classification'} (${bits.join(', ')})${c.conditions?.length ? `, ${c.conditions.slice(0, 2).join('; ')}${c.conditions.length > 2 ? ' and more' : ''}` : ''}${cv.length > 1 ? `; ${cv.length - 1} more ${cv.length === 2 ? 'record' : 'records'}` : ''}.`);
  } else if (!sub.mismatch) S.push(`No ${cl} record for this ${sub.change ? 'change' : 'residue'}.`);
  const am = amForChange(r, sub);
  const cons = f.conservation === null ? '' : ` Conservation at the residue: ${f.conservation.toFixed(2)} on a 0 to 1 scale.`;
  if (am) S.push(`AlphaMissense predicts ${amClassLabel(am.amClass)} (score ${fmtAm(am.am)}); this is a prediction, not an observation.${cons}`);
  else if (!sub.mismatch && r.kind === 'missense' && r.alt) S.push(`AlphaMissense prediction for this change: not available.${cons}`);
  else if (cons) S.push(cons.trim());
  if (x) {
    const parts = [];
    if (x.cfr) parts.push(`a core functional residue (CFR, class-wide rank ${f.cfrRank})`);
    const carried = (r.motifs ?? []).filter((m) => m.carried !== false && m.required);
    if (carried.length) parts.push(`part of the ${carried.map((m) => motifPhrase(m.name)).join(' and the ')}`);
    let contacts;
    if (r.contacts === undefined) contacts = 'its contact list is not available in this index';
    else if (!r.contacts.length) contacts = 'it takes part in no contact above the receptor’s threshold';
    else {
      const t = r.contacts[0];
      contacts = `it takes part in ${r.contacts.length} contact${r.contacts.length === 1 ? '' : 's'} above the receptor’s threshold; the largest, with ${partnerName(t)}${t.partnerGeneric ? ` (${t.partnerGeneric})` : ''}, is ${activationWord(t)} (ΔRRCS ${signed(t.delta)})${f.net !== null ? `; ${netSentence(f.net)}` : ''}`;
    }
    S.push(`In the GPCompaRe models, ${res} is ${parts.length ? `${parts.join(' and ')}; ` : 'not a CFR; '}${contacts}.`);
    const hood = x.cfr ? null : cfrHoodSentence(r);
    if (hood && (r.cfrHood?.connected.length || r.cfrHood?.near.length)) S.push(`It is ${hood}.`);
  }
  return S;
}

/** Research-use note, one sentence, shown under the summary and in the evidence text. */
export const RESEARCH_NOTE = 'Research use only. This card summarizes database records and computational predictions; it is not a clinical classification and ACMG criteria are not applied.';
/** The same, as the one line of fine print on the card. */
export const RESEARCH_NOTE_SHORT = 'Research use only: not a clinical classification; ACMG criteria are not applied.';

// ----------------------------------------------------------------- pathogenicity palette, gauges

/**
 * AlphaMissense class cutoffs (Cheng et al. 2023, Science; the AlphaMissense README): likely pathogenic > 0.564,
 * ambiguous 0.34 to 0.564 (both inclusive), likely benign < 0.34. The index carries each prediction's source class
 * (and the class of each unrounded residue mean); amClassOfScore is only the fallback for a value without one.
 */
export const AM_CUTS = Object.freeze({ benign: 0.34, pathogenic: 0.564 });
export const amClassOfScore = (v) => (v < AM_CUTS.benign ? 'benign' : v > AM_CUTS.pathogenic ? 'pathogenic' : 'ambiguous');
/** The interval of each class, as the report's Understanding section states it. */
export const AM_INTERVAL = Object.freeze({ pathogenic: 'score > 0.564', ambiguous: '0.34 ≤ score ≤ 0.564', benign: 'score < 0.34' });
/** One sentence for every place that states the cutoffs (the report's wording). */
export const AM_CUTS_TEXT = 'Likely pathogenic: score > 0.564. Ambiguous: 0.34 ≤ score ≤ 0.564. Likely benign: score < 0.34. Classes follow the source predictions before display rounding.';
/**
 * The pathogenicity palette, one CSS token pair per class (static/css/search-ui.css --path-<class> for text and
 * marks, --path-<class>-fill for cells and bars). Teal, amber and purple: distinguishable for the common colour
 * vision deficiencies and never the red and blue that mean active and inactive. Every use carries a label too.
 */
export const PATH_CLASSES = Object.freeze(['benign', 'ambiguous', 'pathogenic']);
const pct = (x) => `${(Math.max(0, Math.min(1, x)) * 100).toFixed(1)}%`;

/** A pathogenicity class as a labelled chip. `none` is the neutral chip. */
export const pathChip = (cls, label) => html`<span class="sr-path-chip sr-path-chip--${cls ?? 'none'}">${label ?? amClassLabel(cls)}</span>`;

/**
 * A 0..1 gauge with the three AlphaMissense class zones, the two cutoffs and a marker at `value` (null = none).
 * `cls` is the class from the source (before rounding); the score's own class is only the fallback.
 */
export function amGauge(value, { label = 'AlphaMissense', cls: given = null } = {}) {
  const cls = value === null || value === undefined ? null : (given ?? amClassOfScore(value));
  const text = cls ? `${label} ${fmtAm(value)}, ${amClassLabel(cls)}` : `${label}: no score`;
  return html`<div class="sr-gauge sr-gauge--am" role="img" aria-label="${text}">
    <div class="sr-gauge-zones"><span class="sr-zone sr-zone--benign" style="width:${pct(AM_CUTS.benign)}"></span><span class="sr-zone sr-zone--ambiguous" style="width:${pct(AM_CUTS.pathogenic - AM_CUTS.benign)}"></span><span class="sr-zone sr-zone--pathogenic" style="width:${pct(1 - AM_CUTS.pathogenic)}"></span></div>
    ${cls ? html`<span class="sr-gauge-mark sr-gauge-mark--${cls}" style="left:${pct(value)}"></span>` : ''}
    <div class="sr-gauge-ticks"><span style="left:${pct(AM_CUTS.benign)}">${AM_CUTS.benign}</span><span style="left:${pct(AM_CUTS.pathogenic)}">${AM_CUTS.pathogenic}</span></div>
  </div>`;
}

/** A neutral 0..1 gauge (conservation): one grey ramp and a marker. */
export function plainGauge(value, label) {
  const has = value !== null && value !== undefined;
  return html`<div class="sr-gauge sr-gauge--plain" role="img" aria-label="${label} ${has ? value.toFixed(2) : 'not available'} on a 0 to 1 scale">
    <div class="sr-gauge-zones"><span class="sr-zone sr-zone--ramp" style="width:100%"></span></div>
    ${has ? html`<span class="sr-gauge-mark" style="left:${pct(value)}"></span>` : ''}
    <div class="sr-gauge-ticks"><span style="left:0">0</span><span style="left:50%">0.5</span><span style="left:100%">1</span></div>
  </div>`;
}

/** Rarity bands for an allele frequency (descriptive, not a classification rule). */
export const AF_BANDS = Object.freeze([
  { key: 'rare', label: 'rare', max: 0.001, text: 'below 0.1%' },
  { key: 'low', label: 'low frequency', max: 0.01, text: '0.1% to 1%' },
  { key: 'common', label: 'common', max: 1, text: 'above 1%' },
]);
export const afBand = (af) => (af === null || af === undefined ? null : AF_BANDS.find((b) => af < b.max) ?? AF_BANDS[AF_BANDS.length - 1]);
const AF_FLOOR = 1e-6;
const afPos = (af) => Math.max(0, Math.min(1, (Math.log10(Math.max(af, AF_FLOOR)) + 6) / 6));

/** Allele frequency on a log scale from 1e-6 to 1 with the three rarity bands (neutral greys) and a marker. */
export function afGauge(af, label = 'Allele frequency') {
  const band = afBand(af);
  const w = (lo, hi) => pct(afPos(hi) - afPos(lo));
  return html`<div class="sr-gauge sr-gauge--af" role="img" aria-label="${label} ${af === null || af === undefined ? 'not listed' : `${fmtAf(af)}, ${band.label}`}">
    <div class="sr-gauge-zones"><span class="sr-zone sr-zone--rare" style="width:${w(AF_FLOOR, 0.001)}"></span><span class="sr-zone sr-zone--low" style="width:${w(0.001, 0.01)}"></span><span class="sr-zone sr-zone--common" style="width:${w(0.01, 1)}"></span></div>
    ${band ? html`<span class="sr-gauge-mark" style="left:${pct(afPos(af))}"></span>` : ''}
    <div class="sr-gauge-ticks"><span style="left:${pct(afPos(0.001))}">0.1%</span><span style="left:${pct(afPos(0.01))}">1%</span></div>
  </div>`;
}

/** The pathogenicity class of a ClinVar classification: P/LP, B/LB, VUS or conflicting (ambiguous), else none. */
export function cvClassKey(classification) {
  const k = CLINVAR_GROUPS.find((g) => g.test(String(classification ?? '')))?.key;
  return { plp: 'pathogenic', blb: 'benign', vus: 'ambiguous', conflict: 'ambiguous' }[k] ?? 'none';
}

/** One legend for every place the pathogenicity palette is used. */
export function pathLegend({ cuts = true } = {}) {
  return html`<ul class="sr-path-legend" aria-label="Pathogenicity classes">${PATH_CLASSES.map((c) => html`<li><span class="sr-path-swatch sr-path-swatch--${c}" aria-hidden="true"></span>${amClassLabel(c)}${cuts ? html` <span class="sr-sub">${AM_INTERVAL[c]}</span>` : ''}</li>`)}</ul>${cuts ? html`<p class="sr-sub sr-path-note">Classes follow the source predictions before display rounding.</p>` : ''}`;
}

// ------------------------------------------------------------------------------------- tiles

const NAV = Object.freeze([
  ['summary', 'Summary'], ['structure', 'Contacts and structure'], ['region', 'Receptor map'], ['predictions', 'Predictions'], ['conservation', 'Conservation'],
  ['population', 'Population'], ['clinical', 'Clinical'], ['refs', 'Notations and references'],
]);
const secId = (idx, key) => `sr-${idx}-${key}`;

/** The section navigation of one card: a sticky column on wide screens, a chip row on phones. */
function navBlock(idx, keys) {
  return html`<nav class="sr-nav" aria-label="Sections of this result"><ul>${NAV.filter(([k]) => keys.has(k)).map(([k, l]) => html`<li><a href="#${secId(idx, k)}" data-nav="${idx}">${l}</a></li>`)}</ul></nav>`;
}

/** The summary tiles: five facts readable in a few seconds, each linking to its section. */
function tiles(r, o, sub) {
  const f = residueFacts(r);
  const x = r.residue;
  const idx = o.idx ?? 0;
  const na = html`<span class="sr-na">not available</span>`;
  const tile = (key, title, body, foot = '') => html`<li class="sr-tile sr-tile--${key}"><a class="sr-tile-k" href="#${secId(idx, key)}" data-nav="${idx}">${title}</a><div class="sr-tile-v">${body}</div>${foot ? html`<div class="sr-tile-f">${foot}</div>` : ''}</li>`;
  // structure: CFR, motif, contacts
  const top = r.contacts?.[0];
  const motifs = (r.motifs ?? []).filter((m) => m.carried !== false && m.required);
  const structHead = x ? html`<span class="sr-big">${x.cfr ? `CFR, rank ${f.cfrRank}` : (f.cfrRank ? `Not a CFR, rank ${f.cfrRank}` : 'Not a CFR')}</span>${motifs.length ? html` ${motifs.map((m) => html`<span class="sr-badge sr-badge--cfr">${m.name}</span> `)}` : ''}` : na;
  const cfrLine = x ? cfrTileLine(r) : '';
  const cfrFoot = cfrLine ? html`<span class="sr-tile-line sr-tile-cfr" data-cfr-tile>${cfrLine}</span>` : '';
  const structFoot = !x ? '' : r.contacts === undefined ? 'contact list not available'
    : !r.contacts.length ? html`${cfrFoot}<span class="sr-tile-line">no contact above the threshold</span>`
      : html`${cfrFoot}<span class="sr-tile-line"><span class="mono">${partnerName(top)}</span> <span class="sr-net sr-net--${direction(top.delta).cls}">${signed(top.delta)}</span>, ${activationWord(top)}</span><span class="sr-tile-line">${r.contacts.length} contact${r.contacts.length === 1 ? '' : 's'} above threshold</span>`;
  // AlphaMissense
  const am = amForChange(r, sub);
  const missense = r.kind === 'missense' && /^[A-Z]$/.test(r.alt ?? '');
  let amBody; let amVal = null; let amCls = null;
  if (sub.mismatch) amBody = html`<span class="sr-na">typed ${sub.what} not checkable</span>`;
  else if (am) { amBody = html`<span class="sr-big sr-path sr-path--${am.amClass}">${fmtAm(am.am)}</span> ${pathChip(am.amClass)}`; amVal = am.am; amCls = am.amClass; }
  else if (missense) amBody = html`<span class="sr-na">no score for this change</span>`;
  else if (f.amMean !== null) { amBody = html`<span class="sr-big">${f.amMean.toFixed(2)}</span> <span class="sr-sub">residue mean</span>`; amVal = f.amMean; amCls = f.amMeanClass; }
  else amBody = na;
  // population
  const alleles = r.alleles ?? [];
  const best = alleles.length ? alleles.reduce((p, a) => ((a.af ?? -1) > (p.af ?? -1) ? a : p)) : null;
  const gl = r.releases?.gnomad ?? o.releases?.gnomad?.label ?? 'gnomAD';
  let popBody; let popFoot = '';
  if (best) {
    popBody = html`<span class="sr-big">${fmtAf(best.af)}</span> <span class="sr-badge sr-badge--muted">${afBand(best.af)?.label}</span>`;
    popFoot = html`${fmtInt(best.ac)} of ${fmtInt(best.an)} alleles, ${fmtInt(best.hom)} ${best.hom === 1 ? 'homozygote' : 'homozygotes'}${alleles.length > 1 ? `; ${alleles.length} alleles give this change` : ''}`;
  } else if (sub.mismatch) popBody = html`<span class="sr-na">not looked up</span>`;
  else if (missense) popBody = html`<span class="sr-na">not in ${gl}</span>`;
  else popBody = html`<span class="sr-big">${(r.residueAlleles ?? []).length}</span> <span class="sr-sub">missense allele${(r.residueAlleles ?? []).length === 1 ? '' : 's'} at this residue</span>`;
  // ClinVar
  const cv = sub.mismatch ? [] : (r.clinvar ?? []);
  const c0 = cv[0];
  const cvBody = c0
    ? html`${pathChip(cvClassKey(c0.classification), c0.classification || 'no classification')} ${stars(c0.stars)}`
    : html`<span class="sr-na">${sub.mismatch ? 'not looked up' : 'no record'}</span>`;
  const cvFoot = c0 ? html`${c0.conditions?.length ? `${c0.conditions.slice(0, 2).join('; ')}${c0.conditions.length > 2 ? '; more' : ''}` : 'no condition given'}${cv.length > 1 ? `; ${cv.length} records` : ''}` : '';
  return html`<ul class="sr-tiles">
    ${tile('structure', 'Structure', structHead, structFoot)}
    ${tile('predictions', 'AlphaMissense', html`${amBody}${amGauge(amVal, { cls: amCls })}`, html`<span class="sr-sub">prediction, not an observation</span>`)}
    ${tile('population', 'Population', html`${popBody}${afGauge(best?.af ?? null)}`, popFoot)}
    ${tile('clinical', 'ClinVar', cvBody, cvFoot)}
    ${tile('conservation', 'Conservation', html`<span class="sr-big">${f.conservation === null ? html`<span class="sr-na">n/a</span>` : f.conservation.toFixed(2)}</span>${plainGauge(f.conservation, 'Conservation')}`, html`<span class="sr-sub">0 variable to 1 conserved</span>`)}
  </ul>`;
}

/** The compact identifier line under the title: c. on MANE, GRCh38 allele, rsID, ClinVar record, UniProt. */
function idLine(r, o, sub) {
  if (!r.pos) return '';
  const rel = o.releases;
  const items = [];
  const tv = r.transcriptViews ?? [];
  const mane = tv.find((t) => t.role === 'mane' && t.c) ?? tv.find((t) => t.c);
  if (mane && !sub.mismatch) items.push(html`<span class="mono">${mane.transcript}:${mane.c}</span>`);
  for (const a of (r.alleles ?? []).slice(0, 2)) items.push(g38Link(a.id, rel));
  for (const rs of [...new Set((r.alleles ?? []).flatMap((a) => a.rsids ?? []))].slice(0, 2)) items.push(extLink(L.dbsnpUrl(rs), rs, SITE.dbsnp));
  if (!sub.mismatch) for (const c of (r.clinvar ?? []).slice(0, 2)) items.push(extLink(c.url ?? L.clinvarUrl(c.variationId), c.accession, SITE.clinvar));
  if (r.receptor?.uniprot) items.push(extLink(L.uniprotUrl(r.receptor.uniprot), r.receptor.uniprot, 'UniProt'));
  if (!items.length) return '';
  return html`<p class="sr-idline">${items.map((it, i) => html`${i ? html`<span class="sr-dot" aria-hidden="true">·</span>` : ''}${it}`)}</p>`;
}

// -------------------------------------------------------------------------------- bar charts

/**
 * The residue's contacts as inactive-to-active dumbbells: one dot at the inactive RRCS, one at the active RRCS,
 * the line between them blue when the contact is stronger in the inactive model and red when it is stronger in the
 * active model; the words
 * beside each. Largest |ΔRRCS| first.
 */
function contactDumbbells(r) {
  const list = r.contacts;
  if (!list?.length) return '';
  const max = Math.max(...list.map((c) => Math.max(c.active, c.inactive))) || 1;
  return html`<ol class="sr-dbs" aria-label="Contacts of this residue, inactive to active model">${list.map((c) => {
    const d = direction(c.delta);
    const xi = pct(c.inactive / max); const xa = pct(c.active / max);
    const lo = Math.min(c.inactive, c.active) / max; const hi = Math.max(c.inactive, c.active) / max;
    return html`<li class="sr-db-row"><span class="sr-db-label"><span class="mono">${partnerName(c)}</span>${c.partnerGeneric ? html` <span class="sr-sub">${c.partnerGeneric}</span>` : ''}${partnerBadges(c)}</span><span class="sr-db-track" title="inactive ${fmtRrcs(c.inactive, contactPresence(c).inactive)}, active ${fmtRrcs(c.active, contactPresence(c).active)}"><span class="sr-db-line sr-db-line--${d.cls}" style="left:${pct(lo)};width:${pct(hi - lo)}"></span><span class="sr-db-dot sr-db-dot--inactive" style="left:${xi}"><span class="sr-sr-only">inactive RRCS ${fmtRrcs(c.inactive, contactPresence(c).inactive)}</span></span><span class="sr-db-dot sr-db-dot--active" style="left:${xa}"><span class="sr-sr-only">active RRCS ${fmtRrcs(c.active, contactPresence(c).active)}</span></span></span><span class="sr-db-val"><span class="sr-net sr-net--${d.cls}">${signed(c.delta)}</span> <span class="sr-db-word">${activationWord(c)}</span></span></li>`;
  })}</ol>
  <p class="sr-db-legend"><span class="sr-db-dot sr-db-dot--inactive sr-db-key" aria-hidden="true"></span> inactive model <span class="sr-db-dot sr-db-dot--active sr-db-key" aria-hidden="true"></span> active model, RRCS on one scale; <span class="sr-net sr-net--active">red</span>: stronger in the active model; <span class="sr-net sr-net--inactive">blue</span>: stronger in the inactive model.</p>`;
}

/** Allele frequency bars, one per gnomAD allele of the change, with the rarity bands and the homozygote count. */
function afBars(r) {
  const alleles = r.alleles ?? [];
  if (!alleles.length) return '';
  return html`<div class="sr-afbars">${alleles.map((a) => html`<div class="sr-afbar">
      <span class="sr-afbar-label">${sourceWord(a.source) ?? 'gnomAD'}${alleles.length > 1 ? html` <span class="sr-sub mono">${a.id}</span>` : ''}</span>
      ${afGauge(a.af, `Allele frequency, ${sourceWord(a.source) ?? 'gnomAD'}`)}
      <span class="sr-afbar-val"><strong>${fmtAf(a.af)}</strong> <span class="sr-sub">${afBand(a.af)?.label ?? ''}; ${fmtInt(a.hom)} ${a.hom === 1 ? 'homozygote' : 'homozygotes'}</span></span></div>`)}
    <ul class="sr-band-legend" aria-label="Rarity bands">${AF_BANDS.map((b) => html`<li><span class="sr-band-swatch sr-band-swatch--${b.key}" aria-hidden="true"></span>${b.label} <span class="sr-sub">${b.text}</span></li>`)}</ul>
    <p class="sr-sub">One count per allele is held (exomes where present, else genomes); a combined or per-population frequency is not.</p></div>`;
}

// ------------------------------------------------------------------------------ receptor map

/**
 * The receptor map: a linear track of the receptor with the helices, the queried residue, its contact partners as
 * arcs (red = stronger in the active model, blue = inactive), CFR positions, the mean AlphaMissense per residue
 * as a heat band, and ticks where gnomAD and ClinVar hold records. Data: result.track (residues and variants
 * shards already loaded for the card) and result.contacts.
 */
export function receptorMap(r, o) {
  const t = r.track;
  if (!t || !r.pos) return '';
  const idx = o.idx ?? 0;
  const sym = r.receptor?.symbol ?? r.gid;
  const W = 1000; const n = t.length;
  const xOf = (p) => ((p - 0.5) / n) * W;
  const Y = { arc: 50, cfr: 46, seg: 56, segH: 16, am: 78, amH: 6, allele: 88, cv: 95, axis: 112 };
  const segs = t.segments.map(([name, a, b]) => {
    const helix = HELICES.has(name);
    const x1 = ((a - 1) / n) * W; const x2 = (b / n) * W;
    return html`<rect class="sr-map-seg ${helix ? 'is-helix' : 'is-loop'}" x="${x1.toFixed(1)}" y="${helix ? Y.seg : Y.seg + 5}" width="${(x2 - x1).toFixed(1)}" height="${helix ? Y.segH : Y.segH - 10}"><title>${name}: residues ${a} to ${b}</title></rect>${helix && x2 - x1 > 26 ? html`<text class="sr-map-seglabel" x="${((x1 + x2) / 2).toFixed(1)}" y="${Y.seg + 12}" text-anchor="middle">${name}</text>` : ''}`;
  });
  const runs = [];
  let run = null;
  t.am.forEach((v, i) => {
    const k = v === null || v === undefined ? 'none' : (t.amClass?.[i] ?? amClassOfScore(v));
    if (run && run.k === k) run.b = i + 1;
    else { if (run) runs.push(run); run = { k, a: i + 1, b: i + 1 }; }
  });
  if (run) runs.push(run);
  const heat = runs.map(({ k, a, b }) => html`<rect class="sr-map-am sr-map-am--${k}" x="${(((a - 1) / n) * W).toFixed(1)}" y="${Y.am}" width="${(((b - a + 1) / n) * W).toFixed(1)}" height="${Y.amH}"/>`);
  const ticks = (ps, y, cls, h) => ps.map((p) => html`<rect class="${cls}" x="${(xOf(p) - 0.7).toFixed(1)}" y="${y}" width="1.4" height="${h}"/>`);
  const partners = new Set((r.cfrHood?.connected ?? []).map((c) => c.pos));
  const cfr = t.cfr.map((p) => {
    const cls = p === r.pos ? ' is-this' : partners.has(p) ? ' is-partner' : '';
    const sz = partners.has(p) && p !== r.pos ? 1.6 : 1;
    return html`<path class="sr-map-cfr${cls}"${partners.has(p) ? html` data-cfr-partner="${p}"` : ''} d="M${xOf(p).toFixed(1)} ${(Y.cfr - 4 * sz).toFixed(1)} l${(3.5 * sz).toFixed(1)} ${(4 * sz).toFixed(1)} l${(-3.5 * sz).toFixed(1)} ${(4 * sz).toFixed(1)} l${(-3.5 * sz).toFixed(1)} ${(-4 * sz).toFixed(1)} z"><title>${partners.has(p) ? `CFR position connected to ${three(r.residue?.aa ?? r.ref)}${r.pos}, residue ${p}` : `CFR position, residue ${p}`}</title></path>`;
  });
  const contacts = r.contacts ?? [];
  const cmax = Math.max(...contacts.map((c) => Math.abs(c.delta)), 0.01);
  const arcs = contacts.map((c) => {
    const x1 = xOf(r.pos); const x2 = xOf(c.partnerPos);
    const h = Math.min(44, 10 + Math.abs(x2 - x1) / 6);
    const d = direction(c.delta);
    return html`<path class="sr-map-arc sr-map-arc--${d.cls}" d="M${x1.toFixed(1)} ${Y.arc} Q${((x1 + x2) / 2).toFixed(1)} ${(Y.arc - 2 * h).toFixed(1)} ${x2.toFixed(1)} ${Y.arc}" style="stroke-width:${(1 + 2.5 * Math.abs(c.delta) / cmax).toFixed(1)}"><title>${partnerName(c)}: ΔRRCS ${signed(c.delta)}, ${d.word}</title></path>`;
  });
  const xr = xOf(r.pos);
  const res = `${three(r.residue?.aa ?? r.ref)}${r.pos}`;
  const step = n > 700 ? 200 : 100;
  const axis = [];
  for (let p = step; p <= n; p += step) axis.push(html`<text class="sr-map-axis" x="${xOf(p).toFixed(1)}" y="${Y.axis}" text-anchor="middle">${p}</text>`);
  const label = `${sym}, ${n} residues; ${res} marked${contacts.length ? `, ${contacts.length} contact partner${contacts.length === 1 ? '' : 's'} drawn as arcs` : ''}; ${t.cfr.length} CFR positions${partners.size ? `, ${partners.size} of them connected to ${res} (larger marks)` : ''}; ${t.alleles.length} residues with gnomAD alleles; ${t.clinvar.length} with ClinVar records`;
  return html`<figure class="sr-map" data-map="${idx}" data-length="${n}" data-symbol="${sym}">
    <svg class="sr-map-svg" viewBox="0 0 ${W} 118" preserveAspectRatio="none" role="img" aria-label="${label}">
      ${arcs}
      ${segs}${cfr}${heat}
      ${ticks(t.alleles, Y.allele, 'sr-map-tick sr-map-tick--allele', 5)}
      ${ticks(t.clinvar, Y.cv, 'sr-map-tick sr-map-tick--cv', 5)}
      ${axis}
      <line class="sr-map-res" x1="${xr.toFixed(1)}" x2="${xr.toFixed(1)}" y1="${Y.arc - 2}" y2="${Y.cv + 6}"/>
      <text class="sr-map-reslabel" x="${xr.toFixed(1)}" y="${Y.axis}" text-anchor="${xr < 60 ? 'start' : xr > W - 60 ? 'end' : 'middle'}">${res}</text>
      <rect class="sr-map-hit" data-map-hit="${idx}" x="0" y="${Y.cfr - 8}" width="${W}" height="${Y.cv + 8 - (Y.cfr - 8)}" fill="transparent"><title>Click a position to search it</title></rect>
    </svg>
    <figcaption class="sr-map-legend">
      <ul class="sr-map-keys"><li><span class="sr-map-key sr-map-key--helix" aria-hidden="true"></span>helix</li><li><span class="sr-map-key sr-map-key--loop" aria-hidden="true"></span>loop or terminus</li><li><span class="sr-map-key sr-map-key--cfr" aria-hidden="true"></span>CFR position</li>${partners.size ? html`<li><span class="sr-map-key sr-map-key--cfr-partner" aria-hidden="true"></span>CFR connected to ${three(r.residue?.aa ?? r.ref)}${r.pos}</li>` : ''}<li><span class="sr-map-key sr-map-key--arc-active" aria-hidden="true"></span><span class="sr-map-key sr-map-key--arc-inactive" aria-hidden="true"></span>contact, stronger in the active / inactive model</li><li><span class="sr-map-key sr-map-key--am" aria-hidden="true"></span>mean AlphaMissense per residue (class colors)</li><li><span class="sr-map-key sr-map-key--tick" aria-hidden="true"></span>gnomAD allele (upper) and ClinVar record (lower)</li></ul>
      <form class="sr-map-go" data-map-go="${idx}"><label>Residue <input type="number" class="v2-input" name="pos" min="1" max="${n}" value="${r.pos}" inputmode="numeric"></label> <button type="submit" class="btn btn-ghost btn-sm">Search</button> ${intLink(L.residueUrl(o, r.gid, r.pos), `${res} in the report`, { cls: 'btn btn-ghost btn-sm', title: 'Report at this residue' })}<span class="sr-sub sr-map-hint">Click the track to search a position.</span></form>
    </figcaption>
  </figure>`;
}

function regionSection(r, o) {
  const map = receptorMap(r, o);
  if (!map) return '';
  return section('region', 'Receptor map', 'segments, CFR positions, contacts, records', map, { idx: o.idx });
}

/** The plain-language summary, folded at the end of the card (the "Copy evidence summary" text carries it too). */
function proseSection(r, o) {
  const S = summarySentences(r, o);
  if (!S.length) return '';
  return section('prose', 'In words', 'the evidence as sentences', html`<p class="sr-summary-text">${S.map((s, i) => html`${i ? raw(' ') : ''}<span class="sr-sentence">${s}</span>`)}</p>`, { open: false, idx: o.idx });
}

// --------------------------------------------------------------- copy buttons' text

/**
 * Everything the "Copy all notations" button copies, as text. On a reference mismatch the typed change
 * comes first, marked as not checkable; the model residue follows on its own; the correction is a suggestion.
 *
 * @param {object} r a result
 * @param {{typed?: object, interp?: object, alternates?: object[]}} [ctx] renderAnswer()'s ctx
 */
export function notationsText(r, ctx = {}) {
  const out = [];
  const sub = subjectOf(r, ctx);
  if (!r.pos) {
    out.push(`${recFull(r.receptor)}: no residue was placed`);
    return out.join('\n');
  }
  const resLine = `${three(r.residue?.aa ?? r.ref)}${r.pos}${r.residue?.generic ? ` (${r.residue.generic}, ${r.residue.segment})` : ''}`;
  if (sub.mismatch) {
    out.push(recFull(r.receptor));
    out.push(`Typed ${sub.what}: ${sub.unverifiable}`);
    out.push(`Model residue: ${resLine}`);
  } else {
    out.push(`${recFull(r.receptor)} residue ${resLine}`);
  }
  if (sub.change && r.kind === 'missense') out.push(`${hgvsP(r)} (${r.ref}${r.pos}${r.alt})`);
  const seen = new Set();
  for (const t of r.transcriptViews ?? []) {
    if (t.c) { const s = `${t.transcript}:${t.c}`; if (!seen.has(s)) { seen.add(s); out.push(s); } }
    if (t.protein && t.p) { const s = `${t.protein}:${t.p}`; if (!seen.has(s)) { seen.add(s); out.push(s); } }
  }
  for (const a of r.alleles ?? []) {
    out.push(`GRCh38: ${a.id}`);
    if (a.id37) out.push(`GRCh37: ${a.id37}`);
    if (a.rsids?.length) out.push(a.rsids.join(', '));
  }
  if (!(r.alleles ?? []).length) {
    if (r.genomic?.grch38) out.push(`GRCh38: ${r.genomic.grch38}`);
    if (r.genomic?.grch37) out.push(`GRCh37: ${r.genomic.grch37}`);
  }
  for (const c of r.clinvar ?? []) out.push(c.accession);
  if (sub.fix) out.push(`Suggested correction (a suggestion only; check that it is what you meant): ${sub.fix.query}`);
  return out.join('\n');
}

/** Release labels as plain text lines, for the evidence summary. */
function releaseLines(r, rel) {
  const l = (k) => rel?.[k]?.label;
  const bits = [r.releases?.gnomad ?? l('gnomad'), r.releases?.clinvar ?? l('clinvar'),
    rel?.ensembl ? `${l('ensembl')} (${rel.ensembl.grch38}, ${rel.ensembl.grch37})` : null,
    l('refseq'), l('alphamissense'), l('conservation'), l('gpcrdb_numbering'), l('hgnc'), l('uniprot'), l('database')].filter(Boolean);
  return [...new Set(bits)];
}

/**
 * A plain-text evidence block for one result: what was typed and how it was read, the residue
 * and change, every notation with its transcript version, both assemblies (approximate lifts
 * flagged), alleles, ClinVar, the database's own facts, warnings, data releases and a link that
 * reproduces the search. ASCII-friendly, one fact per line, pasteable into notes or a report.
 *
 * @param {object} r a result
 * On a reference mismatch (`PAR2 p.Ala159Ile`) the typed change is reported as typed and unverifiable, the
 * model residue on its own, and the correction only as a suggestion: never as the subject.
 *
 * @param {{query?: string, reading?: string|null, interp?: object, releases?: object, cfrTop?: number|null,
 *          pageUrl?: string, typed?: object, alternates?: object[]}} [ctx]
 */
export function evidenceText(r, ctx = {}) {
  const L = [];
  const q = String(ctx.query ?? '').trim();
  const f = residueFacts(r);
  const x = r.residue;
  L.push('GPCompaRe search evidence summary');
  L.push(`Query: ${q}`);
  if (ctx.reading) L.push(`Interpretation: ${ctx.reading}`);
  L.push(`Receptor: ${recFull(r.receptor)}`);
  const sub = subjectOf(r, ctx);
  const S = summarySentences(r, ctx);
  if (S.length) {
    L.push('Evidence summary:');
    for (const t of S) L.push(`  ${t}`);
  }
  if (r.pos) {
    // a reference mismatch: the typed change is the subject and cannot be checked; the model residue is separate
    if (sub.mismatch) L.push(`Typed ${sub.what}: ${sub.unverifiable}.`);
    L.push(`${sub.mismatch ? 'Model residue' : 'Residue'}: ${three(x?.aa ?? r.ref)}${r.pos} (model numbering, the numbering of the report)${x?.generic ? `; generic number ${x.generic}; ${x.segment}` : ''}`);
    if (sub.change) L.push(`Change: ${r.kind === 'missense' ? `${hgvsP(r)} (${r.ref}${r.pos}${r.alt})` : hgvsP(r)}; ${kindLabel(r.kind).toLowerCase()}`);
  } else {
    L.push('Residue: not placed (nothing below is about a residue)');
  }
  const tv = r.transcriptViews ?? [];
  if (tv.length) {
    L.push(sub.mismatch ? 'The model residue on each transcript:' : 'Transcript notations:');
    for (const t of tv) {
      const bits = [t.c, t.p].filter(Boolean).join(', ');
      L.push(`  ${roleLabel(t)}: ${t.transcript}${t.protein ? ` / ${t.protein}` : ''}${bits ? `: ${bits}` : ''}${t.allele ? ` (allele ${t.allele})` : ''}`);
    }
  }
  const g = r.genomic ?? {};
  const alleles = r.alleles ?? [];
  const asm = (a38, a37) => {
    L.push(`  GRCh38: ${a38 ?? 'not mapped'}${g.grch38Approximate ? ' (approximate)' : ''}`);
    L.push(`  GRCh37: ${a37 ?? 'not mapped'}${g.grch37Approximate ? ' (approximate)' : ''}`);
  };
  if (alleles.length) {
    L.push('Genome positions:');
    for (const a of alleles) { L.push(`  allele ${a.id}`); asm(a.id, a.id37); }
  } else if (g.grch38 || g.grch37) {
    L.push('Genome positions:');
    asm(g.grch38, g.grch37);
  }
  const gl = r.releases?.gnomad ?? ctx.releases?.gnomad?.label ?? 'gnomAD';
  if (alleles.length) {
    L.push(`${gl} alleles for this change:`);
    for (const a of alleles) {
      L.push(`  ${a.id} ${a.hgvsc ?? ''} ${a.hgvsp ?? ''}; ${a.rsids?.length ? a.rsids.join(', ') : 'no rsID'}; allele count ${fmtInt(a.ac)} of ${fmtInt(a.an)}; allele frequency ${fmtAf(a.af)}; homozygotes ${fmtInt(a.hom)}; AlphaMissense prediction ${a.am == null ? 'not available' : `${fmtAm(a.am)}${a.amClass ? ` (${amClassLabel(a.amClass)})` : ''}`}`.replace(/\s+;/g, ';'));
    }
  } else if (sub.mismatch) {
    L.push(`${gl}: the typed ${sub.what} was not looked up, because ${sub.what === 'change' ? 'its residue is' : 'it is'} not the model residue.`);
  } else if (r.alt && r.kind === 'missense' && r.pos) {
    L.push(`${gl}: this exact change is not listed.${codonReason(r) ? ` ${codonReason(r)}` : ''}`);
  }
  const nOther = (r.residueAlleles ?? []).filter((a) => !alleles.some((b) => b.id === a.id)).length;
  const at = sub.mismatch ? `the model residue ${sub.modelRes}` : 'this residue';
  if (nOther) L.push(`${gl}: ${nOther} ${sub.mismatch ? '' : 'other '}missense allele${nOther === 1 ? '' : 's'} at ${at}.`);
  const cl = r.releases?.clinvar ?? ctx.releases?.clinvar?.label ?? 'ClinVar';
  if ((r.clinvar ?? []).length) {
    L.push(sub.mismatch ? `${cl} records at ${at} (not of the typed ${sub.what}):` : `${cl} records:`);
    for (const c of r.clinvar) L.push(`  ${c.accession}: ${c.classification || 'no classification'}, ${c.stars ?? 0} of 4 review stars${c.scv ? `, ${c.scv} ${c.scv === 1 ? 'submission' : 'submissions'}` : ''}${c.evaluated ? `, last evaluated ${c.evaluated}` : ''}${c.conditions?.length ? `; ${c.conditions.join('; ')}` : ''}; ${c.url}`);
  } else if (sub.mismatch) L.push(`${cl}: no record at ${at}.`);
  else if (r.pos) L.push(`${cl}: no record matches this query.`);
  if (x) {
    L.push('Computational predictions (AlphaMissense is a prediction, not an observation):');
    L.push(`  Classes: ${AM_CUTS_TEXT}`);
    const am = amForChange(r, sub);
    if (sub.mismatch) L.push(`  AlphaMissense, typed ${sub.what}: not shown (not the model residue)`);
    else if (am) L.push(`  AlphaMissense, this change: ${fmtAm(am.am)} (${amClassLabel(am.amClass)})`);
    else if (r.alt && r.kind === 'missense') L.push('  AlphaMissense, this change: not available');
    L.push(`  AlphaMissense, residue mean: ${f.amMean === null ? 'not available' : `${f.amMean.toFixed(2)}${f.amMeanClass ? ` (${amClassLabel(f.amMeanClass)})` : ''}`}`);
    if (r.amAll) L.push(`  AlphaMissense, every substitution at ${sub.modelRes}: ${Object.keys(r.amAll).sort().map((a) => `${three(a)} ${fmtAm(r.amAll[a].am)} (${amClassLabel(r.amAll[a].amClass)})`).join('; ')}`);
    L.push(`  Conservation: ${f.conservation === null ? 'not available' : `${f.conservation.toFixed(2)} on a 0 to 1 scale`}`);
    L.push('In the GPCompaRe database:');
    L.push(`  Numbering: ${x.generic ? `${x.generic} (BW ${x.bw}, GPCRdb ${x.gpcrdb}), ${x.segment}` : `no generic number (${x.segment || 'outside the helices'})`}`);
    L.push(`  Core functional residue (class-wide): ${x.cfr ? `yes, ${cfrOneOf(ctx.cfrTop)}, rank ${f.cfrRank}` : (f.cfrRank ? `no, its generic position ranks ${f.cfrRank} by CFR score` : 'not ranked (no generic number)')}`);
    if (r.cfrHood) L.push(`  CFR neighborhood (a CFR is ${cfrOneOf(ctx.cfrTop)}): ${cfrHoodSentence(r) ?? 'at a CFR position, no other relation'}`);
    if (r.motifs) { const ms = r.motifs.filter((m) => m.key !== 'xmy' || m.carried !== false); L.push(`  Motif: ${ms.length ? ms.map((m) => `${m.name} (position ${m.position}${!m.required ? ', the variable x' : m.canonical ? `, canonical ${m.canonical.split('').map(three).join(' or ')}` : ''}${m.carried === false ? '; not carried in full by this receptor' : ''}${m.key === 'xmy' ? `; ${m.note}` : ''})`).join('; ') : 'not a motif position'}`); }
    L.push(`  Largest contact change: ${f.dmax === null ? 'no contacts' : `|dRRCS| ${f.dmax.toFixed(2)}${f.threshold !== null ? `, receptor threshold ${f.threshold.toFixed(2)}` : ''}${f.partner ? `, with ${f.partner}` : ''}`}`);
    if (f.net !== null) L.push(`  Net dRRCS: ${signed(f.net, 1)}: ${netSentence(f.net, { value: false })}`);
    if (r.rank?.rank) L.push(`  Rank by largest |dRRCS|: ${r.rank.rank} of ${r.rank.of} residues in ${r.receptor?.symbol ?? r.gid}`);
    L.push(`  Contacts above this receptor's threshold: ${f.nsig ?? 0}`);
    if (r.contacts === undefined) L.push('  Contact list: not available in this index');
    else if (!r.contacts.length) L.push('  Contact list: this residue takes part in no contact above the threshold');
    else {
      L.push('  Contacts, largest |dRRCS| first (dRRCS; active RRCS; inactive RRCS; what the models show):');
      for (const c of r.contacts) L.push(`    ${partnerName(c)}${c.partnerGeneric ? ` (${c.partnerGeneric}, ${c.partnerSegment})` : (c.partnerSegment ? ` (${c.partnerSegment})` : '')}${c.partnerCfr ? `, CFR rank ${c.partnerCfrRank}` : ''}${c.partnerMotifs?.length ? `, ${c.partnerMotifs.join(', ')}` : ''}: dRRCS ${signed(c.delta)}; active ${fmtRrcs(c.active, contactPresence(c).active)}; inactive ${fmtRrcs(c.inactive, contactPresence(c).inactive)}; ${contactMeaning(c)}; report pair ${c.a}-${c.b}`);
    }
  }
  if ((r.notes ?? []).length) {
    L.push('Warnings and notes:');
    for (const n of r.notes) L.push(`  ${WARN_NOTES.has(n.code) ? 'Warning: ' : ''}${n.text}`);
  }
  if (sub.fix) {
    const n = sub.fix.count;
    const rec = n === null || n === undefined ? '' : (n ? ` (${n} ${n === 1 ? 'record' : 'records'} in gnomAD or ClinVar)` : ' (not recorded in gnomAD or ClinVar)');
    L.push(`Suggested correction (a suggestion only; check that it is what you meant): ${sub.fix.query}${rec}`);
  }
  L.push(`Note: ${RESEARCH_NOTE}`);
  const rl = releaseLines(r, ctx.releases);
  if (rl.length) L.push(`Data releases: ${rl.join('; ')}`);
  L.push(`Search link: ${ctx.pageUrl ?? 'search/'}?q=${encodeURIComponent(q)}`);
  return L.join('\n');
}

// ---------------------------------------------------------------------------- actions & cards

/**
 * The gnomAD release the report pages' variant tables list: `releases.reportTable.label` from search2/meta.json
 * (the version registry), else the search release. Never a literal.
 */
export function reportTableRelease(releases) {
  return releases?.reportTable?.label ?? releases?.gnomad?.label ?? 'gnomAD';
}

/** True when the report's variant table lists the change named by the result. */
export function inReportTable(r) {
  if (typeof r.inReportTable === 'boolean') return r.inReportTable;
  const flags = (r.alleles ?? []).map((a) => a.inReportTable);
  if (flags.length && flags.every((f) => typeof f === 'boolean')) return flags.some(Boolean);
  // an index without the membership flags: the table's own rule (residues with |ΔRRCS| >= 3.0)
  const d = residueFacts(r).dmax;
  return d !== null && d >= REPORT_TABLE_DELTA;
}

function actions(r, o, idx, mismatch) {
  const gid = r.gid;
  const res = r.pos ? `${o.reports}${gid}.html#sec=sec-snake&res=${r.pos}` : `${o.reports}${gid}.html`;
  const alleles = r.alleles ?? [];
  // the protein change to find: one the report table lists, when the index says which
  const listed = alleles.find((a) => a.inReportTable === true);
  const vq = (listed ?? alleles[0])?.hgvsp ?? (r.alt && r.kind === 'missense' ? hgvsP(r) : null);
  const hasAlleles = alleles.length > 0;
  const canFind = !mismatch && vq && hasAlleles && inReportTable(r);
  const dmax = residueFacts(r).dmax;
  const belowCut = dmax === null || dmax < REPORT_TABLE_DELTA;
  const why = !mismatch && vq && hasAlleles && !canFind
    ? html`<p class="sr-action-note fine-print">${belowCut
      ? `Not in the report’s variant table: it lists variants at residues with a contact change of |ΔRRCS| ${REPORT_TABLE_DELTA.toFixed(1)} or more, and ${dmax === null ? 'this residue has no contact change' : `this residue’s largest is ${dmax.toFixed(2)}`}.`
      : `Not in the report’s variant table: that table was built from ${reportTableRelease(o.releases)} and does not list this change.`}</p>`
    : '';
  return html`<div class="sr-actions">
    ${intLink(res, r.pos ? 'Open report at this residue' : 'Open report', { cls: 'btn btn-primary btn-sm' })}
    ${canFind ? intLink(`${o.reports}${gid}.html#sec=sec-variants&vq=${encodeURIComponent(vq)}`, raw("Find in the report's variant table"), { cls: 'btn btn-ghost btn-sm' }) : ''}
    ${intLink(L.studioUrl(o, gid), 'Open in Studio', { cls: 'btn btn-ghost btn-sm' })}
    ${r.pos ? html`<button type="button" class="btn btn-ghost btn-sm" data-copy-notations="${idx}">Copy all notations</button>
    <button type="button" class="btn btn-ghost btn-sm" data-copy-evidence="${idx}">Copy evidence summary</button>` : ''}
    ${why}
  </div>`;
}

/** Notes that explain rather than warn: shown in the card's fine print, not above its results. */
const FINE_NOTES = new Set(['assembly_detected', 'gnomad_frame', 'multi_nucleotide', 'par_y', 'reference_unchecked']);

function notesBlock(allNotes) {
  const notes = (allNotes ?? []).filter((n) => !FINE_NOTES.has(n.code));
  if (!notes.length) return '';
  return html`<ul class="sr-notes">${notes.map((n) => html`<li class="sr-note ${WARN_NOTES.has(n.code) ? 'sr-note--warn' : 'sr-note--info'}" data-code="${n.code}"><span class="sr-sr-only">Note: </span>${n.text}</li>`)}</ul>`;
}

// ------------------------------------------- a typed residue that is not the model's residue

function typedChangeText(c) {
  if (!c) return null;
  if (c.generic && (c.alt === null || c.alt === undefined)) return `${c.ref ?? ''}${c.generic}`;
  if (c.pos === null || c.pos === undefined) return null;
  const alt = c.alt === undefined || c.alt === null ? '' : altText(c.alt);
  return `p.${c.ref ? three(c.ref) : ''}${c.pos}${alt}`;
}

/** {typed, query, label, count} when the reference residue typed is not the one in the model. */
export function mismatchFix(r, o) {
  if (!hasNote(r, 'reference_mismatch') || !r.pos) return null;
  const typedObj = o.typed ?? r.typed ?? null;
  const typed = typeof typedObj === 'string' ? typedObj : (typedChangeText(typedObj) ?? typedChangeText(o.interp?.change));
  if (!typed) return null;
  // the engine's correction is the first alternate for this receptor; derive it when absent
  const alt = (o.alternates ?? []).find((a) => (a.kind === 'change' || a.kind === 'residue') && (!a.gid || a.gid === r.gid));
  const sym = r.receptor?.symbol ?? r.gid;
  const altAa = typedObj?.alt ?? r.alt;
  const fixed = altAa && typedObj?.generic === undefined ? `p.${three(r.ref)}${r.pos}${three(altAa)}` : `${three(r.ref)}${r.pos}`;
  const count = alt ? (Number.isFinite(alt.count) ? alt.count : null)
    : (altAa ? (r.residueAlleles ?? []).filter((a) => a.alt === altAa).length : null);
  return { typed, query: alt?.query ?? `${sym} ${fixed}`, label: alt?.query ?? `${sym} ${fixed}`, count, sym };
}

/**
 * What a result is about, read in one place for the card header, the change line, the lead line and both
 * copy buttons. On a reference mismatch the typed change stays the subject and is marked as not checkable
 * (`unverifiable`), the model residue is given on its own (`modelRes`), and the change on the model
 * residue appears only as a suggestion (`fix`); `change` (the change the card is about) is then null.
 */
export function subjectOf(r, o = {}) {
  const fix = mismatchFix(r, o);
  const mismatch = !!fix || hasNote(r, 'reference_mismatch');
  const aa = r.residue?.aa ?? r.ref;
  const modelRes = r.pos && aa ? `${three(aa)}${r.pos}` : null;
  const typedObj = r.typed ?? o.typed ?? null;
  const typed = fix?.typed ?? (mismatch ? typedChangeText(typedObj) ?? typedChangeText(o.interp?.change) : null);
  const what = (typedObj?.alt ?? o.interp?.change?.alt) ? 'change' : 'residue';
  const sym = r.receptor?.symbol ?? r.gid;
  const where = typedObj?.generic && r.pos ? `position ${r.pos} (${r.residue?.generic || typedObj.generic})` : `position ${r.pos}`;
  const unverifiable = mismatch && modelRes
    ? `${typed ? `${typed}: ` : ''}${where} is ${three(aa)} in ${sym}, so this ${what} cannot be checked`
    : null;
  return { mismatch, fix, typed, what, modelRes, unverifiable, change: !mismatch && r.pos && r.alt ? hgvsP(r) : null };
}

function changeLine(r, fix, mismatch = false) {
  if (!r.pos) return html`<span class="sr-badge sr-badge--muted">${kindLabel(r.kind)}</span>`;
  if (r.type === 'not_coding') return html`<span class="sr-change-main">Not a coding residue</span> <span class="sr-badge">outside the coding sequence</span>`;
  if (fix) return html`<span class="sr-change-main mono">${fix.typed}</span> <span class="sr-badge sr-badge--warn">typed residue does not match</span>`;
  if (mismatch) return html`<span class="sr-change-main">Model residue ${three(r.residue?.aa ?? r.ref)}${r.pos}</span> <span class="sr-badge sr-badge--warn">typed residue does not match</span>`;
  if (r.alt && r.kind === 'missense') {
    return html`<span class="sr-change-main mono">${hgvsP(r)}</span> <span class="sr-sub">(${r.ref}${r.pos}${r.alt})</span> <span class="sr-badge">${kindLabel(r.kind)}</span>`;
  }
  if (r.alt) return html`<span class="sr-change-main mono">${hgvsP(r)}</span> <span class="sr-badge">${kindLabel(r.kind)}</span>`;
  return html`<span class="sr-change-main">Residue ${three(r.residue?.aa ?? r.ref)}${r.pos}</span>`;
}

function fixBlock(fix, o) {
  if (!fix) return '';
  const base = o.base ?? '';
  return html`<div class="sr-fix"><span class="sr-label">Did you mean</span>
    <a class="btn btn-primary" href="${base}?q=${encodeURIComponent(fix.query)}" data-q="${fix.query}" data-fix="1"><span class="mono">${fix.label}</span></a>
    ${fix.count !== null ? html`<span class="sr-sub">${fix.count === 0 ? 'not recorded in gnomAD or ClinVar' : `${fix.count} ${fix.count === 1 ? 'record' : 'records'} in gnomAD or ClinVar`}</span>` : ''}</div>`;
}

function badgesFor(r, o = {}) {
  const b = [];
  if (r.residue?.cfr) b.push(html`<span class="sr-badge sr-badge--cfr" title="Core functional residue: ${cfrOneOf(o.cfrTop)}">CFR, class-wide rank ${residueFacts(r).cfrRank}</span>`);
  if (r.notes?.some((n) => n.code === 'model_conflict')) b.push(html`<span class="sr-badge sr-badge--warn">model differs from reference genome</span>`);
  return b;
}

function card(r, o, idx) {
  const x = r.residue;
  const rec = r.receptor;
  const oc = { ...o, idx };
  const reportHref = `${o.reports}${r.gid}.html`;
  const title = intLink(reportHref, recFull(rec), { title: 'Report page' });
  const sub = subjectOf(r, o);
  const { fix, mismatch } = sub;
  const noResidue = !r.pos && r.type === 'not_in_resource'; // e.g. an unknown transcript version: nothing to show but the note
  const status = r.type === 'not_in_resource' && !mismatch && !noResidue ? html`<span class="sr-badge sr-badge--muted">not analyzed here</span>` : '';
  const hasEvidence = !noResidue && r.type !== 'not_coding' && !(r.type === 'not_in_resource' && !r.residue);
  // the notations open on a single card; with several cards on the page they start folded
  const refsOpen = (o.cardCount ?? 1) <= 1;
  const keys = new Set(['summary', 'structure', 'predictions', 'conservation', 'population', 'clinical', 'refs']);
  if (r.track && r.pos) keys.add('region');
  if (!x) { keys.delete('structure'); keys.delete('predictions'); keys.delete('conservation'); keys.delete('region'); }
  return html`<article class="sr-card sr-card--${r.type}" aria-labelledby="sr-card-${idx}">
    <header class="sr-card-head">
      <h3 id="sr-card-${idx}" class="sr-card-title">${title}${r.pos ? html`<span class="sr-dot" aria-hidden="true">·</span>${mismatch ? html`<span class="sr-sub">model residue </span>` : ''}${intLink(L.residueUrl(o, r.gid, r.pos), `${three(r.residue?.aa ?? r.ref)}${r.pos}`, { cls: 'mono', title: 'Report at this residue' })}` : ''}${x?.generic ? html`<span class="sr-dot" aria-hidden="true">·</span><span class="mono" title="Generic residue number">${x.generic}</span>` : ''}${x?.segment ? html`<span class="sr-dot" aria-hidden="true">·</span><span class="sr-nowrap">${x.segment}</span>` : ''}</h3>
      ${noResidue ? '' : html`<div class="sr-change">${changeLine(r, fix, mismatch)} ${status} ${badgesFor(r, o)}</div>`}
      ${hasEvidence ? idLine(r, oc, sub) : ''}
    </header>
    ${leadLine(r, o)}
    ${notesBlock(r.notes)}
    ${fixBlock(fix, o)}
    ${noResidue ? '' : hasEvidence ? html`<div class="sr-body">${navBlock(idx, keys)}<div class="sr-main">
      <section class="sr-sec sr-sec--summary" id="${secId(idx, 'summary')}" aria-label="Summary"><h4 class="sr-sr-only">Summary</h4>${tiles(r, oc, sub)}</section>
      ${structureSection(r, oc)}
      ${regionSection(r, oc)}
      ${x ? predictionsSection(r, sub, oc) : ''}
      ${x ? conservationSection(r, oc) : ''}
      ${populationSection(r, oc, mismatch)}
      ${clinicalSection(r, oc, mismatch)}
      ${refsSection(r, sub, oc, refsOpen)}
      ${proseSection(r, oc)}
    </div></div>` : html`${clinicalSection(r, oc, mismatch)}${structureSection(r, oc)}`}
    ${actions(r, o, idx, mismatch)}
    ${cardFinePrint(r, o, mismatch, noResidue)}
  </article>`;
}

/**
 * Everything that explains a card without changing what it says: the data releases, how the typed text
 * was mapped, notes that are not warnings, what the numbers mean, and the transcript and genome tables.
 * One small block at the bottom of the card; the long parts are folded.
 */
function cardFinePrint(r, o, mismatch, noResidue) {
  if (noResidue) return '';
  const rel = o.releases;
  const hasRows = r.type !== 'not_coding' && !(r.type === 'not_in_resource' && !r.residue);
  const releases = [r.releases?.gnomad ?? rel?.gnomad?.label, r.releases?.clinvar ?? rel?.clinvar?.label, rel?.alphamissense?.label, rel?.conservation?.label].filter(Boolean);
  const f = r.residue ? residueFacts(r) : null;
  const about = [];
  if (leadNeeded(r, o.interp)) about.push(html`<li><strong>How it was read:</strong> ${leadReason(r, o.interp)}.</li>`);
  for (const n of (r.notes ?? []).filter((x) => FINE_NOTES.has(x.code))) about.push(html`<li>${n.text}</li>`);
  if (hasRows) about.push(html`<li><strong>Population evidence</strong> is the ${term(o, 'gnomad', 'gnomAD')} missense allele (exome counts where present, else genome). Per-population frequencies are not held in this index; open the gnomAD record for them.</li>`);
  if (f) {
    about.push(html`<li><strong>${term(o, 'cfr', 'CFR')}:</strong> a core functional residue position here is ${cfrOneOf(o.cfrTop)}. The rank is the position's place in that class-wide ranking.</li>`);
    if (f.dmax !== null) about.push(html`<li><strong>Largest contact change:</strong> the biggest |ΔRRCS| among this residue's contacts${f.threshold !== null ? html`; this receptor's threshold is ${f.threshold.toFixed(2)}` : ''}.</li>`);
    about.push(html`<li><strong>${term(o, 'pair', 'Contacts')}</strong> are residue pairs of the two GPCRdb models (AlphaFold-Multistate, with plain AlphaFold2 for some states) whose contact score changes by at least the receptor's threshold between the inactive and the active model. They describe the two models, not the effect of a variant.</li>`);
    about.push(html`<li><strong>${term(o, 'conservation', 'Conservation')}</strong> is on a 0 to 1 scale. <strong>${term(o, 'am', 'AlphaMissense')}</strong> scores are predictions on a 0 to 1 scale. ${AM_CUTS_TEXT} <strong>Residue mean</strong> is the mean over all substitutions at the residue, classed by the same cutoffs before rounding.</li>`);
  }
  if (!releases.length && !about.length) return '';
  return finePrint(html`${hasRows ? html`<p class="sr-research-note">${RESEARCH_NOTE_SHORT}</p>` : ''}${hasRows && releases.length ? html`<p class="sr-card-releases">${releases.join('; ')}.</p>` : ''}
    ${about.length ? html`<details class="sr-about"><summary>About these numbers</summary><ul>${about}</ul></details>` : ''}`, { cls: 'sr-card-fine' });
}

// ------------------------------------------------------- every ClinVar record of one receptor

/** Classification groups, most severe first; a record goes to the first group whose test matches. */
export const CLINVAR_GROUPS = [
  { key: 'plp', label: 'Pathogenic or likely pathogenic', test: (c) => /^(?:pathogenic|likely pathogenic)/i.test(c) },
  { key: 'conflict', label: 'Conflicting classifications', test: (c) => /^conflicting/i.test(c) },
  { key: 'vus', label: 'Uncertain significance', test: (c) => /^uncertain/i.test(c) },
  { key: 'blb', label: 'Benign or likely benign', test: (c) => /^(?:benign|likely benign)/i.test(c) },
  { key: 'other', label: 'Other or no classification', test: () => true },
];

/** The records grouped by classification (P/LP first), each group sorted by residue, then record id. */
export function clinvarGroups(records) {
  const groups = CLINVAR_GROUPS.map((g) => ({ key: g.key, label: g.label, records: [] }));
  for (const c of records ?? []) {
    const k = CLINVAR_GROUPS.findIndex((g) => g.test(String(c.classification ?? '')));
    groups[k].records.push(c);
  }
  const by = (a, b) => ((a.pos ?? Infinity) - (b.pos ?? Infinity)) || (a.variationId - b.variationId);
  for (const g of groups) g.records.sort(by);
  return groups;
}

/** "c.46A>G (p.Arg16Gly)" from "NM_000024.6(ADRB2):c.46A>G (p.Arg16Gly)"; other titles as they are. */
const cvChange = (c) => /\):(.+)$/.exec(String(c.title ?? ''))?.[1] ?? c.title ?? '';

function clinvarListTable(recs, caption) {
  return html`<div class="sr-table-wrap"><table class="sr-table sr-table--cv">
    <caption class="sr-sr-only">${caption}</caption>
    <thead><tr><th scope="col">Classification</th><th scope="col">Review</th><th scope="col">Condition</th><th scope="col">Residue</th><th scope="col">Change</th><th scope="col">Record</th></tr></thead>
    <tbody>${recs.map((c) => {
      const acc = c.accession ?? `VCV${String(c.variationId).padStart(9, '0')}`;
      const q = `VCV${String(c.variationId).padStart(9, '0')}`;
      return html`<tr>
      <td data-label="Classification">${c.classification ? pathChip(cvClassKey(c.classification), c.classification) : html`<span class="sr-na">not given</span>`}</td>
      <td data-label="Review">${stars(c.stars)}</td>
      <td data-label="Condition">${c.conditions?.length ? c.conditions.join('; ') : html`<span class="sr-na">not given</span>`}</td>
      <td data-label="Residue">${c.pos ? html`<a class="mono" href="?q=${encodeURIComponent(q)}" data-q="${q}" title="Details for ${acc}">${c.ref ? three(c.ref) : ''}${c.pos}</a>` : html`<span class="sr-na">not placed</span>`}</td>
      <td data-label="Change"><span class="mono">${cvChange(c)}</span></td>
      <td data-label="Record">${extLink(c.url ?? L.clinvarUrl(c.variationId), acc, SITE.clinvar)}</td></tr>`;
    })}</tbody></table></div>`;
}

/**
 * Every ClinVar record the index holds for a receptor, grouped by classification with counts. Open when
 * the reader asked for the list ("ADRB2 ClinVar"), folded on a plain receptor result.
 */
export function clinvarListSection(r, o = {}) {
  const recs = r.clinvar;
  if (!Array.isArray(recs)) return '';
  const sym = r.receptor?.symbol ?? r.gid;
  const label = r.releases?.clinvar ?? o.releases?.clinvar?.label ?? 'ClinVar';
  if (!recs.length) return html`<div class="sr-row sr-cvlist"><h4>${sourceName(label)}</h4><div><p>No ClinVar record for ${sym} in ${label}.</p></div></div>`;
  const groups = clinvarGroups(recs);
  const counts = groups.filter((g) => g.records.length || g.key === 'plp').map((g) => `${g.records.length} ${g.label.toLowerCase()}`).join(', ');
  const openKey = groups.find((g) => g.key === 'plp' && g.records.length)?.key ?? (r.clinvarList ? groups.find((g) => g.records.length)?.key : null);
  const body = html`<p class="sr-sub">${recs.length} ${recs.length === 1 ? 'record' : 'records'}: ${counts}.</p>
    ${finePrint(html`<p>${label}. Single-gene records only, any classification. The report page lists only the pathogenic or likely pathogenic missense records.</p>`)}
    ${groups.filter((g) => g.records.length).map((g) => html`<details class="sr-more sr-cvgroup" data-cv-group="${g.key}"${g.key === openKey ? raw(' open') : ''}>
      <summary>${g.label} <span class="sr-sub">${g.records.length}</span></summary>
      ${clinvarListTable(g.records, `${g.label}: ${g.records.length} ClinVar records for ${sym}`)}</details>`)}`;
  return html`<div class="sr-row sr-row--wide sr-cvlist" id="sr-cvlist"><details class="sr-more sr-cvlist-all"${r.clinvarList ? raw(' open') : ''}>
    <summary><strong>All ${recs.length} ClinVar ${recs.length === 1 ? 'record' : 'records'} for ${sym}</strong></summary>
    ${body}</details></div>`;
}

// ------------------------------------------- variants in the CFR neighbourhood of one receptor

/** The worst ClinVar class of a row's records, for sorting (P/LP first) and the chip: 0 P/LP .. 4 other, 9 none. */
const cvRank = (recs) => (recs?.length ? Math.min(...recs.map((c) => CLINVAR_GROUPS.findIndex((g) => g.test(String(c.classification ?? ''))))) : 9);
const pChange = (row) => `p.${three(row.ref)}${row.pos}${three(row.alt)}`;
/** The row's CFR relations as one plain text (CSV and screen readers). */
function cfrPartnerText(row) {
  const h = row.hood;
  const parts = [];
  if (h.connected.length) parts.push(...h.connected.map((c) => `${cfrName(c)} dRRCS ${signed(c.delta)} ${activationWord(c)}`));
  if (row.group === 'near') parts.push(...h.near.map((c) => `${cfrName(c)} ${awayText(c.offset)}`));
  if (row.group === 'touch') parts.push(...(h.touch ?? []).map((c) => `${cfrName(c)} dRRCS ${signed(c.delta)} below threshold`));
  return parts.join('; ');
}

/** Sources a row can be filtered by. */
export const CFR_SOURCES = Object.freeze([['gnomad', 'gnomAD'], ['clinvar', 'ClinVar'], ['plp', 'P/LP only']]);
const sourceTest = {
  gnomad: (row) => !!row.allele,
  clinvar: (row) => row.clinvar.length > 0,
  plp: (row) => row.clinvar.some(isPlp),
};

/**
 * The data behind the receptor's CFR variant table (result.cfrList from the engine): rows with their sort keys.
 * @param {object} r a receptor result with `cfrList`
 */
export function cfrListModel(r, o = {}) {
  const L0 = r.cfrList;
  if (!L0) return null;
  const rows = L0.rows.map((row, i) => ({ ...row, i, order: CFR_GROUPS.indexOf(row.group), cv: cvRank(row.clinvar), af: row.allele?.af ?? null }));
  const cols = [
    { key: 'res', label: 'Residue', num: true, sort: (x) => x.pos },
    { key: 'grp', label: 'Group', sort: (x) => x.order },
    { key: 'partners', label: 'CFR partner', sort: null },
    { key: 'change', label: 'Change', sort: (x) => x.pos * 100 + 'ACDEFGHIKLMNPQRSTVWY'.indexOf(x.alt) },
    { key: 'af', label: 'Allele frequency', num: true, sort: (x) => x.af },
    { key: 'clinvar', label: 'ClinVar', sort: (x) => (x.cv === 9 ? null : -x.cv) },
    { key: 'am', label: 'AlphaMissense', num: true, sort: (x) => x.am },
    { key: 'links', label: 'Open', sort: null },
  ];
  return {
    gid: r.gid, symbol: r.receptor?.symbol ?? r.gid, receptor: r.receptor, rows, cols, counts: L0.counts, cfr: L0.cfr,
    skipped: L0.skipped, hasTouch: L0.hasTouch, hasContacts: L0.hasContacts, hasVariants: L0.hasVariants, threshold: L0.threshold,
    releases: r.releases ?? {}, reports: o.reports, cfrTop: o.cfrTop ?? null,
  };
}

export const cfrListDefaults = () => ({ group: '', source: '', sort: 'orig', dir: 'asc', page: 1, all: false });

/** Rows after the group and source filters and the sort. */
export function cfrListRows(model, state, { ignoreGroup = false } = {}) {
  let rows = model.rows.filter((x) => (ignoreGroup || !state.group || x.group === state.group) && (!state.source || sourceTest[state.source](x)));
  const col = state.sort && state.sort !== 'orig' ? model.cols.find((c) => c.key === state.sort && c.sort) : null;
  if (col) {
    const sgn = state.dir === 'desc' ? -1 : 1;
    rows = [...rows].sort((a, b) => {
      const x = col.sort(a); const y = col.sort(b);
      const xn = x === null || x === undefined; const yn = y === null || y === undefined;
      if (xn || yn) return xn === yn ? a.i - b.i : (xn ? 1 : -1);
      return (sgn * (x - y)) || a.i - b.i;
    });
  }
  return rows;
}

function cfrPartnerCell(row, o, gid) {
  const h = row.hood;
  const link = (c) => intLink(L.residueUrl(o, gid, c.pos), `${three(c.aa)}${c.pos}`, { cls: 'mono', title: 'Report at this residue' });
  const meta = (c) => html` <span class="sr-sub">(${[bwOf(c.generic), c.rank ? `rank ${c.rank}` : null].filter(Boolean).join(', ')})</span>`;
  const out = [];
  for (const c of h.connected) {
    const d = direction(c.delta);
    out.push(html`<li>${link(c)}${meta(c)} <span class="sr-net sr-net--${d.cls}">${signed(c.delta)}</span> <span class="sr-sub">${activationWord(c)}</span> ${intLink(L.reportUrl(o, gid, `pair=${c.a}-${c.b}`), 'pair', { cls: 'sr-sub', title: `Report at contact pair ${c.a}-${c.b}` })}</li>`);
  }
  if (row.group === 'near') for (const c of h.near) out.push(html`<li>${link(c)}${meta(c)} <span class="sr-sub">${awayText(c.offset)}</span></li>`);
  if (row.group === 'touch') {
    const t = h.touch ?? [];
    for (const c of t.slice(0, 3)) { const d = direction(c.delta); out.push(html`<li>${link(c)}${meta(c)} <span class="sr-net sr-net--${d.cls}">${signed(c.delta)}</span> <span class="sr-sub">below threshold</span></li>`); }
    if (t.length > 3) out.push(html`<li class="sr-sub">and ${t.length - 3} more</li>`);
  }
  if (!out.length) return row.group === 'at' ? html`<span class="sr-na">itself a CFR</span>` : '';
  return html`<ul class="sr-cfr-partners">${out}</ul>`;
}

function cfrCell(col, row, model, o) {
  const sym = model.symbol;
  const gid = model.gid;
  switch (col.key) {
    case 'res': return html`<span class="mono">${three(row.hood.aa ?? row.ref)}${row.pos}</span>${row.hood.generic ? html` <span class="sr-sub">${row.hood.generic}</span>` : ''}`;
    case 'grp': return html`<span class="sr-cfr-grp sr-cfr-grp--${row.group}">${CFR_GROUP_SHORT[row.group]}</span>${row.group === 'at' && row.hood.rank ? html` <span class="sr-badge sr-badge--cfr" title="Class-wide CFR rank of this generic position">rank ${row.hood.rank}</span>` : ''}`;
    case 'partners': return cfrPartnerCell(row, o, gid);
    case 'change': return html`<span class="mono">${pChange(row)}</span>${row.allele ? html`<br><span class="sr-sub">${g38Link(row.allele.id, model.releases)}</span>` : ''}`;
    case 'af': return row.allele ? html`${fmtAf(row.allele.af)}<br><span class="sr-sub">${fmtInt(row.allele.ac)} of ${fmtInt(row.allele.an)}</span>` : html`<span class="sr-na">not in gnomAD</span>`;
    case 'clinvar': return row.clinvar.length
      ? html`${row.clinvar.map((c, i) => html`${i ? html`<br>` : ''}${c.classification ? pathChip(cvClassKey(c.classification), c.classification) : html`<span class="sr-na">not given</span>`} ${stars(c.stars)} ${extLink(c.url ?? L.clinvarUrl(c.variationId), c.accession ?? `VCV${String(c.variationId).padStart(9, '0')}`, SITE.clinvar, { cls: 'mono sr-sub' })}`)}`
      : html`<span class="sr-na">no record</span>`;
    case 'am': return row.am === null || row.am === undefined ? html`<span class="sr-na">no score</span>` : html`<span class="sr-cfr-am"><span class="sr-path sr-path--${row.amClass}">${fmtAm(row.am)}</span> ${pathChip(row.amClass)}</span>`;
    case 'links': {
      const q = `${sym} ${pChange(row)}`;
      return html`<span class="sr-cfr-links">${intLink(`?q=${encodeURIComponent(q)}`, 'card', { title: `Search card for ${q}` })} ${intLink(L.residueUrl(o, gid, row.pos), 'report', { title: 'Report at this residue' })}</span>`;
    }
    default: return '';
  }
}

/** Group and source chips with their counts under the current filters (they redraw with the body). */
function cfrChips(model, state) {
  const bySource = cfrListRows(model, state, { ignoreGroup: true });
  const groups = CFR_GROUPS.filter((g) => g !== 'touch' || model.hasTouch);
  const n = (g) => bySource.filter((x) => x.group === g).length;
  const srcN = (k) => model.rows.filter((x) => (!state.group || x.group === state.group) && sourceTest[k](x)).length;
  return html`<div class="sr-groups sr-cfr-chips" role="group" aria-label="Show group"><span class="sr-label">Group</span>
      <button type="button" class="sr-seg" data-cfr-group="" aria-pressed="${state.group === '' ? 'true' : 'false'}">All <span class="sr-sub">${bySource.length}</span></button>
      ${groups.map((g) => html`<button type="button" class="sr-seg" data-cfr-group="${g}" aria-pressed="${state.group === g ? 'true' : 'false'}" title="${CFR_GROUP_LABEL[g]}">${CFR_GROUP_SHORT[g]} <span class="sr-sub">${n(g)}</span></button>`)}</div>
    <div class="sr-groups sr-cfr-chips" role="group" aria-label="Show source"><span class="sr-label">Source</span>
      <button type="button" class="sr-seg" data-cfr-source="" aria-pressed="${state.source === '' ? 'true' : 'false'}">All</button>
      ${CFR_SOURCES.map(([k, label]) => html`<button type="button" class="sr-seg" data-cfr-source="${k}" aria-pressed="${state.source === k ? 'true' : 'false'}">${label} <span class="sr-sub">${srcN(k)}</span></button>`)}</div>`;
}

export function renderCfrListBody(model, state, o = {}) {
  const rows = cfrListRows(model, state);
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / CMP_PAGE_SIZE));
  const page = state.all ? 1 : Math.min(Math.max(1, state.page), pages);
  const slice = state.all ? rows : rows.slice((page - 1) * CMP_PAGE_SIZE, page * CMP_PAGE_SIZE);
  const first = total ? (state.all ? 1 : (page - 1) * CMP_PAGE_SIZE + 1) : 0;
  const last = state.all ? total : first + slice.length - (total ? 1 : 0);
  const ariaSort = (c) => (state.sort === c.key ? (state.dir === 'desc' ? 'descending' : 'ascending') : 'none');
  const pager = total > CMP_PAGE_SIZE
    ? html`<div class="sr-pager"><span class="sr-pager-info" role="status">${state.all ? `All ${total} variants` : `Variants ${first} to ${last} of ${total}`}</span>
        ${state.all ? html`<button type="button" class="btn btn-ghost btn-sm" data-cfr-all="0">Show ${CMP_PAGE_SIZE} per page</button>` : html`
          <button type="button" class="btn btn-ghost btn-sm" data-cfr-page="prev"${page <= 1 ? raw(' disabled') : ''}>Previous</button>
          <span class="sr-pager-info">Page ${page} of ${pages}</span>
          <button type="button" class="btn btn-ghost btn-sm" data-cfr-page="next"${page >= pages ? raw(' disabled') : ''}>Next</button>
          <button type="button" class="btn btn-ghost btn-sm" data-cfr-all="1">Show all ${total}</button>`}</div>`
    : html`<div class="sr-pager"><span class="sr-pager-info" role="status">${total === 1 ? '1 variant' : `${total} variants`}</span></div>`;
  const oo = { ...o, reports: o.reports ?? model.reports };
  return html`${cfrChips(model, state)}
    ${total ? html`<div class="sr-table-wrap"><table class="sr-table sr-table--multi sr-table--cmp sr-table--cfr" data-cfr-table>
    <caption class="sr-sr-only">${total} variants of ${model.symbol} at residues in the CFR neighborhood. Column headings with buttons sort the table.</caption>
    <thead><tr>${model.cols.map((c) => html`<th scope="col"${c.sort ? html` aria-sort="${ariaSort(c)}"` : ''} class="${c.num ? 'num' : ''}">${c.sort ? html`<button type="button" data-cfr-sort="${c.key}">${c.label}</button>` : c.label}</th>`)}</tr></thead>
    <tbody>${slice.map((row) => html`<tr data-cfr-row="${row.group}">${model.cols.map((c) => html`<td data-label="${c.label}" class="sr-c-${c.key}${c.num ? ' num' : ''}">${cfrCell(c, row, model, oo)}</td>`)}</tr>`)}</tbody></table></div>`
    : html`<p class="sr-message sr-message--info">No variant matches these filters.</p>`}
    ${pager}`;
}

/** Count tiles, the CFR positions, filters, sort, CSV and the table, as the initial markup. */
export function renderCfrList(model, state, o = {}) {
  if (!model) return html`<p class="sr-na">The residue table of this receptor is not in this index.</p>`;
  const sym = model.symbol;
  const groups = CFR_GROUPS.filter((g) => g !== 'touch' || model.hasTouch);
  const gl = model.releases?.gnomad ?? 'gnomAD';
  const cl = model.releases?.clinvar ?? 'ClinVar';
  const tiles = html`<ul class="sr-cfr-tiles" aria-label="Variants per group">${groups.map((g) => html`<li class="sr-cfr-tile" data-cfr-tile="${g}">
      <span class="sr-cfr-tile-k">${term(o, { at: 'cfr', connected: 'cfr-connected', near: 'cfr-near', touch: 'cfr-touch' }[g], CFR_GROUP_LABEL[g])}</span>
      <span class="sr-big" data-cfr-count="${g}">${model.counts[g]?.variants ?? 0}</span> <span class="sr-sub">variant${model.counts[g]?.variants === 1 ? '' : 's'} at ${model.counts[g]?.residues ?? 0} residue${model.counts[g]?.residues === 1 ? '' : 's'}</span></li>`)}</ul>`;
  const cfrList = model.cfr.length
    ? html`<details class="sr-more sr-cfr-positions"><summary>The ${model.cfr.length} CFR positions of ${sym}</summary><ul class="sr-chips">${[...model.cfr].sort((a, b) => a.pos - b.pos).map((c) => html`<li>${intLink(L.residueUrl(o, model.gid, c.pos), cfrName(c), { cls: 'sr-chip', title: 'Report at this residue' })}</li>`)}</ul></details>`
    : html`<p>${sym} has no residue at a CFR position.</p>`;
  return html`<div class="sr-cfrlist" data-cfrlist>
    <p class="sr-cfr-set">${cfrSetText(o.cfrTop ?? model.cfrTop)} ${term(o, 'cfr', 'What is a CFR?')}</p>
    ${tiles}
    ${cfrList}
    <div class="sr-cmp-controls">
      <div class="sr-cmp-sort"><label class="sr-cmp-field">Sort by
        <select class="v2-select" data-cfr-sortsel><option value="orig"${state.sort === 'orig' ? raw(' selected') : ''}>Group, then residue</option>${model.cols.filter((c) => c.sort).map((c) => html`<option value="${c.key}"${state.sort === c.key ? raw(' selected') : ''}>${c.label}</option>`)}</select></label>
        <button type="button" class="btn btn-ghost btn-sm" data-cfr-dir${state.sort === 'orig' ? raw(' disabled') : ''} aria-label="Sort direction: ${state.dir === 'desc' ? 'high to low' : 'low to high'}. Press to reverse.">${state.dir === 'desc' ? 'High to low' : 'Low to high'}</button></div>
      <button type="button" class="btn btn-ghost btn-sm sr-cmp-csv" data-cfr-csv>Download CSV</button>
    </div>
    <div data-cfr-body>${renderCfrListBody(model, state, o)}</div>
    ${finePrint(html`<p>Each residue is counted once, in the first group that applies: ${groups.map((g) => `${CFR_GROUP_LABEL[g][0].toLowerCase()}${CFR_GROUP_LABEL[g].slice(1)} (${CFR_GROUP_DEF[g].replace(/\.$/, '')})`).join('; ')}. The CFR partner column lists the CFR residues a residue is connected to by contacts above ${sym}’s threshold${model.threshold !== null && model.threshold !== undefined ? ` (|ΔRRCS| ≥ ${model.threshold.toFixed(2)})` : ''}; <span class="sr-net sr-net--active">red, positive</span> ΔRRCS is stronger in the active model, <span class="sr-net sr-net--inactive">blue, negative</span> stronger in the inactive model. These describe the two models, not the effect of a variant.</p>
      <p>Variants: every ${gl} missense allele and every ${cl} missense record at these residues (a record of a ${gl} allele shares its row)${model.skipped ? `; ${model.skipped} ClinVar record${model.skipped === 1 ? '' : 's'} of other kinds (synonymous, stop, frameshift) at these residues ${model.skipped === 1 ? 'is' : 'are'} not listed` : ''}. AlphaMissense scores are predictions. ${RESEARCH_NOTE_SHORT}</p>`, { cls: 'sr-cfrlist-note' })}
  </div>`;
}

/** The table as CSV: every row after the filters and the sort, not just the visible page. */
export function cfrListCsv(model, state) {
  const rows = cfrListRows(model, state);
  const head = ['receptor', 'gene_symbol', 'gpcr_id', 'group', 'residue', 'residue_number', 'generic_number', 'segment', 'cfr_rank',
    'cfr_partners', 'change_model_numbering', 'gnomad_hgvsp', 'gnomad_id', 'rsids', 'allele_count', 'allele_number', 'allele_frequency',
    'clinvar_ids', 'clinvar_classification', 'clinvar_stars', 'alphamissense', 'alphamissense_class', 'receptor_threshold'];
  const lines = [head.join(',')];
  for (const x of rows) {
    const a = x.allele;
    const v = [recShort(model.receptor ?? { symbol: model.symbol }), model.symbol, model.gid, CFR_GROUP_LABEL[x.group], `${three(x.hood.aa ?? x.ref)}${x.pos}`, x.pos,
      x.hood.generic ?? '', x.hood.segment ?? '', x.hood.rank ?? '', cfrPartnerText(x), pChange(x), a?.hgvsp ?? '', a?.id ?? '', (a?.rsids ?? []).join(' '),
      a ? a.ac : '', a ? a.an : '', a?.af === null || a?.af === undefined ? '' : Number(a.af.toPrecision(4)), x.clinvar.map((c) => c.accession ?? c.variationId).join(' '), x.clinvar.map((c) => c.classification ?? '').join('; '),
      x.clinvar.map((c) => c.stars ?? 0).join(' '), x.am ?? '', x.amClass ? amClassLabel(x.amClass) : '', model.threshold ?? ''];
    lines.push(v.map(csvField).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

function receptorCard(r, o, idx) {
  const rec = r.receptor;
  return html`<article class="sr-card sr-card--receptor" aria-labelledby="sr-card-${idx}">
    <header class="sr-card-head"><h3 id="sr-card-${idx}" class="sr-card-title">${intLink(L.reportUrl(o, r.gid), recFull(rec), { title: 'Report page' })}</h3>
    <div class="sr-change"><span class="sr-sub">${rec.name}</span></div></header>
    ${r.cfrList !== undefined ? html`<div class="sr-row sr-row--wide sr-cfrlist-row" id="sr-cfrlist"><h4>Variants at, connected to or near a CFR</h4><div>${renderCfrList(o.cfrModel ?? cfrListModel(r, o), o.cfrState ?? cfrListDefaults(), o)}</div></div>` : ''}
    ${receptorLinks(rec, o) ? html`<div class="sr-row"><h4>Records elsewhere</h4><div>${receptorLinks(rec, o)}</div></div>` : ''}
    ${r.clinvarList ? clinvarListSection(r, o) : ''}
    <div class="sr-row"><h4>Search inside this receptor</h4><div><ul class="sr-chips">
      ${[`${rec.symbol} 3.50`, `${rec.symbol} 6.48`, `${rec.symbol} 159`, ...(r.cfrList !== undefined ? [] : [`${rec.symbol} CFR variants`])].map((q) => html`<li><a class="sr-chip" href="?q=${encodeURIComponent(q)}" data-q="${q}">${q}</a></li>`)}
    </ul>${finePrint(html`<p>Add a protein change, a residue number, a generic number or a coding change to the receptor name.</p>`)}</div></div>
    ${r.clinvarList ? '' : clinvarListSection(r, o)}
    <div class="sr-actions">${intLink(L.reportUrl(o, r.gid), 'Open report', { cls: 'btn btn-primary btn-sm' })}
    ${intLink(L.studioUrl(o, r.gid), 'Open in Studio', { cls: 'btn btn-ghost btn-sm' })}</div>
  </article>`;
}

// -------------------------------------------------------------------- the comparison table

export const CMP_PAGE_SIZE = 25;

function topClinvar(r) {
  const rec = (r.clinvar ?? [])[0];
  return rec ? `${rec.classification}${(r.clinvar.length > 1 ? ` (+${r.clinvar.length - 1})` : '')}` : '';
}

/** The motif name and its positions; the longer note about it is fine print. */
function motifBlock(m) {
  if (!m) return '';
  return html`<p class="sr-motif"><strong>${m.name}</strong>${m.positions?.length ? html`<span class="sr-sub">, generic positions ${m.positions.join(', ')}</span>` : ''}</p>${m.note ? finePrint(html`<p>${m.note}</p>`, { cls: 'sr-motif-note' }) : ''}`;
}

/** Compact table for a list of receptors with nothing to compare (names and accessions). */
export function renderReceptorList(rs, o) {
  return html`<div class="sr-table-wrap"><table class="sr-table sr-table--multi">
    <caption class="sr-sr-only">${rs.length} receptors</caption>
    <thead><tr><th scope="col">Receptor</th><th scope="col">UniProt</th><th scope="col">Name</th><th scope="col">Open</th></tr></thead>
    <tbody>${rs.map((r) => html`<tr>
      <td data-label="Receptor"><a href="?q=${encodeURIComponent(r.receptor.symbol)}" data-q="${r.receptor.symbol}">${recShort(r.receptor)}</a></td>
      <td data-label="UniProt">${r.receptor.uniprot ? extLink(L.uniprotUrl(r.receptor.uniprot), r.receptor.uniprot, 'UniProt') : ''}</td>
      <td data-label="Name">${r.receptor.name ?? ''}</td>
      <td data-label="Open">${intLink(L.reportUrl(o, r.gid), 'Report', { title: 'Report page' })}</td></tr>`)}</tbody></table></div>`;
}

/** A group label up to its colon: "R3.50 (3.50x50)" from "R3.50 (3.50x50): 269 of 283 receptors have Arg". */
const groupShort = (g) => String(g.label).split(':')[0];
const residueLabel = (r) => (r.pos ? `${three(r.summary?.aa ?? r.residue?.aa ?? r.ref)}${r.pos}` : '');

/**
 * The data behind a cross-receptor table: one row per result, with raw values for sorting and the
 * text each column shows. A column nobody has a value for is left out, so an index without
 * `summary` still gives a (smaller) table.
 *
 * @param {object} answer engine answer
 * @param {{familyOf?: (gid: string) => string|undefined}} [o]
 */
export function compareModel(answer, o = {}) {
  const groups = answer.groups?.length ? answer.groups : null;
  const list = groups ? groups.flatMap((g, gi) => g.results.map((r) => ({ r, gi }))) : (answer.results ?? []).map((r) => ({ r, gi: 0 }));
  const rows = list.map(({ r, gi }, i) => {
    const f = residueFacts(r);
    const s = r.summary ?? {};
    const obs = s.observed ?? null;
    return {
      i, r, gi, f,
      gid: r.gid,
      symbol: r.receptor?.symbol ?? r.gid,
      family: f.family ?? o.familyOf?.(r.gid) ?? '',
      res: residueLabel(r),
      generic: f.generic ?? r.generic ?? '',
      segment: f.segment ?? '',
      gnomad: obs ? num(obs.gnomad) : (r.alleles?.length ? r.alleles.length : null),
      clinvar: obs ? num(obs.clinvar) : (r.clinvar?.length ? r.clinvar.length : null),
      query: queryFor(r, answer.interpretation),
      departs: false,
    };
  });
  if (answer.motif?.canonical && groups) {
    for (const row of rows) {
      const canon = answer.motif.canonical[groups[row.gi].key];
      row.departs = !!(canon && row.r.ref && !canon.includes(row.r.ref));
    }
  }
  const any = (fn) => rows.some((row) => fn(row) !== null && fn(row) !== undefined && fn(row) !== '');
  const cols = [
    { key: 'rec', label: 'Receptor', show: true, sort: (row) => row.symbol.toLowerCase(), text: (row) => recShort(row.r.receptor) },
    { key: 'fam', label: 'Family', show: any((row) => row.family), sort: (row) => row.family.toLowerCase(), text: (row) => row.family },
    { key: 'grp', label: 'Group', show: !!groups && groups.length > 1, sort: (row) => row.gi, text: (row) => groupShort(groups[row.gi]) },
    { key: 'res', label: 'Residue', show: true, num: true, sort: (row) => row.r.pos ?? null, text: (row) => row.res },
    { key: 'gen', label: 'Generic number', show: any((row) => row.generic), sort: (row) => row.generic, text: (row) => row.generic },
    { key: 'net', label: 'Net ΔRRCS', show: any((row) => row.f.net), num: true, sort: (row) => row.f.net, text: (row) => (row.f.net === null ? '' : signed(row.f.net, 1)) },
    { key: 'dmax', label: 'Largest |ΔRRCS|', show: any((row) => row.f.dmax), num: true, sort: (row) => row.f.dmax, text: (row) => (row.f.dmax === null ? '' : row.f.dmax.toFixed(1)) },
    { key: 'nsig', label: 'Contacts above threshold', show: any((row) => row.f.nsig), num: true, sort: (row) => row.f.nsig, text: (row) => (row.f.nsig === null ? '' : String(row.f.nsig)) },
    { key: 'cfr', label: 'CFR rank', show: any((row) => row.f.cfrRank), num: true, sort: (row) => row.f.cfrRank, text: (row) => (row.f.cfrRank === null ? '' : String(row.f.cfrRank)) },
    { key: 'cons', label: 'Conservation (0 to 1)', show: any((row) => row.f.conservation), num: true, sort: (row) => row.f.conservation, text: (row) => (row.f.conservation === null ? '' : row.f.conservation.toFixed(1)) },
    { key: 'gnomad', label: 'gnomAD alleles', show: any((row) => row.gnomad), num: true, sort: (row) => row.gnomad, text: (row) => (row.gnomad === null ? '' : String(row.gnomad)) },
    { key: 'clinvar', label: 'ClinVar records', show: any((row) => row.clinvar), num: true, sort: (row) => row.clinvar, text: (row) => (row.clinvar === null ? '' : String(row.clinvar)) },
  ].filter((c) => c.show);
  const families = [...rows.reduce((m, row) => (row.family ? m.set(row.family, (m.get(row.family) ?? 0) + 1) : m), new Map())]
    .sort((a, b) => a[0].localeCompare(b[0]));
  return {
    rows, cols, groups: groups ? groups.map((g) => ({ key: g.key, label: g.label, n: g.results.length })) : null, families,
    filterNote: answer.filterNote ?? null, motif: answer.motif ?? null, hasSummary: rows.some((row) => row.r.summary),
    reports: o.reports,
  };
}

export const compareDefaults = () => ({ sort: 'orig', dir: 'asc', family: '', group: '', page: 1, all: false });

/** Apply the filters and the sort to the model; the page slice is applied by the caller. */
export function compareRows(model, state) {
  let rows = model.rows.filter((row) => (!state.family || row.family === state.family) && (!state.group || model.groups?.[row.gi]?.key === state.group));
  if (state.sort && state.sort !== 'orig') {
    const col = model.cols.find((c) => c.key === state.sort);
    if (col) {
      const sgn = state.dir === 'desc' ? -1 : 1;
      rows = [...rows].sort((a, b) => {
        const x = col.sort(a); const y = col.sort(b);
        const xn = x === null || x === undefined || x === '';
        const yn = y === null || y === undefined || y === '';
        if (xn || yn) return xn === yn ? a.i - b.i : (xn ? 1 : -1); // missing values last, either way
        const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'en', { numeric: true });
        return c ? sgn * c : a.i - b.i;
      });
    }
  }
  return rows;
}

function cellHtml(col, row, o) {
  const f = row.f;
  switch (col.key) {
    case 'rec': return html`<a href="?q=${encodeURIComponent(row.query)}" data-q="${row.query}" title="Details for ${row.query}">${recShort(row.r.receptor)}</a> ${intLink(L.residueUrl(o, row.gid, row.r.pos), 'report', { cls: 'sr-sub sr-reportlink', title: row.r.pos ? 'Report at this residue' : 'Report page' })}`;
    case 'gen': return row.generic ? html`<span class="mono">${row.generic}</span>` : html`<span class="sr-na">none</span>`;
    case 'res': return html`<span class="mono">${row.res}</span>${row.departs ? html` <span class="sr-badge sr-badge--warn" title="This residue is not the one the motif name fixes">not the motif residue</span>` : ''}`;
    case 'net': return f.net === null ? html`<span class="sr-na">none</span>` : netHtml(f.net, { word: false });
    case 'dmax': {
      if (f.dmax === null) return html`<span class="sr-na">none</span>`;
      const d = direction(f.dmaxSigned);
      return html`<span class="${d ? `sr-net sr-net--${d.cls}` : ''}">${f.dmax.toFixed(1)}</span>${d ? html`<span class="sr-sr-only"> (${d.word})</span>` : ''}${f.partner ? html` <span class="sr-sub">with <span class="sr-notation">${f.partner}</span></span>` : ''}`;
    }
    case 'nsig': return f.nsig === null ? html`<span class="sr-na">none</span>` : String(f.nsig);
    case 'cfr': return f.cfrRank === null ? html`<span class="sr-na">none</span>` : html`${f.cfrRank}${f.cfr ? html` <span class="sr-badge sr-badge--cfr" title="Core functional residue: ${cfrOneOf(o.cfrTop)}">CFR</span>` : ''}`;
    case 'cons': return f.conservation === null ? html`<span class="sr-na">none</span>` : f.conservation.toFixed(1);
    case 'gnomad': return row.gnomad === null ? html`<span class="sr-na">n/a</span>` : (row.gnomad ? String(row.gnomad) : html`<span class="sr-na">not seen</span>`);
    case 'clinvar': return row.clinvar === null ? html`<span class="sr-na">n/a</span>` : (row.clinvar ? String(row.clinvar) : html`<span class="sr-na">none</span>`);
    default: return col.text(row);
  }
}

/** Legend, filters, sort control (phones) and the table body, as the initial markup. */
export function renderCompare(model, state, o = {}) {
  const sortable = model.cols;
  return html`<div class="sr-compare" data-compare>
    ${motifBlock(model.motif)}
    ${model.filterNote ? html`<p class="sr-filter-note">${model.filterNote}</p>` : ''}
    ${model.groups && model.groups.length > 1 ? html`<div class="sr-groups" role="group" aria-label="Show"><span class="sr-label">Show</span>
      <button type="button" class="sr-seg" data-cmp-group="" aria-pressed="${state.group === '' ? 'true' : 'false'}">All <span class="sr-sub">${model.rows.length}</span></button>
      ${model.groups.map((g) => html`<button type="button" class="sr-seg" data-cmp-group="${g.key}" aria-pressed="${state.group === g.key ? 'true' : 'false'}" title="${g.label}">${String(g.label).split(':')[0]} <span class="sr-sub">${g.n}</span></button>`)}</div>
      ${model.motif && model.groups.some((g) => String(g.label).includes(':')) ? finePrint(html`<ul class="sr-motif-notes">${model.groups.map((g) => html`<li>${g.label}</li>`)}</ul>`, { summary: 'About these groups' }) : ''}` : ''}
    <div class="sr-cmp-controls">
      ${model.families.length > 1 ? html`<label class="sr-cmp-field">Family
        <select class="v2-select" data-cmp-family><option value="">All families (${model.rows.length})</option>${model.families.map(([name, n]) => html`<option value="${name}"${state.family === name ? raw(' selected') : ''}>${name} (${n})</option>`)}</select></label>` : ''}
      <div class="sr-cmp-sort"><label class="sr-cmp-field">Sort by
        <select class="v2-select" data-cmp-sortsel><option value="orig"${state.sort === 'orig' ? raw(' selected') : ''}>Original order</option>${sortable.map((c) => html`<option value="${c.key}"${state.sort === c.key ? raw(' selected') : ''}>${c.label}</option>`)}</select></label>
        <button type="button" class="btn btn-ghost btn-sm" data-cmp-dir${state.sort === 'orig' ? raw(' disabled') : ''} aria-label="Sort direction: ${state.dir === 'desc' ? 'high to low' : 'low to high'}. Press to reverse.">${state.dir === 'desc' ? 'High to low' : 'Low to high'}</button></div>
      <button type="button" class="btn btn-ghost btn-sm sr-cmp-csv" data-cmp-csv>Download CSV</button>
    </div>
    <div data-cmp-body>${renderCompareBody(model, state, o)}</div>
    ${model.hasSummary ? html`<aside class="fine-print sr-legend"><p>Net ΔRRCS: <span class="sr-net sr-net--active">red, positive</span> means stronger in the active model; <span class="sr-net sr-net--inactive">blue, negative</span> means stronger in the inactive model. Thresholds are set per receptor, so compare ranks and directions rather than raw sizes.</p></aside>` : ''}
  </div>`;
}

export function renderCompareBody(model, state, o = {}) {
  const rows = compareRows(model, state);
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / CMP_PAGE_SIZE));
  const page = state.all ? 1 : Math.min(Math.max(1, state.page), pages);
  const slice = state.all ? rows : rows.slice((page - 1) * CMP_PAGE_SIZE, page * CMP_PAGE_SIZE);
  const first = total ? (state.all ? 1 : (page - 1) * CMP_PAGE_SIZE + 1) : 0;
  const last = state.all ? total : first + slice.length - (total ? 1 : 0);
  const ariaSort = (c) => (state.sort === c.key ? (state.dir === 'desc' ? 'descending' : 'ascending') : 'none');
  const pager = total > CMP_PAGE_SIZE
    ? html`<div class="sr-pager"><span class="sr-pager-info" role="status">${state.all ? `All ${total} rows` : `Rows ${first} to ${last} of ${total}`}</span>
        ${state.all ? html`<button type="button" class="btn btn-ghost btn-sm" data-cmp-all="0">Show ${CMP_PAGE_SIZE} per page</button>` : html`
          <button type="button" class="btn btn-ghost btn-sm" data-cmp-page="prev"${page <= 1 ? raw(' disabled') : ''}>Previous</button>
          <span class="sr-pager-info">Page ${page} of ${pages}</span>
          <button type="button" class="btn btn-ghost btn-sm" data-cmp-page="next"${page >= pages ? raw(' disabled') : ''}>Next</button>
          <button type="button" class="btn btn-ghost btn-sm" data-cmp-all="1">Show all ${total}</button>`}</div>`
    : html`<div class="sr-pager"><span class="sr-pager-info" role="status">${total === 1 ? '1 row' : `${total} rows`}</span></div>`;
  return html`${total ? html`<div class="sr-table-wrap"><table class="sr-table sr-table--multi sr-table--cmp">
    <caption class="sr-sr-only">${total} receptors. Column headings are buttons that sort the table.</caption>
    <thead><tr>${model.cols.map((c) => html`<th scope="col" aria-sort="${ariaSort(c)}" class="${c.num ? 'num' : ''}"><button type="button" data-cmp-sort="${c.key}">${c.label}</button></th>`)}</tr></thead>
    <tbody>${slice.map((row) => html`<tr>${model.cols.map((c) => html`<td data-label="${c.label}" class="sr-c-${c.key}${c.num ? ' num' : ''}">${cellHtml(c, row, { ...o, reports: o.reports ?? model.reports })}</td>`)}</tr>`)}</tbody></table></div>`
    : html`<p class="sr-message sr-message--info">No receptor matches these filters.</p>`}
    ${pager}`;
}

const NUMERIC_TEXT = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;

/**
 * One CSV cell. Text that a spreadsheet would run as a formula (a cell starting with =, +, -, @, a tab or
 * a carriage return) gets a leading apostrophe (the OWASP mitigation); numbers, and text that is a plain
 * number such as "-1.3", stay numeric.
 */
export function csvField(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s) && !NUMERIC_TEXT.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The table as CSV: every row after the filters and the sort, not just the visible page. */
export function compareCsv(model, state) {
  const rows = compareRows(model, state);
  const head = ['receptor', 'gene_symbol', 'gpcr_id', 'uniprot', 'family'];
  if (model.groups?.length > 1) head.push('group');
  head.push('residue', 'residue_number', 'generic_number', 'segment');
  if (model.motif?.canonical) head.push('departs_from_motif');
  const extra = {
    net: ['net_delta_rrcs', 'net_direction'],
    dmax: ['largest_abs_delta_rrcs', 'largest_signed_delta_rrcs', 'largest_partner', 'receptor_threshold'],
    nsig: ['contacts_above_threshold'], cfr: ['cfr_rank'], cons: ['conservation_0_to_1'],
    gnomad: ['gnomad_alleles'], clinvar: ['clinvar_records'],
  };
  const have = new Set(model.cols.map((c) => c.key));
  for (const k of ['net', 'dmax', 'nsig', 'cfr', 'cons', 'gnomad', 'clinvar']) if (have.has(k)) head.push(...extra[k]);
  const lines = [head.join(',')];
  for (const row of rows) {
    const r = row.r; const f = row.f;
    const v = [recShort(r.receptor), r.receptor?.symbol, row.gid, r.receptor?.uniprot, row.family];
    if (model.groups?.length > 1) v.push(model.groups[row.gi].label);
    v.push(row.res, r.pos, row.generic, row.segment);
    if (model.motif?.canonical) v.push(row.departs ? 'yes' : 'no');
    if (have.has('net')) v.push(f.net === null ? '' : f.net.toFixed(1), direction(f.net)?.word ?? '');
    if (have.has('dmax')) v.push(f.dmax === null ? '' : f.dmax.toFixed(1), f.dmaxSigned === null ? '' : f.dmaxSigned.toFixed(1), f.partner ?? '', f.threshold === null ? '' : f.threshold.toFixed(2));
    if (have.has('nsig')) v.push(f.nsig ?? '');
    if (have.has('cfr')) v.push(f.cfrRank ?? '');
    if (have.has('cons')) v.push(f.conservation === null ? '' : f.conservation.toFixed(1));
    if (have.has('gnomad')) v.push(row.gnomad ?? '');
    if (have.has('clinvar')) v.push(row.clinvar ?? '');
    lines.push(v.map(csvField).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

// ------------------------------------------------------------------------------- help & footer

/** One example set across receptor families and notations; every query resolves to a card or a table in the index. */
export const HELP = [
  ['Protein change', ['DRD2 S311C', 'MC1R Arg151Cys', 'OPRM1 N40D']],
  ['Residue', ['DRD2 Ser311', 'CNR1 Trp356']],
  ['Coding DNA', ['NM_000795.4:c.932C>G', 'NM_002386.4:c.451C>T']],
  ['Genome (GRCh38 or GRCh37)', ['11-113412762-G-C', '16-89919709-C-T', '11-113283484-G-C']],
  ['Database IDs', ['rs1801028', 'rs1805007', 'VCV000014312']],
  ['Generic residue number', ['6.48x48', 'ADRB2 3.50', 'R3.50']],
  ['Motif', ['DRY', 'NPxxY in MC1R', 'toggle switch']],
  ['Receptor name or ID', ['ADRB2', 'DRD2', 'MC1R', 'β2AR']],
];

export function renderHelp(o = {}) {
  return html`<div class="sr-help"><h2 class="sr-h2">You can search like this</h2>
    <p class="sr-sub">Click an example to try it.</p>
    <dl class="sr-help-list">${HELP.map(([k, ex]) => html`<div><dt>${k}</dt><dd><ul class="sr-chips">${ex.map((q) => html`<li><a class="sr-chip" href="?q=${encodeURIComponent(q)}" data-q="${q}">${q}</a></li>`)}</ul></dd></div>`)}</dl></div>`;
}

export function renderReleases(rel) {
  if (!rel) return '';
  const l = (k) => rel[k]?.label;
  const ens = rel.ensembl ? `${l('ensembl')} (${rel.ensembl.grch38}, ${rel.ensembl.grch37})` : null;
  const amUrl = L.alphamissenseUrl(rel);
  const am = l('alphamissense') && amUrl ? extLink(amUrl, l('alphamissense'), 'Zenodo', { cls: '' }) : l('alphamissense');
  const bits = [l('gnomad'), l('clinvar'), ens, am, l('hgnc'), l('uniprot')].filter(Boolean);
  const rt = rel.reportTable ?? null;
  const same = rt ? rt.sameAsSearch !== false : true;
  const rule = html`at residues with at least one contact change of |ΔRRCS| ≥ ${REPORT_TABLE_DELTA.toFixed(1)}`;
  const note = same
    ? finePrint(html`<p>The variant tables on the report pages use the same release as this search, ${l('gnomad') ?? 'gnomAD'}. They list its missense alleles ${rule}; search covers every missense allele and ${l('clinvar') ?? 'ClinVar'}.</p>`, { cls: 'sr-releases-note' })
    : html`<details><summary>How this differs from the report pages</summary>
    <p>The variant tables on the report pages list ${reportTableRelease(rel)} missense variants ${rule}; search uses ${l('gnomad') ?? 'gnomAD'} and covers every missense allele and ${l('clinvar') ?? 'ClinVar'}. Where the two differ, the search result is the more recent.</p></details>`;
  return html`<p class="sr-releases"><strong>Data in this search:</strong> ${bits.map((b, i) => html`${i ? '; ' : ''}${b}`)}. Coordinates are given on GRCh38 and GRCh37.</p>
    ${note}`;
}

// -------------------------------------------------------------------------------- main entry

/** "No receptor has Trp at 3.50x50; all 283 receptors with their residue at 3.50x50 are listed below." */
function groupedOnlyMessage(answer) {
  const i = answer.interpretation ?? {};
  const rows = (answer.groups ?? []).flatMap((g) => g.results ?? []);
  const n = rows.length;
  const first = rows[0];
  const gn = first?.summary?.generic ?? first?.generic ?? /at (\S+)$/.exec(String(answer.groups[0]?.label ?? ''))?.[1] ?? i.generic?.display ?? '';
  const letter = i.generic?.residueLetter ?? i.change?.ref ?? null;
  const has = letter ? three(letter) : 'that residue';
  return `No receptor has ${has}${gn ? ` at ${gn}` : ''}; ${n === 1 ? 'the 1 receptor' : `all ${n} receptors`} with ${n === 1 ? 'its' : 'their'} residue${gn ? ` at ${gn}` : ''} ${n === 1 ? 'is' : 'are'} listed below.`;
}

/**
 * @param {object} answer engine answer
 * @param {string} query what was typed
 * @param {{reports: string, studio: string, releases?: object, cfrTop?: number, symbolOf?: (gid:string)=>string,
 *          familyOf?: (gid:string)=>string, pageUrl?: string, base?: string}} o   `cfrTop`: meta.json cfrTop, the size
 *          of the class-wide CFR set (every CFR text names it)
 * @returns {{html: string, status: string, results: object[], compare: object|null, cfr: object|null, ctx: object}}
 *   `results` are the cards' results (index = the data-copy-* number); `compare` is the model of the
 *   cross-receptor table when one was drawn; `cfr` the model of a receptor's CFR variant table ("ADRB2 CFR
 *   variants"); `ctx` is what evidenceText() needs.
 */
export function renderAnswer(answer, query, o) {
  const base = o.base ?? '';
  const rs = answer.results ?? [];
  const reading = readAsText(answer, query);
  const statusBits = [];
  let out = '';
  const ro = { ...o, interp: answer.interpretation, query, typed: answer.typed ?? null, alternates: answer.alternates ?? [] };
  const ctx = { query, reading, interp: answer.interpretation, releases: o.releases, cfrTop: o.cfrTop ?? null, pageUrl: o.pageUrl, typed: answer.typed ?? null, alternates: answer.alternates ?? [] };
  // no exact match, but the other residues at the position are grouped (W3.50: nobody has Trp at 3.50x50)
  const groupedOnly = !rs.length && (answer.groups ?? []).some((g) => g.results?.length);

  out += newTabNote().s;
  if (String(query ?? '').length > MAX_QUERY_LENGTH || answer.interpretation?.flags?.includes('query-truncated')) {
    out += html`<div class="sr-message sr-message--info" role="note">Only the first ${MAX_QUERY_LENGTH} characters were read.</div>`.s;
  }

  // the card's own "Did you mean" button replaces the same link in the list at the top
  const fixes = new Set(rs.map((r) => mismatchFix(r, ro)?.query).filter(Boolean));
  if (reading && !(answer.interpretation?.kind === 'receptor' && !rs.length)) {
    out += html`<section class="sr-read" aria-label="How the query was read"><p class="sr-read-line"><span class="sr-label">I read this as</span> <strong>${reading}</strong>${answer.assembly ? html` <span class="sr-badge">${answer.assembly}</span>` : ''}</p>
      ${alternatesBlock(answer, o.symbolOf, base, fixes)}</section>`.s;
  } else if (answer.alternates?.length) {
    out += html`<section class="sr-read">${alternatesBlock(answer, o.symbolOf, base, fixes)}</section>`.s;
  }

  const dup = answer.message && rs.some((r) => (r.notes ?? []).some((n) => n.text === answer.message));
  if (groupedOnly) {
    out += html`<div class="sr-message sr-message--info" role="note" data-expect="${answer.expect}">${groupedOnlyMessage(answer)}</div>`.s;
  } else if (answer.message && !dup && !answer.filterNote) {
    const level = answer.expect === 'unrecognised' || (answer.expect === 'not_in_resource' && !rs.length) ? 'sr-message--stop' : 'sr-message--info';
    out += html`<div class="sr-message ${level}" role="note" data-expect="${answer.expect}"><span class="sr-sr-only">${answer.expect === 'unrecognised' ? 'Could not read the query. ' : ''}</span>${answer.message}</div>`.s;
  }

  let compare = null;
  let cfr = null;
  if (rs.length) {
    const receptors = new Set(rs.map((r) => r.gid));
    const receptorsOnly = rs.every((r) => r.type === 'receptor');
    const crossReceptor = receptors.size > 1 && (rs.length > 3 || rs.some((r) => r.light) || !!answer.groups);
    if (crossReceptor && receptorsOnly) {
      statusBits.push(`${rs.length} receptors`);
      out += html`<section class="sr-results" aria-label="Results"><h2 class="sr-h2">${rs.length} receptors</h2>${renderReceptorList(rs, o)}</section>`.s;
    } else if (crossReceptor) {
      compare = compareModel(answer, o);
      const n = compare.rows.length;
      statusBits.push(`${n} ${n === 1 ? 'receptor' : 'receptors'}`);
      out += html`<section class="sr-results" aria-label="Results"><h2 class="sr-h2">${n} receptors</h2>${renderCompare(compare, compareDefaults(), o)}</section>`.s;
    } else {
      statusBits.push(`${rs.length} ${rs.length === 1 ? 'result' : 'results'}`);
      const motif = motifBlock(answer.motif);
      if (rs.length === 1 && rs[0].cfrList) { cfr = cfrListModel(rs[0], o); statusBits.push(`${cfr.rows.length} variants in the CFR neighborhood`); }
      const co = { ...ro, cardCount: rs.length, cfrModel: cfr };
      out += html`<section class="sr-results" aria-label="Results">${motif}${rs.map((r, i) => (r.type === 'receptor' ? receptorCard(r, co, i) : card(r, co, i)))}</section>`.s;
    }
  } else if (groupedOnly) {
    compare = compareModel(answer, o);
    const n = compare.rows.length;
    statusBits.push(`No exact match, ${n} ${n === 1 ? 'receptor' : 'receptors'} listed`);
    out += html`<section class="sr-results" aria-label="Results"><h2 class="sr-h2">${n} ${n === 1 ? 'receptor' : 'receptors'}</h2>${renderCompare(compare, compareDefaults(), o)}</section>`.s;
  } else {
    statusBits.push('No result');
  }

  if ((!rs.length && !groupedOnly) || answer.expect === 'unrecognised') out += renderHelp(o).s;
  return { html: out, status: statusBits.join(', '), results: rs, compare, cfr, ctx };
}
