#!/usr/bin/env python3
"""Check a staged release before anything is published. Exit 1 on any failure.

    python3 scripts/check_stage.py STAGE_DIR
"""
import json
import pathlib
import re
import sys

MAX_FILE = 100 * 2**20      # GitHub rejects larger files in a push
MAX_SITE = 1024 * 2**20     # GitHub Pages site limit
RECEPTORS = 283

ALLOWED = {'.css', '.gif', '.gz', '.html', '.ico', '.jpg', '.js', '.json', '.mjs', '.nojekyll',
           '.png', '.svg', '.ttf', '.txt', '.wasm', '.webp', '.woff', '.woff2', '.xml'}
EXCLUDED_DIRS = ('data', 'poster', 'dossier')
SECRET_NAME = re.compile(r'(^\.env|\.pem$|\.key$|id_rsa|credential|secret|\.docx?$|\.xlsx?$|\.pptx?$|'
                         r'\.pdb$|\.cif$|\.map$|\.bak$|\.pyc$|\.sqlite|\.db$)', re.I)
PRIVATE_TEXT = re.compile(rb'/home/yamir|yamamir|/run/media/|/media/yamir|file:///|'
                          rb'ghp_[A-Za-z0-9]{20}|github_pat_|sk-ant-|BEGIN [A-Z ]*PRIVATE KEY')
TEXT = {'.css', '.html', '.js', '.json', '.mjs', '.svg', '.txt', '.xml'}


def main(stage):
    fails, total, counts = [], 0, {}
    files = sorted(p for p in stage.rglob('*') if p.is_file())
    for path in files:
        rel = path.relative_to(stage).as_posix()
        size = path.stat().st_size
        total += size
        suffix = path.suffix or path.name
        counts[suffix] = counts.get(suffix, 0) + 1
        if size > MAX_FILE:
            fails.append('%s is larger than 100 MiB' % rel)
        if suffix not in ALLOWED:
            fails.append('unexpected file type: %s' % rel)
        if SECRET_NAME.search(path.name):
            fails.append('file name not allowed: %s' % rel)
        if suffix in TEXT and PRIVATE_TEXT.search(path.read_bytes()):
            fails.append('private text in %s' % rel)

    for name in EXCLUDED_DIRS:
        if (stage / name).exists():
            fails.append('excluded directory is present: /%s/' % name)
    if total > MAX_SITE:
        fails.append('site is %.0f MiB, over the Pages limit' % (total / 2**20))
    for rel in ('.nojekyll', 'index.html', 'statistics.html', 'sitemap.xml', 'studio/index.html',
                'studio/sw.js', 'studio/pack/index.json', 'studio/THIRD_PARTY_NOTICES.txt',
                'studio/fonts/OFL.txt'):
        if not (stage / rel).is_file():
            fails.append('missing: %s' % rel)

    reports = [p for p in (stage / 'reports').glob('*.html')
               if 'http-equiv="refresh"' not in p.read_text(encoding='utf-8')[:600]]
    with_snake = sum('id="snake-plot-data"' in p.read_text(encoding='utf-8') for p in reports)
    if len(reports) != RECEPTORS:
        fails.append('%d report pages, expected %d' % (len(reports), RECEPTORS))
    if with_snake != RECEPTORS:
        fails.append('%d reports have a snake plot, expected %d' % (with_snake, RECEPTORS))

    studio = stage / 'studio'
    if (studio / 'sw.js').is_file():
        sw = (studio / 'sw.js').read_text(encoding='utf-8')
        found = re.search(r'precache:\s*(\[.*?\])|"precache":\s*(\[.*?\])', sw, re.S)
        if not found:
            fails.append('no precache list in studio/sw.js')
        else:
            precache = json.loads(found.group(1) or found.group(2))
            missing = [p for p in precache if not (studio / p).is_file()]
            if missing:
                fails.append('precached but not staged: %s' % missing[:5])
    if (studio / 'pack/index.json').is_file():
        release = json.loads((studio / 'pack/index.json').read_text(encoding='utf-8'))['release']
        missing = [s for s in release['files'].values() if not (studio / 'pack' / s).is_file()]
        if missing:
            fails.append('pack files not staged: %s' % missing[:5])

    print('files: %d, %.1f MiB' % (len(files), total / 2**20))
    print('by type: %s' % ', '.join('%s %d' % kv for kv in sorted(counts.items())))
    print('reports: %d, with snake plot: %d' % (len(reports), with_snake))
    for fail in fails:
        print('FAIL: %s' % fail)
    print('stage check: %s' % ('FAILED' if fails else 'ok'))
    return 1 if fails else 0


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    sys.exit(main(pathlib.Path(sys.argv[1]).resolve()))
