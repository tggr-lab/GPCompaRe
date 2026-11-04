#!/usr/bin/env python3
"""Step 6c (offline): protein-to-model alignment and NM_ version relations.

Reads transcripts_all/{ensembl,refseq}_{grch38,grch37}.json.gz, ncbi_cds.json.gz, nm_harvest.json.gz and the model (pack)
sequence of every receptor (public/pack/<gid>.json). Writes
  transcripts_all/protein_model_map.json.gz   gid -> {key: alignment}   key = "<assembly>:<ENST.v>" | "<assembly>:<NM_.v>" |
                                              "ncbi:<NM_.v>" (any harvested version, protein from NCBI)
        alignment = {"len_tx","len_model","kind","offset"|"blocks","matched","identity_model","identity_tx","flag"}
        kind: identical | variant (same length, <= 5 residue differences) | offset (tx == model shifted by `offset`:
              model_pos = tx_pos + offset, overlap >= 95% of the shorter) | isoform (compact block list [[tx_start,
              model_start,length],...], 1-based) ; flag = "isoform" when kind == isoform,
              "offset_length" when kind == offset but the lengths differ by more than 5 (other start codon / truncation:
              mchr1, npff2, oxer1, hrh2, gpr17 ...), else null
  transcripts_all/nm_versions.json.gz         gid -> {NM_.v: {sources, np, available, relation, equals, protein_equals,
                                              resolve_to}}
        relation: current (same accession.version is on a host's RefSeq import) | cds_identical (CDS nucleotides equal a
        current transcript) | protein_identical (same protein, different CDS) | cds_shifted (one CDS is the other with extra
        5' bases) | different | unavailable. resolve_to = key of the current transcript whose coordinates apply.
Run: python3 build_transcript_map.py
"""
import difflib
from collections import defaultdict

import json

from common import HERE, PACK, load_gz_json, receptors, write_gz_json

OUT = HERE / "transcripts_all"


def align(tx, model):
    lt, lm = len(tx), len(model)
    res = {"len_tx": lt, "len_model": lm}
    if tx == model:
        res.update(kind="identical", matched=lt, identity_model=1.0, identity_tx=1.0, flag=None)
        return res
    if lt == lm:
        d = sum(1 for a, b in zip(tx, model) if a != b)
        if d <= 5:
            res.update(kind="variant", differences=d, matched=lt - d, identity_model=round((lt - d) / lm, 4),
                       identity_tx=round((lt - d) / lt, 4), flag=None)
            return res
    # pure offset: model_pos = tx_pos + off
    sm = difflib.SequenceMatcher(None, tx, model, autojunk=False)
    blocks = [b for b in sm.get_matching_blocks() if b.size]
    matched = sum(b.size for b in blocks)
    if blocks:
        off = blocks[0].b - blocks[0].a
        if all(b.b - b.a == off for b in blocks) and matched >= 0.95 * min(lt, lm) and matched >= min(lt, lm) - 5:
            res.update(kind="offset", offset=off, matched=matched, identity_model=round(matched / lm, 4),
                       identity_tx=round(matched / lt, 4), flag="offset_length" if abs(lt - lm) > 5 else None)
            return res
    res.update(kind="isoform", blocks=[[b.a + 1, b.b + 1, b.size] for b in blocks], matched=matched,
               identity_model=round(matched / lm, 4), identity_tx=round(matched / lt, 4), flag="isoform")
    return res


def main():
    recs = {r["gid"]: r for r in receptors()}
    ens = {t: load_gz_json(OUT / f"ensembl_{t}.json.gz") for t in ("grch38", "grch37")}
    rsq = {t: load_gz_json(OUT / f"refseq_{t}.json.gz") for t in ("grch38", "grch37")}
    ncbi = load_gz_json(OUT / "ncbi_cds.json.gz")
    harvest = load_gz_json(OUT / "nm_harvest.json.gz")
    pmap, nmv = {}, {}
    stats = defaultdict(int)
    for gid, r in recs.items():
        model = json.load(open(PACK / f"{gid}.json"))["sequence"]     # model/pack sequence
        m = pmap[gid] = {}
        cur = {}     # key -> (cds_seq, protein)
        for tag in ("grch38", "grch37"):
            for t in ens[tag].get(gid, []):
                if t.get("protein"):
                    key = f"{tag}:{t['id']}.{t['version']}"
                    m[key] = align(t["protein"], model)
                    cur[key] = (t.get("cds_seq"), t["protein"])
            for t in rsq[tag].get(gid, []):
                n = ncbi.get(t["accession"])
                if n:
                    key = f"{tag}:{t['accession']}"
                    m[key] = align(n["protein"], model)
                    cur[key] = (n["cds_seq"], n["protein"])
        for acc in harvest.get(gid, {}):
            n = ncbi.get(acc)
            if n:
                m[f"ncbi:{acc}"] = align(n["protein"], model)
        for v in m.values():
            stats["alignments"] += 1
            stats["flag_" + str(v["kind"])] += 1
        d = nmv[gid] = {}
        for acc, srcs in harvest.get(gid, {}).items():
            n = ncbi.get(acc)
            e = {"sources": srcs, "np": n["np"] if n else None, "available": bool(n), "equals": [], "protein_equals": [],
                 "resolve_to": None}
            on_host = [f"{t}:{acc}" for t in ("grch38", "grch37") if any(x["accession"] == acc for x in rsq[t].get(gid, []))]
            if not n:
                e["relation"] = "unavailable"
            else:
                for k, (cds, prot) in cur.items():
                    if cds and cds == n["cds_seq"]:
                        e["equals"].append(k)
                    elif prot == n["protein"]:
                        e["protein_equals"].append(k)
                shifted = [k for k, (cds, _) in cur.items() if cds and cds != n["cds_seq"] and
                           (cds.endswith(n["cds_seq"]) or n["cds_seq"].endswith(cds))]
                if on_host:
                    e["relation"], e["resolve_to"] = "current", on_host[0]
                elif e["equals"]:
                    e["relation"] = "cds_identical"
                    e["resolve_to"] = next((k for k in e["equals"] if "NM_" in k), e["equals"][0])
                elif e["protein_equals"]:
                    e["relation"] = "protein_identical"
                elif shifted:
                    e["relation"] = "cds_shifted"
                    e["shifted_vs"] = shifted
                else:
                    e["relation"] = "different"
            stats["nm_" + e["relation"]] += 1
            d[acc] = e
    write_gz_json(OUT / "protein_model_map.json.gz", pmap)
    write_gz_json(OUT / "nm_versions.json.gz", nmv)
    print(dict(stats))


if __name__ == "__main__":
    main()
