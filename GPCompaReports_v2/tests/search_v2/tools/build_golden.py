#!/usr/bin/env python3
"""Build GPCompaReports_v2/tests/search_v2/golden_queries.tsv from the Studio packs (scratch generator, not shipped).

Every row's gid/pos/ref/alt/alleles is read from the pack files; nothing is typed by hand except the query strings,
the curated common names and the expectation class. GRCh37 coordinates come from Ensembl REST (map endpoint) and are
cached to tests/search_v2/grch37_liftover.tsv.
"""
import collections
import csv
import gzip
import json
import os
import sys
import time
import urllib.request

STUDIO = '/home/yamir/Documents/gpcr_synth/gpcompare_studio_web/.claude/worktrees/main-merge'
PACK = f'{STUDIO}/public/pack'
SRC = f'{STUDIO}/pack/sources'
OUT = '/home/yamir/Documents/gpcr_synth/.worktrees/db-next/GPCompaReports_v2/tests/search_v2'
CACHE = '/home/yamir/scratch/2026-11-04_search_golden/liftover_cache.json'

THREE = dict(A='Ala', R='Arg', N='Asn', D='Asp', C='Cys', Q='Gln', E='Glu', G='Gly', H='His', I='Ile', L='Leu',
             K='Lys', M='Met', F='Phe', P='Pro', S='Ser', T='Thr', W='Trp', Y='Tyr', V='Val')

index = json.load(open(f'{PACK}/index.json'))['receptors']
GIDS = [r['gid'] for r in index]
P = {g: json.load(open(f'{PACK}/{g}.json')) for g in GIDS}


def ens(g):
    f = f'{SRC}/ensembl/{g}.json'
    return json.load(open(f)) if os.path.exists(f) else None


_cv = {}


def cvraw(g):
    if g not in _cv:
        f = f'{SRC}/clinvar/{g}.json.gz'
        _cv[g] = json.load(gzip.open(f)) if os.path.exists(f) else None
    return _cv[g]


def seq(g):
    return P[g]['sequence']


def aa(g, pos):
    return seq(g)[pos - 1]


def gn_of(g, pos):
    return P[g]['residues'][pos - 1][3]


def variants(g):
    return P[g]['variants'] or []


def alleles_at(g, pos, ref=None, alt=None):
    return [v for v in variants(g) if v[0] == pos and (ref is None or v[1] == ref) and (alt is None or v[2] == alt)]


def allele(g, vid):
    for v in variants(g):
        if v[11] == vid:
            return v
    raise KeyError((g, vid))


def by_rsid(rs):
    out = []
    for g in GIDS:
        for v in variants(g):
            if rs in v[10]:
                out.append((g, v))
    return out


def gtx(g):
    gp = P[g]['provenance']['gnomad']
    return f"{gp['transcript']}.{gp['transcriptVersion']}"


rows = []
SEEN = set()


def row(query, category, expect, gid='', pos='', ref='', alt='', alleles=(), alternates='', assembly='na', note=''):
    if query in SEEN:
        raise SystemExit(f'duplicate query {query!r}')
    SEEN.add(query)
    rows.append(dict(query=query, category=category, expect=expect, gid=gid, pos=str(pos), ref=ref, alt=alt,
                     alleles=','.join(alleles), alternates=alternates, assembly=assembly, note=note))


def src(g, field):
    return f'src=public/pack/{g}.json:{field}'


WIN = collections.defaultdict(list)
for _g in GIDS:
    _ps = [(v[11].split('-')[0], int(v[11].split('-')[1])) for v in variants(_g)]
    for _c in {c for c, _ in _ps}:
        _xs = [p for cc, p in _ps if cc == _c]
        WIN[_c].append((min(_xs), max(_xs), _g))


def in_win(c, p):
    return [g for lo, hi, g in WIN.get(c, []) if lo <= p <= hi]


def sub_row(query, category, g, v_list, note='', assembly='na', expect='target'):
    """target row for one substitution with the given alleles (all same pos/ref/alt)."""
    pos, ref, alt = v_list[0][0], v_list[0][1], v_list[0][2]
    assert all((v[0], v[1], v[2]) == (pos, ref, alt) for v in v_list)
    alternates = ''
    if assembly == 'GRCh37':
        for v in v_list:
            c, p38 = v[11].split('-')[0], v[11].split('-')[1]
            L = lift_cache[f'{c}:{p38}']
            hits = in_win(c, L['pos37'])
            if hits:
                same = [(x, y) for x in hits for y in variants(x) if y[11].split('-')[1] == str(L['pos37'])]
                note += f' | GRCh37 {c}:{L["pos37"]} FALLS INSIDE the GRCh38 window of {",".join(hits)}'
                if same:
                    expect = 'ambiguous'
                    alternates = ' | '.join(f'change:{x}:{y[0]}:{y[1]}>{y[2]}' for x, y in same)
                    note += ' and GRCh38 alleles exist at that coordinate: offer both assemblies'
                else:
                    note += ' with no GRCh38 allele there: rank the reading that names a stored allele first (assumed)'
    row(query, category, expect, g, pos, ref, alt, [v[11] for v in v_list], alternates=alternates, assembly=assembly,
        note=(note + ' ' if note else '') + src(g, 'variants'))


# --------------------------------------------------------------------------------------------- liftover (GRCh37)
lift_cache = json.load(open(CACHE)) if os.path.exists(CACHE) else {}
_req = [0]


def _get(url):
    _req[0] += 1
    if _req[0] > 120:
        raise SystemExit('request budget exceeded')
    time.sleep(0.2)
    r = urllib.request.Request(url, headers={'Content-Type': 'application/json', 'Accept': 'application/json'})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(r, timeout=40) as h:
                return json.load(h)
        except Exception as ex:  # noqa: BLE001
            print('retry', url, ex, file=sys.stderr)
            _req[0] += 1
            time.sleep(5)
    raise SystemExit('Ensembl unreachable')


LIFT_USED = {}


def lift(chrom, pos):
    key = f'{chrom}:{pos}'
    if key not in lift_cache:
        m = _get(f'https://rest.ensembl.org/map/human/GRCh38/{chrom}:{pos}..{pos}:1/GRCh37?')['mappings']
        assert len(m) == 1, (key, m)
        mp = m[0]['mapped']
        assert mp['start'] == mp['end']
        s = _get(f"https://grch37.rest.ensembl.org/sequence/region/human/{mp['seq_region_name']}:{mp['start']}..{mp['start']}:1?")
        lift_cache[key] = dict(chrom37=mp['seq_region_name'], pos37=mp['start'], strand=mp['strand'], base37=s['seq'])
        json.dump(lift_cache, open(CACHE, 'w'), indent=1)
    LIFT_USED[key] = lift_cache[key]
    return lift_cache[key]


def id37(vid):
    c, p, r, a = vid.split('-')
    L = lift(c, int(p))
    assert L['strand'] == 1 and L['chrom37'] == c, (vid, L)
    assert L['base37'] == r[0], (vid, L, 'GRCh37 base differs')
    return f"{c}-{L['pos37']}-{r}-{a}", L['pos37']


# ============================================================================================ 1. PAR2 p.Met159Ile
g = 'par2_human'
M159I = alleles_at(g, 159, 'M', 'I')
assert sorted(v[11] for v in M159I) == ['5-76833084-G-A', '5-76833084-G-T']
GA = allele(g, '5-76833084-G-A')
GT = allele(g, '5-76833084-G-T')
assert GA[4] == 'c.477G>A' and GT[4] == 'c.477G>T' and gtx(g) == 'ENST00000296677.5'
for q in ['F2RL1 p.Met159Ile', 'F2RL1 p.M159I', 'F2RL1 p.(Met159Ile)', 'F2RL1 p.(M159I)', 'F2RL1 M159I',
          'F2RL1 Met159Ile', 'F2RL1 Met-159-Ile', 'F2RL1 M159→I', 'F2RL1 M159>I', 'F2RL1 159M>I',
          'F2RL1 P.MET159ILE', 'f2rl1 p.met159ile', 'F2RL1 P.Met159Ile']:
    sub_row(q, 'par2_protein', g, M159I, 'both alleles of the change (c.477G>A, c.477G>T)')
