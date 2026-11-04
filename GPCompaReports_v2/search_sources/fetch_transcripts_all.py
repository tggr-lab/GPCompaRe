#!/usr/bin/env python3
"""Step 6a: EVERY protein-coding transcript of the 283 genes, Ensembl (ENST) and RefSeq (NM_) on GRCh38 and GRCh37.

Outputs in transcripts_all/ (each skipped if it already exists; delete to refetch):
  ensembl_grch38.json.gz, ensembl_grch37.json.gz   gid -> [transcript]; ENST id/version, ENSP, exons, CDS segments with
        c. ranges, strand, CDS sequence, protein sequence, canonical flag, mane_select (by HGNC / ClinVar MANE pair)
  refseq_grch38.json.gz     gid -> [NM_/XM_ transcript] from the Ensembl "otherfeatures" RefSeq import (logic_name
        refseq_import): accession.version, NP_, exons, CDS segments with c. ranges, tags (MANE_Select ...)
  (refseq_grch37.json.gz is written by fetch_ucsc_refseq.py: the GRCh37 Ensembl host carries no RefSeq import)
Ensembl: POST /lookup/id (genes, expand=1) -> transcripts+exons+translation; POST /sequence/id type=cds and type=protein;
GET /overlap/region/human/<gene window>?feature=transcript;feature=exon;feature=cds;db_type=otherfeatures (6 threads).
All calls share one limiter (<= 6 requests/s per host), Retry-After honoured. The GRCh37 host serves the older RefSeq
and Ensembl versions. Run: python3 fetch_transcripts_all.py
"""
import json
import os
from concurrent.futures import ThreadPoolExecutor

from common import ENSEMBL37, ENSEMBL38, HERE, SOURCES, Client, load_gz_json, write_gz_json
from fetch_ensembl_cds import chunks, tx_view

OUT = HERE / "transcripts_all"
PRIMARY = {str(i) for i in range(1, 23)} | {"X", "Y", "MT"}


def seq_post(c, ids, kind):
    out = {}
    for ch in chunks(sorted(ids), 50):
        for x in c.post(f"/sequence/id?type={kind}", {"ids": ch}):
            out[x.get("query") or x["id"]] = x["seq"]
    return out


def mane_pairs(gid, hgnc):
    s = set()
    m = hgnc[gid].get("mane_select")
    if m:
        s.add(m[0].split(".")[0])
    cp = SOURCES / "clinvar" / f"{gid}.json.gz"
    if cp.exists():
        for d in (load_gz_json(cp).get("refseq") or {}).values():
            for e in d.get("maneEnsembl") or []:
                if "ENST" in e:
                    s.add(e.split(".")[0])
    return s


def ensembl_phase(c, tag, genes, hgnc):
    path = OUT / f"ensembl_{tag}.json.gz"
    if path.exists():
        return
    ids = sorted({g for g in genes.values() if g})
    genedocs = {}
    for ch in chunks(ids, 20):
        res = c.post("/lookup/id", {"ids": ch, "expand": 1})
        genedocs.update({k: v for k, v in res.items() if v})
        print(tag, "genes", len(genedocs), "/", len(ids), flush=True)
    tx = {}
    for gid, ensg in genes.items():
        d = genedocs.get(ensg)
        if not d:
            continue
        mane = mane_pairs(gid, hgnc)
        lst = []
        for t in d.get("Transcript", []):
            if t.get("biotype") != "protein_coding" or not t.get("Translation"):
                continue
            v = tx_view(t)
            v["id"] = v.pop("transcript")
            v["ensp"] = v.pop("translation")
            v["ensp_version"] = v.pop("translation_version")
            v["is_canonical"] = bool(t.get("is_canonical"))
            v["mane_select"] = v["id"] in mane
            v["source"] = t.get("source")
            lst.append(v)
        tx[gid] = lst
    allt = [t["id"] for l in tx.values() for t in l]
    allp = [t["ensp"] for l in tx.values() for t in l]
    cds = seq_post(c, allt, "cds")
    print(tag, "cds", len(cds), flush=True)
    prot = seq_post(c, allp, "protein")
    print(tag, "protein", len(prot), flush=True)
    for l in tx.values():
        for t in l:
            t["cds_seq"] = cds.get(t["id"])
            t["protein"] = prot.get(t["ensp"])
    write_gz_json(path, tx)


