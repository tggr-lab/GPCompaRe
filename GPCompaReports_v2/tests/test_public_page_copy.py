"""The Contact and Downloads pages are public, and address a general
scientific audience.

They must carry the approved wording exactly, and must not leak the kind of
internal framing that belonged to the drafting phase: licensing reviews,
packaging requirements, approval status, maintainership, publication
readiness, or "not yet available" language that reads as a limitation rather
than a planned release.
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

CONTACT = BUILD_DIR / 'contact.html'
DOWNLOADS = BUILD_DIR / 'downloads.html'

CONTACT_INTRO = ('Questions about the data, methods, or website? Use the form '
                 'below to contact the TGGR Laboratory.')
DB_TEXT = ('A downloadable version of the GPCompaRe database is being prepared. '
           'Until then, the complete collection of receptor reports can be '
           'explored online.')

#: Wording that must never appear in the visible copy of a public page.
FORBIDDEN = [
    'licens', 'packaging', 'provisional', 'not yet available', 'once assigned',
    'best-effort', 'maintained on', 'pending release', 'no fixed schedule',
    'internal', 'approval', 'publication readiness', 'release blocker',
]

needs_build = pytest.mark.skipif(
    not (CONTACT.exists() and DOWNLOADS.exists()),
    reason='contact/downloads not built in %s' % BUILD_DIR)


def _visible(path):
    """Rendered text a visitor reads. Attribute values are not visible copy."""
    h = path.read_text(encoding='utf-8')
    # the footer's "Data versions" fine print is site-wide chrome, not the page's own copy
    h = re.sub(r'<footer\b.*?</footer>', ' ', h, flags=re.S | re.I)
    h = re.sub(r'<script\b.*?</script>', ' ', h, flags=re.S | re.I)
    h = re.sub(r'<style\b.*?</style>', ' ', h, flags=re.S | re.I)
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', h))


@needs_build
def test_the_contact_intro_is_the_approved_wording():
    assert CONTACT_INTRO in _visible(CONTACT), (
        'the approved contact introduction is missing')


@needs_build
def test_the_contact_page_names_no_individual_and_promises_no_future_contacts():
    text = _visible(CONTACT)
    assert 'once assigned' not in text.lower(), (
        'the page still promises contacts will be listed later')
    assert 'Named scientific and technical contacts' not in text
    emails = set(re.findall(r'[\w.+-]+@[\w.-]+\.\w+', text))
    assert not emails, (
        'the contact page displays an email address: %s. Visitors use the '
        'form; the delivery address is a Formspree dashboard setting and is '
        'not published on the page.' % sorted(emails))


@needs_build
def test_the_downloads_page_offers_the_database_and_no_local_program():
    text = _visible(DOWNLOADS)
    assert 'Database download' in text, 'database heading missing'
    assert text.count('Coming soon') == 1, (
        'expected one "Coming soon" label, found %d' % text.count('Coming soon'))
    assert DB_TEXT in text, 'the approved database text is missing'
    assert 'analysis software' not in text.lower()


@needs_build
def test_no_page_mentions_the_manuscript():
    for name in ('index.html', 'statistics.html'):
        html = (BUILD_DIR / name).read_text(encoding='utf-8').lower()
        assert 'manuscript' not in html, name
        assert 'as submitted' not in html, name


@needs_build
def test_the_landing_page_sends_your_own_structures_to_studio():
    text = _visible(BUILD_DIR / 'index.html')
    assert 'analysis software' not in text.lower()
    assert 'releasable version' not in text.lower()
    assert 'Open GPCompaRe Studio' in text


@needs_build
def test_the_downloads_page_links_back_to_the_receptor_browser():
    html = DOWNLOADS.read_text(encoding='utf-8')
    body = html[html.find('downloads-page'):html.find('</section>')]
    assert re.search(r'href="[^"]*browse/index\.html"', body), (
        'no link back to the receptor browser')
    target = BUILD_DIR / 'browse' / 'index.html'
    assert target.is_file(), 'the browser link points at a missing page'


@needs_build
def test_no_version_doi_or_release_date_is_shown():
    text = _visible(DOWNLOADS)
    assert not re.search(r'\bv?\d+\.\d+\.\d+\b', text), (
        'a version number is shown: %s' % re.findall(r'\bv?\d+\.\d+\.\d+\b', text))
    assert 'doi' not in text.lower(), 'a DOI is shown'
    assert not re.search(r'\b20\d\d[-.]\d\d\b', text), 'a release date is shown'


@needs_build
@pytest.mark.parametrize('page', ['contact', 'downloads'])
def test_no_internal_framing_reaches_the_public_copy(page):
    path = CONTACT if page == 'contact' else DOWNLOADS
    text = _visible(path).lower()
    found = [w for w in FORBIDDEN if w in text]
    assert not found, (
        'the %s page shows internal framing in its visible copy: %s'
        % (page, found))