for q in ['PAR2 M159I', 'PAR2:p.Met159Ile', 'PAR2, M159I', 'M159I (PAR2)', 'F2RL1:M159I',
          'PAR-2 M159I', 'P55085:p.Met159Ile', 'PAR2_HUMAN p.Met159Ile', '  F2RL1    p.Met159Ile  ']:
    sub_row(q, 'par2_combination', g, M159I, 'receptor + change, separator/case variants')

# bare change across receptors: every receptor with Met at pack 159
m159 = [x for x in GIDS if len(seq(x)) >= 159 and aa(x, 159) == 'M']
m159i_alleles = [v[11] for x in m159 for v in alleles_at(x, 159, 'M', 'I')]
for q in ['M159I', 'p.Met159Ile', 'p.(Met159Ile)', 'Met159Ile']:
    row(q, 'bare_change', 'targets', ';'.join(m159), ';'.join(['159'] * len(m159)), 'M', 'I', m159i_alleles,
        note=f'complete=seq every receptor with Met at pack 159 ({len(m159)}); ranking among receptors is open (Q); src=public/pack/*.json:sequence,variants')
row('M159', 'bare_residue', 'targets', ';'.join(m159), ';'.join(['159'] * len(m159)), 'M',
    note='complete=seq residue-only, every receptor with Met at pack 159; src=public/pack/*.json:sequence')
row('Met159', 'bare_residue', 'targets', ';'.join(m159), ';'.join(['159'] * len(m159)), 'M',
    note='complete=seq; src=public/pack/*.json:sequence')

# residue forms
for q in ['F2RL1 M159', 'F2RL1 Met159', 'F2RL1 159', 'F2RL1 residue 159', 'PAR2 Met159', 'PAR2 p.Met159']:
    row(q, 'par2_residue', 'target', g, 159, 'M', note='residue only (card lists all 4 alleles at 159) ' + src(g, 'residues'))

# unseen substitution, mismatch, out of range
row('F2RL1 M159A', 'par2_protein', 'target', g, 159, 'M', 'A',
    note='no gnomAD allele, no ClinVar record: residue card + AlphaMissense for M>A; ' + src(g, 'am'))
row('F2RL1 p.Trp159Ala', 'reference_mismatch', 'not_in_resource', g, 159, 'M', 'A',
    note='typed Trp159; message "position 159 is Met in PAR2"; ' + src(g, 'residues'))
row('F2RL1 M160I', 'reference_mismatch', 'not_in_resource', g, 160, aa(g, 160), 'I',
    note=f'residue 160 is {THREE[aa(g,160)]}; ' + src(g, 'residues'))
row('F2RL1 M999I', 'reference_mismatch', 'not_in_resource', g, '', '', 'I',
    note=f'PAR2 has {len(seq(g))} residues; no residue 999; ' + src(g, 'sequence'))

# non-missense at 159 (D3: parse, resolve to residue, say not analysed)
for q, code in [('F2RL1 p.Met159=', '='), ('F2RL1 p.(Met159=)', '='), ('F2RL1 p.Met159Ter', '*'),
                ('F2RL1 M159*', '*'), ('F2RL1 M159X', '*'), ('F2RL1 p.Met159ProfsTer12', 'fs'),
                ('F2RL1 p.Met159del', 'del'), ('F2RL1 p.Met159dup', 'dup'), ('F2RL1 p.Met159_Tyr160insHis', 'ins')]:
    row(q, 'par2_nonmissense', 'not_in_resource', g, 159, 'M', code,
        note='non-missense: resolve to residue, say the class is not analysed; ' + src(g, 'residues'))
assert aa(g, 160) == 'Y'

# coding
for q, v in [('F2RL1 c.477G>A', GA), ('F2RL1 c.477G>T', GT), ('F2RL1 477G>A', GA), ('F2RL1 G477A', GA),
             ('NM_005242.6:c.477G>A', GA), ('NM_005242:c.477G>A', GA), ('ENST00000296677.5:c.477G>A', GA),
             ('ENST00000296677:c.477G>T', GT), ('nm_005242.6:C.477g>a', GA),
             ('NM_005242.6(F2RL1):c.477G>A (p.Met159Ile)', GA), ('NM_005242.6(F2RL1):c.477G>T (p.Met159Ile)', GT),
             ('PAR2 c.477G>A', GA)]:
    sub_row(q, 'par2_coding', g, [v], 'NM_005242.6 is MANE = ENST00000296677.5 (gnomAD transcript); src=pack/sources/clinvar/par2_human.json.gz:refseq')
sub_row('NM_005242.5:c.477G>A', 'par2_coding', g, [GA],
        'version mismatch (MANE is .6): resolve on the current version and flag the mismatch on the card')
sub_row('ENST00000296677.4:c.477G>A', 'par2_coding', g, [GA],
        'version mismatch (gnomAD/Ensembl .5): resolve and flag')
row('F2RL1 c.477G>C', 'par2_coding', 'target', g, 159, 'M', 'I',
    note='ATG>ATC is also Met159Ile but no gnomAD allele: residue 159 + AM for M>I; deriving alt needs the codon (CDS cache, P2); minimum acceptable = residue 159; ' + src(g, 'variants'))
row('F2RL1 c.477+1G>A', 'par2_noncoding', 'not_coding', g, 159, 'M', '',
    note='intronic form (synthetic; exon boundary not checked): not a coding residue, nearest residue 159')
row('F2RL1 c.-23C>T', 'par2_noncoding', 'not_coding', g, 1, 'M', '', note="5'UTR: nearest residue 1")
row('F2RL1 c.*45G>A', 'par2_noncoding', 'not_coding', g, len(seq(g)), aa(g, len(seq(g))), '',
    note=f"3'UTR: nearest residue {len(seq(g))} (last)")
row('NM_005242.6(F2RL1):c.1089T>C (p.Ser363=)', 'par2_nonmissense', 'not_in_resource', g, 363, aa(g, 363), '=',
    note='ClinVar VCV000718860.3 (Likely benign, synonymous); src=pack/sources/clinvar/par2_human.json.gz:records uid=718860')
assert aa(g, 363) == 'S'

# genomic GRCh38
for q, v in [('5-76833084-G-A', GA), ('5-76833084-G-T', GT), ('chr5:76833084:G:A', GA), ('chr5_76833084_G_A', GA),
             ('5:76833084 G>A', GA), ('5 76833084 . G A', GA), ('5\\t76833084\\trs115885685\\tG\\tT', GT),
             ('chr5\\t76833084\\t.\\tG\\tA\\t.\\tPASS', GA),
             ('NC_000005.10:g.76833084G>A', GA), ('NC_000005.10:76833083:G:A', GA),
             ('NC_000005.10:76833083:G:T', GT), ('CHR5:76833084:g:a', GA), ('GRCh38 5:76833084 G>A', GA)]:
    sub_row(q, 'par2_genomic', g, [v], 'GRCh38; \\t = TAB; SPDI is 0-based', 'GRCh38')
for q in ['chr5:76833084', '5:76,833,084', 'chr5:76833084-76833084']:
    row(q, 'par2_locus', 'target', g, 159, 'M', 'I', [GA[11], GT[11]], assembly='GRCh38',
        note='position only: the residue at this locus and every allele there; ' + src(g, 'variants'))
row('5-76833084-G-C', 'par2_genomic', 'target', g, 159, 'M', 'I', assembly='GRCh38',
    note='= c.477G>C (ATG>ATC, Met159Ile) not in gnomAD; minimum = residue 159 with no allele; ' + src(g, 'variants'))
