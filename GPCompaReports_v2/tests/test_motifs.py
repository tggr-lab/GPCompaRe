"""The motif registry (motifs.json, website/motifs.py): the xMY motif (owner, 2026-11-05).

xMY is Met at 3.36 and Tyr at 3.37 after a variable residue at 3.35 (manuscript 07-10-26; the
control analysis showed the arrangement and the weakening of its two contacts are shared by
the receptors that carry it, not PAR-specific). One definition feeds the report pages (#rx-config
`motifs`, the snake-plot chip, the header badge), the glossary entry and <site>/motifs.json (search).

The registry and glossary checks need nothing; membership needs the Studio packs; the build checks
read SMOKE_BUILD_DIR / FREEZE_BUILD_DIR (as test_report_v3.py); the glossary page check needs
Playwright.
"""
import json
import re

import pytest

from GPCompaReports_v2.website import motifs
from GPCompaReports_v2.website.glossary import GLOSSARY
from GPCompaReports_v2.website.page_generators import report_extras

from .test_report_v3 import BUILD_DIR, REPORTS_DIR, SECTION_RE, needs_build, _pages, _html

PARS = {'par1_human', 'par2_human', 'par3_human', 'par4_human'}


def _xmy():
    return motifs.motif('xmy')


def test_the_registry_defines_xmy_once_in_plain_words():
    m = _xmy()
    assert [x['id'] for x in motifs.load()['motifs']].count('xmy') == 1
    assert m['positions'] == ['3.35', '3.36', '3.37']
    assert m['requires'] == {'3.36': 'M', '3.37': 'Y'}
    assert m['contacts'] == [['3.36', '3.37'], ['3.36', '6.48']]
    assert m['count'] == {'receptors': 30, 'of': 283}
    text = json.dumps(motifs.load(), ensure_ascii=False)
    assert '—' not in text
    for word in ('novel', 'PAR-specific', 'PAR specific', 'undescribed'):
        assert word.lower() not in text.lower(), word


def test_the_rule_reads_the_receptors_own_residues():
    m = _xmy()
    assert motifs.carries(m, {'3.35': [157, 'N'], '3.36': [158, 'M'], '3.37': [159, 'Y']})
    assert not motifs.carries(m, {'3.35': [116, 'C'], '3.36': [117, 'V'], '3.37': [118, 'T']})
    assert not motifs.carries(m, {'3.36': [158, 'M'], '3.37': [159, 'F']})
    assert not motifs.carries(m, {})
    assert motifs.bw_of('3.36x36') == '3.36' and motifs.bw_of('12.48x48') == '12.48' and motifs.bw_of('') == ''
    got = motifs.carried(motifs.by_generic([[157, 'H', 'TM3', '3.35x35'], [158, 'M', 'TM3', '3.36x36'],
                                            [159, 'Y', 'TM3', '3.37x37']]))
    assert got and got[0]['id'] == 'xmy' and got[0]['text'] == 'H157 M158 Y159'


def test_the_glossary_entry_comes_from_the_registry():
    t = next(t for t in GLOSSARY if t['id'] == 'xmy')
    assert t['term'] == 'xMY motif'
    assert t['definition'] == _xmy()['definition']
    d = t['definition']
    assert 'Met at 3.36 and Tyr at 3.37' in d and '3.35' in d
    assert 'Of the 283 Class A receptors, 30 carry it' in d
    assert 'weaker in the active model' in d
    assert 'GPCompaRe study' in d
    assert 'novel' not in d.lower() and 'PAR-specific' not in d
    assert re.search(t['match'][0], 'the xMY motif') and not re.search(t['match'][0], 'xMYs')


def _pack_members():
    gids = [p.stem for p in sorted(report_extras.pack_dir().glob('*_human.json'))]
    if len(gids) < 283:
        return None
    by = {g: motifs.by_generic((report_extras.load_pack(g) or {}).get('residues')) for g in gids}
    return [r['gid'] for r in motifs.members(gids, by.get)['xmy']]


def test_thirty_receptors_carry_xmy_in_the_studio_packs():
    found = _pack_members()
    if found is None:
        pytest.skip('no full set of Studio packs at %s' % report_extras.pack_dir())
    assert len(found) == _xmy()['count']['receptors'] == 30
    assert PARS <= set(found)
    assert 'adrb2_human' not in found


@needs_build
def test_the_site_copy_lists_the_members_for_search():
    path = BUILD_DIR / 'motifs.json'
    assert path.is_file()
    reg = json.loads(path.read_text(encoding='utf-8'))
    m = next(x for x in reg['motifs'] if x['id'] == 'xmy')
    assert m['definition'] == _xmy()['definition']
    gids = [r['gid'] for r in m['members']]
    assert len(gids) == 30 and PARS <= set(gids)
    for r in m['members']:
        assert r['gene'] and r['residues']['3.36'][1] == 'M' and r['residues']['3.37'][1] == 'Y'


@needs_build
def test_the_badge_is_on_xmy_reports_only_and_outside_the_approved_sections():
    members = None
    if (BUILD_DIR / 'motifs.json').is_file():
        reg = json.loads((BUILD_DIR / 'motifs.json').read_text(encoding='utf-8'))
        members = {r['gid'] for r in reg['motifs'][0]['members']}
    seen = 0
    for path in _pages():
        html = path.read_text(encoding='utf-8')
        badge = re.search(r'<a class="motif-badge" data-motif="xmy" href="\.\./glossary\.html#xmy"[^>]*>xMY</a>', html)
        cfg = json.loads(re.search(r'<script type="application/json" id="rx-config">(.*?)</script>', html, re.S).group(1))
        assert [m['id'] for m in cfg['motifs']] == ['xmy']
        if members is not None:
            assert bool(badge) == (path.stem in members), path.stem
        if badge:
            seen += 1
            assert 'motif-badge' not in ''.join(SECTION_RE.findall(html))
    if members is not None and members & {p.stem for p in _pages()}:
        assert seen


@needs_build
def test_the_glossary_page_has_the_xmy_entry(open_report):
    pytest.importorskip('playwright.sync_api')
    page = open_report('adrb2_human') if (REPORTS_DIR / 'adrb2_human.html').is_file() else None
    if page is None:
        pytest.skip('no ADRB2 report in this build')
    page.goto(page.url.split('/reports/')[0] + '/glossary.html#xmy', wait_until='load')
    entry = page.locator('#xmy')
    assert entry.is_visible()
    assert entry.locator('dt').inner_text().startswith('xMY motif')
    dd = entry.locator('dd').inner_text()
    assert '30 carry it' in dd and 'GPCompaRe study' in dd


@needs_build
def test_a_badge_link_lands_on_the_glossary_entry(open_report):
    gid = next((p.stem for p in _pages() if p.stem != 'par2_human' and 'class="motif-badge"' in _html(p.stem)), None)
    if gid is None:
        pytest.skip('no xMY report other than PAR2 in this build')
    page = open_report(gid)
    badge = page.locator('.motif-badge[data-motif="xmy"]')
    assert badge.is_visible()
    badge.click()
    page.wait_for_load_state('load')
    assert page.url.endswith('glossary.html#xmy')
    assert page.locator('#xmy').is_visible()


from .test_report_v3 import server, browser, open_report  # noqa: E402,F401
