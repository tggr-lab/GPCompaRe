"""Fixes from the independent browser walk of the release candidate (2026-11-05).

The closed menu out of the Tab order, the selection bar's keyboard reach and phone layout,
links that name residues or pairs the page does not have, the snake filter's lower bound,
the line in place of a missing variant table, the game's board and keys, the variant table's
protein-change cell, and the neutral badges. Browser checks drive a built site in headless
Chromium (SMOKE_BUILD_DIR / FREEZE_BUILD_DIR, as tests/test_report_v3.py) and skip without
Playwright or a build.
"""
import json
import re

import pytest

from .test_report_v3 import (BUILD_DIR, REPORTS_DIR, SECTION_RE, DESKTOP, PHONE, needs_build,  # noqa: F401
                             server, browser, open_report, _pick, _html, _pages, _errors, _first_chip)

expect = pytest.importorskip('playwright.sync_api').expect

WIDE = {'width': 1366, 'height': 900}


def _focus_desc(page):
    return page.evaluate("""(() => { var e = document.activeElement; if (!e || e === document.body) return null;
      return {inMenu: !!e.closest('#mobile-drawer'), inBar: !!e.closest('#gpc-selbar'),
              cls: String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className)}; })()""")


# ---- 1. the closed menu is not in the Tab order, on every page ---------------------------

@needs_build
@pytest.mark.parametrize('path', ['index.html', 'statistics.html', 'glossary.html', 'report'])
def test_closed_menu_is_not_in_the_tab_order(open_report, browser, server, path):
    if path == 'report':
        page = open_report(_pick(), viewport=WIDE)
    else:
        if not (BUILD_DIR / path).is_file():
            pytest.skip('%s not in this build' % path)
        ctx = browser.new_context(viewport=WIDE)
        page = ctx.new_page()
        page.goto('%s/%s' % (server, path), wait_until='load')
        page.wait_for_timeout(300)
    menu = page.locator('#mobile-drawer')
    assert menu.get_attribute('aria-hidden') == 'true'
    assert page.evaluate("document.getElementById('mobile-drawer').inert") is True
    assert page.evaluate("getComputedStyle(document.getElementById('mobile-drawer')).visibility") == 'hidden'
    for _ in range(30):
        page.keyboard.press('Tab')
        f = _focus_desc(page)
        assert not (f and f['inMenu']), 'Tab reached the closed menu'
    if path != 'report':
        page.context.close()


@needs_build
def test_the_menu_opens_into_focus_and_closes_inert_on_a_phone(open_report):
    page = open_report(_pick(), viewport=PHONE)
    page.click('#mobile-nav-toggle')
    page.wait_for_timeout(300)
    assert page.evaluate("document.getElementById('mobile-drawer').inert") is False
    assert _focus_desc(page)['inMenu'], 'the first link takes the focus'
    page.keyboard.press('Escape')
    page.wait_for_timeout(300)
    assert page.evaluate("document.getElementById('mobile-drawer').inert") is True
    assert page.evaluate("document.activeElement.id") == 'mobile-nav-toggle'
    assert _errors(page) == []


# ---- 2. the bar is one Tab away from a keyboard selection --------------------------------

