"""The Statistics page in a browser: the selection, the position profile, exports and small layouts.

Each test pins one behavior a reader relies on:

  * the recovery curve is read by structure position: every generic number of a structure position finds it;
  * the position profile stays where the reader left it: no jump back after a scroll, no move or focus loss
    when a second position or a receptor is picked, no rebuild after an in-page #anchor link, no profile that
    nobody asked for after a 4e row;
  * on a phone a shared link opens the profile folded to one line, the handle folds and unfolds it, and a tap
    on the page folds it without clearing the position;
  * an exported SVG keeps its title, scope line and legend inside the export width;
  * small layouts (768 and 320 px) keep labels inside their bars and tabs;
  * the explorer scatter draws the figure asked for last, even when Plotly arrives late; its clear button names
    what it clears and leaves with the scatter;
  * without JavaScript no control is shown that would do nothing.

    SEARCH_BUILD_DIR=<build> .venv-test/bin/python -m pytest GPCompaReports_v2/tests/test_statistics_interactions.py
"""
import re

import pytest

pytest.importorskip('playwright.sync_api', reason='Playwright is not installed in this interpreter. Run from the project venv.')
from playwright.sync_api import expect  # noqa: E402

from GPCompaReports_v2.tests.test_search_browser import DESKTOP, PHONE_390, browser, server  # noqa: E402,F401
from GPCompaReports_v2.tests.test_statistics_browser import (  # noqa: E402,F401
    PLOTLY_LOCAL, STATS, _errors, _no_horizontal_scroll, _settle, needs_build, needs_plotly, open_page,
)

WIDE = {'width': 1440, 'height': 900}


def _click_row(page, gn):
    page.locator('#chart-ranking [aria-label="Open the profile of %s"]' % gn).click()


def _profile(page):
    return page.evaluate("""() => { const p = document.querySelector('.pos-profile'); if (!p) return null;
        const r = p.getBoundingClientRect();
        return { gn: p.querySelector('.pgn').textContent, top: p.style.top, rectTop: r.top, rectBottom: r.bottom,
                 focused: document.activeElement === p || p.contains(document.activeElement),
                 peek: p.classList.contains('is-peek'), height: r.height }; }""")


# ------------------------------------------------------------------------------------------- recovery
@needs_build
def test_the_recovery_curve_is_read_by_structure_position(open_page):
    page = open_page('/statistics.html?sel=pos:6.46x46')
    _settle(page, ['chart-recovery'])
    note = page.locator('#card-chart-recovery [data-rec-note]').inner_text()
    assert 'shares structure position 6x46 with 6.45x46' in note and 'rank 212 of the 262' in note, note
    assert 'fewer than half' not in note
    page = open_page('/statistics.html?sel=pos:6.45x46')
    _settle(page, ['chart-recovery'])
    note = page.locator('#card-chart-recovery [data-rec-note]').inner_text()
    assert note.startswith('6.45x46 (structure position 6x46) is at rank 212 of the 262'), note
    page = open_page('/statistics.html?sel=pos:6.48x48')
    _settle(page, ['chart-recovery'])
    assert '6.48x48: rank 2 of 262, a known position' in page.locator('#chart-recovery').inner_text()
    assert '262 structure positions' in page.locator('.cov-table').inner_text()
    assert 'half' in page.locator('.cov-table').inner_text()


@needs_build
def test_the_segment_chart_names_the_segment_it_leaves_out(open_page):
    page = open_page()
    _settle(page, ['chart-segments'])
    assert 'ICL4 omitted: 35 endpoints (minimum 50)' in page.locator('#chart-segments').inner_text()
    labels = page.evaluate("Array.from(document.querySelectorAll('#chart-segments text')).map(t => t.textContent)")
    assert 'ICL4' not in labels and 'ECL2' in labels


# ------------------------------------------------------------------------------------------- the profile
@needs_build
def test_a_scroll_after_opening_the_profile_is_not_undone(open_page):
    page = open_page(viewport=WIDE)
    _settle(page, ['chart-ranking'])
    page.locator('#card-chart-ranking').scroll_into_view_if_needed()
    _click_row(page, '3.50x50')
    page.wait_for_timeout(250)
    y0 = page.evaluate('scrollY')
    for _ in range(8):
        page.mouse.wheel(0, 250)
    page.wait_for_timeout(1500)
    y = page.evaluate('scrollY')
    page.wait_for_timeout(600)
    assert page.evaluate('scrollY') == y
    assert y > y0 + 1000, (y0, y)


