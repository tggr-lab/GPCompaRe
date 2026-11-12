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
from collections import Counter, defaultdict

import numpy as np
from scipy.cluster.hierarchy import leaves_list, linkage

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
LINK_K = 3                # a link needs each receptor among the other's LINK_K nearest
N_SIMILAR = 8
SEQ_TREE = pathlib.Path(__file__).resolve().parent.parent / 'data' / 'atlas_sequence_tree.nwk'
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


def axis_sides(axis):
    """'in' (intracellular half), 'out' (extracellular half) per axis position. Helices are split at the
    middle of their numbered range; odd helices run outside-in, even helices inside-out."""
    by = defaultdict(list)
    for g in axis:
        by[_GN.match(g).group(1)].append(int(_GN.match(g).group(2)))
    side = []
    for g in axis:
        pre, num = _GN.match(g).group(1), int(_GN.match(g).group(2))
        seg = PREFIX_SEG[pre]
        if seg.startswith('TM'):
            mid = (min(by[pre]) + max(by[pre])) / 2.0
            odd = int(seg[2:]) % 2 == 1
            side.append('in' if (num > mid) == odd else 'out')
        else:
            side.append('out' if seg.startswith('ECL') or seg == 'N-term' else 'in')
    return side


def nj_tree(dist):
    """Neighbor-joining tree as (adjacency, next free node id, {})."""
    n = dist.shape[0]
    d = dist.astype(float).copy()
    live = list(range(n))
    adj = defaultdict(dict)
    nxt = n
    while len(live) > 2:
        sub = d[np.ix_(live, live)]
        r = sub.sum(1)
        q = (len(live) - 2) * sub - r[:, None] - r[None, :]
        np.fill_diagonal(q, np.inf)
        a, b = np.unravel_index(np.argmin(q), q.shape)
        la = 0.5 * sub[a, b] + (r[a] - r[b]) / (2 * (len(live) - 2))
        la, lb = max(la, 0.0), max(sub[a, b] - la, 0.0)
        ia, ib = live[a], live[b]
        new = 0.5 * (d[ia] + d[ib] - d[ia, ib])
        d = np.pad(d, ((0, 1), (0, 1)))
        d[nxt, :nxt], d[:nxt, nxt] = new, new
        adj[nxt][ia] = adj[ia][nxt] = la
        adj[nxt][ib] = adj[ib][nxt] = lb
        live = [x for x in live if x not in (ia, ib)] + [nxt]
        nxt += 1
    ia, ib = live
    adj[ia][ib] = adj[ib][ia] = max(d[ia, ib], 0.0)
    return adj, nxt, {}


def read_newick(text, leaf_index):
    """Unrooted tree from Newick as (adjacency, next free node id, {branch: support}); None when the
    leaves are not exactly `leaf_index`. A two-child root is dissolved into one edge."""
    n = len(leaf_index)
    adj, support, stack, seen = defaultdict(dict), {}, [], set()
    nxt, last, root = n, None, None
    for tok in re.findall(r"[(),;]|[^(),;]+", text.strip()):
        if tok == '(':
            stack.append(nxt)
            nxt += 1
        elif tok in ',;':
            last = None
            continue
        elif tok == ')':
            last = stack.pop()
            if not stack:
                root = last
        else:
            label, _, length = tok.partition(':')
            if last is None:                    # a leaf
                if label not in leaf_index or label in seen:
                    return None
                seen.add(label)
                node = leaf_index[label]
            else:                               # label and length of the group just closed
                node, last = last, None
                if label and stack:
                    try:
                        support[frozenset((node, stack[-1]))] = float(label)
                    except ValueError:
                        pass
            if stack:
                w = max(float(length or 0.0), 0.0)
                adj[node][stack[-1]] = adj[stack[-1]][node] = w
            continue
        last = last if tok == ')' else None
    if len(seen) != n or root is None:
        return None
    if len(adj[root]) == 2:
        (a, wa), (b, wb) = adj.pop(root).items()
        del adj[a][root], adj[b][root]
        adj[a][b] = adj[b][a] = wa + wb
        for old in (frozenset((a, root)), frozenset((b, root))):
            if old in support:
                support[frozenset((a, b))] = support.pop(old)
    return adj, nxt, support


