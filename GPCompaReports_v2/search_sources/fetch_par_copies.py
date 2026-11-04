#!/usr/bin/env python3
"""Step 6a': P2RY8 lives in the pseudo-autosomal region, so GRCh38 has an X gene (ENSG00000182162) and a Y copy
(ENSG00000292333). The pack/gnomAD alleles and the GRCh37 gene are on X, but the first fetch took the Y copy's gene window.
This script adds the X copy to transcripts_all/ensembl_grch38.json.gz and refseq_grch38.json.gz (tagging every P2RY8
transcript with `par_copy`: X or Y) and records both windows on the ensembl_cds record (gene_grch38 = X,
gene_grch38_par_y = Y). Run after fetch_transcripts_all.py: python3 fetch_par_copies.py
"""
from common import ENSEMBL38, HERE, Client, load_gz_json, write_gz_json
from fetch_ensembl_cds import tx_view
from fetch_transcripts_all import OUT, seq_post

GID, X_GENE = "p2ry8_human", "ENSG00000182162"


def main():
    c = Client(ENSEMBL38, rate=6)
    ens = load_gz_json(OUT / "ensembl_grch38.json.gz")
    if any(t.get("par_copy") == "X" for t in ens[GID]):
        print("already done")
        return
    g = c.post("/lookup/id", {"ids": [X_GENE], "expand": 1})[X_GENE]
    new = []
    for t in g["Transcript"]:
        if t.get("biotype") != "protein_coding" or not t.get("Translation"):
            continue
        v = tx_view(t)
        v["id"] = v.pop("transcript"); v["ensp"] = v.pop("translation"); v["ensp_version"] = v.pop("translation_version")
        v["is_canonical"] = bool(t.get("is_canonical")); v["source"] = t.get("source"); v["par_copy"] = "X"
        new.append(v)
    cds = seq_post(c, [t["id"] for t in new], "cds")
    prot = seq_post(c, [t["ensp"] for t in new], "protein")
    mane = {"ENST00000381297"}      # the pack's transcript (ClinVar maneEnsembl / HGNC MANE pair)
    for t in new:
        t["cds_seq"], t["protein"] = cds[t["id"]], prot[t["ensp"]]
        t["mane_select"] = t["id"] in mane
    for t in ens[GID]:
        t["par_copy"] = "Y"
        t["mane_select"] = False
    ens[GID] = new + ens[GID]
    write_gz_json(OUT / "ensembl_grch38.json.gz", ens)

    # RefSeq import for the X window
    rs = load_gz_json(OUT / "refseq_grch38.json.gz")
    win = {"chrom": "X", "start": g["start"], "end": g["end"]}
    j = c.get(f"/overlap/region/human/X:{win['start']}..{win['end']}?feature=transcript;feature=exon;feature=cds;db_type=otherfeatures")
    res = []
    for x in j:
        if x["feature_type"] == "transcript" and x.get("logic_name") == "refseq_import" and \
                (x.get("external_name") or "")[:3] in ("NM_", "XM_") and x.get("Parent") == "gene-P2RY8" and x["biotype"] == "protein_coding":
            tid = x["id"]
            seg = sorted(((f["start"], f["end"]) for f in j if f["feature_type"] == "cds" and f.get("Parent") == tid), reverse=(x["strand"] == -1))
            ex = sorted(((f["start"], f["end"]) for f in j if f["feature_type"] == "exon" and f.get("Parent") == tid), reverse=(x["strand"] == -1))
            pos, segs = 0, []
            for a, b in seg:
                segs.append([a, b, pos + 1, pos + b - a + 1]); pos += b - a + 1
            np_ = next((f["id"][4:] for f in j if f["feature_type"] == "cds" and f.get("Parent") == tid), None)
            res.append({"accession": x["external_name"], "np": np_, "chrom": "X", "strand": x["strand"], "tx_start": x["start"],
                        "tx_end": x["end"], "tags": x.get("tag", []), "biotype": x["biotype"], "exons": [list(e) for e in ex],
                        "cds_segments": segs, "cds_length": pos, "par_copy": "X"})
    rs[GID] = sorted(res, key=lambda r: r["accession"])
    write_gz_json(OUT / "refseq_grch38.json.gz", rs)

    # ensembl_cds record: both windows
    tr = load_gz_json(HERE / "ensembl_cds" / "transcripts.json.gz")
    r = tr[GID]
    if r["gene_grch38"]["chrom"] != "X":
        r["gene_grch38_par_y"] = r["gene_grch38"]
        r["gene_grch38"] = {"gene": X_GENE, "version": g.get("version"), "symbol": g.get("display_name"), "chrom": "X",
                            "start": g["start"], "end": g["end"], "strand": g["strand"], "biotype": g.get("biotype")}
        write_gz_json(HERE / "ensembl_cds" / "transcripts.json.gz", tr)
    print("P2RY8 X transcripts", len(new), "refseq", len(res), "requests", c.requests)


if __name__ == "__main__":
    main()
