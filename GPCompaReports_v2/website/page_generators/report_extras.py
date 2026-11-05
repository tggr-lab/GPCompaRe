"""Opt-in report-page extras: the 3D view, the ClinVar section and the data the
residue drawer reads.

Nothing here touches a frozen report section. The template places these in
their own elements outside every <section class="report-section"> (see
tests/test_report_extras.py), and each is off until the visitor asks for it.

Data comes from the Studio's per-receptor packs (public/pack/<gid>.json) at
build time. The packs hold ClinVar P/LP missense records in the models' own
residue numbering, plus the GPCRdb numbering for every residue of the right
receptor. No network access happens here.
"""
import json
import os
import re
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent.parent

# The Studio checkout the packs are read from (override with STUDIO_ROOT).
DEFAULT_STUDIO_ROOT = Path(
    '/home/yamir/Documents/gpcr_synth/gpcompare_studio_web/.claude/worktrees/main-merge')

MODELS_SUBDIR = 'gpcrdb_alphafold_models'
STATES = ('active', 'inactive')

# Where the models and the viewer live, relative to a report page
# (reports/<gid>.html). The stage serves models/ at the site root and the
# Studio build, which carries the embed, under studio/.
MODELS_URL = '../models/{state}/{gid}_{state}.pdb.gz'
EMBED_URL = '../studio/embed/pair-viewer.js'
STUDIO_URL = '../studio/?db={gid}'

_ONE_TO_THREE = {
    'A': 'Ala', 'R': 'Arg', 'N': 'Asn', 'D': 'Asp', 'C': 'Cys', 'Q': 'Gln',
    'E': 'Glu', 'G': 'Gly', 'H': 'His', 'I': 'Ile', 'L': 'Leu', 'K': 'Lys',
    'M': 'Met', 'F': 'Phe', 'P': 'Pro', 'S': 'Ser', 'T': 'Thr', 'W': 'Trp',
    'Y': 'Tyr', 'V': 'Val',
}

_warned = set()


def _warn(key, message):
    if key not in _warned:
        _warned.add(key)
        print('  [report extras] ' + message)


def studio_root():
    env = os.environ.get('STUDIO_ROOT')
    return Path(env).expanduser() if env else DEFAULT_STUDIO_ROOT


def pack_dir():
    """The pack folder: STUDIO_PACK_DIR (a Studio build's pack/, as the release
    script sets it), else public/pack of the Studio checkout."""
    env = os.environ.get('STUDIO_PACK_DIR')
    return Path(env).expanduser() if env else studio_root() / 'public' / 'pack'


def models_dir():
    """Directory holding active/ and inactive/ model PDBs, or None."""
    env = os.environ.get('GPCOMPARE_MODELS_DIR')
    candidates = [Path(env).expanduser()] if env else [
        BASE.parent / MODELS_SUBDIR,
        BASE.parents[2] / 'The Ultimate RRCS database project'
        / 'alphafold_multistate_gpcr' / MODELS_SUBDIR,
    ]
    for c in candidates:
        if (c / 'active').is_dir() and (c / 'inactive').is_dir():
            return c
    return None


def has_model_pair(gid, root):
    return root is not None and all(
        (root / s / ('%s_%s.pdb' % (gid, s))).is_file() for s in STATES)


def _pack_path(gid):
    """<gid>.json in a source checkout, <gid>.<hash>.json in a build (named by index.json)."""
    folder = pack_dir()
    plain = folder / ('%s.json' % gid)
    if plain.is_file():
        return plain
    index = folder / 'index.json'
    if index.is_file():
        files = json.loads(index.read_text(encoding='utf-8')).get('release', {}).get('files', {})
        hashed = files.get('%s.json' % gid)
        if hashed and (folder / hashed).is_file():
            return folder / hashed
    return None


def load_pack(gid):
    path = _pack_path(gid)
    if path is None:
        _warn('pack', 'no Studio pack at %s: the ClinVar section is left out '
                      'and residue numbering comes from the page annotation.'
              % pack_dir())
        return None
    return json.loads(path.read_text(encoding='utf-8'))


def _pack_annotation(pack):
    """{position: (segment, generic number)} for every residue of the pack."""
    return {int(r[0]): (r[2] or '', r[3] or '') for r in pack.get('residues', [])}


