#!/usr/bin/env python3
"""Step 2: receptor alias table -> aliases_curated.tsv (offline; reads hgnc/, uniprot/, curated_aliases.py).

Columns: gid, alias, source, kind, also, collision
  source  hgnc_alias | hgnc_prev | uniprot_name | uniprot_entry | curated   (primary source; `also` lists the others)
  kind    symbol | alias_symbol | prev_symbol | index_symbol | hgnc_name | alias_name | prev_name | entry_name |
          entry_prefix | accession | gene_synonym | protein_name | curated
  collision  comma list: dup:<gid;gid..> (same normalised key on other receptors), variant_like (reads as a protein
          change, e.g. M1R = Met1Arg, A2A, F2R, P2Y), residue_like (e.g. D2, H1), short (<= 2 characters).
Normalised key for collisions: lower case, Greek letters spelled out (β -> beta), only a-z0-9 kept.
GtoPdb is NOT used here. Run: python3 build_aliases.py
"""
import csv
import re
from collections import defaultdict

from common import HERE, load_gz_json, receptors
from curated_aliases import CURATED

AA1 = "ACDEFGHIKLMNPQRSTVWY"
AA3 = "Ala|Arg|Asn|Asp|Cys|Gln|Glu|Gly|His|Ile|Leu|Lys|Met|Phe|Pro|Ser|Thr|Trp|Tyr|Val"
VARIANT_RE = re.compile(rf"^[{AA1}]\d+[{AA1}*X]$", re.I)
RESIDUE_RE = re.compile(rf"^([{AA1}]|{AA3})\d+$", re.I)
GREEK = str.maketrans({"α": "alpha", "β": "beta", "γ": "gamma", "δ": "delta", "ε": "epsilon", "κ": "kappa", "μ": "mu", "ω": "omega"})
PRIORITY = ["hgnc_alias", "hgnc_prev", "uniprot_name", "uniprot_entry", "curated"]


def norm(s):
    return re.sub(r"[^a-z0-9]", "", s.lower().translate(GREEK))


def protein_name_parts(text):
    """'Main name (alt 1) (alt 2) [Cleaved into: ...]' -> ['Main name', 'alt 1', 'alt 2']."""
    text = re.split(r"\s*\[(?:Cleaved|Isoform|Includes|Contains)", text)[0].strip()
    parts, depth, cur = [], 0, ""
    for ch in text:
        if ch == "(":
            if depth == 0:
                parts.append(cur.strip())
                cur = ""
            else:
                cur += ch
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                parts.append(cur.strip())
                cur = ""
            else:
                cur += ch
        else:
            cur += ch
    if cur.strip():
        parts.append(cur.strip())
    return [p for p in parts if p and not re.fullmatch(r"EC [\d.\-]+", p)]


def main():
    recs = receptors()
    hgnc = load_gz_json(HERE / "hgnc" / "hgnc_records.json.gz")
    import gzip
    up = {}
    with gzip.open(HERE / "uniprot" / "uniprot_names.tsv.gz", "rt") as fh:
        next(fh)
        for line in fh:
            acc, entry, genes, names = line.rstrip("\n").split("\t")
            up[acc] = (entry, genes, names)

    rows = defaultdict(dict)   # (gid, alias) -> {sources:set, kinds:list}

    def add(gid, alias, source, kind):
        alias = (alias or "").strip()
        if not alias:
            return
        d = rows[(gid, alias)]
        d.setdefault("src", [])
        if source not in d["src"]:
            d["src"].append(source)
        d.setdefault("kind", {})[source] = kind

    for r in recs:
        gid = r["gid"]
        h = hgnc[gid]
        add(gid, h["symbol"], "hgnc_alias", "symbol")
        if r["gene"] != h["symbol"]:
            add(gid, r["gene"], "hgnc_prev", "index_symbol")
        for a in h.get("alias_symbol", []):
            add(gid, a, "hgnc_alias", "alias_symbol")
        for a in h.get("prev_symbol", []):
            add(gid, a, "hgnc_prev", "prev_symbol")
        add(gid, h.get("name"), "hgnc_alias", "hgnc_name")
        for a in h.get("alias_name", []):
            add(gid, a, "hgnc_alias", "alias_name")
        for a in h.get("prev_name", []):
            add(gid, a, "hgnc_prev", "prev_name")
        entry, genes, names = up[r["uniprotId"]]
        add(gid, entry, "uniprot_entry", "entry_name")
        add(gid, entry.split("_")[0], "uniprot_entry", "entry_prefix")
        add(gid, r["uniprotName"], "uniprot_entry", "entry_prefix")
        add(gid, r["uniprotId"], "uniprot_entry", "accession")
        for g in genes.split():
            add(gid, g, "uniprot_name", "gene_synonym")
        for n in protein_name_parts(names):
            add(gid, n, "uniprot_name", "protein_name")
        for a in CURATED.get(gid, []):
            add(gid, a, "curated", "curated")

    by_norm = defaultdict(set)
    for (gid, alias) in rows:
        by_norm[norm(alias)].add(gid)

    out = []
    for (gid, alias), d in rows.items():
        srcs = sorted(d["src"], key=PRIORITY.index)
        k = norm(alias)
        flags = []
        others = sorted(by_norm[k] - {gid})
        if others:
            flags.append("dup:" + ";".join(others))
        if d["kind"][srcs[0]] in ("accession", "entry_name"):
            pass
        elif VARIANT_RE.match(alias.replace(" ", "")):
            flags.append("variant_like")
        elif RESIDUE_RE.match(alias.replace(" ", "")):
            flags.append("residue_like")
        if len(k) <= 2:
            flags.append("short")
        out.append((gid, alias, srcs[0], d["kind"][srcs[0]], ",".join(srcs[1:]), ",".join(flags)))
    order = {r["gid"]: i for i, r in enumerate(recs)}
    out.sort(key=lambda x: (order[x[0]], PRIORITY.index(x[2]), x[1].lower()))

    with open(HERE / "aliases_curated.tsv", "w", newline="") as fh:
        w = csv.writer(fh, delimiter="\t", lineterminator="\n")
        w.writerow(["gid", "alias", "source", "kind", "also", "collision"])
        w.writerows(out)
    n_flag = sum(1 for o in out if o[5])
    print(f"{len(out)} aliases for {len({o[0] for o in out})} receptors; {n_flag} flagged")


if __name__ == "__main__":
    main()
