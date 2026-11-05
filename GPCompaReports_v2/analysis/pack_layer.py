"""The report pages' variant and annotation layer, read from the Studio packs (the source search v2 uses).

The batch run (batch_analysis_20260202_151051) stays the source of every RRCS, dRRCS and CFR number and of
the family-wide analyses (CFR ranking, TM-domain and variant statistics, the paper). Its variant CSVs and
three of its annotation files have known defects (parity/DIFFERS_FROM_DATABASE.md in the Studio):

- AlphaMissense and conservation joined to the first allele at a position only;
- alleles numbered on another transcript or isoform (MCHR1, NPFFR2, OPRM1, EDNRB, ...) and UniProt
  numbering 3 residues off the model (LPAR2, OPN1SW);
- GPR3, GPR4 and XCR1 carry the variants, caches and annotation of GPR31, GPR42 and CXCR1;
- no table for GPR182 and P2RY8 (gene lookup failed).

This module rebuilds, per receptor, what the report shows from the pack instead, with the report's own rules:

    variant_frame(pack, delta_df)       the variant table rows: every pack allele at a residue in a contact pair
                                        with |dRRCS| >= 3.0 (single_gpcr_processor.get_significant_positions),
                                        each with its own AlphaMissense score and class and the residue's
                                        conservation. Same columns as the batch CSV, so
                                        gpcr_report_helpers._prepare_variants_full renders it unchanged.
                                        This is src/engine/report/variants.ts variantRows() of the Studio.
    annotation_frame(pack, delta_df)    the annotation rows of the batch CSV (residues in a pair with
                                        |dRRCS| >= 3.0), from the pack's GPCRdb numbering. Used only for
                                        WRONG_RECEPTOR_ANNOTATION; the other 280 receptors' batch annotation is
                                        identical to the pack at every row.
    conservation(pack), am_mean(pack)   per-residue snake-plot and residue-table layers in model numbering.

No network access. The pack folder is report_extras' (STUDIO_PACK_DIR, else STUDIO_ROOT/public/pack).
"""
import json
import os
from pathlib import Path

import pandas as pd

SIGNIFICANT_DELTA = 3.0  # get_significant_positions: the fixed cutoff, not the receptor threshold
AM_ALPHABET = 'ACDEFGHIKLMNPQRSTVWY'
AM_CLASS = {'P': 'PATHOGENIC', 'A': 'AMBIGUOUS', 'B': 'BENIGN'}
THREE = {
    'A': 'Ala', 'R': 'Arg', 'N': 'Asn', 'D': 'Asp', 'C': 'Cys', 'Q': 'Gln', 'E': 'Glu', 'G': 'Gly',
    'H': 'His', 'I': 'Ile', 'L': 'Leu', 'K': 'Lys', 'M': 'Met', 'F': 'Phe', 'P': 'Pro', 'S': 'Ser',
    'T': 'Thr', 'W': 'Trp', 'Y': 'Tyr', 'V': 'Val', '*': 'Ter',
}
# The batch matched UniProt ids by substring: these three carry another receptor's annotation layer.
WRONG_RECEPTOR_ANNOTATION = {'gpr3_human': 'GPR31', 'gpr4_human': 'GPR42', 'xcr1_human': 'CXCR1'}

VARIANT_COLUMNS = ['variant_id', 'protein_position', 'ref', 'alt', 'ref_aa', 'alt_aa', 'hgvsp', 'hgvsc',
                   'af', 'ac', 'an', 'ac_hom', 'rsids', 'data_source', 'am_score', 'am_class',
                   'conservation', 'het_count', 'tx_position', 'conflict']
ANNOTATION_COLUMNS = ['position', 'amino_acid', 'generic_number', 'display_number', 'protein_segment',
                      'gpcrdb_number']

DEFAULT_STUDIO_ROOT = Path(
    '/home/yamir/Documents/gpcr_synth/gpcompare_studio_web/.claude/worktrees/main-merge')


