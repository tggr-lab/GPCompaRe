"""The contact form posts to Formspree as plain HTML.

Basic HTML integration only: a real <form action> with method="POST". No
React, no npm, no @formspree/ajax, no CDN script. The form must not ship
disabled, and the placeholder endpoint must be gone.

CAPTCHA and "Restrict to Domain" are Formspree dashboard settings, not code.
They are release checks in docs/superpowers/RELEASE_CHECKLIST.md, and nothing
here pretends a key exists.
"""
import os
import pathlib
import re

import pytest

BASE = pathlib.Path(__file__).resolve().parent.parent
ENDPOINT = 'https://formspree.io/f/mljrqazl'
PLACEHOLDER = 'FORMSPREE_ENDPOINT_NOT_YET_CONFIGURED'

APPROVED_OPTIONS = [
    '', 'Data or annotation issue', 'Website problem',
    'Custom analysis program', 'Scientific question',
    'Data, download or citation question', 'Other',
]
REQUIRED_FIELDS = ['name', 'email', 'institution', 'enquiry_type', 'message']
OPTIONAL_FIELDS = ['receptor', 'page_url']

_env = os.environ.get('FREEZE_BUILD_DIR')
if _env:
    BUILD_DIR = pathlib.Path(_env).expanduser()
    if not BUILD_DIR.is_absolute():
        BUILD_DIR = BASE / _env
else:
    BUILD_DIR = BASE / 'output_v3_demo'

CONTACT = BUILD_DIR / 'contact.html'

needs_build = pytest.mark.skipif(
    not CONTACT.exists(), reason='no built contact page at %s' % CONTACT)


def _form():
    h = CONTACT.read_text(encoding='utf-8')
    # The topbar carries its own search <form>, so look for the closing tag
    # after the contact form starts, not the first one on the page.
    start = h.find('<form class="contact-form"')
    return h[start:h.find('</form>', start)], h


@needs_build
def test_the_placeholder_endpoint_is_completely_gone():
    _, h = _form()
    assert PLACEHOLDER not in h, 'the placeholder endpoint still appears'
    src = (BASE / 'website' / 'page_generators' / 'contact_page.py').read_text(
        encoding='utf-8')
    assert PLACEHOLDER not in src.replace(
        'starts with', ''), 'the generator still defines the placeholder'


@needs_build
def test_the_endpoint_and_method_are_exact():
    form, _ = _form()
    tag = re.search(r'<form[^>]*>', form).group(0)
    assert 'action="%s"' % ENDPOINT in tag, tag
    assert re.search(r'method="post"', tag, re.I), tag


@needs_build
def test_required_visible_fields_are_present_and_enabled():
    form, _ = _form()
    for name in REQUIRED_FIELDS:
        m = re.search(r'<(?:input|select|textarea)\b[^>]*name="%s"[^>]*>' % name, form)
        assert m, 'required field %r missing' % name
        assert 'required' in m.group(0), '%r is not marked required' % name
        assert 'disabled' not in m.group(0), '%r ships disabled' % name
    for name in OPTIONAL_FIELDS:
        m = re.search(r'<input\b[^>]*name="%s"[^>]*>' % name, form)
        assert m, 'optional field %r missing' % name
        assert 'disabled' not in m.group(0), '%r ships disabled' % name


@needs_build
def test_the_submit_button_is_enabled():
    form, _ = _form()
    btn = re.search(r'<button[^>]*type="submit"[^>]*>', form).group(0)
    assert 'disabled' not in btn, 'the submit button still ships disabled'
    assert 'aria-disabled' not in btn


@needs_build
def test_every_label_is_associated_with_its_control():
    form, _ = _form()
    ids = set(re.findall(r'<(?:input|select|textarea)\b[^>]*id="([^"]+)"', form))
    for target in re.findall(r'<label[^>]*for="([^"]+)"', form):
        assert target in ids, 'label points at missing control %r' % target


@needs_build
def test_the_approved_select_options_are_unchanged():
    form, _ = _form()
    sel = re.search(r'<select\b[^>]*name="enquiry_type".*?</select>', form, re.S)
    assert sel, 'enquiry_type select missing'
    values = re.findall(r'<option value="([^"]*)"', sel.group(0))
    assert values == APPROVED_OPTIONS, (
        'the approved enquiry options changed:\n  got      %s\n  approved %s'
        % (values, APPROVED_OPTIONS))


@needs_build
def test_the_subject_is_set():
    form, _ = _form()
    assert re.search(
        r'<input[^>]*type="hidden"[^>]*name="_subject"[^>]*'
        r'value="GPCompaRe website enquiry"', form), '_subject not set'


@needs_build
def test_the_email_field_is_the_reply_address():
    """Formspree uses a field named `email` as the reply-to address."""
    form, _ = _form()
    m = re.search(r'<input\b[^>]*name="email"[^>]*>', form)
    assert m and 'type="email"' in m.group(0), (
        'no email-typed field named `email`, so replies would have no address')


@needs_build
def test_the_honeypot_exists_and_is_hidden_from_people():
    form, h = _form()
    m = re.search(r'<input\b[^>]*name="_gotcha"[^>]*>', form)
    assert m, '_gotcha honeypot missing'
    field = m.group(0)
    assert 'tabindex="-1"' in field, '_gotcha is still reachable by keyboard'
    assert 'required' not in field, '_gotcha must never be required'
    wrapper = re.search(
        r'<div[^>]*class="form-honeypot"[^>]*>.*?name="_gotcha"', form, re.S)
    assert wrapper, '_gotcha is not inside the hidden wrapper'
    assert 'aria-hidden="true"' in wrapper.group(0), (
        '_gotcha is not hidden from assistive technology')
    css = (BASE / 'static' / 'css' / 'site.css').read_text(encoding='utf-8')
    assert '.form-honeypot' in css, 'no project CSS hides the honeypot'


@needs_build
def test_no_javascript_dependency_was_introduced():
    _, h = _form()
    for bad in ('formspree.io/js', '@formspree', 'unpkg.com', 'cdn.jsdelivr',
                'react', 'ReactDOM', 'formspree-react'):
        assert bad.lower() not in h.lower(), (
            'the contact page pulls in %r; the integration must stay plain HTML'
            % bad)
    assert not (BASE / 'package.json').exists(), 'an npm project appeared'


@needs_build
def test_no_captcha_key_is_invented():
    _, h = _form()
    for bad in ('recaptcha', 'g-recaptcha', 'sitekey', 'data-sitekey'):
        assert bad.lower() not in h.lower(), (
            'the page references %r; CAPTCHA is a Formspree dashboard setting '
            'and no key should appear in the markup' % bad)
