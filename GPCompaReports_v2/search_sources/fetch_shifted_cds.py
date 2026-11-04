#!/usr/bin/env python3
"""Step 3b: CDS in gnomAD/ClinVar numbering for receptors whose current Ensembl CDS has moved (lpar2, oxer1).

gnomAD v4.1.2 annotated against an older transcript model, so its hgvsc/hgvsp numbering no longer matches the current
Ensembl CDS for lpar2 (3 more N-terminal residues) and oxer1 (longer N-terminus). For every receptor whose cached
alleles fail the c.->residue test (see validate.py), this script
  1. measures the constant offset  d = (gnomAD hgvsc c. position) - (c. position derived from genomic coordinates through
     the current CDS segments),
  2. fetches the cDNA (GET /sequence/id/<ENST>?type=cdna), takes the d bases upstream of the current start codon, and
     stores  gnomad_numbering = {c_offset, cds_seq (= upstream + current CDS), residue_offset}  in the record.
The result is re-checked allele by allele in validate.py. Nothing in the Studio pack numbering is changed.
Run after fetch_ensembl_cds.py: python3 fetch_shifted_cds.py
"""
import collections
import re

from common import ENSEMBL38, HERE, SOURCES, Client, load_gz_json, write_gz_json

OUT = HERE / "ensembl_cds" / "transcripts.json.gz"
HGVSC = re.compile(r"^c\.(\d+)[ACGT]>[ACGT]$")
CODON = dict(zip((a + b + c for a in "TCAG" for b in "TCAG" for c in "TCAG"),
                 "FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG"))


def tr(s):
    return "".join(CODON.get(s[i:i + 3], "X") for i in range(0, len(s) - 2, 3))


def main():
    t = load_gz_json(OUT)
    c = Client(ENSEMBL38, rate=4)
    changed = []
    for gid, rec in t.items():
        if "cds_seq" not in rec:
            continue
        seq, tx = rec["cds_seq"], rec["grch38"]
        bad = collections.Counter()
        for v in load_gz_json(SOURCES / "gnomad" / f"{gid}.json.gz")["variants"]:
            m = HGVSC.match((v.get("transcript_consequence") or {}).get("hgvsc") or v.get("hgvsc") or "")
            if not m:
                continue
            cpos = int(m[1])
            pos = int(v["variant_id"].split("-")[1])
            gc = next((cf + (pos - a if tx["strand"] == 1 else b - pos) for a, b, cf, ct in tx["cds_segments"] if a <= pos <= b), None)
            if gc is not None:
                bad[cpos - gc] += 1
        d, n = bad.most_common(1)[0]
        rec.pop("gnomad_numbering", None)
        if d == 0 and len(bad) == 1:
            continue
        cdna = c.get(f"/sequence/id/{tx['transcript']}?type=cdna")["seq"]
        start = cdna.find(seq)
        ext, ext_src = (cdna[start - d:start], "cdna") if d > 0 and start >= d else (None, None)
        if ext is None and d > 0:
            # cDNA has too little 5' UTR: the older model starts further upstream. Take the d bases directly upstream
            # of the start codon on the genome (transcript orientation); validate.py checks every allele against it.
            a0, b0 = tx["cds_segments"][0][0], tx["cds_segments"][0][1]
            if tx["strand"] == 1:
                reg, strand = f"{tx['chrom']}:{a0 - d}..{a0 - 1}:1", 1
            else:
                reg, strand = f"{tx['chrom']}:{b0 + 1}..{b0 + d}:-1", -1
            ext = c.get(f"/sequence/region/human/{reg}", accept="text/plain").strip().upper()
            ext_src = "genome_upstream_contiguous"
        rec["gnomad_numbering"] = {
            "c_offset": d, "alleles_at_offset": n, "alleles_total": sum(bad.values()),
            "offset_distribution": {str(k): v for k, v in bad.items()},
            "residue_offset": d // 3 if d % 3 == 0 else None,
            "upstream_bases_used": ext, "upstream_source": ext_src, "cdna_cds_start": start + 1,
            "cds_seq": (ext + seq) if ext else None,
            "cds_translation_starts": tr(ext + seq)[:12] if ext else None,
            "note": "gnomAD numbering = current Ensembl CDS shifted by c_offset (older, longer N-terminus); "
                    "the Studio pack numbering and the report numbering are NOT changed",
        }
        changed.append((gid, d, n, sum(bad.values())))
    write_gz_json(OUT, t)
    print("shifted:", changed, "requests", c.requests)


if __name__ == "__main__":
    main()
