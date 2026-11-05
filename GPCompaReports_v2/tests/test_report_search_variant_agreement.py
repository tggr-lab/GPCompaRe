"""Every report variant table and the search index agree, allele by allele.

Reads a full build (FREEZE_BUILD_DIR; skips without reports/ and search2/): for every receptor, the rows of
the report page's variant table are exactly the search alleles flagged `rt` = '1', with the same position,
protein and DNA change, allele frequency, heterozygote count, AlphaMissense score (the table shows 3 decimals of the 4-decimal score, the shard stores 3: they may differ by 0.001 in the
last digit) and class and dbSNP ids;
and an allele is flagged exactly when its residue takes part in a pair with |dRRCS| >= 3.0 (the table's rule,
read from the batch delta CSVs).
"""
import html as htmllib
import json
import os
import re
from collections import Counter
from pathlib import Path

import pytest

from GPCompaReports_v2.website.format_helpers import fmt_sci

from .report_files import report_pages

BASE = Path(__file__).resolve().parent.parent
_env = os.environ.get('FREEZE_BUILD_DIR')
if _env:
    BUILD_DIR = Path(_env).expanduser()
    if not BUILD_DIR.is_absolute():
        BUILD_DIR = BASE / _env
else:
    BUILD_DIR = BASE / 'output_v3_demo'

THREE = {'A': 'Ala', 'R': 'Arg', 'N': 'Asn', 'D': 'Asp', 'C': 'Cys', 'Q': 'Gln', 'E': 'Glu', 'G': 'Gly',
         'H': 'His', 'I': 'Ile', 'L': 'Leu', 'K': 'Lys', 'M': 'Met', 'F': 'Phe', 'P': 'Pro', 'S': 'Ser',
         'T': 'Thr', 'W': 'Trp', 'Y': 'Tyr', 'V': 'Val', '*': 'Ter'}
COMP = str.maketrans('ACGT', 'TGCA')
CLASS = {'P': 'PATHOGENIC', 'A': 'AMBIGUOUS', 'B': 'BENIGN'}

needs_build = pytest.mark.skipif(
    not ((BUILD_DIR / 'reports').is_dir() and (BUILD_DIR / 'search2' / 'meta.json').exists()),
    reason='no build with reports/ and search2/ at %s' % BUILD_DIR)


def _cell(x):
    return htmllib.unescape(re.sub(r'<[^>]+>', '', x)).strip()


def report_rows(page):
    text = page.read_text(encoding='utf-8')
    i = text.find('id="variants-table"')
    if i < 0:
        return []
    table = text[i:text.find('</table>', i)]
    body = table[table.find('<tbody>'):]
    return [[_cell(c) for c in re.findall(r'<td[^>]*>(.*?)</td>', tr, re.S)]
            for tr in re.findall(r'<tr[^>]*>(.*?)</tr>', body, re.S)]


def decode(raw):
    """Python twin of static/js/search/shards.js decodeVariants (the fields the table shows)."""
    out, pos, g, an = [], 0, 0, 0
    for i in range(raw['n']):
        pos += raw['pos'][i]
        g += raw['g'][i]
        an += raw['an'][i]
        ref, alt, tx = raw['ref'][i], raw['alt'][i], raw['tx'][i]
        r38, a38 = raw['nt'][i].split('>')
        num = tx if tx is not None else pos
        hgvsc = raw['hgvscX'].get(str(i))
        if hgvsc is None and raw['c'][i] is not None:
            c = 3 * num - 2 + raw['c'][i]
            hgvsc = 'c.%d%s>%s' % (c, r38 if raw['strand'] == 1 else r38.translate(COMP),
                                    a38 if raw['strand'] == 1 else a38.translate(COMP))
        rs = raw['rs'][i]
        out.append({
            'pos': pos, 'hgvsp': raw['hgvspX'].get(str(i), 'p.%s%d%s' % (THREE[ref], num, THREE[alt])),
            'hgvsc': hgvsc, 'id': '%s-%d-%s-%s' % (raw['chrom'], g, r38, a38),
            'rsids': ['rs%d' % n for n in rs] if rs else [], 'ac': raw['ac'][i], 'an': an,
            'hom': raw['hom'][i], 'am': None if raw['am'][i] is None else raw['am'][i] / 1000,
            'amc': raw['amc'][i], 'rt': raw['rt'][i],
        })
    return out


