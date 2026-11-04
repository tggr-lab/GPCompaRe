#!/usr/bin/env python3
"""Step 3c (offline): MANE RefSeq NM_ with version for each chosen transcript -> record['refseq'] in transcripts.json.gz.

Sources, in order: HGNC mane_select pair (ENST.v, NM_.v), then the ClinVar cache refseq block (maneEnsembl).
A pick is `exact` when the MANE Ensembl transcript is the chosen ENST. For ccr2, gp142 and gpr17 the pack's transcript is
not the MANE one (the pack chose an Ensembl transcript with an identical protein): the MANE NM is still reported, with
nm_transcript_differs = true and protein_identical = (our CDS translation == the ClinVar refseq translation of that NM).
Run: python3 resolve_refseq.py
"""
from common import HERE, SOURCES, load_gz_json, write_gz_json

OUT = HERE / "ensembl_cds" / "transcripts.json.gz"
CODON = dict(zip((a + b + c for a in "TCAG" for b in "TCAG" for c in "TCAG"),
                 "FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG"))


def tr(s):
    return "".join(CODON.get(s[i:i + 3], "X") for i in range(0, len(s) - 2, 3))


def main():
    t = load_gz_json(OUT)
    hgnc = load_gz_json(HERE / "hgnc" / "hgnc_records.json.gz")
    stats = {"exact": 0, "other_transcript": 0, "none": 0}
    for gid, rec in t.items():
        if "cds_seq" not in rec:
            continue
        chosen = rec["grch38"]["transcript"]
        cp = SOURCES / "clinvar" / f"{gid}.json.gz"
        crs = (load_gz_json(cp).get("refseq") if cp.exists() else None) or {}
        cands = []     # (nm, enst_v, source)
        m = hgnc[gid].get("mane_select")
        if m and len(m) == 2:
            cands.append((m[1], m[0], "hgnc_mane_select"))
        for nm, d in crs.items():
            for e in (d.get("maneEnsembl") or [])[:1]:
                if e.endswith(".") or "ENST" in e:
                    cands.append((nm, e, "clinvar_refseq_maneEnsembl"))
        exact = next((c for c in cands if c[1].split(".")[0] == chosen), None)
        out = {"nm": None, "source": None, "nm_enst": None, "nm_transcript_differs": None, "protein_identical": None,
               "all_candidates": [list(c) for c in cands], "clinvar_refseq_keys": sorted(crs)}
        pick = exact or (cands[0] if cands else None)
        if pick:
            nm, enst_v, src = pick
            prot = (crs.get(nm) or {}).get("translation")
            out.update({"nm": nm, "source": src, "nm_enst": enst_v, "nm_transcript_differs": exact is None,
                        "protein_identical": (tr(rec["cds_seq"]).rstrip("*") == prot) if prot else None})
            # nm_usable: c. positions of this NM can be read through our CDS only when the proteins are identical
            out["nm_usable"] = out["protein_identical"] is True
            stats["exact" if exact else "other_transcript"] += 1
        else:
            stats["none"] += 1
        rec["refseq"] = out
    write_gz_json(OUT, t)
    print(stats)


if __name__ == "__main__":
    main()