row('5-76833084-A-G', 'reference_mismatch', 'not_in_resource', g, 159, 'M', '', assembly='GRCh38',
    note='genome reference at 5:76833084 is G (all stored alleles say so): reference mismatch message')
# GRCh37
ga37, p37 = id37(GA[11])
gt37, _ = id37(GT[11])
assert p37 == 76128909, p37
for q, v in [(ga37, GA), (gt37, GT), (f'chr5:{p37}:G:A', GA), (f'NC_000005.9:g.{p37}G>A', GA),
             (f'hg19 chr5:{p37} G>A', GA), (f'5\\t{p37}\\t.\\tG\\tT', GT)]:
    sub_row(q, 'par2_grch37', g, [v], f'GRCh37 detected by gene window (or accession .9 / label); card shows label GRCh37 and the GRCh38 id; liftover=5:{GA[11].split("-")[1]}>{p37}', 'GRCh37')
row(f'chr5:{p37}', 'par2_grch37', 'target', g, 159, 'M', 'I', [GA[11], GT[11]], assembly='GRCh37',
    note=f'GRCh37 position only; liftover=5:76833084>{p37}; ' + src(g, 'variants'))

# IDs
for q in ['rs115885685', 'RS115885685', 'rs 115885685', 'F2RL1 rs115885685']:
    sub_row(q, 'par2_id', g, M159I, 'one rsID, two alleles (G>A and G>T), one substitution')
for q in ['VCV000718860', 'VCV000718860.3', 'ClinVar 718860']:
    row(q, 'par2_id', 'not_in_resource', g, 363, 'S', '=',
        note='clinvar_raw=718860 ClinVar record is p.Ser363= (Likely benign, synonymous): not packed (P/LP missense only); assumes the index maps every single-gene ClinVar record in the cache to its residue (open question); src=pack/sources/clinvar/par2_human.json.gz:records')

# generic numbers on PAR2
assert gn_of(g, 159) == '3.36x36'
for q in ['F2RL1 3.36', 'F2RL1 3x36', 'PAR2 M3.36', 'PAR2 M^3.36', 'PAR2 Met159(3.36)', 'PAR2 M159^3.36']:
    row(q, 'par2_generic', 'target', g, 159, 'M', note='generic number 3.36x36 = residue 159; ' + src(g, 'residues'))
row('PAR2 F3.36', 'reference_mismatch', 'not_in_resource', g, 159, 'M',
    note='3.36 is Met159 in PAR2, not Phe; ' + src(g, 'residues'))
r350 = [r for r in P[g]['residues'] if r[3] == '3.50x50'][0]
row('PAR2 R3.50', 'par2_generic', 'target', g, r350[0], r350[1], note='DRY Arg; ' + src(g, 'residues'))

# receptor identifiers for PAR2
e = ens(g)
cv = cvraw(g)
assert e['geneId'] == 'ENSG00000164251' and cv['geneId'] == '2150'
for q, n in [('PAR2', 'curated common name'), ('F2RL1', 'HGNC symbol'), ('f2rl1', 'case'), ('PAR-2', 'curated'),
             ('par2', 'case'), ('P55085', 'UniProt accession; outranks the Pro55085 change reading (no such residue)'),
             ('PAR2_HUMAN', 'UniProt entry name'), ('ENSG00000164251', 'Ensembl gene; src=pack/sources/ensembl/par2_human.json:geneId'),
             ('HGNC:3538', 'HGNC ID (from the brief; verify against the P2 HGNC cache)'),
             ('Gene ID 2150', 'NCBI Gene ID; src=pack/sources/clinvar/par2_human.json.gz:geneId'),
             ('GeneID:2150', 'NCBI Gene ID'), ('protease-activated receptor 2', 'UniProt/HGNC name'),
             ('GPR11', 'HGNC alias (to confirm from P2 HGNC cache)')]:
    row(q, 'par2_receptor', 'receptor', g, note=n)

# ============================================================================================ 2. ADRB2 aliases, swap
g = 'adrb2_human'
G16R = alleles_at(g, 16, 'G', 'R')
E27Q = alleles_at(g, 27, 'E', 'Q')
assert aa(g, 16) == 'G' and aa(g, 27) == 'E' and len(G16R) == 1 and len(E27Q) == 1
for q in ['ADRB2', 'β2AR', 'B2AR', 'beta-2', 'beta2 adrenergic', 'β2-adrenergic receptor', 'P07550', 'ADRB2_HUMAN', 'Β2AR']:
    row(q, 'receptor_alias', 'receptor', g, note='curated common name / UniProt (D5)')
SWAP = 'reference swap: model and gnomAD have Gly16; card says "listed the other way round, as p.Gly16Arg"'
for q in ['ADRB2 p.Arg16Gly', 'ADRB2 R16G', 'β2AR R16G', 'B2AR p.(Arg16Gly)']:
    sub_row(q, 'reference_swap', g, G16R, SWAP)
for q in ['ADRB2 p.Gly16Arg', 'ADRB2 G16R', 'rs1042713']:
    sub_row(q, 'reference_swap', g, G16R, 'direct gnomAD orientation')
for q in ['ADRB2 p.Gln27Glu', 'ADRB2 Q27E']:
    sub_row(q, 'reference_swap', g, E27Q, 'reference swap: literature Gln27Glu, model and gnomAD Glu27 (p.Glu27Gln)')
sub_row('rs1042714', 'reference_swap', g, E27Q, 'direct')
row('ADRB2 Arg16', 'reference_swap', 'target', g, 16, 'G', note='residue-only, typed residue is the alt of a stored allele: residue 16 card with mismatch line "position 16 is Gly" and the G16R allele (assumed rule); ' + src(g, 'residues'))
a37, _ = id37(G16R[0][11])
sub_row(a37, 'grch37', g, G16R, 'GRCh37', 'GRCh37')
row('NM_000024.6(ADRB2):c.79= (p.Glu27=)', 'clinvar_nonmissense', 'not_in_resource', g, 27, 'E', '=',
    note='ClinVar VCV000017743 (Benign): the reference allele record of rs1042714; src=pack/sources/clinvar/adrb2_human.json.gz:records uid=17743')
row('VCV000017743', 'clinvar_nonmissense', 'not_in_resource', g, 27, 'E', '=',
    note='clinvar_raw=17743 reference-allele record, not packed; same index assumption as VCV000718860')
row('NM_000024.6(ADRB2):c.*34del', 'clinvar_noncoding', 'not_coding', g, len(seq(g)), aa(g, len(seq(g))), '',
    note="ClinVar VCV001178313 (Benign), 3'UTR: nearest residue = last")
# generic numbers on ADRB2
res = {r[3]: r for r in P[g]['residues'] if r[3]}
for q, gn in [('ADRB2 3.50', '3.50x50'), ('ADRB2 R^3.50', '3.50x50'), ('ADRB2 Arg131(3.50)', '3.50x50'),
              ('ADRB2 R131^3.50', '3.50x50'), ('ADRB2 3.50x50', '3.50x50'), ('ADRB2 W6.48', '6.48x48'),
              ('ADRB2 ECL2.50', '45.50x50'), ('ADRB2 8x50', '8.50x50'), ('ADRB2 D2.50', '2.50x50')]:
    r = res[gn]
    row(q, 'generic_receptor', 'target', g, r[0], r[1], note=f'{gn}; ' + src(g, 'residues'))
row('ADRB2 F6.48', 'reference_mismatch', 'not_in_resource', g, res['6.48x48'][0], 'W', note='6.48 is Trp286 in ADRB2')
row('ADRB2 Arg130(3.50)', 'reference_mismatch', 'target', g, 131, 'R',
    note='number and generic disagree (3.50 is Arg131): generic wins, flag "residue 130 is ' + THREE[aa(g, 130)] + '"; assumed rule')

