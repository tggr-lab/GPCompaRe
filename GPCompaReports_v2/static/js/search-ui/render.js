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

const WARN_NOTES = new Set([
  'model_conflict', 'reference_swap', 'reference_mismatch', 'version_mismatch', 'typed_residue_differs',
  'generic_number_differs', 'offset_mapping', 'isoform_mapping', 'liftover_approximate', 'no_coding_transcript', 'outside_model',
]);

// ------------------------------------------------------------------------ query text builders

/** The query string that reproduces one result (used by "Details" links and "Did you mean"). */
export function queryFor(r, interp) {
  const sym = r.receptor?.symbol ?? r.gid;
  if (r.type === 'receptor') return sym;
  if (r.light && interp?.generic) return `${sym} ${interp.generic.display ?? ''}`.trim();
  if (r.alt && r.kind === 'missense') return `${sym} ${hgvsP(r)}`;
  if (r.pos) return `${sym} ${three(r.ref)}${r.pos}`;
  return sym;
}

/** Link target for an alternate ("Did you mean"). */
export function alternateQuery(a, symbolOf, interp) {
  const sym = a.gid && a.gid !== '*' ? (symbolOf?.(a.gid) ?? a.gid) : '';
  switch (a.kind) {
    case 'receptor': return sym || a.display || a.label;
    case 'change': return `${sym} p.${three(a.ref)}${a.pos}${three(a.alt)}`.trim();
    case 'residue': return `${sym} ${three(a.ref ?? a.aa)}${a.pos}`.trim();
    case 'generic': return a.display;
    case 'clinvar': return `VCV${String(a.id).padStart(9, '0')}`;
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
      parts.push(`generic residue number ${g.display}`);
      if (sameRec && first.pos) parts[1] = `residue ${three(first.ref)}${first.pos} at generic number ${first.residue?.generic || g.display}`;
      return parts.join(', ');
    }
    default:
      return null;
  }
  return parts.join(', ');
}

function alternatesBlock(answer, symbolOf, base) {
  const interp = answer.interpretation;
  const alts = answer.alternates ?? [];
  if (!alts.length) return '';
  return html`<div class="sr-did-you-mean"><span class="sr-label">Did you mean</span>
    <ul class="sr-alt-list">${alts.map((a) => {
      const q = alternateQuery(a, symbolOf, interp);
      return html`<li><a href="${base}?q=${encodeURIComponent(q)}" data-q="${q}">${a.label ?? q}</a></li>`;
    })}</ul></div>`;
}

