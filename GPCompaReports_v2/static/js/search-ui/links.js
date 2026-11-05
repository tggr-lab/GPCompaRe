/**
 * Search v2 UI: where each identifier in a result links to.
 *
 * Pure URL builders: no DOM, no network, no prefetch. Each returns null when the value does not have the
 * shape its resource expects, so the caller shows plain text instead of a broken link. Release-specific
 * targets (the gnomAD dataset, the AlphaMissense record) come from search2/meta.json `releases`, which is
 * filled from data_versions.json; nothing release-specific is written here.
 *
 * URL schemes, checked against each resource's own pages (2026-11-05):
 *   HGNC         https://www.genenames.org/data/gene-symbol-report/#!/hgnc_id/HGNC:<n>
 *                (by symbol: https://www.genenames.org/tools/search/#!/?query=<symbol>, the site's own search link)
 *   UniProt      https://www.uniprot.org/uniprotkb/<accession>/entry
 *   GPCRdb       https://gpcrdb.org/protein/<entry name, lower case>/    (GPCRdb has no stable per-residue page)
 *   NCBI Gene    https://www.ncbi.nlm.nih.gov/gene/<Gene ID>
 *   dbSNP        https://www.ncbi.nlm.nih.gov/snp/<rsID>
 *   ClinVar      https://www.ncbi.nlm.nih.gov/clinvar/variation/<Variation ID>/
 *   gnomAD       https://gnomad.broadinstitute.org/variant/<chrom-pos-ref-alt>?dataset=<dataset>   (GRCh38 ids)
 *                https://gnomad.broadinstitute.org/gene/<ENSG>?dataset=<dataset>
 *   Ensembl      https://www.ensembl.org/id/<stable id>   (Ensembl's documented stable-ID link: gene, transcript
 *                or protein, GRCh38; it follows Ensembl's move to its new site)
 *   RefSeq       https://www.ncbi.nlm.nih.gov/nuccore/<NM_ or NR_>  and  https://www.ncbi.nlm.nih.gov/protein/<NP_>
 *   UCSC         https://genome.ucsc.edu/cgi-bin/hgTracks?db=hg38|hg19&position=chr<c>:<start>-<end>
 *                (GRCh37 positions go to UCSC hg19: the Ensembl GRCh37 site was unavailable when checked)
 *   AlphaMissense  releases.alphamissense.record (the Zenodo record in data_versions.json)
 *
 * @module search-ui/links
 */

const VARIANT_ID = /^(?:chr)?([0-9]{1,2}|X|Y|MT?)-([0-9]+)-([ACGTN]+)-([ACGTN]+)$/i;
const POSITION_ID = /^(?:chr)?([0-9]{1,2}|X|Y|MT?)[-:]([0-9]+)$/i;

/** The gnomAD dataset of the search release; gnomad_r4 when an older index does not name one. */
export const gnomadDataset = (releases) => releases?.gnomad?.dataset || 'gnomad_r4';

export function hgncUrl(rec) {
  const id = String(rec?.hgnc ?? '');
  if (/^HGNC:\d+$/.test(id)) return `https://www.genenames.org/data/gene-symbol-report/#!/hgnc_id/${id}`;
  return rec?.symbol ? `https://www.genenames.org/tools/search/#!/?query=${encodeURIComponent(rec.symbol)}` : null;
}

export function uniprotUrl(acc) {
  return /^[A-Z0-9]{6,10}(?:-\d+)?$/.test(String(acc ?? '')) ? `https://www.uniprot.org/uniprotkb/${acc}/entry` : null;
}

export function gpcrdbUrl(entry) {
  const e = String(entry ?? '').toLowerCase();
  return /^[a-z0-9]+_human$/.test(e) ? `https://gpcrdb.org/protein/${e}/` : null;
}

export function ncbiGeneUrl(id) {
  return /^\d+$/.test(String(id ?? '')) ? `https://www.ncbi.nlm.nih.gov/gene/${id}` : null;
}

export function dbsnpUrl(rs) {
  return /^rs\d+$/.test(String(rs ?? '')) ? `https://www.ncbi.nlm.nih.gov/snp/${rs}` : null;
}

export function clinvarUrl(variationId) {
  return /^\d+$/.test(String(variationId ?? '')) ? `https://www.ncbi.nlm.nih.gov/clinvar/variation/${Number(variationId)}/` : null;
}

