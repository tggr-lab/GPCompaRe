"""Every view on a report page uses the receptor's full GPCRdb numbering (the pack's), not the batch
annotation, which only lists the residues of pairs with |dRRCS| >= 3.0 (ADRB2: 53 of 413 residues, no TM1).

Built on the partial layer, the TM chart dropped whole helices and inflated the rest, the TM table left out
above-threshold residues, Largest changes and the residue summary lost generic numbers, and the snake plot's
CFR view (and the drawer, which reads it) marked 17 CFR residues on ADRB2 where the residue table marked 48.

The data tests need the batch run and the Studio packs (STUDIO_PACK_DIR) and skip otherwise. The page tests
read a build (FREEZE_BUILD_DIR or SMOKE_BUILD_DIR) and skip without one.
"""
import json
import os
import re
from collections import defaultdict
from pathlib import Path

import numpy as np
import pytest

from GPCompaReports_v2.analysis import pack_layer as pl
from GPCompaReports_v2.website.page_generators import gpcr_report_helpers as h
from GPCompaReports_v2.website.page_generators import gpcr_report_page as rp
from GPCompaReports_v2.website.page_generators import report_extras

from .report_files import report_pages
from .test_search_index_v2 import _batch_dir

TM = ['TM1', 'TM2', 'TM3', 'TM4', 'TM5', 'TM6', 'TM7']
SAMPLE = ['adrb2_human', 'ccr5_human', 'opsd_human', 'hrh1_human', 'gpr3_human', 'mtr1a_human', 'lpar2_human']


@pytest.fixture(scope='module')
def store():
    batch = _batch_dir()
    if not (batch / 'csv_data').exists():
        pytest.skip('no batch data at %s' % batch)
    if pl.pack_index() is None:
        pytest.skip('no Studio packs at %s' % pl.pack_dir())
    from GPCompaReports_v2.analysis.data_loader import GPCRDataStore
    st = GPCRDataStore(batch_dir=batch).load_all()
    st.load_report_layer(required=True)
    return st


def _pack_numbering(store, gid):
    pack = pl.load_pack(gid, store.report_layer.folder)
    return {int(r[0]): (r[2] or '', r[3] or '') for r in pack['residues']}


def test_full_map_is_the_pack_numbering_for_every_residue(store):
    """Every contact residue of every receptor is numbered, with the pack's segment and number (the
    numbering rx-config, the snake plot and the residue table show). MCHR1's pack skips some residues of
    its long N-terminus (isoform numbering); those stay unnumbered, all before TM1."""
    for gid in store.gpcr_ids:
        full = store.get_report_full_annotation_map(gid)
        pack = _pack_numbering(store, gid)
        for pos, (seg, gn) in pack.items():
            assert (full[pos]['protein_segment'], full[pos]['display_number']) == (seg, gn), (gid, pos)
        d = store.delta_data[gid]
        unnumbered = (set(d['res1']) | set(d['res2'])) - set(full)
        if gid == 'mchr1_human':
            tm1 = min(p for p, (seg, _gn) in pack.items() if seg == 'TM1')
            assert unnumbered and max(unnumbered) < tm1, unnumbered
        else:
            assert not unnumbered, (gid, sorted(unnumbered)[:10])


def test_family_wide_annotation_is_untouched(store):
    """The statistics page and the CFR ranking keep the batch annotation."""
    assert len(store.get_annotation_map('adrb2_human')) == 53
    assert len(store.get_report_annotation_map('adrb2_human')) == 53
    assert len(store.get_report_full_annotation_map('adrb2_human')) == 413


@pytest.mark.parametrize('gid', SAMPLE)
def test_tm_chart_and_table_cover_every_helix(store, gid):
    d = store.delta_data[gid]
    full = store.get_report_full_annotation_map(gid)
    seg = {p: a['protein_segment'] for p, a in full.items()}
    # chart: mean |dRRCS| over the pair endpoints in each helix, all seven helices
    vals = defaultdict(list)
    for a, b, dl in zip(d['res1'], d['res2'], d['delta_rrcs']):
        for p in (a, b):
            if seg.get(int(p)) in TM:
                vals[seg[int(p)]].append(abs(dl))
    fig = h._make_tm_breakdown(d, full, gid)
    tr = fig.data[0]
    assert list(tr.x) == TM
    assert [round(y, 6) for y in tr.y] == [round(float(np.mean(vals[s])), 6) for s in TM]
    # table: every residue whose largest contact or signed sum reaches the threshold, under its helix
    t = h._calc_significance_threshold(d)
    m = h._compute_residue_metrics(d, full)
    want = defaultdict(set)
    for _, r in m.iterrows():
        if seg.get(int(r['position'])) in TM and max(abs(r['active_minus_inactive']), abs(r['max_signed_delta'])) >= t:
            want[seg[int(r['position'])]].add(int(r['position']))
    got = {e['domain']: {x['position'] for x in e['active_residues'] + e['inactive_residues']}
           for e in h._build_tm_summary(d, full, t)}
    assert got == {s: want[s] for s in TM}