def residue_annotation(pack, annot_map):
    """Segment and generic number per residue, as {str(pos): [segment, gn]}.

    The pack is preferred: its numbering is built for the right receptor,
    while the page annotation of three receptors (GPR3, GPR4, XCR1) still
    carries another receptor's layer (known, fixed in the data refresh).
    """
    out = {}
    if pack:
        for pos, (seg, gn) in _pack_annotation(pack).items():
            out[str(pos)] = [seg, gn]
        return out
    for pos, a in (annot_map or {}).items():
        out[str(pos)] = [a.get('protein_segment', ''),
                         a.get('display_number') or a.get('generic_number') or '']
    return out


def segment_ranges(annotation):
    """{'TM1': [first, last], ...} from {str(pos): [segment, gn]}."""
    ranges = {}
    for pos, (seg, _gn) in annotation.items():
        if not seg:
            continue
        p = int(pos)
        lo, hi = ranges.get(seg, (p, p))
        ranges[seg] = [min(lo, p), max(hi, p)]
    return ranges


def clinvar_block(pack, annotation, report_aa):
    """ClinVar P/LP missense records for the receptor, or None without a pack.

    report_aa: {position: one-letter residue} as the report's own model has it,
    used only to flag a record whose reference residue differs there.
    """
    if not pack:
        return None
    prov = (pack.get('provenance') or {}).get('clinvar')
    if not prov:
        return None
    records = []
    for r in pack.get('clinvar') or []:
        (pos, ref, alt, hgvsp, change, vid, vcv, cls, _code, stars, review,
         subs, conditions, _tx, _np, _txpos, conflict, _gid, last) = r[:19]
        seg, gn = annotation.get(str(pos), ['', ''])
        model_aa = report_aa.get(pos)
        records.append({
            'pos': pos, 'ref': ref, 'alt': alt, 'hgvsp': hgvsp, 'change': change,
            'vid': vid, 'vcv': vcv, 'cls': cls, 'stars': stars, 'review': review,
            'subs': subs, 'conditions': conditions, 'gn': gn, 'seg': seg,
            'last': last or '',
            # the reference residue in ClinVar's name is not the residue of
            # the model at that position
            'differs': bool(conflict) or (model_aa is not None and model_aa != ref),
        })
    records.sort(key=lambda x: (x['pos'], x['alt'], x['vid']))
    return {
        'release': prov.get('release', ''),
        'scope': prov.get('scope', ''),
        'records': records,
    }


def stars_text(n):
    n = max(0, min(4, int(n)))
    return '★' * n + '☆' * (4 - n)


