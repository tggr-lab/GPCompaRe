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


def residue_table_extras(delta_df, sig_threshold, am_by_pos, cons_by_pos, positions):
    """{'sig': threshold, 'rows': {str(position): [contacts above threshold, AlphaMissense mean, conservation]}}.

    Feeds the opt-in residue table. Nothing is computed here that the page does
    not already show: the count uses the receptor's own ΔRRCS threshold, and
    the other two values are the caches the snake plot's AlphaMissense and
    Conservation views are coloured from (None where a cache has no value).
    """
    above = {}
    if delta_df is not None and not delta_df.empty:
        hit = delta_df[delta_df['delta_rrcs'].abs() >= sig_threshold]
        for col in ('res1', 'res2'):
            for pos, n in hit[col].astype(int).value_counts().items():
                above[int(pos)] = above.get(int(pos), 0) + int(n)
    out = {}
    for pos in positions:
        pos = int(pos)
        am = (am_by_pos or {}).get(pos)
        cons = (cons_by_pos or {}).get(pos)
        out[str(pos)] = [above.get(pos, 0),
                         None if am is None else round(float(am), 3),
                         None if cons is None else round(float(cons), 3)]
    return {'sig': round(float(sig_threshold), 2), 'rows': out}


def json_for_script(obj):
    return _json_for_script(obj)


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