def root_tree(adj, n, nxt, support=None):
    """Root a binary unrooted tree at the midpoint of its longest leaf-to-leaf path.

    Returns (merges, order, newick_fn): merges are scipy-linkage-style rows [a, b, height] sorted by
    height, where the height of a node is the largest distance from it down to a leaf, so cutting by
    height never splits a parent before its children; order is the leaf order of the rooted tree."""
    support = support or {}

    def far(src):
        seen, stack = {src: (0.0, None)}, [src]
        while stack:
            u = stack.pop()
            for v, w in adj[u].items():
                if v not in seen:
                    seen[v] = (seen[u][0] + w, u)
                    stack.append(v)
        end = max((x for x in seen if x < n), key=lambda x: (seen[x][0], -x))
        return end, seen
    e1, _ = far(0)
    e2, seen = far(e1)
    half, u = seen[e2][0] / 2.0, e2
    while seen[seen[u][1]][0] > half:          # walk back from e2 to the edge that holds the midpoint
        u = seen[u][1]
    v = seen[u][1]
    w = adj[u].pop(v)
    adj[v].pop(u)
    root = nxt
    du = min(max(seen[u][0] - half, 0.0), w)
    adj[root][u] = adj[u][root] = du
    adj[root][v] = adj[v][root] = w - du
    if frozenset((u, v)) in support:
        support[frozenset((root, u))] = support[frozenset((root, v))] = support[frozenset((u, v))]

    kids, height, order, todo, closed = {}, {}, [], [(root, None, False)], {}
    while todo:
        x, par, done = todo.pop()
        ch = [c for c in adj[x] if c != par]
        if done:
            height[x] = max(height[c] + adj[x][c] for c in ch)
            closed[x] = len(closed)             # children close before their parent: breaks height ties
            continue
        if x < n:
            height[x] = 0.0
            order.append(x)
            continue
        kids[x] = ch
        todo.append((x, par, True))
        todo.extend((c, x, False) for c in sorted(ch, key=lambda c: -c))
    rank = {x: n + k for k, x in enumerate(sorted(kids, key=lambda x: (height[x], closed[x])))}
    name = lambda x: x if x < n else rank[x]
    merges = [[name(kids[x][0]), name(kids[x][1]), round(height[x], 4)]
              for x in sorted(kids, key=lambda x: rank[x])]

    def newick(labels):
        def w(x, par):
            ch = [c for c in adj[x] if c != par]
            me = labels[x] if x < n else '(' + ','.join(w(c, x) for c in ch) + ')'
            if x >= n and frozenset((x, par)) in support:
                me += '%.3f' % support[frozenset((x, par))]
            return me if par is None else '%s:%.5f' % (me, adj[x][par])
        return w(root, None) + ';'
    return merges, order, newick


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
    pair_all = [defaultdict(float) for _ in range(n)]  # signed dRRCS per generic-numbered contact pair
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
            ja, jb = col.get(gn.get(a)), col.get(gn.get(b))
            if ja is not None and jb is not None and ja != jb:
                pair_all[i][(min(ja, jb), max(ja, jb))] += v
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

    # ---- grouping rules: each gives a similarity matrix, a map, links, neighbor lists and a tree
    keys = sorted({k for d in pair_all for k in d})
    kix = {k: j for j, k in enumerate(keys)}
    pf = np.zeros((n, len(keys)))
    for i, d in enumerate(pair_all):
        for k, v in d.items():
            pf[i, kix[k]] = math.copysign(math.sqrt(abs(v)), v)
    side = axis_sides(axis)
    k_in = np.array([side[a] == 'in' and side[b] == 'in' for a, b in keys])
    k_out = np.array([side[a] == 'out' and side[b] == 'out' for a, b in keys])
    have = aa != ord('-')
    seqid = np.zeros((n, n))
    for i in range(n):
        both = have & have[i]
        seqid[i] = ((aa == aa[i]) & both).sum(1) / np.maximum(both.sum(1), 1)
    onehot = np.zeros((n, m * 26))
    for i in range(n):
        j = np.nonzero(have[i])[0]
        onehot[i, j * 26 + np.clip(aa[i, j].astype(int) - ord('A'), 0, 25)] = 1.0

    def unit(x):
        return x / np.maximum(np.linalg.norm(x, axis=1, keepdims=True), 1e-12)

    def ward(x):
        xn = unit(x)
        u, sv, _ = np.linalg.svd(xn - xn.mean(0), full_matrices=False)
        d = min(20, len(sv))
        return linkage(u[:, :d] * sv[:d], 'ward', optimal_ordering=True)

    sim_all = unit(pf) @ unit(pf).T
    specs = [
        ('pattern', 'Contact pattern', 'Which contacts change between the two models, and in which direction, '
         'over the whole receptor.', pf, None),
        ('inner', 'Intracellular side', 'The same measure, restricted to contacts on the intracellular half '
         'of the helices, the intracellular loops and helix 8.', pf[:, k_in], np.nonzero(k_in)[0]),
        ('outer', 'Extracellular side', 'The same measure, restricted to contacts on the extracellular half '
         'of the helices and the extracellular loops.', pf[:, k_out], np.nonzero(k_out)[0]),
        ('sequence', 'Sequence', 'Residue identity over the GPCRdb generic positions both receptors have.',
         None, None),
    ]
    rules = []
    for rid, label, desc, x, kmap in specs:
        if rid == 'sequence':
            sim = seqid.copy()
            dist = 1.0 - sim
            np.fill_diagonal(dist, 0.0)
            tree, tree_note = None, json.loads(SEQ_TREE.with_suffix('.json').read_text(encoding='utf-8'))
            if SEQ_TREE.is_file():
                tree = read_newick(SEQ_TREE.read_text(encoding='utf-8'), {r['gid']: i for i, r in enumerate(rows)})
            if tree is not None:
                method = ('Maximum-likelihood tree (%s; %s) over the GPCRdb generic residue positions, rooted '
                          'at the midpoint; node height = largest distance down to a leaf'
                          % (tree_note['program'].split(' (')[0], tree_note['model'].split(',')[0]))
            else:
                # fallback: Kimura protein distance from the share of differing residues, neighbor joining
                pd = np.clip(dist, 0.0, 0.8)
                tree = nj_tree(-np.log(1.0 - pd - 0.2 * pd * pd))
                method = ('Neighbor-joining tree on Kimura protein distances over the GPCRdb generic residue '
                          'positions, rooted at the midpoint; node height = largest distance down to a leaf')
            merges, leaf_order, newick = root_tree(tree[0], n, tree[1], tree[2])
            (out / 'atlas' / 'sequence_tree.txt').write_text(
                newick([r['symbol'] for r in rows]) + '\n', encoding='utf-8')
            xy = tsne(onehot)
        else:
            xn = unit(x)
            sim = xn @ xn.T
            z, xy = ward(x), tsne(x)
            merges = [[int(a), int(b), round(float(h), 4)] for a, b, h, _ in z]
            leaf_order = [int(v) for v in leaves_list(z)]
            method = 'Ward linkage on the 20 leading principal axes of the unit-length vectors'
        off = sim.copy()
        np.fill_diagonal(off, -9.0)
        order = np.argsort(-off, axis=1, kind='stable')
        top = [set(order[i, :LINK_K].tolist()) for i in range(n)]
        floor = float(np.quantile(off[np.arange(n), order[:, 0]], 0.25))  # weakest quarter of best matches: no link
        links = sorted([i, j, round(float(sim[i, j]), 3)] for i in range(n) for j in top[i]
                       if i < j and i in top[j] and sim[i, j] >= floor)
        similar = []
        for i in range(n):
            near = []
            for j in order[i, :N_SIMILAR].tolist():
                shared = []
                if rid in ('pattern', 'inner', 'outer'):
                    prod = xn[i] * xn[j]
                    for k in np.argsort(-prod, kind='stable')[:3].tolist():
                        if prod[k] > 0:
                            ka, kb = keys[k if kmap is None else int(kmap[k])]
                            shared.append([axis[ka], axis[kb], 1 if x[i, k] > 0 else -1])
                other = sim_all[i, j] if rid == 'sequence' else seqid[i, j]
                near.append([j, round(float(sim[i, j]), 3), round(float(other), 3), shared])
            similar.append(near)
        rules.append({
            'id': rid, 'label': label, 'description': desc, 'tree_method': method,
            'n_features': int(m if rid == 'sequence' else x.shape[1]), 'link_floor': round(floor, 3),
            'xy': [[round(float(a), 4), round(float(b), 4)] for a, b in xy],
            'links': links, 'similar': similar,
            'tree': {'merges': merges, 'order': leaf_order},
        })
    rules_doc = {
        'schema': SCHEMA, 'default': 'pattern', 'rules': rules,
        'notes': {
            'similarity': 'Cosine similarity of the rule\'s vectors (signed, square-root damped dRRCS per contact '
                          'pair between generic-numbered positions); share of '
                          'identical residues for the sequence rule. 1 = the same, 0 = unrelated.',
            'similar': 'similar[i]: the %d nearest receptors as [index, similarity under this rule, companion '
                       'score, [[position, position, sign] ...]]. The companion score is sequence identity, or '
                       'whole-receptor contact-pattern similarity for the sequence rule. The last item lists up '
                       'to 3 contact pairs that contribute most (sign +1 stronger in the active model, -1 in the '
                       'inactive model); empty for the sequence rule.' % N_SIMILAR,
            'links': 'A link joins two receptors that are each among the other\'s %d nearest under the rule, '
                     'unless the similarity is in the weakest quarter of best matches (link_floor).' % LINK_K,
            'tree': 'merges: scipy linkage rows [a, b, height]; ids below n are receptors, id n + k is the '
                    'cluster made by row k. Undo the last k - 1 merges to get k groups. order: leaf order. '
                    'The sequence tree is also in atlas/sequence_tree.txt (Newick, branch lengths, support '
                    'values on internal branches); tree_method says how it was made. Groups are browsing aids, not classifications.',
        },
    }
    (out / 'atlas' / 'rules.json').write_text(json.dumps(rules_doc, separators=(',', ':')), encoding='utf-8')

    first = rules[0]
    links = first['links']
    for i, row in enumerate(rows):
        row['sim_xy'] = first['xy'][i]
        row['seq_xy'] = rules[-1]['xy'][i]
        row['similar'] = [[rows[j]['gid'], a, b, sh] for j, a, b, sh in first['similar'][i]]

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
        'links': links,
        'rules_file': 'atlas/rules.json',
        'similarity_note': 'receptors[].similar, links and sim_xy follow the default rule (contact pattern); '
                           'atlas/rules.json holds every grouping rule with its map, links, neighbor lists '
                           'and tree, and the definitions.',
        'layout_note': 'sim_xy: t-SNE (perplexity 22, cosine distance) of the contact-pattern vectors. '
                       'seq_xy: the same on residue identity at the generic positions. '
                       'Browsing aids, not classifications.',
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