# bare generic numbers across receptors
def gn_targets(q, gnfull, aa1=None, cat='generic_bare', extra=''):
    hits = [(x, r[0], r[1]) for x in GIDS for r in P[x]['residues'] if r[3] == gnfull and (aa1 is None or r[1] == aa1)]
    row(q, cat, 'targets', ';'.join(h[0] for h in hits), ';'.join(str(h[1]) for h in hits), aa1 or '',
        note=f'complete=gn:{gnfull}{":" + aa1 if aa1 else ""} {len(hits)} receptors {extra}; src=public/pack/*.json:residues')
    return hits


gn_targets('3.50', '3.50x50')
gn_targets('R3.50', '3.50x50', 'R')
gn_targets('R^3.50', '3.50x50', 'R')
gn_targets('6.48', '6.48x48')
gn_targets('F6.48', '6.48x48', 'F')
gn_targets('3x50', '3.50x50', extra='x form')
gn_targets('45.50', '45.50x50')
gn_targets('ECL2.50', '45.50x50')
gn_targets('8x50', '8.50x50')
# a generic where BW and GPCRdb numbers differ
diff = collections.Counter(r[3] for x in GIDS for r in P[x]['residues'] if r[3] and r[3].split('x')[0].split('.')[1] != r[3].split('x')[1])
bw_ne_x = sorted(diff, key=lambda k: -diff[k])[0]
gn_targets(bw_ne_x, bw_ne_x, extra='BW and GPCRdb differ here (bulge)')

# ============================================================================================ 3. reference conflicts
for gid, pos, qs, vid in [
    ('adrb1_human', 389, ['ADRB1 Arg389Gly', 'ADRB1 p.Gly389Arg'], '10-114045297-G-C'),
    ('5ht2c_human', 23, ['HTR2C Cys23Ser', '5-HT2C C23S', 'rs6318'], 'X-114731326-C-G'),
    ('fshr_human', 680, ['FSHR Asn680Ser', 'rs6166'], '2-48962782-C-T'),
    ('drd3_human', 9, ['DRD3 Ser9Gly', 'rs6280'], '3-114171968-C-T')]:
    v = allele(gid, vid)
    assert v[13] and aa(gid, pos) == v[2], (gid, v)
    for q in qs:
        sub_row(q, 'model_conflict', gid, [v], f'conflict: model residue {THREE[aa(gid,pos)]}{pos} = gnomAD alt; transcript reference {THREE[v[1]]}; card must not claim the model has {THREE[v[1]]}')
v = allele('adrb1_human', '10-114045297-G-C')
a37, _ = id37(v[11])
sub_row(a37, 'grch37', 'adrb1_human', [v], 'GRCh37', 'GRCh37')
row('PAR2 N30', 'model_conflict', 'target', 'par2_human', 30, 'N',
    note='residue 30: model Asn, Ensembl/gnomAD Ser (conflictPositions=[30]); ' + src('par2_human', 'provenance.gnomad.conflictPositions'))
v30 = [v for v in variants('par2_human') if v[0] == 30 and v[2] == 'G']
if v30:
    sub_row('PAR2 p.Ser30Gly', 'model_conflict', 'par2_human', v30, 'transcript ref Ser30, model Asn30')
else:
    row('PAR2 p.Ser30Gly', 'model_conflict', 'target', 'par2_human', 30, 'S', 'G',
        note='transcript ref Ser30 (ClinVar VUS VCV002590215), model Asn30, no gnomAD S30G: residue 30 with conflict line')

# ============================================================================================ 4. shifted numbering
g = 'lpar2_human'
lv = [v for v in variants(g) if v[12] is not None]
assert all(v[12] - v[0] == 3 for v in lv)
# unambiguous: tx position beyond the model, or model residue at tx position differs from ref
v_end = [v for v in lv if v[12] > len(seq(g))][0]
v_mid_unamb = [v for v in lv if v[12] <= len(seq(g)) and aa(g, v[12]) != v[1] and v[6] > 1][0]
v_mid_amb = [v for v in lv if v[12] <= len(seq(g)) and aa(g, v[12]) == v[1] and 50 < v[0] < 300][0]
for v, kind in [(v_end, 'tx position beyond model length'), (v_mid_unamb, f'model residue at {v_mid_unamb[12]} is not {v_mid_unamb[1]}')]:
    ref3, alt3 = THREE[v[1]], THREE[v[2]]
    sub_row(f'LPAR2 p.{ref3}{v[12]}{alt3}', 'shifted_numbering', g, [v],
            f'gnomAD numbering (ENST00000407877.8 as annotated in gnomAD v4.1, tx = pack + 3): {kind}; flag "transcript numbering" on the card')
    sub_row(f'ENST00000407877.8:{v[4]}', 'shifted_numbering', g, [v],
            'gnomAD c. numbering; NOTE today\'s Ensembl ENST00000407877.8 is 348 aa = pack, so this c. lies in a different frame than Ensembl now reports')
    sub_row(v[11], 'shifted_numbering', g, [v], 'genomic id is numbering-free', 'GRCh38')
ref3, alt3 = THREE[v_mid_unamb[1]], THREE[v_mid_unamb[2]]
row(f'LPAR2 p.{ref3}{v_mid_unamb[0]}{alt3}', 'shifted_numbering', 'target', g, v_mid_unamb[0], v_mid_unamb[1], v_mid_unamb[2],
    [v_mid_unamb[11]], note='pack/MANE numbering (NM_001395660.1 = ENST00000407877.8 today = model) ' + src(g, 'variants'))
v = v_mid_amb
ref3, alt3 = THREE[v[1]], THREE[v[2]]
other = alleles_at(g, v[12], v[1], v[2])
row(f'LPAR2 p.{ref3}{v[12]}{alt3}', 'shifted_numbering', 'ambiguous', g, v[0], v[1], v[2], [v[11]],
    alternates=f'change:{g}:{v[12]}:{v[1]}>{v[2]}',
    note=f'both readings valid: gnomAD numbering -> pack {v[0]} (allele listed); model numbering -> residue {v[12]} ({v[1]}) {"with alleles " + ",".join(o[11] for o in other) if other else "no allele"}; assumed rank: an allele whose own HGVS matches beats an unseen substitution; ' + src(g, 'variants'))
dropped = P[g]['provenance']['gnomad']['droppedVariants'][0]
row(f'LPAR2 {dropped[1]}', 'shifted_numbering', 'not_in_resource', g, '', '', '',
    note=f'gnomAD {dropped[0]} {dropped[1]}: {dropped[2]} (dropped by the pack); ' + src(g, 'provenance.gnomad.droppedVariants'))
row(f'NP_001382589.1:p.{ref3}{v[0]}{alt3}', 'shifted_numbering', 'target', g, v[0], v[1], v[2], [v[11]],
    note='MANE RefSeq protein = model numbering (identity); src=pack/sources/clinvar/lpar2_human.json.gz:refseq')
lv37 = v_mid_unamb
a37, _ = id37(lv37[11])
sub_row(a37, 'grch37', g, [lv37], 'GRCh37 on a shifted receptor', 'GRCh37')

