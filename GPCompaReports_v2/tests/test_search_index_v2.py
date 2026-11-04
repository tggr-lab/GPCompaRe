"""Search v2 index (website/page_generators/search_index_v2.py).

Builds only the index (no report pages, about 10 s): the database store is loaded from the batch
directory and generate_search_index_v2 writes <tmp>/search2/. Set SEARCH2_DIR to test an existing
build instead. Skips when neither the batch data nor the Studio packs are available.

Batch directory: GPCOMPARE_BATCH_DIR, else the main checkout's
The_batch_RRCS_analyzer/batch_analysis_full/batch_analysis_20260202_151051 (a linked worktree has none).
Studio packs: STUDIO_ROOT (default the main-merge worktree). The node resolver suite
(tests/search_v2/resolve.test.mjs) reads the same build through SEARCH2_DIR.
"""
import gzip
import json
import os
import random
import shutil
import subprocess
from pathlib import Path

import pytest

from GPCompaReports_v2.website.page_generators import search_index_v2 as v2

BASE = Path(__file__).resolve().parent.parent
BUDGET_GZIP = 6 * 1024 * 1024


def _batch_dir():
    env = os.environ.get('GPCOMPARE_BATCH_DIR')
    if env:
        return Path(env)
    try:
        common = subprocess.run(['git', '-C', str(BASE), 'rev-parse', '--path-format=absolute', '--git-common-dir'],
                                capture_output=True, text=True, check=True).stdout.strip()
        root = Path(common).parent
    except (OSError, subprocess.CalledProcessError):
        root = BASE.parent
    return root / 'The_batch_RRCS_analyzer' / 'batch_analysis_full' / 'batch_analysis_20260202_151051'


@pytest.fixture(scope='session')
def index_dir(tmp_path_factory):
    env = os.environ.get('SEARCH2_DIR')
    if env and (Path(env) / 'meta.json').exists():
        return Path(env)
    batch = _batch_dir()
    if not (batch / 'csv_data').exists():
        pytest.skip('no batch data at %s (set GPCOMPARE_BATCH_DIR)' % batch)
    if not (v2.studio_root() / 'public' / 'pack' / 'index.json').exists():
        pytest.skip('no Studio packs at %s (set STUDIO_ROOT)' % v2.studio_root())
    from GPCompaReports_v2.analysis.data_loader import GPCRDataStore
    store = GPCRDataStore(batch_dir=batch).load_all()
    out = tmp_path_factory.mktemp('search2_build')
    v2.generate_search_index_v2(store, out, quiet=True)
    return out / 'search2'


def _load(d, rel):
    return json.loads((d / rel).read_text(encoding='utf-8'))


def _pack(gid):
    return json.loads((v2.studio_root() / 'public' / 'pack' / ('%s.json' % gid)).read_text())


def _tx(rec):
    t = v2.make_tx(rec['strand'], rec['cds'], rec['ex'])
    return t


# ---------------------------------------------------------------------------------- coverage


def test_covers_all_283_receptors(index_dir):
    meta = _load(index_dir, 'meta.json')
    gids = [r[0] for r in meta['receptors']]
    assert len(gids) == 283 == len(set(gids))
    seqs = _load(index_dir, 'seq.json')
    assert len(seqs) == 283
    for i, g in enumerate(gids):
        res = _load(index_dir, 'residues/%s.json' % g)
        assert res['aa'] == seqs[i], g
        assert len(res['dmax']) == len(res['cons']) == len(res['am']) == len(seqs[i]), g
        assert (index_dir / 'variants' / ('%s.json' % g)).exists(), g
    with_tx = {meta['receptors'][i][0] for i in meta['shards']['transcripts']}
    assert with_tx == set(gids) - {'npy6r_human', 'taar3_human'}  # the two pseudogenes have no CDS
    assert len(meta['excluded']) == 4  # gpr26, lgr5, opsx, rxfp1
    assert {e[0] for e in meta['excluded']} >= {'GPR26', 'LGR5', 'RXFP1'}


def test_size_budget(index_dir):
    total = 0
    for f in index_dir.rglob('*.json'):
        total += len(gzip.compress(f.read_bytes(), 9))
    assert total <= BUDGET_GZIP, 'search2 is %.2f MB gzip (budget %.0f MB)' % (total / 2 ** 20, BUDGET_GZIP / 2 ** 20)
    # a typical query touches meta plus one receptor's residues, variants and transcripts
    meta = len(gzip.compress((index_dir / 'meta.json').read_bytes(), 9))
    assert meta < 150 * 1024


def test_every_pack_allele_and_clinvar_record_is_indexed(index_dir):
    meta = _load(index_dir, 'meta.json')
    n_alleles = n_packed = 0
    for g, *_ in meta['receptors']:
        p = _pack(g)
        v = _load(index_dir, 'variants/%s.json' % g)
        assert v['n'] == len(p['variants'] or []), g
        n_alleles += v['n']
        packed = {r[0] for r in v['clinvar']['rows'] if r[11]}
        assert packed == {c[5] for c in (p.get('clinvar') or [])}, g
        n_packed += len(packed)
        assert all(x in (0, 1, 2) for x in v['c'] if x is not None), g
    assert n_alleles == 145345
    assert n_packed == 488