def pack_dir():
    env = os.environ.get('STUDIO_PACK_DIR')
    if env:
        return Path(env).expanduser()
    root = os.environ.get('STUDIO_ROOT')
    return (Path(root).expanduser() if root else DEFAULT_STUDIO_ROOT) / 'public' / 'pack'


def pack_index(folder=None):
    folder = Path(folder) if folder else pack_dir()
    path = folder / 'index.json'
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding='utf-8'))


def pack_path(gid, folder=None):
    """<gid>.json in a source checkout, <gid>.<hash>.json in a Studio build (named by index.json)."""
    folder = Path(folder) if folder else pack_dir()
    plain = folder / ('%s.json' % gid)
    if plain.is_file():
        return plain
    index = pack_index(folder)
    hashed = ((index or {}).get('release') or {}).get('files', {}).get('%s.json' % gid)
    if hashed and (folder / hashed).is_file():
        return folder / hashed
    return None


def load_pack(gid, folder=None):
    path = pack_path(gid, folder)
    return json.loads(path.read_text(encoding='utf-8')) if path else None


def significant_positions(delta_df, threshold=SIGNIFICANT_DELTA):
    """Residues of any pair with |dRRCS| >= threshold (single_gpcr_processor.get_significant_positions)."""
    if delta_df is None or delta_df.empty:
        return set()
    hit = delta_df[delta_df['delta_rrcs'].abs() >= threshold]
    return set(hit['res1'].astype(int)) | set(hit['res2'].astype(int))


def am_of(pack, pos, ref, alt):
    """(score, class code 'P'/'A'/'B') of the substitution, from the AM entry whose reference is `ref`."""
    for entry in (pack.get('am') or {}).get(str(pos), []):
        if entry[0] == ref and alt in AM_ALPHABET:
            i = AM_ALPHABET.index(alt)
            score = entry[1][i]
            return score, (entry[2][i] if score is not None else None)
    return None, None


def variant_frame(pack, delta_df, threshold=SIGNIFICANT_DELTA):
    """The report variant table's input rows (batch CSV columns), in pack order."""
    if not pack or not pack.get('variants'):
        return pd.DataFrame(columns=VARIANT_COLUMNS)
    sig = significant_positions(delta_df, threshold)
    cons = pack.get('conservation') or {}
    rows = []
    for v in pack['variants']:
        pos, ref, alt, hgvsp, hgvsc, af, ac, an, hom, source, rsids, vid, txpos, conflict = v
        if pos not in sig:
            continue
        score, code = am_of(pack, pos, ref, alt)
        ch, gpos, gref, galt = vid.split('-')
        rows.append({
            'variant_id': vid,
            'protein_position': pos,
            'ref': gref,
            'alt': galt,
            'ref_aa': THREE.get(ref, ref),
            'alt_aa': THREE.get(alt, alt),
            'hgvsp': hgvsp,
            'hgvsc': hgvsc,
            'af': af,
            'ac': ac,
            'an': an,
            'ac_hom': hom,
            # the CSV held a list literal; the Studio joins with ', ' (one display string per row)
            'rsids': ', '.join(rsids),
            'data_source': source,
            'am_score': score,
            'am_class': AM_CLASS.get(code, 'N/A'),
            'conservation': cons.get(str(pos)),
            'het_count': ac - 2 * (hom or 0),
            'tx_position': txpos,
            'conflict': bool(conflict),
        })
    return pd.DataFrame(rows, columns=VARIANT_COLUMNS)


def annotation_frame(pack, delta_df, threshold=SIGNIFICANT_DELTA):
    """Annotation rows for the residues of pairs with |dRRCS| >= threshold, from the pack's GPCRdb numbering
    (the batch wrote get_gpcrdb_numbers() for exactly these residues; display_number holds the number)."""
    if not pack:
        return pd.DataFrame(columns=ANNOTATION_COLUMNS)
    sig = significant_positions(delta_df, threshold)
    rows = []
    for pos, aa, seg, gn, _src in pack.get('residues', []):
        if pos in sig:
            rows.append({'position': pos, 'amino_acid': aa, 'generic_number': None,
                         'display_number': gn or None, 'protein_segment': seg or None,
                         'gpcrdb_number': None})
    return pd.DataFrame(rows, columns=ANNOTATION_COLUMNS)


