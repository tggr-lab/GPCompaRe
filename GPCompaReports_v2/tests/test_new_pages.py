"""The Contact and Downloads pages must not ship invented credentials or dead links."""
import os
import pathlib
import re
from pathlib import Path

import pytest

BASE = Path(__file__).resolve().parent.parent
_env = os.environ.get('FREEZE_BUILD_DIR')
if _env:
    BUILD_DIR = pathlib.Path(_env).expanduser()
    if not BUILD_DIR.is_absolute():
        BUILD_DIR = BASE / _env
else:
    BUILD_DIR = BASE / 'output_v3_demo'

OUT = BUILD_DIR
CONTACT = OUT / 'contact.html'
DOWNLOADS = OUT / 'downloads.html'

pytestmark = pytest.mark.skipif(not OUT.exists(), reason='needs a demo build on disk')


def test_contact_form_has_every_required_field():
    html = CONTACT.read_text(encoding='utf-8')
    for field in ('name', 'email', 'institution', 'enquiry_type', 'message'):
        assert 'name="%s"' % field in html, 'missing field: %s' % field


def test_contact_form_accepts_no_file_uploads():
    html = CONTACT.read_text(encoding='utf-8')
    assert 'type="file"' not in html


#: The one Formspree endpoint the lab supplied. Any other is invented.
SUPPLIED_FORMSPREE_ENDPOINT = 'https://formspree.io/f/mljrqazl'


def test_contact_page_invents_no_credentials():
    """The endpoint must be the supplied one, and nothing else may be conjured.

    This used to assert that no Formspree endpoint appeared at all, which was
    right while the form was a placeholder. The lab has since supplied one, so
    the check now pins that exact value: a different endpoint would mean an
    invented credential, which is what this test exists to catch.
    """
    html = CONTACT.read_text(encoding='utf-8')
    found = set(re.findall(r'https://formspree\.io/f/[A-Za-z0-9]+', html))
    assert found <= {SUPPLIED_FORMSPREE_ENDPOINT}, (
        'the contact page references a Formspree endpoint that was not '
        'supplied: %s' % sorted(found - {SUPPLIED_FORMSPREE_ENDPOINT}))
    assert not re.search(r'6L[\w-]{20,}', html), 'a reCAPTCHA site key was invented'
    for token in ('sitekey', 'g-recaptcha', 'api_key', 'apiKey', 'secret'):
        assert token.lower() not in html.lower(), (
            'the contact page references %r, which looks like a credential' % token)


def test_downloads_page_offers_no_dead_links():
    """No archive may be linked, and no download control may be shown disabled.

    The page presents both items as planned releases, so there is nothing to
    download yet. The DOI line this test used to require is gone: the page no
    longer shows a DOI, pending or otherwise.
    """
    html = DOWNLOADS.read_text(encoding='utf-8')
    lowered = html.lower()
    # 2026-11-06: the Statistics tables archive is linked; it must exist in the build. Any other archive is invented.
    archives = re.findall(r'href="([^"]+\.(?:zip|tar\.gz|tgz|7z))"', html)
    assert archives == ['data/stats/gpcompare_statistics_tables.zip'], archives
    assert (DOWNLOADS.parent / archives[0]).is_file(), 'the linked statistics archive is not in the build'
    for ext in ('.tar.gz', '.tgz', '.7z'):
        assert ext not in lowered, 'a download link was invented: %s' % ext
    assert lowered.count('.zip') == 1, 'another archive is mentioned'
    body = html[html.find('downloads-page'):html.find('</section>')]
    assert 'disabled' not in body, 'a disabled download control is shown'


def test_downloads_page_invents_no_doi():
    """Presence of the pending line is not enough: assert no real DOI sneaks in beside it."""
    html = DOWNLOADS.read_text(encoding='utf-8')
    assert 'zenodo.org' not in html.lower(), 'a Zenodo record was invented'
    assert not re.search(r'10\.\d{4,9}/\S+', html), 'a DOI-shaped string was invented'
    assert 'doi.org/' not in html.lower(), 'a resolvable DOI link was invented'


def test_both_pages_are_reachable_from_the_nav():
    """Reachability means the target exists, not that its name appears in the markup.

    The nav markup carried these strings before either page was built, so a
    substring check passes even when the page is missing. Assert the files.
    """
    index = (OUT / 'index.html').read_text(encoding='utf-8')
    for name, path in (('contact.html', CONTACT), ('downloads.html', DOWNLOADS)):
        assert name in index, '%s is not linked from the landing page' % name
        assert path.exists(), '%s is linked but was never built' % name