for g, off, nm_mane, np_mane in [('mchr1_human', 69, 'NM_005297.4', 'NP_005288.4'), ('npff2_human', 102, 'NM_004885.3', 'NP_004876.3')]:
    xs = [v for v in variants(g) if v[12] is not None]
    assert all(v[0] - v[12] == off for v in xs), g
    # pick a common allele whose model residue at tx pos differs (unambiguous)
    xs.sort(key=lambda v: -v[6])
    v = [x for x in xs if aa(g, x[12]) != x[1]][0]
    ref3, alt3 = THREE[v[1]], THREE[v[2]]
    gene = P[g]['meta']['gene']
    sub_row(f'{gene} p.{ref3}{v[12]}{alt3}', 'shifted_numbering', g, [v],
            f'MANE/gnomAD numbering ({gtx(g)}, {nm_mane}) = pack - {off}; model is the longer UniProt isoform')
    sub_row(f'{gene} p.{ref3}{v[0]}{alt3}', 'shifted_numbering', g, [v], 'UniProt/model numbering')
    sub_row(f'{np_mane}:p.{ref3}{v[12]}{alt3}', 'shifted_numbering', g, [v], f'MANE RefSeq protein, +{off}')
    sub_row(f'{nm_mane}:{v[4]}', 'shifted_numbering', g, [v], f'MANE c. numbering, residue {v[12]} -> pack {v[0]}')
    row(f'{gene} 100', 'shifted_numbering', 'target', g, 100, aa(g, 100),
        alternates=f'residue:{g}:{100 + off}:{aa(g, 100 + off)}',
        note=f'bare residue number = model/UniProt numbering (assumed); transcript reading 100 = pack {100 + off} offered as "Did you mean"')

g = 'oxer1_human'
assert P[g]['provenance']['gnomad']['mapping']['offset'] == 0 and seq(g)[39] == 'M'
xs = sorted([v for v in variants(g) if v[0] > 60 and v[10]], key=lambda v: -v[6])
v = [x for x in xs if aa(g, x[0] - 39) != x[1]][0]
ref3, alt3 = THREE[v[1]], THREE[v[2]]
sub_row(f'OXER1 p.{ref3}{v[0]}{alt3}', 'shifted_numbering', g, [v],
        'gnomAD (ENST00000378661.3, 423 aa) = model numbering (offset 0)')
sub_row(f'NP_683765.2:p.{ref3}{v[0]-39}{alt3}', 'shifted_numbering', g, [v],
        'current MANE NP_683765.2 / ENST00000378661.4 (384 aa, starts at model Met40): pack = MANE + 39; src=pack/sources/clinvar/oxer1_human.json.gz:refseq')
sub_row(f'NP_683765.1:p.{ref3}{v[0]}{alt3}', 'shifted_numbering', g, [v], 'old RefSeq NP_683765.1 (423 aa) = model')
cpos = int(v[4][2:].split('>')[0][:-1])
sub_row(f'NM_148962.5:c.{cpos-117}{v[4][-3:]}', 'shifted_numbering', g, [v],
        'MANE c. = gnomAD c. - 117 (39 codons); assumes the N-terminal difference is contiguous CDS, verify with P2 CDS tables')
sub_row(f'ENST00000378661.3:{v[4]}', 'shifted_numbering', g, [v], 'gnomAD transcript version .3 = model numbering')
row(f'OXER1 p.{ref3}{v[0]-39}{alt3}', 'shifted_numbering', 'target', g, v[0], v[1], v[2], [v[11]],
    note=f'no version given, model residue {v[0]-39} is {THREE[aa(g, v[0]-39)]} so only the MANE reading fits: map +39 and flag; ' + src(g, 'variants'))

g = 'hrh2_human'
d = P[g]['provenance']['gnomad']['droppedVariants'][0]
row(f'HRH2 {d[1]}', 'shifted_numbering', 'not_in_resource', g, '', '', '',
    note=f'MANE HRH2 is 422 aa, model 359: {d[1]} ({d[0]}) is {d[2]}; ' + src(g, 'provenance.gnomad.droppedVariants'))
row(d[0], 'shifted_numbering', 'not_in_resource', g, '', '', '', assembly='GRCh38',
    note=f'gnomAD id of a dropped allele ({d[1]}): in the receptor but outside the model')

g = 'ffar4_human'
v = [x for x in variants(g) if 'rs116454156' in x[10]][0]
assert v[0] == 254 and aa(g, 270) == 'M'
sub_row('FFAR4 R270H', 'isoform_numbering', g, [v],
        'literature R270H is the long isoform (ENST00000371483.8, 377 aa); model/MANE R254H; requires the alternative-isoform map from the Ensembl cache (open question); model residue 270 is Met')
sub_row('FFAR4 p.Arg254His', 'isoform_numbering', g, [v], 'MANE numbering')
sub_row('rs116454156', 'isoform_numbering', g, [v], '')

# ============================================================================================ 5. GPR3/GPR4/XCR1, P2RY8, pseudogenes
for g, trap in [('gpr3_human', 'gpr31_human'), ('gpr4_human', 'gpr42_human'), ('xcr1_human', 'cxcr1_human')]:
    gene = P[g]['meta']['gene']
    assert ens(g)['symbol'] == gene and cvraw(g)['symbol'] == gene
    row(gene, 'wrong_receptor_layer', 'receptor', g, note=f'exact match must beat {trap} (prefix/substring); pack is the correct receptor (Ensembl symbol {gene}, {gtx(g)})')
    def single(x):
        return len({(y[0], y[1], y[2]) for y in variants(g) if x[10][0] in y[10]}) == 1
    v = sorted([x for x in variants(g) if x[10] and single(x)], key=lambda x: -x[6])[0]
    sub_row(f'{gene} p.{THREE[v[1]]}{v[0]}{THREE[v[2]]}', 'wrong_receptor_layer', g, alleles_at(g, v[0], v[1], v[2]),
            f'correct-receptor allele (old index had {trap} layers)')
    sub_row(v[10][0], 'wrong_receptor_layer', g, [x for x in variants(g) if v[10][0] in x[10]], '')
row('GPR31', 'wrong_receptor_layer', 'receptor', 'gpr31_human', note='its own receptor')
row('CXCR1', 'wrong_receptor_layer', 'receptor', 'cxcr1_human', note='not XCR1')

g = 'p2ry8_human'
v = sorted(variants(g), key=lambda x: -x[6])[0]
c, p, r, a = v[11].split('-')
assert c == 'X'
sub_row(v[11], 'pseudoautosomal', g, [v], 'PAR1: gnomAD lists the X id only', 'GRCh38')
sub_row(f'Y-{p}-{r}-{a}', 'pseudoautosomal', g, [v], 'PAR1 Y id: GRCh38 chrY PAR1 shares chrX coordinates, map to the X allele (assumed)', 'GRCh38')
sub_row(f'chrY:{p}:{r}:{a}', 'pseudoautosomal', g, [v], 'PAR1 Y', 'GRCh38')
sub_row(f'23-{p}-{r}-{a}', 'pseudoautosomal', g, [v], 'PLINK chromosome code 23 = X (assumed accepted)', 'GRCh38')
sub_row(f'P2RY8 p.{THREE[v[1]]}{v[0]}{THREE[v[2]]}', 'pseudoautosomal', g, alleles_at(g, v[0], v[1], v[2]), '')
a37, p37 = id37(v[11])
spanX = [int(x[11].split('-')[1]) for x in variants(g)]
inside = min(spanX) <= p37 <= max(spanX)
sub_row(a37, 'pseudoautosomal', g, [v], f'GRCh37 PAR1; GRCh37 position {"FALLS INSIDE" if inside else "is outside"} the GRCh38 P2RY8 window -> assembly detection {"is ambiguous here" if inside else "unambiguous"}', 'GRCh37')
cvp = P[g]['clinvar'][0]
row(f'VCV{cvp[5]:09d}', 'clinvar_id', 'target', g, cvp[0], cvp[1], cvp[2],
    [cvp[17]] if cvp[17] and any(x[11] == cvp[17] for x in variants(g)) else [],
    note=f'clinvar={cvp[5]} P2RY8 ClinVar {cvp[8]}; ' + src(g, 'clinvar'))

