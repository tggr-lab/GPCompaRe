"""The report changes of the final pass (owner approval 2026-11-05, FINAL_IMPLEMENTATION_PLAN.md A).

Built HTML (FREEZE_BUILD_DIR): the approved wording is on every report, with this receptor's
threshold; the AlphaMissense intervals are the published ones; the summary points to Understanding
the results; the TM table carries its fine print outside the frozen section; the header tiles say
"model". In a browser (SNAKE_BUILD_DIR, the snake-plus fixtures): the summary link opens the
collapsible, TM values take the colour of their own sign, the residue drawer opens away from the
selection, the slider has no hidden display cutoff, and no glossary underline sits in a section
heading or doubles the ΔRRCS header tooltip.
"""
import os
import re
from pathlib import Path

import pytest

from .report_files import report_pages

BASE = Path(__file__).resolve().parent.parent
_env = os.environ.get('FREEZE_BUILD_DIR')
BUILD = Path(_env).expanduser() if _env else BASE / 'output_v3_demo'
if not BUILD.is_absolute():
    BUILD = BASE / BUILD
REPORTS = BUILD / 'reports'
needs_build = pytest.mark.skipif(not REPORTS.is_dir(), reason='no build at %s; set FREEZE_BUILD_DIR' % BUILD)
SECTION_RE = re.compile(r'<section class="report-section"[^>]*>(.*?)</section>', re.S)


def _pages():
    return report_pages(REPORTS) if REPORTS.is_dir() else []


@needs_build
def test_approved_wording_is_on_every_report_with_its_threshold():
    for path in _pages():
        html = path.read_text(encoding='utf-8')
        m = re.search(r'Medium \(([\d.]+) ≤ \|Δ\| &lt; 5\.0\)', html)
        assert m, path.stem
        thr = m.group(1)
        assert "Highlighted rows are at or above this receptor's threshold (|ΔRRCS| ≥ %s).</p>" % thr in html, path.stem
        assert html.count("Highlighted rows are at or above this receptor's threshold (|ΔRRCS| ≥ %s)" % thr) == 2, path.stem
        assert "reaches this receptor's threshold (|ΔRRCS| ≥ %s)." % thr in html, path.stem
        assert 'The 100 contact pairs with the largest |ΔRRCS|.' in html
        assert 'Up to 1,000 contact pairs, ranked by |ΔRRCS|.' in html
        for gone in ('major structural rearrangement', 'Rows above the receptor-specific', 'stronger in active.',
                     'When a protein changes shape', 'score ≥ 0.564', '0.34–0.563', 'The 0.2 floor ensures'):
            assert gone not in html, (path.stem, gone)
        assert 'Likely pathogenic</span>: score &gt; 0.564.' in html
        assert 'Ambiguous</span>: 0.34 ≤ score ≤ 0.564.' in html
        assert 'Classes follow the source predictions before display rounding.' in html
        assert '—' not in ''.join(SECTION_RE.findall(html)), path.stem


@needs_build
def test_additions_outside_the_frozen_sections():
    for path in _pages():
        html = path.read_text(encoding='utf-8')
        bodies = ''.join(SECTION_RE.findall(html))
        assert 'For an explanation of the scores and colours, see <a href="#sec-understanding" data-open-section="sec-understanding">Understanding the results</a>.' in html or 'id="sec-summary"' not in html
        if 'id="tm-summary-table"' in html:
            fine = 'This table uses partial annotations from residues in contact pairs with |ΔRRCS| ≥ 3.0. It does not summarize every residue in each helix.'
            assert fine in html and fine not in bodies, path.stem
        assert 'Largest increase' in html and 'Max Increase' not in html
        assert 'in active state' not in html and 'weakened most' not in html
        assert 'stronger in the active model. <span class="is-inactive">Blue:</span> stronger in the inactive model.</p>' in html or 'rx-caption' not in html


# ------------------------------------------------------------------ browser
pytest.importorskip('playwright.sync_api', reason='Playwright is not installed in this interpreter')
from .test_snake_plus import PAGES, browser, open_report, server  # noqa: E402,F401  (fixtures)

browser_build = pytest.mark.skipif(not PAGES, reason='no build with snake plots; set SNAKE_BUILD_DIR')
MAIN = 'adrb2_human' if 'adrb2_human' in PAGES else (PAGES[0] if PAGES else None)


@browser_build
def test_summary_link_opens_understanding(open_report):
    page = open_report(MAIN, scroll=False)
    assert page.evaluate("document.querySelector('#sec-understanding .collapsible-head').getAttribute('aria-expanded')") == 'false'
    page.evaluate("document.querySelector('.gpc-summary-fine').open = true")
    page.click('a[data-open-section="sec-understanding"]')
    page.wait_for_timeout(600)
    assert page.evaluate("document.querySelector('#sec-understanding .collapsible-head').getAttribute('aria-expanded')") == 'true'
    assert page.locator('#sec-understanding .collapsible-body').is_visible()
    top = page.evaluate("document.getElementById('sec-understanding').getBoundingClientRect().top")
    assert -5 < top < page.evaluate("window.innerHeight") - 100, top   # in view (it is the last section)
    assert not page.errors


