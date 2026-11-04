"""Search v2 index: lazy JSON shards under `<output>/search2/` for static/js/search/resolve.js.

Plan: docs/plans/2026-11-04_search_v2_and_studio_features.md (sections 3, 4, P3 and the addendum
"every transcript, both assemblies"). Golden spec: tests/search_v2/README.md.

Inputs (no network):
- the database store (GPCRDataStore): per-residue max |dRRCS|, threshold-passing contacts and the CFR
  ranking, i.e. the database's own structural numbers;
- the Studio packs (STUDIO_ROOT, default the main-merge worktree): sequence, residue table (segment,
  generic number), conservation, mean AlphaMissense, gnomAD v4.1.2 alleles, packed ClinVar P/LP
  records, and the raw per-gene ClinVar caches (every single-gene record, any class);
- search_sources/ (SEARCH_SOURCES): HGNC, UniProt, curated aliases, every transcript on both
  assemblies, protein-to-model alignments, NM_ version relations, GRCh37 block maps.

Residue annotations (conservation, AlphaMissense, generic numbers) come from the packs because the
database's own annotation layer is wrong for gpr3/gpr4/xcr1; structural facts (CFR, dRRCS) come from
the database. The CFR flag marks a residue whose pack generic number is among the database's top
CFR positions, the same rule the report snake plots use.

Shards (all JSON, compact; the deploy gzips them; sizes are budgeted by tests):
  meta.json                   receptors, aliases (aliasKey-normalised), excluded receptors, gene windows on
                              GRCh38 and GRCh37 (incl. the P2RY8 PAR-Y copy), shard parameters, releases
  seq.json                    the 283 model sequences, in receptor order
  txindex.json                transcript and protein accession (ENST, ENSP, NM_, NP_, XM_, XP_; no version) ->
                              [receptor idx], the gene it is MANE or model-identical for first (LTB4R/LTB4R2 share some)
  residues/<gid>.json         every model residue: aa, segment, generic number, CFR rank, max |dRRCS|,
                              threshold-passing contacts, conservation, mean AlphaMissense
  variants/<gid>.json         gnomAD alleles (columnar), dropped alleles, ClinVar records (all classes)
  transcripts/<gid>.json      every transcript: exons, CDS segments (c. <-> g. blocks), strand, protein
                              ids, protein->model map; NM_ version relations; GRCh38->GRCh37 lift blocks
  cds/<gid>.json              reference bases of every coding exon (GRCh38, plus strand), for codon and
                              reference-base checks
  generic/<segment>.json      generic number -> [[receptor, pos, aa], ...]
  rsid/<NN>.json              rs number -> receptor indices (NN = number mod RSID_SHARDS)
  clinvar/<NN>.json           ClinVar Variation ID -> receptor index (single-gene records)
  hgvsc/<NN>.json             gnomAD c. change -> receptor indices (NN = c. position mod HGVSC_SHARDS)
  subst/<NN>.json             observed substitution '<pos><ref><alt>' (model numbering; gnomAD allele or ClinVar
                              missense record) -> receptor indices (NN = pos mod SUBST_SHARDS), for bare changes

Cheapest way to build only this index (about 30 s, no report pages):
    .venv-test/bin/python -m GPCompaReports_v2.website.page_generators.search_index_v2 \
        --output /tmp/search2_build --batch-dir <batch_analysis_20260202_151051>
"""

import csv
import gzip
import json
import os
import re
import shutil
import unicodedata
from collections import defaultdict
from pathlib import Path

RSID_SHARDS = 64
CFR_TOP = 30  # the report snake plots colour the top 30 CFR positions
CLINVAR_SHARDS = 32
HGVSC_SHARDS = 32
SUBST_SHARDS = 32
VERSION = 2

HERE = Path(__file__).resolve().parent
BASE = HERE.parent.parent  # GPCompaReports_v2
DEFAULT_STUDIO = '/home/yamir/Documents/gpcr_synth/gpcompare_studio_web/.claude/worktrees/main-merge'

AM_ALPHABET = 'ACDEFGHIKLMNPQRSTVWY'
AA3 = {
    'Ala': 'A', 'Arg': 'R', 'Asn': 'N', 'Asp': 'D', 'Cys': 'C', 'Gln': 'Q', 'Glu': 'E', 'Gly': 'G',
    'His': 'H', 'Ile': 'I', 'Leu': 'L', 'Lys': 'K', 'Met': 'M', 'Phe': 'F', 'Pro': 'P', 'Ser': 'S',
    'Thr': 'T', 'Trp': 'W', 'Tyr': 'Y', 'Val': 'V', 'Ter': '*', 'Sec': 'U',
}
ONE3 = {v: k for k, v in AA3.items()}
CODON = {}
_B = 'TCAG'
_AAS = 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG'
for _i, _a in enumerate(_B):
    for _j, _b in enumerate(_B):
        for _k, _c in enumerate(_B):
            CODON[_a + _b + _c] = _AAS[_i * 16 + _j * 4 + _k]
COMP = str.maketrans('ACGTN', 'TGCAN')

RELEASES = {
    'gnomad': {'label': 'gnomAD v4.1.2', 'dataset': 'gnomad_r4', 'fetched': '2026-10-18'},
    'clinvar': {'label': 'ClinVar 2026-10-11', 'build': 'Build261011-1710.1', 'fetched': '2026-10-19'},
    'ensembl': {'label': 'Ensembl 116', 'grch38': 'GRCh38.p14', 'grch37': 'GRCh37.p13', 'fetched': '2026-11-04'},
    'refseq': {'label': 'NCBI RefSeq (Ensembl otherfeatures GRCh38; UCSC hg19.ncbiRefSeq 2024-09-18)', 'fetched': '2026-11-04'},
    'hgnc': {'label': 'HGNC 2026-10-30', 'fetched': '2026-11-04'},
    'uniprot': {'label': 'UniProt 2026_04', 'fetched': '2026-11-04'},
    'alphamissense': {'label': 'AlphaMissense (Cheng et al. 2023)'},
    'database': {'label': 'GPCompaRe RRCS batch 2026-02-02'},
}

STAR = {
    'practice guideline': 4,
    'reviewed by expert panel': 3,
    'criteria provided, multiple submitters, no conflicts': 2,
    'criteria provided, conflicting classifications': 1,
    'criteria provided, conflicting interpretations': 1,
    'criteria provided, single submitter': 1,
}


# ------------------------------------------------------------------------------------- normalise

_DASHES = re.compile('[‐‑‒–—―−﹘﹣－]')
_ARROWS = re.compile(r'\s*(?:[→⇒➔➜➝➡⟶⟹↦⭢›]|->|=>)\s*')
_INVISIBLE = re.compile('[​-‍⁠﻿­]')
_QUOTES = re.compile('[‘’‚‛“”„‟«»"\'`]')
GREEK = {
    'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'ε': 'epsilon', 'κ': 'kappa', 'λ': 'lambda',
    'μ': 'mu', 'µ': 'mu', 'ν': 'nu', 'π': 'pi', 'σ': 'sigma', 'τ': 'tau', 'ω': 'omega',
    'Α': 'alpha', 'Β': 'beta', 'Γ': 'gamma', 'Δ': 'delta', 'Ε': 'epsilon', 'Κ': 'kappa', 'Λ': 'lambda',
    'Μ': 'mu', 'Ν': 'nu', 'Π': 'pi', 'Σ': 'sigma', 'Τ': 'tau', 'Ω': 'omega',
}


def normalize_query(raw):
    """Python port of normalize.js normalizeQuery (used for alias keys only)."""
    s = unicodedata.normalize('NFKC', str(raw))
    s = _INVISIBLE.sub('', s)
    s = _QUOTES.sub('', s)
    s = _DASHES.sub('-', s)
    s = _ARROWS.sub('>', s)
    s = s.replace('×', 'x')
    s = re.sub(r'[Δδ](?=\d)', ' delta', s)
    s = re.sub(r'(?i)-\s*delta(?=\d)', ' delta', s)
    s = re.sub(r'\s+', ' ', s).strip()
    s = re.sub(r'\s*[;,]+$', '', s).strip()
    return s


