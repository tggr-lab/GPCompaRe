# Database search v2, and Studio features in the database: plan (2026-11-04)

Status: **approved direction 2026-11-04.** Yamir's decisions:
- **D1:** host the GPCRdb models now, with CC BY 4.0 attribution.
- **D2:** search uses the Studio packs now; a report-page data refresh follows later (P8).
- **D5:** ship HGNC, UniProt and a curated common-name list; GtoPdb is used for checking only and is not shipped.
- **D3 and D4:** the defaults stand (parse non-missense input and resolve it to the residue; port the Studio parser code).
Inputs: four read-only audits run on 2026-11-04.
1. Database search: executed classify() against the Nov 1 stage.
2. Studio search and packs.
3. Studio features and 3D.
4. Variant-notation conventions and the local data inventory.

Ground rules carried over:
- The database is the main product. Studio features are added to it, and no database page is replaced by Studio.
- Work on feature branches. Make atomic commits. Compare against a baseline. Never deploy automatically.
- Deploys go through `scripts/deploy_pages.sh` with a stage, after Yamir's review.
- Nothing scientific changes. The report pages' numbers stay frozen unless D2 below says otherwise.

## 1. Where we start

**Database search today.** It is two tabs on Browse plus a topbar box.
- It accepts `GENE M159I` and `GENE p.Met159Ile`.
- It accepts `GENE c.477G>A`, but only as an exact string match.
- It accepts `GENE 159`, but only when that residue carries a variant.
- It accepts rsIDs, GRCh38 gnomAD IDs and positions, and generic numbers (`6.48`, `3.50x50`).

It fails on most other notations a geneticist would use:
- `p.(Met159Ile)`, a bare `M159I` without a receptor, and a capital `P.`.
- Stop codons, `=`, fs, del and dup.
- `NM_…:c.`, `ENST…:c.` and `NC_…:g.`.
- GRCh37 coordinates (silently read as GRCh38), VCF rows, SPDI, and ClinVar VCV IDs.
- `F6.48` and `R^3.50`.
- UniProt accessions, and synonyms such as β2AR or "beta2 adrenergic".
- A residue with no gnomAD variant.

Other UX gaps:
- Unrecognised topbar input lands silently on an empty receptor table.
- There are no JS tests for the parser.

**Data limits in the current index (5 MB, lazy shards).**
- gnomAD v4.1.0 missense alleles at contact residues only: 29,213 alleles.
- 44% of those alleles have no AlphaMissense score (the known join gap).
- GPR3, GPR4 and XCR1 carry the wrong-receptor layers.
- No transcript IDs, no GRCh37, no ClinVar.

**Studio search.** Its parser (`src/app/search/query.ts`, 162 lines) is pure and imports nothing. It is tested by `tests/search.test.ts`.
- It already handles `p.()`, ClinVar VCV and Variation IDs, the ClinVar title form, `F6.48`, and the reference-swap fallback.
- It does not handle c./g./transcripts, GRCh37, stop codons, synonyms, or a cross-receptor bare change.

**Studio packs.** These hold more and better data, and all are on disk:
- gnomAD v4.1.2, all missense: 145,345 alleles, with the transcript ID (ENST plus version) in provenance.
- ClinVar 2026-10-11, the full per-gene cache including SPDI and NM/NP/ENST/ENSP maps. Only 488 P/LP missense records are packed.
- Ensembl transcripts, GPCRdb numbering for all 283 receptors, and per-substitution AlphaMissense.
- Isoform maps: lpar2 is shifted by −3, and oxer1 also differs. Both are already reconciled in the packs.

**Not on disk:**
- the HGNC alias and previous-symbol set (GtoPdb synonyms v2026.3.1 are on disk)
- the MANE summary
- exon and CDS tables
- any GRCh37 coordinates
- dbSNP merge history

**3D.** Studio's viewer is Mol* 5.13.1, a lazy 851 KB gzip chunk.
- `src/app/v2/three/viewer.ts` is React-free. Superposition (kabsch.ts) and the scene are pure TS.
- The database's own GPCRdb model PDBs are 574 files, about 33 MB gzip.
- GPCRdb's download URL sends ZIP attachments with no CORS header, so models must be self-hosted.
- **Their redistribution licence is unresolved.** This is why Studio's production build leaves them out (`launch-audit.md`, `target.ts:8`). The 2026-10-20 draft email to GPCRdb was never sent.

