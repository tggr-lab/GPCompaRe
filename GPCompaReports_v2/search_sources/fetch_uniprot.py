#!/usr/bin/env python3
"""Step 1b: UniProt names for the 283 receptors -> uniprot/uniprot_names.tsv.gz (+ _meta.json).

Source of the `uniprot_name` / `uniprot_entry` alias kinds. One batched query per 40 accessions via
https://rest.uniprot.org/uniprotkb/search (fields: accession, id, gene_names, protein_name). UniProt is CC BY 4.0.
Run: python3 fetch_uniprot.py
"""
import gzip
import urllib.parse

from common import HERE, Client, receptors, write_json

OUT = HERE / "uniprot" / "uniprot_names.tsv.gz"
META = HERE / "uniprot" / "_meta.json"


def main():
    recs = receptors()
    c = Client("https://rest.uniprot.org", rate=3, accept="text/plain")
    rows, release, date = {}, None, None
    accs = sorted({r["uniprotId"] for r in recs})
    for i in range(0, len(accs), 40):
        q = " OR ".join(f"accession:{a}" for a in accs[i:i + 40])
        url = ("/uniprotkb/search?query=" + urllib.parse.quote(f"({q})") +
               "&fields=accession,id,gene_names,protein_name&format=tsv&size=100")
        text = c.get(url, accept="text/plain")
        release = c.last_headers.get("X-UniProt-Release", release)
        date = c.last_headers.get("X-UniProt-Release-Date", date)
        for line in text.splitlines()[1:]:
            acc, entry, genes, names = (line.split("\t") + ["", "", "", ""])[:4]
            rows[acc] = (entry, genes, names)
    missing = [a for a in accs if a not in rows]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with gzip.GzipFile(OUT, "wb", mtime=0) as gz:
        gz.write(b"accession\tentry_name\tgene_names\tprotein_names\n")
        for a in sorted(rows):
            gz.write(("\t".join([a, *rows[a]]) + "\n").encode())
    write_json(META, {"source": "UniProtKB REST search (rest.uniprot.org)", "release": release,
                      "release_date": date, "licence": "CC BY 4.0", "accessions": len(accs),
                      "returned": len(rows), "missing": missing, "requests": c.requests})
    print(len(rows), "of", len(accs), "missing:", missing, "release", release)


if __name__ == "__main__":
    main()
