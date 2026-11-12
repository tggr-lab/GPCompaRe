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
    assert page.locator('#atlas-rule option').count() == 4
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
    assert 'neighbor joining' in page.locator('#atlas-caption').inner_text()
    assert page.locator('#atlas-newick').is_visible()
    assert page.locator('#atlas-sim-rule').inner_text() == 'Rule: Sequence.'
    assert page.locator('#atlas-panel-similar li').count() == 8
    assert page.locator('#atlas-panel-similar .sm-chip').count() == 0          # no contact pairs for sequence
    page.select_option('#atlas-rule', 'inner')
    page.wait_for_function("window.__atlas.rule === 'inner'")
    assert 'not a phylogeny' in page.locator('#atlas-caption').inner_text()
    assert not page.locator('#atlas-newick').is_visible()
    assert page.locator('#atlas-sim-rule').inner_text() == 'Rule: Intracellular side.'
    assert page.locator('#atlas-panel-similar .sm-chip').count() > 0
    assert page.errors == []


@needs_build
def test_preview_pill_and_controls_fit_a_phone(atlas):
    page = atlas('#view=similarity', viewport=PHONE_390, scheme='dark')
    page.wait_for_function("window.__atlas.rulesState === 'ready'", timeout=20000)
    assert page.locator('.atlas-pill').is_visible()
    width = page.evaluate('() => document.documentElement.scrollWidth')
    assert width <= 390
    assert page.locator('#atlas-k').is_visible()
    assert page.errors == []