@needs_build
def test_a_keyboard_selection_hands_the_next_tab_to_the_bar(open_report):
    page = open_report(_pick())
    # in the page order between the summary and the first report section (its place on
    # screen stays fixed)
    assert page.evaluate("""(() => { var b = document.getElementById('gpc-selbar');
      var F = Node.DOCUMENT_POSITION_FOLLOWING;
      return !!(document.getElementById('sec-summary').compareDocumentPosition(b) & F) &&
             !!(b.compareDocumentPosition(document.querySelector('.report-section')) & F); })()""")
    assert page.evaluate("getComputedStyle(document.getElementById('gpc-selbar')).position") == 'fixed'
    chip = '#gpc-pairs-core .gpc-pair'
    page.focus(chip)
    page.keyboard.press('Enter')
    page.wait_for_timeout(200)
    expect(page.locator('#gpc-selbar')).to_be_visible()
    assert 'Press Tab for the actions' in page.evaluate("document.querySelector('#gpc-selbar .gpc-selbar-what').textContent")
    page.keyboard.press('Tab')
    assert page.evaluate("document.activeElement.textContent") == 'Details'
    page.keyboard.press('Shift+Tab')
    assert page.evaluate("document.activeElement === document.querySelector('#gpc-pairs-core .gpc-pair')")
    page.keyboard.press('Tab')
    n = page.evaluate("document.querySelectorAll('#gpc-selbar button, #gpc-selbar a').length")
    for _ in range(n - 1):
        page.keyboard.press('Tab')
    assert page.evaluate("document.activeElement.classList.contains('gpc-selbar-close')")
    # past the bar's last button the page goes on after the chip that made the selection
    page.keyboard.press('Tab')
    assert page.evaluate("""(() => { var first = document.querySelector('#gpc-pairs-core .gpc-pair');
      var a = document.activeElement; return a !== first && !a.closest('#gpc-selbar') &&
      !!(first.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING); })()""")
    # Escape from inside the bar hides it and puts the focus back where the selection was made
    second = page.locator('#gpc-pairs-core .gpc-pair').nth(1)
    second.focus()
    page.keyboard.press('Enter')
    page.wait_for_timeout(150)
    page.keyboard.press('Tab')
    assert _focus_desc(page)['inBar']
    page.keyboard.press('Escape')
    expect(page.locator('#gpc-selbar')).to_be_hidden()
    assert page.evaluate("document.activeElement === document.querySelectorAll('#gpc-pairs-core .gpc-pair')[1]")
    assert page.evaluate("window.GPCSelect.current().pair !== null")
    assert _errors(page) == []


@needs_build
def test_a_mouse_selection_leaves_the_tab_order_alone(open_report):
    page = open_report(_pick())
    page.click('#gpc-pairs-core .gpc-pair')
    page.wait_for_timeout(200)
    page.keyboard.press('Tab')
    f = _focus_desc(page)
    assert not (f and f['inBar'])
    assert 'Press Tab' not in page.evaluate("document.querySelector('#gpc-selbar .gpc-selbar-what').textContent")


# ---- 3. phone: the bar's buttons and the drawer's 3D column stay on the screen ------------

@needs_build
@pytest.mark.parametrize('dark', [False, True])
def test_phone_bar_and_drawer_fit_the_screen(open_report, dark):
    gid = _pick('id="sec-3d"', prefer='par2_human') or _pick()
    page = open_report(gid, viewport=PHONE, dark=dark)
    page.click('#gpc-pairs-core .gpc-pair')
    page.wait_for_timeout(250)
    page.locator('#gpc-selbar').get_by_role('button', name='Details').click()
    page.wait_for_timeout(250)
    geo = page.evaluate("""(() => {
      var r = e => e.getBoundingClientRect();
      var bar = r(document.getElementById('gpc-selbar')), drawer = r(document.getElementById('rx-drawer'));
      var ctrls = [].map.call(document.querySelectorAll('#gpc-selbar button, #gpc-selbar a'), e => { var b = r(e); return [b.left, b.right, b.bottom]; });
      var sc = document.querySelector('#rx-drawer .rx-pairs-scroll');
      var focus = [].map.call(document.querySelectorAll('#rx-drawer .rx-pair-focus'), e => r(e).right);
      return {w: innerWidth, h: innerHeight, bar: [bar.left, bar.right, bar.top, bar.bottom], drawer: [drawer.left, drawer.right, drawer.top, drawer.bottom],
              ctrls: ctrls, scroll: sc ? [sc.clientWidth, sc.scrollWidth] : null, focus: focus};
    })()""")
    assert all(0 <= c[0] and c[1] <= geo['w'] + 0.5 and c[2] <= geo['h'] + 0.5 for c in geo['ctrls']), geo['ctrls']
    assert geo['drawer'][0] <= 0.5 and geo['drawer'][1] >= geo['w'] - 0.5, 'the drawer is a full-width sheet'
    assert geo['drawer'][3] <= geo['bar'][2] + 1, 'the drawer ends where the bar starts'
    if geo['scroll']:
        assert geo['scroll'][1] <= geo['scroll'][0] + 1, 'the partner table (with its 3D column) fits'
        assert all(x <= geo['w'] for x in geo['focus'])
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1')
    assert _errors(page) == []


