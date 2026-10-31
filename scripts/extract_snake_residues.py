#!/usr/bin/env python3
"""Snapshot the residue tables behind the published snake plots.

Run by hand, never by a build. The site build draws each snake plot from a
residue table, and GPCRdb's live tables no longer match the approved reports:
13 receptors differ (see extract_snake_numbering.py for MCHR1 and the two
renamed entries). So the build reads this snapshot, recovered from the SVGs of
the published reports, where each residue carries its segment and its title.

    python3 scripts/extract_snake_residues.py [--ref gh-pages]

Writes GPCompaReports_v2/data/snake_residues.json.
"""
import argparse
import json
import pathlib
import re
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEST = ROOT / 'GPCompaReports_v2' / 'data' / 'snake_residues.json'

SVG = re.compile(r'<svg id="snakeplot".*?</svg>', re.S)
# The number comes from the title: a circle's id is a coordinate on some loops.
CIRCLE = re.compile(r"<circle class='(\S+)(?: long)? rcircle'.*?original_title='([A-Z])(\d+) ([^']*)'", re.S)


def git(*args):
    return subprocess.run(['git', '-C', str(ROOT)] + list(args), check=True,
                          capture_output=True, text=True).stdout


def residues(html):
    """[[sequence number, amino acid, segment, display number or null], ...]."""
    rows = {}
    for segment, letter, number, display in CIRCLE.findall(SVG.search(html).group(0)):
        rows[int(number)] = [int(number), letter, segment, display.strip() or None]
    return [rows[n] for n in sorted(rows)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ref', default='gh-pages')
    ref = git('rev-parse', parser.parse_args().ref).strip()
    paths = [p for p in git('ls-tree', '--name-only', ref, 'reports/').split()]
    out = {'about': ('Residue tables recovered from the snake plots of the published reports: '
                     '[sequence number, amino acid, segment, display number]. Written by '
                     'scripts/extract_snake_residues.py; read by the site build.'),
           'source': ref, 'receptors': {}}
    for path in sorted(paths):
        html = git('show', '%s:%s' % (ref, path))
        if SVG.search(html):
            out['receptors'][pathlib.Path(path).stem] = residues(html)
    DEST.write_text(json.dumps(out, separators=(',', ':')) + '\n', encoding='utf-8')
    print('%d receptors from %s' % (len(out['receptors']), ref[:7]))


if __name__ == '__main__':
    main()
