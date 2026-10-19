"""Static search index for variant and generic-position search on Browse.

Everything is precomputed at build time into small JSON files under
`<output>/search/` (not `data/`, which the deploy script does not publish).
The Browse page fetches them lazily on the first variant or position search.

    search/meta.json               receptors, gnomAD coordinate ranges, shard lists
    search/variants/<gid>.json     one receptor's variant table rows + residue info
    search/rsid/<NN>.json          rsID -> receptor indices, NN = rs number mod 100
    search/positions/<P>.json      generic number -> [[receptor, seq, aa, max|dRRCS|]]
                                   P = the helix or loop part, e.g. "6" for 6.48x48

Variant rows reuse the report's own `_prepare_variants_full`, so allele
frequency, AlphaMissense and conservation strings are exactly what each
report's variant table shows, including its gaps. Residue generic numbers for
variants come from the annotation `display_number` column (`generic_number`
is empty in every annotation file). Position search uses the full GPCRdb
numbering that the snake plots are drawn from (see gpcrdb_residues.py).
"""

import json
import re
import shutil

import pandas as pd

from . import gpcr_report_helpers as v1
from ..format_helpers import MISSING
from ..gpcrdb_residues import load_residue_maps

RSID_SHARDS = 100

VARIANT_FIELDS = ['pos', 'hgvsp', 'hgvsc', 'variant_id', 'af', 'het', 'max_abs_delta',
                  'am_score', 'am_class', 'conservation', 'rsids']

_GN_RE = re.compile(r'^(\d{1,2})\.(\d{2,3})x(\d{2,3})$')

_AA3 = {
    'Ala': 'A', 'Arg': 'R', 'Asn': 'N', 'Asp': 'D', 'Cys': 'C', 'Gln': 'Q', 'Glu': 'E',
    'Gly': 'G', 'His': 'H', 'Ile': 'I', 'Leu': 'L', 'Lys': 'K', 'Met': 'M', 'Phe': 'F',
    'Pro': 'P', 'Ser': 'S', 'Thr': 'T', 'Trp': 'W', 'Tyr': 'Y', 'Val': 'V',
}


def _write(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, separators=(',', ':'), ensure_ascii=False)
    path.write_text(text, encoding='utf-8')
    return len(text.encode('utf-8'))


def _residue_max_abs_delta(delta_df):
    """Max |dRRCS| over every contact pair a residue takes part in."""
    if delta_df.empty:
        return {}
    a = delta_df[['res1', 'delta_rrcs']].rename(columns={'res1': 'res'})
    b = delta_df[['res2', 'delta_rrcs']].rename(columns={'res2': 'res'})
    both = pd.concat([a, b])
    both['abs'] = both['delta_rrcs'].abs()
    return both.groupby('res')['abs'].max().to_dict()


def _variant_shard(gid, store):
    var_df = store.variant_data.get(gid, pd.DataFrame())
    if var_df.empty:
        return None
    delta_df = store.delta_data.get(gid, pd.DataFrame())
    annot = store.get_annotation_map(gid)
    rows = v1._prepare_variants_full(var_df, delta_df)

    ref_aa = {}
    for _, r in var_df.iterrows():
        try:
            ref_aa.setdefault(int(r['protein_position']), _AA3.get(str(r.get('ref_aa', '')), ''))
        except (TypeError, ValueError):
            pass

    residues, alleles = {}, []
    for r in rows:
        pos = r['position']
        if isinstance(pos, int) and str(pos) not in residues:
            a = annot.get(pos, {})
            residues[str(pos)] = [
                a.get('amino_acid', '') or ref_aa.get(pos, ''),
                a.get('display_number', ''),
                a.get('protein_segment', ''),
            ]
        alleles.append([
            pos, r['hgvsp'], r['hgvsc'], r['variant_id'], r['af_display'], r['het'],
            r['delta_rrcs_display'], r['am_score_display'],
            r['am_class'] if r['am_class'] != MISSING else MISSING,
            r['conservation_display'], r['rsid_list'],
        ])
    return {'res': residues, 'v': alleles}