def _json_for_script(obj):
    """JSON that is safe inside a <script type="application/json"> element."""
    return (json.dumps(obj, separators=(',', ':'), ensure_ascii=False)
            .replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026'))


def cfr_flags(annotation, cfr_generics, positions):
    """{position: True} for residues whose generic number is among the top
    cross-receptor CFR positions.

    This is the rule the report snake plot and the search use (a CFR is a
    position, named by its generic number, that recurs across receptors; it is
    not a per-receptor contact count). `annotation` is the numbering the
    residue table shows ({str(pos): [segment, gn]}, the receptor's own pack
    where there is one), so a residue is flagged by the number it is shown
    with, not by the annotation layer the snake plot was built from.
    """
    out = {}
    if not cfr_generics:
        return out
    for pos in positions:
        a = (annotation or {}).get(str(int(pos)))
        gn = (a[1] if a else '') or ''
        if gn.strip() and gn.strip() in cfr_generics:
            out[int(pos)] = True
    return out


def residue_table_extras(delta_df, sig_threshold, am_by_pos, cons_by_pos, positions,
                         annotation=None, cfr_generics=None):
    """{'sig': threshold, 'rows': {str(position): [contacts above threshold, AlphaMissense mean, conservation, CFR 0/1]}}.

    Feeds the opt-in residue table. Nothing is computed here that the page does
    not already show: the count uses the receptor's own ΔRRCS threshold and is
    taken by residue number from the receptor's own contacts (independent of any
    annotation layer); the AlphaMissense and Conservation values are the caches
    the snake plot's colour views read (None where a cache has no value); the
    CFR flag is cfr_flags() on the table's own numbering.
    """
    above = {}
    if delta_df is not None and not delta_df.empty:
        hit = delta_df[delta_df['delta_rrcs'].abs() >= sig_threshold]
        for col in ('res1', 'res2'):
            for pos, n in hit[col].astype(int).value_counts().items():
                above[int(pos)] = above.get(int(pos), 0) + int(n)
    flags = cfr_flags(annotation, cfr_generics, positions)
    out = {}
    for pos in positions:
        pos = int(pos)
        am = (am_by_pos or {}).get(pos)
        cons = (cons_by_pos or {}).get(pos)
        out[str(pos)] = [above.get(pos, 0),
                         None if am is None else round(float(am), 3),
                         None if cons is None else round(float(cons), 3),
                         1 if flags.get(pos) else 0]
    return {'sig': round(float(sig_threshold), 2), 'rows': out}


def json_for_script(obj):
    return _json_for_script(obj)


# Segments in receptor order, for the summary block.
SEGMENT_ORDER = ['N-term', 'TM1', 'ICL1', 'TM2', 'ECL1', 'TM3', 'ICL2', 'TM4', 'ECL2',
                 'TM5', 'ICL3', 'TM6', 'ECL3', 'TM7', 'H8', 'C-term']
HELICES = {'TM1', 'TM2', 'TM3', 'TM4', 'TM5', 'TM6', 'TM7', 'H8'}
# The site's default display order ("Helices first", static/js/segment-order.js keeps the
# same list): the helices together, then the loops, then the termini.
HELICES_FIRST_ORDER = ['TM1', 'TM2', 'TM3', 'TM4', 'TM5', 'TM6', 'TM7', 'H8',
                       'ICL1', 'ICL2', 'ICL3', 'ECL1', 'ECL2', 'ECL3', 'N-term', 'C-term']


def _aa3(name):
    n = str(name or '').strip()
    if len(n) == 3 and n.isalpha():
        return n[0].upper() + n[1:].lower()
    return _ONE_TO_THREE.get(n.upper(), n)


def contact_summary(delta_df, sig_threshold, annotation, top_n=8, per_segment=3):
    """What changes most in this receptor, from numbers the page already shows.

    Takes the contact pairs at or above the receptor's own threshold (the rows the
    tables highlight) and groups them by the segment of each residue, using the
    numbering the residue table shows. Returns a dict for the template:

      sig        the threshold
      n_total    contact pairs modelled
      n_above    pairs at or above the threshold
      segments   [{seg, n, up, down, up_pct, down_pct, top: [pair, ...]}] in receptor
                 order, only segments with at least one such pair; up = sum of the
                 positive dRRCS (stronger in the active model), down = sum of |dRRCS|
                 of the negative ones; the pct values scale the bars to the largest
      lead       the three helices (TM1 to TM7, H8) with the largest total |dRRCS|, by name
      pairs      the top_n largest changes with both residues in a helix (the structured core)
      pairs_all  the top_n largest changes overall; each pair carries tail: '' | 'loop' | 'tail'
      n_tail     how many of pairs_all involve a loop ('loop') or a terminus ('tail')

    A pair between two segments counts once for each; a pair within one segment
    counts once. Each pair is {a, aa, b, ab, d, act, inact, ga, gb, sa, sb}:
    positions, three-letter residue names, dRRCS, active and inactive RRCS,
    generic numbers and segments.
    """
    out = {'sig': round(float(sig_threshold), 2), 'n_total': 0, 'n_above': 0,
           'segments': [], 'lead': [], 'pairs': [], 'pairs_all': [], 'n_tail': 0}
    if delta_df is None or delta_df.empty:
        return out
    ann = annotation or {}

    def seg_of(pos):
        a = ann.get(str(int(pos)))
        return (a[0] if a else '') or ''

    def gn_of(pos):
        a = ann.get(str(int(pos)))
        return (a[1] if a else '') or ''

    hit = delta_df[delta_df['delta_rrcs'].abs() >= float(sig_threshold)]
    hit = hit.reindex(hit['delta_rrcs'].abs().sort_values(ascending=False).index)
    out['n_total'] = int(len(delta_df))
    out['n_above'] = int(len(hit))

    def pair_of(r):
        a, b = int(r['res1']), int(r['res2'])
        sa, sb = seg_of(a), seg_of(b)
        return {'a': a, 'aa': _aa3(r['res1_name']), 'b': b, 'ab': _aa3(r['res2_name']),
                'd': round(float(r['delta_rrcs']), 2),
                'act': round(float(r['active_rrcs']), 2), 'inact': round(float(r['inactive_rrcs']), 2),
                'ga': gn_of(a), 'gb': gn_of(b), 'sa': sa, 'sb': sb, 'tail': _tail_kind(sa, sb)}

    segs = {}
    for _, r in hit.iterrows():
        p = pair_of(r)
        for seg in {p['sa'], p['sb']}:
            if not seg:
                continue
            s = segs.setdefault(seg, {'seg': seg, 'n': 0, 'up': 0.0, 'down': 0.0, 'top': []})
            s['n'] += 1
            if p['d'] >= 0:
                s['up'] += p['d']
            else:
                s['down'] += -p['d']
            if len(s['top']) < per_segment:
                s['top'].append(p)
    order = {name: i for i, name in enumerate(SEGMENT_ORDER)}
    ordered = sorted(segs.values(), key=lambda s: (order.get(s['seg'], len(order)), s['seg']))
    vmax = max([max(s['up'], s['down']) for s in ordered] or [0.0])
    for s in ordered:
        s['up_pct'] = min(100.0, round(100.0 * s['up'] / vmax, 1)) if vmax else 0.0
        s['down_pct'] = min(100.0, round(100.0 * s['down'] / vmax, 1)) if vmax else 0.0
        s['up'] = round(s['up'], 1)
        s['down'] = round(s['down'], 1)
    out['segments'] = ordered
    hf = {name: i for i, name in enumerate(HELICES_FIRST_ORDER)}
    out['segments_helices_first'] = sorted(ordered, key=lambda s: (hf.get(s['seg'], len(hf)), s['seg']))
    out['has_seg_groups'] = any(s['seg'] in HELICES for s in ordered) and any(s['seg'] not in HELICES for s in ordered)
    helices = [s for s in ordered if s['seg'] in HELICES]
    out['lead'] = [s['seg'] for s in sorted(helices, key=lambda s: -(s['up'] + s['down']))[:3]]
    out['pairs_all'] = [pair_of(r) for _, r in hit.head(top_n).iterrows()]
    out['n_tail'] = sum(1 for p in out['pairs_all'] if p['tail'])
    core = []
    for _, r in hit.iterrows():
        p = pair_of(r)
        if not p['tail']:
            core.append(p)
            if len(core) >= top_n:
                break
    out['pairs'] = core
    return out


def _tail_kind(sa, sb):
    """'' when both residues sit in a helix, 'tail' when either is in a terminus, else 'loop'."""
    kinds = []
    for seg in (sa, sb):
        if not seg or seg in HELICES:
            continue
        kinds.append('tail' if seg in ('N-term', 'C-term') else 'loop')
    if not kinds:
        return ''
    return 'tail' if 'tail' in kinds else 'loop'


def build_extras(gid, annot_map, residue_metrics, models_root, gene_name=''):
    """Template context for one report: the `rx` dict.

    residue_metrics: the report's per-residue DataFrame (may be empty).
    """
    pack = load_pack(gid)
    annotation = residue_annotation(pack, annot_map)
    report_aa = {}
    if residue_metrics is not None and not residue_metrics.empty:
        for _, row in residue_metrics.iterrows():
            if row['amino_acid']:
                report_aa[int(row['position'])] = row['amino_acid']
    clinvar = clinvar_block(pack, annotation, report_aa)
    has_3d = has_model_pair(gid, models_root)
    if models_root is None:
        _warn('models', 'no model directory found (set GPCOMPARE_MODELS_DIR): '
                        'the 3D view is left out of the reports.')

    for r in (clinvar or {}).get('records', []):
        r['stars_text'] = stars_text(r['stars'])
        r['aa3'] = _ONE_TO_THREE.get(r['ref'], r['ref'])
        r['alt3'] = _ONE_TO_THREE.get(r['alt'], r['alt'])

    config = {
        'gid': gid,
        'has3d': has_3d,
        'models': {s: MODELS_URL.format(gid=gid, state=s) for s in STATES} if has_3d else None,
        'embed': EMBED_URL,
        'studio': STUDIO_URL.format(gid=gid),
        'segments': segment_ranges(annotation),
        'annotation': annotation,
        'clinvar': (clinvar['records'] if clinvar else []),
        # null when the build has no ClinVar data: the drawer then says nothing about ClinVar
        'clinvarLabel': clinvar_label(clinvar) if clinvar else None,
        'clinvarScope': CLINVAR_SCOPE,
        'gene': gene_name or '',
    }
    # JS needs only a few fields per record
    config['clinvar'] = [
        {k: r[k] for k in ('pos', 'ref', 'alt', 'hgvsp', 'vid', 'vcv', 'cls', 'stars', 'conditions')}
        for r in config['clinvar']
    ]
    return {
        'annotation': annotation,
        'has_3d': has_3d,
        'studio_url': config['studio'],
        'clinvar': clinvar,
        'config_json': _json_for_script(config),
    }


#: What the ClinVar section and the drawer count: said wherever they say "no records".
CLINVAR_SCOPE = 'pathogenic or likely pathogenic missense records'

_RELEASE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')


def clinvar_label(clinvar):
    """'ClinVar 2026-10-11' (the release is always recorded where ClinVar is used)."""
    rel = (clinvar or {}).get('release', '')
    return 'ClinVar %s' % rel if _RELEASE_RE.match(rel) else 'ClinVar'