@needs_build
def test_a_second_position_and_a_receptor_keep_the_profile_in_place(open_page):
    page = open_page(viewport=WIDE)
    _settle(page, ['chart-ranking'])
    page.locator('#card-chart-ranking').scroll_into_view_if_needed()
    _click_row(page, '6.58x58')
    page.wait_for_timeout(700)
    _click_row(page, '7.50x50')
    page.wait_for_timeout(700)
    p = _profile(page)
    assert p['gn'].startswith('7.50x50') and p['focused'], p
    assert p['top'] != '104px' and 0 <= p['rectTop'] < 900, p
    before = p['top']
    page.evaluate("StatsSel.set({ rec: 'hrh1_human' })")
    page.wait_for_timeout(700)
    p = _profile(page)
    assert p['top'] == before and p['focused'] and 0 <= p['rectTop'] < 900, p
    assert 'HRH1' in page.locator('.pos-profile').inner_text()
    assert _errors(page) == []


@needs_build
def test_an_anchor_link_redraws_nothing(open_page):
    page = open_page(viewport=WIDE)
    _settle(page, ['chart-ranking'])
    _click_row(page, '6.58x58')
    page.wait_for_timeout(700)
    top = _profile(page)['top']
    page.evaluate("window.__sel = 0; document.addEventListener('gpc:stats-select', () => window.__sel++)")
    page.locator('.rail-list a[href="#sec-d"]').click()
    page.wait_for_timeout(600)
    assert page.evaluate('window.__sel') == 0
    assert _profile(page)['top'] == top
    page.go_back()
    page.wait_for_timeout(600)
    assert page.evaluate('window.__sel') == 0 and 'sel=pos:6.58x58' in page.url


@needs_build
def test_a_variants_row_opens_no_profile_later(open_page):
    page = open_page(viewport=WIDE)
    _settle(page, ['chart-cfr-variants'])
    page.locator('#chart-cfr-variants g[data-gn="3.49x49"] [data-hit]').first.click()
    page.wait_for_timeout(800)
    assert 'sel=pos:3.49x49' in page.url and page.locator('.pos-profile').count() == 0
    top = "document.getElementById('card-chart-cfr-variants').getBoundingClientRect().top"
    y = page.evaluate(top)
    page.evaluate("StatsSel.set({ rec: 'ccr5_human' })")
    page.wait_for_timeout(1200)
    assert page.locator('.pos-profile').count() == 0
    # the card stays where the reader sees it: cards above may grow (the helix card adds the receptor's own bundle
    # when it has loaded), and scroll anchoring keeps the view in place
    assert abs(page.evaluate(top) - y) < 50


@needs_build
def test_the_phone_sheet_folds_and_keeps_the_position(open_page):
    page = open_page('/statistics.html?sel=pos:6.48x48', viewport=PHONE_390)
    prof = page.locator('.pos-profile')
    expect(prof).to_be_visible(timeout=15000)
    page.wait_for_timeout(300)
    p = _profile(page)
    assert p['peek'] and p['height'] < 90, p   # a shared link opens folded
    assert '6.48x48 · rank 2 by CFR score · CFR in 245 of 283' in prof.locator('.ppeek').inner_text()
    prof.locator('.handle').click()
    page.wait_for_timeout(200)
    p = _profile(page)
    assert not p['peek'] and p['height'] > 200, p
    assert prof.locator('.handle').get_attribute('aria-expanded') == 'true'
    page.locator('.stats-head h1').click()   # a tap on the page folds the sheet
    page.wait_for_timeout(200)
    assert _profile(page)['peek'] and 'sel=pos:6.48x48' in page.url
    prof.locator('.x').click()
    expect(prof).to_have_count(0)
    assert 'sel=' not in page.url
    assert _no_horizontal_scroll(page)


@needs_build
def test_the_profile_bars_follow_the_theme(open_page):
    page = open_page('/statistics.html?sel=pos:6.48x48', viewport=WIDE)
    expect(page.locator('.pos-profile .pbar i').first).to_be_visible(timeout=15000)
    light = page.evaluate("getComputedStyle(document.querySelector('.pos-profile .pbar i')).backgroundColor")
    page.locator('#theme-toggle, .theme-toggle').first.click()
    page.wait_for_timeout(300)
    dark = page.evaluate("getComputedStyle(document.querySelector('.pos-profile .pbar i')).backgroundColor")
    want = page.evaluate("getComputedStyle(document.querySelector('.stats')).getPropertyValue('--st-inactive').trim()")
    assert light != dark
    assert page.evaluate("c => { const d = document.createElement('i'); d.style.color = c; document.body.appendChild(d);"
                         " const v = getComputedStyle(d).color; d.remove(); return v; }", want) == dark


