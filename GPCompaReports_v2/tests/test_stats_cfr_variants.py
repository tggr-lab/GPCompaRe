"""Statistics page, variants: the site-data panel per CFR position (analysis/cfr_variants.py), the paper's
AlphaMissense comparison in the clinical tint (analysis/manuscript_stats.py) and the per-residue
conservation view (analysis/variant_correlation.py).

The per-position counts must equal the Studio packs (and search v2's ClinVar placement) when recounted
here independently; the paper numbers must equal the corrected supplement summary exactly; site and paper
must never share a label.
"""
import json
import math
import os
import re
from collections import Counter
from pathlib import Path

import pandas as pd
import pytest

from GPCompaReports_v2.analysis import pack_layer
from GPCompaReports_v2.analysis import cfr_variants as cv
from GPCompaReports_v2.analysis.manuscript_stats import (
    AM_TRACE_NAMES, CLINICAL_TINT, am_comparison_payload, class_cfr_ranks, class_cfr_set, fig_am_composition,
    load_am_comparison, make_enrichment_bar, write_am_comparison)
from GPCompaReports_v2.analysis.variant_correlation import conservation_by_residue, make_conservation_density
from GPCompaReports_v2.website import data_versions

BASE = Path(__file__).resolve().parent.parent
CSS = BASE / 'static' / 'css' / 'search-ui.css'
# search v2 of a build made from the same packs (ClinVar all-class counts); the tests that need it skip without
_s2 = os.environ.get('STATS_SEARCH2_DIR')
SEARCH2 = Path(_s2).expanduser() if _s2 else Path.home() / 'scratch/2026-11-05_reports_v3/rc3/stage_rc9/search2'
CODE = {'P': 'pathogenic', 'A': 'ambiguous', 'B': 'benign'}


# ---------------------------------------------------------------------------- the AlphaMissense class comparison (6a)
def test_class_counts_are_the_summary_exactly_without_a_test_statistic():
    am = load_am_comparison()
    p = am_comparison_payload(am)
    assert p['receptors'] == 276 and 'layer' not in p
    assert p['cells'] == [4117, 2038, 4085, 5284]
    assert 'odds_ratio' not in p and 'conservation_adjusted' not in p
    assert p['decisive_pct'] == am['decisive_pct'] and p['groups'] == am['groups']
    assert p['display'] == {
        'top_pct': '66.9%', 'other_pct': '43.6%',
        'top_denominators': '7,268 scored, 6,155 decisive',
        'other_denominators': '11,040 scored, 9,369 decisive'}
    assert 'gnomAD v4.1.0' in p['label'] and 'v4.1.2' not in p['label']
    assert not any(w in p['label'].lower() for w in ('paper', 'supplement', 'corrected', 'layer'))


def test_write_am_comparison_round_trips(tmp_path):
    p = write_am_comparison(tmp_path)
    assert json.loads((tmp_path / 'data/stats/am_comparison.json').read_text()) == json.loads(json.dumps(p))
    csv = (tmp_path / 'data/stats/am_comparison.csv').read_text()
    assert '"Top 50 positions by CFR score",7268,6155,4117,1113,2038,' in csv
    assert '"Other generic-numbered positions",11040,9369,4085,1671,5284,' in csv
    assert 'odds' not in csv.lower() and 'paper' not in csv.lower()