## 2. Decisions needed from Yamir before building (blocking)

**D1. Model redistribution (blocks all 3D work in the database).**
- (a) Send the GPCRdb/Heo–Feig licence query and wait.
- (b) Host the models under GPCRdb's CC BY 4.0 site notice, with attribution, judging that sufficient.
- (c) No 3D in the database for now. Keep "Open in Studio" for the user's own structures only.
- My recommendation: (a) now, and build the 3D code behind a flag so it ships when the answer comes.

**D2. Which variant data search uses.**
- (a) Search over the packs (gnomAD v4.1.2, all missense, correct receptors, AlphaMissense complete). Search results would then show variants that the report pages (v4.1.0, contact residues) do not list. Result cards would say so and carry the release label.
- (b) Search only what the report pages show.
- (c) Option (a) now, then a separate "data refresh" release that rebuilds the report-page variant tables from the packs. That release would also fix GPR3/GPR4/XCR1, the AlphaMissense gap and the LPAR2/OPSB offsets, which are currently disclosed in Studio's `differences.json`.
- My recommendation: (c). (b) leaves known-wrong data in search.

**D3. Non-missense input** (stop, synonymous, frameshift, splice, UTR).
- The resource is residue-level and holds missense data only.
- Proposal: parse them all, resolve to the residue, and say plainly what the database holds there and what it does not, for example "nonsense and frameshift variants are not analysed here".

**D4. Studio code licence for the port.** The repo has no LICENSE file. Porting parser code into the database repo is the owner's call. You own both, so this is a formality, but say yes.

**D5. Alias sources.**
- HGNC (CC0) and UniProt (CC BY) are fine.
- GtoPdb names are CC BY-SA 4.0. Using them in the shipped index probably brings share-alike terms to that file.
- Proposal: HGNC plus UniProt plus a hand-curated list of common names (PAR2, β2AR, 5-HT1A and similar). GtoPdb is used only to check that list, never shipped.

## 3. What "any notation" will mean

The full spec table is in the notation audit, kept in the session transcript. Everything below resolves to one or more **(receptor, residue, optional substitution, optional allele)** targets.

| Family | Accepted forms (examples for PAR2 p.Met159Ile) |
|---|---|
| Protein | `p.Met159Ile`, `p.M159I`, `p.(Met159Ile)`, `M159I`, `Met159Ile`, `Met-159-Ile`, `M159→I`, `M159>I`, `159M>I`; any case including `P.`; stop forms `Ter`, `*` and `X` (also parsed, see D3); `p.Met159=`; fs/del/dup/ins/ext parsed to the residue |
| Residue | `M159`, `Met159`, `F2RL1 159`, `residue 159`, `PAR2 Met159`; works for every residue, not only those with variants |
| Coding | `c.477G>A`, `477G>A`, `G477A`, `NM_005242.6:c.477G>A`, `NM_005242:c.477G>A` (version resolved, mismatch flagged), `ENST00000296677(.5):c.477G>A`, the ClinVar title form; intronic or UTR forms (`c.477+1G>A`, `c.-23C>T`) give a "not a coding residue" answer with the nearest residue |
| Genomic | `5-76833084-G-A`, `chr5:76833084:G:A`, `chr5_76833084_G_A`, `5 76833084 . G A` (VCF row, tabs or spaces), `chr5:76833084`, `5:76,833,084`, `chr5:76833084-76833084`, `NC_000005.10:g.76833084G>A`, SPDI `NC_000005.10:76833083:G:A`. The assembly is detected by which gene window contains the position, and GRCh37 is accepted with a label |
| IDs | `rs115885685` (merged rsIDs: if a merge table is cheap), ClinVar `VCV000718860(.3)`, `RCV…`, `ClinVar 718860`, gnomAD IDs |
| Generic numbers | `3.50`, `3x50`, `3.50x50`, `R3.50`, `R^3.50`, `Arg131(3.50)`, `R131^3.50`, `45.50`, `ECL2.50`, `8x50`; with or without a receptor |
| Receptor | HGNC symbol, previous symbols and aliases, UniProt accession and entry name, Ensembl gene, HGNC ID, NCBI Gene ID, common names. Greek and punctuation are normalised (β2AR, B2AR, beta-2, 5HT1A, 5-HT1A) |
| Combinations | `GENE + any of the above` with any separator (space, `:`, `,`, or `(GENE)`); a bare change with no receptor searches all 283 |