// ---------------------------------------------------------------------------------- the cards

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
    <thead><tr><th scope="col">gnomAD allele</th><th scope="col">Change</th><th scope="col">rsID</th><th scope="col" class="num">Allele count</th><th scope="col" class="num">Frequency</th><th scope="col" class="num">Homozygotes</th><th scope="col">AlphaMissense</th></tr></thead>
    <tbody>${alleles.map((a) => html`<tr>
      <td class="mono" data-label="gnomAD allele">${a.id}</td>
      <td data-label="Change">${a.hgvsc ?? ''}${a.hgvsc ? html`<br>` : ''}<span class="sr-sub">${a.hgvsp ?? ''}</span>${a.conflict ? html` <span class="sr-badge sr-badge--warn" title="The model has the other residue here">model differs</span>` : ''}</td>
      <td class="mono" data-label="rsID">${a.rsids?.length ? a.rsids.join(', ') : 'none'}</td>
      <td class="num" data-label="Allele count">${fmtInt(a.ac)}<span class="sr-sub"> of ${fmtInt(a.an)}</span></td>
      <td class="num" data-label="Frequency">${fmtAf(a.af)}</td>
      <td class="num" data-label="Homozygotes">${fmtInt(a.hom)}</td>
      <td data-label="AlphaMissense">${amCell(a)}</td></tr>`)}</tbody></table></div>`;
}

function transcriptGroups(r) {
  const tv = r.transcriptViews ?? [];
  if (!tv.length) return '';
  const anyC = tv.some((t) => t.c);
  const firstAllele = tv.find((t) => t.allele)?.allele ?? '';
  const keyOf = (t) => t.allele ?? firstAllele;
  const alleleKeys = [...new Set(tv.map(keyOf))];
  const maneP = (key) => tv.find((x) => x.role === 'mane' && keyOf(x) === key)?.p;
  // one row per transcript view; with several alleles each cell lists them in the same order
  const rows = [];
  for (const t of tv) {
    const k = `${t.transcript}|${t.protein ?? ''}`;
    let row = rows.find((x) => x.k === k);
    if (!row) { row = { k, t, roles: [], cs: [], ps: [], differs: false }; rows.push(row); }
    if (!row.roles.includes(t.role)) row.roles.push(t.role);
    const idx = alleleKeys.indexOf(keyOf(t));
    row.cs[idx] = t.c ?? '';
    row.ps[idx] = t.p ?? '';
    const mp = maneP(keyOf(t));
    if (mp && t.p && t.p !== mp) row.differs = true;
  }
  const list = (arr) => {
    const vals = alleleKeys.map((_, i) => arr[i] ?? '');
    const uniq = [...new Set(vals.filter(Boolean))];
    return uniq.length <= 1 ? (uniq[0] ?? '') : html`${vals.map((v) => html`<div>${v}</div>`)}`;
  };
  return html`<div class="sr-row"><h4>Transcripts</h4><div>
    <div class="sr-table-wrap"><table class="sr-table sr-table--tx">
    <caption class="sr-sr-only">The change on each transcript</caption>
    <thead><tr><th scope="col">View</th><th scope="col">Transcript</th><th scope="col">Protein</th>${anyC ? html`<th scope="col">Coding change</th>` : ''}<th scope="col">Protein change</th></tr></thead>
    <tbody>${rows.map((row) => html`<tr><td data-label="View">${row.roles.map((x) => ROLE_LABEL[x] ?? x).join(', ')}</td>
      <td class="mono" data-label="Transcript">${row.t.transcript}</td><td class="mono" data-label="Protein">${row.t.protein ?? ''}</td>
      ${anyC ? html`<td class="mono" data-label="Coding change">${list(row.cs)}</td>` : ''}
      <td class="mono" data-label="Protein change">${list(row.ps)}${row.differs ? html` <span class="sr-badge sr-badge--warn">numbered differently</span>` : ''}</td></tr>`)}</tbody></table></div>
    ${alleleKeys.length > 1 ? html`<p class="sr-sub">Several alleles give this change. Their coding changes are listed in the order ${alleleKeys.filter(Boolean).join(', ')}.</p>` : ''}</div></div>`;
}

function genomicRows(r) {
  const alleles = r.alleles ?? [];
  const items = [];
  if (alleles.length) {
    for (const a of alleles) items.push({ g38: a.id, g37: a.id37 });
  } else if (r.genomic && (r.genomic.grch38 || r.genomic.grch37)) {
    items.push({ g38: r.genomic.grch38, g37: r.genomic.grch37 });
  }
  if (!items.length) return '';
  const show = (v) => (v ? html`<span class="mono">${v}</span> ${copyBtn(v)}` : html`<span class="sr-na">not mapped</span>`);
  return html`<div class="sr-row"><h4>Genome position</h4><div>
    <div class="sr-table-wrap"><table class="sr-table">
      <caption class="sr-sr-only">Genomic positions on both assemblies</caption>
      <thead><tr><th scope="col">GRCh38 (hg38)</th><th scope="col">GRCh37 (hg19)</th></tr></thead>
      <tbody>${items.map((x) => html`<tr><td data-label="GRCh38">${show(x.g38)}</td><td data-label="GRCh37">${show(x.g37)}</td></tr>`)}</tbody></table></div>
    <p class="sr-sub">IDs read chromosome-position-reference-alternate, on the forward strand.</p></div></div>`;
}

function gnomadRow(r, releases) {
  const alleles = r.alleles ?? [];
  const resid = r.residueAlleles ?? [];
  const names = new Set(alleles.map((a) => a.id));
  const others = resid.filter((a) => !names.has(a.id));
  const label = r.releases?.gnomad ?? releases?.gnomad?.label ?? 'gnomAD';
  let body;
  if (alleles.length) {
    body = allelesTable(alleles, { caption: `${label} alleles for this change` });
  } else if (r.kind === 'missense' && r.alt) {
    body = html`<p>This exact change is not listed in ${label}.</p>
      <p>AlphaMissense score for it: not available in this index.${r.residue?.amMean != null ? html` The <strong>mean</strong> AlphaMissense score over all possible substitutions at this residue is <strong>${fmt2(r.residue.amMean)}</strong>.` : ''}</p>`;
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
  const cfr = x.cfr
    ? html`<strong>Yes.</strong> A core functional residue (CFR), rank ${x.cfrRank} of the generic positions.`
    : (x.cfrRank ? html`No. Its generic position ranks ${x.cfrRank}, outside the top 30 core functional residues (CFRs).` : html`No generic number, so not ranked as a core functional residue (CFR).`);
  const cell = (k, v) => html`<div class="sr-fact"><dt>${k}</dt><dd>${v}</dd></div>`;
  return html`<div class="sr-row"><h4>In this database</h4><div><dl class="sr-facts">
    ${cell('Core functional residue', cfr)}
    ${cell('Largest contact change', x.dmax == null ? html`<span class="sr-na">no contacts</span>` : html`|ΔRRCS| ${x.dmax.toFixed(2)}`)}
    ${cell('Contacts above threshold', x.nsig ?? 0)}
    ${cell('Conservation', x.conservation == null ? html`<span class="sr-na">not available</span>` : html`${x.conservation.toFixed(2)} <span class="sr-sub">0 variable, 1 conserved</span>`)}
    ${cell('AlphaMissense, residue mean', x.amMean == null ? html`<span class="sr-na">not available</span>` : html`${x.amMean.toFixed(2)} <span class="sr-sub">mean over all substitutions</span>`)}
    ${cell('Numbering', html`${x.generic ? html`<span class="mono">${x.generic}</span> ` : ''}${x.bw ? html`<span class="sr-sub">BW ${x.bw}, GPCRdb ${x.gpcrdb}</span>` : html`<span class="sr-na">no generic number (outside the helices)</span>`}`)}
  </dl></div></div>`;
}

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

function actions(r, o, idx) {
  const gid = r.gid;
  const res = r.pos ? `${o.reports}${gid}.html#sec=sec-snake&res=${r.pos}` : `${o.reports}${gid}.html`;
  const first = (r.alleles ?? [])[0];
  const vq = first?.hgvsp ?? (r.alt && r.kind === 'missense' ? hgvsP(r) : null);
  return html`<div class="sr-actions">
    <a class="btn btn-primary btn-sm" href="${res}">${r.pos ? 'Open report at this residue' : 'Open report'}</a>
    ${vq && (r.alleles ?? []).length ? html`<a class="btn btn-ghost btn-sm" href="${o.reports}${gid}.html#sec=sec-variants&vq=${encodeURIComponent(vq)}">Find in the report's variant table</a>` : ''}
    <a class="btn btn-ghost btn-sm" href="${o.studio}?db=${encodeURIComponent(gid)}">Open in Studio</a>
    ${r.pos ? html`<button type="button" class="btn btn-ghost btn-sm" data-copy-notations="${idx}">Copy all notations</button>` : ''}
  </div>`;
}

function notesBlock(notes) {
  if (!notes?.length) return '';
  return html`<ul class="sr-notes">${notes.map((n) => html`<li class="sr-note ${WARN_NOTES.has(n.code) ? 'sr-note--warn' : 'sr-note--info'}" data-code="${n.code}"><span class="sr-sr-only">Note: </span>${n.text}</li>`)}</ul>`;
}

function changeLine(r) {
  if (!r.pos) return html`<span class="sr-badge sr-badge--muted">${kindLabel(r.kind)}</span>`;
  if (r.type === 'not_coding') return html`<span class="sr-change-main">Not a coding residue</span> <span class="sr-badge">outside the coding sequence</span>`;
  if (r.alt && r.kind === 'missense') {
    return html`<span class="sr-change-main mono">${hgvsP(r)}</span> <span class="sr-sub">(${r.ref}${r.pos}${r.alt})</span> <span class="sr-badge">${kindLabel(r.kind)}</span>`;
  }
  if (r.alt) return html`<span class="sr-change-main mono">${hgvsP(r)}</span> <span class="sr-badge">${kindLabel(r.kind)}</span>`;
  return html`<span class="sr-change-main">Residue ${three(r.residue?.aa ?? r.ref)}${r.pos}</span>`;
}

function badgesFor(r) {
  const b = [];
  if (r.residue?.cfr) b.push(html`<span class="sr-badge sr-badge--cfr" title="Core functional residue: a generic position where the contact change recurs across receptors">CFR, rank ${r.residue.cfrRank}</span>`);
  if (r.notes?.some((n) => n.code === 'model_conflict')) b.push(html`<span class="sr-badge sr-badge--warn">model differs from reference genome</span>`);
  return b;
}

function card(r, o, idx) {
  const x = r.residue;
  const rec = r.receptor;
  const reportHref = `${o.reports}${r.gid}.html`;
  const title = html`<a href="${reportHref}">${recFull(rec)}</a>`;
  const status = r.type === 'not_in_resource' ? html`<span class="sr-badge sr-badge--muted">not analysed here</span>` : '';
  return html`<article class="sr-card sr-card--${r.type}" aria-labelledby="sr-card-${idx}">
    <header class="sr-card-head">
      <h3 id="sr-card-${idx}" class="sr-card-title">${title}${r.pos ? html`<span class="sr-dot" aria-hidden="true">·</span><span class="mono sr-nowrap">${three(r.residue?.aa ?? r.ref)}${r.pos}</span>` : ''}${x?.generic ? html`<span class="sr-dot" aria-hidden="true">·</span><span class="mono sr-nowrap" title="Generic residue number">${x.generic}</span>` : ''}${x?.segment ? html`<span class="sr-dot" aria-hidden="true">·</span><span class="sr-nowrap">${x.segment}</span>` : ''}</h3>
      <div class="sr-change">${changeLine(r)} ${status} ${badgesFor(r)}</div>
    </header>
    ${notesBlock(r.notes)}
    ${transcriptGroups(r)}
    ${genomicRows(r)}
    ${r.type === 'not_coding' || r.type === 'not_in_resource' && !r.residue ? '' : gnomadRow(r, o.releases)}
    ${clinvarRow(r, o.releases)}
    ${factsRow(r)}
    ${actions(r, o, idx)}
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