# ------------------------------------------------------------------------- numbering and maps


def test_shifted_numbering_maps(index_dir):
    def tx(gid, ident, v, frame=None):
        t = _load(index_dir, 'transcripts/%s.json' % gid)
        return next(r for r in t['tx'] if r['id'] == ident and r.get('v') == v and r['asm'] == 'GRCh38'
                    and r.get('frame') == frame)

    assert tx('lpar2_human', 'ENST00000407877', 8, 'gnomad')['map'] == ['+', -3]   # gnomAD frame, pack = gnomAD - 3
    assert tx('lpar2_human', 'NM_001395660', 1)['map'] == ['=']                     # MANE = pack
    assert tx('oxer1_human', 'ENST00000378661', 3, 'gnomad')['map'] == ['=']        # gnomAD .3 = pack
    assert tx('oxer1_human', 'NM_148962', 5)['map'][:2] == ['+', 39]
    assert tx('mchr1_human', 'NM_005297', 4)['map'][:2] == ['+', 69]
    assert tx('npff2_human', 'NM_004885', 3)['map'][:2] == ['+', 102]
    for gid in ('ccr2_human', 'gp142_human', 'gpr17_human'):
        assert _load(index_dir, 'transcripts/%s.json' % gid)['nmUsable'] is False, gid
    # the gnomAD frames are 9 and 117 nt longer than today's CDS
    assert _load(index_dir, 'transcripts/lpar2_human.json')['gnomadFrame']['cOffset'] == 9
    assert _load(index_dir, 'transcripts/oxer1_human.json')['gnomadFrame']['cOffset'] == 117


def test_gnomad_hgvsc_maps_to_its_allele(index_dir):
    """Every gnomAD allele: c. on the gnomAD transcript -> GRCh38 position and reference base."""
    meta = _load(index_dir, 'meta.json')
    checked = 0
    for g, *_ in meta['receptors']:
        p = _pack(g)
        if not p['variants']:
            continue
        t = _load(index_dir, 'transcripts/%s.json' % g)
        bases = _load(index_dir, 'cds/%s.json' % g)
        gid_tx, gv = t['gnomadTx'].split('.')
        chrom = p['variants'][0][11].split('-')[0]
        rec = next((r for r in t['tx'] if r['id'] == gid_tx and r['v'] == int(gv) and r['asm'] == 'GRCh38'
                    and r['chrom'] == chrom), None) or next(
            r for r in t['tx'] if r['id'] == gid_tx and r['asm'] == 'GRCh38' and r['chrom'] == chrom)
        tx = _tx(rec)
        for v in p['variants']:
            hg = v[4] or ''
            if not hg.startswith('c.') or not hg[2:-3].isdigit():
                continue
            c = int(hg[2:-3])
            ch, pos, ref, alt = v[11].split('-')
            assert v2.c_to_g(tx, c) == int(pos), (g, v[11], hg)
            b = v2.base_at(bases, int(pos))
            assert b == ref, (g, v[11], b)
            checked += 1
    assert checked > 140000


def _sample_transcripts(index_dir, n_random=50, seed=20261104):
    meta = _load(index_dir, 'meta.json')
    mane, others = [], []
    for i in meta['shards']['transcripts']:
        g = meta['receptors'][i][0]
        for r in _load(index_dir, 'transcripts/%s.json' % g)['tx']:
            if r['src'] == 'uniprot' or not r.get('cds'):
                continue
            (mane if r.get('mane') else others).append((g, r))
    rnd = random.Random(seed)
    return mane + rnd.sample(others, n_random)


def test_transcript_round_trips(index_dir):
    """Every MANE transcript plus 50 random ones: c. -> g. -> c. over the CDS, UTRs and intron offsets."""
    sample = _sample_transcripts(index_dir)
    assert len(sample) > 300
    for g, r in sample:
        tx = _tx(r)
        L = tx['len']
        for c in range(1, L + 1):
            gp = v2.c_to_g(tx, c)
            back = v2.g_to_c(tx, gp)
            assert back == {'pos': c, 'region': 'cds', 'offset': 0}, (g, r['id'], c, back)
        for c in (-1, -10, -50):
            gp = v2.c_to_g(tx, c, region='5utr')
            if gp is not None:
                assert v2.g_to_c(tx, gp) == {'pos': c, 'region': '5utr', 'offset': 0}, (g, r['id'], c)
        for c in (1, 10, 50):
            gp = v2.c_to_g(tx, c, region='3utr')
            if gp is not None:
                assert v2.g_to_c(tx, gp) == {'pos': c, 'region': '3utr', 'offset': 0}, (g, r['id'], c)
        # intronic offsets next to every CDS segment boundary that is an exon edge
        for s in tx['segs'][:-1]:
            end_c = s[3]
            for k in (1, 2, 5):
                gp = v2.c_to_g(tx, end_c, offset=k)
                back = v2.g_to_c(tx, gp)
                if back and back['region'] == 'intron':
                    assert (back['pos'], back['offset']) == (end_c, k), (g, r['id'], end_c, k, back)


