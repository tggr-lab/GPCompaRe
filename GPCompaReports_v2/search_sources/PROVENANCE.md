# search_sources: provenance

Source caches for the database search v2 index (plan: `docs/plans/2026-11-04_search_v2_and_studio_features.md`, section 4 and phase P2).
Fetched on **2026-11-04** (IST) by the scripts in this folder. The index generator reads only these files and never touches the network.

Inputs (read-only): the Studio pack checkout `gpcompare_studio_web/.claude/worktrees/main-merge` (override with `STUDIO_ROOT`):
`public/pack/index.json` (283 receptors, genes, UniProt accessions), `public/pack/<gid>.json`, and `pack/sources/{gnomad,clinvar,ensembl}/`
(gnomAD v4.1.2 `gnomad_r4`, fetched 2026-10-18; ClinVar release 2026-10-11, build `Build261011-1710.1`; Ensembl transcript choices of 2026-10-18).

## Contents

| Path | What | Source and endpoint | Release / date | Licence | Size |
|---|---|---|---|---|---|
| `hgnc/hgnc_records.json.gz` | HGNC record per gid: symbol, alias_symbol, prev_symbol, name, alias_name, prev_name, hgnc_id, entrez_id, ensembl_gene_id, uniprot_ids, mane_select, locus_type | HGNC REST `https://rest.genenames.org/fetch/symbol/<SYM>` (288 requests; the complete set, ~16 MB JSON, was not needed for 283 genes). `GPR182` and `NPY6R` are no longer approved symbols and were found through `prev_symbol` (now ACKR5 and NPY6RP) | HGNC last modified 2026-10-30, 47,090 records in the whole set; fetched 2026-11-04 | CC0 1.0 | 20 KB |
| `uniprot/uniprot_names.tsv.gz` | entry name, gene names and protein names (recommended + alternative) per accession | UniProtKB REST `https://rest.uniprot.org/uniprotkb/search?query=accession:...&fields=accession,id,gene_names,protein_name&format=tsv` (40 accessions per call) | UniProt release 2026_04; fetched 2026-11-04 | CC BY 4.0 (attribution: UniProt Consortium) | 11 KB |
| `aliases_curated.tsv` | 3,780 alias rows for all 283 gids: `gid, alias, source, kind, also, collision` | built offline by `build_aliases.py` from HGNC + UniProt + `curated_aliases.py` (hand-written common names). **GtoPdb is not used or shipped**; it was only consulted to check coverage (8 missing names were then written by hand in our own words) | 2026-11-04 | HGNC CC0, UniProt CC BY 4.0, curated list ours | 214 KB |
| `ensembl_cds/transcripts.json.gz` | per gid: chosen transcript (the one the gnomAD pack used), GRCh38 exons, CDS segments with c. ranges, strand, CDS length, CDS nucleotide sequence (GRCh38, includes stop codon), GRCh37 transcript (same stable ID; version may differ) with its own exons and CDS segments, gene windows on both assemblies, MANE RefSeq NM_ with version, `gnomad_numbering` block for lpar2 and oxer1 | Ensembl REST: `POST /lookup/id` (transcripts with expand=1, genes), `POST /sequence/id?type=cds`, `GET /map/cds/<ENST>/1..N` (independent cross-check of the exon x translation split), `POST /lookup/symbol/homo_sapiens` (5 GRCh37 genes not found by ENSG), `GET /sequence/id?type=cdna` (lpar2, oxer1). GRCh38 on `rest.ensembl.org`, GRCh37 on `grch37.rest.ensembl.org` | Ensembl REST software release **116** on both hosts. GRCh38 = GRCh38.p14, genebuild 2025-11. GRCh37 = GRCh37.p13, genebuild last update 2013-09 (the GRCh37 host reports the same REST release number but serves the frozen GRCh37 database). Fetched 2026-11-04 | Ensembl data is open (EMBL-EBI terms); no restriction on reuse | 182 KB |
| `grch37/alleles.tsv.gz` | `gid, variant_id_grch38, variant_id_grch37, method, ref37_ok` for all 174,755 gnomAD missense alleles in `pack/sources/gnomad` (the Studio packs keep 145,345 of them) | derived from `grch37/segment_maps.json.gz`: each GRCh38 CDS segment was mapped once with `GET /map/human/GRCh38/<chr>:<s>..<e>:1/GRCh37`, alleles are shifted by their block offset. Patch/alt scaffolds in the mapper answer (e.g. `HG1433_PATCH`) are discarded, primary chromosomes only. Blocks that are inverted between the assemblies (npy4r 852 alleles, v1br 665) are mirrored and the alleles complemented (`method=cds_block_map_inverted`). 65 alleles outside the current CDS (lpar2 6, oxer1 59) were mapped one position at a time (`method=direct_map`, `grch37/direct_maps.json`). `ref37_ok` compares the GRCh37 reference base (`POST /sequence/region/human?coord_system_version=GRCh37`) with the gnomAD ref allele | 2026-11-04 | Ensembl open | 1.1 MB |
| `grch37/segment_maps.json.gz`, `direct_maps.json`, `verification.json`, `_meta.json` | block maps, direct maps, the 200-allele + PAR2 anchor check (forward and back), counts | as above | 2026-11-04 | | 25 KB |
| `validation_report.json` | output of `validate.py` | offline | | | 48 KB |

