#!/usr/bin/env python3
"""Step 1: HGNC records for the 283 receptor genes -> hgnc/hgnc_records.json.gz.

Method: per-symbol REST (https://rest.genenames.org/fetch/symbol/<SYM>), 283 small requests, chosen over the
~16 MB complete-set download because only 283 genes are needed. Falls back to a search on prev_symbol/alias_symbol
when the index gene symbol is no longer approved (the record then notes `matched_via`).
Idempotent: gids already in the output are skipped. Run: python3 fetch_hgnc.py
"""
import sys
import urllib.parse

from common import HERE, Client, load_gz_json, receptors, write_gz_json, write_json

OUT = HERE / "hgnc" / "hgnc_records.json.gz"
META = HERE / "hgnc" / "_meta.json"
FIELDS = ["symbol", "alias_symbol", "prev_symbol", "name", "alias_name", "prev_name", "hgnc_id", "entrez_id",
          "ensembl_gene_id", "uniprot_ids", "mane_select", "locus_type", "locus_group", "status", "location"]


def slim(doc):
    return {k: doc[k] for k in FIELDS if k in doc}


def main():
    c = Client("https://rest.genenames.org", rate=5)
    info = c.get("/info")
    out = load_gz_json(OUT) if OUT.exists() else {}
    for r in receptors():
        gid, sym = r["gid"], r["gene"]
        if gid in out:
            continue
        docs = c.get("/fetch/symbol/" + urllib.parse.quote(sym))["response"]["docs"]
        via = "symbol"
        if not docs:
            for field in ("prev_symbol", "alias_symbol"):
                docs = c.get(f"/search/{field}/" + urllib.parse.quote(sym))["response"]["docs"]
                if len(docs) == 1:
                    docs = c.get("/fetch/symbol/" + urllib.parse.quote(docs[0]["symbol"]))["response"]["docs"]
                    via = field
                    break
                docs = []
        if len(docs) != 1:
            print(f"WARN {gid} {sym}: {len(docs)} HGNC docs", file=sys.stderr)
            out[gid] = {"query_symbol": sym, "found": False}
            continue
        rec = slim(docs[0])
        rec.update({"query_symbol": sym, "found": True, "matched_via": via})
        out[gid] = rec
    write_gz_json(OUT, out)
    write_json(META, {
        "source": "HGNC REST (rest.genenames.org), per-symbol fetch",
        "hgnc_last_modified": info.get("lastModified"),
        "hgnc_num_docs": info.get("numDoc"),
        "licence": "CC0 1.0",
        "records": len(out),
        "not_found": sorted(g for g, v in out.items() if not v.get("found")),
        "requests": c.requests,
    })
    print(f"{len(out)} records, {sum(1 for v in out.values() if v.get('found'))} found, {c.requests} requests")


if __name__ == "__main__":
    main()
