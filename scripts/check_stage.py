#!/usr/bin/env python3
"""Check a staged release before anything is published. Exit 1 on any failure.

    python3 scripts/check_stage.py STAGE_DIR
"""
import gzip
import hashlib
import json
import pathlib
import re
import sys

MAX_FILE = 100 * 2**20      # GitHub rejects larger files in a push
MAX_SITE = 1024 * 2**20     # GitHub Pages site limit
RECEPTORS = 283
# gzipped GPCRdb model files: the real ones are about 25 to 150 KiB
MODEL_MIN = 8 * 2**10
MODEL_MAX = 2 * 2**20
STATES = ('active', 'inactive')

ALLOWED = {'.css', '.gif', '.gz', '.html', '.ico', '.jpg', '.js', '.json', '.mjs', '.nojekyll',
           '.png', '.svg', '.ttf', '.txt', '.wasm', '.webp', '.woff', '.woff2', '.xml'}
EXCLUDED_DIRS = ('data', 'poster', 'dossier')
SECRET_NAME = re.compile(r'(^\.env|\.pem$|\.key$|id_rsa|credential|secret|\.docx?$|\.xlsx?$|\.pptx?$|'
                         r'\.pdb$|\.cif$|\.map$|\.bak$|\.pyc$|\.sqlite|\.db$)', re.I)
PRIVATE_TEXT = re.compile(rb'/home/yamir|yamamir|/run/media/|/media/yamir|file:///|'
                          rb'ghp_[A-Za-z0-9]{20}|github_pat_|sk-ant-|BEGIN [A-Z ]*PRIVATE KEY')
TEXT = {'.css', '.html', '.js', '.json', '.mjs', '.svg', '.txt', '.xml'}


def check_models(stage, reports, fails):
    """Every report's two model files exist, are sane, and are the database's own.

    The sha256 of each file after gunzip must equal the Studio pack's
    modelSha256, so the hosted bytes are the unmodified GPCRdb files the Studio
    recognises. Returns the number of model files checked."""
    models = stage / 'models'
    index_path = stage / 'studio' / 'pack' / 'index.json'
    expected = {}
    if index_path.is_file():
        for r in json.loads(index_path.read_text(encoding='utf-8'))['receptors']:
            expected[r['gid']] = r.get('modelSha256') or {}
    wanted = set()
    for report in reports:
        html = report.read_text(encoding='utf-8')
        gid = report.stem
        if 'id="sec-3d"' not in html:
            fails.append('%s has no 3D view section' % report.name)
            continue
        if 'id="sec-clinvar"' not in html:
            fails.append('%s has no ClinVar section' % report.name)
        for state in STATES:
            rel = 'models/%s/%s_%s.pdb.gz' % (state, gid, state)
            wanted.add(rel)
            path = stage / rel
            if not path.is_file():
                fails.append('missing model: %s' % rel)
                continue
            size = path.stat().st_size
            if not MODEL_MIN <= size <= MODEL_MAX:
                fails.append('model size is not sane (%d bytes): %s' % (size, rel))
                continue
            try:
                data = gzip.decompress(path.read_bytes())
            except (OSError, EOFError):
                fails.append('not a gzip file: %s' % rel)
                continue
            want = expected.get(gid, {}).get(state)
            if want is None:
                fails.append('no modelSha256 in the Studio pack index for %s %s' % (gid, state))
            elif hashlib.sha256(data).hexdigest() != want.lower():
                fails.append('model bytes differ from the Studio pack (modelSha256): %s' % rel)
    present = {p.relative_to(stage).as_posix() for p in models.rglob('*.pdb.gz')} if models.is_dir() else set()
    extra = sorted(present - wanted)
    if extra:
        fails.append('models without a report: %s' % extra[:5])
    for rel in ('models/NOTICE.txt', 'static/notices/models-and-viewer.txt',
                'studio/embed/pair-viewer.js', 'studio/embed/NOTICE.txt',
                'studio/embed/THIRD_PARTY_NOTICES.txt'):
        if not (stage / rel).is_file():
            fails.append('missing: %s' % rel)
    embed = stage / 'studio' / 'embed' / 'pair-viewer.js'
    if embed.is_file():
        chunks = re.findall(r'["\']\./(chunks/[\w.-]+\.js)["\']', embed.read_text(encoding='utf-8'))
        if not chunks:
            fails.append('studio/embed/pair-viewer.js names no viewer chunk')
        for chunk in chunks:
            if not (stage / 'studio' / 'embed' / chunk).is_file():
                fails.append('embed chunk not staged: studio/embed/%s' % chunk)
    return len(wanted)


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

    n_models = check_models(stage, reports, fails)
    print('models: %d files' % n_models)
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
