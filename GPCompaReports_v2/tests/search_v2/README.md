# Search v2 golden queries (P1 spec by example)

Specification by example for the database's variant and residue search (plan
`docs/plans/2026-11-04_search_v2_and_studio_features.md`, sections 3 and 5/P1).
Each row is a string a user might type and the answer the search must give.
The P4 parser and resolver test suite runs this table and must pass 100%.

| File | What it is |
|---|---|
| `golden_queries.tsv` | 394 queries and their expected answers |
| `grch37_liftover.tsv` | GRCh38 to GRCh37 positions used by the GRCh37 rows (Ensembl REST, fetched 2026-11-04) |
| `check_golden.py` | Validator: re-derives every row from the Studio packs and exits non-zero on any mismatch |

Run: `python3 check_golden.py` (stdlib only). Set `--pack-dir` and `--sources-dir`, or
`GPCOMPARE_PACK_DIR` and `GPCOMPARE_PACK_SOURCES`, to point it at another copy of the packs.
By default it reads the Studio main-merge worktree on HAVN.

## Ground truth and releases

Every gid, position, residue, allele and ClinVar id was read from the Studio packs. None was typed by hand.

- Packs: `gpcompare_studio_web/.claude/worktrees/main-merge/public/pack/<gid>.json` and `index.json`.
- gnomAD v4.1.2 (dataset `gnomad_r4`), all missense, fetched 2026-10-18.
- ClinVar release 2026-10-11 (`Build261011-1710.1`). Packed records are P/LP single-residue missense only. Raw per-gene caches are in `pack/sources/clinvar/`.
- Ensembl transcripts: `pack/sources/ensembl/`, fetched 2026-10-18.
- GRCh37 positions: Ensembl REST `/map/human/GRCh38/<c>:<p>..<p>:1/GRCh37`, with the GRCh37 base checked on `grch37.rest.ensembl.org/sequence/region`. 16 positions in all; every one maps on the + strand and has the same reference base. PAR2 check: 5:76833084 maps to 5:76128909.

The scratch generator is `~/scratch/2026-11-04_search_golden/build_golden.py`. It is not shipped, so treat the TSV as the source.

## Columns

| Column | Meaning |
|---|---|
| `id` | `G001`, `G002`, ... in file order |
| `query` | The exact string the user types. Leading and trailing spaces are part of the query. The two characters `\t` stand for a TAB (VCF rows); the test harness must unescape them. |
| `category` | Test group, for example `par2_protein`, `shifted_numbering` or `clinvar_record` |
| `expect` | One of the seven classes in the next table |
| `gid` | Pack id (`par2_human`). For `targets` it is a `;`-separated list that runs parallel to `pos`. For `ambiguous` it holds the primary (top-ranked) reading. |
| `pos` | Pack position (see numbering). It is `;`-separated and parallel to `gid`. It is empty for receptor answers and when no residue is defined. |
| `ref` | One-letter residue. Rows naming an allele or ClinVar record use that record's reference, in gnomAD/ClinVar transcript orientation. Rows naming no allele use the pack residue at `pos`. |
| `alt` | One-letter alt for missense. It may be a `,` list when one rsID gives several substitutions at one residue. For non-missense input it is the parsed class: `*` stop, `=` synonymous, `fs`, `del`, `dup`, `ins`, `delins`. |
| `alleles` | GRCh38 gnomAD ids (`5-76833084-G-A`), `,`-separated. A query naming a substitution lists every allele of it. A query naming one allele (gnomAD id, c., g., SPDI, VCV) lists only that allele. A ClinVar-only allele can appear when gnomAD lacks it. |
| `alternates` | Other acceptable or "Did you mean" readings, separated by ` \| `: `receptor:<gid>`, `change:<gid or *>:<pos>:<ref>><alt>`, `residue:<gid or *>:<pos>:<aa>`, `generic:<display number>`, `clinvar:<variation id>`, `gene_id:<n>`, `hgnc:<n>`. `*` means across all receptors. |
| `assembly` | `GRCh38` or `GRCh37` for genomic input (the assembly the search should detect), else `na` |
| `note` | Free text plus machine tokens that the validator reads (next table) |