@pytest.mark.parametrize('make', [make_enrichment_bar, fig_am_composition])
def test_paper_charts_carry_the_summary_values_in_the_clinical_tint(make):
    am = load_am_comparison()
    fig = make(am)
    by = {t.name: t for t in fig.data}
    assert set(by) == set(AM_TRACE_NAMES.values())
    groups = am['groups'] if make is make_enrichment_bar else am['groups'][::-1]
    for cls, name in AM_TRACE_NAMES.items():
        t = by[name]
        vals = t.y if make is make_enrichment_bar else t.x
        assert list(vals) == [g[cls.lower()] for g in groups]          # exact, no rounding on the way
        counts = [c if isinstance(c, int) else c[0] for c in t.customdata]
        assert counts == [g[cls.lower() + '_n'] for g in groups]
        assert t.marker.color == CLINICAL_TINT['light'][cls.lower()]
        assert t.meta == {'path_class': cls.lower()}
    if make is fig_am_composition:
        title = fig.layout.title.text
        for s in ('66.9% vs 43.6%', '276 receptors'):
            assert s in title
        assert 'paper' not in title and 'Odds' not in title
        notes = ' '.join(a.text for a in fig.layout.annotations)
        assert '7,268 scored, 6,155 decisive' in notes and '11,040 scored, 9,369 decisive' in notes


def test_clinical_tint_equals_the_css_tokens():
    css = CSS.read_text(encoding='utf-8')
    light = css[css.index(':root {', css.index('clinical tint')):]
    light = light[:light.index('}')]
    dark = css[css.index('[data-color-mode="dark"]', css.index('clinical tint')):]
    dark = dark[:dark.index('}')]
    for block, theme in ((light, 'light'), (dark, 'dark')):
        for cls in ('benign', 'ambiguous', 'pathogenic'):
            m = re.search(r'--path-%s:\s*(#[0-9A-Fa-f]{6})' % cls, block)
            assert m and m.group(1).upper() == CLINICAL_TINT[theme][cls].upper(), (theme, cls)


# ---------------------------------------------------------------------------- the site panel per CFR position
def test_am_class_thresholds():
    assert cv.am_class(None) is None
    assert cv.am_class(0.5641) == 'pathogenic' and cv.am_class(0.564) == 'ambiguous'
    assert cv.am_class(0.34) == 'ambiguous' and cv.am_class(0.3399) == 'benign'
    assert cv.am_class(0.564, 'P') == 'pathogenic' and cv.am_class(0.34, 'B') == 'benign'   # the source class wins
    assert cv.clinvar_group('Pathogenic; risk factor') == 'plp'
    assert cv.clinvar_group('Uncertain significance') == 'vus' and cv.clinvar_group('') == 'other'


@pytest.fixture(scope='module')
def packs():
    index = pack_layer.pack_index()
    if index is None:
        pytest.skip('no Studio packs at %s' % pack_layer.pack_dir())
    gids = [r['gid'] for r in index['receptors']]
    return {g: pack_layer.load_pack(g) for g in gids}


@pytest.fixture(scope='module')
def built(packs, tmp_path_factory):
    out = tmp_path_factory.mktemp('stats')
    s2 = SEARCH2 if (SEARCH2 / 'variants').is_dir() else None
    return cv.write_cfr_variants(out, list(packs), search2_dir=s2) | {'out': out, 'search2': s2}


def _top_residues(packs):
    """{gid: {pos: generic}} for residues at the 50 CFR positions, read straight from the packs."""
    top = class_cfr_set()
    return {g: {r[0]: r[3] for r in p['residues'] if r[3] in top} for g, p in packs.items()}


def test_positions_are_the_class_cfr_set_in_rank_order(built):
    ranks = class_cfr_ranks()
    s = built['summary']
    assert [p['generic'] for p in s['positions']] == sorted(class_cfr_set(), key=ranks.get)
    assert [p['cfr_rank'] for p in s['positions']] == list(range(1, 51))
    assert s['coverage']['receptors'] == s['coverage']['receptors_with_pack'] == 283


