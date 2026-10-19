"""Generic numbering as shown in the published snake plots.

Position search on Browse needs every receptor's full GPCRdb numbering. The
annotation CSVs number only residues in a high-magnitude contact, and GPCRdb's
live API has drifted from what the approved snake plots show (it now serves
MCHR1 as a shorter isoform, 69 residues off, and no longer resolves two
entries). So the build reads a tracked snapshot taken from the published
snake plots by scripts/extract_snake_numbering.py, and never the network.
"""
import json
from pathlib import Path

SNAPSHOT = Path(__file__).resolve().parent.parent / 'data' / 'snake_numbering.json'


def load_snake_numbering(gpcr_ids, path=SNAPSHOT):
    """Return ({gid: [[seq, aa, generic_number], ...]}, missing gids)."""
    if not path.is_file():
        print(f"  WARNING: {path} is missing; position search will be empty. "
              "Recreate it with scripts/extract_snake_numbering.py.")
        return {}, list(gpcr_ids)
    data = json.loads(path.read_text(encoding='utf-8'))['receptors']
    maps = {g: data[g] for g in gpcr_ids if data.get(g)}
    missing = [g for g in gpcr_ids if g not in maps]
    if missing:
        print(f"  WARNING: no snake-plot numbering for {len(missing)} receptors: "
              + ', '.join(missing[:10]) + (' ...' if len(missing) > 10 else ''))
    return maps, missing