/** A GRCh38 gnomAD id (5-148826877-G-A); null for anything else, including GRCh37 ids. */
export function gnomadVariantUrl(id, releases) {
  const m = VARIANT_ID.exec(String(id ?? ''));
  if (!m) return null;
  return `https://gnomad.broadinstitute.org/variant/${m[1].toUpperCase()}-${m[2]}-${m[3].toUpperCase()}-${m[4].toUpperCase()}?dataset=${encodeURIComponent(gnomadDataset(releases))}`;
}

export function gnomadGeneUrl(ensg, releases) {
  return /^ENSG\d+$/.test(String(ensg ?? '').replace(/\.\d+$/, ''))
    ? `https://gnomad.broadinstitute.org/gene/${String(ensg).replace(/\.\d+$/, '')}?dataset=${encodeURIComponent(gnomadDataset(releases))}`
    : null;
}

/** Ensembl gene, transcript or protein (ENSG, ENST, ENSP), version dropped so a newer release still resolves. */
export function ensemblUrl(id) {
  const m = /^(ENS[GTP]\d{11})(?:\.\d+)?$/.exec(String(id ?? ''));
  return m ? `https://www.ensembl.org/id/${m[1]}` : null;
}

/** NCBI RefSeq: nucleotide (NM_, NR_, XM_, XR_) or protein (NP_, XP_), with its version. */
export function refseqUrl(acc) {
  const m = /^([NX])([MRP])_\d+(?:\.\d+)?$/.exec(String(acc ?? ''));
  if (!m) return null;
  return `https://www.ncbi.nlm.nih.gov/${m[2] === 'P' ? 'protein' : 'nuccore'}/${acc}`;
}

/** A transcript or protein accession of either source. */
export const accessionUrl = (acc) => ensemblUrl(acc) ?? refseqUrl(acc);
export const accessionSite = (acc) => (/^ENS/.test(String(acc ?? '')) ? 'Ensembl' : 'NCBI RefSeq');

/**
 * UCSC Genome Browser at a genome id or position, on the assembly it belongs to.
 * @param {string} id chrom-pos-ref-alt or chrom-pos
 * @param {'GRCh38'|'GRCh37'} assembly
 */
export function ucscUrl(id, assembly) {
  const s = String(id ?? '');
  const v = VARIANT_ID.exec(s);
  const p = v ?? POSITION_ID.exec(s);
  if (!p) return null;
  const db = assembly === 'GRCh37' ? 'hg19' : assembly === 'GRCh38' ? 'hg38' : null;
  if (!db) return null;
  let chrom = p[1].toUpperCase();
  if (chrom === 'MT') chrom = 'M';
  const start = Number(p[2]);
  const end = v ? start + v[3].length - 1 : start;
  return `https://genome.ucsc.edu/cgi-bin/hgTracks?db=${db}&position=chr${chrom}:${start}-${end}`;
}

/** The AlphaMissense data record (Zenodo) from the registry, or null when the index does not carry it. */
export function alphamissenseUrl(releases) {
  const u = releases?.alphamissense?.record;
  return typeof u === 'string' && /^https:\/\//.test(u) ? u : null;
}

/** "Zenodo record 10813168" from the record link. */
export function recordLabel(url) {
  const m = /zenodo\.org\/records?\/(\d+)/.exec(String(url ?? ''));
  return m ? `Zenodo record ${m[1]}` : 'data record';
}

// ------------------------------------------------------------------------------- internal pages

/** A report page, optionally at a hash (`sec=sec-snake&res=16`, `pair=130-131`). */
export function reportUrl(o, gid, hash = '') {
  return `${o?.reports ?? ''}${gid}.html${hash ? `#${hash}` : ''}`;
}
export const residueUrl = (o, gid, pos) => reportUrl(o, gid, pos ? `sec=sec-snake&res=${pos}` : '');
export const studioUrl = (o, gid) => `${o?.studio ?? ''}?db=${encodeURIComponent(gid)}`;

/** The glossary page at one term (website/glossary.py ids: cfr, delta, am, gnomad, ...). */
export function glossaryUrl(o, id) {
  const page = o?.glossary ?? (o?.reports ? `${o.reports}../glossary.html` : 'glossary.html');
  return `${page}#${id}`;
}
