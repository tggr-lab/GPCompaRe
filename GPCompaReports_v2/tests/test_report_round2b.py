"""Report-page fixes from the second independent review (2026-11-04).

- the residue table's CSV export cannot carry a spreadsheet formula;
- the residue table's CFR flag comes from the table's own numbering, not from the
  snake plot's annotation layer (wrong for GPR3, GPR4 and XCR1);
- every chart is drawn exactly once while the lazily loaded Plotly is pending.

Build-level and browser checks read FREEZE_BUILD_DIR / SMOKE_BUILD_DIR (a stage or a
build) and skip without one; the unit checks need nothing.
"""
import csv as csvmod
import io
import json
import os
import pathlib
import re
import time

import pytest

from GPCompaReports_v2.website.page_generators import report_extras
from .test_report_round2 import (  # noqa: F401  (fixtures)
    BASE, BUILD_DIR, REPORTS_DIR, PLOTLY_JS, needs_build, needs_plotly, server, browser,
    open_report, _errors, _pages)

# The report annotation of these three was another receptor's until the 2026-11-05 refresh
# (analysis/pack_layer.py); their snake CFR marks now follow the right numbering like every other.
FIXED_LAYER = {'gpr3_human', 'gpr4_human', 'xcr1_human'}
JSON_RE = r'<script type="application/json" id="%s">(.*?)</script>'


def _json(html, sid):
    m = re.search(JSON_RE % sid, html, re.S)
    return json.loads(m.group(1)) if m else None


# --------------------------------------------------------------------------
# 2. CSV formula injection
# --------------------------------------------------------------------------

def _load_with_summary(page, patch):
    """Edit the residue summary the table reads before the block is opened."""
    page.evaluate("""(patch) => {
      var n = document.getElementById('residue-summary-data');
      var rows = JSON.parse(n.textContent);
      patch.forEach(function (p) { Object.assign(rows[p.i], p.set); });
      n.textContent = JSON.stringify(rows);
    }""", patch)


