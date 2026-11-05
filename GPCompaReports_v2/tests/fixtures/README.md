# Freeze fixtures

`freeze_manifest.json` is the tracked baseline that `tests/test_freeze.py`
compares every build against. This file explains what it covers, what it
does not, and how to update it.

## What the freeze covers

The inner HTML of every `<section class="report-section">` element on every
report page, for all 283 receptors. "Inner HTML" means everything between
the opening `<section ...>` tag and the closing `</section>` tag, not
including the opening tag itself. That boundary is deliberate: the V3
branch adds `id=` and `data-section-title=` attributes to the opening tag
(sanctioned wayfinding), while everything inside is the PI-approved content
that must not move.

For each receptor the manifest stores a SHA-256 over the concatenated inner
HTML of its sections (byte level, not text extracted from the markup) and a
separate count of how many sections were found, so a missing or added
section produces its own clear failure instead of only a hash mismatch.

## What the freeze does not cover

**Styling.** The V3 branch deliberately adds `static/css/v3.css` and
modifies `static/css/site.css` (and, as it turns out, `static/css/landing.css`
too). Pinning stylesheet fingerprints as a passing assertion would fail by
design the moment V3 styling ships, so no test asserts on them. The manifest
still records the pre-V3 SHA-256 of every stylesheet under
`GPCompaReports_v2/output/static/css/` alongside the current source file's
SHA-256, under the `stylesheet_provenance` key. That key is informational
only, so a reader can see exactly which stylesheets the branch touched and
by how much, but nothing in `test_freeze.py` reads it as a pass/fail
condition.

**Runtime JavaScript behaviour.** The freeze says nothing about what scripts
do once the page loads (interactivity, the snake plot's own rendering
behaviour, the deep-link handling, etc.). It only pins the server-rendered
markup that ships inside `report-section` elements.

Anything outside those two categories, meaning the section content itself,
is in scope.

## How to update the baseline

Run the generator by hand against a pristine pre-V3 build (normally
`GPCompaReports_v2/output/`, never a V3 build or anything under
`output_v3_demo/` or `output_v3_alt/`):

```
python3 scripts/build_freeze_manifest.py GPCompaReports_v2/output --force
```

Drop `--force` on a first-time run, when no manifest exists yet; keep it
only to intentionally replace an existing one.

The generator refuses to run if it finds V3 markers in the source directory,
so pointing it at the wrong build fails loudly instead of quietly baking
unapproved changes into the baseline.

The result is a proposal, not a trusted artifact. Review the printed summary
and, ideally, a diff against the previous manifest, before running
`git add GPCompaReports_v2/tests/fixtures/freeze_manifest.json` and
committing. Never regenerate this file as part of a build, a test run, or
any automated script; it exists specifically to catch a build overwriting
the thing it is supposed to protect.

## Deliberate data refresh

A change to the data inside a frozen section (not its wording) is refreshed
section by section, never by regenerating the whole baseline:

```
python3 scripts/build_freeze_manifest.py --refresh OLD_BUILD NEW_BUILD \
    --allow sec-variants --allow sec-changes=gpr3_human,gpr4_human,xcr1_human \
    --keep-old freeze_manifest.pre_<what>_<date>.json --reason "..."
```

`OLD_BUILD` must pass the current manifest. Every section that differs
between the two builds must be named by an `--allow` (for every receptor, or
`=gid,...` for some), or nothing is written. Only the receptors whose
sections changed get a new hash; each receptor also gets per-section hashes
(`sections`), which `test_freeze.py` uses to name the section that moved. The
previous manifest stays beside this one under the `--keep-old` name, and the
refresh is recorded in the manifest's `refreshes` list.

Refreshes so far:

* 2026-11-05, report variant layer from the Studio packs (gnomAD v4.1.2, one
  AlphaMissense score per allele, model numbering, the right receptor for
  GPR3, GPR4 and XCR1): `sec-variants` for every receptor, plus `sec-changes`
  and `sec-tm` (generic numbers and segments) for GPR3, GPR4 and XCR1.
  Previous manifest: `freeze_manifest.pre_variant_refresh_2026-11-05.json`.
  Changelog: `~/scratch/2026-11-05_reports_v3/C_REFRESH_CHANGELOG.tsv`. The
  gnomAD label in Methods and Understanding is handled by the approved-edit
  rule `gnomad-release-2026-11-05`, not by the refresh.

## Approved edits of 2026-11-05 (final pass, plan section A)

Fourteen rules at the top of `freeze_approved_deltas.json` (newest first), each with the
approval, what and why, and an expected rewrite `count` that `test_freeze.py` checks per
receptor (a number, a marker literal counted in the built sections, or one per recorded
string), so a rule that matches too little or too much fails:

* wording rows 1 to 10 and the AlphaMissense intervals (`literal`, or
  `literal_per_receptor` with `values_from: threshold-label-two-decimals` where the
  sentence carries this receptor's threshold);
* the snake plot (P1 to P3): `snake-svg-tags-2026-11-05` rewrites the exact `<svg>` tag
  and moved terminus labels recorded per receptor (`literal_pairs_per_receptor`), and
  `snake-helix-labels-2026-11-05` / `snake-x50-marks-2026-11-05` delete the two baked
  groups only when their SHA-256 is the recorded one (`regex_delete_sha`).

The per-receptor record is `snake_svg_changes_2026-11-05.json`, written by
`scripts/build_snake_svg_record.py` (run by hand; `--check` compares). The baseline
manifest is unchanged. `tests/test_freeze_negative.py` shows that unrelated edits still fail.
