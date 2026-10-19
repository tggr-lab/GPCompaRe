"""Generate the Contact page.

The form posts to Formspree over plain HTML: a real <form action> with
method="POST". No JavaScript, no npm package, no AJAX helper.

The template disables the form whenever this endpoint still starts with
"FORMSPREE_", so a placeholder can never ship looking live. That guard stays.

Spam protection beyond the _gotcha honeypot (Formspree CAPTCHA and "Restrict
to Domain") is dashboard configuration, not code, and is recorded as a manual
release check in docs/superpowers/RELEASE_CHECKLIST.md.
"""

FORMSPREE_ENDPOINT = 'https://formspree.io/f/mljrqazl'
#: The form's notifications are delivered to the lab account. That routing
#: is a Formspree dashboard setting, not a value this module controls, and
#: the address is deliberately not rendered on the page: visitors use the
#: form, and a published mailto is an invitation to scrapers.


def generate_contact_page(env, store, output_dir):
    template = env.get_template('contact.html')
    html = template.render(
        static_prefix='',
        active_page='contact',
        nav_home_url='index.html',
        nav_browse_url='browse/index.html',
        nav_stats_url='statistics.html',
        nav_downloads_url='downloads.html',
        nav_contact_url='contact.html',
        page_title='Contact · GPCompaRe',
        page_path='contact.html',
        total_gpcrs=len(store.gpcr_ids),
        formspree_endpoint=FORMSPREE_ENDPOINT,
    )
    (output_dir / 'contact.html').write_text(html, encoding='utf-8')
    print("  Generated: contact.html")