for g in ['npy6r_human', 'taar3_human']:
    m = P[g]['meta']
    row(m['gene'], 'pseudogene', 'receptor', g, note=f'pseudogene: no Ensembl protein-coding transcript, no variants; src=pack/sources/gnomad_unavailable.json')
    row(f"{m['gene']} M1", 'pseudogene', 'target', g, 1, 'M', note='residue answers still work')
    r = [x for x in P[g]['residues'] if x[3] == '3.50x50']
    if r:
        row(f"{m['gene']} 3.50", 'pseudogene', 'target', g, r[0][0], r[0][1], note='generic number on a pseudogene')
    row(f"{m['gene']} p.Met1Val", 'pseudogene', 'target', g, 1, 'M', 'V',
        note='no gnomAD/ClinVar data: residue card, "no variant data for this pseudogene"; AlphaMissense if present')
row('TAAR3', 'pseudogene', 'receptor', 'taar3_human', note='UniProt name TAAR3; pack gene symbol is TAAR3P (HGNC)')
row('NPY6R c.100G>A', 'pseudogene', 'not_in_resource', 'npy6r_human', 34, aa('npy6r_human', 34), '',
    note='no transcript: c. cannot be placed; answer "no coding transcript (pseudogene)" (residue 34 only if the model numbering is assumed, open question)')

# ============================================================================================ 6. residues with no variant
for g in ['adrb2_human', 'drd2_human', 'oprm_human', 'cnr1_human', 'ccr5_human', 'par1_human']:
    have = {v[0] for v in variants(g)}
    pos = [r[0] for r in P[g]['residues'] if r[0] not in have and r[2].startswith('TM')][0]
    gene = P[g]['meta']['gene']
    row(f'{gene} {aa(g,pos)}{pos}', 'no_variant_residue', 'target', g, pos, aa(g, pos),
        note=f'novar residue {gn_of(g,pos)} with no gnomAD allele: residue card still shown; ' + src(g, 'residues'))

# ============================================================================================ 7. breadth: gnomAD alleles
breadth = ['oprm_human', 'mshr_human', 'adrb3_human', 'ccr2_human', 'cx3c1_human', 'npsr1_human', 'mc4r_human',
           'cnr1_human', 'ccr5_human', 'drd2_human', '5ht1a_human', '5ht2a_human', 'hrh1_human', 'acm2_human',
           'oprd_human', 'agtr1_human', 'cxcr4_human', 'ox2r_human', 'nk1r_human',
           'aa2ar_human', 's1pr1_human', 'gpr35_human', 'mtr1b_human',
           'ffar1_human', 'hcar2_human', 'drd4_human', 'oxyr_human', 'acm1_human', 'par1_human']
breadth = [x for x in breadth if x in P]
famous = {'oprm_human': 'rs1799971', 'mshr_human': 'rs1805007', 'adrb3_human': 'rs4994', 'ccr2_human': 'rs1799864',
          'cx3c1_human': 'rs3732379', 'npsr1_human': 'rs324981', 'mc4r_human': 'rs2229616'}
forms = ['gene3', 'uni1', 'rsid', 'gnomad', 'enst', 'acc', 'chr', 'genec', 'entry', 'paren']
for i, g in enumerate(breadth):
    m = P[g]['meta']
    if g in famous:
        v = [x for x in variants(g) if famous[g] in x[10]][0]
    else:
        cands = sorted([x for x in variants(g) if x[10] and x[12] is None and not x[13]], key=lambda x: -x[6])
        v = cands[0]
    same = alleles_at(g, v[0], v[1], v[2])
    r3, a3 = THREE[v[1]], THREE[v[2]]
    f = forms[i % len(forms)]
    c, p, r, a = v[11].split('-')
    if f == 'gene3':
        q, al = f"{m['gene']} p.{r3}{v[0]}{a3}", same
    elif f == 'uni1':
        q, al = f"{m['uniprotName']} {v[1]}{v[0]}{v[2]}", same
    elif f == 'rsid':
        al = [x for x in variants(g) if v[10][0] in x[10]]
        q = v[10][0]
        if any((x[0], x[1], x[2]) != (v[0], v[1], v[2]) for x in al):
            q, al = f"{m['gene']} p.{r3}{v[0]}{a3}", same
    elif f == 'gnomad':
        q, al = v[11], [v]
    elif f == 'enst':
        q, al = f'{gtx(g)}:{v[4]}', [v]
    elif f == 'acc':
        q, al = f"{m['uniprotId']}:p.{v[1]}{v[0]}{v[2]}", same
    elif f == 'chr':
        q, al = f'chr{c}:{p}:{r}:{a}', [v]
    elif f == 'genec':
        q, al = f"{m['gene']}:{v[4]}", [v]
    elif f == 'entry':
        q, al = f"{g.upper()} p.({r3}{v[0]}{a3})", same
    else:
        q, al = f"p.{r3}{v[0]}{a3} ({m['gene']})", same
    sub_row(q, 'breadth_gnomad', g, al, f'form={f}' + (f' famous {famous[g]}' if g in famous else ' highest-AC allele with rsID'),
            'GRCh38' if f in ('gnomad', 'chr') else 'na')
    if i % 3 == 0:
        a37, _ = id37(v[11])
        if a37 == v[11]:
            sub_row(f'GRCh37 {a37}', 'grch37', g, [v], 'GRCh37 and GRCh38 coordinates are identical here (chr11p15.5): both readings give the same allele', 'GRCh37')
        else:
            sub_row(a37, 'grch37', g, [v], 'GRCh37 breadth', 'GRCh37')

# identical GRCh37/GRCh38 coordinate (DRD4, chr11p15.5)
v = [x for x in variants('drd4_human') if x[11] == '11-640099-A-G'][0]
a37, _ = id37(v[11])
assert a37 == v[11]
sub_row(v[11], 'grch37', 'drd4_human', [v], 'GRCh37 and GRCh38 coordinates are identical here (Ensembl map 11:640099 -> 11:640099): either assembly reading gives the same allele; label the card GRCh38 and say both agree', 'GRCh38')

# multi-substitution rsID and three-allele substitution
ms = None
for g in GIDS:
    by = collections.defaultdict(list)
    for v in variants(g):
        for rs in v[10]:
            by[rs].append(v)
    for rs, vs in by.items():
        if len({x[2] for x in vs}) == 3 and len({x[0] for x in vs}) == 1:
            ms = (g, rs, vs)
            break
    if ms:
        break
g, rs, vs = ms
row(rs, 'multi_allele', 'targets', g, vs[0][0], vs[0][1], ','.join(sorted({x[2] for x in vs})), [x[11] for x in vs],
    note='one rsID, three substitutions at one residue; alt is a list; ' + src(g, 'variants'))
for g in GIDS:
    grp = collections.defaultdict(list)
    for v in variants(g):
        grp[(v[0], v[1], v[2])].append(v)
    three = [vs for vs in grp.values() if len(vs) == 3]
    if three and g in ('5ht1b_human',):
        vs = three[0]
        sub_row(f"{P[g]['meta']['gene']} p.{THREE[vs[0][1]]}{vs[0][0]}{THREE[vs[0][2]]}", 'multi_allele', g, vs,
                'one substitution from three different nucleotide alleles (two codon positions)')

# bare c. across receptors
hits = [(x, v) for x in GIDS for v in variants(x) if v[4] == 'c.477G>A' and v[12] is None]
subs = {(v[1], v[2]) for _, v in hits}
assert len(subs) == 1
row('c.477G>A', 'bare_coding', 'targets', ';'.join(x for x, _ in hits), ';'.join(str(v[0]) for _, v in hits), *subs.pop(),
    [v[11] for _, v in hits], note=f'complete=hgvsc:c.477G>A every receptor whose gnomAD transcript has c.477G>A ({len(hits)}); refs differ per receptor; src=public/pack/*.json:variants')

