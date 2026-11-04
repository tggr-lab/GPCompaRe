#!/usr/bin/env python3
"""Step 6c (offline): transcript-to-model residue maps from SHARED GENOMIC CODONS, and NM_ version relations.

A transcript residue maps to a model (pack) residue only when its codon occupies exactly the same three genomic
positions as the model residue's codon, on the same assembly. Sequence alignment is not used: a protein alignment
pairs chance matches inside divergent exons (2026-11-04 review: 1,385 allele x transcript disagreements on 144
transcripts, incl. the MANE transcripts of GPR142 and CCR2).

The model's own codons:
  GRCh38  the gnomAD transcript of the pack (provenance.gnomad.transcript, current Ensembl coordinates from
          ensembl_cds/transcripts.json.gz), in gnomAD's c. frame (gnomad_numbering.c_offset: lpar2 +9 nt,
          oxer1 +117 nt), shifted by the pack's model offset (model = gnomAD residue + d: lpar2 -3, mchr1 +69,
          npff2 +102, else 0; read from the pack alleles, which must agree on one d). Every pack allele must
          lie inside the codon of its own model residue (checked, hard error otherwise).
          Plus any GRCh38 transcript whose protein equals the model, for residues not yet placed.
  GRCh37  the GRCh38 codons lifted base by base through grch37/segment_maps.json.gz (Ensembl assembly map,
          exact blocks), plus any GRCh37 transcript whose protein equals the model (mchr1 .4 and npff2 .6 encode
          the 422- and 522-aa models; their extra N-terminal residues have no GRCh38 counterpart here).
  PAR1 copies on chrY (GRCh38 coordinates equal chrX) are keyed as chrX.

Reads transcripts_all/{ensembl,refseq}_{grch38,grch37}.json.gz, ncbi_cds.json.gz, nm_harvest.json.gz,
ensembl_cds/transcripts.json.gz, grch37/segment_maps.json.gz and the packs (public/pack/<gid>.json). Writes
  transcripts_all/protein_model_map.json.gz   gid -> {key: map}   key = "<assembly>:<ENST.v>" | "<assembly>:<NM_.v>" |
                                              "ncbi:<NM_.v>" (any harvested version) | "gnomad_frame" (the pack's own
                                              gnomAD c. frame on GRCh38)
        map = {"len_tx", "len_model", "kind", "offset" | "blocks", "matched", "identity_model", "identity_tx",
               "aa_differences", "flag", "method"}
        kind: identical (every transcript residue and every model residue paired, model = tx) | blocks (exact block
              list [[tx_start, model_start, length], ...], 1-based; residues outside the blocks have no shared codon) |
              none (no shared codon)
        flag: "partial" for kind blocks, "none" for kind none, else null
        method: "genomic_codon" | "via:<key>" (a harvested NM_ version read through a current transcript: identical
                CDS or protein, or a CDS that is the other with extra 5' codons) | "not_mapped" (different CDS)
  transcripts_all/nm_versions.json.gz         gid -> {NM_.v: {sources, np, available, relation, equals, protein_equals,
                                              resolve_to}}
        relation: current (same accession.version is on a host's RefSeq import) | cds_identical (CDS nucleotides equal a
        current transcript) | protein_identical (same protein, different CDS) | cds_shifted (one CDS is the other with extra
        5' bases) | different | unavailable. resolve_to = key of the current transcript whose coordinates apply.
  transcripts_all/model_codons.json.gz        gid -> {"GRCh38": {chrom, segs: [[gLo, gHi, cStart, cEnd, strand], ...]},
                                              "GRCh37": {...}, "offset": d, "cOffset": n, "gnomadTx": "ENST.v"}
        segs place the model as a virtual transcript: model residue m is c. 3m-2..3m (runs of consecutive bases;
        a residue without a codon on that assembly is absent)
Run: python3 build_transcript_map.py
"""
import json
from collections import Counter, defaultdict

from common import HERE, PACK, load_gz_json, receptors, write_gz_json

OUT = HERE / "transcripts_all"

_B = "TCAG"
_AAS = "FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG"
CODON = {a + b + c: _AAS[i * 16 + j * 4 + k] for i, a in enumerate(_B) for j, b in enumerate(_B) for k, c in enumerate(_B)}
COMP = str.maketrans("ACGTN", "TGCAN")