@needs_build
def test_residue_table_csv_neutralises_formulas_but_keeps_numbers_numeric(open_report):
    page = open_report('par2_human', wait=300)
    bad = ['=1+1', '+SUM(1,2)', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd', '=HYPERLINK("http://x","y")']
    _load_with_summary(page, [{'i': i, 'set': {'partner_at_max': v}} for i, v in enumerate(bad)])
    page.evaluate("document.getElementById('rx-residues').open = true")
    page.wait_for_timeout(300)
    text = page.evaluate('window.ReportExtras.residueTableCsv()')
    rows = list(csvmod.reader(io.StringIO(text)))
    head, body = rows[0], rows[1:]
    col = head.index('partner_at_largest')
    by_pos = {int(r[0]): r for r in body}
    summary = json.loads(page.evaluate("document.getElementById('residue-summary-data').textContent"))
    for i, v in enumerate(bad):
        cell = by_pos[summary[i]['position']][col]
        assert cell == "'" + v, (v, cell)
        assert not re.match(r'^[=+\-@\t\r]', cell)
    # no cell of any row starts with a formula character unless it is a plain number
    plain = re.compile(r'^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$')
    for r in body:
        for c in r:
            assert not (re.match(r'^[=+\-@\t\r]', c) and not plain.match(c)), c
    # negative numbers stay unprefixed numbers
    net = head.index('net_delta_rrcs')
    negs = [r[net] for r in body if r[net].startswith('-')]
    assert negs and all(re.match(r'^-\d+\.\d+$', c) for c in negs)
    assert all(re.match(r'^[+-]?\d+\.\d+$', r[net]) for r in body)
    assert _errors(page) == []


# --------------------------------------------------------------------------
# 3. CFR flags in the residue table
# --------------------------------------------------------------------------

def test_cfr_flags_use_the_numbering_the_table_shows():
    annotation = {'134': ['TM3', '3.50x50'], '217': ['TM5', '5.62x62'], '5': ['N-term', '']}
    top = {'3.50x50', '6.48x48'}
    assert report_extras.cfr_flags(annotation, top, [134, 217, 5, 99]) == {134: True}
    assert report_extras.cfr_flags(annotation, set(), [134]) == {}
    assert report_extras.cfr_flags(None, top, [134]) == {}


def test_residue_table_extras_flag_and_count_independent_of_annotation():
    import pandas as pd
    delta = pd.DataFrame({'res1': [134, 134, 10], 'res2': [20, 30, 40], 'delta_rrcs': [3.0, -0.5, -4.0]})
    out = report_extras.residue_table_extras(
        delta, 2.0, {134: 0.9}, {134: 0.5}, [10, 20, 30, 40, 134],
        annotation={'134': ['TM3', '3.50x50']}, cfr_generics={'3.50x50'})
    rows = out['rows']
    # 134: one contact at or above 2.0 (the -0.5 one is below); 10 and 40: the -4.0 pair
    assert rows['134'] == [1, 0.9, 0.5, 1]
    assert rows['10'][0] == 1 and rows['40'][0] == 1 and rows['30'][0] == 0
    assert [r[3] for k, r in rows.items() if k != '134'] == [0, 0, 0, 0]


def _stage_cfr_top():
    p = BUILD_DIR / 'search2' / 'meta.json'
    if not p.is_file():
        return None
    meta = json.loads(p.read_text(encoding='utf-8'))
    return {g for g, r in meta['cfrRank'].items() if r <= meta['cfrTop']}


@needs_build
def test_every_report_flags_cfr_residues_by_its_own_numbering_and_agrees_with_search():
    """All reports of the stage: the table's flag equals the search index's CFR marks, and
    the snake plot's marks are a subset of it (GPR3, GPR4 and XCR1 included since the refresh).
    The snake plot marks only residues that have a row in the database annotation file, so
    on the other receptors the table flags more, never fewer (reported, not hidden)."""
    top = _stage_cfr_top()
    if top is None:
        pytest.skip('no search2/meta.json in %s' % BUILD_DIR)
    checked, wrong_layer_seen = 0, set()
    for path in _pages():
        gid = path.stem
        sidx = BUILD_DIR / 'search2' / 'residues' / ('%s.json' % gid)
        if not sidx.is_file():
            continue
        html = path.read_text(encoding='utf-8')
        cfg, summary, snake = _json(html, 'rx-config'), _json(html, 'residue-summary-data'), _json(html, 'snake-plot-data')
        if not (cfg and summary and snake):
            continue
        positions = [r['position'] for r in summary]
        flags = set(report_extras.cfr_flags(cfg['annotation'], top, positions))
        search = {int(p) for p in json.loads(sidx.read_text(encoding='utf-8'))['cfr']}
        assert flags == search & set(positions), gid
        snake_cfr = {int(p) for p in snake['views']['cfr']['colors']}
        if gid in FIXED_LAYER:
            wrong_layer_seen.add(gid)
        assert snake_cfr <= flags, (gid, sorted(snake_cfr - flags))
        # pages built with the fix carry the flag in the table data, and it is the same set
        extra = _json(html, 'rx-residue-extra')
        rows = (extra or {}).get('rows', {})
        if rows and all(len(v) == 4 for v in rows.values()):
            assert {int(p) for p, v in rows.items() if v[3]} == flags, gid
        checked += 1
    assert checked >= 5
    if checked > 100:
        assert wrong_layer_seen == FIXED_LAYER


@needs_build
def test_gpr3_arg134_is_a_cfr_in_the_table():
    html = (REPORTS_DIR / 'gpr3_human.html').read_text(encoding='utf-8')
    rows = (_json(html, 'rx-residue-extra') or {}).get('rows', {})
    if not rows or len(rows['134']) != 4:
        pytest.skip('page built before the CFR flag moved into the table data')
    assert _json(html, 'rx-config')['annotation']['134'] == ['TM3', '3.50x50']
    assert rows['134'][3] == 1
    assert rows['134'][0] >= 1


@needs_build
def test_the_table_shows_gpr3_arg134_as_cfr_and_exports_yes(open_report):
    html = (REPORTS_DIR / 'gpr3_human.html').read_text(encoding='utf-8')
    rows = (_json(html, 'rx-residue-extra') or {}).get('rows', {})
    if not rows or len(rows['134']) != 4:
        pytest.skip('page built before the CFR flag moved into the table data')
    page = open_report('gpr3_human', wait=300)
    page.evaluate("document.getElementById('rx-residues').open = true")
    page.wait_for_timeout(300)
    cells = page.evaluate("""() => { var b = document.querySelector('button[data-rx-res="134"]');
      return [].map.call(b.closest('tr').cells, c => c.textContent); }""")
    assert cells[1] == '3.50x50' and cells[7] == 'Yes', cells
    lines = page.evaluate('window.ReportExtras.residueTableCsv()').splitlines()
    head = lines[0].split(',')
    row = next(l.split(',') for l in lines[1:] if l.split(',')[0] == '134')
    assert row[head.index('cfr')] == 'yes'
    assert _errors(page) == []


# --------------------------------------------------------------------------
# 4. Lazy Plotly: one newPlot per chart
# --------------------------------------------------------------------------

COUNTER = ("\n;(function(){var o=Plotly.newPlot;window.__np=[];"
           "Plotly.newPlot=function(g){window.__np.push(typeof g==='string'?g:g.id);"
           "return o.apply(this,arguments);};})();")

CHARTS = ['delta-chart', 'scatter-chart', 'residue-chart', 'tm-breakdown-chart']

SNAPSHOT = """() => {
  var out = {};
  document.querySelectorAll('.v2-chart[id]').forEach(function (el) {
    var gd = document.getElementById(el.id);
    out[el.id] = {
      rendered: el.dataset.chartRendered === '1',
      traces: gd.data ? gd.data.length : -1,
      groups: el.querySelectorAll('.trace').length,
      paths: el.querySelectorAll('svg path').length,
      nplots: el.querySelectorAll('.main-svg').length,
      expected: ((window.CHART_DATA || {})[el.id] || {data: []}).data.length
    };
  });
  return out;
}"""


def _open_delayed(browser, server, gid, delay, click_before=None):
    ctx = browser.new_context(viewport={'width': 1280, 'height': 900})
    page = ctx.new_page()
    page.errors, page.console_errors = [], []
    page.on('pageerror', lambda e: page.errors.append(str(e)))
    page.on('console', lambda m: m.type == 'error' and page.console_errors.append(
        (m.text, (m.location or {}).get('url', ''))))
    for pattern in ('**gc.zgo.at/**', '**fonts.googleapis.com/**', '**fonts.gstatic.com/**'):
        page.route(pattern, lambda route: route.abort())
    body = PLOTLY_JS.read_text(encoding='utf-8') + COUNTER

    def lib(route):
        time.sleep(delay)
        route.fulfill(body=body, content_type='application/javascript')

    page.route('**/cdn.plot.ly/**', lib)
    page.goto('%s/reports/%s.html' % (server, gid), wait_until='load')
    return ctx, page


def _wait_rendered(page, timeout=20000):
    page.wait_for_function(
        "() => { var c = document.querySelectorAll('.v2-chart[id]'); return c.length >= 4 && "
        "[].every.call(c, e => e.dataset.chartRendered === '1'); }", timeout=timeout)
    page.wait_for_timeout(400)


@needs_build
@needs_plotly
def test_each_chart_is_drawn_once_under_delayed_plotly_and_looks_the_same(browser, server):
    gid = 'par2_human'
    snaps = {}
    for label, delay in (('fast', 0.0), ('slow', 2.5)):
        ctx, page = _open_delayed(browser, server, gid, delay)
        try:
            _wait_rendered(page)
            np_calls = page.evaluate('window.__np')
            assert sorted(np_calls) == sorted(CHARTS), (label, np_calls)
            snaps[label] = page.evaluate(SNAPSHOT)
            for cid, s in snaps[label].items():
                assert s['rendered'] and s['traces'] == s['expected'] > 0, (label, cid, s)
            assert _errors(page) == []
        finally:
            ctx.close()
    assert snaps['fast'] == snaps['slow']


@needs_build
@needs_plotly
def test_tm_directional_toggle_works_when_pressed_before_and_after_the_chart_renders(browser, server):
    ctx, page = _open_delayed(browser, server, 'par2_human', 3.0)
    try:
        page.wait_for_selector('.tm-breakdown-toggle .tm-metric-btn[data-tm-view="directional"]', state='attached')
        # pressed while Plotly is still pending
        assert page.evaluate("typeof Plotly.version") == 'undefined'
        page.evaluate("document.querySelector('.tm-breakdown-toggle [data-tm-view=\"directional\"]').click()")
        _wait_rendered(page)
        page.wait_for_function("document.getElementById('tm-breakdown-chart').data[1].visible === true", timeout=10000)
        state = page.evaluate("""() => { var g = document.getElementById('tm-breakdown-chart');
          return [g.data[0].visible, g.data[1].visible, g.layout.yaxis.title.text]; }""")
        assert state[0] is False and state[1] is True and 'signed' in state[2], state
        # pressed after it rendered: back to absolute, then directional again
        page.evaluate("document.querySelector('.tm-breakdown-toggle [data-tm-view=\"absolute\"]').click()")
        page.wait_for_function("document.getElementById('tm-breakdown-chart').data[1].visible === false", timeout=10000)
        page.evaluate("document.querySelector('.tm-breakdown-toggle [data-tm-view=\"directional\"]').click()")
        page.wait_for_function("document.getElementById('tm-breakdown-chart').data[1].visible === true", timeout=10000)
        assert page.evaluate('window.__np.length') == 4
        assert _errors(page) == []
    finally:
        ctx.close()
