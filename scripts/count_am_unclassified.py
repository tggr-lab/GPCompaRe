#!/usr/bin/env python3
"""Write GPCompaReports_v2/data/supplement_2026-11-05b/am_unclassified.tsv: the substitutions of the
276-receptor AlphaMissense comparison (Statistics page, section 4) that carry no AlphaMissense class in it.

Run by hand, never by the site build (its input lives outside the repository). The build reads the output
and asserts its sha256 (analysis/class_results.py AM_UNCLASSIFIED_SHA); the page prints the counts in the method
note of card 4a.

The comparison counts the rows of the audit table (fig3_audit_variants_complete_modelnum_2026-11-05b, GPR3,
GPR4 and XCR1 left out) with a generic number (gn) whose am_status is not 'unresolved'. All but one of the
1,260 unresolved rows are a second allele at a protein position that already has a classified allele in the
batch variant CSVs, whose AlphaMissense column is filled for the first allele at each position only.
When the Studio packs are given, the script also reports how many of them the packs score (same reference
residue required); that count is printed, not written.

    .venv-test/bin/python -I scripts/count_am_unclassified.py [--audit TSV] [--packs DIR] [--dry-run]
"""
import argparse
import glob
import hashlib
import json
import os
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'GPCompaReports_v2' / 'data' / 'supplement_2026-11-05b' / 'am_unclassified.tsv'
AUDIT = Path('/home/yamir/research/tggr_gpcr_ready_for_the final_draft/figures_overhaul/figure3/'
             'fig3_audit_variants_complete_modelnum_2026-11-05b.tsv')
AUDIT_SHA = 'be52356ed7eba2b1a980487e91a9a7b40f583b9190be94e7713725abc56c2686'
LEFT_OUT = ('gpr3_human', 'gpr4_human', 'xcr1_human')
AA = 'ACDEFGHIKLMNPQRSTVWY'
#: the classified counts of the summary the page shows (scored at the top 50 and at other positions)
SCORED = {True: 7268, False: 11040}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def pack_classes(rows, packs):
    out = []
    cache = {}
    for r in rows.itertuples():
        if r.gid not in cache:
            hits = glob.glob(os.path.join(packs, '%s.*.json' % r.gid))
            cache[r.gid] = json.load(open(hits[0])).get('am', {}) if hits else {}
        cls = None
        for ent in cache[r.gid].get(str(int(r.protein_position))) or []:
            if ent[0] == r.ref_aa:
                cls = ent[2][AA.index(r.alt_aa)]
        out.append(cls)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--audit', default=str(AUDIT))
    ap.add_argument('--packs', default=os.environ.get('STUDIO_PACK_DIR', ''))
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    got = sha(a.audit)
    if got != AUDIT_SHA:
        sys.exit('audit table sha256 %s, expected %s' % (got, AUDIT_SHA))
    t = pd.read_csv(a.audit, sep='\t')
    t = t[t.gn.notna() & ~t.gid.isin(LEFT_OUT)]
    classified = t[t.am_status != 'unresolved']
    for top, n in SCORED.items():
        have = int((classified.cfr == top).sum())
        if have != n:
            sys.exit('classified substitutions at %s: %d, expected %d' % ('top 50' if top else 'other', have, n))
    u = t[t.am_status == 'unresolved'].sort_values(['gid', 'protein_position', 'alt_aa'])
    out = pd.DataFrame({'gid': u.gid, 'protein_position': u.protein_position.astype(int), 'ref_aa': u.ref_aa,
                        'alt_aa': u.alt_aa, 'generic_number': u.gn, 'top50': u.cfr.map({True: 1, False: 0})})
    print('unclassified substitutions %d, at the top 50 %d, receptors %d'
          % (len(out), int(out.top50.sum()), out.gid.nunique()))
    if a.packs and os.path.isdir(a.packs):
        cls = pd.Series(pack_classes(out, a.packs))
        print('scored by the Studio packs: %d %s' % (int(cls.notna().sum()), cls.value_counts().to_dict()))
    if a.dry_run:
        return
    OUT.write_text(out.to_csv(sep='\t', index=False, lineterminator='\n'), encoding='utf-8')
    print('wrote %s sha256 %s' % (OUT, sha(OUT)))


if __name__ == '__main__':
    main()