**Ambiguity rules.**
- An exact receptor-name match wins over a variant reading: `M1R`, `A2A`, `F2R`, `P2Y`, `D2`, `H1`. The other reading is offered as "Did you mean".
- A bare integer is a residue only when a receptor is given. Otherwise candidate IDs are offered.
- A multi-allele protein change (M159I = c.477G>A and c.477G>T) shows all alleles.
- A reference mismatch says "position 159 is Met in PAR2".
- Transcript numbering shifts (lpar2 −3, oxer1) are mapped to model numbering and flagged on the card.

**Canonical display on result cards.**
- `PAR2 (F2RL1, P55085) · Met159 · 3.36x36 · TM3`
- Then `p.Met159Ile (M159I)`, `NM_005242.6:c.477G>A`, `5-76833084-G-A (GRCh38) · 5-76128909-G-A (GRCh37)`, and `rs115885685`.
- Then gnomAD AF and AC, AlphaMissense, ClinVar class and stars with a link, conservation, CFR status, max |ΔRRCS|, and number of changing contacts.
- Links: open the report at this residue (snake plot or variants table), and open in Studio.

## 4. Architecture

- **One search box** everywhere: the topbar, Browse, a new `/search/?q=` results page, and autocomplete. The two Browse tabs stay as a fallback but use the same parser and resolver.
- **`static/js/search/` (plain ES modules, no build step):**
  - `normalize.js`: case, Unicode, Greek letters, separators.
  - `parse.js`: the Studio query.ts port plus the new families above. It returns ranked interpretations, never a single guess.
  - `resolve.js`: maps interpretations to targets using index shards.
  - `render.js`: the result cards, "Did you mean" and plain-language no-result messages.
  - The parser stays pure and deterministic, so the same tests can also run against the Studio parser later and the two can converge.
- **Index v2, built by the generator from cached sources.** No network at build time; separate fetch scripts write the caches, with provenance.
  - `meta.json`: receptors, aliases, transcripts (MANE NM and ENST with versions), gene windows for both assemblies, shard lists, data releases.
  - `residues/<gid>.json`: every residue (aa, BW and GPCRdb numbers, segment, CFR flag, max |ΔRRCS|, contact count, conservation, mean AlphaMissense). About 0.6 MB gzip in total.
  - `variants/<gid>.json`: alleles (pos, hgvsp, hgvsc, transcript, GRCh38 and GRCh37 IDs, rsIDs, AF/AC, AlphaMissense, ClinVar records).
  - `rsid/`, `clinvar/` and `locus/` shards as small lookup maps.
  - `seq.json`: all 283 sequences, about 90 KB, for the cross-receptor `M159I`.
  - Estimated total 3–4 MB gzip, still lazy-loaded. A typical query touches 1–3 shards.
- **New fetch caches** (one time, with release dates written to `releases.json`):
  - HGNC complete set (aliases and previous symbols).
  - Ensembl REST for MANE exon and CDS coordinates on both assemblies (GRCh37 via the grch37 endpoint).
  - A GRCh37 liftover of every stored allele through the Ensembl map endpoint; verified for PAR2 as 5:76128909.
  - Optional: dbSNP merges for the stored rsIDs.

## 5. Phases and who does them

Agents are matched to the task: **Sonnet** for mechanical work, **Opus** where numbering, coordinates or parity must be exactly right. Main-session Opus plans and reviews each phase, and an independent reviewer (Astra/Codex, or a fresh Opus) checks the numbering work. Each phase ends with tests green and a short report, and a phase does not start before the previous one is reviewed.