def test_par2_anchor(index_dir):
    """NM_005242.6:c.477G>A -> 5:76833084 (GRCh38) / 5:76128909 (GRCh37) / model residue 159."""
    t = _load(index_dir, 'transcripts/par2_human.json')
    nm = next(r for r in t['tx'] if r['id'] == 'NM_005242' and r['v'] == 6 and r['asm'] == 'GRCh38')
    tx = _tx(nm)
    g38 = v2.c_to_g(tx, 477)
    assert g38 == 76833084
    assert v2.base_at(_load(index_dir, 'cds/par2_human.json'), g38) == 'G'
    assert v2.lift38(t['lift'], g38) == ('5', 76128909)
    assert v2.map_pos(nm['map'], (477 + 2) // 3) == 159
    nm37 = next(r for r in t['tx'] if r['id'] == 'NM_005242' and r['v'] == 6 and r['asm'] == 'GRCh37')
    assert v2.c_to_g(_tx(nm37), 477) == 76128909
    assert _pack('par2_human')['sequence'][158] == 'M'


def test_grch37_lift_reproduces_every_allele(index_dir):
    alleles = v2.load_grch37_alleles(v2.sources_root())
    meta = _load(index_dir, 'meta.json')
    n = 0
    for i in meta['shards']['transcripts']:
        g = meta['receptors'][i][0]
        lift = _load(index_dir, 'transcripts/%s.json' % g)['lift']
        for vid, (ch37, p37, *_bases) in alleles.get(g, {}).items():
            got = v2.lift38(lift, int(vid.split('-')[1]))
            assert got == (ch37, p37), (g, vid, got, (ch37, p37))
            n += 1
    assert n > 170000


# ----------------------------------------------------------------------------- residues


def test_residue_layers_come_from_the_right_receptor(index_dir):
    """gpr3/gpr4/xcr1: the database annotation layer is another receptor's; the index uses the packs."""
    for g in ('gpr3_human', 'gpr4_human', 'xcr1_human', 'par2_human'):
        p = _pack(g)
        r = _load(index_dir, 'residues/%s.json' % g)
        assert r['aa'] == p['sequence']
        cons = p.get('conservation') or {}
        for pos, val in cons.items():
            got = r['cons'][int(pos) - 1]
            assert got == int(round(val * 100)), (g, pos)
        gn = {row[0]: row[3] for row in p['residues'] if row[3]}
        decoded = {}
        for start, n, disp in r['gn']:
            seg, bw, x = disp.replace('x', '.').split('.')
            for k in range(n):
                decoded[start + k] = disp if k == 0 else '%s.%dx%d' % (seg, int(bw) + k, int(x) + k)
        assert decoded == gn, g


def test_cfr_flags_follow_the_database_top_positions(index_dir):
    meta = _load(index_dir, 'meta.json')
    top = {gn for gn, rank in meta['cfrRank'].items() if rank <= meta['cfrTop']}
    assert len(top) == 30
    r = _load(index_dir, 'residues/par2_human.json')
    assert r['cfr'].get('159') == meta['cfrRank']['3.36x36'] <= 30   # PAR2 Met159 = 3.36x36, a top CFR position
    assert r['dmax'][158] is not None and r['nsig'].get('159', 0) >= 1


# ------------------------------------------------------------------------------- aliases


def test_alias_keys_match_the_js_normaliser(index_dir):
    node = shutil.which('node')
    if not node:
        pytest.skip('node not installed')
    meta = _load(index_dir, 'meta.json')
    displays = sorted({row[1] for row in meta['aliases']})
    script = ("import('%s').then(m => { const xs = JSON.parse(require('fs').readFileSync(0, 'utf8'));"
              " process.stdout.write(JSON.stringify(xs.map(m.aliasKey))); })"
              % (BASE / 'static' / 'js' / 'search' / 'normalize.js').as_uri())
    out = subprocess.run([node, '-e', script], input=json.dumps(displays), capture_output=True, text=True, check=True)
    js = json.loads(out.stdout)
    py = [v2.alias_key(d) for d in displays]
    diff = [(d, a, b) for d, a, b in zip(displays, py, js) if a != b]
    assert diff == []
    keys = {row[0]: row for row in meta['aliases']}
    for k in ('f2rl1', 'par2', 'p55085', 'hgnc3538', 'geneid2150', 'beta2ar', 'gpr3', 'xcr1'):
        assert k in keys, k
