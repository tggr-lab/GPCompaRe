#!/usr/bin/env python3
"""Step 5: offline validation of the caches -> validation_report.json (+ stdout summary). Exit 1 on hard failures.

(a) every cached gnomAD missense allele: hgvsc c. position through the CDS gives the hgvsp residue number, the
    reference amino acid and the alternate amino acid; the c. reference base equals the CDS base; the genomic position
    mapped through the CDS segments reproduces the c. position; the gnomAD ref/alt alleles equal the c. bases
    (complemented on the minus strand). Residue numbering is also compared with the Studio pack's own rows.
(b) GRCh37/GRCh38 round-trip on the stored 200-allele sample + the PAR2 anchor 5:76833084 -> 5:76128909, plus
    coverage of grch37/alleles.tsv.gz (unmapped, reference-base differences).
(c) all 283 gids present in hgnc/, uniprot, aliases, ensembl_cds (CDS or documented pseudogene); each has >= 1 alias source.
Special cases (transcript numbering differs from the gnomAD hgvsc numbering) are measured and reported, not corrected.
"""
import collections
import csv
import gzip
import json
import sys

from common import HERE, PACK, SOURCES, load_gz_json, receptors

CODON = {}
bases = "TCAG"
aas = "FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG"
for i, a in enumerate(aas):
    CODON[bases[i // 16] + bases[(i // 4) % 4] + bases[i % 4]] = a
# GRCh38 bases with no GRCh37 counterpart. ADRA2B: 9 bp (96115250-96115258) are absent from the GRCh37 reference, whose
# transcript is 447 aa vs 450 aa in GRCh38 (known in-frame Glu301-303 deletion polymorphism), so 7 alleles have no GRCh37 ID.
EXPECTED_UNMAPPED = {"ada2b_human": "9 bp absent from GRCh37 reference (in-frame deletion polymorphism region)",
                     "opsg_human": "OPN1MW exons 5-6 lie in the X-linked opsin gene array, which has no one-to-one GRCh37 primary mapping"}
T3 = {"Ala": "A", "Arg": "R", "Asn": "N", "Asp": "D", "Cys": "C", "Gln": "Q", "Glu": "E", "Gly": "G", "His": "H",
      "Ile": "I", "Leu": "L", "Lys": "K", "Met": "M", "Phe": "F", "Pro": "P", "Ser": "S", "Thr": "T", "Trp": "W",
      "Tyr": "Y", "Val": "V", "Ter": "*"}
COMP = str.maketrans("ACGT", "TGCA")

import re
HGVSC = re.compile(r"^c\.(\d+)([ACGT])>([ACGT])$")
HGVSP = re.compile(r"^p\.([A-Z][a-z]{2})(\d+)([A-Z][a-z]{2})$")


def translate(seq):
    return "".join(CODON.get(seq[i:i + 3], "X") for i in range(0, len(seq) - 2, 3))


def genomic_to_c(pos, segs, strand):
    for a, b, cf, ct in segs:
        if a <= pos <= b:
            return cf + (pos - a if strand == 1 else b - pos)
    return None


def translates_to(cds, protein):
    """True if the CDS translates to the stated protein. A stop codon that the annotation calls X is accepted as
    translational readthrough / recoding (OPRK1 and OPRL1 transcripts carry one) and counted separately."""
    tr, p = translate(cds).rstrip("*"), protein.rstrip("*")
    if tr == p:
        return True, False
    if len(tr) == len(p) and all(a == b or (a == "*" and b == "X") for a, b in zip(tr, p)):
        return True, True
    return False, False


def c_to_g(c, segs, strand):
    for a, b, cf, ct in segs:
        if cf <= c <= ct:
            return a + (c - cf) if strand == 1 else b - (c - cf)
    return None


def validate_transcripts_all(TA, hard):
    d = {}
    ncbi = load_gz_json(TA / "ncbi_cds.json.gz")
    ens = {t: load_gz_json(TA / f"ensembl_{t}.json.gz") for t in ("grch38", "grch37")}
    rsq = {t: load_gz_json(TA / f"refseq_{t}.json.gz") for t in ("grch38", "grch37")}
    pmap = load_gz_json(TA / "protein_model_map.json.gz")
    nmv = load_gz_json(TA / "nm_versions.json.gz")
    # (d1) CDS translates to the stated protein
    for tag in ens:
        n = bad = badlen = readthrough = 0
        examples = []
        for gid, lst in ens[tag].items():
            for t in lst:
                n += 1
                ok, rt = translates_to(t["cds_seq"], t["protein"])
                readthrough += rt
                if not ok:
                    bad += 1
                    examples.append(f"{gid}:{t['id']}")
                if len(t["cds_seq"]) != t["cds_length"]:
                    badlen += 1
        d[f"ensembl_{tag}"] = {"transcripts": n, "genes_with_transcripts": sum(1 for v in ens[tag].values() if v),
                               "cds_not_translating_to_protein": bad, "stop_codon_readthrough_X": readthrough,
                               "cds_length_mismatch_partial_cds": badlen, "examples": examples[:8]}
        if bad:
            hard.append(f"ensembl_{tag} translation")
    chk = {a: translates_to(v["cds_seq"], v["protein"]) for a, v in ncbi.items()}
    bad = [a for a, (ok, _) in chk.items() if not ok]
    d["ncbi"] = {"accessions": len(ncbi), "cds_not_translating_to_protein": len(bad),
                 "stop_codon_readthrough_X": sorted(a for a, (_, rt) in chk.items() if rt), "examples": bad[:8]}
    if bad:
        hard.append("ncbi translation")
    for tag in rsq:
        n = lenbad = nodata = 0
        for gid, lst in rsq[tag].items():
            for t in lst:
                n += 1
                v = ncbi.get(t["accession"])
                if not v:
                    nodata += 1
                elif len(v["cds_seq"]) != t["cds_length"]:
                    lenbad += 1
        d[f"refseq_{tag}"] = {"transcripts": n, "genes_with_transcripts": sum(1 for v in rsq[tag].values() if v),
                              "no_ncbi_record": nodata, "cds_length_differs_from_ncbi": lenbad}
    # RefSeq GRCh38: Ensembl otherfeatures import vs UCSC ncbiRefSeq (two independent sources of the same NCBI alignments)
    if (TA / "ucsc_refseq_grch38.json.gz").exists():
        u = load_gz_json(TA / "ucsc_refseq_grch38.json.gz")
        ag = dg = miss = 0
        for gid, lst in rsq["grch38"].items():
            uu = {t["accession"]: t for t in u.get(gid, [])}
            for t in lst:
                o = uu.get(t["accession"])
                if not o:
                    miss += 1
                elif [tuple(s[:2]) for s in o["cds_segments"]] == [tuple(s[:2]) for s in t["cds_segments"]] and o["strand"] == t["strand"]:
                    ag += 1
                else:
                    dg += 1
        d["refseq_grch38_ensembl_vs_ucsc"] = {"cds_segments_agree": ag, "disagree": dg, "not_in_ucsc": miss}
        if dg:
            hard.append("refseq ensembl vs ucsc")
    # protein-to-model flags
    kinds = collections.Counter(v["kind"] for g in pmap.values() for v in g.values())
    flags = collections.Counter(v["flag"] for g in pmap.values() for v in g.values() if v["flag"])
    d["protein_model_map"] = {"alignments": sum(kinds.values()), "by_kind": dict(kinds), "flags": dict(flags),
                              "mane_or_pack_transcript_flagged": sorted(
                                  f"{g}:{k}:{v['flag']}" for g, m in pmap.items() for k, v in m.items()
                                  if v["flag"] and k.startswith("grch38:ENST") and any(
                                      t["mane_select"] and k == f"grch38:{t['id']}.{t['version']}" for t in ens["grch38"].get(g, []))),
                              "isoform_flagged_genes": sorted({g for g, m in pmap.items() if any(v["flag"] for v in m.values())})}
    rel = collections.Counter(e["relation"] for g in nmv.values() for e in g.values())
    d["nm_versions"] = {"accession_versions": sum(rel.values()), "by_relation": dict(rel)}
    # (d3) independent Ensembl checks
    vm = TA / "validation_maps.json"
    if vm.exists():
        v = json.load(open(vm))
        agree = disagree = 0
        for x in v["cds_maps"]:
            for tag in ("grch38", "grch37"):
                if tag not in x:
                    continue
                t = next((t for t in ens[tag].get(x["gid"], []) if t["id"] == x["enst"]), None)
                if t is None:
                    continue
                ours = sorted((s[0], s[1]) for s in t["cds_segments"])
                if ours == [tuple(b) for b in x[tag]]:
                    agree += 1
                else:
                    disagree += 1
        vep_ok = vep_bad = vep_none = 0
        for x in v["vep_grch38"]:
            if "no_answer" in x:
                vep_none += 1
                continue
            acc, rest = x["query"].split(":c.")
            pos = int("".join(ch for ch in rest.split(">")[0] if ch.isdigit()))
            t = next(t for t in rsq["grch38"][x["gid"]] if t["accession"] == acc)
            g = c_to_g(pos, t["cds_segments"], t["strand"])
            if g == x["start"] and t["chrom"] == x["chrom"]:
                vep_ok += 1
            else:
                vep_bad += 1
        d["independent_checks"] = {"map_cds_transcripts_checked": len(v["cds_maps"]), "mane": sum(1 for x in v["cds_maps"] if x["mane"]),
                                   "map_cds_agree": agree, "map_cds_disagree": disagree,
                                   "vep_agree": vep_ok, "vep_disagree": vep_bad, "vep_no_answer": vep_none,
                                   "requests": v["requests"]}
        if disagree or vep_bad:
            hard.append("independent c.->g. checks")
    # (d4) PAR2 NM_005242.6:c.477G>A
    par = {}
    t38 = next((t for t in rsq["grch38"]["par2_human"] if t["accession"] == "NM_005242.6"), None)
    par["grch38"] = f"{t38['chrom']}:{c_to_g(477, t38['cds_segments'], t38['strand'])}" if t38 else None
    e = nmv["par2_human"].get("NM_005242.6", {})
    key = e.get("resolve_to") or ""
    tag37, _, acc37 = key.partition(":")
    t37 = next((t for t in rsq["grch37"]["par2_human"] if t["accession"] == acc37), None) if tag37 == "grch37" else None
    if t37 is None:     # NM_005242.6 not on the GRCh37 host: use any current GRCh37 transcript with identical CDS
        k37 = next((k for k in e.get("equals", []) if k.startswith("grch37:NM_")), None)
        t37 = next((t for t in rsq["grch37"]["par2_human"] if k37 and t["accession"] == k37.split(":")[1]), None)
    par["grch37"] = f"{t37['chrom']}:{c_to_g(477, t37['cds_segments'], t37['strand'])} (via {t37['accession']})" if t37 else None
    residue = (477 - 1) // 3 + 1
    model = json.load(open(PACK / "par2_human.json"))["sequence"]
    al = pmap["par2_human"].get("grch38:NM_005242.6") or pmap["par2_human"].get("ncbi:NM_005242.6")
    model_pos = residue + al.get("offset", 0) if al and al["kind"] in ("identical", "variant", "offset") else None
    par["model_residue"] = model_pos
    par["model_aa"] = model[model_pos - 1] if model_pos else None
    par["ok"] = (par["grch38"] == "5:76833084" and par["grch37"] is not None and par["grch37"].startswith("5:76128909")
                 and model_pos == 159 and par["model_aa"] == "M")
    d["par2_acceptance"] = par
    if not par["ok"]:
        hard.append("PAR2 acceptance")
    return d


def main():
    recs = receptors()
    trans = load_gz_json(HERE / "ensembl_cds" / "transcripts.json.gz")
    report = {"a_alleles": {}, "special": {}, "b": {}, "c": {}}
    hard = []

    # (a)
    tot = collections.Counter()
    for r in recs:
        gid = r["gid"]
        t = trans.get(gid, {})
        gp = SOURCES / "gnomad" / f"{gid}.json.gz"
        if not gp.exists():
            continue
        g = load_gz_json(gp)
        shifted = t.get("gnomad_numbering") or {}
        seq, tx = shifted.get("cds_seq") or t["cds_seq"], t["grch38"]
        expected_off = shifted.get("c_offset", 0)
        prot = translate(seq)
        packfile = json.load(open(PACK / f"{gid}.json"))
        packrows = {row[11]: row for row in (packfile["variants"] or [])}
        c = collections.Counter()
        offs = collections.Counter()       # c.-derived protein pos minus pack pos
        cdelta = collections.Counter()     # gnomAD hgvsc c. minus genomic-derived c.
        examples = []
        for v in g["variants"]:
            c["alleles"] += 1
            tc = v.get("transcript_consequence") or {}
            mc, mp = HGVSC.match(tc.get("hgvsc") or v.get("hgvsc") or ""), HGVSP.match(tc.get("hgvsp") or v.get("hgvsp") or "")
            if not (mc and mp):
                c["not_snv_missense_format"] += 1
                continue
            cpos, cref, calt = int(mc[1]), mc[2], mc[3]
            pref, ppos, palt = T3.get(mp[1]), int(mp[2]), T3.get(mp[3])
            cod0 = (cpos - 1) // 3 * 3
            codon = seq[cod0:cod0 + 3]
            ok = True
            if len(codon) < 3:
                c["c_beyond_cds"] += 1
                ok = False
            else:
                if seq[cpos - 1] != cref:
                    c["c_ref_base_mismatch"] += 1
                    ok = False
                if (cpos - 1) // 3 + 1 != ppos:
                    c["c_to_p_position_mismatch"] += 1
                    ok = False
                if CODON.get(codon) != pref:
                    c["ref_aa_mismatch"] += 1
                    ok = False
                mut = codon[:(cpos - 1) % 3] + calt + codon[(cpos - 1) % 3 + 1:]
                if CODON.get(mut) != palt:
                    c["alt_aa_mismatch"] += 1
                    ok = False
            _, gpos, gref, galt = v["variant_id"].split("-")
            gc = genomic_to_c(int(gpos), tx["cds_segments"], tx["strand"])
            if gc is None:
                c["genomic_outside_current_cds"] += 1   # lies in the older model's longer N-terminus (lpar2, oxer1)
            else:
                cdelta[cpos - gc - expected_off] += 1
                if tx["strand"] == 1:
                    gb_ok = (gref, galt) == (cref, calt)
                else:
                    gb_ok = (gref.translate(COMP), galt.translate(COMP)) == (cref, calt)
                if not gb_ok:
                    c["genomic_allele_vs_c_mismatch"] += 1
            prow = packrows.get(v["variant_id"])
            if prow:
                offs[ppos - prow[0]] += 1
            if ok:
                c["ok"] += 1
            elif len(examples) < 3:
                examples.append([v["variant_id"], tc.get("hgvsc"), tc.get("hgvsp")])
        main_delta, n_delta = (cdelta.most_common(1) or [(None, 0)])[0]
        c["pack_numbering_offsets"] = dict(offs) if any(k != 0 for k in offs) else 0
        if shifted:
            c["checked_under_gnomad_numbering_offset_c"] = expected_off
        report["a_alleles"][gid] = {
            **{k: v for k, v in c.items()}, "c_minus_genomic_c": dict(cdelta) if len(cdelta) > 1 or main_delta not in (0, None) else 0,
            "cds_translation_len": len(prot), "examples": examples}
        for k, v in c.items():
            if isinstance(v, int) and not k.startswith("checked_under") and k != "pack_numbering_offsets":
                tot[k] += v
    report["a_totals"] = dict(tot)

    # special cases: receptors where c. numbering of gnomAD != current Ensembl CDS
    for gid, d in report["a_alleles"].items():
        bad = d.get("ref_aa_mismatch", 0) + d.get("c_ref_base_mismatch", 0)
        if bad or d["c_minus_genomic_c"] or d["pack_numbering_offsets"] or d.get("checked_under_gnomad_numbering_offset_c"):
            report["special"][gid] = {k: d[k] for k in ("alleles", "ok", "ref_aa_mismatch", "c_ref_base_mismatch",
                                                         "c_minus_genomic_c", "pack_numbering_offsets", "cds_translation_len",
                                                         "checked_under_gnomad_numbering_offset_c", "genomic_outside_current_cds") if k in d}

    # (b)
    if not (HERE / "grch37" / "verification.json").exists():
        report["b"] = {"missing": "run fetch_grch37.py first"}
        hard.append("grch37 not fetched")
    else:
        ver = json.load(open(HERE / "grch37" / "verification.json"))
        res = ver["results"]
        anchor = next(x for x in res if x["kind"] == "PAR2 anchor")
        rnd = [x for x in res if x["kind"] == "random"]
        report["b"] = {
            "sample": len(rnd), "forward_ok": sum(x["forward_ok"] for x in rnd), "roundtrip_ok": sum(x["roundtrip_ok"] for x in rnd),
            "par2_anchor": {"expected": anchor["expected_grch37"][:-4], "direct": anchor["direct_grch37"], "ok": anchor["forward_ok"] or
                            (anchor["direct_grch37"] or "").startswith("5-76128909")}}
        meta = json.load(open(HERE / "grch37" / "_meta.json"))
        report["b"].update({"alleles_lifted": meta["alleles"], "unmapped": meta["unmapped"],
                            "ref_differs_in_grch37": meta["ref_differs_in_grch37"]})
        n_rows = 0
        with gzip.open(HERE / "grch37" / "alleles.tsv.gz", "rt") as fh:
            for row in csv.DictReader(fh, delimiter="\t"):
                n_rows += 1
        report["b"]["alleles_tsv_rows"] = n_rows

    # (b2) independent check: GRCh37 position from the GRCh37 transcript's own CDS segments (same stable ID, identical CDS)
    x37 = collections.Counter()
    pos37 = {}
    with gzip.open(HERE / "grch37" / "alleles.tsv.gz", "rt") as fh:
        for row in csv.DictReader(fh, delimiter="\t"):
            if row["variant_id_grch37"]:
                pos37[row["variant_id_grch38"]] = row["variant_id_grch37"]
    for gid, t in trans.items():
        if "cds_seq" not in t or not t["grch37"].get("cds_identical_to_grch38"):
            continue
        t38, t37 = t["grch38"], t["grch37"]
        if t37["chrom"] not in {str(i) for i in range(1, 23)} | {"X", "Y"}:
            x37["receptors_skipped_transcript_on_patch_scaffold"] += 1     # opsg: HG1497_PATCH
            continue
        for v in load_gz_json(SOURCES / "gnomad" / f"{gid}.json.gz")["variants"]:
            vid = v["variant_id"]
            got = pos37.get(vid)
            gpos = int(vid.split("-")[1])
            cc = genomic_to_c(gpos, t38["cds_segments"], t38["strand"])
            if cc is None or not got:
                x37["skipped"] += 1
                continue
            exp = next((a + (cc - cf) if t37["strand"] == 1 else b - (cc - cf)
                        for a, b, cf, ct in t37["cds_segments"] if cf <= cc <= ct), None)
            ok = exp is not None and str(exp) == got.split("-")[1] and got.split("-")[0] == t37["chrom"]
            x37["agree" if ok else "disagree"] += 1
        x37["receptors"] += 1
    report["b2_grch37_transcript_crosscheck"] = {k: v for k, v in x37.items()}
    if x37["disagree"]:
        hard.append("grch37 transcript cross-check")

    # (c)
    hg = load_gz_json(HERE / "hgnc" / "hgnc_records.json.gz")
    al = collections.defaultdict(set)
    with open(HERE / "aliases_curated.tsv") as fh:
        for row in csv.DictReader(fh, delimiter="\t"):
            al[row["gid"]].add(row["source"])
    gids = [r["gid"] for r in recs]
    report["c"] = {
        "receptors": len(gids),
        "hgnc_present": sum(1 for g in gids if hg.get(g, {}).get("found")),
        "ensembl_cds_present": sum(1 for g in gids if g in trans),
        "ensembl_with_cds": sum(1 for g in gids if "cds_seq" in trans.get(g, {})),
        "pseudogene_gene_only": sorted(g for g in gids if g in trans and "cds_seq" not in trans[g]),
        "alias_sources_ge1": sum(1 for g in gids if al.get(g)),
        "alias_gids_missing": [g for g in gids if not al.get(g)],
        "curated_source_present": sum(1 for g in gids if "curated" in al.get(g, ())),
        "refseq_nm_resolved": sum(1 for g in gids if trans.get(g, {}).get("refseq", {}).get("nm")),
        "refseq_nm_unresolved": [g for g in gids if "cds_seq" in trans.get(g, {}) and not trans[g]["refseq"]["nm"]],
        "cds_length_inconsistent": [g for g in gids if "grch38" in trans.get(g, {}) and not trans[g]["grch38"]["cds_length_consistent"]],
        "map_cds_disagrees": [g for g in gids if "grch38" in trans.get(g, {}) and not trans[g]["grch38"]["map_cds_agrees"]],
        "pack_version_differs": [g for g in gids if "grch38" in trans.get(g, {}) and not trans[g]["grch38"]["version_matches_pack"]],
        "grch37_same_id": sum(1 for g in gids if trans.get(g, {}).get("grch37", {}).get("same_stable_id")),
        "grch37_cds_identical": sum(1 for g in gids if trans.get(g, {}).get("grch37", {}).get("cds_identical_to_grch38")),
    }


    # (d) transcripts_all: every protein-coding transcript, Ensembl + RefSeq, GRCh38 + GRCh37
    TA = HERE / "transcripts_all"
    if (TA / "protein_model_map.json.gz").exists():
        report["d"] = validate_transcripts_all(TA, hard)

    # hard failures: structural problems, not the documented numbering special cases
    if report["c"]["receptors"] != 283 or report["c"]["hgnc_present"] != 283 or report["c"]["alias_sources_ge1"] != 283:
        hard.append("coverage")
    if "missing" not in report["b"] and (report["b"]["forward_ok"] != report["b"]["sample"] or report["b"]["roundtrip_ok"] != report["b"]["sample"] \
            or not report["b"]["par2_anchor"]["ok"]):
        hard.append("grch37 sample")
    meta = json.load(open(HERE / "grch37" / "_meta.json")) if (HERE / "grch37" / "_meta.json").exists() else {}
    unexpected = {g: v["unmapped"] for g, v in meta.get("per_receptor", {}).items()
                  if v["unmapped"] and g not in EXPECTED_UNMAPPED}
    report["b"]["unmapped_expected"] = {g: meta["per_receptor"][g]["unmapped"] for g in EXPECTED_UNMAPPED
                                        if g in meta.get("per_receptor", {})}
    if unexpected:
        report["b"]["unmapped_unexpected"] = unexpected
        hard.append("unmapped alleles")
    report["hard_failures"] = hard
    json.dump(report, open(HERE / "validation_report.json", "w"), indent=1, sort_keys=True)
    print(json.dumps({k: report[k] for k in ("a_totals", "special", "b", "b2_grch37_transcript_crosscheck", "c", "d", "hard_failures") if k in report}, indent=1, sort_keys=True))
    return 1 if hard else 0


if __name__ == "__main__":
    sys.exit(main())
