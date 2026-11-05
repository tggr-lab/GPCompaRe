"""The build-time additions to the snake plot (approved 2026-11-05, P1 to P3; website/snake_bake.py).

What the build may change in the approved SVG is recorded per receptor in
tests/fixtures/snake_svg_changes_2026-11-05.json (scripts/build_snake_svg_record.py): the <svg>
tag (fitted viewBox), the terminus labels moved off residues, and two added groups whose exact
SHA-256 is recorded. These tests check a build against that record (FREEZE_BUILD_DIR, as the freeze
test): undoing exactly the recorded changes gives back the plot as it was, no label lies on a
residue, every helix present has its label, and the old arc payload is gone. The geometry tests
run on synthetic SVG and need no build.
"""
import hashlib
import json
import os
import re
from pathlib import Path

import pytest

from GPCompaReports_v2.website import snake_bake as B
from .report_files import report_pages

BASE = Path(__file__).resolve().parent.parent
RECORD = json.loads((BASE / 'tests' / 'fixtures' / 'snake_svg_changes_2026-11-05.json').read_text(encoding='utf-8'))

_env = os.environ.get('FREEZE_BUILD_DIR')
BUILD_DIR = Path(_env).expanduser() if _env else BASE / 'output_v3_demo'
if not BUILD_DIR.is_absolute():
    BUILD_DIR = BASE / BUILD_DIR
REPORTS = BUILD_DIR / 'reports'
SVG_RE = re.compile(r'<div id="snake-plot-container">\s*(<svg.*?</svg>)', re.S)
LABELS_RE = re.compile(r"<g class='snake-helix-labels'.*?</g>", re.S)
X50_RE = re.compile(r"<g class='snake-x50'.*?</g>", re.S)


def unbake(svg, gid):
    """The built SVG with exactly the recorded changes undone (None if anything does not match)."""
    rec = RECORD[gid]
    for after, before in rec['replaced_tags']:
        if svg.count(after) != 1:
            return None
        svg = svg.replace(after, before)
    for rx, key in ((LABELS_RE, 'labels_group_sha256'), (X50_RE, 'x50_group_sha256')):
        m = rx.search(svg)
        if not m or hashlib.sha256(m.group(0).encode('utf-8')).hexdigest() != rec[key]:
            return None
        svg = svg.replace(m.group(0), '', 1)
    return svg


def _built():
    if not REPORTS.is_dir():
        return {}
    return {p.stem: p for p in report_pages(REPORTS)}


needs_build = pytest.mark.skipif(not REPORTS.is_dir(), reason='no build at %s; set FREEZE_BUILD_DIR' % BUILD_DIR)


# ---------------------------------------------------------------- the record itself

def test_record_covers_every_receptor_and_names_only_helices():
    assert len(RECORD) == 283
    for gid, rec in RECORD.items():
        assert set(rec['helix_labels']) <= {'TM1', 'TM2', 'TM3', 'TM4', 'TM5', 'TM6', 'TM7', 'H8'}, gid
        assert rec['helix_labels'][:6] == ['TM1', 'TM2', 'TM3', 'TM4', 'TM5', 'TM6'], gid
        assert not rec['viewbox'][1].startswith('0 0 '), gid
        for label, pos, _tag in rec['x50']:
            assert re.fullmatch(r'[1-8]\.50x50', label), (gid, label)
        # only the <svg> tag and moved terminus labels are rewritten
        tags = rec['replaced_tags']
        assert tags[-1][0].startswith('<svg id="snakeplot"') and tags[-1][1].startswith('<svg id="snakeplot"')
        for after, before in tags[:-1]:
            assert "class='C-term short segment'" in after or "class='N-term short segment'" in after, gid
            assert re.sub(r"\b[xy]='[-\d.]+'", '', after) == re.sub(r"\b[xy]='[-\d.]+'", '', before), gid


def test_npy6r_has_no_h8_and_mc4r_c_term_moved():
    assert 'H8' not in RECORD['npy6r_human']['helix_labels'] and 'TM7' not in RECORD['npy6r_human']['helix_labels']
    assert [m[0] for m in RECORD['mc4r_human']['moved_labels']] == ['C-term']
    assert RECORD['adrb2_human']['moved_labels'] == []


# ---------------------------------------------------------------- geometry, no build needed

SYNTH = ("<svg id=\"snakeplot\" xmlns=\"http://www.w3.org/2000/svg\" version=\"1.1\" width=\"400\" height=\"600\" "
         "style='stroke-width: 0px; background-color: white;' viewBox='0 0 400 600'>\n"
         "<g id='snake' transform='translate(0, 100)'>%s</g></svg>")


def _circle(seg, x, y, n, title):
    return ("<circle class='%s rcircle' cx='%d' cy='%d' r='12' stroke='black' stroke-width='2' fill='white'\n"
            "            fill-opacity='1' id='%d' original_title='%s' original_cx='%d' original_cy='%d'></circle>"
            % (seg, x, y, n, title, x, y))