def refseq_phase(c, tag, windows, symbols):
    path = OUT / f"refseq_{tag}.json.gz"
    if path.exists():
        return
    def one(item):
        gid, w = item
        if not w:
            return gid, []
        j = c.get(f"/overlap/region/human/{w['chrom']}:{w['start']}..{w['end']}"
                  "?feature=transcript;feature=exon;feature=cds;db_type=otherfeatures")
        tr = {x["id"]: x for x in j if x["feature_type"] == "transcript" and x.get("logic_name") == "refseq_import"
              and (x.get("external_name") or "")[:3] in ("NM_", "XM_") and x.get("biotype") == "protein_coding"
              and x.get("Parent", "").replace("gene-", "") in symbols[gid]}
        res = []
        for tid, x in tr.items():
            cds = sorted(((f["start"], f["end"]) for f in j if f["feature_type"] == "cds" and f.get("Parent") == tid),
                         reverse=(x["strand"] == -1))
            exons = sorted(((f["start"], f["end"]) for f in j if f["feature_type"] == "exon" and f.get("Parent") == tid),
                           reverse=(x["strand"] == -1))
            np_ = next((f["id"][4:] for f in j if f["feature_type"] == "cds" and f.get("Parent") == tid), None)
            segs, pos = [], 0
            for a, b in cds:
                segs.append([a, b, pos + 1, pos + b - a + 1])
                pos += b - a + 1
            res.append({"accession": x["external_name"], "np": np_, "chrom": x["seq_region_name"], "strand": x["strand"],
                        "tx_start": x["start"], "tx_end": x["end"], "tags": x.get("tag", []), "biotype": x["biotype"],
                        "exons": [list(e) for e in exons], "cds_segments": segs, "cds_length": pos})
        return gid, sorted(res, key=lambda r: r["accession"])
    with ThreadPoolExecutor(max_workers=6) as ex:
        out = dict(ex.map(one, windows.items()))
    write_gz_json(path, out)
    print(tag, "refseq transcripts", sum(len(v) for v in out.values()), flush=True)


def main():
    OUT.mkdir(exist_ok=True)
    t = load_gz_json(HERE / "ensembl_cds" / "transcripts.json.gz")
    hgnc = load_gz_json(HERE / "hgnc" / "hgnc_records.json.gz")
    c38, c37 = Client(ENSEMBL38, rate=6), Client(ENSEMBL37, rate=6)
    g38 = {g: (r.get("gene_grch38") or {}).get("gene") for g, r in t.items()}
    g37 = {g: (r.get("gene_grch37") or {}).get("gene") for g, r in t.items()}
    w38 = {g: r.get("gene_grch38") for g, r in t.items()}
    w37 = {g: r.get("gene_grch37") for g, r in t.items()}
    symbols = {g: {hgnc[g]["symbol"], t[g]["symbol"], *hgnc[g].get("prev_symbol", []), *hgnc[g].get("alias_symbol", [])} for g in t}
    for tag, c, genes, win in (("grch38", c38, g38, w38), ("grch37", c37, g37, w37)):
        ensembl_phase(c, tag, genes, hgnc)
        if tag == "grch38":
            refseq_phase(c, tag, {g: w for g, w in win.items() if w and w["chrom"] in PRIMARY}, symbols)
        # GRCh37: the grch37 Ensembl host has no RefSeq import in otherfeatures (only ESTgenes and CCDS), so
        # refseq_grch37.json.gz comes from fetch_ucsc_refseq.py instead
    print("failures", c38.failures + c37.failures)


if __name__ == "__main__":
    main()
