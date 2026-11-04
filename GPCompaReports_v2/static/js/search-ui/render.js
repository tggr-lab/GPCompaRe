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
const fmt2 = (x) => (x === null || x === undefined ? 'n/a' : x.toFixed(2));

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
      if (sameRec && first.pos) parts[1] = `residue ${three(first.ref)}${first.pos} at generic number ${first.residue?.generic || g.display}`;
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
    family: s.family ?? null,
    generic: x.generic || s.generic || null,
    segment: x.segment || s.segment || null,
    aa: x.aa ?? s.aa ?? r.ref ?? null,
  };
}

/** Direction of a net ΔRRCS: red = stronger in the active model, blue = stronger in the inactive model. */
export function direction(net) {
  if (net === null || net === undefined) return null;
  if (net > 0) return { cls: 'active', word: 'stronger in active', short: 'active' };
  if (net < 0) return { cls: 'inactive', word: 'stronger in inactive', short: 'inactive' };
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

function amCell(a) {
  if (a.am === null || a.am === undefined) return html`<span class="sr-na">no score</span>`;
  return html`${a.am.toFixed(2)} <span class="sr-sub">${a.amClass ?? ''}</span>`;
}

function allelesTable(alleles, { caption }) {
  return html`<div class="sr-table-wrap"><table class="sr-table">
    <caption class="sr-sr-only">${caption}</caption>
    <thead><tr><th scope="col">gnomAD allele (GRCh38)</th><th scope="col">Change</th><th scope="col">rsID</th><th scope="col" class="num">Allele count</th><th scope="col" class="num">Frequency</th><th scope="col" class="num">Homozygotes</th><th scope="col">AlphaMissense prediction</th></tr></thead>
    <tbody>${alleles.map((a) => html`<tr>
      <td class="mono" data-label="gnomAD allele (GRCh38)">${a.id}${a.id37 ? html`<br><span class="sr-sub">GRCh37 <span class="mono">${a.id37}</span></span>` : ''}</td>
      <td data-label="Change"><span class="mono">${a.hgvsc ?? ''}</span>${a.hgvsc ? html`<br>` : ''}<span class="sr-sub mono">${a.hgvsp ?? ''}</span>${a.conflict ? html` <span class="sr-badge sr-badge--warn" title="The model has the other residue here">model differs</span>` : ''}</td>
      <td class="mono" data-label="rsID">${a.rsids?.length ? a.rsids.join(', ') : 'none'}</td>
      <td class="num" data-label="Allele count">${fmtInt(a.ac)}<span class="sr-sub"> of ${fmtInt(a.an)}</span></td>
      <td class="num" data-label="Frequency">${fmtAf(a.af)}</td>
      <td class="num" data-label="Homozygotes">${fmtInt(a.hom)}</td>
      <td data-label="AlphaMissense prediction">${amCell(a)}</td></tr>`)}</tbody></table></div>`;
}

// ------------------------------------------------------- "You typed X -> model residue Y"

const MAPPED_KINDS = new Set(['cdna', 'genomic', 'rsid', 'clinvar', 'generic']);

function modelText(r) {
  const res = `${three(r.residue?.aa ?? r.ref)}${r.pos}`;
  return r.alt && r.kind === 'missense' ? { res, change: hgvsP(r) } : { res, change: null };
}

function leadReason(r, i) {
  if (hasNote(r, 'offset_mapping')) return 'the transcript you typed numbers this residue differently from the model';
  if (hasNote(r, 'isoform_mapping')) return 'mapped from another isoform of this receptor';
  if (hasNote(r, 'version_mismatch')) return 'the transcript version differs from the one in this database';
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
  const q = String(o.query ?? '').trim();
  const typed = q.length > 90 ? `${q.slice(0, 87)}...` : q;
  return html`<p class="sr-lead"><span class="sr-label">You typed</span> <span class="mono">${typed}</span> <span class="sr-arrow" aria-hidden="true">→</span><span class="sr-sr-only"> which is </span> <span class="sr-label">model residue</span> <strong class="mono">${m.res}</strong>${m.change ? html`<span class="sr-sub">, </span><span class="mono">${m.change}</span>` : ''} <span class="sr-sub">(${leadReason(r, o.interp)})</span></p>`;
}

// ------------------------------------------------------ transcripts, assemblies (folded away)

function transcriptTable(r) {
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
    <tbody>${rows.map((row) => html`<tr>${anyAllele ? html`<td class="mono" data-label="Genomic allele (GRCh38)">${row.t.allele ?? ''}</td>` : ''}
      <td data-label="View">${row.roles.map(roleLabel).join(', ')}</td>
      <td class="mono" data-label="Transcript">${row.t.transcript}</td><td class="mono" data-label="Protein">${row.protein ?? ''}</td>
      ${anyC ? html`<td class="mono" data-label="Coding change">${row.c ?? ''}</td>` : ''}
      <td class="mono" data-label="Protein change">${row.p ?? ''}${row.differs ? html` <span class="sr-badge sr-badge--warn">numbered differently</span>` : ''}</td></tr>`)}</tbody></table></div>`;
}

function genomeTable(r) {
  const alleles = r.alleles ?? [];
  const g = r.genomic ?? {};
  const items = [];
  if (alleles.length) {
    for (const a of alleles) items.push({ g38: a.id, g37: a.id37 });
  } else if (g.grch38 || g.grch37) {
    items.push({ g38: g.grch38, g37: g.grch37 });
  }
  if (!items.length) return '';
  const show = (v, approx) => (v
    ? html`<span class="mono">${v}</span>${approx ? html` <span class="sr-badge sr-badge--warn" title="Lifted by the nearest alignment block, not checked base by base">approximate</span>` : ''} ${copyBtn(v)}`
    : html`<span class="sr-na">not mapped</span>`);
  return html`<div class="sr-table-wrap"><table class="sr-table">
      <caption class="sr-sr-only">Genomic positions on both assemblies</caption>
      <thead><tr><th scope="col">GRCh38 (hg38)</th><th scope="col">GRCh37 (hg19)</th></tr></thead>
      <tbody>${items.map((x) => html`<tr><td data-label="GRCh38">${show(x.g38, g.grch38Approximate)}</td><td data-label="GRCh37">${show(x.g37, g.grch37Approximate)}</td></tr>`)}</tbody></table></div>
    <p class="sr-sub">IDs read chromosome-position-reference-alternate, on the forward strand.</p>`;
}

function notationsDetails(r) {
  const tx = transcriptTable(r);
  const gen = genomeTable(r);
  if (!tx && !gen) return '';
  const open = hasNote(r, MAPPING_WARN);
  return html`<div class="sr-row sr-row--wide"><details class="sr-more sr-notations"${open ? raw(' open') : ''}>
    <summary>All transcript notations${open ? html` <span class="sr-badge sr-badge--warn">numbering differs</span>` : ''}</summary>
    ${tx}${gen}</details></div>`;
}

function gnomadRow(r, releases, mismatch) {
  const alleles = r.alleles ?? [];
  const resid = r.residueAlleles ?? [];
  const names = new Set(alleles.map((a) => a.id));
  const others = resid.filter((a) => !names.has(a.id));
  const label = r.releases?.gnomad ?? releases?.gnomad?.label ?? 'gnomAD';
  let body;
  if (alleles.length) {
    body = allelesTable(alleles, { caption: `${label} alleles for this change` });
  } else if (mismatch) {
    body = ''; // the residue is not the one typed: do not claim anything about the typed change
  } else if (r.kind === 'missense' && r.alt) {
    body = html`<p>This exact change is not listed in ${label}.</p>
      <p>AlphaMissense prediction for it: not available in this index.${r.residue?.amMean != null ? html` The <strong>mean</strong> AlphaMissense prediction over all possible substitutions at this residue is <strong>${fmt2(r.residue.amMean)}</strong>.` : ''}</p>`;
  } else if (!resid.length) {
    body = html`<p>No ${label} missense allele at this residue.</p>`;
  } else body = '';
  const more = others.length
    ? html`<details class="sr-more"><summary>${alleles.length ? 'Other' : 'All'} ${others.length} ${label} missense allele${others.length === 1 ? '' : 's'} at this residue</summary>${allelesTable(others, { caption: `Other ${label} alleles at this residue` })}</details>`
    : '';
  return html`<div class="sr-row"><h4>${label}</h4><div>${body}${more}</div></div>`;
}

function clinvarRow(r, releases) {
  const recs = r.clinvar ?? [];
  const label = r.releases?.clinvar ?? releases?.clinvar?.label ?? 'ClinVar';
  const body = recs.length
    ? html`<ul class="sr-list">${recs.map((c) => html`<li>
        <a href="${c.url}" target="_blank" rel="noopener noreferrer">${c.accession}<span class="sr-sr-only"> (opens ClinVar in a new tab)</span></a>
        <span class="sr-badge">${c.classification}</span> ${stars(c.stars)}
        ${c.conditions?.length ? html`<div class="sr-sub">${c.conditions.join('; ')}</div>` : ''}
        <div class="sr-sub">${c.title}</div></li>`)}</ul>`
    : html`<p>No ClinVar record matches this query.</p>`;
  return html`<div class="sr-row"><h4>${label}</h4><div>${body}</div></div>`;
}

function factsRow(r) {
  const x = r.residue;
  if (!x) return '';
  const f = residueFacts(r);
  const cfr = x.cfr
    ? html`<strong>Yes</strong>, rank ${f.cfrRank} of the class-wide positions (the top 30 are CFRs).`
    : (f.cfrRank ? html`No. Rank ${f.cfrRank} of the class-wide positions, outside the top 30 that are CFRs.` : html`Not ranked: no generic number.`);
  const largest = f.dmax === null
    ? html`<span class="sr-na">no contacts</span>`
    : html`|ΔRRCS| ${f.dmax.toFixed(2)}${f.threshold !== null ? html`<span class="sr-sub">, receptor threshold ${f.threshold.toFixed(2)}</span>` : ''}${f.partner ? html`<span class="sr-sub">, with ${f.partner}</span>` : ''}`;
  const cell = (k, v) => html`<div class="sr-fact"><dt>${k}</dt><dd>${v}</dd></div>`;
  return html`<div class="sr-row"><h4>In this database</h4><div><dl class="sr-facts">
    ${cell('Core functional residue (CFR), class-wide', cfr)}
    ${cell('Largest contact change', largest)}
    ${f.net !== null ? cell('Net ΔRRCS over this residue\u2019s contacts', netHtml(f.net)) : ''}
    ${cell('Contacts above this receptor’s threshold', f.nsig ?? 0)}
    ${cell('Conservation', f.conservation === null ? html`<span class="sr-na">not available</span>` : html`${f.conservation.toFixed(2)} <span class="sr-sub">on a 0 to 1 scale</span>`)}
    ${cell('AlphaMissense prediction, residue mean', f.amMean === null ? html`<span class="sr-na">not available</span>` : html`${f.amMean.toFixed(2)} <span class="sr-sub">mean over all substitutions</span>`)}
    ${cell('Numbering', html`${x.generic ? html`<span class="mono">${x.generic}</span> ` : ''}${x.bw ? html`<span class="sr-sub">BW ${x.bw}, GPCRdb ${x.gpcrdb}</span>` : html`<span class="sr-na">no generic number (outside the helices)</span>`}`)}
  </dl></div></div>`;
}

// --------------------------------------------------------------- copy buttons' text

/** Everything the "Copy all notations" button copies, as text. */
export function notationsText(r) {
  const out = [];
  out.push(`${recFull(r.receptor)} residue ${three(r.residue?.aa ?? r.ref)}${r.pos}${r.residue?.generic ? ` (${r.residue.generic}, ${r.residue.segment})` : ''}`);
  if (r.alt && r.kind === 'missense') out.push(`${hgvsP(r)} (${r.ref}${r.pos}${r.alt})`);
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
  return out.join('\n');
}

/** Release labels as plain text lines, for the evidence summary. */
function releaseLines(r, rel) {
  const l = (k) => rel?.[k]?.label;
  const bits = [r.releases?.gnomad ?? l('gnomad'), r.releases?.clinvar ?? l('clinvar'),
    rel?.ensembl ? `${l('ensembl')} (${rel.ensembl.grch38}, ${rel.ensembl.grch37})` : null,
    l('refseq'), l('alphamissense'), l('hgnc'), l('uniprot'), l('database')].filter(Boolean);
  return [...new Set(bits)];
}

/**
 * A plain-text evidence block for one result: what was typed and how it was read, the residue
 * and change, every notation with its transcript version, both assemblies (approximate lifts
 * flagged), alleles, ClinVar, the database's own facts, warnings, data releases and a link that
 * reproduces the search. ASCII-friendly, one fact per line, pasteable into notes or a report.
 *
 * @param {object} r a result
 * @param {{query?: string, reading?: string|null, interp?: object, releases?: object, pageUrl?: string}} [ctx]
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
  if (r.pos) {
    L.push(`Residue: ${three(x?.aa ?? r.ref)}${r.pos} (model numbering, the numbering of the report)${x?.generic ? `; generic number ${x.generic}; ${x.segment}` : ''}`);
    if (r.alt) L.push(`Change: ${r.kind === 'missense' ? `${hgvsP(r)} (${r.ref}${r.pos}${r.alt})` : hgvsP(r)}; ${kindLabel(r.kind).toLowerCase()}`);
  }
  const tv = r.transcriptViews ?? [];
  if (tv.length) {
    L.push('Transcript notations:');
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
      L.push(`  ${a.id} ${a.hgvsc ?? ''} ${a.hgvsp ?? ''}; ${a.rsids?.length ? a.rsids.join(', ') : 'no rsID'}; allele count ${fmtInt(a.ac)} of ${fmtInt(a.an)}; allele frequency ${fmtAf(a.af)}; homozygotes ${fmtInt(a.hom)}; AlphaMissense prediction ${a.am == null ? 'not available' : `${a.am.toFixed(2)}${a.amClass ? ` (${a.amClass})` : ''}`}`.replace(/\s+;/g, ';'));
    }
  } else if (r.alt && r.kind === 'missense') {
    L.push(`${gl}: this exact change is not listed.`);
  }
  const nOther = (r.residueAlleles ?? []).filter((a) => !alleles.some((b) => b.id === a.id)).length;
  if (nOther) L.push(`${gl}: ${nOther} other missense allele${nOther === 1 ? '' : 's'} at this residue.`);
  const cl = r.releases?.clinvar ?? ctx.releases?.clinvar?.label ?? 'ClinVar';
  if ((r.clinvar ?? []).length) {
    L.push(`${cl} records:`);
    for (const c of r.clinvar) L.push(`  ${c.accession}: ${c.classification}, ${c.stars ?? 0} of 4 review stars${c.conditions?.length ? `; ${c.conditions.join('; ')}` : ''}; ${c.url}`);
  } else L.push(`${cl}: no record matches this query.`);
  if (x) {
    L.push('In this database:');
    L.push(`  Core functional residue (class-wide): ${x.cfr ? `yes, rank ${f.cfrRank} of the class-wide positions` : (f.cfrRank ? `no, its generic position ranks ${f.cfrRank}` : 'not ranked (no generic number)')}`);
    L.push(`  Largest contact change: ${f.dmax === null ? 'no contacts' : `|dRRCS| ${f.dmax.toFixed(2)}${f.threshold !== null ? `, receptor threshold ${f.threshold.toFixed(2)}` : ''}${f.partner ? `, with ${f.partner}` : ''}`}`);
    if (f.net !== null) L.push(`  Net dRRCS: ${signed(f.net, 1)} (${direction(f.net).word}; red = active, blue = inactive)`);
    L.push(`  Contacts above this receptor's threshold: ${f.nsig ?? 0}`);
    L.push(`  Conservation: ${f.conservation === null ? 'not available' : `${f.conservation.toFixed(2)} on a 0 to 1 scale`}`);
    L.push(`  AlphaMissense prediction, residue mean: ${f.amMean === null ? 'not available' : f.amMean.toFixed(2)}`);
  }
  if ((r.notes ?? []).length) {
    L.push('Warnings and notes:');
    for (const n of r.notes) L.push(`  ${WARN_NOTES.has(n.code) ? 'Warning: ' : ''}${n.text}`);
  }
  const rl = releaseLines(r, ctx.releases);
  if (rl.length) L.push(`Data releases: ${rl.join('; ')}`);
  L.push(`Search link: ${ctx.pageUrl ?? 'search/'}?q=${encodeURIComponent(q)}`);
  return L.join('\n');
}

