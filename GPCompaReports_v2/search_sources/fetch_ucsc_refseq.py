#!/usr/bin/env python3
"""Step 6a'': RefSeq NM_/XM_ coordinates on GRCh37 (and a GRCh38 cross-check) from UCSC `ncbiRefSeq` tables.

Why: the grch37 Ensembl host has no RefSeq import, so there is no Ensembl source for GRCh37 NM_ coordinates.
UCSC ncbiRefSeq (NCBI RefSeq alignments, accession WITH version) is a small download:
  http://hgdownload.soe.ucsc.edu/goldenPath/hg19/database/ncbiRefSeq.txt.gz   4.6 MB  (Last-Modified 2024-09-18)
  http://hgdownload.soe.ucsc.edu/goldenPath/hg38/database/ncbiRefSeq.txt.gz   7.3 MB  (Last-Modified 2025-08-13)
Download them first into an empty scratch directory (the data is parsed as text only, never executed):
  d=~/scratch/2026-11-04_ucsc_refseq; mkdir -p $d; cd $d
  curl -s -D hg19.headers -o hg19.ncbiRefSeq.txt.gz http://hgdownload.soe.ucsc.edu/goldenPath/hg19/database/ncbiRefSeq.txt.gz
  curl -s -D hg38.headers -o hg38.ncbiRefSeq.txt.gz http://hgdownload.soe.ucsc.edu/goldenPath/hg38/database/ncbiRefSeq.txt.gz
then: python3 fetch_ucsc_refseq.py [dir]
Rows are kept when the protein-coding transcript (NM_/XM_, cdsStart < cdsEnd) is on a primary chromosome and name2 is one of the
receptor's HGNC/index/previous symbols. Output (same record layout as refseq_grch38.json.gz):
  transcripts_all/refseq_grch37.json.gz       gid -> [transcript]  (hg19 = GRCh37)
  transcripts_all/ucsc_refseq_grch38.json.gz  same for hg38 (cross-check against the Ensembl otherfeatures import only)
UCSC table data is free to use; cite the Genome Browser (Nassar et al.) and NCBI RefSeq (O'Leary et al. 2016).
"""
import gzip
import sys
from pathlib import Path

from common import HERE, load_gz_json, write_gz_json, write_json

OUT = HERE / "transcripts_all"
PRIMARY = {str(i) for i in range(1, 23)} | {"X", "Y", "M"}


def parse(path, symbols):
    by_sym = {}
    for g, ss in symbols.items():
        for s in ss:
            by_sym.setdefault(s, set()).add(g)
    out = {g: [] for g in symbols}
    with gzip.open(path, "rt") as fh:
        for line in fh:
            f = line.rstrip("\n").split("\t")
            name, chrom, strand = f[1], f[2], f[3]
            if name[:3] not in ("NM_", "XM_") or not chrom.startswith("chr") or chrom[3:] not in PRIMARY:
                continue
            tx_s, tx_e, cds_s, cds_e = int(f[4]), int(f[5]), int(f[6]), int(f[7])
            if cds_s >= cds_e:
                continue
            for gid in by_sym.get(f[12], ()):
                st = [int(x) for x in f[9].strip(",").split(",")]
                en = [int(x) for x in f[10].strip(",").split(",")]
                exons = [(a + 1, b) for a, b in zip(st, en)]          # 1-based inclusive
                sgn = 1 if strand == "+" else -1
                exons.sort(reverse=(sgn == -1))
                segs, pos = [], 0
                for a, b in exons:
                    x, y = max(a, cds_s + 1), min(b, cds_e)
                    if x <= y:
                        segs.append([x, y, pos + 1, pos + y - x + 1])
                        pos += y - x + 1
                out[gid].append({"accession": name, "np": None, "chrom": chrom[3:].replace("M", "MT"), "strand": sgn,
                                 "tx_start": tx_s + 1, "tx_end": tx_e, "tags": [], "biotype": "protein_coding",
                                 "exons": [list(e) for e in exons], "cds_segments": segs, "cds_length": pos,
                                 "cds_start_stat": f[13], "cds_end_stat": f[14]})
    for g in out:
        out[g].sort(key=lambda t: t["accession"])
    return out


def main():
    d = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "scratch" / "2026-11-04_ucsc_refseq"
    hgnc = load_gz_json(HERE / "hgnc" / "hgnc_records.json.gz")
    recs = load_gz_json(HERE / "ensembl_cds" / "transcripts.json.gz")
    symbols = {g: {hgnc[g]["symbol"], recs[g]["symbol"], *hgnc[g].get("prev_symbol", [])} for g in recs}
    r37 = parse(d / "hg19.ncbiRefSeq.txt.gz", symbols)
    r38 = parse(d / "hg38.ncbiRefSeq.txt.gz", symbols)
    write_gz_json(OUT / "refseq_grch37.json.gz", r37)
    write_gz_json(OUT / "ucsc_refseq_grch38.json.gz", r38)
    meta = {"source": "UCSC Genome Browser ncbiRefSeq tables", "files": {}}
    for b in ("hg19", "hg38"):
        import hashlib
        h = (d / f"{b}.headers").read_text()
        meta["files"][b] = {"sha256": hashlib.sha256((d / f"{b}.ncbiRefSeq.txt.gz").read_bytes()).hexdigest(),
                            "last_modified": next((l.split(": ", 1)[1].strip() for l in h.splitlines() if l.lower().startswith("last-modified")), None)}
    meta["transcripts_grch37"] = sum(len(v) for v in r37.values())
    meta["transcripts_grch38"] = sum(len(v) for v in r38.values())
    write_json(OUT / "_meta_ucsc.json", meta)
    print(meta)


if __name__ == "__main__":
    main()