def test_counts_equal_the_packs(built, packs):
    s = built['summary']
    top = _top_residues(packs)
    alleles, subs, ac, am_a, am_s, plp, numbered = Counter(), Counter(), Counter(), Counter(), Counter(), Counter(), Counter()
    seen = set()
    for g, p in packs.items():
        for pos, gn in top[g].items():
            numbered[gn] += 1
        for v in p.get('variants') or []:
            gn = top[g].get(v[0])
            if gn is None:
                continue
            alleles[gn] += 1
            ac[gn] += v[6]
            code = pack_layer.am_of(p, v[0], v[1], v[2])[1]
            am_a[CODE.get(code, 'unscored')] += 1
            if (g, v[0], v[1], v[2]) not in seen:
                seen.add((g, v[0], v[1], v[2]))
                subs[gn] += 1
                am_s[CODE.get(code, 'unscored')] += 1
        for c in p.get('clinvar') or []:
            if c[0] in top[g]:
                plp[top[g][c[0]]] += 1
    for pos in s['positions']:
        gn = pos['generic']
        assert (pos['alleles'], pos['substitutions'], pos['allele_count'], pos['clinvar']['plp_db'],
                pos['receptors_numbered']) == (alleles[gn], subs[gn], ac[gn], plp[gn], numbered[gn]), gn
        assert sum(pos['am_substitutions'].values()) == pos['substitutions']
        assert sum(pos['am_alleles'].values()) == pos['alleles']
    tot = lambda k: sum(p[k] for p in s['positions'])
    assert tot('alleles') == sum(alleles.values()) and tot('substitutions') == sum(subs.values())
    for cls in ('benign', 'ambiguous', 'pathogenic', 'unscored'):
        assert sum(p['am_substitutions'][cls] for p in s['positions']) == am_s[cls]
        assert sum(p['am_alleles'][cls] for p in s['positions']) == am_a[cls]
    assert s['totals_check']['alleles_in_packs'] == sum(len(p.get('variants') or []) for p in packs.values())


def test_groups_partition_the_generic_numbered_residues(built, packs):
    s = built['summary']
    g = {x['key']: x for x in s['groups']}
    top = g['top50']
    for k in ('alleles', 'substitutions', 'allele_count', 'residues'):
        assert top[k] == sum(p[k] for p in s['positions'])
        assert g['other_generic'][k] == g['rank51_368'][k] + g['outside_catalog'][k]
    gn = {g: {r[0] for r in p['residues'] if r[3]} for g, p in packs.items()}
    numbered = sum(1 for g, p in packs.items() for v in p.get('variants') or [] if v[0] in gn[g])
    assert top['alleles'] + g['other_generic']['alleles'] == numbered
    assert (top['positions'], g['rank51_368']['positions']) == (50, 318)
    for x in s['groups']:
        assert sum(x['am_substitutions'].values()) == x['substitutions']


def test_receptor_files_add_up_to_the_summary(built):
    s, details = built['summary'], built['details']
    out = built['out'] / 'data/stats'
    assert len(list((out / 'cfr_variants').glob('*.json'))) == 50
    f = cv.DETAIL_FIELDS
    for pos in s['positions']:
        d = json.loads((built['out'] / pos['links']['detail']).read_text())
        assert d == json.loads(json.dumps(details[pos['generic']]))
        rows = d['rows']
        assert len(rows) == pos['receptors_numbered']
        for k in ('alleles', 'substitutions', 'benign', 'ambiguous', 'pathogenic', 'allele_count'):
            col = sum(r[f.index(k)] for r in rows)
            ref = pos[k] if k in pos else pos['am_substitutions'][k]
            assert col == ref, (pos['generic'], k)
        gene = s['receptors']['rows'][rows[0][0]][1]
        assert rows[0][f.index('search_q')] == '%s %s' % (gene, pos['generic'])
    assert all(r[3] == 'reports/%s.html' % r[0] for r in s['receptors']['rows'])
    lines = (out / 'cfr_variants.csv').read_text().splitlines()
    assert lines[0].startswith('# gnomAD') and 'paper' not in lines[0] and len(lines) == 2 + 50 + 4