Total payload is about 3.1 MB (target was < 30 MB), including `transcripts_all/` below. Checksums: `CHECKSUMS.sha256` (`make_checksums.sh`).

## Alias table (`aliases_curated.tsv`)

* `source`: `hgnc_alias` (current symbol, alias symbols, approved name, alias names), `hgnc_prev` (previous symbols and names, plus the symbol the pack index carries when HGNC has since renamed it), `uniprot_name` (gene synonyms, recommended and alternative protein names), `uniprot_entry` (entry name such as `PAR2_HUMAN`, its prefix, accession), `curated`. `also` lists further sources for the same string.
* `collision`: `dup:<gid;gid>` the same normalised string (lower case, Greek spelled out, only a-z0-9 kept) is also an alias of other receptors; `variant_like` reads as a one-letter protein change (M1R, A2A, F2R, P2Y); `residue_like` reads as a residue (D2, H1, A1); `short` 2 characters or fewer. 158 rows are flagged. Accessions and entry names are never flagged as residue-like.
* Resolution rule the index should use: an exact HGNC symbol (`kind=symbol` or `index_symbol`) wins over any alias; an exact receptor name wins over a variant reading (plan section 3); `dup:` aliases give a "which receptor?" list.
* Known upstream oddity: UniProt lists "Alpha-1A adrenergic receptor" as an alternative name of ADRA1D (P25100), so it collides with ADRA1A.

## Numbering notes the index builder must know