# ---- 5. links to residues or pairs the page does not have ---------------------------------

@needs_build
def test_a_link_to_a_residue_the_page_lacks_is_ignored(open_report):
    page = open_report(_pick(), '#res=99999')
    expect(page.locator('#gpc-selbar')).to_be_hidden()
    assert page.evaluate("window.GPCSelect.current().res") is None
    assert page.evaluate("document.getElementById('rx-drawer').hidden")
    assert 'res=' not in page.evaluate('location.hash')
    assert _errors(page) == []


@needs_build
def test_a_link_to_a_pair_that_is_not_a_contact_falls_back_to_its_first_residue(open_report):
    gid = _pick()
    page = open_report(gid)
    a, b = page.evaluate("""(() => {
      var known = p => !!document.querySelector('#snake-plot-container circle[id="' + p + '"]');
      var has = (x, y) => !!document.querySelector('#rrcs-table tr[data-gpc-a="' + x + '"][data-gpc-b="' + y + '"], #rrcs-table tr[data-gpc-a="' + y + '"][data-gpc-b="' + x + '"]');
      for (var x = 1; x < 400; x++) for (var y = x + 1; y < x + 3; y++) if (known(x) && known(y) && !has(x, y)) return [x, y];
      return [null, null];
    })()""")
    assert a is not None
    page = open_report(gid, '#pair=%d-%d' % (a, b))
    cur = page.evaluate('window.GPCSelect.current()')
    assert cur['pair'] is None and cur['res'] == a
    assert page.evaluate('location.hash') == '#res=%d' % a
    assert 'Contact' not in page.locator('#gpc-selbar').inner_text()
    # neither residue on the page: nothing at all
    page2 = open_report(gid, '#pair=99998-99999')
    assert page2.evaluate('window.GPCSelect.current().res') is None
    expect(page2.locator('#gpc-selbar')).to_be_hidden()
    assert 'pair=' not in page2.evaluate('location.hash')
    # a real contact still opens as a pair
    chip = _first_chip(page)
    page3 = open_report(gid, '#pair=%d-%d' % (chip['a'], chip['b']))
    assert page3.evaluate('window.GPCSelect.current().pair')['b'] == chip['b']
    assert _errors(page) == [] and _errors(page2) == [] and _errors(page3) == []


# ---- 9. the filter's lower bound is the page's threshold ----------------------------------

@needs_build
@pytest.mark.parametrize('gid', ['mc4r_human', 'opsd_human', 'adrb2_human'])
def test_the_magnitude_filter_starts_at_the_pages_threshold(open_report, gid):
    if not (REPORTS_DIR / ('%s.html' % gid)).is_file():
        pytest.skip('%s not in this build' % gid)
    sig = json.loads(re.search(r'id="rx-residue-extra">(.*?)</script>', _html(gid), re.S).group(1))['sig']
    page = open_report(gid)
    page.locator('#sec-snake').scroll_into_view_if_needed()
    page.wait_for_timeout(600)
    assert abs(page.evaluate('window.SnakeAPI.bounds().lo') - sig) < 1e-9
    assert abs(float(page.evaluate("document.getElementById('snake-mag-min').min")) - sig) < 1e-9
    assert page.evaluate("document.getElementById('snake-mag-min-val').textContent") == '%.2f' % sig
    assert ('|ΔRRCS| ≥ %.2f' % sig) in page.evaluate("document.getElementById('sec-snake').textContent")
    assert _errors(page) == []