def alias_key(term):
    """Python port of normalize.js aliasKey: Greek spelled out, lower case, only a-z0-9 kept."""
    s = normalize_query(term)
    s = ''.join(GREEK.get(c, c) for c in s).lower()
    return re.sub(r'[^a-z0-9]', '', s)


# ---------------------------------------------------------------------- transcript coordinate maps

def make_tx(strand, segs, exons, chrom=None):
    """Normalised transcript: segs [[gs, ge, cs, ce]] by c., exons ascending and covering every segment."""
    segs = sorted([list(map(int, s)) for s in segs], key=lambda s: s[2])
    ex = sorted([sorted(map(int, e)) for e in exons])
    for s in segs:  # RefSeq alignments: a CDS block can sit outside the listed exons
        if not any(e[0] <= s[0] and s[1] <= e[1] for e in ex):
            ex.append([s[0], s[1]])
    ex.sort()
    merged = []
    for e in ex:
        if merged and e[0] <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], e[1])
        else:
            merged.append(list(e))
    return {'strand': int(strand), 'segs': segs, 'exons': merged, 'chrom': chrom,
            'len': segs[-1][3] if segs else 0}


def _seg_g(tx, s, c):
    return s[0] + (c - s[2]) if tx['strand'] == 1 else s[1] - (c - s[2])


def _tx_exons(tx):
    """Exons in transcript order with transcript coordinates [g_lo, g_hi, t_start]."""
    ex = tx['exons'] if tx['strand'] == 1 else list(reversed(tx['exons']))
    out, t = [], 1
    for a, b in ex:
        out.append((a, b, t))
        t += b - a + 1
    return out


def _g_to_t(tx, g):
    for a, b, t in _tx_exons(tx):
        if a <= g <= b:
            return t + (g - a if tx['strand'] == 1 else b - g)
    return None


def _t_to_g(tx, t):
    for a, b, t0 in _tx_exons(tx):
        n = b - a + 1
        if t0 <= t < t0 + n:
            return a + (t - t0) if tx['strand'] == 1 else b - (t - t0)
    return None


def c_to_g(tx, pos, offset=0, region='cds'):
    """c. position -> genomic (None when outside the transcript). region: cds | 5utr | 3utr."""
    if region == 'cds' or region == 'intron':
        if not (1 <= pos <= tx['len']):
            return None
        for s in tx['segs']:
            if s[2] <= pos <= s[3]:
                return _seg_g(tx, s, pos) + offset * tx['strand']
        return None
    if region == '5utr':
        t1 = _g_to_t(tx, _seg_g(tx, tx['segs'][0], 1))
        g = _t_to_g(tx, t1 + pos) if t1 is not None else None  # pos is negative
    else:
        tl = _g_to_t(tx, _seg_g(tx, tx['segs'][-1], tx['len']))
        g = _t_to_g(tx, tl + pos) if tl is not None else None
    return None if g is None else g + offset * tx['strand']


def _exonic_c(tx, g):
    for s in tx['segs']:
        lo, hi = s[0], s[1]
        if lo <= g <= hi:
            return {'pos': s[2] + (g - lo if tx['strand'] == 1 else hi - g), 'region': 'cds'}
    t = _g_to_t(tx, g)
    if t is None:
        return None
    t1 = _g_to_t(tx, _seg_g(tx, tx['segs'][0], 1))
    tl = _g_to_t(tx, _seg_g(tx, tx['segs'][-1], tx['len']))
    if t1 is not None and t < t1:
        return {'pos': t - t1, 'region': '5utr'}
    if tl is not None and t > tl:
        return {'pos': t - tl, 'region': '3utr'}
    return None  # inside the CDS span but in an alignment gap


def g_to_c(tx, g):
    """genomic -> {pos, offset, region} on this transcript, or None outside it."""
    hit = _exonic_c(tx, g)
    if hit:
        hit['offset'] = 0
        return hit
    ex = tx['exons']
    if g < ex[0][0] or g > ex[-1][1]:
        return None
    for (a1, b1), (a2, b2) in zip(ex, ex[1:]):
        if b1 < g < a2:
            d_left, d_right = g - b1, a2 - g
            edge, dist = (b1, d_left) if d_left <= d_right else (a2, d_right)
            if d_left == d_right:  # HGVS: the midpoint goes to the 5' exon (upstream in transcript order)
                edge, dist = (b1, d_left) if tx['strand'] == 1 else (a2, d_right)
            e = _exonic_c(tx, edge)
            if not e:
                return None
            # + means downstream of the exon edge in transcript direction
            sign = 1 if ((g > edge) == (tx['strand'] == 1)) else -1
            return {'pos': e['pos'], 'region': 'intron' if e['region'] == 'cds' else e['region'],
                    'offset': sign * dist, 'edgeRegion': e['region']}
    return None


# ------------------------------------------------------------------------------------------ io

def _gz(path):
    with gzip.open(path, 'rt') as fh:
        return json.load(fh)


def _write(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, separators=(',', ':'), ensure_ascii=False)
    path.write_text(text, encoding='utf-8')
    return len(text.encode('utf-8')), len(gzip.compress(text.encode('utf-8'), 9))


def _r(x, nd=3):
    return None if x is None else round(float(x), nd)


def studio_root():
    return Path(os.environ.get('STUDIO_ROOT', DEFAULT_STUDIO))


def sources_root():
    return Path(os.environ.get('SEARCH_SOURCES', BASE / 'search_sources'))


# ---------------------------------------------------------------------------------- residues

def _residue_struct(store, gid):
    """max |dRRCS| and number of threshold-passing contacts per model residue (database data)."""
    import pandas as pd  # noqa: F401  (store frames)
    mx, nsig = {}, defaultdict(int)
    d = store.delta_data.get(gid)
    if d is not None and len(d):
        for col in ('res1', 'res2'):
            for res, v in zip(d[col].astype(int), d['delta_rrcs'].abs()):
                if v > mx.get(res, -1):
                    mx[res] = float(v)
    s = store.significant_data.get(gid)
    if s is not None and len(s):
        for a, b in zip(s['res1'].astype(int), s['res2'].astype(int)):
            nsig[a] += 1
            if b != a:
                nsig[b] += 1
    return mx, nsig


_GN = re.compile(r'^(\d+)\.(\d+)x(\d+)$')


def gn_runs(gn):
    """Run-length generic numbers: [[start, length, display]]; inside a run both the BW and the GPCRdb
    number grow by one per residue (decode: f'{seg}.{bw + k}x{x + k}')."""
    runs = []
    for i, g in enumerate(gn, start=1):
        if not g:
            continue
        if runs:
            st, n, d = runs[-1]
            m = _GN.match(d)
            if m and st + n == i and g == '%s.%dx%d' % (m.group(1), int(m.group(2)) + n, int(m.group(3)) + n):
                runs[-1][1] += 1
                continue
        runs.append([i, 1, g])
    return runs


def _i(x, scale):
    return None if x is None else int(round(float(x) * scale))


