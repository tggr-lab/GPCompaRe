#!/usr/bin/env python3
"""Snapshot the generic numbering shown in the published snake plots.

Run by hand, never by a build. Position search on the Browse page lists, for a
GPCRdb generic number such as 6.48x48, every receptor with a residue there.
It must use the numbering the approved report pages show. The annotation CSVs
number only residues in a high-magnitude contact, and GPCRdb's live API has
changed since the reports were approved (for example it now serves MCHR1 as
the 353-residue isoform, 69 residues off the database's numbering, and no
longer resolves ogr1_human or psyr_human). So the numbering is read from the
snake plot SVGs of the published reports, where each residue carries a
`<title>F300 6.48x48</title>`.

    python3 scripts/extract_snake_numbering.py               # from git ref gh-pages
    python3 scripts/extract_snake_numbering.py --dir BUILD   # from BUILD/reports/

Writes GPCompaReports_v2/data/snake_numbering.json.
"""
import argparse
import datetime
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEST = ROOT / 'GPCompaReports_v2' / 'data' / 'snake_numbering.json'

SNAKE_SEC = re.compile(r'<section class="report-section" id="sec-snake".*?</section>', re.S)
TITLE = re.compile(r'<title>([A-Z])(\d+) ([^<]*)</title>')
GENERIC = re.compile(r'^\d{1,2}\.\d{2,3}x\d{2,3}$')


def git(*args):
    return subprocess.run(['git', '-C', str(ROOT)] + list(args), check=True,
                          capture_output=True, text=True).stdout


def numbering(html):
    sec = SNAKE_SEC.search(html)
    if not sec:
        return None
    seen = {}
    for aa, seq, label in TITLE.findall(sec.group(0)):
        label = label.strip()
        if not GENERIC.match(label):
            continue
        seq = int(seq)
        prev = seen.get(seq)
        if prev and prev != (aa, label):
            raise SystemExit('conflicting labels for residue %d: %s vs %s' % (seq, prev, (aa, label)))
        seen[seq] = (aa, label)
    return [[s, aa, gn] for s, (aa, gn) in sorted(seen.items())]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--ref', default='gh-pages', help='git ref holding the published site')
    ap.add_argument('--dir', help='read BUILD/reports/*.html instead of a git ref')
    args = ap.parse_args()

    pages = {}
    if args.dir:
        src = pathlib.Path(args.dir) / 'reports'
        for p in sorted(src.glob('*.html')):
            pages[p.stem] = p.read_text(encoding='utf-8')
        source = {'kind': 'directory', 'path': str(src.resolve())}
    else:
        sha = git('rev-parse', args.ref).strip()
        names = [n for n in git('ls-tree', '--name-only', sha, 'reports/').split()
                 if n.endswith('.html')]
        for n in names:
            pages[pathlib.PurePosixPath(n).stem] = git('show', '%s:%s' % (sha, n))
        subject = git('log', '-1', '--format=%ci %s', sha).strip()
        source = {'kind': 'git', 'ref': args.ref, 'commit': sha, 'commit_subject': subject}

    receptors, missing = {}, []
    for gid, html in sorted(pages.items()):
        rows = numbering(html)
        if rows:
            receptors[gid] = rows
        else:
            missing.append(gid)

    out = {
        'about': 'Generic numbers shown in the published snake plots, one entry per '
                 'numbered residue: [sequence number, amino acid, GPCRdb display number]. '
                 'Written by scripts/extract_snake_numbering.py; read by the site build '
                 'for Browse position search.',
        'source': source,
        'extracted': datetime.date.today().isoformat(),
        'receptors_without_snake_plot': missing,
        'receptors': receptors,
    }
    DEST.write_text(json.dumps(out, separators=(',', ':')) + '\n', encoding='utf-8')
    n = sum(len(v) for v in receptors.values())
    print('%d receptors, %d numbered residues -> %s (%d KB)%s' % (
        len(receptors), n, DEST.relative_to(ROOT), DEST.stat().st_size // 1024,
        ('; no snake plot: ' + ', '.join(missing)) if missing else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