# ---- 7, 8. the scrubber readout and the step-through label read plainly -------------------

@needs_build
def test_the_snake_toolbar_reads_plainly(open_report):
    page = open_report(_pick())
    page.locator('#sec-snake').scroll_into_view_if_needed()
    page.wait_for_timeout(500)
    assert page.evaluate("document.querySelector('#sp-bar .sp-tour-lab').textContent") == 'Step through the largest changes'
    assert re.match(r'^0 of \d+$', page.evaluate("document.querySelector('#sp-bar .sp-tour-n').textContent"))
    page.click('#sp-bar .sp-mode[data-mode="state"]')
    assert page.evaluate("document.querySelector('#sp-bar .sp-scrub-text').textContent") == 'Showing: the inactive model'


# ---- 11. a receptor without a variant table says why --------------------------------------

@needs_build
def test_a_report_without_a_variant_table_says_why_outside_the_frozen_sections():
    seen = 0
    for path in _pages():
        html = path.read_text(encoding='utf-8')
        if 'id="sec-variants"' in html:
            continue
        m = re.search(r'<aside class="fine-print rx-variants-none" id="variants-fine-print">(.*?)</aside>', html, re.S)
        assert m, '%s: no variant table and no line saying why' % path.stem
        text = re.sub(r'\s+', ' ', m.group(1))
        assert 'rx-variants-none' not in ''.join(SECTION_RE.findall(html))
        assert '—' not in text
        if path.stem in ('npy6r_human', 'taar3_human'):
            assert 'pseudogene' in text and 'no protein-coding transcript' in text and 'ENSG' in text, text
            assert 'gnomAD v' in text
        seen += 1
    if not seen:
        pytest.skip('every report in this build has a variant table')


def test_the_no_variants_reason_comes_from_the_pack():
    from GPCompaReports_v2.analysis.pack_layer import no_variants_reason
    pseudo = {'meta': {'gene': 'TAAR3P'}, 'variants': [], 'provenance': {'clinvar': {
        'empty': 'pseudogene: Ensembl gene ENSG00000179073 (transcribed_unprocessed_pseudogene) has no protein-coding transcript'}}}
    assert no_variants_reason(pseudo) == {'kind': 'pseudogene', 'gene': 'TAAR3P', 'ensembl': 'ENSG00000179073',
                                          'biotype': 'transcribed unprocessed pseudogene'}
    other = {'meta': {'gene': 'X'}, 'variants': [[1]], 'provenance': {'gnomad': {'release': 'v4.1.2'}}}
    assert no_variants_reason(other)['kind'] == 'none_at_contacts'


# ---- 13. the game fits the screen and takes the keys only while it has the focus -----------

