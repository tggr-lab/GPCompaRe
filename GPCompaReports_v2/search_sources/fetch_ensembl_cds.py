#!/usr/bin/env python3
"""Step 3: exon/CDS coordinates (GRCh38 + GRCh37), CDS sequence, MANE RefSeq NM for the chosen transcripts.

-> ensembl_cds/transcripts.json.gz  (dict gid -> record) and ensembl_cds/_meta.json
Then run, in order: fetch_shifted_cds.py (lpar2/oxer1 numbering) and resolve_refseq.py (MANE NM_, offline).

Transcript choice: the one the gnomAD pack used (pack/sources/gnomad/<gid>.json.gz: transcript + version), i.e. the
MANE Select transcript where one exists (or the pack's documented fallback: hrh2, p2ry8).
Ensembl REST was slow (13-60 s per call, intermittent 503) when this was fetched, so everything that has a POST form
is batched: POST /lookup/id (transcripts with expand=1, then genes), POST /sequence/id?type=cds (50 per call),
POST /lookup/symbol/homo_sapiens (GRCh37 genes whose ENSG is absent). Only /map/cds/<ENST>/1..N (independent cross-check
of our exon x translation split) is a GET per receptor, run with 6 threads. All calls share one rate limiter
(<= 8 requests/s per host) and honour Retry-After.
  GRCh38: rest.ensembl.org      GRCh37: grch37.rest.ensembl.org (same stable ID looked up; version may differ)
Pseudogenes without a protein-coding transcript (npy6r, taar3) get a gene-window-only record.
Idempotent: gids already in the output are kept; --redo gid ... refetches some. Run: python3 fetch_ensembl_cds.py
"""
import json
import sys
from concurrent.futures import ThreadPoolExecutor

from common import (ENSEMBL37, ENSEMBL38, HERE, SOURCES, Client, load_gz_json, receptors, write_gz_json,
                    write_json)

OUT = HERE / "ensembl_cds" / "transcripts.json.gz"
META = HERE / "ensembl_cds" / "_meta.json"


def chunks(xs, n):
    for i in range(0, len(xs), n):
        yield xs[i:i + n]


def tx_view(look):
    """Exons (transcript order), CDS segments with c. ranges, from a lookup/id?expand=1 document."""
    strand = look["strand"]
    exons = sorted(((e["start"], e["end"]) for e in look["Exon"]), reverse=(strand == -1))
    tr = look.get("Translation")
    segs, pos = [], 0
    if tr:
        ts, te = tr["start"], tr["end"]
        for s, e in exons:
            a, b = max(s, ts), min(e, te)
            if a <= b:
                n = b - a + 1
                segs.append([a, b, pos + 1, pos + n])
                pos += n
    return {
        "transcript": look["id"], "version": look["version"], "chrom": look["seq_region_name"], "strand": strand,
        "tx_start": look["start"], "tx_end": look["end"], "biotype": look.get("biotype"),
        "exons": [list(x) for x in exons], "cds_segments": segs, "cds_length": pos,
        "translation": tr["id"] if tr else None, "translation_version": tr.get("version") if tr else None,
        "translation_length": tr.get("length") if tr else None,
    }


def gene_view(g):
    if not g:
        return None
    return {"gene": g["id"], "version": g.get("version"), "symbol": g.get("display_name"), "chrom": g["seq_region_name"],
            "start": g["start"], "end": g["end"], "strand": g["strand"], "biotype": g.get("biotype")}


def lookup_batch(c, ids, expand):
    out = {}
    for ch in chunks(ids, 100):
        res = c.post("/lookup/id", {"ids": ch, "expand": 1 if expand else 0})
        out.update({k: v for k, v in res.items() if v})
    return out


def seq_batch(c, ids):
    out = {}
    for ch in chunks(ids, 50):
        res = c.post("/sequence/id?type=cds", {"ids": ch})
        for x in res:
            out[x["query"] if "query" in x else x["id"]] = x["seq"]
    return out


