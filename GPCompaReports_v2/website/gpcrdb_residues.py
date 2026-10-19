"""Full GPCRdb residue numbering for every receptor, with an on-disk cache.

The snake plot on each report page is drawn from GPCRdb's
`/residues/extended/<entry>/` response (via ouroboros), which numbers every
residue GPCRdb can number. The per-receptor annotation CSVs only number the
residues that took part in a high-magnitude contact, so anything that asks
"which receptors have a residue at 6.48x48" must use this full map instead.

Same endpoint as the snake plot, fetched with the standard library so the
build needs nothing beyond its own environment. Cached like the conservation
and AlphaMissense caches, under `<output_dir>/data/gpcrdb_residues/<gid>.json`,
so only the first build into a given output directory touches the network.
`data/` is not published by the deploy script.
"""

import json
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

GPCRDB_RESIDUES_URL = 'https://gpcrdb.org/services/residues/extended/{}/'
CACHE_SUBDIR = Path('data') / 'gpcrdb_residues'

# GPCRdb has since renamed these entries; the old names now return 404 or an
# empty list. Tried only when the site's own id gives nothing.
GPCRDB_RENAMED = {
    'ogr1_human': 'gpr68_human',
    'psyr_human': 'gpr65_human',
}


def _cache_path(output_dir, gid):
    return Path(output_dir) / CACHE_SUBDIR / f'{gid}.json'


def _read_cache(path):
    try:
        rows = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    return rows if isinstance(rows, list) and rows else None


def _fetch_one(gid, timeout=30):
    """[[seq, aa, segment, display_generic_number], ...] or an Exception."""
    data = None
    for entry in (gid, GPCRDB_RENAMED.get(gid)):
        if not entry:
            continue
        try:
            with urllib.request.urlopen(GPCRDB_RESIDUES_URL.format(entry), timeout=timeout) as resp:
                data = json.loads(resp.read().decode('utf-8'))
        except Exception as exc:  # network, HTTP or JSON error: report and carry on
            data = exc
        if isinstance(data, list) and data:
            break
    if not isinstance(data, list):
        return data
    return [
        [int(r.get('sequence_number', 0)), r.get('amino_acid', '?'),
         r.get('protein_segment') or '', r.get('display_generic_number') or '']
        for r in data
    ]


def load_residue_maps(gpcr_ids, output_dir, workers=8):
    """Return ({gid: [[seq, aa, segment, display_generic_number], ...]}, missing).

    `missing` lists receptors with no cached map that could not be fetched.
    """
    maps, todo = {}, []
    for gid in gpcr_ids:
        rows = _read_cache(_cache_path(output_dir, gid))
        if rows:
            maps[gid] = rows
        else:
            todo.append(gid)

    missing = []
    if todo:
        print(f"  Fetching GPCRdb residue numbering for {len(todo)} receptors...")
        with ThreadPoolExecutor(max_workers=workers) as pool:
            results = dict(zip(todo, pool.map(_fetch_one, todo)))
        for gid in todo:
            rows = results[gid]
            if isinstance(rows, list) and rows:
                path = _cache_path(output_dir, gid)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(rows, separators=(',', ':')), encoding='utf-8')
                maps[gid] = rows
            else:
                missing.append(gid)
        if missing:
            print(f"  WARNING: no GPCRdb residue map for {len(missing)} receptors, left out "
                  "of position search: " + ', '.join(missing[:10])
                  + (' ...' if len(missing) > 10 else ''))
    return maps, missing
