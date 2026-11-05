# Provenance: manuscript-derived cross-receptor statistics

These files are the scientific authority for the statistics page's
cross-receptor numbers. They were copied out of the final submission package
so that the site build depends only on this repository, never on an external
or removable directory.

## Source

| | |
|---|---|
| File | `GPCompaRe__Supplementary_Tables.xlsx` |
| Located at extraction time | `/media/yamir/OS/Users/yamam/Downloads/` (removable Windows volume, NOT a build dependency) |
| Source file date | 2026-08-24 |
| sha256 of source workbook | `456ebcad1d21a3371be888cf5d57bc685d6a739f898500433f5147fa64edeb31` |
| Extracted | 2026-08-26 |
| Extracted by | `scripts/extract_manuscript_tables.py` (read-only on the source) |

Figure 3 values in `figure3_enrichment.json` were transcribed from
`GPCompaRe__Main_Figures.pdf` page 3 and the Results paragraph of
`GPCompaRe_Main_Manuscript_final_24-08-26.docx`. They are not computed here.

## What each file is

| File | Sheet | Rows | Contents |
|---|---|---|---|
| `S3_top50_recurrent_cfr_positions.csv` | S3 | 50 | Top 50 recurrent CFR positions by composite CFR score, in the submitted order |
| `S4_all_recurrent_positions.csv` | S4 | 368 | Complete catalogue of recurrent positions (CFR in at least 3 receptors) |
| `S5_top20_recurrent_cfr_pairs.csv` | S5 | 20 | Top 20 recurrent CFR-CFR contact pairs |
| `figure3_enrichment.json` | n/a | n/a | Retired 2026-11-05 for the enrichment section (see `../supplement_2026-11-05b/PROVENANCE.md`); still read for `n_pairs_universe` only |

## Why these and not the site's own computation

Recurrence here was calculated from the **full GPCRdb residue maps for all
283 receptors**, which is what the manuscript analysis used. The site's own
per-receptor annotation files number a residue only when it took part in a
high-magnitude contact, so they cover a fraction of contact positions and
yield systematically lower recurrence counts.

The two give different answers, and the manuscript's is authoritative:

| | site annotation | full GPCRdb maps (submitted) |
|---|---|---|
| Recurrent positions (at least 3 receptors) | 356 | **368** |
| 3.50x50 | 261 / 283 (92.2%) | **274 / 283 (96.8%)** |
| CFR-CFR pair universe | 179 | **2,234** |

## Scope, and what deliberately did NOT change

These files feed the **statistics page only**: the ranked chart, the Top 50
table, the contact-pair table and the enrichment section.

Individual receptor reports are unchanged. They keep their own
report-generation data, including the snake plot's Core Functional colouring,
which is built from each receptor's own annotation file. Those 283 pages are
frozen against `tests/fixtures/freeze_manifest.json` and must stay
byte-identical.

## Notes carried over from the source sheets

S3: Top 50 recurrent Core Functional Residue generic positions, ranked by composite CFR score. / Supplementary Table S3 / Note: CFR score = (normalized recurrence frequency + normalized mean |ΔRRCS|) / 2 across 368 recurrent positions. The three most recurrent positions were 3.50×50 (274/283, 96.8%), 7.53×53 (254/283, 89.8%) and 6.48×48 (245/283, 86.6%).

S4: Complete catalogue of 368 recurrent generic positions, with recurrence breadth, magnitude and scaffold coverage. / Supplementary Table S4 / Note: Recurrence was calculated from GPCRdb residue maps for all 283 receptors. The Figure 2a scaffold includes TM1-TM7 and H8 positions present in at least 50% of receptors; loop positions are not included in that scaffold.

S5: Top 20 recurrent CFR-CFR contact pairs across the 283-receptor dataset. / Supplementary Table S5 / Note: Rankings were calculated across 2,234 unique contact pairs. The four most frequent pairs occurred in 169, 161, 156 and 152 of 283 receptors, respectively.
