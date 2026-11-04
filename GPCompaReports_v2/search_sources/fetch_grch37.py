#!/usr/bin/env python3
"""Step 4: GRCh37 coordinate for every cached gnomAD allele, via per-CDS-block GRCh38 -> GRCh37 mapping.

Needs ensembl_cds/transcripts.json.gz (run fetch_ensembl_cds.py first). Alleles = every missense allele in
pack/sources/gnomad/<gid>.json.gz (174,755; the Studio packs keep 145,345 of them, so this is a superset).
NOT one request per allele: each GRCh38 CDS segment is mapped once with
  /map/human/GRCh38/<chr>:<s>..<e>:1/GRCh37     (rest.ensembl.org)
and every allele inside the segment is shifted by the block offset. The GRCh38 and GRCh37 genomic sequence of each
block is also fetched (/sequence/region/human/...), so every allele gets ref37_ok (does the GRCh37 reference base
equal the gnomAD ref allele? if 0 the GRCh37 ID is shown with a warning flag).

Outputs
  grch37/segment_maps.json.gz     per receptor: segments, mapped blocks, bases that differ between assemblies
  grch37/alleles.tsv.gz           gid, variant_id_grch38, variant_id_grch37, method, ref37_ok
  grch37/verification.json        200 random alleles (seed 20261104) + PAR2 5:76833084 -> 5:76128909 checked by direct
                                  /map calls, forward and back (GRCh37 -> GRCh38)
Idempotent: segment maps and verification are reused when present. Run: python3 fetch_grch37.py
"""
import gzip
import random
from concurrent.futures import ThreadPoolExecutor

from common import (ENSEMBL38, HERE, SOURCES, Client, load_gz_json, receptors, write_gz_json, write_json)

T = HERE / "ensembl_cds" / "transcripts.json.gz"
SEGS = HERE / "grch37" / "segment_maps.json.gz"
ALLELES = HERE / "grch37" / "alleles.tsv.gz"
VERIF = HERE / "grch37" / "verification.json"
COMP = str.maketrans("ACGTacgt", "TGCAtgca")


PRIMARY = {str(i) for i in range(1, 23)} | {"X", "Y", "MT"}   # drop patch/alt scaffolds (e.g. HG1433_PATCH)


def map_region(c, chrom, s, e, src, dst):
    j = c.get(f"/map/human/{src}/{chrom}:{s}..{e}:1/{dst}")
    out = []
    for m in j["mappings"]:
        o, d = m["original"], m["mapped"]
        if d["seq_region_name"] not in PRIMARY:
            continue
        out.append({"o_start": o["start"], "o_end": o["end"], "m_chrom": d["seq_region_name"],
                    "m_start": d["start"], "m_end": d["end"], "m_strand": d["strand"]})
    return out


def region_seqs(c, regions, assembly):
    """POST /sequence/region/human in batches of 50 (list of 'chr:s..e:1' strings) -> list of upper-case sequences."""
    q = "/sequence/region/human" + ("?coord_system_version=GRCh37" if assembly == "GRCh37" else "")
    out = []
    for k in range(0, len(regions), 50):
        res = c.post(q, {"regions": regions[k:k + 50]})
        assert len(res) == len(regions[k:k + 50])
        out += [x["seq"].upper() for x in res]
    return out