| Note token | What the validator checks |
|---|---|
| `src=<file>:<field>` | Provenance. The file must exist. |
| `clinvar=<id>[,<id>]` | A packed ClinVar record with this Variation ID sits at `pos` with this `ref` and `alt`. |
| `clinvar_raw=<uid>` | The record is in the raw ClinVar cache and is not packed. |
| `complete=seq`, `complete=gn:<gn>[:<aa>]`, `complete=hgvsc:<c.>` | The row lists exactly every receptor (and allele) matching. |
| `novar` | No gnomAD allele exists at that residue. |
| `FALLS INSIDE` | Acknowledges a GRCh37 position that lies inside a GRCh38 receptor window. |

### expect classes

| expect | Meaning |
|---|---|
| `target` | One receptor and one residue, with an optional substitution and alleles |
| `targets` | Several receptors or residues (a bare change, a bare generic number, one rsID with several substitutions) |
| `receptor` | The receptor itself (report link), with no residue |
| `ambiguous` | Two or more valid readings. The primary reading is in `gid`/`pos` (or empty when none is preferred), and the others are in `alternates`. |
| `not_coding` | Parsed and placed, but outside the coding sequence (intron, UTR, intergenic). `pos` is the nearest residue when it can be defined. |
| `not_in_resource` | Parsed and understood, but the database does not hold it: a non-missense class (D3), a reference mismatch, a ClinVar record that is not packed, a dropped allele, a receptor outside the 283, an unknown rsID. `pos` is set when a residue is defined. |
| `unrecognised` | Not readable at all. The answer is a plain-language "could not read this", never an empty receptor table. |

## Numbering conventions

`pos` is the **pack position**. This is the numbering of the database's own models, which is also the numbering of the
report pages and snake plots. For 268 of the 283 receptors, the gnomAD transcript is identical to the model, so
transcript, MANE and pack numbering all agree. The exceptions follow. In each, `txPos` in the pack is the gnomAD numbering.

| Receptor | Relation | Consequence for queries |
|---|---|---|
| LPAR2 | gnomAD's hgvsp/hgvsc on ENST00000407877.8 = pack + 3. Today's Ensembl .8, MANE NM_001395660.1/NP_001382589.1 = pack. UniProt Q9HBW0 (351 aa) = pack + 3. | A change copied from gnomAD (`p.Leu351Phe`, `c.1051C>T`) maps −3. A change in MANE numbering maps 1:1. The same ENST version label means two frames: `ENST00000407877.8:c.N` is read in gnomAD's frame (assumed). |
| MCHR1 | MANE NM_005297.4 / ENST00000249016.5 (353 aa) = pack − 69. The model is the 422-aa UniProt isoform. | MANE p./c. maps +69. UniProt numbering = pack. |
| NPFFR2 | MANE NM_004885.3 / ENST00000308744.12 (420 aa) = pack − 102. The model is 522 aa. | Same as MCHR1, +102. |
| OXER1 | gnomAD ENST00000378661.3 (423 aa) = pack. Current MANE NM_148962.5 / NP_683765.2 / ENST00000378661.4 (384 aa) starts at model Met40, so MANE = pack − 39. | `NP_683765.2:p.` and `NM_148962.5:c.` map +39 (and +117 nt). The c. mapping assumes the N-terminal difference is contiguous coding sequence; check this against the P2 CDS tables. |
| HRH2 | MANE (422 aa) extends 63 residues past the 359-residue model. 33 gnomAD alleles are dropped. | Those inputs are `not_in_resource` (outside the model). |
| FFAR4 | Model and MANE are the 361-aa isoform. The literature's R270H uses the 377-aa isoform (ENST00000371483.8). | `FFAR4 R270H` is expected to reach pack 254 (open question 5). |
| OPSB | gnomAD and MANE (345 aa) = pack. UniProt P03999 (348 aa) = pack + 3. | No golden row yet (open question 5). |