@needs_build
@pytest.mark.parametrize('viewport', [WIDE, {'width': 1280, 'height': 720}])
def test_the_game_fits_the_screen_and_lets_the_page_scroll(open_report, viewport):
    page = open_report(_pick('id="delta-chart"'), viewport=viewport)
    page.locator('.rrcs-tetris-toggle').scroll_into_view_if_needed()
    page.click('.rrcs-tetris-toggle')
    page.wait_for_timeout(400)
    geo = page.evaluate("""(() => {
      var chrome = 0;
      ['.topbar', '.v3-secnav'].forEach(s => { var e = document.querySelector(s); if (e && /sticky|fixed/.test(getComputedStyle(e).position)) chrome += e.offsetHeight; });
      var w = document.querySelector('.rrcs-tetris').getBoundingClientRect(), c = document.querySelector('.rrcs-tetris-board canvas').getBoundingClientRect();
      return {chrome: chrome, top: w.top, boardBottom: c.bottom, h: innerHeight, focused: document.querySelector('.rrcs-tetris').contains(document.activeElement)};
    })()""")
    assert geo['top'] >= geo['chrome'] - 1 and geo['boardBottom'] <= geo['h'], geo
    assert geo['focused'], 'the game has the focus when it starts'
    y = page.evaluate('scrollY')
    page.keyboard.press('ArrowDown')
    page.keyboard.press('ArrowLeft')
    page.wait_for_timeout(100)
    assert page.evaluate('scrollY') == y, 'a running, focused game takes the arrow keys'
    # the focus elsewhere: the game pauses and the arrow keys scroll the page
    page.evaluate('document.activeElement.blur()')
    page.keyboard.press('ArrowDown')
    page.keyboard.press('ArrowDown')
    page.wait_for_timeout(300)
    assert page.evaluate('scrollY') > y
    assert 'Paused' in page.evaluate("document.querySelector('.rrcs-tetris-msg').textContent")
    # a click on the board takes the focus back; Escape there returns to the chart
    page.locator('.rrcs-tetris-board canvas').scroll_into_view_if_needed()
    page.click('.rrcs-tetris-board canvas')
    assert page.evaluate("document.querySelector('.rrcs-tetris').contains(document.activeElement)")
    page.keyboard.press('Escape')
    page.wait_for_timeout(200)
    assert page.evaluate("document.querySelector('.rrcs-tetris').hidden")
    assert page.evaluate("document.activeElement.classList.contains('rrcs-tetris-toggle')")
    assert _errors(page) == []


# ---- 14. the protein-change cell selects its row's residue --------------------------------

@needs_build
def test_a_protein_change_cell_selects_the_rows_residue(open_report):
    gid = _pick('id="variants-table"')
    if not gid:
        pytest.skip('no report with a variant table')
    page = open_report(gid)
    row = page.locator('#variants-table tbody tr').first
    row.scroll_into_view_if_needed()
    pos = int(row.locator('td').nth(0).inner_text().strip())
    row.locator('td').nth(1).click()
    page.wait_for_timeout(200)
    assert page.evaluate('window.GPCSelect.current().res') == pos
    expect(page.locator('#rx-drawer')).to_be_visible()
    assert page.locator('#rx-drawer-title').inner_text().endswith(str(pos))
    assert _errors(page) == []


# ---- 4, 6. no active/inactive colours on the badges; a chosen motif stays readable ---------

@needs_build
@pytest.mark.parametrize('dark', [False, True])
def test_pathogenic_and_high_badges_are_neutral(open_report, dark):
    gid = _pick('badge-pathogenic', 'badge-high') or _pick('badge-high')
    page = open_report(gid, dark=dark)
    colours = page.evaluate("""(() => {
      var probe = c => { var s = document.createElement('span'); s.style.color = c; document.body.appendChild(s); var v = getComputedStyle(s).color; s.remove(); return v; };
      var cs = getComputedStyle(document.documentElement);
      var sem = ['--semantic-active', '--semantic-inactive', '--semantic-active-soft', '--semantic-inactive-soft'].map(v => probe(cs.getPropertyValue(v).trim()));
      var out = [];
      document.querySelectorAll('.badge-pathogenic, .badge-high').forEach(b => { var s = getComputedStyle(b); out.push([s.color, s.backgroundColor]); });
      return {sem: sem, badges: out};
    })()""")
    assert colours['badges']
    for fg, bg in colours['badges']:
        assert fg not in colours['sem'] and bg not in colours['sem'], (fg, bg)


@needs_build
def test_a_chosen_motif_chip_keeps_its_residues_readable_in_dark_mode(open_report):
    page = open_report(_pick(), dark=True)
    page.locator('#sec-snake').scroll_into_view_if_needed()
    page.wait_for_timeout(500)
    chip = page.locator('#sp-motif-chips .sp-chip').first
    chip.click()
    c = page.evaluate("""(() => { var ch = document.querySelector('#sp-motif-chips .sp-chip.is-on');
      return [getComputedStyle(ch.querySelector('.sp-chip-res')).color, getComputedStyle(document.body).color]; })()""")
    assert c[0] == c[1], 'the residues take the page text colour on a chosen chip'