@needs_build
def test_every_report_table_row_is_a_flagged_search_allele_and_back():
    meta = json.loads((BUILD_DIR / 'search2' / 'meta.json').read_text(encoding='utf-8'))
    assert meta['releases']['reportTable']['label'] == meta['releases']['gnomad']['label']
    pages = {p.stem: p for p in report_pages(BUILD_DIR / 'reports')}
    gids = [r[0] for r in meta['receptors']]
    assert set(gids) <= set(pages) or len(pages) < 283
    n_rows = n_tables = 0
    problems = []
    for gid in gids:
        if gid not in pages:
            continue
        rows = report_rows(pages[gid])
        shard = BUILD_DIR / 'search2' / 'variants' / ('%s.json' % gid)
        alleles = decode(json.loads(shard.read_text(encoding='utf-8'))) if shard.exists() else []
        flagged = [a for a in alleles if a['rt'] == '1']
        key_r = Counter((int(r[0]), r[1], r[2]) for r in rows)
        key_s = Counter((a['pos'], a['hgvsp'], a['hgvsc'] or '-') for a in flagged)
        if key_r != key_s:
            problems.append('%s: report %d rows, search %d flagged; only in report %s; only in search %s' % (
                gid, len(rows), len(flagged), list((key_r - key_s).elements())[:3], list((key_s - key_r).elements())[:3]))
            continue
        by_key = {}
        for a in flagged:
            by_key.setdefault((a['pos'], a['hgvsp'], a['hgvsc'] or '-'), []).append(a)
        for r in rows:
            cands = by_key[(int(r[0]), r[1], r[2])]
            a = cands[0]
            want_rs = ', '.join(a['rsids']) or '-'
            am_ok = (r[6] == '-' and a['am'] is None) or (a['am'] is not None and abs(float(r[6]) - a['am']) <= 0.001 + 1e-9)
            cls_ok = r[7] == CLASS.get(a['amc'], '-')
            af_ok = r[3] == fmt_sci(a['ac'] / a['an'], digits=2) if a['an'] else r[3] == '-'
            het_ok = int(r[4]) == a['ac'] - 2 * (a['hom'] or 0)
            if not (am_ok and cls_ok and af_ok and het_ok and r[9] == want_rs):
                problems.append('%s %s %s: report %s, search am=%s %s af=%s het=%s rs=%s' % (
                    gid, r[1], r[2], r, a['am'], a['amc'], fmt_sci(a['ac'] / a['an'], digits=2),
                    a['ac'] - 2 * (a['hom'] or 0), want_rs))
        n_rows += len(rows)
        n_tables += bool(rows)
    assert not problems, '\n'.join(problems[:30]) + ('\n... %d more' % (len(problems) - 30) if len(problems) > 30 else '')
    if len(pages) >= 283:
        assert (n_rows, n_tables) == (28789, 281)


@needs_build
def test_search_flags_exactly_the_alleles_at_residues_past_the_cutoff():
    """`rt` = '1' exactly at residues of a pair with |dRRCS| >= 3.0. A residue's largest |dRRCS| comes from
    the store (the batch delta CSVs) when available; this keeps the check independent of the report layer."""
    from .test_search_index_v2 import _batch_dir
    batch = _batch_dir()
    if not (batch / 'csv_data').exists():
        pytest.skip('no batch data at %s' % batch)
    import pandas as pd
    meta = json.loads((BUILD_DIR / 'search2' / 'meta.json').read_text(encoding='utf-8'))
    bad = []
    for gid in (r[0] for r in meta['receptors']):
        shard = BUILD_DIR / 'search2' / 'variants' / ('%s.json' % gid)
        if not shard.exists():
            continue
        d = pd.read_csv(batch / 'csv_data' / ('%s_rrcs_delta.csv' % gid))
        hit = d[d['delta_rrcs'].abs() >= 3.0]
        sig = set(hit['res1'].astype(int)) | set(hit['res2'].astype(int))
        for a in decode(json.loads(shard.read_text(encoding='utf-8'))):
            if (a['rt'] == '1') != (a['pos'] in sig):
                bad.append((gid, a['id'], a['pos'], a['rt']))
    assert not bad, bad[:20]
