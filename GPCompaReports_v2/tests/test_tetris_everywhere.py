"""The RRCS Tetris easter egg is on every report that has the ΔRRCS distribution chart, not only PAR2.

It must stay outside the approved report sections: the script and stylesheet are loaded from the
page's scripts block, and the toggle button is added by the script at run time.

The trigger is a small pixel-art gamepad (owner, 2026-11-05) whose tooltip and accessible name
are "Play Tetris"; the T block and the "Play RRCS Tetris" hint are gone.
"""
import os
import pathlib
import re

import pytest

from .report_files import report_pages

BASE = pathlib.Path(__file__).resolve().parents[1]
BUILD = os.environ.get('SMOKE_BUILD_DIR') or os.environ.get('FREEZE_BUILD_DIR')


def test_the_template_does_not_limit_tetris_to_one_receptor():
    tpl = (BASE / 'templates' / 'gpcr_report.html').read_text(encoding='utf-8')
    block = tpl[tpl.index('{% block scripts %}'):]
    assert "gpcr_id == 'par2_human'" not in block.split('rrcs-tetris.js')[0][-400:]
    assert 'rrcs-tetris.js' in block


def test_the_trigger_is_a_pixel_art_gamepad_named_play_tetris():
    js = (BASE / 'static' / 'js' / 'rrcs-tetris.js').read_text(encoding='utf-8')
    css = (BASE / 'static' / 'css' / 'rrcs-tetris.css').read_text(encoding='utf-8')
    assert "btn.title = 'Play Tetris'" in js
    assert "btn.setAttribute('aria-label', 'Play Tetris')" in js
    assert 'shape-rendering="crispEdges"' in js and 'fill="currentColor"' in js
    # no T block, no hint line, no wiggle
    assert 'Play RRCS Tetris' not in js
    for gone in ('rrcs-tetris-hint', 'is-wiggle', 'rrcs-tetris-drop'):
        assert gone not in js and gone not in css, gone
    # a 32 px target
    toggle = css[css.index('.rrcs-tetris-toggle {'):]
    toggle = toggle[:toggle.index('}')]
    assert 'width: 32px' in toggle and 'height: 32px' in toggle


@pytest.mark.skipif(not BUILD or not (pathlib.Path(BUILD) / 'reports').is_dir(),
                    reason='needs a built site (SMOKE_BUILD_DIR or FREEZE_BUILD_DIR)')
def test_every_report_with_the_delta_chart_loads_tetris():
    pages = report_pages(pathlib.Path(BUILD) / 'reports')
    with_chart = 0
    for p in pages:
        html = p.read_text(encoding='utf-8')
        if 'id="delta-chart"' not in html:
            continue
        with_chart += 1
        assert 'static/js/rrcs-tetris.js' in html, p.name
        assert 'static/css/rrcs-tetris.css' in html, p.name
        assert 'Play RRCS Tetris' not in html, p.name
        # never inside an approved section
        for sec in re.findall(r'<section class="report-section".*?</section>', html, flags=re.S):
            assert 'rrcs-tetris' not in sec, p.name
    assert with_chart > 0