def build_residues(gid, pack, store, cfr_rank):
    """Every model residue. Columns are per residue (index 0 = residue 1); `cons`, `am` and `dmax` are
    x100 integers (null = no value); `cfr` (rank, top CFR_TOP only) and `nsig` are sparse {pos: value}.
    The rank of every CFR position is in meta.cfrRank by generic number."""
    seq = pack['sequence']
    rows = {r[0]: r for r in pack['residues']}
    mx, nsig = _residue_struct(store, gid) if store is not None else ({}, {})
    cons = pack.get('conservation') or {}
    amm = pack.get('amMean') or {}
    seg_runs, gn, cfr, dmax, ns, cv, am = [], [], {}, [], {}, [], []
    for i in range(1, len(seq) + 1):
        r = rows.get(i)
        seg = r[2] if r else ''
        if seg_runs and seg_runs[-1][0] == seg:
            seg_runs[-1][2] = i
        else:
            seg_runs.append([seg, i, i])
        g = r[3] if r else ''
        gn.append(g)
        if g and cfr_rank.get(g, 10 ** 9) <= CFR_TOP:
            cfr[str(i)] = cfr_rank[g]
        dmax.append(_i(mx.get(i), 100))
        if nsig.get(i):
            ns[str(i)] = nsig[i]
        cv.append(_i(cons.get(str(i)), 100))
        am.append(_i(amm.get(str(i)), 100))
    return {'gid': gid, 'aa': seq, 'segments': seg_runs, 'gn': gn_runs(gn), 'cfr': cfr, 'dmax': dmax,
            'nsig': ns, 'cons': cv, 'am': am}


# ------------------------------------------------------------------------------------ transcripts

def _tx_record(src, asm, t, gid, extra=None):
    tx = make_tx(t['strand'], t['cds_segments'], t['exons'], t.get('chrom'))
    rec = {'src': src, 'asm': asm, 'chrom': str(t.get('chrom')), 'strand': tx['strand'],
           'ex': tx['exons'], 'cds': tx['segs']}
    if src == 'ensembl':
        rec['id'] = t['id']
        rec['v'] = int(t['version'])
        if t.get('ensp'):
            rec['p'] = t['ensp']
            rec['pv'] = int(t['ensp_version']) if t.get('ensp_version') is not None else None
        if t.get('mane_select'):
            rec['mane'] = 1
        if t.get('is_canonical'):
            rec['canon'] = 1
        if t.get('par_copy'):
            rec['par'] = t['par_copy']
    else:
        acc, _, v = t['accession'].partition('.')
        rec['id'] = acc
        rec['v'] = int(v) if v else None
        if t.get('np'):
            rec['p'], _, pv = t['np'].partition('.')
            rec['pv'] = int(pv) if pv else None
        if 'MANE_Select' in (t.get('tags') or []):
            rec['mane'] = 1
    if extra:
        rec.update(extra)
    return rec


def _map_of(a):
    """Compact transcript->model residue map from a shared-genomic-codon map (build_transcript_map.py):
    ['='] a bijection (every transcript residue is the same model residue), ['b', [[tx_start, model_start, n], ...]]
    an exact block list (residues outside the blocks have no counterpart in the model; ['b', []] = none)."""
    if a is None:
        return None
    if a['kind'] == 'identical':
        return ['=']
    if a['kind'] == 'offset':   # not written by the codon builder; kept for older caches
        return ['b', [[1, 1 + a['offset'], a['len_tx']]]] if a['offset'] >= 0 else ['b', [[1 - a['offset'], 1, a['len_tx'] + a['offset']]]]
    return ['b', [list(b) for b in a.get('blocks') or []]]


def map_pos(m, p):
    """Protein position -> model position through a compact map (None when unaligned)."""
    if m is None or p is None:
        return None
    if m[0] == '=':
        return p
    if m[0] == '+':
        return p + m[1]
    for ts, ms, n in m[1]:
        if ts <= p < ts + n:
            return ms + (p - ts)
    return None


def build_transcripts(gid, src, ens_cds, pmap, nmv, ncbi, seg_maps, direct_maps, pack, uniprot_offset):
    """Every transcript of the gene with protein->model maps, NM_ versions and GRCh37 lift blocks."""
    recs = []
    pm = pmap.get(gid, {})
    gnomad_tx = (pack['provenance'].get('gnomad') or {})
    gtx, gver_label = gnomad_tx.get('transcript'), gnomad_tx.get('transcriptVersion')
    gver = re.match(r'\d+', gver_label).group(0) if gver_label else None
    gn = (ens_cds.get(gid) or {}).get('gnomad_numbering')
    for asm, key in (('GRCh38', 'grch38'), ('GRCh37', 'grch37')):
        for t in src['ensembl_' + key].get(gid, []):
            if not t.get('cds_segments'):
                continue
            r = _tx_record('ensembl', asm, t, gid)
            r['map'] = _map_of(pm.get(f"{key}:{t['id']}.{t['version']}"))
            recs.append(r)
        for t in src['refseq_' + key].get(gid, []):
            if not t.get('cds_segments'):
                continue
            r = _tx_record('refseq', asm, t, gid)
            if asm == 'GRCh37' and not r.get('p'):
                n = ncbi.get(t['accession'])
                if n and n.get('np'):
                    r['p'], _, pv = n['np'].partition('.')
                    r['pv'] = int(pv) if pv else None
            a = pm.get(f"{key}:{t['accession']}") or pm.get(f"ncbi:{t['accession']}")
            r['map'] = _map_of(a)
            recs.append(r)
    # the gnomAD transcript: gnomAD's c. frame (lpar2 +9 nt, oxer1 +117 nt) and its version label
    pack_tx = None
    for r in recs:
        if r['asm'] == 'GRCh38' and r['src'] == 'ensembl' and r['id'] == gtx:
            pack_tx = r
    gnomad_frame = None
    if pack_tx is not None:
        if gn:
            n = int(gn['c_offset'])
            first = pack_tx['cds'][0]
            # extend upstream by n contiguous genomic bases (validated against every gnomAD allele)
            if pack_tx['strand'] == 1:
                ext = [first[0] - n, first[0] - 1, 1, n]
            else:
                ext = [first[1] + 1, first[1] + n, 1, n]
            segs = [ext] + [[s[0], s[1], s[2] + n, s[3] + n] for s in pack_tx['cds']]
            ex = [list(e) for e in pack_tx['ex']]
            tx = make_tx(pack_tx['strand'], segs, ex + [[ext[0], ext[1]]])
            frame = dict(pack_tx)
            frame.update({'cds': tx['segs'], 'ex': tx['exons'], 'v': int(gver), 'frame': 'gnomad',
                          'map': _map_of(pm.get('gnomad_frame'))})
            for k in ('mane', 'canon', 'p', 'pv', 'id_note'):
                frame.pop(k, None)  # today's ENSP is in the current frame, not gnomAD's
            if int(gver) == pack_tx['v']:
                # lpar2: the same ENST.version label carries gnomAD's frame (README decision 6)
                pack_tx['id_note'] = 'current Ensembl frame of %s.%s (gnomAD uses a frame %d nt longer)' % (gtx, gver, n)
                pack_tx['id'] = pack_tx['id'] + '@ensembl'
            recs.append(frame)
            gnomad_frame = {'id': gtx, 'v': int(gver), 'cOffset': n}
        elif gver and str(pack_tx['v']) != str(gver):
            pack_tx.setdefault('alsoV', []).append(int(gver))
    # UniProt canonical numbering as a pseudo protein
    up = pack['meta']['uniprotId']
    # model = UniProt + uniprot_offset over the model's length (lpar2: UniProt 4..351 = model 1..348)
    L = len(pack['sequence'])
    up_map = ['='] if not uniprot_offset else (
        ['b', [[1 - uniprot_offset, 1, L]]] if uniprot_offset < 0 else ['b', [[1, 1 + uniprot_offset, L - uniprot_offset]]])
    recs.append({'src': 'uniprot', 'asm': None, 'id': up, 'p': up, 'map': up_map})
    # harvested NM_ versions that are not current on a host
    have = {(r['id'], r.get('v')) for r in recs}
    nm = {}
    for acc, e in (nmv.get(gid) or {}).items():
        a, _, v = acc.partition('.')
        if (a, int(v)) in have:
            continue
        rt = e.get('resolve_to')
        m = _map_of(pm.get(f'ncbi:{acc}'))
        nm[acc] = {'rel': e['relation'], 'to': rt.split(':', 1)[1] if rt else None,
                   'toAsm': ('GRCh38' if rt.startswith('grch38') else 'GRCh37') if rt else None,
                   'np': e.get('np'), 'map': m}
    lift = build_lift(gid, src, seg_maps, direct_maps)
    mane = None
    e = ens_cds.get(gid) or {}
    rs = e.get('refseq') or {}
    for r in recs:
        if r.get('mane') and r['asm'] == 'GRCh38' and r['src'] == 'refseq':
            mane = f"{r['id']}.{r['v']}"
    out = {'gid': gid, 'tx': recs, 'nm': nm, 'lift': lift, 'mane': mane or rs.get('nm'),
           'maneEnst': rs.get('nm_enst'), 'nmUsable': rs.get('nm_usable', True),
           'gnomadTx': f'{gtx}.{gver}' if gtx else None, 'gnomadTxLabel': gver_label, 'gnomadFrame': gnomad_frame}
    return out