The `ref` orientation follows gnomAD and ClinVar. For a **model/transcript conflict** the model residue is the gnomAD
**alt**: ADRB1 389, 5-HT2C 23, FSHR 680, DRD3 9, NPY4R 240, TSHR 727, and PAR2 30 (Asn in the model, Ser in Ensembl). These are 17 alleles in 7 receptors.
The validator allows `ref` to differ from the pack residue only when the row's allele carries the pack's `conflict` flag.

## Ambiguity and ranking rules assumed

1. An exact receptor name (HGNC symbol, UniProt name, accession or entry name, curated common name) beats a variant reading: `M1R`, `A2A`, `F2R`, `D2`, `M1`. The other reading goes in "Did you mean".
2. An exact name beats a prefix or substring: `GPR3` is not `GPR31`, `GPR4` is not `GPR42`, `XCR1` is not `CXCR1`, `P2Y1` is not `P2Y10`. A pure prefix (`P2Y`, `GPR`) gives a list.
3. An identifier that matches a receptor (`P55085`) outranks a protein-change reading that matches no residue (Pro55085).
4. A bare integer is never a residue without a receptor. It gives candidate IDs (Variation ID, NCBI Gene ID). `2150` offers F2RL1, and `718860` offers the ClinVar record.
5. With a receptor, `6 48` reads as generic 6.48, not residue 6. Without one, it offers generic 6.48.
6. A bare change (`M159I`) or residue (`M159`) lists every receptor with that residue at that pack position (9 receptors for Met159).
7. A protein change matches by pack position, or by the allele's own HGVS numbering (transcript). When both readings fit (`LPAR2 p.Val273Gly`), the reading that names a stored allele ranks first.
8. A bare residue number with a receptor uses model numbering. For a shifted receptor, the transcript reading is offered as "Did you mean".
9. Reference swap: when the typed ref is the stored alt and the typed alt is the stored ref, the stored allele is shown with "listed the other way round" (ADRB2 Arg16Gly, Gln27Glu). A residue-only query whose typed residue is a stored alt (`ADRB2 Arg16`) shows the residue with a mismatch line and that allele.
10. A residue number and a generic number that disagree (`ADRB2 Arg130(3.50)`): the generic number wins, and the card flags the number.
11. The genomic assembly is GRCh38 unless the position falls outside every GRCh38 receptor window and inside a GRCh37 one, or unless the accession (`NC_000005.9`) or a label (`hg19`, `GRCh37`) says otherwise. At DRD4 11:640099 the two assemblies have the same coordinate and give the same allele.
12. PAR1 Y ids (`Y-1466186-C-T`, `chrY:`) and PLINK `23` map to the X allele (gnomAD lists X only).
13. Non-missense input (stop, `=`, fs, del, dup, ins, delins) resolves to its residue with `not_in_resource` (D3). Intronic and UTR input gives `not_coding` with the nearest residue. A `g.` dup with no transcript has no residue.
14. A typed c. or genomic change that gnomAD lacks (`F2RL1 c.477G>C`, `5-76833084-G-C`) still resolves to the residue. The row gives the true substitution (M>I via ATG>ATC). The minimum acceptable answer is residue 159.

## Open questions (the plan is silent)