def _synthetic(cterm_on_residue=False):
    parts, n = [], 1
    for h in range(7):
        for k in range(6):
            gn = '%d.%dx%d' % (h + 1, 47 + k, 47 + k)
            parts.append(_circle('TM%d' % (h + 1), 40 + 50 * h + (k % 2) * 14, 60 + 19 * k, n, 'A%d %s' % (n, gn)))
            n += 1
    cx, cy = (40 + 50 * 6, 60 + 19 * 5) if cterm_on_residue else (380, 300)
    parts.append("<rect onclick='toggleLoop(\".C-term\",\"short\",false,this);' class='C-term short segment' x='%d' y='%d' rx='5' ry='5' width='45' height='20' stroke='black' fill='white' stroke-width='1'/>" % (cx - 22, cy - 10))
    parts.append("<text  onclick='toggleLoop(\".C-term\",\"short\",false,this);' class='C-term short segment' x='%d' y='%d' text-anchor='middle' font-size='12' font-family='helvetica'>C-term</text>" % (cx, cy + 3))
    parts.append("<circle class='ICL3 long rcircle' cx='999' cy='999' r='12' stroke='black' stroke-width='2' fill='white'\n"
                 "            fill-opacity='1' id='900' original_title='A900 ' original_cx='999' original_cy='999'></circle>")
    return SYNTH % ''.join(parts)


def test_bake_adds_labels_marks_and_a_fitted_box_without_moving_residues():
    svg = _synthetic()
    out, rec = B.bake(svg)
    assert rec['helix_labels'] == ['TM1', 'TM2', 'TM3', 'TM4', 'TM5', 'TM6', 'TM7']
    assert [x[0] for x in rec['x50']] == ['%d.50x50' % h for h in range(1, 8)]
    assert B.built_overlaps(out) == []
    # every residue circle is byte-identical
    assert re.findall(r'<circle class=.*?</circle>', svg, re.S) == re.findall(r"<circle class='[^']*rcircle.*?</circle>", out, re.S)
    # the box holds the collapsed plot and ignores the hidden (long) residue at 999, 999
    x, y, w, h = (float(v) for v in rec['viewbox'].split())
    assert x + w < 900 and y + h < 900 + 100
    assert 'width="%s"' % B._fmt(w) in out and 'height="%s"' % B._fmt(h) in out


def test_a_terminus_label_on_residues_is_moved_off_them():
    svg = _synthetic(cterm_on_residue=True)
    assert B.check_overlaps(B.parse(svg))          # the input really has the problem
    out, rec = B.bake(svg)
    assert [m[0] for m in rec['moved_labels']] == ['C-term']
    assert B.built_overlaps(out) == []


def test_a_label_that_cannot_be_placed_fails_loudly(monkeypatch):
    monkeypatch.setattr(B, '_free', lambda *a, **k: False)
    with pytest.raises(B.SnakeBakeError):
        B.bake(_synthetic())


# ---------------------------------------------------------------- the build

@needs_build
def test_built_snake_plots_differ_from_the_approved_ones_only_as_recorded():
    """Undoing the recorded changes must leave a plot with no baked group, the original <svg> tag
    and unchanged residues; any other change makes unbake() fail."""
    built = _built()
    checked = 0
    for gid, path in sorted(built.items()):
        m = SVG_RE.search(path.read_text(encoding='utf-8'))
        if not m:
            continue
        svg = m.group(1)
        back = unbake(svg, gid)
        assert back is not None, '%s: the snake SVG does not match its recorded changes' % gid
        assert 'snake-helix-labels' not in back and 'snake-x50' not in back
        assert ("viewBox='%s'" % RECORD[gid]['viewbox'][0]) in back
        # residues identical before and after
        assert re.findall(r"<circle class='[^']*rcircle.*?</circle>", back, re.S) == \
            re.findall(r"<circle class='[^']*rcircle.*?</circle>", svg, re.S), gid
        checked += 1
    assert checked


@needs_build
def test_no_label_lies_on_a_residue_in_any_built_plot():
    """The overlap check over every built plot (all 283 in a full build)."""
    offenders = {}
    for gid, path in sorted(_built().items()):
        m = SVG_RE.search(path.read_text(encoding='utf-8'))
        if m:
            bad = B.built_overlaps(m.group(1))
            if bad:
                offenders[gid] = bad[:3]
    assert not offenders, offenders


@needs_build
def test_old_arc_payload_is_gone_and_the_pairs_block_is_unrounded():
    for gid, path in sorted(_built().items()):
        html = path.read_text(encoding='utf-8')
        if 'id="snake-plot-data"' not in html:
            continue
        data = json.loads(re.search(r'<script type="application/json" id="snake-plot-data">(.*?)</script>', html, re.S).group(1))
        assert 'contact_links' not in data, gid
        assert 'function redrawSnakeLinks' in html and 'links.forEach' not in html
        block = json.loads(re.search(r'<script type="application/json" id="rx-contacts">(.*?)</script>', html, re.S).group(1))
        sig = block['sig']
        assert block['pairs'] and all(abs(p[4]) >= sig - 1e-9 and p[5] == 1 for p in block['pairs']), gid
        # the same pairs the RRCS table highlights (none is lost to its 1,000-row cap)
        rrcs = re.search(r'<section class="report-section" id="sec-rrcs".*?</section>', html, re.S).group(0)
        assert len(block['pairs']) == rrcs.count('<tr class="significant-row">'), gid


@pytest.mark.parametrize('gid', ['adrb2_human', 'mc4r_human', 'npy6r_human', 'opsd_human'])
def test_record_matches_a_fresh_render(gid):
    """The committed record is what the code produces now (the full check: scripts/build_snake_svg_record.py --check)."""
    pytest.importorskip('ouroboros', reason='ouroboros is not installed in this interpreter; run from the project venv')
    import importlib.util
    spec = importlib.util.spec_from_file_location('build_snake_svg_record', BASE.parent / 'scripts' / 'build_snake_svg_record.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.record_for(gid) == RECORD[gid]
