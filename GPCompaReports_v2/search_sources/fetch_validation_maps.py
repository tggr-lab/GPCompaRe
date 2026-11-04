#!/usr/bin/env python3
"""Step 6d: independent Ensembl checks of the transcripts_all coordinates (<= 120 requests) -> transcripts_all/validation_maps.json

  * /map/cds/<ENST>/1..N on GRCh38 and GRCh37 for 10 random MANE + 20 random non-MANE transcripts (seed 20261104): the
    genomic blocks must equal our CDS segments (validate.py compares).
  * VEP hgvs (GET /vep/human/hgvs/<NM_>:c.<pos><ref>><alt>) for the PAR2 example NM_005242.6:c.477G>A and 12 random RefSeq
    transcripts on GRCh38: the reported genomic start/chromosome must equal our c.->g. result. VEP cannot always resolve a
    non-MANE NM_; those are recorded as `no_answer`, not as failures.
Run after fetch_transcripts_all.py and fetch_ncbi_cds.py.
"""
import random
from concurrent.futures import ThreadPoolExecutor

from common import ENSEMBL37, ENSEMBL38, HERE, Client, load_gz_json, write_json

OUT = HERE / "transcripts_all"


def main():
    rnd = random.Random(20261104)
    e38 = load_gz_json(OUT / "ensembl_grch38.json.gz")
    e37 = load_gz_json(OUT / "ensembl_grch37.json.gz")
    r38 = load_gz_json(OUT / "refseq_grch38.json.gz")
    ncbi = load_gz_json(OUT / "ncbi_cds.json.gz")
    mane = [(g, t["id"]) for g, l in e38.items() for t in l if t["mane_select"]]
    non = [(g, t["id"]) for g, l in e38.items() for t in l if not t["mane_select"]]
    pick = rnd.sample(sorted(mane), 10) + rnd.sample(sorted(non), 20)
    ids37 = {t["id"] for l in e37.values() for t in l}
    c38, c37 = Client(ENSEMBL38, rate=6), Client(ENSEMBL37, rate=6)
    cds_len = {t["id"]: len(t["cds_seq"]) for l in e38.values() for t in l}
    cds_len37 = {t["id"]: len(t["cds_seq"]) for l in e37.values() for t in l}

    def maps(item):
        gid, enst = item
        out = {"gid": gid, "enst": enst, "mane": item in mane}
        for tag, c, ln, ok in (("grch38", c38, cds_len, True), ("grch37", c37, cds_len37, enst in ids37)):
            if ok:
                m = c.get(f"/map/cds/{enst}/1..{ln[enst]}")["mappings"]
                out[tag] = sorted((x["start"], x["end"]) for x in m if x.get("gap", 0) == 0)
        return out
    with ThreadPoolExecutor(max_workers=6) as ex:
        cds_maps = list(ex.map(maps, pick))

    # VEP on GRCh38: PAR2 NM_005242.6:c.477G>A plus random NMs
    nms = [(g, t["accession"]) for g, l in r38.items() for t in l if t["accession"] in ncbi and t["accession"].startswith("NM_")]
    vep_items = [("par2_human", "NM_005242.6", 477)] + [
        (g, a, rnd.randint(1, len(ncbi[a]["cds_seq"]))) for g, a in rnd.sample(sorted(nms), 12)]
    comp = str.maketrans("ACGT", "TGCA")

    def vep(item):
        gid, acc, pos = item
        ref = ncbi[acc]["cds_seq"][pos - 1]
        alt = "A" if ref != "A" else "C"
        q = f"{acc}:c.{pos}{ref}>{alt}"
        try:
            j = c38.get(f"/vep/human/hgvs/{q}?content-type=application/json")
            x = j[0]
            return {"gid": gid, "query": q, "chrom": x["seq_region_name"], "start": x["start"], "end": x["end"],
                    "allele_string": x["allele_string"], "strand": x.get("strand")}
        except Exception as e:
            return {"gid": gid, "query": q, "no_answer": str(e)[:120]}
    with ThreadPoolExecutor(max_workers=4) as ex:
        vep_res = list(ex.map(vep, vep_items))
    write_json(OUT / "validation_maps.json", {"cds_maps": cds_maps, "vep_grch38": vep_res,
                                                "requests": {"grch38": c38.requests, "grch37": c37.requests},
                                                "failures": c38.failures + c37.failures})
    print("requests", c38.requests + c37.requests)


if __name__ == "__main__":
    main()