def main():
    redo = set(sys.argv[2:]) if len(sys.argv) > 1 and sys.argv[1] == "--redo" else set()
    hgnc = load_gz_json(HERE / "hgnc" / "hgnc_records.json.gz")
    out = load_gz_json(OUT) if OUT.exists() else {}
    c38, c37 = Client(ENSEMBL38, rate=8), Client(ENSEMBL37, rate=8)
    todo = [r for r in receptors() if r["gid"] not in out or r["gid"] in redo]
    if not todo:
        print("nothing to do")
    info = {}
    for r in todo:
        gid = r["gid"]
        gp = SOURCES / "gnomad" / f"{gid}.json.gz"
        ep = SOURCES / "ensembl" / f"{gid}.json"
        ens = json.load(open(ep)) if ep.exists() else {}
        gn = load_gz_json(gp) if gp.exists() else None
        h = hgnc[gid]
        info[gid] = {"r": r, "ens": ens, "gn": gn, "h": h, "ensg": ens.get("geneId") or h.get("ensembl_gene_id"),
                     "enst": gn["transcript"] if gn else None}
    enst_ids = sorted({v["enst"] for v in info.values() if v["enst"]})
    ensg_ids = sorted({v["ensg"] for v in info.values() if v["ensg"]})
    print("requesting", len(enst_ids), "transcripts,", len(ensg_ids), "genes", flush=True)

    # --- GRCh38 and GRCh37 batched lookups
    l38 = lookup_batch(c38, enst_ids, True)
    g38 = lookup_batch(c38, ensg_ids, False)
    print("GRCh38 lookups done", len(l38), len(g38), flush=True)
    l37 = lookup_batch(c37, enst_ids, True)
    g37 = lookup_batch(c37, ensg_ids, False)
    print("GRCh37 lookups done", len(l37), len(g37), flush=True)
    miss_syms = sorted({(v["h"]["symbol"]) for v in info.values() if v["ensg"] not in g37})
    s37 = {}
    for ch in chunks(miss_syms, 100):
        res = c37.post("/lookup/symbol/homo_sapiens", {"symbols": ch, "expand": 1})
        s37.update({k: v for k, v in res.items() if v})
    s38 = {}
    for ch in chunks(sorted({v["h"]["symbol"] for v in info.values() if v["ensg"] not in g38}), 100):
        res = c38.post("/lookup/symbol/homo_sapiens", {"symbols": ch})
        s38.update({k: v for k, v in res.items() if v})
    q38 = [e for e in enst_ids if e in l38]
    seq38 = seq_batch(c38, q38)
    print("GRCh38 sequences", len(seq38), flush=True)
    seq37 = seq_batch(c37, [e for e in enst_ids if e in l37])
    print("GRCh37 sequences", len(seq37), flush=True)

    # --- /map/cds cross-check, one GET per receptor
    def mapcds(enst):
        s = seq38[enst]
        m = c38.get(f"/map/cds/{enst}/1..{len(s)}")["mappings"]
        return enst, sorted((x["start"], x["end"]) for x in m if x.get("gap", 0) == 0)
    with ThreadPoolExecutor(max_workers=6) as ex:
        maps = dict(ex.map(mapcds, q38))
    print("map/cds done", len(maps), flush=True)

    for gid, v in info.items():
        r, ens, gn, h, ensg, enst = v["r"], v["ens"], v["gn"], v["h"], v["ensg"], v["enst"]
        rec = {"gid": gid, "symbol": r["gene"], "hgnc_symbol": h.get("symbol"), "ensg": ensg, "uniprot": r["uniprotId"],
               "gene_grch38": gene_view(g38.get(ensg) or s38.get(h["symbol"])),
               "gene_grch37": gene_view(g37.get(ensg) or s37.get(h["symbol"]))}
        rec["gene_grch37_via"] = "ensg" if ensg in g37 else ("symbol" if h["symbol"] in s37 else None)
        if not gn:
            rec["note"] = "no protein-coding transcript (pseudogene); gene windows only"
            out[gid] = rec
            continue
        mane = next((t for t in ens.get("transcripts", []) if t["id"] == enst), {})
        rec["pack_transcript"] = {"id": enst, "version": gn["transcriptVersion"], "chosenBy": ens.get("chosenBy"),
                                  "mane": mane.get("mane"), "canonical": mane.get("canonical")}
        look = l38[enst]
        t38 = tx_view(look)
        seq = seq38[enst]
        t38["version_matches_pack"] = str(look["version"]) == str(gn["transcriptVersion"]).split("_")[0]
        t38["cds_seq_length"] = len(seq)
        t38["cds_length_consistent"] = len(seq) == t38["cds_length"]
        t38["map_cds_agrees"] = maps[enst] == sorted((s[0], s[1]) for s in t38["cds_segments"])
        rec["grch38"] = t38
        rec["cds_seq"] = seq
        if enst in l37 and l37[enst].get("object_type") == "Transcript":
            t37 = tx_view(l37[enst])
            t37["same_stable_id"] = True
            t37["cds_identical_to_grch38"] = seq37.get(enst) == seq
            t37["cds_seq_length"] = len(seq37[enst]) if enst in seq37 else None
            rec["grch37"] = t37
        else:
            cand = [{"id": t["id"], "version": t["version"], "translation_length": t["Translation"].get("length")}
                    for t in (s37.get(h["symbol"]) or {}).get("Transcript", []) if t.get("Translation")]
            rec["grch37"] = {"same_stable_id": False, "transcript": None, "candidates": cand}
        out[gid] = rec
    write_gz_json(OUT, out)

    rel38, rel37 = c38.get("/info/software"), c37.get("/info/software")
    ass38, ass37 = c38.get("/info/assembly/homo_sapiens"), c37.get("/info/assembly/homo_sapiens")
    write_json(META, {
        "grch38": {"host": ENSEMBL38, "software_release": rel38.get("release"), "assembly": ass38.get("assembly_name"),
                   "genebuild_last_update": ass38.get("genebuild_last_geneset_update")},
        "grch37": {"host": ENSEMBL37, "software_release": rel37.get("release"), "assembly": ass37.get("assembly_name"),
                   "genebuild_last_update": ass37.get("genebuild_last_geneset_update")},
        "receptors": len(out), "with_transcript": sum(1 for v in out.values() if "grch38" in v),
        "requests": {"grch38": c38.requests, "grch37": c37.requests},
        "failures": c38.failures + c37.failures,
    })
    print("done", len(out))


if __name__ == "__main__":
    main()
