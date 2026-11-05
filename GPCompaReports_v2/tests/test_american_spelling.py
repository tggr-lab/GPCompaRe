"""The site is written in American English (owner, 2026-11-05: "'Colour by' is British English,
it was meant to be American"). No British spelling may come back in what a reader sees.

Source checks (always run): the string literals of every script under static/js, the `content:`
strings of the stylesheets, the reader-facing text of every template and the glossary.
Build checks (with FREEZE_BUILD_DIR, as the other build tests): the reader-facing text of every
built page, inline scripts and chart data included. tests/spelling.py holds the word list.

Allowed, each for a stated reason:
  * identifiers that are never shown (element ids, data keys, the HTML attribute aria-labelledby);
  * the query words the search accepts from readers (both spellings are understood);
  * approved report text the freeze keeps as the PI approved it (FROZEN_PHRASES);
  * text quoted from an external source, when a full build shows one (EXTERNAL_PHRASES).
"""
import json
import os
from pathlib import Path

import pytest

from .report_files import report_pages
from .spelling import british_hits, css_content_strings, html_reader_text, js_strings
from GPCompaReports_v2.website.glossary import GLOSSARY

BASE = Path(__file__).resolve().parent.parent
_env = os.environ.get('FREEZE_BUILD_DIR')
if _env:
    BUILD_DIR = Path(_env).expanduser()
    if not BUILD_DIR.is_absolute():
        BUILD_DIR = BASE / _env
else:
    BUILD_DIR = BASE / 'output_v3_demo'

# tokens that are code, not prose: never rendered as text
IDENTIFIERS = {
    'unrecognised',           # search answer kind / data-expect value (search/parse.js, resolve.js)
    'sp-colour-by',           # snake plot select id
    'rx-3d-residue-colour',   # 3D view checkbox id
    'aria-labelledby',        # the HTML attribute
}
# words a reader may type: the parser accepts both spellings (search/parse.js CFR list words)
QUERY_WORDS = {('parse.js', 'neighbourhood'), ('parse.js', 'neighbours')}
# PI-approved report text inside the frozen sections (tests/test_freeze.py); not ours to respell
FROZEN_PHRASES = (
    'Shows magnitude of contact remodelling regardless of direction.',   # sec-charts, TM toggle tooltip
)
# text quoted from an external source (ClinVar conditions, UniProt names, paper titles)
EXTERNAL_PHRASES = ()


def _allowed(text, token, where):
    if token in IDENTIFIERS or (where, token) in QUERY_WORDS:
        return True
    return any(token in p and p in text for p in FROZEN_PHRASES + EXTERNAL_PHRASES)


def _offences(strings, where):
    out = []
    for s in strings:
        for token, word in british_hits(s):
            if not _allowed(s, token, where):
                out.append('%s: %r in %r' % (where, token, ' '.join(s.split())[:160]))
    return out


def test_the_word_list_catches_the_reported_case_and_spares_american_words():
    assert [t for t, _ in british_hits('Colour by')] == ['Colour']
    for w in ('colour', 'favouring', 'behaviour', 'grey', 'centre', 'analysed', 'normalise', 'organise',
              'prioritising', 'summarises', 'recognised', 'visualise', 'minimise', 'labelled', 'modelled',
              'travelled', 'cancelled', 'catalogue', 'licence', 'programme', 'whilst', 'amongst',
              'artefact', 'fulfil', 'enrol', 'neighbourhood', 'signalling', 'nanometre', 'recolour'):
        assert british_hits(w), w
    for w in ('color', 'favoring', 'gray', 'center', 'analyzed', 'analysis', 'analyses', 'normalize',
              'labeled', 'modeled', 'catalog', 'license', 'program', 'programmer', 'while', 'among',
              'artifact', 'otherwise', 'promise', 'precise', 'emphasis', 'synthesis', 'towards',
              'parameter', 'recolor', 'pairwise', 'advertise'):
        assert not british_hits(w), w


def test_the_js_scanner_reads_strings_not_comments_or_regexes():
    src = ("// a colour comment\n/* centre */ var a = 'Color by'; var r = /colour/g;\n"
           "var t = `x ${'in'} y colours`; var d = a / 2 / 3; f('grey');")
    assert js_strings(src) == ['Color by', 'x ', 'in', ' y colours', 'grey']


def test_scripts_use_american_spelling():
    bad = []
    for p in sorted((BASE / 'static' / 'js').rglob('*.js')):
        if 'vendor' in p.parts or '.min.' in p.name:
            continue
        bad += _offences(js_strings(p.read_text(encoding='utf-8')), p.name)
    assert not bad, '\n'.join(bad)


def test_stylesheet_content_uses_american_spelling():
    bad = []
    for p in sorted((BASE / 'static' / 'css').rglob('*.css')):
        bad += _offences(css_content_strings(p.read_text(encoding='utf-8')), p.name)
    assert not bad, '\n'.join(bad)


def test_templates_use_american_spelling():
    bad = []
    for p in sorted((BASE / 'templates').rglob('*.html')):
        bad += _offences(html_reader_text(p.read_text(encoding='utf-8')), p.name)
    assert not bad, '\n'.join(bad)


def test_glossary_and_version_labels_use_american_spelling():
    bad = []
    for t in GLOSSARY:
        bad += _offences([t['term'], t.get('full') or '', t['definition']], 'glossary:%s' % t['id'])
    # data_versions.json: the values a page can show (labels, notes); the keys are data fields
    def values(x):
        if isinstance(x, dict):
            for v in x.values():
                yield from values(v)
        elif isinstance(x, list):
            for v in x:
                yield from values(v)
        elif isinstance(x, str):
            yield x
    bad += _offences(list(values(json.loads((BASE / 'data_versions.json').read_text(encoding='utf-8')))),
                     'data_versions.json')
    assert not bad, '\n'.join(bad)


@pytest.mark.skipif(not (BUILD_DIR / 'index.html').exists(), reason='no build at %s' % BUILD_DIR)
def test_built_pages_use_american_spelling():
    pages = [p for p in sorted(BUILD_DIR.rglob('*.html'))
             if not {'static', 'studio'} & set(p.relative_to(BUILD_DIR).parts)]
    reports = set(report_pages(BUILD_DIR / 'reports')) if (BUILD_DIR / 'reports').is_dir() else set()
    pages = [p for p in pages if p.parent.name != 'reports' or p in reports]
    assert pages
    bad = []
    for p in pages:
        bad += _offences(html_reader_text(p.read_text(encoding='utf-8')), str(p.relative_to(BUILD_DIR)))
    assert not bad, '%d British spelling(s):\n%s' % (len(bad), '\n'.join(bad[:60]))
