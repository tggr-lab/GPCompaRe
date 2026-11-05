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
