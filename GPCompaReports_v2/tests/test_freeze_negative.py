"""Negative checks for the approved-edit rules of 2026-11-05 (tests/test_freeze.py).

A passing hash after the reversals does not prove the rules are narrow. Each test here takes a
built report that passes the freeze, makes one change the approval does not cover, and asserts the
freeze now fails: an unrelated number, a changed threshold inside an approved sentence, a moved
helix label, a changed viewBox, one approved string missing, and a stray copy of an approved
string. Build: FREEZE_BUILD_DIR (any build with ADRB2, or the first receptor it has).
"""
import pytest

from . import test_freeze as tf

BUILD = tf._build_reports()
GID = 'adrb2_human' if 'adrb2_human' in BUILD else (sorted(BUILD)[0] if BUILD else None)

pytestmark = pytest.mark.skipif(GID is None, reason='no build at %s; set FREEZE_BUILD_DIR' % tf.BUILD_DIR)


def _passes(html):
    baseline = tf._load_manifest()['receptors'][GID]
    try:
        digest, count = tf._approved_content_hash(html, GID)
    except AssertionError:
        return False
    return digest == baseline['sha256'] and count == baseline['section_count']


@pytest.fixture(scope='module')
def html():
    text = BUILD[GID].read_text(encoding='utf-8')
    assert _passes(text), 'the unmodified build must pass the freeze first'
    return text


def _once(html, old, new):
    assert old in html, old
    return html.replace(old, new, 1)


def test_an_unrelated_number_in_a_table_fails(html):
    i = html.index('<table class="v2-table" id="rrcs-table">')
    j = html.index('<td class="num">', i)
    k = html.index('</td>', j)
    cell = html[j:k]
    mutated = html[:j] + cell[:-1] + ('1' if cell[-1] != '1' else '2') + html[k:]
    assert not _passes(mutated)


def test_a_changed_threshold_inside_an_approved_sentence_fails(html):
    old = "Highlighted rows are at or above this receptor's threshold (|ΔRRCS| ≥ "
    i = html.index(old) + len(old)
    mutated = html[:i] + '9' + html[i + 1:]
    assert not _passes(mutated)


def test_a_moved_helix_label_fails(html):
    i = html.index("<g class='snake-helix-labels'")
    j = html.index("<rect x='", i) + len("<rect x='")
    mutated = html[:j] + '1' + html[j:]
    assert not _passes(mutated)


def test_a_changed_x50_tag_fails(html):
    i = html.index("<g class='snake-x50'")
    j = html.index("r='13.1'", i)
    mutated = html[:j] + "r='14.1'" + html[j + len("r='13.1'"):]
    assert not _passes(mutated)


def test_a_changed_viewbox_fails(html):
    i = html.index('<svg id="snakeplot"')
    j = html.index("viewBox='", i) + len("viewBox='")
    mutated = html[:j] + '1' + html[j:]
    assert not _passes(mutated)


def test_a_missing_approved_string_fails(html):
    # one HIGH badge loses its approved tooltip (and gains other text): the count no longer matches
    mutated = _once(html, '|ΔRRCS| ≥ 5.0: a large contact change', '|ΔRRCS| ≥ 5.0: a big change')
    assert not _passes(mutated)


def test_a_stray_copy_of_an_approved_string_fails(html):
    # the approved Methods sentence added a second time, inside another frozen section
    sentence = 'The threshold is never lower than 0.2. Contact pairs with |ΔRRCS| below 0.2 do not pass this rule.'
    mutated = _once(html, 'Here, ΔRRCS compares contact scores', sentence + ' Here, ΔRRCS compares contact scores')
    assert not _passes(mutated)


def test_an_unrelated_word_in_the_snake_callout_fails(html):
    mutated = _once(html, 'Each circle is one residue', 'Each circle is a residue')
    assert not _passes(mutated)
