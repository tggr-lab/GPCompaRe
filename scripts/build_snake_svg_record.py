#!/usr/bin/env python3
"""Record every change the build makes to the approved snake plot SVGs (approved 2026-11-05).

Run by hand, never by a build, from the project venv (it needs ouroboros):

    .venv-test/bin/python scripts/build_snake_svg_record.py [--check]

For each receptor it renders the snake plot exactly as the report build does (the residue
snapshot in GPCompaReports_v2/data/snake_residues.json, ouroboros, the tooltip and viewBox
injection) and then bakes in the approved additions (website/snake_bake.py: helix labels,
membrane sides, the x.50 marks, the fitted viewBox, terminus labels moved off residues).
It writes GPCompaReports_v2/tests/fixtures/snake_svg_changes_2026-11-05.json:

  viewbox          [before, after]
  helix_labels     the helix pills drawn (TM1 ... H8 present in the plot)
  h8_label         [x, y] of the H8 pill, or null
  x50              [[frozen label, residue, tag drawn], ...]; the outline is always drawn
  moved_labels     [[segment, [old x, old y], [new x, new y]], ...]
  replaced_tags    [[after, before], ...]: the exact strings of every changed tag
  labels_group_sha256, x50_group_sha256: the exact added groups

The freeze test (tests/test_freeze.py) reverses the built SVG with these strings and hashes,
so any other change to the plot still fails. --check compares a fresh render with the file
and exits 1 on any difference.
"""
import argparse
import hashlib
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = ROOT / 'GPCompaReports_v2'
DEST = SITE / 'tests' / 'fixtures' / 'snake_svg_changes_2026-11-05.json'
sys.path.insert(0, str(SITE))

from website import snake_bake  # noqa: E402
from website.page_generators import gpcr_report_helpers as helpers  # noqa: E402


def sha(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def record_for(gid):
    from ouroboros import RenderConfig, SnakePlotRenderer
    svg = SnakePlotRenderer(config=RenderConfig()).render(helpers._snake_protein(gid))
    svg = helpers._inject_svg_viewbox(helpers._inject_svg_tooltips(svg))
    before_vb = snake_bake._SVG_OPEN_RE.search(svg).group(0)
    _, rec = snake_bake.bake(svg)
    old_vb = before_vb.split("viewBox='", 1)[1].split("'", 1)[0]
    return {
        'viewbox': [old_vb, rec['viewbox']],
        'helix_labels': rec['helix_labels'],
        'h8_label': rec['h8_label'],
        'x50': rec['x50'],
        'moved_labels': rec['moved_labels'],
        'replaced_tags': rec['replaced_tags'],
        'labels_group_sha256': sha(rec['labels_group']),
        'x50_group_sha256': sha(rec['x50_group']),
    }


def dump(records):
    lines = ['{']
    keys = sorted(records)
    for i, gid in enumerate(keys):
        lines.append('  %s: %s%s' % (json.dumps(gid), json.dumps(records[gid], ensure_ascii=False),
                                     ',' if i < len(keys) - 1 else ''))
    lines.append('}')
    return '\n'.join(lines) + '\n'


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--check', action='store_true', help='compare with the committed record, write nothing')
    args = ap.parse_args()
    tables = json.loads(helpers._SNAKE_RESIDUES.read_text(encoding='utf-8'))['receptors']
    records = {gid: record_for(gid) for gid in sorted(tables)}
    text = dump(records)
    if args.check:
        same = DEST.exists() and DEST.read_text(encoding='utf-8') == text
        print('snake SVG record %s (%d receptors)' % ('matches' if same else 'DIFFERS', len(records)))
        return 0 if same else 1
    DEST.write_text(text, encoding='utf-8')
    moved = sum(1 for r in records.values() if r['moved_labels'])
    tags = sum(1 for r in records.values() for x in r['x50'] if x[2])
    marks = sum(len(r['x50']) for r in records.values())
    print('wrote %s: %d receptors, %d terminus labels moved, %d of %d x.50 residues tagged'
          % (DEST.relative_to(ROOT), len(records), moved, tags, marks))
    return 0


if __name__ == '__main__':
    sys.exit(main())
