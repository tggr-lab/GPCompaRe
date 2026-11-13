"""House rules of the Statistics page (2026-11-13 rewrite), on the source and on a built page.

  * no em dash in the visible text, in the script's strings or in a CSV header;
  * no odds ratio, interval, AUC, Mantel-Haenszel or p-value outside the two Kruskal-Wallis lines of the
    Families tab;
  * the clinical tint lives in the stylesheet tokens only (section 4 and the profile use it through them);
  * red and blue are drawn only by the renderers of signed ΔRRCS, ligand hues only in section 5;
  * nothing is selected on load and no PAR receptor or PAR2 p.Met159Ile is a default or an example;
  * no paper, manuscript, supplement, "as reported" or correction wording in the visible text.

Built-page checks read FREEZE_BUILD_DIR (or SMOKE_BUILD_DIR / SEARCH_BUILD_DIR) and skip without a build.
"""
import csv
import io
import os
import re
from pathlib import Path

import pytest

from .spelling import js_strings

BASE = Path(__file__).resolve().parent.parent
_env = os.environ.get('FREEZE_BUILD_DIR') or os.environ.get('SMOKE_BUILD_DIR') or os.environ.get('SEARCH_BUILD_DIR')
BUILD = Path(_env).expanduser() if _env else BASE / 'output_v3_demo'
if not BUILD.is_absolute():
    BUILD = BASE / BUILD
STATS = BUILD / 'statistics.html'
needs_build = pytest.mark.skipif(not STATS.is_file(), reason='no built statistics page at %s' % BUILD)

JS = BASE / 'static' / 'js' / 'stats-story.js'
CSS = BASE / 'static' / 'css' / 'stats.css'
TEMPLATE = BASE / 'templates' / 'statistics.html'
CLINICAL_HEX = ('#B4234B', '#555C68', '#2B6E2F', '#F48FB1', '#B0B4BC', '#81C784')

#: Code blocks of stats-story.js allowed to draw red and blue: the renderers of signed ΔRRCS.
SIGNED = {'divColor', 'chart-histogram', 'chart-helix-pairs', 'legendFor', 'bundle', 'gridView', 'ledger', 'openCell',
          'paintMatrix', 'chart-cfr-atlas', 'Profile', 'scatterFigure', 'TOKENS', 'readTokens'}
#: Code blocks allowed to use ligand hues (section 5: explorer and Atlas teaser).
LIGAND = {'LIGAND_DARK', 'ligandColors', 'scatterFigure', 'explorerTable', 'teaser'}


def _visible(html):
    h = re.sub(r'<footer\b.*?</footer>', ' ', html, flags=re.S | re.I)
    h = re.sub(r'<header class="topbar.*?</header>', ' ', h, flags=re.S)   # site chrome
    h = re.sub(r'<div[^>]*id="mobile-drawer".*?</nav>', ' ', h, flags=re.S)
    h = re.sub(r'<script\b.*?</script>', ' ', h, flags=re.S | re.I)
    h = re.sub(r'<style\b.*?</style>', ' ', h, flags=re.S | re.I)
    h = re.sub(r'<table class="fp-versions".*?</table>', ' ', h, flags=re.S)
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', h))


def _blocks(js):
    """{name: source} of the top-level blocks of the script (functions, define() calls, var blocks)."""
    heads = list(re.finditer(r"^  (?:function (\w+)\(|define\('([\w-]+)'|var (\w+) = )", js, re.M))
    out = {}
    for k, m in enumerate(heads):
        name = m.group(1) or m.group(2) or m.group(3)
        end = heads[k + 1].start() if k + 1 < len(heads) else len(js)
        out[name] = out.get(name, '') + js[m.start():end]
    return out


# ------------------------------------------------------------------------------------------- source
def test_the_script_strings_have_no_em_dash_and_no_banned_wording():
    js = JS.read_text(encoding='utf-8')
    for s in js_strings(js):
        assert '—' not in s, s
        low = s.lower()
        for bad in ('paper', 'manuscript', 'supplement', 'as reported', 'corrected', 'odds ratio', 'mantel', 'auc',
                    '95%', 'confidence interval', 'met159'):
            assert bad not in low, (bad, s)
    for gid in ('par1_human', 'par2_human', 'par3_human', 'par4_human', 'f2r_human'):
        assert gid not in js