| Phase | Work | Agent | Depends on |
|---|---|---|---|
| P0 | Your decisions D1–D5. A feature branch `feature/search-v2` off `release/2026-10-31` in db-next, and in Studio if any. Baseline stage hash manifest. | main | you |
| P1 | **Spec and golden tests first.** About 250 real-world query strings → expected targets, as a TSV. Cases: PAR2 M159I in all 30+ notations, ADRB2 R16G (reference swap), LPAR2/OXER1 shifted numbering, the GPR3/GPR4/XCR1 layers, P2RY8 pseudo-autosomal, NPY6R/TAAR3 pseudogenes, ambiguity cases (`M1R`, `A2A`, `F2R`, `6 48`), stop, fs and intronic inputs, GRCh37 inputs. | Opus | P0 |
| P2 | Fetch caches: HGNC, Ensembl MANE exons and CDS on both assemblies, GRCh37 liftover, optional dbSNP merges. Each with provenance and checksums. Validation: every stored allele's c. position maps back to its protein residue, and the GRCh37/GRCh38 pairs round-trip. | Sonnet fetch, then Opus validates | P0 (D2, D5) |
| P3 | Index v2 generator in `website/page_generators/search_index.py`, plus Python tests (sizes, coverage of all 283, numbering-shift assertions, no wrong-receptor layer). | Sonnet | P2 |
| P4 | `parse.js`, `normalize.js` and `resolve.js`, with a node:test suite running the P1 golden table (100% pass required) and property tests (any format round-trips to the same target). | Opus parser, Sonnet resolver | P1, P3 |
| P5 | UI: unified box, `/search/` page, autocomplete, result cards, "Did you mean", no-result help, gene-symbol URLs (`/GPCompaRe/F2RL1` → report), and deep links into the report (`#res=`, `#vq=`). Playwright smoke: 30 real queries, keyboard and mobile, no console errors. | Sonnet | P4 |
| P6 | Report-page additions that need no models. A ClinVar P/LP section from the packs (release labelled). A residue drawer (click a snake residue → card as in search). Studio's plain-language glossary aids where the database lacks them. | Sonnet | P3 |
| P7 | **3D (only after D1).** Studio publishes a small lazy embed module (`studio/embed/viewer.js`, built from `viewer.ts`, `kabsch.ts` and `scene.ts`; same Mol* look; shares the Studio's cached chunk). The database report gets a "Show 3D" button: paired models superposed, coloured by the report's own residue ΔRRCS, synced with the snake-plot selection. "Open in Studio" via a production `?db=<gid>` route (the dev route already does this). Models hosted stripped and gzipped (~33 MB). Mol* MIT notice and GPCRdb attribution added. | Sonnet build, Opus review | D1 |
| P8 | Optional data refresh (D2c): rebuild the report-page variant tables from the packs. This fixes GPR3/GPR4/XCR1, the AlphaMissense gap and the offsets. It goes through the freeze-test process with an explicit changelog of every changed number. | Opus | D2 |
| P9 | QA and release: full test suites, an independent review agent on the diff, privacy page update (Mol* and any new hosts), notices file, staged build, a Sonnet privacy audit as last time, then your review. Deploy only on your word. | Sonnet + Opus review | all |

The order gives value early. P1–P5 can ship on their own, as "search v2", without waiting on 3D or the data refresh.

## 6. Risks

- **Search and report disagree** if D2 is (a) or (c) before P8. Mitigation: every card shows its data release, and a line when the report page's table is older.
- **Numbering mistakes**, from isoform shifts, transcript versions or GRCh37. Mitigation: golden tests, round-trip validation, and an independent Opus review.
- **Index size creep.** Budget 4 MB gzip; the CI test fails above it.
- **Ambiguous receptor names.** Mitigation: exact-name-first ranking and visible alternatives.
- **Licence:** GtoPdb share-alike (D5), the model redistribution question (D1), and the Mol* notice.

## 7. Effort (rough)

| Phases | Estimate |
|---|---|
| P1–P5 | 2 to 3 working sessions with agents |
| P6 | 1 session |
| P7 | 1 to 2 sessions once D1 is settled |
| P8 | 1 to 2 sessions, plus freeze review |
