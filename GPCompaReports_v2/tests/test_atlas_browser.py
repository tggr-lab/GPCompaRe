"""The GPCRome Atlas in a browser: grouping rules, the Groups slider, the Tree layout and the
neighbor list.

Drives a built site (SEARCH_BUILD_DIR, SMOKE_BUILD_DIR or output_v3_demo, as the other browser
tests) and skips when atlas.html or atlas/rules.json is absent.

    SEARCH_BUILD_DIR=<build> .venv-test/bin/python -m pytest GPCompaReports_v2/tests/test_atlas_browser.py
"""
import pytest

pytest.importorskip('playwright.sync_api', reason='Playwright is not installed in this interpreter. Run from the project venv.')

from GPCompaReports_v2.tests.test_search_browser import (  # noqa: E402,F401  (fixtures)
    BLOCKED, BUILD_DIR, DESKTOP, PHONE_390, browser, server,
)

needs_build = pytest.mark.skipif(not ((BUILD_DIR / 'atlas.html').is_file() and (BUILD_DIR / 'atlas' / 'rules.json').is_file()),
                                 reason='no atlas.html with atlas/rules.json in %s' % BUILD_DIR)


@pytest.fixture
def atlas(browser, server):
    contexts = []

    def _open(hash_='', viewport=DESKTOP, scheme='light'):
        ctx = browser.new_context(viewport=viewport, color_scheme=scheme, reduced_motion='reduce',
                                  is_mobile=viewport is PHONE_390, has_touch=viewport is PHONE_390)
        contexts.append(ctx)
        page = ctx.new_page()
        page.errors = []
        page.on('pageerror', lambda e: page.errors.append(str(e)))
        page.on('console', lambda m: page.errors.append(m.text)
                if m.type == 'error' and m.location.get('url', '').startswith(server) else None)
        for pattern in BLOCKED:
            page.route(pattern, lambda route: route.abort())
        page.goto(server + '/atlas.html' + hash_, wait_until='load')
        page.wait_for_function('window.__atlas && window.__atlas.data')
        return page

    yield _open
    for c in contexts:
        c.close()


def _state(page):
    return page.evaluate('() => { const s = window.__atlas; return {rule: s.rule, k: s.k, groups: s.groupCount, '
                         'view: s.view, rules: s.rulesState, sel: s.sel}; }')


@needs_build
def test_rules_load_after_first_paint_and_the_slider_cuts_the_tree(atlas):
    page = atlas('#view=similarity')
    page.wait_for_function("window.__atlas.rulesState === 'ready'", timeout=20000)
    s = _state(page)
    assert (s['rule'], s['k'], s['groups']) == ('pattern', 12, 12)
    assert page.locator('#atlas-rule option').all_text_contents() == [
        'Contact pattern', 'Intracellular contacts', 'Extracellular contacts', 'Sequence',
    ]
    for k in (6, 30, 4, 40):
        page.locator('#atlas-k').fill(str(k))
        page.locator('#atlas-k').dispatch_event('input')
        assert _state(page)['groups'] == k
    assert 'k=40' in page.evaluate('() => new Promise(r => setTimeout(() => r(location.hash), 300))')
    assert page.errors == []


@needs_build
def test_rule_tree_and_neighbors_follow_the_rule(atlas):
    page = atlas('#view=tree&rule=sequence&k=8&receptor=adrb2_human')
    page.wait_for_function("window.__atlas.rulesState === 'ready' && window.__atlas.view === 'tree'", timeout=20000)
    page.wait_for_function('window.__atlas.sel >= 0')
    s = _state(page)
    assert (s['rule'], s['k'], s['groups']) == ('sequence', 8, 8)
    assert page.locator('#atlas-rule-note').inner_text() == 'Maximum-likelihood sequence tree'
    assert page.locator('#atlas-newick').is_visible()
    assert page.locator('#atlas-sim-h').inner_text() == 'Nearest receptors · Sequence'
    assert page.locator('.atlas-neighbor-head span').all_text_contents() == ['Receptor', 'Sequence identity', 'Contact pattern']
    assert page.locator('#atlas-panel-similar li').count() == 8
    assert page.locator('#atlas-panel-similar .sm-chip').count() == 0          # no contact pairs for sequence
    page.select_option('#atlas-rule', 'inner')
    page.wait_for_function("window.__atlas.rule === 'inner'")
    assert page.locator('#atlas-rule-note').inner_text() == 'Browsing aid, not a classification'
    assert not page.locator('#atlas-newick').is_visible()
    assert page.locator('#atlas-sim-h').inner_text() == 'Nearest receptors · Intracellular contacts'
    assert page.locator('.atlas-neighbor-head span').all_text_contents() == ['Receptor', 'Similarity', 'Sequence identity']
    assert page.locator('#atlas-panel-similar .sm-chip').count() > 0
    assert page.errors == []