def build_lift(gid, src, seg_maps, direct_maps):
    """GRCh38 -> GRCh37 blocks [o_start, o_end, m_start, m_end, strand, m_chrom], o = GRCh38."""
    blocks = []
    sm = seg_maps.get(gid)
    if sm:
        for seg in sm['segments']:
            for b in seg['blocks']:
                blocks.append([b['o_start'], b['o_end'], b['m_start'], b['m_end'], b['m_strand'], str(b['m_chrom'])])
    exact = list(blocks)

    def conflicts(nb):
        for b in exact:
            lo, hi = max(b[0], nb[0]), min(b[1], nb[1])
            if lo <= hi:
                for g in (lo, hi):
                    if _lift1(b, g) != _lift1(nb, g):
                        return True
        return False

    # exon pairs of transcripts present on both assemblies with the same exon lengths
    for kind, idk in (('ensembl', 'id'), ('refseq', 'accession')):
        a38 = {t[idk].split('.')[0]: t for t in src[f'{kind}_grch38'].get(gid, [])}
        for t37 in src[f'{kind}_grch37'].get(gid, []):
            t38 = a38.get(t37[idk].split('.')[0])
            if not t38 or str(t38['chrom']) != str(t37['chrom']).replace('chr', '') and not t38.get('par_copy'):
                continue
            e38 = sorted(map(tuple, t38['exons']), reverse=t38['strand'] == -1)
            e37 = sorted(map(tuple, t37['exons']), reverse=t37['strand'] == -1)
            if len(e38) != len(e37) or any(b - a != d - c for (a, b), (c, d) in zip(e38, e37)):
                continue
            strand = 1 if t38['strand'] == t37['strand'] else -1
            for (a, b), (c, d) in zip(e38, e37):
                nb = [a, b, c, d, strand, str(t37['chrom']).replace('chr', '')]
                if not conflicts(nb):
                    blocks.append(nb)
    for k, hit in direct_maps.items():
        if not hit:
            continue
        chrom, pos37, strand = hit
        c38, p38 = k.split(':')
        if _DIRECT_OWNER.get((c38, int(p38))) == gid:
            blocks.append([int(p38), int(p38), int(pos37), int(pos37), int(strand), str(chrom)])
    return [list(b) for b in sorted({tuple(b) for b in blocks})]


_DIRECT_OWNER = {}


def _lift1(b, g):
    if not (b[0] <= g <= b[1]):
        return None
    return b[2] + (g - b[0]) if b[4] == 1 else b[3] - (g - b[0])


def lift38(lift, g):
    """GRCh38 -> (GRCh37 chrom, pos) through exact blocks; None when unmapped."""
    for b in lift:
        if b[0] <= g <= b[1]:
            return b[5], _lift1(b, g)
    return None


# -------------------------------------------------------------------------------- cds bases

def build_bases(gid, src, ens_cds):
    """GRCh38 plus-strand reference bases of every Ensembl coding exon: {chrom, iv: [[start, bases]]}."""
    pos = {}
    chrom = None

    def put(g, b):
        pos.setdefault(g, b)  # first writer wins: MANE / canonical transcripts are read first

    txs = [t for t in src['ensembl_grch38'].get(gid, []) if t.get('cds_seq') and t.get('par_copy') != 'Y']
    txs.sort(key=lambda t: (not t.get('mane_select'), not t.get('is_canonical')))
    for t in txs:
        seq = t['cds_seq'].upper()
        tx = make_tx(t['strand'], t['cds_segments'], t['exons'])
        # partial CDS (start or end not found) can carry phase padding: use exact-length, unpadded ones only
        if len(seq) != tx['len'] or 'N' in seq:
            continue
        chrom = str(t['chrom'])
        for s_ in tx['segs']:
            for c in range(s_[2], s_[3] + 1):
                b = seq[c - 1]
                put(_seg_g(tx, s_, c), b if tx['strand'] == 1 else b.translate(COMP))
    gn = (ens_cds.get(gid) or {}).get('gnomad_numbering')
    pt = (ens_cds.get(gid) or {}).get('grch38')
    if gn and pt:
        n = int(gn['c_offset'])
        up = gn['cds_seq'][:n].upper()
        first = sorted(pt['cds_segments'], key=lambda s: s[2])[0]
        for i in range(n):
            if pt['strand'] == 1:
                put(first[0] - n + i, up[i])
            else:
                put(first[1] + n - i, up[i].translate(COMP))
    if not pos:
        return None
    iv = []
    for g in sorted(pos):
        if iv and g == iv[-1][0] + len(iv[-1][1]):
            iv[-1][1] += pos[g]
        else:
            iv.append([g, pos[g]])
    return {'gid': gid, 'chrom': chrom, 'iv': iv}


def base_at(bases, g):
    if not bases:
        return None
    for s, b in bases['iv']:
        if s <= g < s + len(b):
            return b[g - s]
    return None


# ----------------------------------------------------------------------------------- variants

_HGVSP = re.compile(r'^p\.([A-Z][a-z]{2})(\d+)([A-Z][a-z]{2})$')


def _am_of(pack, pos, ref, alt):
    for entry in (pack.get('am') or {}).get(str(pos), []):
        if entry[0] == ref and alt in AM_ALPHABET:
            i = AM_ALPHABET.index(alt)
            return entry[1][i], entry[2][i]
    return None, '-'