def build_segment_maps(c, trans, existing):
    out = existing
    todo = [g for g, r in trans.items() if "grch38" in r and g not in out]
    if not todo:
        return out
    flat = [(g, i, trans[g]["grch38"]["chrom"], a, b)
            for g in todo for i, (a, b, _cf, _ct) in enumerate(trans[g]["grch38"]["cds_segments"])]
    with ThreadPoolExecutor(max_workers=6) as ex:
        blocks = list(ex.map(lambda f: map_region(c, f[2], f[3], f[4], "GRCh38", "GRCh37"), flat))
    print("mapped", len(flat), "segments", flush=True)
    seq38 = region_seqs(c, [f"{f[2]}:{f[3]}..{f[4]}:1" for f in flat], "GRCh38")
    b37 = [(k, bl) for k, bls in enumerate(blocks) for bl in bls]
    seq37 = region_seqs(c, [f"{bl['m_chrom']}:{bl['m_start']}..{bl['m_end']}:1" for _, bl in b37], "GRCh37")
    s37 = {(k, bl["o_start"]): sq for (k, bl), sq in zip(b37, seq37)}
    for k, (g, i, chrom, a, b) in enumerate(flat):
        diffs = []
        for bl in blocks[k]:
            sq37 = s37[(k, bl["o_start"])]
            if bl["m_strand"] != 1:       # block inverted between assemblies: compare with the reverse complement
                sq37 = sq37[::-1].translate(COMP)
            off = bl["o_start"] - a
            ref38 = seq38[k][off:off + len(sq37)]
            if len(ref38) != len(sq37):
                diffs.append("length-differs")
                continue
            diffs += [bl["o_start"] + n for n, (x, y) in enumerate(zip(ref38, sq37)) if x != y]
        seg = {"start": a, "end": b, "blocks": blocks[k], "diff_positions": diffs,
               "fully_mapped": sum(x["o_end"] - x["o_start"] + 1 for x in blocks[k]) == b - a + 1}
        out.setdefault(g, {"chrom": chrom, "strand": trans[g]["grch38"]["strand"], "segments": []})["segments"].append(seg)
    write_gz_json(SEGS, out)
    return out


def lift_alleles(trans, maps):
    rows, stats = [], {}
    for gid in maps:
        gp = SOURCES / "gnomad" / f"{gid}.json.gz"
        if not gp.exists():
            continue
        segs = maps[gid]["segments"]
        n = unmapped = refbad = 0
        for v in load_gz_json(gp)["variants"]:
            n += 1
            vid = v["variant_id"]
            chrom, pos, ref, alt = vid.split("-")
            pos = int(pos)
            v37, method, ok = "", "unmapped", ""
            for sg in segs:
                if sg["start"] <= pos <= sg["end"]:
                    for bl in sg["blocks"]:
                        if bl["o_start"] <= pos <= bl["o_end"]:
                            if bl["m_strand"] == 1:
                                p37 = bl["m_start"] + (pos - bl["o_start"])
                                v37 = f"{bl['m_chrom']}-{p37}-{ref}-{alt}"
                                method = "cds_block_map"
                            else:     # inverted block: mirrored position, complemented alleles
                                p37 = bl["m_end"] - (pos - bl["o_start"])
                                v37 = f"{bl['m_chrom']}-{p37}-{ref.translate(COMP)}-{alt.translate(COMP)}"
                                method = "cds_block_map_inverted"
                            ok = 0 if pos in sg["diff_positions"] else 1
                            break
                    break
            if method == "unmapped":
                unmapped += 1
            elif not ok:
                refbad += 1
            rows.append((gid, vid, v37, method, ok))
        stats[gid] = {"alleles": n, "unmapped": unmapped, "ref_differs_in_grch37": refbad}
    return rows, stats


DIRECT = HERE / "grch37" / "direct_maps.json"


def direct_fallback(c, rows):
    """Alleles outside the current CDS segments (lpar2/oxer1: older, longer N-terminus) get a direct per-position map."""
    import json
    cache = json.load(open(DIRECT)) if DIRECT.exists() else {}
    need = sorted({(r[1].split("-")[0], int(r[1].split("-")[1])) for r in rows if r[3] == "unmapped"})
    todo = [k for k in need if f"{k[0]}:{k[1]}" not in cache]

    def one(k):
        m = map_region(c, k[0], k[1], k[1], "GRCh38", "GRCh37")
        return f"{k[0]}:{k[1]}", ([m[0]["m_chrom"], m[0]["m_start"], m[0]["m_strand"]] if len(m) == 1 else None)

    with ThreadPoolExecutor(max_workers=6) as ex:
        cache.update(dict(ex.map(one, todo)))
    write_json(DIRECT, cache)
    out = []
    for r in rows:
        if r[3] == "unmapped":
            ch, pos, ref, alt = r[1].split("-")
            hit = cache.get(f"{ch}:{pos}")
            if hit:
                if hit[2] == 1:
                    r = (r[0], r[1], f"{hit[0]}-{hit[1]}-{ref}-{alt}", "direct_map", "")
                else:
                    r = (r[0], r[1], f"{hit[0]}-{hit[1]}-{ref.translate(COMP)}-{alt.translate(COMP)}", "direct_map_inverted", "")
        out.append(r)
    return out