// --------------------------------------------------------------------------------- the table

function topClinvar(r) {
  const rec = (r.clinvar ?? [])[0];
  return rec ? `${rec.classification}${(r.clinvar.length > 1 ? ` (+${r.clinvar.length - 1})` : '')}` : '';
}

const COLS = [
  { key: 'rec', label: 'Receptor', num: false },
  { key: 'res', label: 'Residue', num: true },
  { key: 'gen', label: 'Generic number', num: false },
  { key: 'seg', label: 'Segment', num: false },
  { key: 'gnomad', label: 'gnomAD alleles', num: true },
  { key: 'cv', label: 'ClinVar', num: false },
  { key: 'cfr', label: 'CFR', num: true },
  { key: 'dmax', label: 'Largest |ΔRRCS|', num: true },
];

export function renderTable(rs, interp, o) {
  const light = rs.every((r) => r.light || r.type === 'receptor');
  const receptorsOnly = rs.every((r) => r.type === 'receptor');
  const cols = receptorsOnly
    ? [{ key: 'rec', label: 'Receptor' }, { key: 'uni', label: 'UniProt' }, { key: 'nm', label: 'Name' }]
    : light ? COLS.slice(0, 2) : COLS;
  const cell = (r, k) => {
    const x = r.residue;
    switch (k) {
      case 'rec': return { v: r.receptor?.symbol ?? r.gid, h: html`<a href="?q=${encodeURIComponent(queryFor(r, interp))}" data-q="${queryFor(r, interp)}">${recShort(r.receptor)}</a>` };
      case 'uni': return { v: r.receptor.uniprot ?? '', h: html`<span class="mono">${r.receptor.uniprot ?? ''}</span>` };
      case 'nm': return { v: r.receptor.name ?? '', h: r.receptor.name ?? '' };
      case 'res': return { v: r.pos ?? 0, h: html`<span class="mono">${r.pos ? `${three(r.residue?.aa ?? r.ref)}${r.pos}` : ''}</span>` };
      case 'gen': return { v: x?.generic ?? '', h: x?.generic ? html`<span class="mono">${x.generic}</span>` : html`<span class="sr-na">none</span>` };
      case 'seg': return { v: x?.segment ?? '', h: x?.segment ?? '' };
      case 'gnomad': { const n = (r.alleles ?? []).reduce((s, a) => s + (a.ac ?? 0), 0); return { v: n, h: (r.alleles ?? []).length ? html`${r.alleles.length} <span class="sr-sub">(count ${fmtInt(n)})</span>` : html`<span class="sr-na">not seen</span>` }; }
      case 'cv': return { v: topClinvar(r), h: topClinvar(r) || html`<span class="sr-na">none</span>` };
      case 'cfr': return { v: x?.cfr ? x.cfrRank : 999, h: x?.cfr ? `rank ${x.cfrRank}` : html`<span class="sr-na">no</span>` };
      case 'dmax': return { v: x?.dmax ?? -1, h: x?.dmax == null ? html`<span class="sr-na">none</span>` : x.dmax.toFixed(2) };
      default: return { v: '', h: '' };
    }
  };
  return html`<div class="sr-table-wrap sr-table-wrap--wide"><table class="sr-table sr-table--multi" data-sortable>
    <caption class="sr-sr-only">${rs.length} receptors. Column headings are buttons that sort the table.</caption>
    <thead><tr>${cols.map((c, i) => html`<th scope="col" aria-sort="none" class="${c.num ? 'num' : ''}"><button type="button" data-sort-col="${i}">${c.label}</button></th>`)}<th scope="col">Open</th></tr></thead>
    <tbody>${rs.map((r) => {
      const cs = cols.map((c) => cell(r, c.key));
      const pos = r.pos ? `${o.reports}${r.gid}.html#sec=sec-snake&res=${r.pos}` : `${o.reports}${r.gid}.html`;
      return html`<tr>${cs.map((c, i) => html`<td data-v="${c.v}" data-label="${cols[i].label}" class="${cols[i].num ? 'num' : ''}">${c.h}</td>`)}
        <td data-label="Open"><a href="${pos}">Report</a></td></tr>`;
    })}</tbody></table></div>`;
}

// ------------------------------------------------------------------------------- help & footer

const HELP = [
  ['Protein change', ['F2RL1 p.Met159Ile', 'PAR2 M159I', 'M159I', 'ADRB2 Arg16Gly']],
  ['Residue', ['F2RL1 Met159', 'PAR2 159']],
  ['Coding DNA', ['NM_005242.6:c.477G>A', 'ENST00000296677.5:c.477G>A', 'F2RL1 c.477G>A']],
  ['Genome (GRCh38 or GRCh37)', ['5-76833084-G-A', '5-76128909-G-A', 'chr5:76833084', 'NC_000005.10:g.76833084G>A']],
  ['Database IDs', ['rs115885685', 'VCV000718860']],
  ['Generic residue number', ['3.50x50', 'PAR2 6.48', 'R3.50']],
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
 * @param {{reports: string, studio: string, releases?: object, symbolOf?: (gid:string)=>string, base?: string}} o
 * @returns {{html: string, status: string, results: object[]}}
 */
export function renderAnswer(answer, query, o) {
  const base = o.base ?? '';
  const rs = answer.results ?? [];
  const reading = readAsText(answer, query);
  const statusBits = [];
  let out = '';

  if (String(query ?? '').length > MAX_QUERY_LENGTH || answer.interpretation?.flags?.includes('query-truncated')) {
    out += html`<div class="sr-message sr-message--info" role="note">Only the first ${MAX_QUERY_LENGTH} characters were read.</div>`.s;
  }

  if (reading && !(answer.interpretation?.kind === 'receptor' && !rs.length)) {
    out += html`<section class="sr-read" aria-label="How the query was read"><p class="sr-read-line"><span class="sr-label">I read this as</span> <strong>${reading}</strong>${answer.assembly ? html` <span class="sr-badge">${answer.assembly}</span>` : ''}</p>
      ${alternatesBlock(answer, o.symbolOf, base)}</section>`.s;
  } else if (answer.alternates?.length) {
    out += html`<section class="sr-read">${alternatesBlock(answer, o.symbolOf, base)}</section>`.s;
  }

  const dup = answer.message && rs.some((r) => (r.notes ?? []).some((n) => n.text === answer.message));
  if (answer.message && !dup) {
    const level = answer.expect === 'unrecognised' || (answer.expect === 'not_in_resource' && !rs.length) ? 'sr-message--stop' : 'sr-message--info';
    out += html`<div class="sr-message ${level}" role="note" data-expect="${answer.expect}"><span class="sr-sr-only">${answer.expect === 'unrecognised' ? 'Could not read the query. ' : ''}</span>${answer.message}</div>`.s;
  }

  if (rs.length) {
    const receptors = new Set(rs.map((r) => r.gid));
    const asTable = rs.length > 3 && receptors.size > 1;
    statusBits.push(`${rs.length} ${rs.length === 1 ? 'result' : 'results'}`);
    if (asTable) {
      out += html`<section class="sr-results" aria-label="Results"><h2 class="sr-h2">${rs.length} receptors</h2>${renderTable(rs, answer.interpretation, { ...o })}</section>`.s;
    } else {
      out += html`<section class="sr-results" aria-label="Results">${rs.map((r, i) => (r.type === 'receptor' ? receptorCard(r, o, i) : card(r, o, i)))}</section>`.s;
    }
  } else {
    statusBits.push('No result');
  }

  if (!rs.length || answer.expect === 'unrecognised') out += renderHelp(o).s;
  return { html: out, status: statusBits.join(', '), results: rs };
}