# ============================================================================================ 8. ClinVar records from packs
cvgenes = [g for g in GIDS if P[g].get('clinvar')]
cforms = ['vcv', 'vcvver', 'varid', 'title', 'gene3', 'uni1', 'gnomad', 'nm', 'clinvarcolon', 'spdi']
k = 0
_first = [x for x in cvgenes if x != 'p2ry8_human'][:22]
for g in _first + [x for x in cvgenes if x in ('opsd_human', 'v2r_human', 'tshr_human', 'mc4r_human') and x not in _first]:
    m = P[g]['meta']
    recs = sorted(P[g]['clinvar'], key=lambda r: (-r[9], r[0]))
    rec = recs[0]
    raw = {r['uid']: r for r in cvraw(g)['records']}[str(rec[5])]
    f = cforms[k % len(cforms)]
    k += 1
    pos, ref, alt = rec[0], rec[1], rec[2]
    gal = [x for x in alleles_at(g, pos, ref, alt)]
    asm = 'na'
    if f == 'vcv':
        q = rec[6].split('.')[0]
    elif f == 'vcvver':
        q = rec[6]
    elif f == 'varid':
        q = f'ClinVar {rec[5]}'
    elif f == 'clinvarcolon':
        q = f'clinvar:{rec[5]}'
    elif f == 'title':
        q = raw['title']
    elif f == 'gene3':
        q = f"{m['gene']} {rec[3]}"
    elif f == 'uni1':
        q = f"{m['uniprotName']} {rec[4]}"
    elif f == 'gnomad':
        if not rec[17]:
            q = rec[6]
        else:
            q, asm = rec[17], 'GRCh38'
            gal = [x for x in gal if x[11] == rec[17]]
    elif f == 'nm':
        cpart = raw['title'].split(':', 1)[1].split(' ')[0]
        q = f'{rec[13]}:{cpart}'
        cid = rec[17]
        gal = [x for x in gal if x[11] == cid]
    else:  # spdi
        q, asm = raw['variations'][0][2], 'GRCh38'
        gal = [x for x in gal if x[11] == rec[17]]
    if f in ('gene3', 'uni1'):
        gal = alleles_at(g, pos, ref, alt)
    else:
        gal = [x for x in alleles_at(g, pos, ref, alt) if x[11] == rec[17]]
    row(q, 'clinvar_record', 'target', g, pos, ref, alt, [x[11] for x in gal], assembly=asm,
        note=f'clinvar={rec[5]} {rec[8]} {rec[9]}* form={f}; ' + src(g, 'clinvar'))
    if g == 'opsd_human':
        # more RHO rows: delins missense, gnomAD-absent ClinVar allele, GRCh37
        r = [x for x in P[g]['clinvar'] if x[5] == 279882][0]
        raw = {x['uid']: x for x in cvraw(g)['records']}['279882']
        row(raw['title'], 'clinvar_record', 'target', g, r[0], r[1], r[2], [], note=f'clinvar=279882 delins giving a single missense (MNV), no gnomAD id; ' + src(g, 'clinvar'))
        notg = [x for x in P[g]['clinvar'] if x[17] and not any(v[11] == x[17] for v in variants(g))][0]
        row(notg[17], 'clinvar_record', 'target', g, notg[0], notg[1], notg[2], [], assembly='GRCh38',
            note=f'clinvar={notg[5]} ClinVar allele id that gnomAD does not list ("In ClinVar, not in gnomAD"); ' + src(g, 'clinvar'))
        inb = [x for x in P[g]['clinvar'] if x[17] and any(v[11] == x[17] for v in variants(g))][0]
        a37, _ = id37(inb[17])
        row(a37, 'grch37', 'target', g, inb[0], inb[1], inb[2], [inb[17]], assembly='GRCh37',
            note=f'clinvar={inb[5]} GRCh37 id of a ClinVar P/LP allele; ' + src(g, 'clinvar'))
        row(f'RHO P23H', 'clinvar_record', 'target', g, 23, 'P', 'H',
            [v[11] for v in alleles_at(g, 23, 'P', 'H')],
            note='clinvar=' + ','.join(str(x[5]) for x in P[g]['clinvar'] if x[0] == 23 and x[2] == 'H') + ' classic adRP allele; ' + src(g, 'clinvar'))
        row('rhodopsin P23H', 'clinvar_record', 'target', g, 23, 'P', 'H', [v[11] for v in alleles_at(g, 23, 'P', 'H')],
            note='clinvar=' + ','.join(str(x[5]) for x in P[g]['clinvar'] if x[0] == 23 and x[2] == 'H') + ' common name rhodopsin')

# a missense VUS (not packed) and a multi-gene record
row('VCV002590215', 'clinvar_unpacked', 'not_in_resource', 'par2_human', 30, 'N', 'G',
    note='clinvar_raw=2590215 VUS p.Ser30Gly at the PAR2 conflict residue (model Asn30); not packed; same index assumption as VCV000718860')
row('VCV000058096', 'clinvar_unpacked', 'not_in_resource', '', '', '', '',
    note='clinvar_raw=58096 multi-gene CNV (697 genes incl. F2RL1): not a residue-level record')

# ClinVar non-coding / non-missense, real titles
CVNC = [('mc4r_human', '14318', 'not_in_resource', 35, '*'), ('opsd_human', '13029', 'not_in_resource', 344, '*'),
        ('v2r_human', '10842', 'not_in_resource', 71, '*'), ('mc4r_human', '14316', 'not_in_resource', 211, 'fs'),
        ('opsd_human', '13051', 'not_in_resource', 264, 'del'), ('opsd_human', '590911', 'not_in_resource', 184, 'fs'),
        ('acthr_human', '279974', 'not_in_resource', 193, 'delins'), ('acthr_human', '80762', 'not_in_resource', 106, '='),
        ('gnrhr_human', '16033', 'not_coding', 175, ''), ('mc4r_human', '327715', 'not_coding', 1, ''),
        ('opsd_human', '256381', 'not_coding', 348, ''), ('par1_human', '3038746', 'not_coding', 1, ''),
        ('gnrhr_human', '1205418', 'not_coding', None, '')]
for g, uid, exp, pos, code in CVNC:
    raw = {x['uid']: x for x in cvraw(g)['records']}[uid]
    t = raw['title']
    row(t, 'clinvar_nonmissense' if exp == 'not_in_resource' else 'clinvar_noncoding', exp, g,
        pos if pos else '', aa(g, pos) if pos else '', code,
        note=f'clinvar_raw={uid} {raw["germline"]["description"]}; ' + ('nearest residue' if exp == 'not_coding' and pos else 'residue') + f'; src=pack/sources/clinvar/{g}.json.gz:records'
        + ('; g. dup with no transcript: nearest residue needs exon tables (left blank)' if pos is None else ''))
# a nonsense typed in short forms
row('MC4R Y35*', 'nonmissense', 'not_in_resource', 'mc4r_human', 35, 'Y', '*', note='stop, short form')
row('MC4R p.Tyr35X', 'nonmissense', 'not_in_resource', 'mc4r_human', 35, 'Y', '*', note='stop, legacy X')
row('MC4R c.105C>A', 'nonmissense', 'not_in_resource', 'mc4r_human', 35, 'Y', '*',
    note='c. of the nonsense VCV000014318 (NM_005912.3): residue 35; deriving "stop" needs the codon')
row('CCR5 delta32', 'nonmissense', 'not_in_resource', 'ccr5_human', '', '', 'del',
    note='CCR5-Δ32 (rs333), 32-bp deletion: receptor CCR5 + "frameshift deletions are not analysed"; common-name form, residue not derivable from the text')
row('rs333', 'nonmissense', 'not_in_resource', '', '', '', '',
    note='rsID absent from every pack (CCR5-Δ32 deletion): "not a missense allele held here"')
row('rs6025', 'id_not_held', 'not_in_resource', '', '', '', '', note='F5 Leiden: rsID not in any pack (not a GPCR)')

# ============================================================================================ 9. ambiguity traps
def change_set(pos, ref):
    return [x for x in GIDS if len(seq(x)) >= pos and aa(x, pos) == ref]