def test_red_and_blue_only_in_the_signed_renderers():
    blocks = _blocks(JS.read_text(encoding='utf-8'))
    used = {n for n, src in blocks.items() if re.search(r'\b(?:C|tok)\.(?:active|inactive)\b|--st-(?:active|inactive)', src)}
    assert used, 'no block draws red or blue'
    assert used <= SIGNED, sorted(used - SIGNED)


def test_ligand_hues_only_in_section_5():
    blocks = _blocks(JS.read_text(encoding='utf-8'))
    used = {n for n, src in blocks.items() if re.search(r'ligandColors\(|LIGAND_DARK|ligand_groups\b.*color', src)}
    assert used <= LIGAND, sorted(used - LIGAND)


def test_the_clinical_tint_lives_in_the_stylesheet_tokens_only():
    css = CSS.read_text(encoding='utf-8')
    tokens = css[:css.index('.stats-probe { position')]
    for hx in CLINICAL_HEX:
        assert hx.lower() in tokens.lower(), hx
        assert css.lower().count(hx.lower()) == 1, hx
    for path in (JS, TEMPLATE):
        text = path.read_text(encoding='utf-8').lower()
        for hx in CLINICAL_HEX:
            assert hx.lower() not in text, (path.name, hx)
    # the tint classes are used in section 4 (and the profile, drawn by the script) only
    tpl = TEMPLATE.read_text(encoding='utf-8')
    d0, d1 = tpl.index('id="sec-d"'), tpl.index('id="sec-e"')
    for m in re.finditer(r'class="[^"]*\bc-(?:path|amb|ben)\b', tpl):
        assert d0 < m.start() < d1, m.group(0)


# -------------------------------------------------------------------------------------------- build
@needs_build
def test_visible_text_has_no_em_dash_and_no_banned_wording():
    text = _visible(STATS.read_text(encoding='utf-8'))
    assert '—' not in text
    low = text.lower()
    for bad in ('paper', 'manuscript', 'supplement', 'as reported', 'corrected', 'non-cfr'):
        assert bad not in low, bad


@needs_build
def test_no_test_statistic_outside_the_families_lines():
    html = STATS.read_text(encoding='utf-8')
    fam = re.search(r'<p class="small-note families-text"[^>]*>(.*?)</p>', html, re.S)
    assert fam and 'Kruskal-Wallis' in fam.group(1) and fam.group(1).count('p = ') == 2
    rest = _visible(html.replace(fam.group(0), ' '))
    for pat in (r'odds ratio', r'\bOR\s', r'\bCI\b', r'95%', r'Mantel', r'\bAUC\b', r'\bp\s*=', r'\bp\s*<'):
        assert not re.search(pat, rest, re.I if pat.islower() else 0), pat


@needs_build
def test_csv_headers_have_no_em_dash():
    for path in (BUILD / 'data' / 'stats').glob('*.csv'):
        lines = [l for l in path.read_text(encoding='utf-8').splitlines() if not l.startswith('#')]
        header = next(csv.reader(io.StringIO(lines[0])))
        assert not any('—' in h for h in header), path.name


@needs_build
def test_nothing_is_selected_and_nothing_par_specific_by_default():
    html = STATS.read_text(encoding='utf-8')
    assert 'sel=' not in html
    assert 'Nothing selected. Every chart shows all 283 receptors.' in html
    for bad in ('par1_human', 'par2_human', 'par3_human', 'par4_human', 'f2r_human', 'Met159', 'M159I'):
        assert bad not in html, bad
    assert 'class="pos-profile' not in html


@needs_build
def test_the_atlas_is_named_only_as_the_gpcrome_atlas_and_called_a_preview():
    text = _visible(STATS.read_text(encoding='utf-8'))
    for m in re.finditer(r'\b[Aa]tlas\b', text):
        before = text[max(0, m.start() - 8):m.start()]
        assert 'GPCRome' in before, text[max(0, m.start() - 60):m.end() + 20]
    assert 'Open the GPCRome Atlas (Preview)' in text and 'experimental preview' in text
