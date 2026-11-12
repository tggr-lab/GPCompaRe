"""Data for the GPCRome Atlas page (atlas.html).

    python -m GPCompaReports_v2.analysis.gpcrome_atlas --stage STAGE --batch BATCH_DIR --models MODELS_DIR [--out DIR]

Reads a built site (STAGE/search2/residues/<gid>.json for the residue numbering,
conservation and AlphaMissense; STAGE/data/stats/receptors.json for the receptor
table), the batch run's csv_data (every contact pair and its dRRCS) and the
GPCRdb model pairs, and writes under OUT/atlas/ (OUT defaults to STAGE):

  index.json      receptors, the shared generic-position axis, per receptor and
                  position layers (base64 typed arrays), per receptor segment
                  sums, helix-pair sums and two precomputed layouts
  r/<gid>.json    one receptor: C-alpha traces of both models (inactive
                  superposed on active) and its above-threshold contacts

Everything is deterministic: same inputs, same bytes.
"""
import argparse
import base64
import csv
import gzip
import json
import math
import pathlib
import re
from collections import defaultdict

import numpy as np

SCHEMA = 'gpcompare-atlas/1'
SEG_ORDER = ['N-term', 'TM1', 'ICL1', 'TM2', 'ECL1', 'TM3', 'ICL2', 'TM4', 'ECL2', 'TM5', 'ICL3',
             'TM6', 'ECL3', 'TM7', 'H8', 'C-term']
HELICES = ['TM1', 'TM2', 'TM3', 'TM4', 'TM5', 'TM6', 'TM7', 'H8']
# generic-number prefix -> segment, in sequence order
PREFIX_SEG = {'1': 'TM1', '12': 'ICL1', '2': 'TM2', '23': 'ECL1', '3': 'TM3', '34': 'ICL2', '4': 'TM4',
              '45': 'ECL2', '5': 'TM5', '56': 'ICL3', '6': 'TM6', '67': 'ECL3', '7': 'TM7', '8': 'H8'}
PREFIX_ORDER = list(PREFIX_SEG)
MIN_SHARE = 0.25          # a position is on the axis when at least this share of receptors has it
NET_SCALE = 10.0          # int8 = round(net dRRCS * 10), clipped to +-127
_GN = re.compile(r'^(\d+)\.(\d+)x(\d+)$')


def _b64(arr):
    return base64.b64encode(np.ascontiguousarray(arr).tobytes()).decode('ascii')


def expand_gn(runs, length):
    """[[start, n, 'S.BWxGN']] -> {position: 'S.BWxGN'} (see search_index_v2.gn_runs)."""
    out = {}
    for start, n, disp in runs:
        m = _GN.match(disp)
        if not m:
            out[start] = disp
            continue
        seg, bw, x = m.group(1), int(m.group(2)), int(m.group(3))
        for k in range(n):
            if start + k <= length:
                out[start + k] = '%s.%dx%d' % (seg, bw + k, x + k)
    return out


def gn_key(g):
    m = _GN.match(g)
    return (PREFIX_ORDER.index(m.group(1)), int(m.group(3)))


def read_pairs(path):
    rows = []
    with open(path, newline='') as f:
        for r in csv.DictReader(f):
            rows.append((int(float(r['res1'])), int(float(r['res2'])), float(r['delta_rrcs'])))
    return rows


def read_ca(path):
    """{residue number: (x, y, z)} of the C-alpha atoms of the first chain."""
    opener = gzip.open if str(path).endswith('.gz') else open
    out, chain = {}, None
    with opener(path, 'rt') as f:
        for line in f:
            if line.startswith('ENDMDL'):
                break
            if line.startswith('ATOM') and line[12:16].strip() == 'CA':
                if chain is None:
                    chain = line[21]
                if line[21] != chain:
                    continue
                out.setdefault(int(line[22:26]), (float(line[30:38]), float(line[38:46]), float(line[46:54])))
    return out


def kabsch(mobile, target):
    """Rotation R and translation t that put `mobile` on `target` (rows are points)."""
    mc, tc = mobile.mean(0), target.mean(0)
    h = (mobile - mc).T @ (target - tc)
    u, _, vt = np.linalg.svd(h)
    d = np.sign(np.linalg.det(vt.T @ u.T))
    r = vt.T @ np.diag([1.0, 1.0, d]) @ u.T
    return r, tc - r @ mc