def verify(c38, rows):
    if VERIF.exists():
        return
    rnd = random.Random(20261104)
    mapped = [r for r in rows if r[2]]
    sample = rnd.sample(mapped, 200)
    items = [("PAR2 anchor", "par2_human", "5-76833084-G-A", "5-76128909-G-A")] + \
            [("random", r[0], r[1], r[2]) for r in sample]

    def check(item):
        kind, gid, v38, v37 = item
        ch, pos, ref, alt = v38.split("-")
        fwd = map_region(c38, ch, int(pos), int(pos), "GRCh38", "GRCh37")
        got37 = None
        if len(fwd) == 1:
            f0 = fwd[0]
            if f0["m_strand"] == 1:
                got37 = f"{f0['m_chrom']}-{f0['m_start']}-{ref}-{alt}"
            else:
                got37 = f"{f0['m_chrom']}-{f0['m_start']}-{ref.translate(COMP)}-{alt.translate(COMP)}"
        back = None
        if got37:
            b = map_region(c38, got37.split("-")[0], int(got37.split("-")[1]), int(got37.split("-")[1]), "GRCh37", "GRCh38")
            if len(b) == 1:
                back = f"{b[0]['m_chrom']}-{b[0]['m_start']}"
        return {"kind": kind, "gid": gid, "grch38": v38, "expected_grch37": v37, "direct_grch37": got37,
                "forward_ok": got37 == v37, "back_grch38_pos": back, "roundtrip_ok": back == f"{ch}-{pos}"}

    with ThreadPoolExecutor(max_workers=6) as ex:
        out = list(ex.map(check, items))
    write_json(VERIF, {"date": __import__("datetime").date.today().isoformat(), "seed": 20261104,
                       "sample_size": len(sample), "results": out})


def main():
    trans = load_gz_json(T)
    c = Client(ENSEMBL38, rate=8)
    maps = load_gz_json(SEGS) if SEGS.exists() else {}
    maps = build_segment_maps(c, trans, maps)
    rows, stats = lift_alleles(trans, maps)
    rows = direct_fallback(c, rows)
    import collections
    cnt = collections.Counter((r[0], r[3]) for r in rows)
    for g in stats:
        stats[g]["unmapped"] = cnt[(g, "unmapped")]
        stats[g]["direct_map"] = cnt[(g, "direct_map")] + cnt[(g, "direct_map_inverted")]
        stats[g]["inverted"] = cnt[(g, "cds_block_map_inverted")] + cnt[(g, "direct_map_inverted")]
    ALLELES.parent.mkdir(parents=True, exist_ok=True)
    with gzip.GzipFile(ALLELES, "wb", mtime=0, compresslevel=9) as gz:
        gz.write(b"gid\tvariant_id_grch38\tvariant_id_grch37\tmethod\tref37_ok\n")
        for r in rows:
            gz.write(("\t".join(str(x) for x in r) + "\n").encode())
    write_json(HERE / "grch37" / "_meta.json", {
        "alleles": len(rows), "unmapped": sum(s["unmapped"] for s in stats.values()),
        "direct_map": sum(s["direct_map"] for s in stats.values()),
        "inverted": sum(s["inverted"] for s in stats.values()),
        "ref_differs_in_grch37": sum(s["ref_differs_in_grch37"] for s in stats.values()),
        "per_receptor": {g: s for g, s in stats.items() if s["unmapped"] or s["ref_differs_in_grch37"] or s["direct_map"] or s["inverted"]},
        "requests_segment_maps": c.requests})
    verify(c, rows)
    write_json(HERE / "grch37" / "_meta.json", {**__import__("json").load(open(HERE / "grch37" / "_meta.json")),
                                                 "requests_total": c.requests, "failures": c.failures})
    print(len(rows), "alleles", sum(s["unmapped"] for s in stats.values()), "unmapped")


if __name__ == "__main__":
    main()
