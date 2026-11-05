"""The glossary: one plain sentence per term a first-time visitor meets.

Single source for the Glossary page (templates/glossary.html) and for the
runtime term tooltips (static/js/glossary.js reads the generated
static/js/glossary-data.js). Definitions adapted from the GPCompaRe Studio
glossary (src/engine/report/glossary.ts) where the term means the same thing
here; database-only terms (CFR as the Statistics page defines it, Kruskal-Wallis,
the fixed |ΔRRCS| >= 3.0 variant selection) are written for this site.

`match` lists JavaScript regular-expression sources. The tooltip script marks
the first match of each term in headings, table headers and legends; terms
are tried longest-pattern first so "ΔRRCS" wins over "RRCS". No em dashes.
"""

import json

from . import data_versions as dv
from . import motifs as _motifs
from ..analysis.cfr_analysis import CFR_TOP_N

GROUPS = ['Contact scores', 'The models', 'The receptor', 'Variants', 'Statistics page', 'Links and files']

# Lookbehind/lookahead word edges that also treat Δ, | and - as word characters.
_L = r'(?<![\wΔ|-])'
_R = r'(?![\w-])'

GLOSSARY = [
    # ---- contact scores ----
    dict(id='rrcs', group='Contact scores', term='RRCS', full='residue-residue contact score',
         definition='How tightly two residues pack in one structure, summed over their pairs of atoms '
                    'within 4.63 Å of each other (closer pairs count more); 0 means no contact.',
         href='https://doi.org/10.7554/eLife.50279',
         match=[_L + r'RRCS' + _R]),
    dict(id='active-inactive-rrcs', group='Contact scores', term='Active RRCS, Inactive RRCS',
         definition='The RRCS of one contact pair in the active model and in the inactive model.',
         match=[_L + r'(?:Active|Inactive) RRCS' + _R]),
    dict(id='delta', group='Contact scores', term='ΔRRCS', full='delta RRCS',
         definition='The change in one contact: its RRCS in the active model minus its RRCS in the inactive model. '
                    'Positive (red) means stronger in the active state, negative (blue) stronger in the inactive state.',
         match=[r'(?<!\|)ΔRRCS(?!\|)', _L + r'Delta RRCS' + _R]),
    dict(id='absdelta', group='Contact scores', term='|ΔRRCS|, |Δ|',
         definition='The size of a change whatever its direction: ΔRRCS without its sign.',
         match=[r'\|Δ(?:RRCS)?\|']),
    dict(id='pair', group='Contact scores', term='Contact pair',
         definition='Two residues with atoms within 4.63 Å of each other in at least one of the two models.',
         match=[_L + r'[Cc]ontact [Pp]airs?' + _R, _L + r'Contacts' + _R]),
    dict(id='threshold', group='Contact scores', term='Threshold',
         definition="The |ΔRRCS| a contact must reach to count as changed on a receptor's page: that receptor's "
                    'mean |ΔRRCS| plus one standard deviation, and never below 0.2.',
         match=[_L + r'[Aa]bove[- ]threshold' + _R, _L + r'[Tt]hreshold' + _R]),
    dict(id='magnitude', group='Contact scores', term='Magnitude (HIGH, MED, LOW)',
         definition="How large a pair's change is: HIGH at |Δ| 5.0 or more, MED from the receptor's threshold up "
                    'to 5.0, LOW below the threshold.',
         match=[_L + r'Magnitude' + _R]),
    dict(id='favoring', group='Contact scores', term='Active-favoring, inactive-favoring',
         definition='A contact or residue that is stronger in the active model (red, positive ΔRRCS) or in the '
                    'inactive model (blue, negative ΔRRCS).',
         match=[_L + r'(?:Active|Inactive)-favoring' + _R]),
    dict(id='sumdelta', group='Contact scores', term='Total |ΔRRCS|',
         definition="|ΔRRCS| added up over all of a receptor's contact pairs; it grows with the number of "
                    'contacts as well as with the size of their changes.',
         match=[_L + r'(?:Total|Sum) \|ΔRRCS\|']),
    dict(id='signed', group='Contact scores', term='Signed sum, Residue net Δ',
         definition='ΔRRCS added up over all contacts of one residue, keeping the signs: the net gain (red) or '
                    'loss (blue) of contact at that residue.',
         match=[_L + r'Signed sum' + _R, _L + r'Residue net Δ']),
    dict(id='maxdelta', group='Contact scores', term='Largest single contact, Residue max Δ',
         definition="The one contact of a residue with the largest |ΔRRCS|, coloured by that contact's sign.",
         match=[_L + r'Largest single contact' + _R, _L + r'Residue max Δ']),
    dict(id='sd', group='Contact scores', term='Std Dev, σ', full='standard deviation',
         definition='How widely values spread around their mean.',
         match=[_L + r'Std Dev' + _R]),
    dict(id='angstrom', group='Contact scores', term='Å', full='ångström',
         definition='A tenth of a nanometre; atoms in contact sit about 3 to 4.6 Å apart.',
         match=[]),

    # ---- the models ----
    dict(id='models', group='The models', term='Active model, inactive model',
         definition='Two computer predictions of the same receptor, one in the active (signalling) state and one '
                    'in the inactive state. They are models, not experimental structures.',
         match=[_L + r'(?:[Aa]ctive|[Ii]nactive) models?' + _R, _L + r'Active vs inactive' + _R]),
    dict(id='multistate', group='The models', term='AlphaFold-Multistate',
         definition='A way of running AlphaFold that predicts a GPCR in a chosen activation state by giving it only '
                    'template structures of that state (Heo and Feig, 2022).',
         href='https://doi.org/10.1002/prot.26382',
         match=[_L + r'AlphaFold[- ][Mm]ultistate' + _R]),

    # ---- the receptor ----
    dict(id='gpcr', group='The receptor', term='GPCR', full='G protein-coupled receptor',
         definition='A cell-surface receptor that crosses the membrane seven times and signals through G proteins.',
         href='https://gpcrdb.org/',
         match=[_L + r'GPCRs?' + _R]),
    dict(id='classa', group='The receptor', term='Class A',
         definition='The largest GPCR class, related to rhodopsin; this database covers 283 human class A receptors.',
         match=[_L + r'Class(?: | )A' + _R]),
    dict(id='gpcrdb', group='The receptor', term='GPCRdb',
         definition='The reference database of G protein-coupled receptors; the source of the generic numbers, '
                    'the segment boundaries and the snake plot layout.',
         href='https://gpcrdb.org/',
         match=[_L + r'GPCRdb' + _R]),
    dict(id='residue', group='The receptor', term='Residue, Res1, Res2',
         definition='One amino acid in the protein chain, written as its code and position, for example D130; '
                    'Res1 and Res2 are the two residues of a contact pair.',
         match=[_L + r'Res(?:idue )?[12]' + _R]),
    dict(id='aa', group='The receptor', term='AA', full='amino acid',
         definition='One of the 20 building blocks of a protein; AA1 and AA2 are the amino acids of a pair.',
         match=[_L + r'AA[12]?' + _R]),
    dict(id='segment', group='The receptor', term='Segment',
         definition='One stretch of the receptor: a transmembrane helix (TM1 to TM7), a loop between two helices '
                    '(ICL inside the cell, ECL outside), helix 8 (H8) or one of the two ends (N-term, C-term).',
         match=[_L + r'Segment' + _R]),
    dict(id='tm', group='The receptor', term='TM, TM1 to TM7', full='transmembrane helix',
         definition='The seven helices that cross the cell membrane, numbered from the N-terminus.',
         match=[_L + r'TM[1-7]?' + _R, _L + r'Transmembrane' + _R]),
    dict(id='loops', group='The receptor', term='ICL, ECL', full='intracellular and extracellular loops',
         definition='The loops joining the helices, on the inside (ICL1 to ICL3) or the outside (ECL1 to ECL3) of the cell.',
         match=[_L + r'[IE]CL[1-3]?' + _R]),
    dict(id='h8', group='The receptor', term='H8', full='helix 8',
         definition='A short helix after TM7 that lies along the inner face of the membrane.',
         match=[_L + r'H8' + _R]),
    dict(id='termini', group='The receptor', term='N-term, C-term', full='N-terminus, C-terminus',
         definition='The two ends of the chain, the N-terminus outside the cell and the C-terminus inside; often '
                    'flexible, so their contacts are the least reliable part of a model.',
         match=[_L + r'[NC]-term(?:inus)?' + _R]),
    dict(id='gn', group='The receptor', term='Generic number',
         full='Ballesteros-Weinstein numbering, written 3.50x50 by GPCRdb',
         definition='A residue address shared across receptors. In 3.50x50, 3 is the helix (TM3) and 50 marks the '
                    "helix's most conserved residue, so one number names the equivalent residue in every receptor; "
                    "the number after the x is GPCRdb's structure-based correction.",
         href='https://gpcrdb.org/',
         match=[_L + r'[Gg]eneric[- ]number(?:s|ed|ing)?' + _R, _L + r'Ballesteros-Weinstein' + _R]),
    dict(id='snake', group='The receptor', term='Snake plot',
         definition="A flat map of the receptor's sequence, one circle per residue, drawn as the chain threads back "
                    'and forth through the membrane.',
         href='https://gpcrdb.org/',
         match=[_L + r'[Ss]nake plot' + _R]),
    # two meanings, said plainly; the class-wide set is the one the whole site marks (CFR_TOP_N, owner 2026-11-05)
    dict(id='cfr', group='The receptor', term='CFR', full='Core Functional Residue',
         definition="The term has two meanings. A receptor-level CFR is a residue of one receptor that takes part "
                    "in a contact whose |ΔRRCS| is above that receptor's threshold. The class-wide CFR positions "
                    'are generic positions where receptor-level CFRs recur in at least three receptors, ranked by '
                    'CFR score. The site marks the top %d, as in Figure 3 of the paper: the snake plots, the '
                    'residue table and search call a residue a CFR when its generic number is one of the %d '
                    'top-ranked class-wide CFR positions (by CFR score), and the Statistics page lists them.'
                    % (CFR_TOP_N, CFR_TOP_N),
         match=[_L + r'CFRs?' + _R, _L + r'Core Functional(?: Residues?)?' + _R]),
    # the CFR neighbourhood of the search (static/js/search/cfrhood.js): the same top CFR_TOP_N class-wide CFR
    # positions as the search card's CFR flag, the report snake plots and the Statistics page
    dict(id='cfr-connected', group='The receptor', term='CFR-connected residue',
         definition="A residue that takes part in a contact above its receptor's ΔRRCS threshold whose partner "
                    'residue sits at a CFR position in the same receptor. A CFR position here is one of the %d '
                    'top-ranked class-wide CFR positions (by CFR score), the positions search and the snake plots '
                    'mark as CFR.' % CFR_TOP_N,
         match=[_L + r'CFR-connected(?: residues?)?' + _R, _L + r'[Cc]onnected to a CFR' + _R]),
    dict(id='cfr-near', group='The receptor', term='Near a CFR',
         definition='A residue within two residues of a CFR position along the chain, in the same segment (helix, '
                    'loop or terminus). CFR positions are the same %d top-ranked class-wide CFR positions (by CFR '
                    'score).' % CFR_TOP_N,
         match=[_L + r'[Nn]ear a CFR(?: in sequence)?' + _R]),
    dict(id='cfr-touch', group='The receptor', term='In contact with a CFR, below threshold',
         definition="A residue with a contact to a CFR residue in at least one of the two models (RRCS above 0) that "
                    "stays below the receptor's threshold.",
         match=[_L + r'[Ii]n contact with a CFR' + _R]),
    # the definition, with its count, is the motif registry's (motifs.json), the text search shows too
    dict(id='xmy', group='The receptor', term='xMY motif',
         definition=_motifs.motif('xmy')['definition'],
         match=[_L + r'xMY' + _R]),
    dict(id='cfrscore', group='Statistics page', term='CFR score',
         definition="The mean of a position's normalised recurrence (how many receptors) and normalised mean "
                    '|ΔRRCS|; it orders the CFR table.',
         match=[_L + r'CFR score' + _R]),
    dict(id='ligand', group='The receptor', term='Ligand type',
         definition='The kind of molecule that naturally activates the receptor, for example an amine, a peptide '
                    'or a lipid; orphan receptors have no confirmed natural ligand.',
         match=[_L + r'Ligand [Tt]ype' + _R]),

    # ---- variants ----
    dict(id='missense', group='Variants', term='Missense variant',
         definition='A DNA change that swaps one amino acid of the protein for another.',
         match=[_L + r'[Mm]issense variants?' + _R]),
    dict(id='contactsite', group='Variants', term='Contact-site variants',
         definition='The gnomAD missense variants listed on a report: those at residues that take part in at '
                    'least one contact pair with |ΔRRCS| ≥ 3.0, a fixed cutoff rather than the receptor threshold.',
         match=[_L + r'Contact-site' + _R]),
    dict(id='gnomad', group='Variants', term='gnomAD', full='Genome Aggregation Database',
         definition='Genetic variation seen in hundreds of thousands of people; the source of the missense '
                    'variants and their frequencies (' + dv.long_label('gnomad') + ').',
         href='https://gnomad.broadinstitute.org/',
         match=[_L + r'gnomAD' + _R]),
    dict(id='af', group='Variants', term='Allele frequency', full='AF',
         definition='The share of chromosomes in gnomAD that carry the variant; 1e-4 means 1 in 10,000.',
         match=[_L + r'Allele freq(?:uency)?' + _R]),
    dict(id='het', group='Variants', term='Het count', full='heterozygote count',
         definition='How many people in gnomAD carry one copy of the variant (allele count minus twice the '
                    'number of people who carry two copies).',
         match=[_L + r'Het count' + _R]),
    dict(id='hgvs', group='Variants', term='Protein change, DNA change', full='HGVS notation',
         definition='The standard way to write a variant: p.Arg151Cys is the arginine at protein position 151 '
                    'replaced by cysteine, and c.451C>T is the DNA letter change behind it.',
         match=[_L + r'(?:Protein|DNA) change' + _R]),
    dict(id='rsid', group='Variants', term='dbSNP, rsID',
         definition="A variant's identifier in dbSNP, NCBI's catalogue of genetic variants, such as rs1042713.",
         match=[_L + r'dbSNP' + _R]),
    dict(id='am', group='Variants', term='AlphaMissense, AM',
         definition='A machine-learning prediction of how likely one amino-acid change is to harm the protein, from '
                    '0 to 1: likely benign below 0.34, likely pathogenic from 0.564, ambiguous between. '
                    'A prediction, not a clinical classification.',
         href='https://doi.org/10.1126/science.adg7492',
         match=[_L + r'AlphaMissense' + _R, _L + r'AM' + _R]),
    dict(id='pathogenicity', group='Variants', term='Pathogenicity',
         definition="AlphaMissense's class for a change: Benign, Ambiguous or Pathogenic, from its score.",
         match=[_L + r'Pathogenicity' + _R]),
    dict(id='conservation', group='Variants', term='Conservation',
         definition='How unchanged a position is across related proteins, from 0 (variable) to 1 (conserved); '
                    'conserved positions are often important (VarSite scores, served by ProtVar).',
         href='https://www.ebi.ac.uk/ProtVar/',
         match=[_L + r'Conservation' + _R]),

    # ---- statistics page ----
    dict(id='kw', group='Statistics page', term='Kruskal-Wallis test',
         definition='A test of whether several groups differ in their typical values, using ranks instead of raw '
                    'values; H is the test statistic, and a small p means a difference this large would be '
                    'unlikely if the groups were alike.',
         match=[_L + r'Kruskal-Wallis' + _R]),
    dict(id='or', group='Statistics page', term='Odds ratio, 95% CI', full='95% confidence interval',
         definition='How much more often something happens in one group than in another (1 means no difference); '
                    'the confidence interval is the range the true value plausibly lies in.',
         match=[_L + r'[Oo]dds ratio' + _R]),
    dict(id='recurrence', group='Statistics page', term='Recurrence',
         definition='How many receptors show an above-threshold change at the same generic-numbered position.',
         match=[_L + r'[Rr]ecurrence' + _R]),

    # ---- links and files ----
    dict(id='uniprot', group='Links and files', term='UniProt',
         definition="The reference protein database; each report links to the receptor's UniProt entry by its "
                    'accession, such as P07550.',
         href='https://www.uniprot.org/',
         match=[]),
    dict(id='csv', group='Links and files', term='CSV', full='comma-separated values',
         definition='A plain table file that opens in any spreadsheet program; every table here can be exported as one.',
         match=[]),
]

_BY_ID = {t['id']: t for t in GLOSSARY}


def glossary_groups():
    """[(group, [terms...]), ...] in display order."""
    return [(g, [t for t in GLOSSARY if t['group'] == g]) for g in GROUPS]


def glossary_js():
    """The data file static/js/glossary.js reads, as JavaScript source."""
    rows = [{'id': t['id'], 'term': t['term'], 'full': t.get('full', ''),
             'def': t['definition'], 'match': t['match']}
            for t in GLOSSARY if t['match']]
    return ('/* Generated from website/glossary.py by the site build. Do not edit. */\n'
            'window.GPC_GLOSSARY = ' + json.dumps(rows, ensure_ascii=False, separators=(',', ':')) + ';\n')