@needs_build
def test_preview_pill_and_controls_fit_a_phone(atlas):
    page = atlas('#view=similarity', viewport=PHONE_390, scheme='dark')
    page.wait_for_function("window.__atlas.rulesState === 'ready'", timeout=20000)
    assert page.locator('.atlas-pill').is_visible()
    note = page.locator('#atlas-rule-note')
    assert note.is_visible() and note.inner_text() == 'Browsing aid, not a classification'
    width = page.evaluate('() => document.documentElement.scrollWidth')
    assert width <= 390
    slider = page.locator('#atlas-k').bounding_box()
    count = page.locator('#atlas-k-out').bounding_box()
    assert slider and count and count['y'] <= slider['y'] + slider['height'] / 2 <= count['y'] + count['height']
    assert page.errors == []


def _help_fully_on_top(page):
    return page.evaluate("""() => {
      const h = document.getElementById('atlas-help').getBoundingClientRect();
      return [[.05, .05], [.5, .5], [.95, .5], [.5, .95], [.95, .95]].every(([a, b]) => {
        const e = document.elementFromPoint(h.left + h.width * a, h.top + h.height * b);
        return !!(e && e.closest('#atlas-help'));
      });
    }""")


@needs_build
@pytest.mark.parametrize('viewport,scheme', [(DESKTOP, 'light'), ({'width': 768, 'height': 900}, 'dark'), (PHONE_390, 'dark')])
def test_help_card_sits_above_an_open_receptor_panel(atlas, viewport, scheme):
    page = atlas('#receptor=drd2_human', viewport=viewport, scheme=scheme)
    page.wait_for_function('window.__atlas.sel >= 0')
    page.wait_for_timeout(300)
    key = page.get_by_role('button', name='Key', exact=True)
    key.click()
    assert key.get_attribute('aria-expanded') == 'true'
    assert page.locator('#atlas-help').is_visible()
    assert page.locator('#atlas-help').get_by_role('heading', name='Key').is_visible()
    assert page.locator('#atlas-key-example').inner_text() == 'ADRB2'
    assert page.locator('#atlas-key-glyph').bounding_box()['width'] >= 220
    leaders = page.locator('#atlas-key-diagram path')
    assert leaders.count() == 4 and leaders.evaluate_all('paths => paths.every(p => p.getTotalLength() > 0)')
    assert page.locator('#atlas-key-scale span').all_text_contents() == ['Inactive stronger', 'Active stronger']
    assert page.locator('#atlas-help').get_by_role('link', name='Glossary').get_attribute('href') == 'glossary.html'
    assert _help_fully_on_top(page)
    page.keyboard.press('Escape')
    assert not page.locator('#atlas-help').is_visible()
    assert key.get_attribute('aria-expanded') == 'false'
    assert key.evaluate('button => document.activeElement === button')
    assert page.errors == []


@needs_build
def test_panel_family_line_is_not_faded_until_the_body_scrolls(atlas):
    page = atlas('#receptor=drd2_human')
    page.wait_for_function('window.__atlas.sel >= 0')
    mask = 'getComputedStyle(document.getElementById("atlas-panel-body")).maskImage'
    assert page.evaluate(mask) == 'none'
    page.evaluate('document.getElementById("atlas-panel-body").scrollTop = 80')
    page.wait_for_function('document.getElementById("atlas-panel").classList.contains("is-scrolled")')
    assert page.evaluate(mask) != 'none'