def translate(s):
    return "".join(CODON.get(s[i:i + 3], "X") for i in range(0, len(s) - 2, 3))


def chrom_key(chrom, par_copy=None):
    c = str(chrom).replace("chr", "")
    return "X" if c == "Y" and par_copy == "Y" else c


def c_to_g(segs, strand, c):
    for a, b, cf, ct in segs:
        if cf <= c <= ct:
            return a + (c - cf) if strand == 1 else b - (c - cf)
    return None


def codons_of(segs, strand, n_res):
    """Genomic positions of the codon of every residue 1..n_res (None when a base is not on the genome)."""
    out = []
    for p in range(1, n_res + 1):
        g = [c_to_g(segs, strand, 3 * p - 2 + k) for k in range(3)]
        out.append(None if None in g else tuple(g))
    return out


def lift_base(blocks, g):
    for b in blocks:
        if b["o_start"] <= g <= b["o_end"]:
            m = b["m_start"] + (g - b["o_start"]) if b["m_strand"] == 1 else b["m_end"] - (g - b["o_start"])
            return str(b["m_chrom"]), m
    return None


def model_codons(gid, pack, ens_cds, ens, seg_maps, stats, ens_all=None):
    """Model residue -> genomic codon on GRCh38 and GRCh37: {asm: {chrom, codons: [tuple | None]}} (index 0 = residue 1)."""
    model = pack["sequence"]
    L = len(model)
    prov = pack["provenance"].get("gnomad") or {}
    e = ens_cds.get(gid) or {}
    out = {"GRCh38": {"chrom": None, "codons": [None] * L}, "GRCh37": {"chrom": None, "codons": [None] * L},
           "offset": None, "cOffset": 0, "gnomadTx": None}
    pt = e.get("grch38") or {}
    if prov.get("transcript") and pt.get("cds_segments"):
        offs = Counter(v[0] - (v[12] if v[12] is not None else v[0]) for v in pack.get("variants") or [])
        if len(offs) > 1:
            raise SystemExit(f"{gid}: pack alleles disagree on the model offset: {dict(offs)}")
        d = next(iter(offs)) if offs else 0
        gn = e.get("gnomad_numbering")
        n = int(gn["c_offset"]) if gn else 0
        segs = sorted([list(s) for s in pt["cds_segments"]], key=lambda s: s[2])
        strand = pt["strand"]
        if n:   # gnomAD's frame: n contiguous bases upstream of today's CDS start
            f = segs[0]
            ext = [f[0] - n, f[0] - 1, 1, n] if strand == 1 else [f[1] + 1, f[1] + n, 1, n]
            segs = [ext] + [[s[0], s[1], s[2] + n, s[3] + n] for s in segs]
        cds = (gn["cds_seq"] if gn else e.get("cds_seq") or "").upper()
        n_tx = (segs[-1][3]) // 3
        cods = codons_of(segs, strand, n_tx)
        chrom = chrom_key(pt["chrom"])
        out["GRCh38"]["chrom"] = chrom
        out.update(offset=d, cOffset=n, gnomadTx=f"{prov['transcript']}.{prov.get('transcriptVersion')}")
        for t in range(1, n_tx + 1):
            m = t + d
            if 1 <= m <= L and cods[t - 1]:
                out["GRCh38"]["codons"][m - 1] = cods[t - 1]
                aa = CODON.get(cds[3 * t - 3:3 * t], "X") if cds else None
                if aa is not None and aa != model[m - 1]:
                    stats["model_codon_aa_differs"] += 1   # the 17 model/transcript conflict residues
        # every pack allele sits in the codon of its own model residue
        for v in pack.get("variants") or []:
            ch, gp, *_ = v[11].split("-")
            cod = out["GRCh38"]["codons"][v[0] - 1]
            if not cod or int(gp) not in cod or chrom_key(ch) != chrom:
                raise SystemExit(f"{gid}: allele {v[11]} (model {v[0]}) is not in its model codon {cod}")
            stats["pack_alleles_in_model_codon"] += 1
    # model-identical transcripts fill residues not placed yet (and must agree where placed)
    for asm, key in (("GRCh38", "grch38"), ("GRCh37", "grch37")):
        for t in ens[key].get(gid, []):
            if t.get("protein") != model or not t.get("cds_segments"):
                continue
            chrom = chrom_key(t["chrom"], t.get("par_copy"))
            mc = out[asm]
            if mc["chrom"] not in (None, chrom):
                continue
            segs = sorted([list(s) for s in t["cds_segments"]], key=lambda s: s[2])
            for m, cod in enumerate(codons_of(segs, t["strand"], L), start=1):
                if cod is None:
                    continue
                if mc["codons"][m - 1] is None:
                    if asm == "GRCh38":
                        stats["model_codons_from_identical_tx_grch38"] += 1
                    mc["codons"][m - 1] = cod
                    mc["chrom"] = chrom
                elif mc["codons"][m - 1] != cod and asm == "GRCh38":
                    stats["identical_tx_codon_conflicts"] += 1
        if asm == "GRCh38":
            # lift the GRCh38 codons to GRCh37 (exact Ensembl assembly-map blocks)
            sm = seg_maps.get(gid)
            blocks = [b for s in (sm or {}).get("segments", []) for b in s["blocks"]]
            m37 = out["GRCh37"]
            for m, cod in enumerate(out["GRCh38"]["codons"], start=1):
                if not cod:
                    continue
                lifted = [lift_base(blocks, g) for g in cod]
                if None in lifted or len({c for c, _ in lifted}) != 1:
                    continue
                m37["codons"][m - 1] = tuple(p for _, p in lifted)
                m37["chrom"] = lifted[0][0]
    # model residues placed on GRCh37 only (mchr1 1-69, npff2 1-102: GRCh37 transcripts encode the model there):
    # lift those codons to GRCh38 through exon pairs of same-id transcripts with equal exon lengths
    miss = [m for m in range(1, L + 1) if out["GRCh38"]["codons"][m - 1] is None and out["GRCh37"]["codons"][m - 1]]
    if miss:
        pairs = exon_pairs(gid, ens_all)
        c38 = out["GRCh38"]["chrom"]
        for m in miss:
            lifted = [lift_37to38(pairs, out["GRCh37"]["chrom"], g) for g in out["GRCh37"]["codons"][m - 1]]
            if None in lifted or len({c for c, _ in lifted}) != 1 or (c38 and lifted[0][0] != c38):
                continue
            out["GRCh38"]["codons"][m - 1] = tuple(p for _, p in lifted)
            out["GRCh38"]["chrom"] = lifted[0][0]
            stats["model_codons_lifted_37_to_38"] += 1
    return out