@browser_build
def test_tm_values_take_the_colour_of_their_own_sign(open_report):
    page = open_report(MAIN, scroll=False)
    bad = page.evaluate("""() => Array.from(document.querySelectorAll('#tm-summary-table .tm-res')).filter(s => {
        const ok = (v, x) => v && v.classList.contains(x > 0 ? 'tm-sign-pos' : (x < 0 ? 'tm-sign-neg' : 'tm-sign-zero'));
        return !ok(s.querySelector('.tm-val-signed'), parseFloat(s.dataset.signed)) || !ok(s.querySelector('.tm-val-max'), parseFloat(s.dataset.max));
      }).length""")
    assert bad == 0
    # a residue in the active column whose largest single contact is negative shows blue under that metric
    has = page.evaluate("Array.from(document.querySelectorAll('#tm-summary-table td.is-active .tm-res')).some(s => parseFloat(s.dataset.max) < 0)")
    if has:
        page.click('.tm-metric-btn[data-tm-metric="max"]')
        cols = page.evaluate("""() => { const s = Array.from(document.querySelectorAll('#tm-summary-table td.is-active .tm-res')).find(s => parseFloat(s.dataset.max) < 0);
            return [getComputedStyle(s.querySelector('.tm-val-max')).color, getComputedStyle(s.closest('td')).color]; }""")
        assert cols[0] != cols[1], cols
    assert not page.errors


@browser_build
def test_drawer_opens_on_the_side_away_from_the_selection(open_report):
    page = open_report(MAIN)
    pos = page.evaluate("""() => { const cs = Array.from(document.querySelectorAll('#snake-plot-container circle.rcircle'))
        .filter(c => /^\\d+$/.test(c.id) && c.getBoundingClientRect().width > 0);
        cs.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
        return [parseInt(cs[0].id, 10), parseInt(cs[cs.length - 1].id, 10)]; }""")
    for res, want_left in ((pos[0], False), (pos[1], True)):
        page.locator('#snake-plot-container circle[id="%d"]' % res).scroll_into_view_if_needed()
        box = page.locator('#snake-plot-container circle[id="%d"]' % res).bounding_box()
        page.mouse.click(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
        page.wait_for_timeout(250)
        drawer = page.locator('#rx-drawer')
        if not drawer.is_visible():
            pytest.skip('this build opens no drawer on a residue click')
        dbox = drawer.bounding_box()
        assert (dbox['x'] + dbox['width'] / 2 < 640) == want_left, (res, dbox)
        page.keyboard.press('Escape')
    assert not page.errors


@pytest.mark.skipif('s1pr4_human' not in PAGES, reason='S1PR4 not in the build')
def test_slider_keeps_small_positive_scores(open_report):
    page = open_report('s1pr4_human')
    page.evaluate("window.SnakePlus.setState(1)")
    page.wait_for_timeout(100)
    cls = page.evaluate("(() => { const p = document.querySelector('#sp-arcs .sp-arc[data-a=\"80\"][data-b=\"143\"]'); return p ? p.getAttribute('class') + '|' + p.getAttribute('stroke-width') : null; })()")
    assert cls, 'no arc 80-143'
    klass, width = cls.split('|')
    assert 'is-absent' not in klass and float(width) > 0.5
    fine = page.evaluate("document.querySelector('.sp-fine').textContent")
    assert 'Intermediate slider values are linear interpolations of those scores; no intermediate structures or dynamics were calculated.' in fine
    assert 'nothing in between is simulated' not in fine
    assert not page.errors


@browser_build
def test_no_glossary_underline_in_section_headings_or_on_the_delta_header(open_report):
    page = open_report(MAIN, scroll=False)
    page.wait_for_timeout(500)
    assert page.evaluate("document.querySelectorAll('.report-section-head h2 .gloss-term').length") == 0
    assert page.evaluate("document.querySelectorAll('th[data-sort=\"delta\"] .gloss-term, th[data-sort=\"d\"] .gloss-term').length") == 0
    tip = page.evaluate("document.querySelector('#top-changes-table th[data-sort=\"delta\"]').getAttribute('data-tooltip')")
    assert tip == 'Active minus inactive. Red (positive): stronger in the active model. Blue (negative): stronger in the inactive model.'
    assert not page.errors


@browser_build
def test_contact_checkbox_is_calm(open_report):
    page = open_report(MAIN)
    assert page.evaluate("document.getElementById('snake-links-cb').checked")
    style = page.evaluate("(() => { const s = getComputedStyle(document.querySelector('.snake-links-toggle')); return [s.borderTopColor, s.backgroundColor]; })()")
    assert style[0] in ('rgba(0, 0, 0, 0)', 'transparent') and style[1] in ('rgba(0, 0, 0, 0)', 'transparent'), style
    assert not page.errors