# ------------------------------------------------------------------------------------------- strip, rail, explorer
@needs_build
def test_every_strip_column_can_be_picked(open_page):
    page = open_page(viewport=WIDE)
    _settle(page, ['chart-ranking'])
    hh = page.evaluate("Array.from(document.querySelectorAll('[data-strip368] rect.hitcol')).map(r => +r.getAttribute('height'))")
    assert len(hh) == 368 and min(hh) >= 70


@needs_build
def test_the_rail_marks_nothing_above_the_first_section(open_page):
    page = open_page(viewport=WIDE)
    page.locator('.rail-list a[href="#sec-e"]').click()
    page.wait_for_timeout(1200)
    assert page.locator('.rail-list a.is-current').count() == 1
    page.evaluate('scrollTo(0, 0)')
    page.wait_for_timeout(800)
    assert page.locator('.rail-list a.is-current').count() == 0


@needs_build
@needs_plotly
def test_the_explorer_clear_button_names_the_selection_and_stays_with_the_scatter(open_page):
    page = open_page('/statistics.html?sel=pair:TM3-TM6', viewport=WIDE)
    _settle(page, ['chart-receptors'])
    card = page.locator('#card-chart-receptors')
    back = card.locator('[data-back]')
    expect(back).to_have_text('Clear TM3-TM6, back to ligand colors', timeout=10000)
    card.locator('[data-ctl="tab"] button[data-value="families"]').click()
    page.wait_for_timeout(300)
    assert card.locator('[data-back]').count() == 0
    card.locator('[data-ctl="tab"] button[data-value="table"]').click()
    page.wait_for_timeout(300)
    assert card.locator('[data-back]').count() == 0


@needs_build
@needs_plotly
def test_a_redraw_asked_for_while_plotly_loads_is_drawn(browser, server):
    held = []
    ctx = browser.new_context(viewport=WIDE)
    page = ctx.new_page()
    page.route('**cdn.plot.ly/**', lambda route: held.append(route))
    page.goto(server + '/statistics.html#card-chart-receptors', wait_until='domcontentloaded')   # the held script delays load
    page.locator('#card-chart-receptors').scroll_into_view_if_needed()
    page.wait_for_timeout(1500)
    card = page.locator('#card-chart-receptors')
    card.locator('[data-ctl="axes"] button[data-value="share_active"]').first.click()
    page.wait_for_timeout(200)
    for _ in range(50):
        if held:
            break
        page.wait_for_timeout(100)
    assert held, 'Plotly was never requested'
    held[0].fulfill(status=200, content_type='application/javascript', body=PLOTLY_LOCAL.read_bytes())
    page.wait_for_function("() => { const d = document.getElementById('chart-receptors-plot'); return d && d.layout; }",
                           timeout=20000)
    page.wait_for_timeout(800)
    title = page.evaluate("document.getElementById('chart-receptors-plot').layout.xaxis.title.text")
    assert title == 'Share stronger in the active model', title
    ctx.close()


# ------------------------------------------------------------------------------------------- exports
def _svg_export(page, card_id, export_name=None):
    card = page.locator('#card-' + card_id)
    card.locator('[data-export-toggle]').click()
    with page.expect_download(timeout=20000) as dl:
        card.locator('[data-export="svg"]').click()
    return open(dl.value.path(), encoding='utf-8').read()


def _overflow(page, svg):
    """Text nodes of an exported SVG that run past its width, measured in the browser."""
    return page.evaluate("""svg => { const box = document.createElement('div'); box.innerHTML = svg.replace(/^<\\?xml[^>]*>/, '');
        document.body.appendChild(box); const s = box.querySelector('svg'), W = +s.getAttribute('width'), out = [];
        s.querySelectorAll(':scope > text').forEach(t => { const b = t.getBBox(); if (b.x + b.width > W + 1) out.push(t.textContent); });
        box.remove(); return out; }""", svg)


@needs_build
@pytest.mark.parametrize('viewport', ['wide', 'phone'])
def test_exports_keep_title_scope_and_legend_inside(open_page, viewport):
    vp = WIDE if viewport == 'wide' else PHONE_390
    page = open_page(viewport=vp)
    for cid in ('chart-helix-pairs', 'chart-recovery', 'chart-pathogenicity'):
        _settle(page, [cid])
        svg = _svg_export(page, cid)
        assert _overflow(page, svg) == [], (cid, _overflow(page, svg))
        text = re.sub(r'<[^>]+>', ' ', svg)
        assert 'GPCompaRe database, statistics.html#card-' + cid in re.sub(r'\s+', ' ', text)
        if cid == 'chart-helix-pairs':
            assert 'Inactive stronger' in text and 'Active stronger' in text
        if cid == 'chart-pathogenicity':
            assert 'predicted pathogenic' in text and 'predicted benign' in text
        page.keyboard.press('Escape')
    assert _errors(page) == []


