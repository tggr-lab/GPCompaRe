# Release checklist

Required checks before publishing a build, whether to gh-pages or to any
other public location. This list is short on purpose. Everything on it is
enforced by `scripts/deploy_pages.sh` except where noted.

A release is one staging directory: the database at its root, the Studio under
`studio/`. `scripts/build_release.sh` assembles it and `scripts/deploy_pages.sh`
publishes it. The sync deletes what the stage does not hold, so there is no
database-only deployment: a database update is staged with the current Studio
build, and a stage without `studio/` is refused.

```bash
bash scripts/build_release.sh --stage STAGE --studio-dist STUDIO_DIST
FREEZE_BUILD_DIR=STAGE SMOKE_BUILD_DIR=STAGE .venv-test/bin/python -m pytest GPCompaReports_v2/tests -rs
bash scripts/deploy_pages.sh STAGE
```

---

## The rule about skipped tests

**A skipped test is not a passing test.**

Most of this project's suite is guarded: tests skip when the build they read
is not on disk, and the browser tests skip when Playwright is not installed
in the interpreter running them. That is correct for day-to-day work, where a
developer without a demo build should not be blocked by 11 red tests.

It is not correct for a release. At release time a skip means the property was
never checked, which is indistinguishable from the property being broken. So
for the checks below, a skip is a failure.

Concretely: `python3 -m pytest GPCompaReports_v2/tests` reporting
`23 passed, 2 skipped` is **not** sufficient to release. One of those skips is
the browser suite, and it has to actually run.

---

## 1. Full suite, with a build present

```bash
bash scripts/build_demo.sh          # or a full build
python3 -m pytest GPCompaReports_v2/tests -rs
```

Read the `-rs` skip report. Every skip must be one you can explain. The two
expected at demo scale are the browser suite (covered by check 2, which runs
it properly) and `test_full_build_covers_every_manifest_receptor`, which
cannot assert full coverage against a five-receptor demo.

Before a real release, run the freeze test against the full build so that
second skip disappears:

```bash
FREEZE_BUILD_DIR=output python3 -m pytest GPCompaReports_v2/tests/test_freeze.py -rs
```

## 2. Browser smoke tests (required, must not be skipped)

```bash
bash scripts/run_browser_tests.sh
```

This covers `v3-nav.js` and `v3-deeplink.js`, the only JavaScript the V3
branch adds to a report page. Neither can be checked by the Python suite: the
Compact-view defect that reached a built page was a CSS specificity problem,
invisible to any test that does not render the page.

`run_browser_tests.sh` **cannot** silently pass. It exits non-zero when the
venv is absent, when Playwright is not installed in it, when there is no build
to test, and when pytest collects no tests. Treat any non-zero exit as a
release blocker, not as "not applicable".

To test exactly what is about to be published rather than the demo:

```bash
SMOKE_BUILD_DIR=output bash scripts/run_browser_tests.sh
```

`scripts/deploy_pages.sh` runs this automatically against the stage, before
anything is pushed.

There is no bypass flag, by design. This is a publication companion site, not
an operational service, so no emergency justifies publishing JavaScript that
was never exercised in a browser. If an exceptional case ever needs the gate
lifted, edit `scripts/deploy_pages.sh` and commit that change: it leaves an
auditable record, which an environment variable set at the shell would not.

## 3. Freeze baseline intact

The PI approved the v2 report content. `tests/fixtures/freeze_manifest.json`
pins it. The freeze test must pass against the build being released, and the
manifest must not have been regenerated as part of the release. Regenerating
it is a separate, deliberate act with manual review, never a release step.

## 4. Contact form: manual Formspree dashboard checks

The form itself is live in code. It posts as plain HTML to
`https://formspree.io/f/mljrqazl` with `method="POST"`, carries a `_subject`
of `GPCompaRe website enquiry`, and includes a `_gotcha` honeypot hidden by
the project stylesheet, removed from the tab order and `aria-hidden`.
`tests/test_contact_form.py` and two browser tests pin all of that.

The four items below **cannot be checked by any test in this repository**.
They are dashboard or deployment settings, and each must be confirmed by a
human before release:

- [x] **Notifications reach `tggrlab@gmail.com`.** Confirmed working by the
      repository owner on 2026-08-26. This covers delivery only; the three
      items below are separate and still open.
- [ ] **Formspree spam protection / reCAPTCHA is enabled** in the form's
      dashboard settings. No CAPTCHA key exists in the markup, and none should:
      it is not a code setting.
- [ ] **"Restrict to Domain" is enabled**, once the final public URL is
      decided. Enter the hostname **without** `https://`.
- [ ] **The deployed site does not send a `Referrer-Policy` stricter than
      `strict-origin-when-cross-origin`.** Formspree's domain restriction reads
      the referrer, so a stricter policy silently breaks submissions. Check any
      host or CDN header, not just the page markup.

## 5. Nothing unresolved from the handoff

`docs/superpowers/V3_DRAFT_HANDOFF.md` section 13 lists decisions the owner
must make, and `docs/superpowers/EXTERNAL_SETUP.md` lists setup only a human
can do (Formspree, reCAPTCHA, licensing, Zenodo). The Downloads page must not
ship a dead link or an invented DOI.

---

## Known non-blocking limitations

Recorded deliberately. Neither affects any scientific value, and both were
traced rather than assumed. No fix is planned for this release.

**NPY6R renders no TM7 helix on its snake plot.** The build log prints
`error with helix 7 'TM7'` once, from
`ouroboros/src/ouroboros/vendor/diagrams_gpcr.py:126`, which catches a
`KeyError` per helix and substitutes fallback coordinates. The cause is that
the data genuinely has no TM7: `npy6r_human` is the only receptor of the 283
with `tm_domains_found: 6`, and its annotation carries no TM7 segment and no
`7.xx` generic numbers at all. NPY6R is the annotated pseudogene `NPY6RP` and
is C-terminally truncated, so there is no seventh helix to draw. Its snake
plot shows 0 TM7 residue circles and no H8, against 26 to 30 in comparable
receptors. Nothing is omitted from the tables.

**NPY6R's snake plot skips one residue circle, GLN64.** 289 of its 290
residues are drawn; positions 60 to 63 and 65 to 70 all appear. GLN64
participates in six contacts, one of them above the receptor threshold
(ΔRRCS −3.905 against a threshold of 2.20), and **it appears in the RRCS
tables normally**. Comparable receptors skip no residues. The cause was not
established; it would require inspecting the GPCRdb residue-map input, and
that investigation was deliberately not pursued.

**In both cases the RRCS tables contain every contact.** These are rendering
gaps in one receptor's snake plot, not missing or altered data.

**Snake plots do not follow GPCRdb.** The build draws them from
`GPCompaReports_v2/data/snake_residues.json`, recovered from the published
reports, not from GPCRdb's API. On 2026-10-31 the live tables differed for 13
receptors: `ogr1` and `psyr` were renamed, MCHR1 became another isoform, and 10
others changed segments or numbering. Refreshing the snapshot would change
frozen plots, so it is a deliberate act with review, never a release step.

---

## First-time setup for the browser tests

Needed once per machine. The system Python is externally managed (PEP 668),
so this goes in a project venv and does not touch the system install.

```bash
python3 -m venv .venv-test
.venv-test/bin/python -m pip install -r GPCompaReports_v2/requirements-test.txt
.venv-test/bin/python -m pip install -r GPCompaReports_v2/requirements-site.txt
.venv-test/bin/python -m pip install ../ouroboros   # the gpcr_synth/ouroboros checkout
.venv-test/bin/python -m playwright install chromium
```

The pinned version is `playwright==1.62.0`, which is what these tests were
written and verified against. `playwright install chromium` is a separate
step and is not optional: the pip package alone has no browser to drive. It
downloads a private Chromium (about 400 MB) into `~/.cache/ms-playwright`.

That browser is deliberately not the snap Chromium. Snap's `home` interface
silently denies access to hidden directories, which has cost this project
time more than once.

If you upgrade Playwright, re-run `playwright install chromium` for the new
version and update the pin in `GPCompaReports_v2/requirements-test.txt`.