f2 = change_set(2, 'F')
p2 = change_set(2, 'P')
d2 = change_set(2, 'D')
a2 = change_set(2, 'A')
h1 = change_set(1, 'H')
assert not h1
row('M1R', 'ambiguity', 'ambiguous', 'acm1_human', alternates='change:*:1:M>R',
    note='exact curated name (M1R = CHRM1) wins; "Did you mean Met1Arg" across all 283 (all start with Met)')
row('M1', 'ambiguity', 'ambiguous', 'acm1_human', alternates='residue:*:1:M',
    note='curated name M1 (muscarinic) vs residue Met1 everywhere')
row('A2A', 'ambiguity', 'ambiguous', 'aa2ar_human', alternates='residue:*:2:A',
    note=f'A2A receptor wins; the other reading Ala2Ala is synonymous ({len(a2)} receptors have Ala2)')
row('A2AR', 'ambiguity', 'receptor', 'aa2ar_human', note='unambiguous common name')
row('F2R', 'ambiguity', 'ambiguous', 'par1_human', alternates=f'change:*:2:F>R',
    note=f'HGNC symbol F2R (PAR1) wins; Phe2Arg reading matches {len(f2)} receptors: {";".join(f2) or "none"}')
row('P2Y', 'ambiguity', 'ambiguous', ';'.join(x for x in GIDS if P[x]['meta']['gene'].startswith('P2RY')),
    alternates='change:*:2:P>Y', note=f'no exact receptor; P2Y-family prefix list first; Pro2Tyr reading matches {len(p2)} receptors')
row('P2Y12', 'ambiguity', 'receptor', 'p2y12_human', note='exact UniProt name; not P2Y1 prefix')
row('P2Y1', 'ambiguity', 'receptor', 'p2ry1_human', note='curated common name P2Y1 = P2RY1 (exact) beats prefix P2Y10..P2Y14')
row('D2', 'ambiguity', 'ambiguous', 'drd2_human', alternates='residue:*:2:D',
    note=f'curated D2 = DRD2 wins; residue Asp2 reading matches {len(d2)} receptors')
row('H1', 'ambiguity', 'receptor', 'hrh1_human', note='curated H1 = HRH1; His1 reading matches no receptor (all start Met), so no Did-you-mean (helix-1 reading not offered: assumed)')
row('6 48', 'ambiguity', 'ambiguous', '', alternates='generic:6.48x48',
    note='space-separated generic: offer 6.48 (Did you mean); a bare pair of integers is not a residue without a receptor')
row('ADRB2 6 48', 'ambiguity', 'ambiguous', 'adrb2_human', res['6.48x48'][0], 'W', alternates='residue:adrb2_human:6:' + aa('adrb2_human', 6),
    note='with a receptor: generic 6.48 (Trp286) preferred over residue 6; assumed')
row('159', 'ambiguity', 'ambiguous', '', alternates='clinvar:159 | gene_id:159',
    note='bare integer without receptor: not a residue; candidate IDs only (ClinVar Variation ID, NCBI Gene ID)')
row('2150', 'ambiguity', 'ambiguous', 'par2_human', alternates='clinvar:2150',
    note='bare integer = NCBI Gene ID 2150 (F2RL1) is a receptor candidate; also a Variation ID candidate; src=pack/sources/clinvar/par2_human.json.gz:geneId')
row('718860', 'ambiguity', 'ambiguous', 'par2_human', 363, 'S', '=', alternates='clinvar:718860',
    note='bare integer = ClinVar Variation ID 718860 (PAR2 p.Ser363=) candidate')
row('3538', 'ambiguity', 'ambiguous', '', alternates='hgnc:3538 | gene_id:3538 | clinvar:3538',
    note='bare 3538: HGNC:3538 is F2RL1 only with the prefix; without it a candidate list (needs HGNC cache)')
row('CB1', 'ambiguity', 'receptor', 'cnr1_human', note='curated common name; no change reading (B is not an amino acid code)')
row('MOR', 'ambiguity', 'receptor', 'oprm_human', note='curated: mu opioid')
row('5-HT1A', 'receptor_alias', 'receptor', '5ht1a_human', note='curated; punctuation normalised')
row('5HT1A', 'receptor_alias', 'receptor', '5ht1a_human', note='UniProt name')
row('5-ht2a', 'receptor_alias', 'receptor', '5ht2a_human', note='case')
row('AT1R', 'receptor_alias', 'receptor', 'agtr1_human', note='curated')
row('rhodopsin', 'receptor_alias', 'receptor', 'opsd_human', note='name')
row('mu opioid receptor', 'receptor_alias', 'receptor', 'oprm_human', note='name')
row('V2R', 'receptor_alias', 'receptor', 'v2r_human', note='UniProt name')
row('CXCR4', 'receptor_alias', 'receptor', 'cxcr4_human', note='HGNC')
row('GPR', 'ambiguity', 'ambiguous', '', note='prefix of many receptors: autocomplete list, no single target (list not enumerated here)')

# ============================================================================================ 10. not in resource / unrecognised
for q, n in [('GLP1R', 'class B GPCR, not in the 283 Class A'), ('GRM5', 'class C'), ('BRCA1', 'not a GPCR'),
             ('GPR26', 'Class A but excluded (no complete active+inactive pair; 283 vs 287)'),
             ('LGR5', 'excluded (no complete pair)'), ('RXFP1', 'excluded (no complete pair)'),
             ('OPSX', 'excluded (no complete pair)'), ('GLP1R p.Arg131Gln', 'class B receptor + change'),
             ('1-1000000-A-G', 'GRCh38 position outside every receptor window')]:
    assert all(P[x]['meta']['gene'] != q.split(' ')[0] for x in GIDS)
    row(q, 'not_in_resource', 'not_in_resource', '', '', '', '', assembly='GRCh38' if q[0].isdigit() else 'na',
        note=n + ' (window check: validator)' if q[0].isdigit() else n)
for q in ['', '   ', 'asdf', 'p.', 'rs', 'c.477G>', '5-76833084-G', 'M0I', 'F2RL1 p.Met159Xyz',
          '<script>alert(1)</script>', '1.2.3', 'chr5:', 'GPR999', 'rs12ab']:
    row(q, 'malformed', 'unrecognised', note='plain-language "could not read this" with examples; never an empty receptor table')

# ------------------------------------------------------------------------------------------- write
os.makedirs(OUT, exist_ok=True)
cols = ['id', 'query', 'category', 'expect', 'gid', 'pos', 'ref', 'alt', 'alleles', 'alternates', 'assembly', 'note']
with open(f'{OUT}/golden_queries.tsv', 'w', newline='') as fh:
    w = csv.writer(fh, delimiter='\t', lineterminator='\n', quoting=csv.QUOTE_NONE, escapechar=None)
    fh.write('\t'.join(cols) + '\n')
    for i, r in enumerate(rows, 1):
        vals = [f'G{i:03d}'] + [r[c] for c in cols[1:]]
        for v in vals:
            assert '\t' not in v and '\n' not in v, vals
        fh.write('\t'.join(vals) + '\n')
with open(f'{OUT}/grch37_liftover.tsv', 'w') as fh:
    fh.write('grch38\tgrch37\tstrand\tgrch37_base\tsource\n')
    for k2, L in sorted(LIFT_USED.items()):
        fh.write(f"{k2}\t{L['chrom37']}:{L['pos37']}\t{L['strand']}\t{L['base37']}\tEnsembl REST /map/human/GRCh38/..:1/GRCh37 + grch37 /sequence/region, fetched 2026-11-04\n")
print(len(rows), 'rows;', _req[0], 'requests', file=sys.stderr)
print(collections.Counter(r['category'] for r in rows), file=sys.stderr)
print(collections.Counter(r['expect'] for r in rows), file=sys.stderr)