def build_variants(gid, pack, g37map, clinvar_rows, strand=1):
    vs = pack.get('variants') or []
    prov = pack['provenance'].get('gnomad') or {}
    cols = {k: [] for k in ('pos', 'tx', 'c', 'g', 'g37', 'rs', 'ac', 'an', 'hom', 'src', 'am', 'amc')}
    ref, alt, nt, conflict, hgvsc_x, hgvsp_x = [], [], [], [], {}, {}
    chrom = None
    last_g = last_pos = last_an = 0
    for i, v in enumerate(vs):
        pos, r, a, hgvsp, hgvsc, af, ac, an, hom, source, rsids, vid, txpos, conf = v
        ch, gp, gr, ga = vid.split('-')
        chrom = ch
        gp = int(gp)
        cols['pos'].append(pos - last_pos)  # delta-encoded (alleles are sorted by position)
        last_pos = pos
        ref.append(r)
        alt.append(a)
        cols['tx'].append(txpos)
        m = re.match(r'^c\.(\d+)([ACGT])>([ACGT])$', hgvsc or '')
        # c. position as its offset from the codon's first base (0, 1 or 2 past 3 * txPos - 2)
        cols['c'].append(int(m.group(1)) - (3 * (txpos if txpos is not None else pos) - 2) if m else None)
        want_c = None
        if m and len(gr) == 1 and len(ga) == 1:
            want_c = 'c.%s%s>%s' % (m.group(1), gr if strand == 1 else gr.translate(COMP),
                                     ga if strand == 1 else ga.translate(COMP))
        if hgvsc != want_c:
            hgvsc_x[str(i)] = hgvsc
        want = 'p.%s%d%s' % (ONE3.get(r, r), txpos if txpos is not None else pos, ONE3.get(a, a))
        if hgvsp != want:
            hgvsp_x[str(i)] = hgvsp
        cols['g'].append(gp - last_g)  # delta-encoded GRCh38 position
        last_g = gp
        nt.append(gr + '>' + ga)
        g37 = g37map.get(vid)
        # GRCh37: offset from the GRCh38 position, or the full id when the chromosome or the bases differ
        # (npy4r, v1br sit in a region inverted between the assemblies: complemented bases)
        if g37 is None:
            cols['g37'].append(None)
        elif g37[0] == ch and (g37[2], g37[3]) == (gr, ga):
            cols['g37'].append(g37[1] - gp)
        else:
            cols['g37'].append('%s-%d-%s-%s' % g37)
        cols['rs'].append([int(x[2:]) for x in rsids if x.startswith('rs')] or 0)
        cols['ac'].append(ac)
        cols['an'].append(an - last_an)  # delta-encoded
        last_an = an
        cols['hom'].append(hom)
        cols['src'].append('e' if source == 'exome' else 'g')
        s, c = _am_of(pack, pos, r, a)
        cols['am'].append(None if s is None else round(s * 1000))
        cols['amc'].append(c)
        conflict.append(1 if conf else 0)
    out = {
        'gid': gid, 'chrom': chrom, 'strand': strand,
        'gnomad': {'tx': prov.get('transcript'), 'v': prov.get('transcriptVersion'),
                   'release': prov.get('release'), 'dataset': prov.get('dataset'),
                   'mapping': prov.get('mapping'), 'conflictPositions': prov.get('conflictPositions', [])} if prov else None,
        'n': len(vs),
        'ref': ''.join(ref), 'alt': ''.join(alt), 'nt': nt, 'conflict': ''.join(map(str, conflict)),
        'amc': ''.join(cols.pop('amc')),
        **cols,
        'hgvscX': hgvsc_x, 'hgvspX': hgvsp_x,
        'dropped': prov.get('droppedVariants', []) if prov else [],
        'clinvar': compact_clinvar(clinvar_rows),
    }
    return out


# ------------------------------------------------------------------------------------ ClinVar

_TITLE = re.compile(r'^((?:NM|NR|XM)_\d+\.\d+)\(([^)]+)\):(\S+)(?:\s+\((p\.[^)]*)\))?')
_P = re.compile(r'^p\.\(?([A-Z][a-z]{2})(\d+)(.*?)\)?$')


def _pclass(rest, ref):
    """(alt token, kind) for the part after p.Xxx123."""
    if rest == '=':
        return '=', 'synonymous'
    m = re.match(r'^([A-Z][a-z]{2})$', rest)
    if m:
        a = AA3.get(m.group(1))
        if a == '*':
            return '*', 'stop'
        if a == ref:
            return '=', 'synonymous'
        if a:
            return a, 'missense'
    if 'fs' in rest:
        return 'fs', 'frameshift'
    if rest.startswith('_') or rest.startswith('del') or rest.startswith('dup') or rest.startswith('ins'):
        for op in ('delins', 'del', 'dup', 'ins'):
            if re.search(r'(^|\d)' + op, rest):
                return op, 'indel'
    if 'ext' in rest:
        return 'ext', 'ext'
    if rest == '?':
        return '?', 'start'
    return '?', 'other'


def _cv_class_code(desc):
    d = (desc or '').lower()
    if d in ('pathogenic',):
        return 'P'
    if d == 'likely pathogenic':
        return 'LP'
    if d == 'pathogenic/likely pathogenic':
        return 'P/LP'
    return None


# RefSeq accession versions of the GRCh38 primary chromosomes (ClinVar SPDI is on GRCh38)
GRCH38_NC = {'1': 11, '2': 12, '3': 12, '4': 12, '5': 10, '6': 12, '7': 14, '8': 11, '9': 12, '10': 11, '11': 10,
             '12': 12, '13': 11, '14': 9, '15': 10, '16': 10, '17': 11, '18': 10, '19': 10, '20': 11, '21': 9,
             '22': 11, 'X': 11, 'Y': 10}