def exon_pairs(gid, ens_all):
    """GRCh37 -> GRCh38 exon blocks [lo37, hi37, lo38, hi38, strand, chrom38] from transcripts with the same id on
    both assemblies and the same exon lengths (Ensembl and RefSeq)."""
    out = []
    for kind, idk in (("ensembl", "id"), ("refseq", "accession")):
        a38 = {t[idk].split(".")[0]: t for t in ens_all[kind]["grch38"].get(gid, [])}
        for t37 in ens_all[kind]["grch37"].get(gid, []):
            t38 = a38.get(t37[idk].split(".")[0])
            if not t38:
                continue
            e38 = sorted(map(tuple, t38["exons"]), reverse=t38["strand"] == -1)
            e37 = sorted(map(tuple, t37["exons"]), reverse=t37["strand"] == -1)
            if len(e38) != len(e37) or any(b - a != d - c for (a, b), (c, d) in zip(e38, e37)):
                continue
            st = 1 if t38["strand"] == t37["strand"] else -1
            for (a, b), (c, d) in zip(e38, e37):
                out.append([c, d, a, b, st, chrom_key(t38["chrom"], t38.get("par_copy"))])
    return out


def lift_37to38(pairs, chrom37, g):
    hits = set()
    for lo, hi, lo38, hi38, st, ch in pairs:
        if lo <= g <= hi:
            hits.add((ch, lo38 + (g - lo) if st == 1 else hi38 - (g - lo)))
    return hits.pop() if len(hits) == 1 else None