1. **ClinVar records that are not packed.** Should the index carry a small map of every single-gene ClinVar record in the cache (VCV to gid, pos, class), so that `VCV000718860` (the plan's own example, PAR2 p.Ser363=, likely benign) says what and where it is? The rows assume yes (G096 to G098, G142, G317). Without the map they degrade to "not held" with no residue.
2. **RCV accessions** are not on disk (the caches hold RCV counts only). There are no RCV rows. P2 needs an RCV to VCV map if `RCV…` input is wanted.
3. **Ranking across receptors** for bare changes (`M159I`): alphabetical, by allele count, or with PAR2 pinned? The rows check the set, not the order.
4. **Which residue a conflict card shows.** The pack `sequence` and `residues` table disagree at 5-HT2C 23 (C vs S), DRD3 9 (S vs G), GPR42 174 (W vs R) and OPSR 153/180 (L/S vs M/A). The rows use `sequence`, which is the model and what the `conflict` flag is computed against.
5. **Alternative isoforms.** Should the index ship isoform maps from the Ensembl cache (FFAR4 R270H, OPSB and LPAR2 UniProt + 3)? The rows expect FFAR4 R270H to resolve (G206).
6. **LPAR2 transcript frame.** gnomAD v4.1 annotates ENST00000407877.8 in a frame 3 codons longer than Ensembl serves for .8 today. Which frame should `ENST00000407877.8:c.` mean? The rows assume gnomAD's.
7. **Codon-level resolution** of typed c./g. changes that are not in gnomAD needs the P2 CDS cache. Is residue-only acceptable for P4?
8. **Pseudogenes** (NPY6R, TAAR3) have no transcript. Should `NPY6R c.100G>A` resolve to model residue 34 or say "no coding transcript"? The row keeps residue 34 as the answer under the model-numbering assumption.
9. **HGNC aliases and IDs** (`GPR11`, `HGNC:3538`) cannot be checked until the P2 HGNC cache exists. The validator checks only that the gid exists.
10. **Accepted forms not named in the plan:** Y ids and PLINK `23`, `dbSNP:` prefixes, a trailing `;`, `H1` as helix 1 (the rows say it is not offered).
11. **Multi-gene ClinVar records** (CNVs listing F2RL1 among 697 genes): the rows expect `not_in_resource` with no residue.
12. **Size.** The table has 387 rows, against the plan's estimate of about 250. Every notation in plan section 3 has at least one PAR2 row, which accounts for 118 rows.

## Coverage (387 rows)

- **expect:** target 238, not_in_resource 50, receptor 44, targets 18, ambiguous 14, unrecognised 14, not_coding 9.
- **Receptors:** 71 distinct receptors are named as single targets or receptor answers (all 283 appear in the bare generic-number rows). Breadth comes from 29 gnomAD rows (famous polymorphisms where the packs hold them, otherwise the highest-AC allele with an rsID, in rotating notations) and 30 rows built from packed ClinVar P/LP records across 26 receptors (the packs hold 488 records in 40 receptors).

## Decisions on the open questions (main session, 2026-11-04)

1. ClinVar: the index maps every single-gene ClinVar record (all classes) from VCV/Variation ID to its residue, and the card shows the record's own classification. Only P/LP feed any enrichment wording.
2. RCV: accept the syntax. With no RCV map on disk, answer "RCV accessions are not indexed; search the VCV or the variant". Fetching an RCV map is deferred.
3. Cross-receptor bare change: order by (the substitution is observed in gnomAD or ClinVar) first, then the receptor has a matching reference residue, then gene symbol.
4. Conflict cards use the model `sequence`, as the rows do. The `sequence`/`residues` disagreements (5-HT2C 23, DRD3 9, GPR42 174, OPSR 153/180) are logged for the P8 data refresh.
5. Isoforms: ship pack↔MANE and pack↔UniProt-canonical maps. Other isoforms (e.g. FFAR4 R270H) are deferred; the card gives a hint when a residue number fits a known alternative isoform.
6. `ENST00000407877.8:c.`: the frame gnomAD used.
7. c./g. changes not in gnomAD resolve to the residue. When the P2 CDS cache exists, the reference base is checked and a mismatch is reported.
8. c. input on a pseudogene with no transcript gives "no coding transcript in this resource". Residue queries still work from the model sequence.
9. Checked after the P2 HGNC cache lands.
10. Accept `X`, `Y`, `23` (→ X) and `24` (→ Y). `H1` is always a receptor (HRH1), never helix 1.
11. Multi-gene or CNV ClinVar records: not_in_resource, with no residue.
12. 387 rows is fine.

Model/transcript conflicts (ADRB1 389, FSHR 680 and others, where the model carries the gnomAD alternate): the card must state that the model residue differs from the reference genome. It must not apply the reference-swap note.