* **lpar2**: gnomAD hgvsc/hgvsp follow an older, longer transcript model (3 more N-terminal residues, c. offset +9). The current Ensembl CDS is shifted by 9 nt; `gnomad_numbering.cds_seq` holds the CDS in gnomAD numbering (current CDS plus the 9 upstream bases `ATGGTCATC`). The Studio pack numbering is the current Ensembl numbering (pack = gnomAD residue minus 3). Not changed here.
* **oxer1**: gnomAD follows the 423 aa model (c. offset +117, 39 more N-terminal residues); the Studio pack uses that same numbering (pack offset 0). The 117 upstream bases are taken from the genome directly upstream of the start codon (the cDNA of the current model has only 73 bases of 5' UTR); every one of the 718 alleles verifies against it.
* **mchr1** and **npff2**: current Ensembl/gnomAD numbering is shorter than UniProt (pack = gnomAD residue plus 69 and plus 102). The CDS fully agrees with gnomAD; the offsets are pack-numbering offsets, not errors.
* **ccr2, gp142, gpr17**: the pack chose a transcript with a protein identical to UniProt, which is not the MANE isoform. The MANE `NM_` is recorded with `nm_usable=false`; do not translate `NM_..:c.` positions for these through our CDS.
* **ada2b**: 7 GRCh38 alleles at 2:96115251-96115257 have no GRCh37 position (the GRCh37 reference lacks the 9 bp that code the Glu301-303 region; GRCh37 transcript is 447 aa vs 450; hg19 NM_000682.7 CDS is likewise 9 bp shorter). `variant_id_grch37` is empty, `method=unmapped`.
* **opsg** (OPN1MW, X-linked opsin array): exons 5-6 have no one-to-one GRCh37 primary mapping, 92 alleles `unmapped`. Its GRCh37 Ensembl transcript lies on `HG1497_PATCH`.
* **npy4r and v1br**: their CDS lies in a region inverted between GRCh37 and GRCh38. GRCh37 positions are mirrored and alleles complemented (1,517 alleles, `cds_block_map_inverted`); in GRCh37 the genes are on the opposite strand.
* **ref differs in GRCh37**: 8 alleles (5ht2c 2, opsr 2, npy4r 4) sit on bases where the GRCh37 reference differs from GRCh38; `ref37_ok=0`.
* **p2ry8**: GRCh38 has an X gene (ENSG00000182162, where the alleles are) and a PAR copy on Y (ENSG00000292333). `ensembl_cds` now holds `gene_grch38` = X and `gene_grch38_par_y`; `transcripts_all` has both (`par_copy` X or Y).
* **npy6r, taar3**: pseudogenes, gene windows only (no CDS). **hrh2** and **p2ry8** use the pack's documented fallback transcripts; p2ry8 alleles are on X (PAR1).
* Ensembl versions: for 7 receptors (ccr2, ffar1, gpr17, opn5, oxer1, taar8, taar9) the current Ensembl transcript version is newer than the one recorded in the gnomAD pack; the CDS was verified allele by allele, so only oxer1 is affected in practice.
* GRCh37 transcript: the same stable ID exists on the GRCh37 host for 252 of 281 transcripts (CDS identical to GRCh38 for 238); the others have a different ID or CDS, so GRCh37 coordinates are always obtained from the mapped GRCh38 CDS blocks, not from the GRCh37 transcript.

## Validation (`validate.py`, offline; result in `validation_report.json`)

All checks run offline on the caches (the sample checks use the stored direct Ensembl answers). `hard_failures` in the report is empty.

* (a) **174,755 of 174,755** gnomAD alleles: the hgvsc position through the CDS gives the hgvsp residue number, the reference amino acid and the alternate amino acid; the c. reference base equals the CDS base; the genomic position through the CDS segments reproduces the c. position; gnomAD ref/alt equal the c. bases (complemented on the minus strand). 281 receptors checked. 1,162 of them fail against the *current* Ensembl CDS and pass only with `gnomad_numbering` (lpar2 +9 nt, oxer1 +117 nt; 65 of these alleles lie outside the current CDS). Residue numbering versus the Studio pack rows differs by a constant for lpar2 (pack = gnomAD - 3), mchr1 (+69), npff2 (+102); oxer1 0; all other receptors 0.
* (b) GRCh37/GRCh38: 200 random alleles (seed 20261104) plus the PAR2 anchor, each checked by a direct `/map` call forward and back: **200/200 forward, 200/200 round trip**, PAR2 5:76833084 -> 5:76128909 confirmed. All 174,755 alleles lifted, 99 unmapped (ada2b 7, opsg 92, both explained above). Independent cross-check: for the 237 receptors whose GRCh37 Ensembl transcript has the identical CDS on a primary chromosome, the GRCh37 position derived from that transcript's own CDS segments equals the block-map result for **152,414 of 152,414** alleles.
* (c) all 283 gids in HGNC (283), alias table (283, each with >= 1 source; 184 also have a curated alias), `ensembl_cds` (281 with CDS, npy6r and taar3 gene-only); `map/cds` agrees with our exon x translation split for all 281; MANE NM resolved for 281 (278 exact, 3 other-isoform with `nm_usable=false`).

### transcripts_all (every protein-coding transcript, both assemblies)

| File | Content | Source | Count |
|---|---|---|---|
| `ensembl_grch38.json.gz` | ENST.version, ENSP, exons, CDS segments with c. ranges, strand, CDS and protein sequence, canonical and MANE flags | Ensembl 116 REST (`POST /lookup/id` expand, `POST /sequence/id`) | 1,797 transcripts, 281 genes (incl. 9 P2RY8 X-copy) |
| `ensembl_grch37.json.gz` | same on the GRCh37 host (older gene build, older versions) | grch37.rest.ensembl.org | 696 transcripts, 279 genes (gpr33, taar9 have none) |
| `refseq_grch38.json.gz` | NM_/XM_ with version, NP_, exons, CDS segments, MANE tag | Ensembl `otherfeatures` RefSeq import (`/overlap/region ... db_type=otherfeatures`) | 1,016 (690 NM, 326 XM), 281 genes |
| `refseq_grch37.json.gz` | NM_ with version, exons, CDS segments | UCSC `hg19.ncbiRefSeq` (Last-Modified 2024-09-18, sha256 in `_meta_ucsc.json`), because the grch37 Ensembl host has no RefSeq import | 692 NM, 281 genes |
| `ucsc_refseq_grch38.json.gz` | UCSC `hg38.ncbiRefSeq` (2025-08-13), cross-check only | UCSC | 1,017 |
| `ncbi_cds.json.gz` | CDS nucleotide sequence, protein and NP_ for every NM_/XM_ accession.version in scope, including older versions | NCBI E-utilities efetch `fasta_cds_na` and `fasta_cds_aa`, 2026-11-04 | 1,066 of 1,066 returned |
| `nm_harvest.json.gz`, `nm_versions.json.gz` | where each accession.version was seen (Ensembl/UCSC current, HGNC MANE, ClinVar refseq block 352, ClinVar titles 319) and its relation to the current transcripts | offline | 1,069 (gene, accession) pairs: current 1,017, cds_identical 18, cds_shifted 1 (agtr1 NM_031850.3), protein_identical 1 (ednrb NM_001201397.1), different 32 |
| `protein_model_map.json.gz` | transcript residue -> model (pack) residue through SHARED GENOMIC CODONS (same three bases on the same assembly), never sequence alignment: `identical` (bijection) or an exact block list; also each harvested NM_ version (read through a current transcript with the same CDS or protein, or a 5'-extended CDS) and the pack's gnomAD frame | offline (2026-11-04 rebuild after review finding 1) | 5,543 maps: identical 4,000, blocks 1,464, none 79 |
| `model_codons.json.gz` | the model's own codons as runs of bases on GRCh38 (gnomAD transcript in gnomAD's frame, shifted by the pack offset; every one of the 145,345 pack alleles lies in its residue's codon) and GRCh37 (lifted through `grch37/segment_maps`, plus GRCh37 transcripts whose protein equals the model) | offline | 111,421 of 112,225 model residues on GRCh38 (missing: the NPY6R/TAAR3 pseudogenes, MCHR1 1-69 and NPFFR2 1-102), 111,490 on GRCh37 |

Notes: licences are Ensembl open, NCBI RefSeq public domain, UCSC table data free to use (cite UCSC Genome Browser and RefSeq). RefSeq XM_ rows are NCBI Gnomon predictions imported by Ensembl; they are kept because they are protein-coding and current. LRG ids were not requested (optional). Records for GRCh37 NM_ are the older NCBI alignment (UCSC, 2024-09) and carry the version it had; `nm_versions.json.gz` resolves a request for another version through identical CDS where possible and otherwise leaves `resolve_to` empty with a relation of `different`, `cds_shifted` or `protein_identical` so the UI can warn.

Maps in `protein_model_map` (rebuilt 2026-11-04): the earlier difflib alignment kept 1-2 aa chance matches inside divergent exons (501 of 686 block maps had blocks < 5 aa; 1,385 allele x transcript pairs on 144 transcripts disagreed with the genome, incl. the MANE transcripts of GPR142 and CCR2). A residue now maps only through a shared codon, so a residue of another isoform's exon has no counterpart in the model. Flags: `partial` (kind `blocks`) and `none`. Checked in tests/test_search_index_v2.py and tests/search_v2/resolve.test.mjs over every gnomAD allele x every transcript holding it.

Validation of transcripts_all (in `validation_report.json`, section `d`):
* every Ensembl CDS translates to its stated protein (1,797 on GRCh38 and 696 on GRCh37, 0 failures); every NCBI CDS translates to its protein (1,066, 0 failures). Stop-codon readthrough annotated as X is accepted: OPRK1 ENST00000673285 and OPRL1 ENST00000672146, NM_001318497.2 and NM_001318853.2. 9 Ensembl transcripts are partial CDS whose length is not a multiple of 3 (flagged, not failures).
* `GET /map/cds/<ENST>/1..N` on both hosts for 10 random MANE plus 20 random non-MANE transcripts (43 transcript-assembly pairs): **43/43** equal our CDS segments. VEP `hgvs` on GRCh38 for NM_005242.6:c.477G>A and 12 random RefSeq transcripts at random c. positions: **13/13** equal our c.->g. result. 58 requests in all.
* Ensembl otherfeatures versus UCSC on GRCh38: CDS segments agree for 1,008 of 1,008 shared NM_/XM_ (8 only in Ensembl).
* RefSeq CDS length equals the NCBI CDS length for all but one: hg19 ADRA2B NM_000682.7 is 9 bp shorter (the GRCh37 reference deletion above).
* **PAR2 NM_005242.6:c.477G>A** gives 5:76833084 (GRCh38) and 5:76128909 (GRCh37, same CDS on the GRCh37 RefSeq record) and model residue 159 (Met in the pack sequence).

## How to rerun

All scripts are python3 standard library, idempotent and resumable; run from this folder. Network order:

```
python3 fetch_hgnc.py
python3 fetch_uniprot.py
python3 fetch_ensembl_cds.py     # batched POSTs, then 271 GET /map/cds; add --redo <gid> ... to refetch some
python3 fetch_shifted_cds.py     # lpar2 / oxer1 gnomAD-numbering CDS
python3 resolve_refseq.py        # offline
python3 build_aliases.py         # offline
python3 fetch_grch37.py          # ~630 map calls + batched sequences + 400 verification calls
python3 fetch_transcripts_all.py # batched gene lookups, sequences, RefSeq overlap (GRCh38)
python3 fetch_par_copies.py      # P2RY8 X copy
# download hg19/hg38 ncbiRefSeq.txt.gz into ~/scratch/2026-11-04_ucsc_refseq (see fetch_ucsc_refseq.py)
python3 fetch_ucsc_refseq.py
python3 fetch_ncbi_cds.py
python3 build_transcript_map.py  # offline
python3 fetch_validation_maps.py # 58 requests
python3 validate.py
sh make_checksums.sh
```

Delete a cache file to refetch it. Rate limit: at most 8 requests/s per host through a shared limiter, `Retry-After` honoured, up to 10 retries with backoff. On 2026-11-04 rest.ensembl.org answered in 13 to 60 s with intermittent 503 (all retried successfully; no request failed permanently), which is why the scripts batch with POST and use 6 threads. The complete run took about five hours of wall time, mostly waiting on Ensembl. To refresh against a newer gnomAD or Ensembl release, rerun everything and re-check the numbering notes above.
