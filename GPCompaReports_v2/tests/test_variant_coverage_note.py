"""The four receptors without variant data are not one story, and the page
must not tell them as one.

Two of them, NPY6R and TAAR3, are annotated pseudogene loci: gnomAD carries
variants at those loci but none with a protein-coding missense consequence, so
there is nothing to place on a residue. Zero is the correct answer.

The other two, GP182 and P2RY8, are a data-collection limitation. gnomAD does
hold missense variants for both. They are absent from this release's variant
dataset because their identifiers were not resolved when it was collected, and
that is recorded for a later manuscript revision rather than patched here.

Collapsing all four into one "no data available" line would state something
false about GP182 and P2RY8. These tests fail if that happens.
"""
import os
import pathlib
import re

import pytest

BASE = pathlib.Path(__file__).resolve().parent.parent

_env = os.environ.get('FREEZE_BUILD_DIR')
if _env:
    BUILD_DIR = pathlib.Path(_env).expanduser()
    if not BUILD_DIR.is_absolute():
        BUILD_DIR = BASE / _env
else:
    BUILD_DIR = BASE / 'output_v3_demo'

STATS = BUILD_DIR / 'statistics.html'

PSEUDOGENE = ('NPY6R', 'TAAR3')
UNRESOLVED = ('GP182', 'P2RY8')

needs_build = pytest.mark.skipif(
    not STATS.exists(),
    reason='no built statistics page at %s; run scripts/build_demo.sh' % STATS)


_CACHE = {}


def _text():
    """Visible page text only.

    The built page carries several megabytes of embedded Plotly JSON inside
    <script> blocks. Sentence-splitting that is both meaningless and slow
    enough to look like a hang, so the scripts come out first.
    """
    if 'text' not in _CACHE:
        html = STATS.read_text(encoding='utf-8')
        html = re.sub(r'<script\b.*?</script>', ' ', html, flags=re.S | re.I)
        html = re.sub(r'<style\b.*?</style>', ' ', html, flags=re.S | re.I)
        _CACHE['text'] = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', html))
    return _CACHE['text']


@needs_build
def test_the_variant_coverage_note_is_present_verbatim():
    text = _text()
    for sentence in (
        "The conservation chart uses the site's own variant layer, which covers 279 receptors.",
        'NPY6R and TAAR3 lack protein-coding missense annotations because they '
        'are annotated as pseudogene loci.',
        'GP182 and P2RY8 are excluded from the current variant dataset because '
        'their identifiers were not successfully resolved during data collection.',
    ):
        assert sentence in text, 'missing from the variant methods note: %r' % sentence


@needs_build
def test_the_two_causes_are_stated_separately():
    """The failure this guards against is one sentence covering all four."""
    text = _text()
    sentences = re.split(r'(?<=\.)\s+', text)
    for s in sentences:
        named = [g for g in PSEUDOGENE + UNRESOLVED if g in s]
        assert len(named) < 4, (
            'one sentence describes all four receptors together, which states '
            'the wrong cause for GP182 and P2RY8: %r' % s.strip()[:200])

    pseudo = [s for s in sentences if all(g in s for g in PSEUDOGENE)]
    unres = [s for s in sentences if all(g in s for g in UNRESOLVED)]
    assert pseudo, 'no sentence attributes NPY6R and TAAR3 to pseudogene loci'
    assert unres, 'no sentence attributes GP182 and P2RY8 to identifier resolution'
    assert 'pseudogene' in pseudo[0], (
        'the NPY6R/TAAR3 sentence does not give the pseudogene reason')
    assert not any(g in pseudo[0] for g in UNRESOLVED), (
        'the pseudogene sentence also names GP182 or P2RY8')
    assert 'identifiers were not successfully resolved' in unres[0], (
        'the GP182/P2RY8 sentence does not give the identifier reason')
    assert not any(g in unres[0] for g in PSEUDOGENE), (
        'the identifier sentence also names NPY6R or TAAR3')


@needs_build
def test_gp182_and_p2ry8_are_not_described_as_lacking_gnomad_variants():
    """gnomAD holds missense variants for both. Saying otherwise is false."""
    text = _text()
    sentences = re.split(r'(?<=\.)\s+', text)
    for s in sentences:
        if not any(g in s for g in UNRESOLVED):
            continue
        low = s.lower()
        for claim in ('no gnomad', 'lack gnomad', 'lacks gnomad',
                      'no variant data were available',
                      'no gnomad variant data'):
            assert claim not in low, (
                'a sentence naming GP182 or P2RY8 claims %r, but gnomAD does '
                'hold missense variants for both: %r' % (claim, s.strip()[:200]))


@needs_build
def test_the_receptor_count_and_dataset_are_unchanged():
    text = _text()
    assert "variant layer, which covers 279 receptors" in text
    assert '281' not in text, (
        'the page reports 281 receptors, so the variant dataset was changed. '
        'This release keeps the submitted 279-receptor dataset.')