def test_clinvar_counts_equal_search_v2(built, packs):
    if built['search2'] is None:
        pytest.skip('no search v2 build at %s (set STATS_SEARCH2_DIR)' % SEARCH2)
    s = built['summary']
    assert s['coverage']['clinvar_all_classes'] is True
    top = _top_residues(packs)
    rec, mis = Counter(), Counter()
    for g in packs:
        block = json.loads((built['search2'] / 'variants' / ('%s.json' % g)).read_text())['clinvar']
        f = block['fields']
        for row in block['rows']:
            gn = top[g].get(row[f.index('pos')])
            if gn:
                rec[gn] += 1
                mis[gn] += row[f.index('kind')] == 'missense'
    for pos in s['positions']:
        c = pos['clinvar']
        assert (c['records'], c['missense']) == (rec[pos['generic']], mis[pos['generic']])
        assert sum(c['missense_by_class'].values()) == c['missense'] == sum(c['missense_groups'].values())
        assert c['missense_groups']['plp'] >= c['plp_db']


def test_labels_come_from_the_registry_and_name_no_paper(built):
    s = built['summary']
    src = data_versions.load()['sources']
    assert 'layer' not in s and 'paper_layer' not in s['sources'] and 'not_paper' not in s
    for key in ('gnomad', 'clinvar', 'conservation', 'gpcrdb_numbering'):
        assert src[key]['label'] in s['label']
    assert 'paper' not in s['label'] and src['gnomad_batch']['label'] not in s['label']
    text = json.dumps(s, ensure_ascii=False)
    assert '\u2014' not in text and 'Non-CFR' not in text and 'non-CFR' not in text


def test_figures_order_and_tint(built):
    s = built['summary']
    fig = cv.fig_cfr_variants_by_position(s)
    x = list(fig.layout.xaxis.categoryarray)
    assert x[0].startswith('1.') and x[-3:] == ['34.53x53', '45.51x51', '45.52x52']     # helices first
    seq = list(cv.fig_cfr_variants_by_position(s, order='sequence').layout.xaxis.categoryarray)
    assert seq.index('3.50x50') < seq.index('34.53x53') < seq.index('45.51x51') < seq.index('5.35x36')
    for t in fig.data:
        assert t.marker.color == CLINICAL_TINT['light'][t.meta['path_class']]
    totals = [sum(t.y[i] for t in fig.data) for i in range(len(x))]
    assert all(math.isclose(v, 100.0) for v in totals)
    counts = cv.fig_cfr_variant_counts(s)
    by = {p['generic']: p for p in s['positions']}
    assert list(counts.data[0].y) == [by[g]['substitutions'] for g in counts.layout.xaxis.categoryarray]


# ---------------------------------------------------------------------------- conservation per residue
class _Store:
    gpcr_ids = ['a_human', 'b_human']
    delta_data = {
        'a_human': pd.DataFrame({'res1': [1, 1, 2], 'res2': [2, 3, 3], 'delta_rrcs': [-4.0, 1.0, 2.5]}),
        'b_human': pd.DataFrame({'res1': [5], 'res2': [6], 'delta_rrcs': [0.5]}),
    }
    cons = {'a_human': {1: 0.9, 2: 0.5, 3: 0.1}, 'b_human': {5: 0.7}}

    def report_conservation(self, gid):
        return self.cons[gid]


def test_conservation_counts_each_residue_once():
    df = conservation_by_residue(_Store())
    got = {(r.gpcr_id, r.position): (r.conservation, r.max_abs_delta) for r in df.itertuples()}
    assert got == {('a_human', 1): (0.9, 4.0), ('a_human', 2): (0.5, 4.0), ('a_human', 3): (0.1, 2.5),
                   ('b_human', 5): (0.7, 0.5)}            # residue 6 has no score: left out, not zero
    fig = make_conservation_density(df)
    assert sum(c[0] for row in fig.data[0].customdata for c in row) == 4
    assert '4 residues, 2 receptors' in fig.layout.title.text