def test_adrb2_tm1_and_numbering(store):
    """The cases the finding named: ADRB2 TM1 holds Gly50 and Leu53; Gly50 is 1.49x49 in Largest changes."""
    gid = 'adrb2_human'
    d = store.delta_data[gid]
    full = store.get_report_full_annotation_map(gid)
    t = h._calc_significance_threshold(d)
    tm1 = next(e for e in h._build_tm_summary(d, full, t) if e['domain'] == 'TM1')
    listed = {x['position'] for x in tm1['active_residues'] + tm1['inactive_residues']}
    assert {50, 53} <= listed and tm1['range'] != '-'
    rows = h._get_top_changes(d, full, t, n=100)
    gly50 = next(r for r in rows if r['res1'] == 50 or r['res2'] == 50)
    assert (gly50['gpcrdb1'] if gly50['res1'] == 50 else gly50['gpcrdb2']) == '1.49x49'
    numbered = sum(1 for r in rows for p, g in ((r['res1'], r['gpcrdb1']), (r['res2'], r['gpcrdb2'])) if full.get(p, {}).get('display_number') and g)
    assert numbered == sum(1 for r in rows for p in (r['res1'], r['res2']) if full.get(p, {}).get('display_number'))


@pytest.mark.parametrize('gid', SAMPLE)
def test_cfr_marks_agree(store, gid):
    """The snake CFR view (and the drawer, which reads it) marks the residues the residue table marks."""
    d = store.delta_data[gid]
    full = store.get_report_full_annotation_map(gid)
    cfr = rp._cfr_generic_numbers()
    snake = json.loads(rp._patch_snake_views(json.dumps({'views': {}}), full, cfr, None))
    marked = {int(p) for p in snake['views']['cfr']['colors']}
    metrics = h._compute_residue_metrics(d, full)
    annotation = report_extras.residue_annotation(pl.load_pack(gid, store.report_layer.folder), full)
    flags = report_extras.cfr_flags(annotation, cfr, metrics['position'].tolist())
    assert set(flags) == marked & set(metrics['position'])
    assert len(marked) >= len(flags) > 30


# ------------------------------------------------------------------ built pages

def _build_dir():
    for k in ('FREEZE_BUILD_DIR', 'SMOKE_BUILD_DIR'):
        v = os.environ.get(k)
        if v and (Path(v) / 'reports').is_dir():
            return Path(v)
    return None


BUILD = _build_dir()
PAGES = [p for p in report_pages(BUILD / 'reports')] if BUILD else []


def _json(page, ident):
    m = re.search(r'<script type="application/json" id="%s">(.*?)</script>' % ident, page, re.S)
    return json.loads(m.group(1)) if m else None


@pytest.mark.skipif(not PAGES, reason='no build (set FREEZE_BUILD_DIR or SMOKE_BUILD_DIR)')
@pytest.mark.parametrize('path', PAGES, ids=lambda p: p.stem)
def test_built_page_numbering_agrees(path):
    page = path.read_text(encoding='utf-8')
    cfg = _json(page, 'rx-config') or {}
    ann = cfg.get('annotation') or {}
    snake = _json(page, 'snake-plot-data')
    extra = _json(page, 'rx-residue-extra')
    if snake and extra and ann:
        marked = set(((snake.get('views') or {}).get('cfr') or {}).get('colors', {}))
        table = {k for k, v in extra['rows'].items() if v[3]}
        assert table == marked & set(extra['rows']), path.stem
        assert '%d on this receptor' % len(marked) in snake['views']['cfr']['description'] or not marked
    m = re.search(r"window\.CHART_DATA\['tm-breakdown-chart'\] = (\{.*?\});\n", page)
    if m and ann:
        helices = {seg for seg, _gn in ann.values() if seg in TM}
        assert set(json.loads(m.group(1))['data'][0]['x']) == helices, path.stem
    # Largest changes: a residue the page numbers is shown with its number
    sec = page[page.find('id="sec-changes"'):]
    sec = sec[:sec.find('</section>')]
    for pos, shown in re.findall(r'<td>[A-Z]{3}(\d+)(?: <small class="muted">\(([^)]*)\)</small>)?</td>', sec):
        want = (ann.get(pos) or ['', ''])[1]
        assert shown == want, (path.stem, pos, shown, want)