def principal_frame(pts, tm_idx, top_idx):
    """Rotate so the helix-bundle axis is +y with the extracellular side up; centre on the TM core."""
    core = pts[tm_idx] if len(tm_idx) >= 20 else pts
    c = core.mean(0)
    _, _, vt = np.linalg.svd(core - c)
    axis = vt[0]
    if len(top_idx) and ((pts[top_idx].mean(0) - c) @ axis) < 0:
        axis = -axis
    x = vt[1] - (vt[1] @ axis) * axis
    x /= np.linalg.norm(x)
    z = np.cross(x, axis)
    rot = np.vstack([x, axis, z])
    return lambda p: (p - c) @ rot.T


def tsne(x, perplexity=22.0, iters=900, seed=7):
    """Exact t-SNE on cosine distances (283 points; numpy only, deterministic)."""
    n = x.shape[0]
    norm = np.linalg.norm(x, axis=1, keepdims=True)
    norm[norm == 0] = 1.0
    xn = x / norm
    d = np.clip(1.0 - xn @ xn.T, 0.0, 2.0)
    np.fill_diagonal(d, 0.0)
    p = np.zeros((n, n))
    target = math.log(perplexity)
    for i in range(n):
        lo, hi, beta = 0.0, np.inf, 1.0
        di = np.delete(d[i], i)
        for _ in range(60):
            w = np.exp(-di * beta)
            s = w.sum() or 1e-12
            h = math.log(s) + beta * (di * w).sum() / s
            if abs(h - target) < 1e-5:
                break
            if h > target:
                lo, beta = beta, (beta * 2 if hi == np.inf else (beta + hi) / 2)
            else:
                hi, beta = beta, (beta + lo) / 2
        p[i, np.arange(n) != i] = w / s
    p = (p + p.T) / (2 * n)
    p = np.maximum(p, 1e-12)
    rng = np.random.RandomState(seed)
    # start from the two leading principal axes: stable and already meaningful
    u, s, _ = np.linalg.svd(xn - xn.mean(0), full_matrices=False)
    y = u[:, :2] * s[:2]
    y = y / (np.abs(y).max() or 1.0) * 1e-2 + rng.normal(0, 1e-4, (n, 2))
    gains, inc = np.ones((n, 2)), np.zeros((n, 2))
    for it in range(iters):
        sq = (y ** 2).sum(1)
        num = 1.0 / (1.0 + sq[:, None] + sq[None, :] - 2 * y @ y.T)
        np.fill_diagonal(num, 0.0)
        q = np.maximum(num / num.sum(), 1e-12)
        pq = (p * (12.0 if it < 200 else 1.0) - q) * num
        grad = 4 * ((np.diag(pq.sum(1)) - pq) @ y)
        gains = np.where(np.sign(grad) != np.sign(inc), gains + 0.2, gains * 0.8).clip(0.01)
        inc = (0.5 if it < 250 else 0.8) * inc - 200.0 * gains * grad
        y = y + inc
        y = y - y.mean(0)
    y = y / np.abs(y).max()
    return y