def generate_search_index(store, output_dir):
    out = output_dir / 'search'
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    gids = list(store.gpcr_ids)
    index_of = {g: i for i, g in enumerate(gids)}
    receptors = []
    for g in gids:
        info = store.gpcr_info[g]
        receptors.append([g, info['uniprot_name'], info['gene_name'] or '',
                          info['receptor_family'] or ''])

    sizes = {'variants': 0, 'rsid': 0, 'positions': 0}
    files = {'variants': 0, 'rsid': 0, 'positions': 0}

    # ---- variants, rsID shards, gnomAD coordinate ranges ----
    rsid_shards = {}
    ranges = {}
    with_variants = []
    n_alleles = 0
    for g in gids:
        shard = _variant_shard(g, store)
        if not shard:
            continue
        with_variants.append(index_of[g])
        n_alleles += len(shard['v'])
        sizes['variants'] += _write(out / 'variants' / f'{g}.json', shard)
        files['variants'] += 1
        for row in shard['v']:
            for rs in row[10]:
                num = int(rs[2:])
                bucket = rsid_shards.setdefault('%02d' % (num % RSID_SHARDS), {})
                lst = bucket.setdefault(rs[2:], [])
                if index_of[g] not in lst:
                    lst.append(index_of[g])
            parts = row[3].split('-')
            if len(parts) == 4 and parts[1].isdigit():
                chrom, p = parts[0], int(parts[1])
                lo_hi = ranges.setdefault(chrom, {}).setdefault(g, [p, p])
                lo_hi[0] = min(lo_hi[0], p)
                lo_hi[1] = max(lo_hi[1], p)

    for key, bucket in sorted(rsid_shards.items()):
        sizes['rsid'] += _write(out / 'rsid' / f'{key}.json', bucket)
        files['rsid'] += 1

    gnomad_ranges = {
        chrom: sorted([lo, hi, index_of[g]] for g, (lo, hi) in per.items())
        for chrom, per in sorted(ranges.items())
    }

    # ---- generic positions (full GPCRdb numbering) ----
    maps, missing = load_residue_maps(gids, output_dir)
    pos_shards = {}
    for g in gids:
        rows = maps.get(g)
        if not rows:
            continue
        maxd = _residue_max_abs_delta(store.delta_data.get(g, pd.DataFrame()))
        for seq, aa, _seg, gn in rows:
            m = _GN_RE.match(gn or '')
            if not m:
                continue
            d = maxd.get(seq)
            entry = [index_of[g], seq, aa, round(float(d), 2) if d is not None else None]
            pos_shards.setdefault(m.group(1), {}).setdefault(gn, []).append(entry)

    for key, bucket in sorted(pos_shards.items()):
        sizes['positions'] += _write(out / 'positions' / f'{key}.json', bucket)
        files['positions'] += 1

    meta = {
        'version': 1,
        'receptors': receptors,
        'receptor_fields': ['gpcr_id', 'uniprot_name', 'gene_name', 'receptor_family'],
        'variant_fields': VARIANT_FIELDS,
        'missing': MISSING,
        'with_variants': with_variants,
        'gnomad_ranges': gnomad_ranges,
        'rsid_shards': RSID_SHARDS,
        'position_shards': sorted(pos_shards, key=int),
        'positions_missing': [index_of[g] for g in missing],
    }
    sizes['meta'] = _write(out / 'meta.json', meta)

    total = sum(sizes.values())
    print(f"  Generated: search/ ({n_alleles} alleles in {files['variants']} receptor shards, "
          f"{files['rsid']} rsID shards, {files['positions']} position shards, "
          f"{len(maps)}/{len(gids)} receptors numbered; "
          f"{total / 1024:.0f} KB total: meta {sizes['meta'] / 1024:.0f}, "
          f"variants {sizes['variants'] / 1024:.0f}, rsid {sizes['rsid'] / 1024:.0f}, "
          f"positions {sizes['positions'] / 1024:.0f})")
    return {'sizes': sizes, 'files': files, 'missing': missing}