@needs_build
@pytest.mark.parametrize('query,symbol', [
    ('dopamine d2', 'DRD2'), ('d2 dopamine', 'DRD2'), ('mu opioid', 'OPRM1'), ('melanocortin 4', 'MC4R'),
    ('serotonin', 'HTR1A'), ('P07550', 'ADRB2'), ('adrenoceptor beta', 'ADRB1'),
    ('drd2', 'DRD2'), ('mu-type', 'OPRM1'), ('beta 2', 'ADRB2')])
def test_find_box_matches_each_word_on_its_own(atlas, query, symbol):
    page = atlas()
    page.wait_for_function("window.__atlas.data.byGid['drd2_human'] && window.__atlas.data.byGid['drd2_human'].uniprot", timeout=20000)
    page.fill('#atlas-search-input', query)
    rows = page.locator('#atlas-suggest li .sg-sym').all_inner_texts()
    assert symbol in rows, (query, rows)
    assert rows[0] == symbol or query in ('serotonin', 'adrenoceptor beta'), (query, rows)
    page.fill('#atlas-search-input', 'zzzz qq')
    assert page.locator('#atlas-suggest .sg-empty').count() == 1


@needs_build
def test_phone_lens_row_cues_the_chips_and_shows_the_whole_readout(atlas):
    page = atlas('', viewport=PHONE_390, scheme='dark')
    page.wait_for_function("document.querySelector('.atlas-chips').classList.contains('has-more-right')")
    assert page.evaluate('document.documentElement.scrollWidth') <= 390
    page.click('.atlas-chip[data-gn="6.48x48"]')
    page.wait_for_function("document.getElementById('atlas-lens').classList.contains('has-lens')")
    box = page.evaluate("""() => { const e = document.getElementById('atlas-lens-readout');
      return {clipped: e.scrollHeight > e.clientHeight + 1, text: e.textContent}; }""")
    assert not box['clipped'], box
    p = page.evaluate("window.__atlas.data.positions.find(p => p.gn === '6.48x48')")
    assert box['text'] == f"6.48x48 · TM6 · ↑ {p['n_up']} ↓ {p['n_down']}"
    assert page.locator('#atlas-ruler-axis span').all_text_contents() == ['↑ Active stronger', '↓ Inactive stronger']
    accessible = page.locator('#atlas-ruler').get_attribute('aria-valuetext')
    assert f"{p['n_up']} active stronger" in accessible and f"{p['n_down']} inactive stronger" in accessible
    assert page.evaluate('document.documentElement.scrollWidth') <= 390
    assert page.errors == []


@needs_build
def test_fingerprint_score_and_missing_cells_follow_the_layer(atlas):
    page = atlas('#view=fingerprints')
    legend = page.locator('#atlas-legend')
    assert 'No contact' in legend.inner_text() and 'Absent' in legend.inner_text()
    page.select_option('#atlas-color', 'am')
    page.wait_for_function("document.querySelector('#atlas-legend').innerText.includes('No score')")
    assert legend.locator('.lg-ends span').all_text_contents() == [
        '0 · predicted benign', 'ambiguous', '1 · predicted pathogenic',
    ]
    assert 'Absent' in legend.inner_text() and 'No contact' not in legend.inner_text()


@needs_build
def test_panel_strip_keyboard_pin_and_pointer_leave(atlas):
    page = atlas('#receptor=adrb2_human')
    strip = page.get_by_role('slider', name='Fingerprint position')
    strip.focus()
    strip.press('ArrowRight')
    strip.press('Enter')
    assert strip.get_attribute('aria-valuenow') == '2'
    assert page.evaluate('window.__atlas.lensPin') == 1
    strip.hover()
    page.mouse.move(0, 0)
    assert page.locator('#atlas-strip-readout').inner_text() == 'Net ΔRRCS by position'
    assert page.errors == []
