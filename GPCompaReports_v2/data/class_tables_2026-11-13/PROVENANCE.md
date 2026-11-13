# Provenance: class-wide tables of the Statistics page (2026-11-13)

Written by `scripts/build_class_tables.py` (run by hand; the site build never runs it). The build reads
these files through `analysis/class_results.py`, which asserts each sha256 below (`PINS`), and
`tests/test_statistics_class_results.py` checks the pins, this table and, where the sources exist on the
machine, that each copy equals its source byte for byte. `checks.json` holds all 31 checks the script
passed before writing, with the sha256 of every input.

| File | sha256 | How | Source or rule |
|---|---|---|---|
| `positions.tsv` | `0993b72f402e3c086d9c611f13074fec251d91982613c21d30c5ef9fcf058173` | recomputed | 368 recurrent positions (CFR in 3 or more receptors), canonical rule, GPCRdb residue maps with GPR4 on its own GPCRdb entry; sorted by CFR score |
| `pairs.tsv` | `65632b35398a178711d2983b2d07eba8f0a6fb4636a75a60573ba4a54d7f18b2` | recomputed | 2,231 distinct pairs of generic positions joined by an above-threshold contact (both residues CFRs), receptors per pair, both ends in the top 50 or not; same run |
| `partner_diversity.tsv` | `a377a11b89831d969a2f4227b6447d2e8ed4367f01ccf23d4c3b28600f339b56` | recomputed | per recurrent position: distinct partner positions and the most frequent exact partner; same run |
| `positions_below_recurrence.tsv` | `faee673c66ca0c26c2891d717e5eb9f76115a7f1bc9d0c5bd1be1527caca9c1b` | recomputed | generic positions that are CFRs in 1 or 2 receptors (below the recurrence rule); same run |
| `activation_reference.tsv` | `ec18984c0588cecb820a5e29d833b8a8db8be7db9497716bc2cc452a9b7fbaa5` | derived | 39 known activation positions: the Zhou et al. 2019 common activation pathway (34 residue pairs) plus the class A motifs (D2.50, DRY, PIF, CWxP, NPxxY, the sodium pocket, 6.30); ordered by rank in the recovery universe |
| `activation_motifs.json` | `4362387eca0c737accdbc3da37a28c2c982c49a137ab4f362bb78276c933bc81` | derived | the five named motifs and their 16 positions |
| `activation_recovery.tsv` | `f4f5e00c968f16dc7d5542b56fdc97cb11ea15de39afd467b9754f8511013715` | derived | the 262 structure positions (GPCRdb structure-based numbers) numbered in at least half of the receptors that hold a recurrent position, in CFR score order; each takes the highest CFR score among its generic numbers (generic_number = that one, which can itself be numbered in fewer receptors); with the cumulative count of reference positions and the count expected by chance (rank x 39 / 262) |
| `segments.tsv` | `abfa05d52739230f890b2551f8d2d73fe2a1b3a99508f36e40c868b1aa2c0f60` | recomputed | mean |dRRCS| per contact endpoint by segment (17 segments, ICL4 included), all contacts, GPCRdb residue maps with GPR4 on its own GPCRdb entry; the canonical maps reproduce ed1_full_segments.tsv, which leaves out ICL4 |
| `interfaces.tsv` | `1c812964181c628778c678014ca3500111027a4b26eeac21c75715c9f67d9303` | recomputed | mean |dRRCS| per contact between two of TM1 to TM7, all contacts, same maps; supported = at least 50 contacts; the canonical maps reproduce ed1_full_interfaces.tsv |
| `conservation_positions.tsv` | `0061d9502a360e5cb6e3dbcbc46b89754a30783c3b0f90e963f90bc53fb3068a` | byte copy | `~/Documents/gpcr_synth/NEW_manuscript/GPCompaRe_Finishing_2026-10-31/deliverables/03_main_figures/source_tables/F3a_conservation_by_generic_position.tsv` |
| `../supplement_2026-11-05b/FigS4b_recurrence_bands.tsv` | `9f385757cb416e88d7553ea47ee2b07f4a666929581cc708881d629edb9651cb` | byte copy | `~/Documents/gpcr_synth/NEW_manuscript/GPCompaRe_Finishing_2026-10-31/deliverables/02_supplement/source_tables/FigS4b_recurrence_bands.tsv` |
| `../supplement_2026-11-05b/ed14_a_conservation_strata_plotdata.tsv` | `0bc8d101b4e3fdb7c9a4c607ba11c6f1d1df9706af0eb9f5967b815a6c38bedd` | byte copy | `~/Documents/gpcr_synth/NEW_manuscript/GPCompaRe_Finishing_2026-10-31/deliverables/02_supplement/code/panels/ed14_a_conservation_strata_plotdata.tsv` |

Rule of the recomputed tables: per receptor, contact pairs with |dRRCS| at or above mean + SD of its
|dRRCS| (at least 0.2), from the RRCS batch run 2026-02-02; a residue is a CFR when it is in one such
pair; a generic position is recurrent when it is a CFR in 3 or more of the 283 receptors; CFR score =
(receptors / max receptors + mean |dRRCS| / max mean |dRRCS|) / 2.

## Why copied, not recomputed in the build

The canonical GPCRdb residue maps (figures_overhaul `gpcrdb_residues/`) are outside the repository. The
script asserts that they reproduce the class tables exactly, then changes one receptor: GPR4, whose
canonical map was GPR42's, is numbered with its own GPCRdb entry. That moves 8.48x48 from 112 to 113
receptors (39.9293%, mean |dRRCS| 5.2107, CFR score 0.46452, rank 36) and shifts some ranks outside the
top 50; the top 50 and its order are unchanged. A build-time recompute on the Studio packs (every
receptor on the current GPCRdb numbering) gives the same top 50 but differs from these tables at 6
positions outside the top 50, by 1 or 2 receptors, so the build reads these files instead. The
segment and interface tables are recomputed the same way: the canonical maps reproduce the ed1 tables
(which leave out ICL4, 35 endpoints), and GPR4 on its own entry moves TM1 to 0.7450 and TM7 to 1.0747.

The activation reference is the known set of the cfr_main_quest e19 analysis (Zhou et al. 2019 pathway
residues, from the Studio's zhou2019.ts, plus the class A motif set). The recovery curve on the
canonical ranking reproduces the e19 cut points (8, 14, 16, 18, 20, 21, 23, 27, 28 known positions in
the first 10, 20, 30, 40, 50, 60, 80, 100, 120), and the corrected ranking gives the same cut points.
