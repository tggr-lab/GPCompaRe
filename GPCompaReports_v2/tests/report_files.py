"""Which files under reports/ are receptor report pages.

reports/ also holds gene-symbol redirect stubs (reports/ADRB2.html forwards to
reports/adrb2_human.html; see website/seo.py). A stub is recognised strictly:
small, a meta refresh plus a canonical link, and no report section at all. A
page with any report content can never pass as a stub, so the freeze and the
other build checks still see every real report, including unexpected ones.
"""
import re

_REFRESH = re.compile(r'<meta http-equiv="refresh" content="0; url=([\w.-]+\.html)">')


def stub_target(path):
    """The report a redirect stub forwards to, or None if path is not a stub."""
    text = path.read_text(encoding='utf-8')
    if len(text) > 2048 or 'report-section' in text or '<link rel="canonical"' not in text:
        return None
    m = _REFRESH.search(text)
    return m.group(1) if m else None


def report_pages(reports_dir):
    """Sorted report page paths in reports_dir, without the redirect stubs."""
    return [p for p in sorted(reports_dir.glob('*.html')) if stub_target(p) is None]