def build(stage, batch, models, out):
    stage, batch, models, out = (pathlib.Path(p) for p in (stage, batch, models, out))
    table = json.loads((stage / 'data' / 'stats' / 'receptors.json').read_text())
    cols = table['columns']
    recs = [dict(zip(cols, row)) for row in table['rows']]
    n = len(recs)
    csv_dir = batch / 'csv_data' if (batch / 'csv_data').is_dir() else batch

    res, gns, count = {}, {}, defaultdict(int)
    for r in recs:
        d = json.loads((stage / 'search2' / 'residues' / (r['gid'] + '.json')).read_text())
        res[r['gid']] = d
        gns[r['gid']] = expand_gn(d['gn'], len(d['aa']))
        for g in set(gns[r['gid']].values()):
            if _GN.match(g) and _GN.match(g).group(1) in PREFIX_SEG:
                count[g] += 1
    axis = sorted((g for g, c in count.items() if c >= MIN_SHARE * n), key=gn_key)
    col = {g: i for i, g in enumerate(axis)}
    m = len(axis)

    net = np.zeros((n, m), np.int8)        # net dRRCS x10 (signed sum over the residue's contacts)
    hit = np.zeros((n, m), np.uint8)       # number of above-threshold contacts (capped 255)
    cons = np.full((n, m), 255, np.uint8)  # conservation x100, 255 = no value
    am = np.full((n, m), 255, np.uint8)    # mean AlphaMissense x100, 255 = no value
    aa = np.full((n, m), ord('-'), np.uint8)
    pos = np.zeros((n, m), np.uint16)      # the receptor's own residue number, 0 = absent
    feat = np.zeros((n, m), np.float64)    # layout input: net dRRCS over above-threshold contacts
    rows, detail_dir = [], out / 'atlas' / 'r'
    detail_dir.mkdir(parents=True, exist_ok=True)

    for i, r in enumerate(recs):
        gid, d, gn = r['gid'], res[r['gid']], gns[r['gid']]
        pairs = read_pairs(csv_dir / (gid + '_rrcs_delta.csv'))
        thr = float(r['threshold'])
        seg_of = {}
        for name, a, b in d['segments']:
            for p in range(a, b + 1):
                seg_of[p] = name
        net_all, net_sig, nsig = defaultdict(float), defaultdict(float), defaultdict(int)
        seg_up, seg_dn = defaultdict(float), defaultdict(float)
        hp = defaultdict(float)
        contacts = []
        for a, b, v in pairs:
            ends = (a, b) if a != b else (a,)
            for p in ends:
                net_all[p] += v
            if abs(v) >= thr:
                contacts.append([a, b, round(v, 2)])
                for p in ends:
                    net_sig[p] += v
                    nsig[p] += 1
                    s = seg_of.get(p, '')
                    (seg_up if v > 0 else seg_dn)[s] += abs(v) / len(ends) if len(ends) == 1 else abs(v) / 2
                sa, sb = seg_of.get(a, ''), seg_of.get(b, '')
                if sa in HELICES and sb in HELICES and sa != sb:
                    key = tuple(sorted((HELICES.index(sa), HELICES.index(sb))))
                    hp[key] += v
        for p, g in gn.items():
            j = col.get(g)
            if j is None:
                continue
            pos[i, j] = p
            aa[i, j] = ord(d['aa'][p - 1])
            net[i, j] = int(np.clip(round(net_all.get(p, 0.0) * NET_SCALE), -127, 127))
            hit[i, j] = min(nsig.get(p, 0), 255)
            feat[i, j] = net_sig.get(p, 0.0)
            c = d['cons'][p - 1]
            if c is not None:
                cons[i, j] = min(int(c), 100)
            a_ = d['am'][p - 1]
            if a_ is not None:
                am[i, j] = min(int(a_), 100)

        # C-alpha traces, inactive superposed on active over the residues both models have
        act = read_ca(_model(models, gid, 'active'))
        ina = read_ca(_model(models, gid, 'inactive'))
        common = sorted(set(act) & set(ina))
        A = np.array([act[p] for p in common])
        I = np.array([ina[p] for p in common])
        tm = [k for k, p in enumerate(common) if seg_of.get(p, '').startswith('TM')]
        fit = tm if len(tm) >= 20 else list(range(len(common)))
        rot, t = kabsch(I[fit], A[fit])
        I = I @ rot.T + t
        top = [k for k, p in enumerate(common) if seg_of.get(p, '').startswith('ECL')]
        frame = principal_frame(A, tm, top)
        A, I = frame(A), frame(I)
        moved = np.linalg.norm(A - I, axis=1)
        (detail_dir / (gid + '.json')).write_text(json.dumps({
            'schema': SCHEMA, 'gid': gid, 'residues': common,
            'active': np.round(A * 10).astype(int).ravel().tolist(),      # x, y, z in 0.1 A
            'inactive': np.round(I * 10).astype(int).ravel().tolist(),
            'segments': d['segments'], 'threshold': thr,
            'contacts': sorted(contacts, key=lambda c: -abs(c[2])),
        }, separators=(',', ':')), encoding='utf-8')

        helix_net = [round(seg_up.get(h, 0.0) - seg_dn.get(h, 0.0), 2) for h in HELICES]
        helix_abs = [round(seg_up.get(h, 0.0) + seg_dn.get(h, 0.0), 2) for h in HELICES]
        rows.append({
            'gid': gid, 'symbol': r['symbol'], 'name': r['name'], 'family': r['family'],
            'ligand': r['ligand_group'], 'length': len(d['aa']), 'threshold': thr,
            'n_pairs': r['n_pairs'], 'n_above': r['n_above'], 'above_per_100': r['above_per_100'],
            'sum_abs_above': r['sum_abs_above'], 'share_active': r['share_active'],
            'helix_net': helix_net, 'helix_abs': helix_abs,
            'helix_pairs': [[a, b, round(v, 2)] for (a, b), v in sorted(hp.items()) if abs(v) >= 0.005],
            'tm6_shift': round(float(np.mean([moved[k] for k, p in enumerate(common)
                                             if seg_of.get(p) == 'TM6'] or [0.0])), 2),
            'report': r['report'],
        })

    xy = tsne(feat)
    for i, row in enumerate(rows):
        row['sim_xy'] = [round(float(xy[i, 0]), 4), round(float(xy[i, 1]), 4)]
        row['similar'] = table['similar'].get(row['gid'], [])

    present = (pos > 0)
    index = {
        'schema': SCHEMA,
        'n_receptors': n,
        'sign': 'dRRCS = active minus inactive. Positive: stronger in the active model. Negative: stronger in the inactive model.',
        'threshold_rule': table['meta']['threshold_rule'],
        'helices': HELICES,
        'segments': SEG_ORDER,
        'ligand_groups': table['ligand_groups'],
        'receptors': rows,
        'positions': [{'gn': g, 'segment': PREFIX_SEG[_GN.match(g).group(1)],
                       'n': int(present[:, j].sum()), 'n_hit': int((hit[:, j] > 0).sum()),
                       'n_up': int(((hit[:, j] > 0) & (feat[:, j] > 0)).sum()),
                       'n_down': int(((hit[:, j] > 0) & (feat[:, j] < 0)).sum())}
                      for j, g in enumerate(axis)],
        'layers': {
            'shape': [n, m], 'order': 'row-major, one row per receptor in `receptors` order',
            'net': {'dtype': 'int8', 'scale': NET_SCALE, 'data': _b64(net),
                    'note': 'net dRRCS of the residue (signed sum over all its contacts) x scale, clipped to +-127'},
            'hit': {'dtype': 'uint8', 'data': _b64(hit), 'note': 'number of above-threshold contacts of the residue'},
            'cons': {'dtype': 'uint8', 'missing': 255, 'scale': 100, 'data': _b64(cons)},
            'am': {'dtype': 'uint8', 'missing': 255, 'scale': 100, 'data': _b64(am)},
            'aa': {'dtype': 'uint8', 'data': _b64(aa), 'note': "ASCII one-letter code, '-' where the receptor lacks the position"},
            'pos': {'dtype': 'uint16', 'endian': 'little', 'data': _b64(pos.astype('<u2')),
                    'note': "the receptor's own residue number, 0 where it lacks the position"},
        },
        'layout_note': 'sim_xy: t-SNE (perplexity 22, cosine distance) of the per-position net dRRCS over '
                       'above-threshold contacts. A browsing aid, not a classification.',
    }
    (out / 'atlas' / 'index.json').write_text(json.dumps(index, separators=(',', ':')), encoding='utf-8')
    return index


def _model(models, gid, state):
    for name in ('%s_%s.pdb' % (gid, state), '%s_%s.pdb.gz' % (gid, state)):
        p = models / state / name
        if p.exists():
            return p
    raise FileNotFoundError('%s model of %s under %s' % (state, gid, models))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--stage', required=True)
    ap.add_argument('--batch', required=True)
    ap.add_argument('--models', required=True)
    ap.add_argument('--out')
    a = ap.parse_args()
    idx = build(a.stage, a.batch, a.models, a.out or a.stage)
    print('atlas: %d receptors, %d positions' % (idx['n_receptors'], len(idx['positions'])))


if __name__ == '__main__':
    main()