// ---------------------------------------------------------------------------- actions & cards

/** True when the residue can appear in the report's variant table. */
export function inReportTable(r) {
  if (typeof r.inReportTable === 'boolean') return r.inReportTable;
  const d = residueFacts(r).dmax;
  return d !== null && d >= REPORT_TABLE_DELTA;
}

function actions(r, o, idx, mismatch) {
  const gid = r.gid;
  const res = r.pos ? `${o.reports}${gid}.html#sec=sec-snake&res=${r.pos}` : `${o.reports}${gid}.html`;
  const first = (r.alleles ?? [])[0];
  const vq = first?.hgvsp ?? (r.alt && r.kind === 'missense' ? hgvsP(r) : null);
  const hasAlleles = (r.alleles ?? []).length > 0;
  const canFind = !mismatch && vq && hasAlleles && inReportTable(r);
  const dmax = residueFacts(r).dmax;
  const why = !mismatch && vq && hasAlleles && !canFind
    ? html`<p class="sr-action-note">Not in the report’s variant table: it lists variants at residues with a contact change of |ΔRRCS| ${REPORT_TABLE_DELTA.toFixed(1)} or more, and ${dmax === null ? 'this residue has no contact change' : `this residue’s largest is ${dmax.toFixed(2)}`}.</p>`
    : '';
  return html`<div class="sr-actions">
    <a class="btn btn-primary btn-sm" href="${res}">${r.pos ? 'Open report at this residue' : 'Open report'}</a>
    ${canFind ? html`<a class="btn btn-ghost btn-sm" href="${o.reports}${gid}.html#sec=sec-variants&vq=${encodeURIComponent(vq)}">Find in the report's variant table</a>` : ''}
    <a class="btn btn-ghost btn-sm" href="${o.studio}?db=${encodeURIComponent(gid)}">Open in Studio</a>
    ${r.pos ? html`<button type="button" class="btn btn-ghost btn-sm" data-copy-notations="${idx}">Copy all notations</button>
    <button type="button" class="btn btn-ghost btn-sm" data-copy-evidence="${idx}">Copy evidence summary</button>` : ''}
    ${why}
  </div>`;
}

function notesBlock(notes) {
  if (!notes?.length) return '';
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

function changeLine(r, fix) {
  if (!r.pos) return html`<span class="sr-badge sr-badge--muted">${kindLabel(r.kind)}</span>`;
  if (r.type === 'not_coding') return html`<span class="sr-change-main">Not a coding residue</span> <span class="sr-badge">outside the coding sequence</span>`;
  if (fix) return html`<span class="sr-change-main mono">${fix.typed}</span> <span class="sr-badge sr-badge--warn">typed residue does not match</span>`;
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

function badgesFor(r) {
  const b = [];
  if (r.residue?.cfr) b.push(html`<span class="sr-badge sr-badge--cfr" title="Core functional residue: one of the 30 top-ranked class-wide generic positions">CFR, rank ${residueFacts(r).cfrRank} of the class-wide positions</span>`);
  if (r.notes?.some((n) => n.code === 'model_conflict')) b.push(html`<span class="sr-badge sr-badge--warn">model differs from reference genome</span>`);
  return b;
}

function card(r, o, idx) {
  const x = r.residue;
  const rec = r.receptor;
  const reportHref = `${o.reports}${r.gid}.html`;
  const title = html`<a href="${reportHref}">${recFull(rec)}</a>`;
  const fix = mismatchFix(r, o);
  const mismatch = !!fix || hasNote(r, 'reference_mismatch');
  const noResidue = !r.pos && r.type === 'not_in_resource'; // e.g. an unknown transcript version: nothing to show but the note
  const status = r.type === 'not_in_resource' && !mismatch && !noResidue ? html`<span class="sr-badge sr-badge--muted">not analysed here</span>` : '';
  return html`<article class="sr-card sr-card--${r.type}" aria-labelledby="sr-card-${idx}">
    <header class="sr-card-head">
      <h3 id="sr-card-${idx}" class="sr-card-title">${title}${r.pos ? html`<span class="sr-dot" aria-hidden="true">·</span><span class="mono">${three(r.residue?.aa ?? r.ref)}${r.pos}</span>` : ''}${x?.generic ? html`<span class="sr-dot" aria-hidden="true">·</span><span class="mono" title="Generic residue number">${x.generic}</span>` : ''}${x?.segment ? html`<span class="sr-dot" aria-hidden="true">·</span><span class="sr-nowrap">${x.segment}</span>` : ''}</h3>
      ${noResidue ? '' : html`<div class="sr-change">${changeLine(r, fix)} ${status} ${badgesFor(r)}</div>`}
    </header>
    ${leadLine(r, o)}
    ${notesBlock(r.notes)}
    ${fixBlock(fix, o)}
    ${noResidue ? '' : html`${r.type === 'not_coding' || r.type === 'not_in_resource' && !r.residue ? '' : gnomadRow(r, o.releases, mismatch)}
    ${clinvarRow(r, o.releases)}
    ${factsRow(r)}
    ${notationsDetails(r)}`}
    ${actions(r, o, idx, mismatch)}
  </article>`;
}

function receptorCard(r, o, idx) {
  const rec = r.receptor;
  return html`<article class="sr-card sr-card--receptor" aria-labelledby="sr-card-${idx}">
    <header class="sr-card-head"><h3 id="sr-card-${idx}" class="sr-card-title"><a href="${o.reports}${r.gid}.html">${recFull(rec)}</a></h3>
    <div class="sr-change"><span class="sr-sub">${rec.name}</span></div></header>
    <div class="sr-row"><h4>Search inside this receptor</h4><div><ul class="sr-chips">
      ${[`${rec.symbol} 3.50`, `${rec.symbol} 6.48`, `${rec.symbol} 159`].map((q) => html`<li><a class="sr-chip" href="?q=${encodeURIComponent(q)}" data-q="${q}">${q}</a></li>`)}
    </ul><p class="sr-sub">Add a protein change, a residue number, a generic number or a coding change to the receptor name.</p></div></div>
    <div class="sr-actions"><a class="btn btn-primary btn-sm" href="${o.reports}${r.gid}.html">Open report</a>
    <a class="btn btn-ghost btn-sm" href="${o.studio}?db=${encodeURIComponent(r.gid)}">Open in Studio</a></div>
  </article>`;
}

// -------------------------------------------------------------------- the comparison table

export const CMP_PAGE_SIZE = 25;

function topClinvar(r) {
  const rec = (r.clinvar ?? [])[0];
  return rec ? `${rec.classification}${(r.clinvar.length > 1 ? ` (+${r.clinvar.length - 1})` : '')}` : '';
}

/** Compact table for a list of receptors with nothing to compare (names and accessions). */
export function renderReceptorList(rs, o) {
  return html`<div class="sr-table-wrap"><table class="sr-table sr-table--multi">
    <caption class="sr-sr-only">${rs.length} receptors</caption>
    <thead><tr><th scope="col">Receptor</th><th scope="col">UniProt</th><th scope="col">Name</th><th scope="col">Open</th></tr></thead>
    <tbody>${rs.map((r) => html`<tr>
      <td data-label="Receptor"><a href="?q=${encodeURIComponent(r.receptor.symbol)}" data-q="${r.receptor.symbol}">${recShort(r.receptor)}</a></td>
      <td data-label="UniProt"><span class="mono">${r.receptor.uniprot ?? ''}</span></td>
      <td data-label="Name">${r.receptor.name ?? ''}</td>
      <td data-label="Open"><a href="${o.reports}${r.gid}.html">Report</a></td></tr>`)}</tbody></table></div>`;
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
    case 'rec': return html`<a href="?q=${encodeURIComponent(row.query)}" data-q="${row.query}" title="Details for ${row.query}">${recShort(row.r.receptor)}</a> <a class="sr-sub sr-reportlink" href="${o.reports ?? ''}${row.gid}.html${row.r.pos ? `#sec=sec-snake&res=${row.r.pos}` : ''}">report</a>`;
    case 'res': return html`<span class="mono">${row.res}</span>${row.departs ? html` <span class="sr-badge sr-badge--warn" title="This residue is not the one the motif name fixes">not the motif residue</span>` : ''}`;
    case 'gen': return row.generic ? html`<span class="mono">${row.generic}</span>` : html`<span class="sr-na">none</span>`;
    case 'net': return f.net === null ? html`<span class="sr-na">none</span>` : netHtml(f.net, { word: false });
    case 'dmax': {
      if (f.dmax === null) return html`<span class="sr-na">none</span>`;
      const d = direction(f.dmaxSigned);
      return html`<span class="${d ? `sr-net sr-net--${d.cls}` : ''}">${f.dmax.toFixed(1)}</span>${d ? html`<span class="sr-sr-only"> (${d.word})</span>` : ''}${f.partner ? html` <span class="sr-sub">with <span class="sr-notation">${f.partner}</span></span>` : ''}`;
    }
    case 'nsig': return f.nsig === null ? html`<span class="sr-na">none</span>` : String(f.nsig);
    case 'cfr': return f.cfrRank === null ? html`<span class="sr-na">none</span>` : html`${f.cfrRank}${f.cfr ? html` <span class="sr-badge sr-badge--cfr" title="One of the 30 top-ranked class-wide generic positions">CFR</span>` : ''}`;
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
    ${model.motif ? html`<p class="sr-motif"><strong>${model.motif.name}</strong>${model.motif.positions?.length ? html`<span class="sr-sub">, generic positions ${model.motif.positions.join(', ')}</span>` : ''}${model.motif.note ? html`. ${model.motif.note}` : ''}</p>` : ''}
    ${model.filterNote ? html`<p class="sr-filter-note">${model.filterNote}</p>` : ''}
    ${model.groups && model.groups.length > 1 ? html`<div class="sr-groups" role="group" aria-label="Show"><span class="sr-label">Show</span>
      <button type="button" class="sr-seg" data-cmp-group="" aria-pressed="${state.group === '' ? 'true' : 'false'}">All <span class="sr-sub">${model.rows.length}</span></button>
      ${model.groups.map((g) => html`<button type="button" class="sr-seg" data-cmp-group="${g.key}" aria-pressed="${state.group === g.key ? 'true' : 'false'}" title="${g.label}">${String(g.label).split(':')[0]} <span class="sr-sub">${g.n}</span></button>`)}</div>
      ${model.motif && model.groups.some((g) => String(g.label).includes(':')) ? html`<ul class="sr-motif-notes">${model.groups.map((g) => html`<li>${g.label}</li>`)}</ul>` : ''}` : ''}
    <div class="sr-cmp-controls">
      ${model.families.length > 1 ? html`<label class="sr-cmp-field">Family
        <select class="v2-select" data-cmp-family><option value="">All families (${model.rows.length})</option>${model.families.map(([name, n]) => html`<option value="${name}"${state.family === name ? raw(' selected') : ''}>${name} (${n})</option>`)}</select></label>` : ''}
      <div class="sr-cmp-sort"><label class="sr-cmp-field">Sort by
        <select class="v2-select" data-cmp-sortsel><option value="orig"${state.sort === 'orig' ? raw(' selected') : ''}>Original order</option>${sortable.map((c) => html`<option value="${c.key}"${state.sort === c.key ? raw(' selected') : ''}>${c.label}</option>`)}</select></label>
        <button type="button" class="btn btn-ghost btn-sm" data-cmp-dir${state.sort === 'orig' ? raw(' disabled') : ''} aria-label="Sort direction: ${state.dir === 'desc' ? 'high to low' : 'low to high'}. Press to reverse.">${state.dir === 'desc' ? 'High to low' : 'Low to high'}</button></div>
      <button type="button" class="btn btn-ghost btn-sm sr-cmp-csv" data-cmp-csv>Download CSV</button>
    </div>
    ${model.hasSummary ? html`<p class="sr-sub sr-legend">Net ΔRRCS: <span class="sr-net sr-net--active">red, positive</span> means stronger in the active model; <span class="sr-net sr-net--inactive">blue, negative</span> means stronger in the inactive model. Thresholds are set per receptor, so compare ranks and directions rather than raw sizes.</p>` : ''}
    <div data-cmp-body>${renderCompareBody(model, state, o)}</div>
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

const csvField = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

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

const HELP = [
  ['Protein change', ['F2RL1 p.Met159Ile', 'PAR2 M159I', 'M159I', 'ADRB2 Arg16Gly']],
  ['Residue', ['F2RL1 Met159', 'PAR2 159']],
  ['Coding DNA', ['NM_005242.6:c.477G>A', 'ENST00000296677.5:c.477G>A', 'F2RL1 c.477G>A']],
  ['Genome (GRCh38 or GRCh37)', ['5-76833084-G-A', '5-76128909-G-A', 'chr5:76833084', 'NC_000005.10:g.76833084G>A']],
  ['Database IDs', ['rs115885685', 'VCV000718860']],
  ['Generic residue number', ['3.50x50', 'PAR2 6.48', 'R3.50']],
  ['Motif', ['DRY', 'NPxxY in PAR2', 'toggle switch']],
  ['Receptor name or ID', ['PAR2', 'F2RL1', 'P55085', 'β2AR']],
];

export function renderHelp(o = {}) {
  return html`<div class="sr-help"><h2 class="sr-h2">You can search like this</h2>
    <p class="sr-sub">Any of these forms works, with or without a receptor name. Click an example to try it.</p>
    <dl class="sr-help-list">${HELP.map(([k, ex]) => html`<div><dt>${k}</dt><dd><ul class="sr-chips">${ex.map((q) => html`<li><a class="sr-chip" href="?q=${encodeURIComponent(q)}" data-q="${q}">${q}</a></li>`)}</ul></dd></div>`)}</dl></div>`;
}

export function renderReleases(rel) {
  if (!rel) return '';
  const l = (k) => rel[k]?.label;
  const ens = rel.ensembl ? `${l('ensembl')} (${rel.ensembl.grch38}, ${rel.ensembl.grch37})` : null;
  const bits = [l('gnomad'), l('clinvar'), ens, l('alphamissense'), l('hgnc'), l('uniprot')].filter(Boolean);
  return html`<p class="sr-releases"><strong>Data in this search:</strong> ${bits.join('; ')}. Coordinates are given on GRCh38 and GRCh37.</p>
    <p class="sr-releases">Search uses newer variant data than the variant tables on the report pages. The report tables list gnomAD v4.1.0 missense variants at residues with at least one contact change of |ΔRRCS| ≥ 3.0; search covers every gnomAD v4.1.2 missense allele and ClinVar 2026-10-11. Where the two differ, the search result is the more recent.</p>`;
}

// -------------------------------------------------------------------------------- main entry

/**
 * @param {object} answer engine answer
 * @param {string} query what was typed
 * @param {{reports: string, studio: string, releases?: object, symbolOf?: (gid:string)=>string,
 *          familyOf?: (gid:string)=>string, pageUrl?: string, base?: string}} o
 * @returns {{html: string, status: string, results: object[], compare: object|null, ctx: object}}
 *   `results` are the cards' results (index = the data-copy-* number); `compare` is the model of the
 *   cross-receptor table when one was drawn; `ctx` is what evidenceText() needs.
 */
export function renderAnswer(answer, query, o) {
  const base = o.base ?? '';
  const rs = answer.results ?? [];
  const reading = readAsText(answer, query);
  const statusBits = [];
  let out = '';
  const ro = { ...o, interp: answer.interpretation, query, typed: answer.typed ?? null, alternates: answer.alternates ?? [] };
  const ctx = { query, reading, interp: answer.interpretation, releases: o.releases, pageUrl: o.pageUrl };

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
  if (answer.message && !dup && !answer.filterNote) {
    const level = answer.expect === 'unrecognised' || (answer.expect === 'not_in_resource' && !rs.length) ? 'sr-message--stop' : 'sr-message--info';
    out += html`<div class="sr-message ${level}" role="note" data-expect="${answer.expect}"><span class="sr-sr-only">${answer.expect === 'unrecognised' ? 'Could not read the query. ' : ''}</span>${answer.message}</div>`.s;
  }

  let compare = null;
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
      const motif = answer.motif ? html`<p class="sr-motif"><strong>${answer.motif.name}</strong>${answer.motif.positions?.length ? html`<span class="sr-sub">, generic positions ${answer.motif.positions.join(', ')}</span>` : ''}${answer.motif.note ? html`. ${answer.motif.note}` : ''}</p>` : '';
      out += html`<section class="sr-results" aria-label="Results">${motif}${rs.map((r, i) => (r.type === 'receptor' ? receptorCard(r, ro, i) : card(r, ro, i)))}</section>`.s;
    }
  } else {
    statusBits.push('No result');
  }

  if (!rs.length || answer.expect === 'unrecognised') out += renderHelp(o).s;
  return { html: out, status: statusBits.join(', '), results: rs, compare, ctx };
}
