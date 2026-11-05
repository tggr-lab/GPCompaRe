"""The motif registry (GPCompaReports_v2/motifs.json): sequence motifs this database defines.

    load()                         the registry as a dict (cached)
    definitions()                  the motif list, as the report pages carry it (#rx-config `motifs`)
    by_generic(residues)           {bw: [pos, aa]} from pack residues ([pos, aa, segment, gn, ...])
    carried(by_bw)                 the motifs a receptor carries: [{id, name, label, glossary, residues}]
    members(gids, residues_of)     {motif id: [member, ...]} over every receptor
    write_site_copy(output_dir, gids, residues_of, info)
                                   <site>/motifs.json: the registry plus `members`, for search

A receptor carries a motif when it has the `requires` residues at those generic numbers (the part
of the GPCRdb number before the x), read from its own sequence. The report snake plot applies the
same rule in the browser to the residues on the page.
"""
import json
from pathlib import Path

PATH = Path(__file__).resolve().parent.parent / 'motifs.json'
_cache = None


def load(path=None):
    global _cache
    if path is not None:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    if _cache is None:
        _cache = json.loads(PATH.read_text(encoding='utf-8'))
    return _cache


def motif(motif_id):
    for m in load()['motifs']:
        if m['id'] == motif_id:
            return m
    raise KeyError(motif_id)


_PAGE_FIELDS = ('id', 'name', 'label', 'positions', 'canonical', 'requires', 'contacts', 'note', 'glossary')


def definitions():
    """What a report page needs of each motif (no prose beyond the chip tooltip)."""
    return [{k: m[k] for k in _PAGE_FIELDS if k in m} for m in load()['motifs']]


def bw_of(gn):
    """'3.36x36' -> '3.36'; '' for an unnumbered residue."""
    head = str(gn or '').split('x')[0]
    return head if head.count('.') == 1 and head.replace('.', '').isdigit() else ''


def by_generic(residues):
    """{bw: [pos, aa]} from pack residues ([pos, aa, segment, gn, ...]); the first residue wins."""
    out = {}
    for r in residues or ():
        bw = bw_of(r[3] if len(r) > 3 else '')
        if bw and bw not in out:
            out[bw] = [int(r[0]), str(r[1] or '')]
    return out


def by_generic_from_annotation(annot_map):
    """The same from a report annotation map (position -> {amino_acid, display_number, ...})."""
    out = {}
    for pos in sorted(annot_map or {}):
        a = annot_map[pos]
        bw = bw_of(a.get('display_number') or a.get('generic_number'))
        if bw and bw not in out:
            out[bw] = [int(pos), a.get('amino_acid') or '']
    return out


def carries(m, by_bw):
    return all((by_bw.get(bw) or [None, ''])[1] == aa for bw, aa in m['requires'].items())


def carried(by_bw):
    """The registry motifs this receptor carries, each with its residues at the motif positions."""
    out = []
    for m in load()['motifs']:
        if not carries(m, by_bw):
            continue
        res = [{'bw': bw, 'pos': by_bw[bw][0], 'aa': by_bw[bw][1]} for bw in m['positions'] if bw in by_bw]
        out.append({'id': m['id'], 'name': m['name'], 'label': m['label'], 'glossary': m['glossary'],
                    'residues': res,
                    'text': ' '.join('%s%d' % (r['aa'], r['pos']) for r in res)})
    return out


def members(gids, residues_of):
    """{motif id: [{gid, residues: {bw: [pos, aa]}}]} for every gid; residues_of(gid) -> {bw: [pos, aa]}."""
    out = {m['id']: [] for m in load()['motifs']}
    for gid in sorted(gids):
        by_bw = residues_of(gid) or {}
        for m in load()['motifs']:
            if carries(m, by_bw):
                out[m['id']].append({'gid': gid, 'residues': {bw: by_bw[bw] for bw in m['positions'] if bw in by_bw}})
    return out


def write_site_copy(output_dir, gids, residues_of, info=None):
    """<site>/motifs.json: the registry with `members` (gid, gene, name, residues) added to each motif.

    Prints a warning when a member count differs from the registry's published `count`."""
    reg = json.loads(json.dumps(load()))
    found = members(gids, residues_of)
    for m in reg['motifs']:
        rows = []
        for row in found[m['id']]:
            i = (info or {}).get(row['gid']) or {}
            rows.append({'gid': row['gid'], 'gene': i.get('gene_name') or '', 'name': i.get('uniprot_name') or '',
                         'residues': row['residues']})
        m['members'] = rows
        want = (m.get('count') or {}).get('receptors')
        if want is not None and len(gids) == (m.get('count') or {}).get('of') and len(rows) != want:
            print('  WARNING: motif %s: %d receptors carry it in this build, the registry says %d'
                  % (m['id'], len(rows), want))
    dst = Path(output_dir) / 'motifs.json'
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(reg, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    return dst