def _scores(obj):
    out = {}
    for k, v in (obj or {}).items():
        if v is None:
            continue
        try:
            out[int(k)] = float(v)
        except (TypeError, ValueError):
            continue
    return out


def conservation(pack):
    """{model position: ProtVar conservation}, the pack's (re-keyed where UniProt numbering differs)."""
    return _scores((pack or {}).get('conservation'))


def am_mean(pack):
    """{model position: mean AlphaMissense score over the 19 substitutions}."""
    return _scores((pack or {}).get('amMean'))


def provenance(pack):
    """The gnomAD block of a pack's provenance (release, dataset, fetched, transcript)."""
    return ((pack or {}).get('provenance') or {}).get('gnomad') or {}


def hgvs_numbering(variants, gnomad):
    """None when every listed allele's HGVS protein number is its model position; else
    {'transcript': 'ENST...v', 'offset': model minus HGVS number, 'rows': n} (LPAR2 -3, MCHR1 +69, NPFFR2 +102):
    the HGVS strings are gnomAD's, on its transcript, while the Position column is the model's."""
    if variants is None or variants.empty or 'tx_position' not in variants.columns:
        return None
    shifted = variants[variants['tx_position'].notna()]
    if shifted.empty:
        return None
    offsets = sorted({int(p - t) for p, t in zip(shifted['protein_position'], shifted['tx_position'])})
    tx = (gnomad or {}).get('transcript')
    if tx and (gnomad or {}).get('transcriptVersion'):
        tx = '%s.%s' % (tx, str(gnomad['transcriptVersion']).split('_')[0])
    return {'transcript': tx, 'offset': offsets[0] if len(offsets) == 1 else offsets, 'rows': len(shifted)}


class ReportLayer:
    """Per-receptor report layer built from the packs, for every gid the store knows.

    variants[gid]        DataFrame (VARIANT_COLUMNS); empty when the pack has no allele at a selected residue
    annotation[gid]      DataFrame (ANNOTATION_COLUMNS) for WRONG_RECEPTOR_ANNOTATION only
    uniprot[gid]         the pack's UniProt accession
    conservation[gid]    {pos: score}; am_mean[gid] {pos: mean score}
    release_id           the pack index release id (search checks it reads the same packs)
    """

    def __init__(self, store, folder=None):
        self.folder = Path(folder) if folder else pack_dir()
        index = pack_index(self.folder)
        if index is None:
            raise FileNotFoundError('no Studio packs at %s (set STUDIO_PACK_DIR or STUDIO_ROOT)' % self.folder)
        self.release_id = (index.get('release') or {}).get('id')
        self.variants, self.annotation, self.conservation, self.am_mean, self.gnomad = {}, {}, {}, {}, {}
        self.uniprot = {}  # gid -> the pack's UniProt accession (the receptor's own)
        missing = []
        for gid in store.gpcr_ids:
            pack = load_pack(gid, self.folder)
            if pack is None:
                missing.append(gid)
                continue
            delta = store.delta_data.get(gid, pd.DataFrame())
            self.variants[gid] = variant_frame(pack, delta)
            if gid in WRONG_RECEPTOR_ANNOTATION:
                self.annotation[gid] = annotation_frame(pack, delta)
            self.conservation[gid] = conservation(pack)
            self.am_mean[gid] = am_mean(pack)
            self.gnomad[gid] = provenance(pack)
            self.uniprot[gid] = (pack.get('meta') or {}).get('uniprotId')
        if missing:
            raise ValueError('no Studio pack for %s in %s' % (', '.join(missing), self.folder))

    def hgvs_numbering(self, gid):
        return hgvs_numbering(self.variants.get(gid), self.gnomad.get(gid))

    def counts(self):
        return {g: len(df) for g, df in self.variants.items()}