def codon_segs(codons):
    """Codon list -> runs [gLo, gHi, cStart, cEnd, strand] of consecutive bases (model c. = 3m-2..3m)."""
    runs = []   # [c_start, c_end, g_start, g_end, dir]
    for m, cod in enumerate(codons, start=1):
        for k, g in enumerate(cod or ()):
            c = 3 * m - 2 + k
            r = runs[-1] if runs else None
            if r and c == r[1] + 1 and (r[4] == 0 and abs(g - r[3]) == 1 or r[4] and g == r[3] + r[4]):
                r[4] = r[4] or g - r[3]
                r[1], r[3] = c, g
            else:
                runs.append([c, c, g, g, 0])
    return [[min(r[2], r[3]), max(r[2], r[3]), r[0], r[1], r[4] or 1] for r in runs]


def map_by_codons(mc, chrom, cods, n_tx, n_model):
    """Transcript residue -> model residue through shared codons; returns the map dict."""
    index = {} if mc["chrom"] != chrom else {c: m for m, c in enumerate(mc["codons"], start=1) if c}
    pairs = [(p, index.get(c)) for p, c in enumerate(cods, start=1) if c and index.get(c)]
    return compress(pairs, n_tx, n_model, "genomic_codon")


def compress(pairs, n_tx, n_model, method):
    res = {"len_tx": n_tx, "len_model": n_model, "matched": len(pairs), "method": method,
           "identity_model": round(len(pairs) / n_model, 4) if n_model else 0.0,
           "identity_tx": round(len(pairs) / n_tx, 4) if n_tx else 0.0}
    if not pairs:
        res.update(kind="none", blocks=[], flag="none")
        return res
    blocks = []
    for p, m in pairs:
        if blocks and p == blocks[-1][0] + blocks[-1][2] and m == blocks[-1][1] + blocks[-1][2]:
            blocks[-1][2] += 1
        else:
            blocks.append([p, m, 1])
    if len(blocks) == 1 and blocks[0][0] == 1 and blocks[0][1] == 1 and blocks[0][2] == n_tx == n_model:
        res.update(kind="identical", flag=None)   # a bijection; any other relation is an exact block list
    else:
        res.update(kind="blocks", blocks=blocks, flag="partial")
    return res


def expand(a, n_tx):
    """Map dict -> [(tx_pos, model_pos)]."""
    if a["kind"] == "identical":
        return [(p, p) for p in range(1, n_tx + 1)]
    return [(ts + k, ms + k) for ts, ms, n in a.get("blocks", []) for k in range(n)]


def protein_len(prot):
    return len(prot.rstrip("*"))