# ------------------------------------------------------------------------------------------- small layouts
@needs_build
def test_bar_labels_fit_their_segments_at_768(open_page):
    page = open_page(viewport={'width': 768, 'height': 900})
    _settle(page, ['chart-pathogenicity'])
    bad = page.evaluate("""() => { const s = document.querySelector('#chart-pathogenicity svg'), out = [];
        const rects = Array.from(s.querySelectorAll('rect[data-tip]'));
        s.querySelectorAll('text').forEach(t => { if (!/^[\\d.]+%$/.test(t.textContent)) return;
          const b = t.getBBox(), cy = b.y + b.height / 2;
          const r = rects.find(r => { const rb = r.getBBox(); return cy > rb.y && cy < rb.y + rb.height && b.x >= rb.x - 1 && b.x <= rb.x + rb.width; });
          if (!r) return; const rb = r.getBBox();
          if (b.x + b.width > rb.x + rb.width + 1 || b.x < rb.x - 1) out.push(t.textContent); });
        return out; }""")
    assert bad == []


@needs_build
def test_tabs_and_labels_fit_at_320(open_page):
    page = open_page(viewport={'width': 320, 'height': 844})
    _settle(page, ['chart-partners', 'chart-pathogenicity'])
    clipped = page.evaluate("""() => Array.from(document.querySelectorAll('.tabs button')).filter(b => {
        const r = b.getBoundingClientRect(), p = b.parentElement.getBoundingClientRect();
        return r.width && (r.right > p.right + 1 || r.left < p.left - 1); }).map(b => b.textContent)""")
    assert clipped == []
    overlap = page.evaluate("""() => { const t = Array.from(document.querySelectorAll('#chart-pathogenicity text')).map(e => e.getBBox ? [e.textContent, e.getBBox()] : null);
        const out = [];
        t.forEach(([a, ba]) => t.forEach(([b, bb]) => { if (a < b && ba.x < bb.x + bb.width && bb.x < ba.x + ba.width && ba.y < bb.y + bb.height && bb.y < ba.y + ba.height) out.push(a + ' / ' + b); }));
        return out; }""")
    assert overlap == []
    assert _no_horizontal_scroll(page)


@needs_build
def test_the_abs_symbol_does_not_break(open_page):
    html = STATS.read_text(encoding='utf-8')
    assert '<span class="nw">|ΔRRCS|</span>' in html
    assert '<span class="nw">' not in ''.join(re.findall(r'<svg\b.*?</svg>', html, re.S))
    page = open_page(viewport=WIDE)
    assert page.evaluate("getComputedStyle(document.querySelector('.nw')).whiteSpace") == 'nowrap'


@needs_build
def test_without_javascript_no_dead_controls(browser, server):
    ctx = browser.new_context(java_script_enabled=False, viewport=DESKTOP)
    page = ctx.new_page()
    page.goto(server + '/statistics.html', wait_until='load')
    for sel in ('.controls', '.chips', '.tabs', '.seg'):
        loc = page.locator('.stats ' + sel)
        for i in range(loc.count()):
            assert not loc.nth(i).is_visible(), sel
    assert page.locator('#cfr-table').is_visible()
    ctx.close()


# ------------------------------------------------------------------------------------------- recurrent pairs
@needs_build
def test_most_recurrent_pairs_mark_the_followed_position(open_page):
    page = open_page('/statistics.html?sel=pos:3.40x40', viewport=WIDE)
    card = page.locator('[data-chart="chart-partners"]')
    card.scroll_into_view_if_needed()
    page.wait_for_timeout(600)
    page.click('button[data-value="pairs"]')
    page.wait_for_timeout(600)
    marked = page.evaluate("[...document.querySelectorAll('#chart-partners rect[data-sel]')].map(r => r.nextElementSibling.textContent)")
    assert marked and all('3.40x40' in t for t in marked), marked
    assert page.evaluate("[...document.querySelectorAll('#chart-partners text')].filter(t => /3\\.40x40 · /.test(t.textContent)).length") == len(marked)
    assert _errors(page) == []
