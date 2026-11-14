# Provenance: corrected AlphaMissense comparison (Statistics page, section D)

`FigS4_S7_summary_modelnum_2026-11-05b.json` is a byte-for-byte copy of the
supplement's summary for Supplementary Figure S4, Figure S5 and Table S7
(edition 2026-11-05b). The Statistics page reads its section D numbers from
this file only, and rounds once, at display.

| | |
|---|---|
| Source | `NEW_manuscript/GPCompaRe_Finishing_2026-10-31/deliverables/02_supplement/source_tables/FigS4_S7_summary_modelnum_2026-11-05b.json` |
| sha256 | `d2e15f4a5da571704a8769bdc3d1cd0be10dcd0c57fed7865fef7ab5fec281bc` |
| Written by | `deliverables/02_supplement/code/fig3_without_gpr3_gpr4_xcr1_modelnum.py ... --full-precision` |
| Input table | `figures_overhaul/figure3/fig3_audit_variants_complete_modelnum_2026-11-05b.tsv` (sha256 `be52356ed7eba2b1a980487e91a9a7b40f583b9190be94e7713725abc56c2686`) |
| Correction record | `deliverables/04_handoff/CORRECTIONS_2026-11-05.md`, sections 1 to 4 and "Second correction (edition 2026-11-05b)" |

What the numbers are: 276 receptors (GPR3, GPR4 and XCR1 excluded because
their annotation layers had been matched to GPR31, GPR42 and CXCR1); the
February gnomAD v4.1.0 alleles placed on the model's own residue numbering;
four OXER1 AlphaMissense classes taken from their own substitution. Unique
substitutions with an AlphaMissense call at the top 50 positions by CFR score
against other generic-numbered positions: 7,268 and 11,040 scored, of which
6,155 and 9,369 decisive (1,113 and 1,671 ambiguous). Odds ratio on decisive
calls 2.613 (Woolf 95% CI 2.444 to 2.794); Mantel-Haenszel over conservation
quintiles 1.5418 (Robins-Breslow-Greenland 95% CI 1.4248 to 1.6683).

This replaces `data/manuscript_2026-08-24/figure3_enrichment.json` as the
source of section D. That file is the retired August analysis (279 receptors,
odds ratio 2.58, adjusted 1.52, 7,445 and 11,150) and is kept only for
`n_pairs_universe`, which is a contact-pair count unrelated to AlphaMissense.

`tests/test_statistics_am_section.py` checks that the copy matches the
supplement file when that is present, and that the built page shows exactly
these values and none of the retired ones.

## Two band tables for the Statistics page (added 2026-11-13)

Byte copies, written by `scripts/build_class_tables.py`; `analysis/class_results.py` asserts the sha256
and `tests/test_statistics_class_results.py` checks the pins and, where the sources exist, byte equality.
Same 276-receptor allele set as the summary above.

| File | Source | sha256 |
|---|---|---|
| `FigS4b_recurrence_bands.tsv` | `deliverables/02_supplement/source_tables/FigS4b_recurrence_bands.tsv` | `9f385757cb416e88d7553ea47ee2b07f4a666929581cc708881d629edb9651cb` |
| `ed14_a_conservation_strata_plotdata.tsv` | `deliverables/02_supplement/code/panels/ed14_a_conservation_strata_plotdata.tsv` | `0bc8d101b4e3fdb7c9a4c607ba11c6f1d1df9706af0eb9f5967b815a6c38bedd` |

`FigS4b_recurrence_bands.tsv`: AlphaMissense classes (pathogenic, ambiguous, benign) of the unique
substitutions by recurrence band (receptors in which the position is a CFR: fewer than 3, 3 to 28, 29 to
70, 71 to 141, 142 to 212, 213 or more); 402 positions, 15,519 decisive calls (5 fewer than the summary:
calls on generic-numbered residues without a modeled contact). `ed14_a_conservation_strata_plotdata.tsv`:
predicted pathogenic share of decisive calls by conservation fifth, top 50 (`lead_*`) against other
positions (`rest_*`); 15,507 decisive calls (12 without a conservation score fall outside). The sibling
meta JSON of the second file quotes superseded values and is not copied.

## Substitutions without an AlphaMissense class (added 2026-11-14)

| File | sha256 |
|---|---|
| `am_unclassified.tsv` | `c445a920a1ae604390e7f4f09b7e7775764c579503e325d7db96d4d1b6434b0e` |

Written by `scripts/count_am_unclassified.py` from the audit table behind the summary above
(`fig3_audit_variants_complete_modelnum_2026-11-05b.tsv`, sha256 `be52356e...c2686`): the 1,260 rows with a
generic number, outside GPR3, GPR4 and XCR1, whose `am_status` is `unresolved` (483 at the top 50 positions, 49
receptors). The summary counts only the classified rows (the script asserts 7,268 and 11,040), so these are
outside every count of section 4. All but one are a second allele at a protein position whose first allele is
classified: the batch variant CSVs fill the AlphaMissense column for the first allele at each position only.
The Studio packs score all 1,260 (424 pathogenic, 641 benign, 195 ambiguous). The page states the counts in the
method note of the AlphaMissense comparison (`class_variants.json` `unclassified`); the summary itself is
unchanged.