def main():
    recs = {r["gid"]: r for r in receptors()}
    ens = {t: load_gz_json(OUT / f"ensembl_{t}.json.gz") for t in ("grch38", "grch37")}
    rsq = {t: load_gz_json(OUT / f"refseq_{t}.json.gz") for t in ("grch38", "grch37")}
    ncbi = load_gz_json(OUT / "ncbi_cds.json.gz")
    harvest = load_gz_json(OUT / "nm_harvest.json.gz")
    ens_cds = load_gz_json(HERE / "ensembl_cds" / "transcripts.json.gz")
    seg_maps = load_gz_json(HERE / "grch37" / "segment_maps.json.gz")
    pmap, nmv, mcod = {}, {}, {}
    stats = Counter()
    for gid, r in recs.items():
        pack = json.load(open(PACK / f"{gid}.json"))
        model = pack["sequence"]
        nm_ = len(model)
        mc = model_codons(gid, pack, ens_cds, ens, seg_maps, stats, {"ensembl": ens, "refseq": rsq})
        mcod[gid] = {asm: {"chrom": mc[asm]["chrom"], "segs": codon_segs(mc[asm]["codons"])} for asm in ("GRCh38", "GRCh37")}
        mcod[gid].update(offset=mc["offset"], cOffset=mc["cOffset"], gnomadTx=mc["gnomadTx"])
        stats["model_residues"] += nm_
        stats["model_residues_with_grch38_codon"] += sum(1 for c in mc["GRCh38"]["codons"] if c)
        stats["model_residues_with_grch37_codon"] += sum(1 for c in mc["GRCh37"]["codons"] if c)
        m = pmap[gid] = {}
        cur = {}     # key -> (cds_seq, protein)
        for tag, asm in (("grch38", "GRCh38"), ("grch37", "GRCh37")):
            for t in ens[tag].get(gid, []):
                if not (t.get("protein") and t.get("cds_segments")):
                    continue
                key = f"{tag}:{t['id']}.{t['version']}"
                segs = sorted([list(s) for s in t["cds_segments"]], key=lambda s: s[2])
                n_tx = protein_len(t["protein"])
                cods = codons_of(segs, t["strand"], n_tx)
                m[key] = a = map_by_codons(mc[asm], chrom_key(t["chrom"], t.get("par_copy")), cods, n_tx, nm_)
                a["aa_differences"] = sum(1 for p, q in expand(a, n_tx) if t["protein"][p - 1] != model[q - 1])
                cur[key] = (t.get("cds_seq"), t["protein"])
            for t in rsq[tag].get(gid, []):
                n = ncbi.get(t["accession"])
                if not n or not t.get("cds_segments"):
                    continue
                key = f"{tag}:{t['accession']}"
                segs = sorted([list(s) for s in t["cds_segments"]], key=lambda s: s[2])
                n_tx = protein_len(n["protein"])
                cods = codons_of(segs, t["strand"], n_tx)
                m[key] = a = map_by_codons(mc[asm], chrom_key(t["chrom"], t.get("par_copy")), cods, n_tx, nm_)
                a["aa_differences"] = sum(1 for p, q in expand(a, n_tx) if n["protein"][p - 1] != model[q - 1])
                cur[key] = (n["cds_seq"], n["protein"])
        # the pack's own gnomAD frame (lpar2: gnomAD residue t = model t - 3)
        if mc["offset"] is not None:
            n_frame = max((v[12] if v[12] is not None else v[0]) for v in pack.get("variants") or [[0] + [None] * 12])
            pt = (ens_cds.get(gid) or {}).get("grch38") or {}
            n_frame = max(n_frame, (int(pt.get("cds_length") or 0) + mc["cOffset"]) // 3 - 1)
            pairs = [(t, t + mc["offset"]) for t in range(1, n_frame + 1)
                     if 1 <= t + mc["offset"] <= nm_ and mc["GRCh38"]["codons"][t + mc["offset"] - 1]]
            m["gnomad_frame"] = compress(pairs, n_frame, nm_, "genomic_codon")
            m["gnomad_frame"]["aa_differences"] = None
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
            # the harvested version's own residues, read through a current transcript where that is exact
            if not n:
                continue
            n_tx = protein_len(n["protein"])
            via, shift = None, 0
            if e["relation"] == "current":
                via = e["resolve_to"]
            elif e["relation"] == "cds_identical":
                via = e["resolve_to"]
            elif e["relation"] == "protein_identical":
                via = next((k for k in sorted(e["protein_equals"], key=lambda k: (not k.startswith("grch38"), "NM_" not in k)) if k in m), None)
            elif e["relation"] == "cds_shifted":
                for k in sorted(e["shifted_vs"], key=lambda k: (not k.startswith("grch38"), "NM_" not in k)):
                    dl = len(cur[k][0]) - len(n["cds_seq"])
                    if dl % 3 == 0 and k in m:
                        via, shift = k, dl // 3
                        break
            if via and via in m:
                pairs = [(p - shift, q) for p, q in expand(m[via], m[via]["len_tx"]) if 1 <= p - shift <= n_tx]
                a = compress(pairs, n_tx, nm_, f"via:{via}" + (f"{shift:+d}" if shift else ""))
            else:
                a = compress([], n_tx, nm_, "not_mapped")
            a["aa_differences"] = sum(1 for p, q in expand(a, n_tx) if n["protein"][p - 1] != model[q - 1])
            m[f"ncbi:{acc}"] = a
        for k, v in m.items():
            stats["maps"] += 1
            stats["kind_" + v["kind"]] += 1
            if v["kind"] == "blocks":
                stats["blocks_lt5aa"] += sum(1 for b in v["blocks"] if b[2] < 5)
    write_gz_json(OUT / "protein_model_map.json.gz", pmap)
    write_gz_json(OUT / "nm_versions.json.gz", nmv)
    write_gz_json(OUT / "model_codons.json.gz", mcod)
    print(dict(sorted(stats.items())))


if __name__ == "__main__":
    main()
