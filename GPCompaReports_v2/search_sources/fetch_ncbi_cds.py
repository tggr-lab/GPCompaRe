#!/usr/bin/env python3
"""Step 6b: NCBI CDS and protein for every NM_/XM_ accession.version we may meet, including older versions.

Harvest (gid -> accession.version -> sources):
  ensembl_otherfeatures_grch38 / ucsc_ncbiRefSeq_hg19   current RefSeq on GRCh38 (Ensembl import) and GRCh37 (UCSC)
  hgnc_mane_select                         MANE pair in the HGNC record
  clinvar_refseq_block / clinvar_title     pack/sources/clinvar: refseq block keys, and NM_xxx.v(GENE) in record titles
                                           when GENE is this receptor's symbol (records on another gene's NM are ignored)
Fetch: NCBI E-utilities efetch db=nuccore rettype=fasta_cds_na and fasta_cds_aa, 100 accessions per call, <= 2.5 req/s
(NCBI limit without an API key is 3/s); a failing batch is split until the bad accession is isolated.
Output: transcripts_all/ncbi_cds.json.gz  {accession.version: {np, gene, protein_name, location, cds_seq, protein}}
        transcripts_all/nm_harvest.json.gz {gid: {accession.version: [sources]}}, _meta in transcripts_all/_meta_ncbi.json
Public domain data (NCBI). Run after fetch_transcripts_all.py: python3 fetch_ncbi_cds.py
"""
import re
import urllib.parse
from collections import defaultdict

from common import HERE, SOURCES, Client, load_gz_json, receptors, write_gz_json, write_json

OUT = HERE / "transcripts_all"
EUTILS = "https://eutils.ncbi.nlm.nih.gov"
HEAD = re.compile(r"^>lcl\|(?P<nm>[NX]M_\d+\.\d+)_(?:cds|prot)_(?P<np>\S+)_\d+ (?P<rest>.*)$")


def parse_fasta(text):
    out, cur = {}, None
    for line in text.splitlines():
        if line.startswith(">"):
            m = HEAD.match(line)
            cur = None
            if m:
                tags = dict(re.findall(r"\[(\w+)=([^\]]*)\]", m["rest"]))
                cur = m["nm"]
                out.setdefault(cur, {"np": m["np"], "gene": tags.get("gene"), "protein_name": tags.get("protein"),
                                     "location": tags.get("location"), "seq": ""})
        elif cur:
            out[cur]["seq"] += line.strip()
    return out


def fetch(c, accs, rettype, missing):
    got = {}
    def run(batch):
        url = (f"/entrez/eutils/efetch.fcgi?db=nuccore&id={','.join(batch)}&rettype={rettype}&retmode=text"
               "&tool=gpcompare_search_sources&email=none@example.org")
        try:
            got.update(parse_fasta(c.get(url, accept="text/plain")))
        except Exception:
            if len(batch) == 1:
                missing.add(batch[0])
            else:
                h = len(batch) // 2
                run(batch[:h]); run(batch[h:])
    for i in range(0, len(accs), 100):
        run(accs[i:i + 100])
    for a in accs:
        if a not in got:
            missing.add(a)
    return got


def main():
    recs = receptors()
    harvest = defaultdict(lambda: defaultdict(set))
    for tag in ("grch38", "grch37"):
        for gid, lst in load_gz_json(OUT / f"refseq_{tag}.json.gz").items():
            for t in lst:
                harvest[gid][t["accession"]].add("ensembl_otherfeatures_grch38" if tag == "grch38" else "ucsc_ncbiRefSeq_hg19")
    hgnc = load_gz_json(HERE / "hgnc" / "hgnc_records.json.gz")
    for r in recs:
        gid = r["gid"]
        m = hgnc[gid].get("mane_select")
        if m and len(m) == 2:
            harvest[gid][m[1]].add("hgnc_mane_select")
        cp = SOURCES / "clinvar" / f"{gid}.json.gz"
        if not cp.exists():
            continue
        cv = load_gz_json(cp)
        for k in cv.get("refseq") or {}:
            harvest[gid][k].add("clinvar_refseq_block")
        syms = {r["gene"], cv.get("symbol"), *cv.get("acceptedSymbols", []), hgnc[gid]["symbol"]}
        for rec in cv["records"]:
            for mm in re.finditer(r"(NM_\d+\.\d+)\(([^)]+)\)", rec["title"]):
                if mm[2] in syms:
                    harvest[gid][mm[1]].add("clinvar_title")
    accs = sorted({a for d in harvest.values() for a in d})
    print(len(accs), "accession.versions to fetch", flush=True)
    c = Client(EUTILS, rate=2.5, accept="text/plain")
    missing = set()
    na = fetch(c, accs, "fasta_cds_na", missing)
    aa = fetch(c, accs, "fasta_cds_aa", missing)
    out = {}
    for a in accs:
        if a in na and a in aa:
            out[a] = {"np": na[a]["np"], "gene": na[a]["gene"], "protein_name": na[a]["protein_name"],
                      "location": na[a]["location"], "cds_seq": na[a]["seq"], "protein": aa[a]["seq"]}
    write_gz_json(OUT / "ncbi_cds.json.gz", out)
    write_gz_json(OUT / "nm_harvest.json.gz", {g: {a: sorted(s) for a, s in d.items()} for g, d in harvest.items()})
    write_json(OUT / "_meta_ncbi.json", {"source": "NCBI E-utilities efetch db=nuccore fasta_cds_na / fasta_cds_aa",
                                          "accessions_requested": len(accs), "returned": len(out),
                                          "missing": sorted(set(accs) - set(out)), "requests": c.requests})
    print(len(out), "of", len(accs), "missing", sorted(set(accs) - set(out)))


if __name__ == "__main__":
    main()