def model_g38(mcod_gene):
    """{GRCh38 position: (model residue, base index 0-2 in its codon, strand)} over the model's own codons
    (build_transcript_map.py), and the chromosome."""
    m = (mcod_gene or {}).get('GRCh38') or {}
    out = {}
    for lo, hi, cs, ce, st in m.get('segs') or []:
        for c in range(cs, ce + 1):
            out[lo + (c - cs) if st == 1 else hi - (c - cs)] = ((c + 2) // 3, (c - 1) % 3, st)
    return out, m.get('chrom')


def model_codon_change(g2m, bases, g, alt):
    """(ref aa, alt aa) of a GRCh38 SNV inside a model codon, from the reference bases; None if a base is missing."""
    m, k, st = g2m[g]
    pos = {v[1]: q for q, v in g2m.items() if v[0] == m}
    if len(pos) != 3:
        return None
    bs = [base_at(bases, pos[j]) for j in range(3)]
    if None in bs:
        return None
    codon = ''.join(b if st == 1 else b.translate(COMP) for b in bs)
    a = alt if st == 1 else alt.translate(COMP)
    return CODON.get(codon), CODON.get(codon[:k] + a + codon[k + 1:])


def spdi_g38(spdi):
    """(chrom, first affected GRCh38 position, deleted, inserted) of a GRCh38 SPDI, else None."""
    m = re.match(r'^NC_0*(\d+)\.(\d+):(\d+):([ACGTN]*):([ACGTN]*)$', spdi or '')
    if not m:
        return None
    ch = {'23': 'X', '24': 'Y'}.get(m.group(1), m.group(1))
    if GRCH38_NC.get(ch) != int(m.group(2)):
        return None
    g = int(m.group(3)) + 1
    if ch == 'Y' and 10001 <= g <= 2781479:   # PAR1: GRCh38 gives Y the X coordinates
        ch = 'X'
    return ch, g, m.group(4), m.group(5)


def build_clinvar(gid, raw, pack, pmap, nmv, tx_maps, mcod_gene=None, stats=None, bases=None):
    """Every single-gene ClinVar record of the gene, mapped to a model residue where it has one.

    The residue is the model residue whose genomic codon (GRCh38) holds the record's variant (its SPDI); a record
    whose variant lies outside every model codon has no residue. Records without a GRCh38 SPDI are placed through
    their title's p. on the title transcript (shared-codon maps). Packed P/LP records keep the pack's residue.

    Row: [variationId, accession, title, classification, stars, conditions, nm, gnomadId (GRCh38 SNV),
          pos, ref (model residue), alt (one letter or class token), kind, packed (1 = the database's P/LP
          missense set), spdi]
    """
    seq = pack['sequence']
    packed = {r[5]: r for r in (pack.get('clinvar') or [])}
    pm = pmap.get(gid, {})
    g2m, mchrom = model_g38(mcod_gene)
    placed = {v[0] for v in g2m.values()}   # model residues with a GRCh38 codon
    stats = stats if stats is not None else defaultdict(int)
    rows = []
    symbols = {s_.upper() for s_ in (raw.get('acceptedSymbols') or [raw.get('symbol') or ''])}
    for rec in raw.get('records', []):
        tm0 = _TITLE.match(rec.get('title') or '')
        names_gene = bool(tm0 and tm0.group(2).upper() in symbols)
        # single-gene records, plus small variants whose title names this gene although another locus
        # overlaps (an antisense gene, a gene in whose intron the receptor sits: CHRM1-AS1, RB1)
        if rec.get('geneCount', 1) != 1 and not names_gene and int(rec['uid']) not in packed:
            continue
        vid = int(rec['uid'])
        g = rec.get('germline') or {}
        desc = g.get('description') or ''
        rs = g.get('reviewStatus') or ''
        stars = STAR.get(rs, 0)
        traits = [t for t in (g.get('traits') or []) if t]
        spdi = ''
        for v in rec.get('variations') or []:
            if len(v) > 2 and v[2]:
                spdi = v[2]
                break
        gnomad_id = None
        m = re.match(r'^NC_0*(\d+)\.\d+:(\d+):([ACGT]):([ACGT])$', spdi)
        if m:
            ch = {'23': 'X', '24': 'Y'}.get(m.group(1), m.group(1))
            gnomad_id = '%s-%d-%s-%s' % (ch, int(m.group(2)) + 1, m.group(3), m.group(4))
        title = rec.get('title') or ''
        nm, pos, ref, alt, kind = None, None, None, None, 'other'
        tm = _TITLE.match(title)
        if tm:
            nm = tm.group(1)
            p = tm.group(4)
            pmm = _P.match(p) if p else None
            if pmm:
                r1 = AA3.get(pmm.group(1))
                txp = int(pmm.group(2))
                alt, kind = _pclass(pmm.group(3), r1)
                a = pm.get(f'ncbi:{nm}') or pm.get(f'grch38:{nm}') or pm.get(f'grch37:{nm}')
                mp = map_pos(_map_of(a), txp) if a else None
                if mp is None and nm in (nmv.get(gid) or {}):
                    rt = nmv[gid][nm].get('resolve_to')
                    if rt and pm.get(rt):
                        mp = map_pos(_map_of(pm[rt]), txp)
                if mp is not None and 1 <= mp <= len(seq):
                    pos = mp
            elif not p:
                kind = 'noncoding' if re.search(r'c\.[-*]|c\.\d+[+-]\d', tm.group(3)) else 'other'
        # a substitution: the model codon that holds the variant decides the residue; an indel keeps its title's
        # (3'-shifted, HGVS) residue and falls back to the codon of its first affected base
        sp = spdi_g38(spdi)
        if sp and mchrom and sp[0] == mchrom and (sp[2] or sp[3]):
            snv = len(sp[2]) == len(sp[3]) == 1
            mg = g2m.get(sp[1] if sp[2] else sp[1] - 1)   # an insertion: the base before it
            if snv and not (mg is None and pos is not None and pos not in placed):
                # (a title residue that has no GRCh38 codon in the model, mchr1/npff2 N-terminus, is kept)
                if pos is not None and (mg or (None,))[0] != pos:
                    stats['clinvar_snv_title_vs_genomic_codon_disagree'] += 1
                    stats.setdefault('examples', []).append('%s VCV%s %s' % (gid, vid, title[:60]))
                title_pos = pos
                pos = mg[0] if mg else None
                if mg:
                    stats['clinvar_snv_placed_by_genomic_codon'] += 1
                    if (title_pos != pos or kind not in ('missense', 'synonymous', 'stop')) and bases:
                        # the title's residue is not this codon (UTR, another isoform or frame): read the model codon
                        ch_ = model_codon_change(g2m, bases, sp[1], sp[3])
                        if ch_ and ch_[0] and ch_[1]:
                            alt, kind = ('=', 'synonymous') if ch_[0] == ch_[1] else (
                                ('*', 'stop') if ch_[1] == '*' else (ch_[1], 'missense'))
                            stats['clinvar_snv_change_read_from_model_codon'] += 1
            elif pos is None and mg:
                pos = mg[0]
                stats['clinvar_indel_placed_by_first_base'] += 1
        pk = packed.get(vid)
        if pk:
            if pos is not None and pos != pk[0]:
                stats['clinvar_packed_vs_genomic_codon_disagree'] += 1
                stats.setdefault('examples', []).append('packed %s VCV%s %s pack %s codon %s' % (gid, vid, title[:50], pk[0], pos))
            pos, alt, kind = pk[0], pk[2], 'missense'
            if not gnomad_id and pk[17]:
                gnomad_id = pk[17]
        ref = seq[pos - 1] if pos else None
        row = [vid, rec.get('accession'), title, desc, stars, traits, nm, gnomad_id, pos, ref, alt, kind,
               1 if pk else 0, spdi]
        if pk:
            row[9] = pk[1]  # the record's own (RefSeq) reference residue
        rows.append(row)
    rows.sort(key=lambda r: (r[8] or 0, r[0]))
    return rows


CLINVAR_FIELDS = ['variationId', 'version', 'title', 'class', 'stars', 'conditions', 'gnomadId', 'pos', 'ref',
                  'alt', 'kind', 'packed', 'spdi']


def compact_clinvar(rows):
    """Rows -> {fields, classes, conditions, rows}; class and conditions are indexes into the shard's
    tables, the accession is VCV + zero-padded id + '.' + version, the NM_ is read from the title, and
    SPDI is kept only when there is no gnomAD-style id."""
    classes, conds, out = [], [], []
    ci, di = {}, {}
    for vid, acc, title, desc, stars, traits, nm, gid_, pos, ref, alt, kind, packed, spdi in rows:
        if desc not in ci:
            ci[desc] = len(classes)
            classes.append(desc)
        tl = []
        for t in traits:
            if t not in di:
                di[t] = len(conds)
                conds.append(t)
            tl.append(di[t])
        ver = int(acc.rsplit('.', 1)[1]) if acc and '.' in acc else None
        out.append([vid, ver, title, ci[desc], stars, tl, gid_, pos, ref, alt, kind, packed, '' if gid_ else spdi])
    return {'fields': CLINVAR_FIELDS, 'classes': classes, 'conditions': conds, 'rows': out}


# -------------------------------------------------------------------------------------- loaders

def load_sources(sdir):
    t = sdir / 'transcripts_all'
    src = {k: _gz(t / f'{k}.json.gz') for k in ('ensembl_grch38', 'ensembl_grch37', 'refseq_grch38', 'refseq_grch37')}
    return {
        'tx': src,
        'ncbi': _gz(t / 'ncbi_cds.json.gz'),
        'pmap': _gz(t / 'protein_model_map.json.gz'),
        'mcod': _gz(t / 'model_codons.json.gz'),
        'nmv': _gz(t / 'nm_versions.json.gz'),
        'ens_cds': _gz(sdir / 'ensembl_cds' / 'transcripts.json.gz'),
        'seg_maps': _gz(sdir / 'grch37' / 'segment_maps.json.gz'),
        'direct_maps': json.loads((sdir / 'grch37' / 'direct_maps.json').read_text()),
        'hgnc': _gz(sdir / 'hgnc' / 'hgnc_records.json.gz'),
        'aliases': list(csv.DictReader(open(sdir / 'aliases_curated.tsv', encoding='utf-8'), delimiter='\t')),
        'uniprot': {r['accession']: r for r in csv.DictReader(
            gzip.open(sdir / 'uniprot' / 'uniprot_names.tsv.gz', 'rt', encoding='utf-8'), delimiter='\t')},
    }


def load_grch37_alleles(sdir):
    out = defaultdict(dict)
    with gzip.open(sdir / 'grch37' / 'alleles.tsv.gz', 'rt') as fh:
        for r in csv.DictReader(fh, delimiter='\t'):
            if r['variant_id_grch37']:
                ch, p, r37, a37 = r['variant_id_grch37'].split('-')
                out[r['gid']][r['variant_id_grch38']] = (ch, int(p), r37, a37)
    return out


EXTRA_ALIASES = {
    '5-HT2': ('5ht2a_human', '5ht2b_human', '5ht2c_human'),   # the 5-HT2 family (IUPHAR)
    '5-HT1': ('5ht1a_human', '5ht1b_human', '5ht1d_human', '5ht1e_human', '5ht1f_human'),
    'CCR2B': ('ccr2_human',),   # CCR2 isoform B, the main isoform (and the gnomAD transcript); widely used name
    'CCR2A': ('ccr2_human',),   # CCR2 isoform A (the MANE transcript)
}

ALIAS_TIER = {'symbol': 0, 'index_symbol': 0, 'accession': 0, 'entry_name': 0, 'gid': 0,
              'curated': 1, 'alias_symbol': 1, 'entry_prefix': 1, 'hgnc_name': 1, 'protein_name': 2,
              'gene_synonym': 2, 'alias_name': 2, 'prev_symbol': 3, 'prev_name': 3}


def build_meta(gids, packs, s, store, lift_blocks=None):
    lift_blocks = lift_blocks or {}
    hgnc = s['hgnc']
    ens = s['ens_cds']
    receptors = []
    for g in gids:
        p = packs[g]
        h = hgnc.get(g) or {}
        u = s['uniprot'].get(p['meta']['uniprotId']) or {}
        pname = re.sub(r'\s*\(.*$', '', u.get('protein_names', '')) if u else ''
        receptors.append([g, h.get('symbol') or p['meta']['gene'], p['meta']['uniprotId'],
                          u.get('entry_name') or p['meta']['uniprotName'] + '_HUMAN', pname,
                          h.get('hgnc_id'), h.get('entrez_id'), h.get('ensembl_gene_id') or (ens.get(g) or {}).get('ensg'),
                          p['meta']['gene'], p['meta']['family'], len(p['sequence']),
                          1 if (p.get('variants') or []) else 0])
    idx = {g: i for i, g in enumerate(gids)}
    aliases = {}

    def add(display, gid, kind, flag=''):
        k = alias_key(display)
        if not k:
            return
        tier = ALIAS_TIER.get(kind, 2)
        lst = aliases.setdefault(k, [])
        for e in lst:
            if e[1] == idx[gid]:
                if tier < e[2]:
                    e[2] = tier
                    e[0] = display
                return
        lst.append([display, idx[gid], tier] + ([flag] if flag else []))

    for r in s['aliases']:
        if r['gid'] in idx:
            add(r['alias'], r['gid'], r['kind'], r['collision'])
    # names in common use that the sources lack or give to one member only (curated tier outranks UniProt's
    # historical "5-HT-2" for HTR2A, so "5-HT2" names the three 5-HT2 subtypes)
    for display, members in EXTRA_ALIASES.items():
        for g in members:
            if g in idx:
                add(display, g, 'curated')
    for g, rec in zip(gids, receptors):
        add(g, g, 'gid')
        add(g.replace('_human', ''), g, 'curated')
        if rec[5]:
            add(rec[5], g, 'accession')       # HGNC:3538 -> hgnc3538
        if rec[6]:
            add('GeneID:%s' % rec[6], g, 'accession')
        if rec[7]:
            add(rec[7], g, 'accession')
        add(rec[8], g, 'index_symbol')
    alias_rows = sorted([[k] + e for k, lst in aliases.items() for e in lst], key=lambda r: (r[0], r[3], r[2]))
    excluded = []
    if store is not None and getattr(store, 'metadata', None) is not None:
        for _, row in store.metadata.iterrows():
            un = str(row.get('uniprot_name', '')).lower() + '_human'
            if un not in idx:
                excluded.append([str(row.get('gene_name', '')), str(row.get('uniprot_name', '')),
                                 'no complete active+inactive model pair'])
    windows = {'GRCh38': [], 'GRCh37': []}
    primary = {str(c) for c in range(1, 23)} | {'X', 'Y'}
    for g in gids:
        e = ens.get(g) or {}
        for asm, key in (('GRCh38', 'gene_grch38'), ('GRCh37', 'gene_grch37')):
            w = e.get(key)
            if w and str(w['chrom']) in primary:
                lo, hi = w['start'], w['end']
                if asm == 'GRCh37':
                    # cover every lifted coding block (genes whose GRCh37 gene model is shorter or shifted)
                    for b in lift_blocks.get(g, []):
                        if b[5] == str(w['chrom']):
                            lo, hi = min(lo, b[2]), max(hi, b[3])
                windows[asm].append([str(w['chrom']), lo, hi, idx[g], w['strand']])
            elif asm == 'GRCh37' and lift_blocks.get(g):
                # no GRCh37 gene on a primary chromosome (OPN1MW sits on a patch): the lifted blocks' span
                bl = lift_blocks[g]
                chrom = max({b[5] for b in bl}, key=lambda c: sum(1 for b in bl if b[5] == c))
                windows[asm].append([chrom, min(b[2] for b in bl if b[5] == chrom), max(b[3] for b in bl if b[5] == chrom),
                                     idx[g], (e.get('gene_grch38') or {}).get('strand', 1)])
        w = e.get('gene_grch38_par_y')
        if w:
            windows['GRCh38'].append([str(w['chrom']), w['start'], w['end'], idx[g], w['strand'], 'PAR-Y'])
    for asm in windows:
        windows[asm].sort()
    return {'receptors': receptors, 'idx': idx, 'aliases': alias_rows, 'excluded': excluded, 'windows': windows}


# ------------------------------------------------------------------------------------- main

def generate_search_index_v2(store, output_dir, studio=None, sources=None, gids=None, quiet=False):
    """Write <output_dir>/search2/. Returns {'sizes': {shard type: [raw, gzip]}, 'files': {...}}."""
    studio = Path(studio) if studio else studio_root()
    sdir = Path(sources) if sources else sources_root()
    pack_dir = studio / 'public' / 'pack'
    if not (pack_dir / 'index.json').exists():
        print('  search2/ skipped: no Studio packs at %s (set STUDIO_ROOT)' % pack_dir)
        return None
    out = Path(output_dir) / 'search2'
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    index = json.loads((pack_dir / 'index.json').read_text())
    pack_gids = [r['gid'] for r in index['receptors']]
    if gids is None:
        gids = sorted(store.gpcr_ids) if store is not None else pack_gids
    missing = sorted(set(gids) - set(pack_gids))
    if missing:
        raise ValueError('no Studio pack for %s' % ', '.join(missing))
    packs = {g: json.loads((pack_dir / f'{g}.json').read_text()) for g in gids}
    s = load_sources(sdir)
    g37 = load_grch37_alleles(sdir)
    cv_dir = studio / 'pack' / 'sources' / 'clinvar'

    # direct GRCh37 maps belong to the receptor whose gnomAD allele sits there
    _DIRECT_OWNER.clear()
    for g in gids:
        for v in packs[g].get('variants') or []:
            ch, p, *_ = v[11].split('-')
            if f'{ch}:{p}' in s['direct_maps']:
                _DIRECT_OWNER[(ch, int(p))] = g
        for d in (packs[g]['provenance'].get('gnomad') or {}).get('droppedVariants', []):
            ch, p, *_ = d[0].split('-')
            if f'{ch}:{p}' in s['direct_maps']:
                _DIRECT_OWNER[(ch, int(p))] = g

    # CFR rank by generic number, from the database (report snake plots colour the top 30)
    cfr_rank = {}
    if store is not None:
        from ...analysis.cfr_analysis import identify_cfrs
        table = identify_cfrs(store)
        for _, r in table.iterrows():
            cfr_rank[r['generic_number']] = int(r['rank'])

    idx = {g: i for i, g in enumerate(gids)}
    lift_blocks = {}
    sizes = defaultdict(lambda: [0, 0])
    files = defaultdict(int)

    def put(kind, rel, obj):
        raw, gz = _write(out / rel, obj)
        sizes[kind][0] += raw
        sizes[kind][1] += gz
        files[kind] += 1

    rsid, clin, hgvsc, generic, subst = defaultdict(dict), defaultdict(dict), defaultdict(dict), defaultdict(dict), defaultdict(dict)
    cv_stats = defaultdict(int)
    with_tx, with_bases, with_var = [], [], []
    txindex = {}
    for g in gids:
        p = packs[g]
        i = idx[g]
        put('residues', f'residues/{g}.json', build_residues(g, p, store, cfr_rank))
        for pos, aa, seg, gn, _src in p['residues']:
            if gn:
                seg_key = gn.split('.')[0].split('x')[0]
                generic[seg_key].setdefault(gn, []).append([i, pos, aa])
        shifts = ((p['provenance'].get('cachesRekeyed') or {}).get('shifts') or {})
        up_off = int(next(iter(shifts))) if len(shifts) == 1 else 0
        if (s['ens_cds'].get(g) or {}).get('grch38') or s['tx']['ensembl_grch38'].get(g):
            t = build_transcripts(g, s['tx'], s['ens_cds'], s['pmap'], s['nmv'], s['ncbi'], s['seg_maps'],
                                  s['direct_maps'], p, up_off)
            put('transcripts', f'transcripts/{g}.json', t)
            with_tx.append(i)
            lift_blocks[g] = t['lift']
            for r in t['tx']:
                rank = 0 if (r.get('mane') or (r.get('map') or [''])[0] == '=') else 1
                for acc in (r['id'].split('@')[0], r.get('p')):
                    if acc and r['src'] != 'uniprot':
                        txindex.setdefault(acc, {})
                        txindex[acc][i] = min(rank, txindex[acc].get(i, 9))
            for acc, e in t['nm'].items():
                for a in (acc.split('.')[0], (e.get('np') or '').split('.')[0]):
                    if a:
                        txindex.setdefault(a, {})
                        txindex[a].setdefault(i, 1)
        b = build_bases(g, s['tx'], s['ens_cds'])
        if b:
            put('cds', f'cds/{g}.json', b)
            with_bases.append(i)
        raw = {}
        f = cv_dir / f'{g}.json.gz'
        if f.exists():
            raw = _gz(f)
        cv_rows = build_clinvar(g, raw, p, s['pmap'], s['nmv'], None, s['mcod'].get(g), cv_stats, b)
        strand = ((s['ens_cds'].get(g) or {}).get('grch38') or {}).get('strand', 1)
        v = build_variants(g, p, g37.get(g, {}), cv_rows, strand)
        put('variants', f'variants/{g}.json', v)
        with_var.append(i)
        for k, rsl in enumerate(v['rs']):
            for num in (rsl or []):
                lst = rsid['%02d' % (num % RSID_SHARDS)].setdefault(str(num), [])
                if i not in lst:
                    lst.append(i)
        for hg in {x[4] for x in (p.get('variants') or []) if x[4]}:
            m = re.match(r'^c\.(\d+)(.*)$', hg)
            if m:
                lst = hgvsc['%02d' % (int(m.group(1)) % HGVSC_SHARDS)].setdefault(hg[2:], [])
                if i not in lst:
                    lst.append(i)
        for row in cv_rows:
            clin['%02d' % (row[0] % CLINVAR_SHARDS)][str(row[0])] = i
        # observed substitutions (gnomAD alleles, ClinVar missense records) for cross-receptor bare changes
        seen = {(x[0], x[1], x[2]) for x in (p.get('variants') or [])}
        seen |= {(row[8], row[9], row[10]) for row in cv_rows if row[8] and row[11] == 'missense' and row[10] in AM_ALPHABET}
        for pos, r_, a_ in seen:
            lst = subst['%02d' % (pos % SUBST_SHARDS)].setdefault('%d%s%s' % (pos, r_, a_), [])
            if i not in lst:
                lst.append(i)

    meta = build_meta(gids, packs, s, store, lift_blocks)
    for k, b in sorted(rsid.items()):
        nums = sorted(b, key=int)
        q, last = [], 0
        for n in nums:
            qq = int(n) // RSID_SHARDS
            q.append(qq - last)
            last = qq
        # rs number = (running sum of q) * RSID_SHARDS + shard; v = receptor indices (one int when single)
        put('rsid', f'rsid/{k}.json', {'q': q, 'v': [b[n][0] if len(b[n]) == 1 else b[n] for n in nums]})
    for k, b in sorted(clin.items()):
        put('clinvar', f'clinvar/{k}.json', b)
    for k, b in sorted(hgvsc.items()):
        put('hgvsc', f'hgvsc/{k}.json', b)
    for k, b in sorted(subst.items()):
        put('subst', f'subst/{k}.json', b)
    for k, b in sorted(generic.items()):
        put('generic', f'generic/{k}.json', b)
    put('seq', 'seq.json', [packs[g]['sequence'] for g in gids])
    put('txindex', 'txindex.json', {a: [i for i, _ in sorted(d.items(), key=lambda x: (x[1], x[0]))]
                                     for a, d in sorted(txindex.items())})

    meta_out = {
        'version': VERSION,
        'receptorFields': ['gid', 'symbol', 'uniprot', 'entry', 'name', 'hgnc', 'geneId', 'ensg', 'packGene',
                           'family', 'length', 'hasVariants'],
        'receptors': meta['receptors'],
        'aliasFields': ['key', 'display', 'receptor', 'tier', 'collision'],
        'aliasTiers': {'0': 'symbol, accession, entry name or id', '1': 'alias symbol or curated common name',
                       '2': 'protein name or synonym', '3': 'previous symbol or name'},
        'aliases': meta['aliases'],
        'excluded': meta['excluded'],
        'windows': meta['windows'],
        'shards': {'rsid': RSID_SHARDS, 'clinvar': CLINVAR_SHARDS, 'hgvsc': HGVSC_SHARDS, 'subst': SUBST_SHARDS,
                   'generic': sorted(generic, key=lambda x: int(x)), 'transcripts': with_tx, 'cds': with_bases,
                   'variants': with_var},
        'cfrTop': CFR_TOP,
        'cfrRank': cfr_rank,
        'releases': RELEASES,
        'amAlphabet': AM_ALPHABET,
    }
    put('meta', 'meta.json', meta_out)
    total = [sum(v[0] for v in sizes.values()), sum(v[1] for v in sizes.values())]
    if not quiet and cv_stats:
        ex = cv_stats.pop('examples', [])
        print('  ClinVar placement: %s%s' % (dict(sorted(cv_stats.items())), ''.join('\n    ' + e for e in ex[:20])))
    if not quiet:
        print('  Generated: search2/ (%d receptors; %.0f KB raw, %.0f KB gzip: %s)' % (
            len(gids), total[0] / 1024, total[1] / 1024,
            ', '.join('%s %.0f' % (k, v[1] / 1024) for k, v in sorted(sizes.items()))))
    return {'sizes': dict(sizes), 'files': dict(files), 'total': total, 'dir': str(out)}


def main(argv=None):
    import argparse
    import sys
    import time
    ap = argparse.ArgumentParser(description='Build only the search v2 index (no report pages).')
    ap.add_argument('--output', required=True, help='output directory; the index goes to <output>/search2/')
    ap.add_argument('--batch-dir', default=None)
    ap.add_argument('--metadata', default=None)
    ap.add_argument('--studio-root', default=None)
    ap.add_argument('--sources', default=None)
    a = ap.parse_args(argv)
    t = time.time()
    from ...analysis.data_loader import GPCRDataStore
    store = GPCRDataStore(batch_dir=a.batch_dir, metadata_csv=a.metadata)
    store.load_all()
    r = generate_search_index_v2(store, Path(a.output), studio=a.studio_root, sources=a.sources)
    print('  %.1f s' % (time.time() - t), file=sys.stderr)
    return r


if __name__ == '__main__':
    main()
