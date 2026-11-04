#!/usr/bin/env python3
"""Validate golden_queries.tsv against the Studio receptor packs (stdlib only).

Re-derives every row's facts from the pack files and exits non-zero on any mismatch:
- gids exist; target rows have positions inside the sequence;
- the pack residue at pos equals ref (or, for a model/transcript conflict, the allele's alt);
- every allele id exists in the row's pack(s) at that position with that ref/alt;
- ClinVar ids named in the note (clinvar=...) are packed P/LP records at that residue; clinvar_raw=... ids are in the
  raw ClinVar cache and are NOT packed;
- complete=... rows list exactly the full cross-receptor set (by sequence, generic number, or hgvsc);
- GRCh37 rows match grch37_liftover.tsv; GRCh37 and off-target GRCh38 positions are checked against the GRCh38
  receptor windows (min..max of each pack's gnomAD positions);
- alternates name real receptors and residues; pseudogene rows have no variants; src= files exist.

Usage: python3 check_golden.py [--pack-dir DIR] [--sources-dir DIR]
Defaults: $GPCOMPARE_PACK_DIR / $GPCOMPARE_PACK_SOURCES, else the Studio main-merge worktree on HAVN.
"""
import argparse
import collections
import csv
import gzip
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = '/home/yamir/Documents/gpcr_synth/gpcompare_studio_web/.claude/worktrees/main-merge'
COLS = ['id', 'query', 'category', 'expect', 'gid', 'pos', 'ref', 'alt', 'alleles', 'alternates', 'assembly', 'note']
EXPECT = {'target', 'targets', 'receptor', 'ambiguous', 'not_coding', 'not_in_resource', 'unrecognised'}
ASSEMBLY = {'GRCh38', 'GRCh37', 'na'}
AA = set('ACDEFGHIKLMNPQRSTVWY')
NONMISSENSE = {'*', '=', 'fs', 'del', 'dup', 'ins', 'delins'}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pack-dir', default=os.environ.get('GPCOMPARE_PACK_DIR', f'{STUDIO}/public/pack'))
    ap.add_argument('--sources-dir', default=os.environ.get('GPCOMPARE_PACK_SOURCES', f'{STUDIO}/pack/sources'))
    ap.add_argument('--tsv', default=os.path.join(HERE, 'golden_queries.tsv'))
    args = ap.parse_args()

    errors = []
    warnings = set()

    def err(rid, msg):
        errors.append(f'{rid}: {msg}')

    index = json.load(open(os.path.join(args.pack_dir, 'index.json')))['receptors']
    gids = [r['gid'] for r in index]
    packs = {}

    def pack(g):
        if g not in packs:
            packs[g] = json.load(open(os.path.join(args.pack_dir, f'{g}.json')))
        return packs[g]

    raw_cv = {}

    def rawcv(g):
        if g not in raw_cv:
            f = os.path.join(args.sources_dir, 'clinvar', f'{g}.json.gz')
            raw_cv[g] = {r['uid']: r for r in json.load(gzip.open(f))['records']} if os.path.exists(f) else {}
        return raw_cv[g]

    # GRCh38 windows per chromosome from the packs' gnomAD positions
    windows = collections.defaultdict(list)
    for g in gids:
        ps = [(v[11].split('-')[0], int(v[11].split('-')[1])) for v in pack(g)['variants'] or []]
        for c in {c for c, _ in ps}:
            xs = [p for cc, p in ps if cc == c]
            windows[c].append((min(xs), max(xs), g))

    def in_window(c, p):
        return [g for lo, hi, g in windows.get(c, []) if lo <= p <= hi]

    lift = {}
    lf = os.path.join(HERE, 'grch37_liftover.tsv')
    with open(lf) as fh:
        for r in csv.DictReader(fh, delimiter='\t'):
            lift[r['grch38']] = r

    with open(args.tsv, newline='') as fh:
        header = fh.readline().rstrip('\n').split('\t')
        rows = [dict(zip(header, line.rstrip('\n').split('\t'))) for line in fh if line.strip('\n')]
    if header != COLS:
        print(f'bad header {header}', file=sys.stderr)
        return 1

    seen_q = set()
    for n, row in enumerate(rows, 1):
        rid = row.get('id', f'line{n + 1}')
        if len(row) != len(COLS) or None in row.values():
            err(rid, 'wrong number of columns')
            continue
        if rid != f'G{n:03d}':
            err(rid, f'id out of sequence (expected G{n:03d})')
        q = row['query']
        if q in seen_q:
            err(rid, f'duplicate query {q!r}')
        seen_q.add(q)
        exp = row['expect']
        if exp not in EXPECT:
            err(rid, f'bad expect {exp}')
        if row['assembly'] not in ASSEMBLY:
            err(rid, f"bad assembly {row['assembly']}")
        note = row['note']

        gl = [g for g in row['gid'].split(';') if g]
        for g in gl:
            if g not in gids:
                err(rid, f'unknown gid {g}')
        if any(g not in gids for g in gl):
            continue
        pl = [p for p in row['pos'].split(';') if p]
        if pl and len(pl) != len(gl):
            err(rid, 'gid and pos lists differ in length')
            continue
        ref, alts = row['ref'], [a for a in row['alt'].split(',') if a]
        alleles = [a for a in row['alleles'].split(',') if a]

        if exp in ('target', 'targets') and (not gl or not pl):
            err(rid, f'{exp} row needs gid and pos')
        if exp == 'target' and len(gl) != 1:
            err(rid, 'target row must name one receptor')
        if exp == 'receptor' and (len(gl) != 1 or pl):
            err(rid, 'receptor row names one gid and no pos')
        if exp == 'unrecognised' and (gl or pl or alleles):
            err(rid, 'unrecognised row must be empty')
        if ref and ref not in AA:
            err(rid, f'bad ref {ref}')
        for a in alts:
            if a not in AA and a not in NONMISSENSE:
                err(rid, f'bad alt {a}')

        # residues
        for g, p in zip(gl, pl):
            pk = pack(g)
            p = int(p)
            if not 1 <= p <= len(pk['sequence']):
                err(rid, f'{g} has no residue {p}')
                continue
            here = pk['sequence'][p - 1]
            rr = [r for r in pk['residues'] if r[0] == p]
            if rr and rr[0][1] != here:
                warnings.add(f'{g} {p}: residues table says {rr[0][1]}, sequence (model) says {here}; rows use the sequence')
            if ref and here != ref:
                conflict_ok = any(v[0] == p and v[13] and v[11] in alleles for v in pk['variants'] or [])
                gp = (pk['provenance'].get('gnomad') or {}).get('conflictPositions') or []
                if not conflict_ok and not (p in gp and 'conflict' in note):
                    err(rid, f'{g} residue {p} is {here}, row says {ref}')
            if 'novar' in note and any(v[0] == p for v in pk['variants'] or []):
                err(rid, f'novar but {g} has alleles at {p}')

        # alleles
        found = {}
        for a in alleles:
            hit = None
            for g, p in zip(gl, pl):
                for v in pack(g)['variants'] or []:
                    if v[11] == a and v[0] == int(p):
                        hit = (g, v)
            if not hit:
                cvh = [(g, r) for g, p in zip(gl, pl) for r in pack(g).get('clinvar') or [] if r[17] == a and r[0] == int(p)]
                if cvh:
                    hit = (cvh[0][0], None)
                else:
                    err(rid, f'allele {a} not in pack(s) {gl} at {pl}')
                    continue
            found[a] = hit
            g, v = hit
            if v is not None and ref:
                if v[1] != ref:
                    err(rid, f'allele {a} ref {v[1]} != {ref}')
                if alts and v[2] not in alts:   # a locus row (no alt) lists every allele at the base
                    err(rid, f'allele {a} alt {v[2]} not in {alts}')
        # rows naming a substitution with gnomAD orientation: alleles must be all alleles of it unless allele-specific
        if exp == 'target' and alleles and len(alts) == 1 and gl:
            g, p = gl[0], int(pl[0])
            all_sub = {v[11] for v in pack(g)['variants'] or [] if v[0] == p and v[1] == ref and v[2] == alts[0]}
            if not set(alleles) <= all_sub | {r[17] for r in pack(g).get('clinvar') or []}:
                err(rid, 'alleles outside the substitution')

        # ClinVar
        for m in re.finditer(r'\bclinvar=([\d,]+)', note):
            for vid in m.group(1).split(','):
                recs = [(g, r) for g in gl for r in pack(g).get('clinvar') or [] if r[5] == int(vid)]
                if not recs:
                    err(rid, f'ClinVar {vid} not packed for {gl}')
                    continue
                g, r = recs[0]
                if pl and (r[0] != int(pl[0]) or r[1] != ref or (alts and r[2] not in alts)):
                    err(rid, f'ClinVar {vid} is {r[0]}{r[1]}>{r[2]}, row says {pl[0]}{ref}>{alts}')
                vac = r[6].split('.')[0]
                if q.upper().startswith('VCV') and not q.upper().startswith(vac):
                    err(rid, f'query VCV does not match record {r[6]}')
        for m in re.finditer(r'\bclinvar_raw=(\d+)', note):
            uid = m.group(1)
            where = [g for g in (gl or gids) if uid in rawcv(g)]
            if not where:
                err(rid, f'ClinVar {uid} not in raw cache of {gl or "any receptor"}')
            if any(r[5] == int(uid) for g in gids for r in pack(g).get('clinvar') or []):
                err(rid, f'ClinVar {uid} is packed, row says not')
            vacc = re.match(r'(?i)vcv0*(\d+)', q)
            if vacc and vacc.group(1) != uid:
                err(rid, f'query VCV {vacc.group(1)} != {uid}')

        # completeness
        m = re.search(r'\bcomplete=([^\s;]+)', note)
        if m:
            kind = m.group(1)
            got = set(zip(gl, map(int, pl)))
            if kind == 'seq':
                p = int(pl[0])
                want = {(g, p) for g in gids if len(pack(g)['sequence']) >= p and pack(g)['sequence'][p - 1] == ref}
                if alts:
                    want_al = {v[11] for g, _ in want for v in pack(g)['variants'] or [] if v[0] == p and v[1] == ref and v[2] in alts}
                    if want_al != set(alleles):
                        err(rid, f'complete=seq alleles differ: missing {want_al - set(alleles)}, extra {set(alleles) - want_al}')
            elif kind.startswith('gn:'):
                parts = kind.split(':')
                gn, aa1 = parts[1], (parts[2] if len(parts) > 2 else None)
                want = {(g, r[0]) for g in gids for r in pack(g)['residues'] if r[3] == gn and (aa1 is None or r[1] == aa1)}
            elif kind.startswith('hgvsc:'):
                c = kind.split(':', 1)[1]
                hits = [(g, v) for g in gids for v in pack(g)['variants'] or [] if v[4] == c and v[12] is None]
                want = {(g, v[0]) for g, v in hits}
                if {v[11] for _, v in hits} != set(alleles):
                    err(rid, 'complete=hgvsc alleles differ')
            else:
                err(rid, f'unknown complete={kind}')
                want = got
            if want != got:
                err(rid, f'complete={kind}: missing {sorted(want - got)[:5]}, extra {sorted(got - want)[:5]}')

        # genomic positions
        if row['assembly'] == 'GRCh37':
            nums = [int(x.replace(',', '')) for x in re.findall(r'(?<!\d)(\d[\d,]{5,})', q.replace('\\t', ' '))]
            mapped = {(lift[k]['grch37'], k) for k in lift}
            ok = False
            for a in alleles:
                c, p38 = a.split('-')[0], a.split('-')[1]
                L = lift.get(f'{c}:{p38}')
                if not L:
                    err(rid, f'no liftover for {a}')
                    continue
                p37 = int(L['grch37'].split(':')[1])
                if p37 in nums or p37 - 1 in nums:
                    ok = True
                    hits = in_window(c, p37)
                    if hits and 'FALLS INSIDE' not in note and p37 != int(p38):
                        err(rid, f'GRCh37 {c}:{p37} lies in GRCh38 window(s) {hits}: assembly ambiguous, note it')
            if not ok:
                err(rid, f'GRCh37 query position {nums} matches no liftover of {alleles}')
        elif row['assembly'] == 'GRCh38' and alleles and exp in ('target', 'targets'):
            nums = {int(x.replace(',', '')) for x in re.findall(r'(\d[\d,]{5,})', q.replace('\\t', ' '))}
            for a in alleles:
                p38 = int(a.split('-')[1])
                if nums and p38 not in nums and p38 - 1 not in nums:
                    err(rid, f'allele {a} position not in query')
        if row['assembly'] == 'GRCh38' and not gl:
            mm = re.match(r'^(?:chr)?(\w+)[-:](\d+)', q)
            if mm and in_window(mm.group(1), int(mm.group(2))):
                err(rid, f'position inside receptor window {in_window(mm.group(1), int(mm.group(2)))}')

        # alternates
        for item in [x.strip() for x in row['alternates'].split('|') if x.strip()]:
            parts = item.split(':')
            kind = parts[0]
            if kind == 'receptor':
                if parts[1] not in gids:
                    err(rid, f'alternate receptor {parts[1]} unknown')
            elif kind in ('change', 'residue'):
                g, p, sub = parts[1], int(parts[2]), parts[3]
                r0 = sub.split('>')[0]
                if g != '*':
                    if g not in gids or len(pack(g)['sequence']) < p or pack(g)['sequence'][p - 1] != r0:
                        err(rid, f'alternate {item}: residue mismatch')
            elif kind == 'generic':
                if not any(r[3] == parts[1] for g in gids for r in pack(g)['residues']):
                    err(rid, f'alternate {item}: no such generic number')
            elif kind not in ('clinvar', 'rsid', 'gene_id', 'hgnc'):
                err(rid, f'unknown alternate kind {kind}')

        if row['category'] == 'pseudogene':
            for g in gl:
                if pack(g)['variants']:
                    err(rid, f'{g} is not variant-free')

        for m in re.finditer(r'src=(\S+?):', note):
            path = m.group(1)
            if '*' in path:
                continue
            full = os.path.join(args.pack_dir, os.path.basename(path)) if path.startswith('public/pack/') else os.path.join(args.sources_dir, path.split('pack/sources/', 1)[-1])
            if not os.path.exists(full):
                err(rid, f'src {path} missing')

    cats = collections.Counter(r['category'] for r in rows)
    exps = collections.Counter(r['expect'] for r in rows)
    print(f'{len(rows)} rows; expect: {dict(exps)}')
    print('categories: ' + ', '.join(f'{k} {v}' for k, v in sorted(cats.items())))
    for w in sorted(warnings):
        print('note: ' + w)
    if errors:
        print(f'{len(errors)} problem(s):', file=sys.stderr)
        for e in errors:
            print('  ' + e, file=sys.stderr)
        return 1
    print('OK: every row re-derived from the packs')
    return 0


if __name__ == '__main__':
    sys.exit(main())
