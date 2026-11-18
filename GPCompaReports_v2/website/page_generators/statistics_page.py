"""Generate the statistics page for GPCompaReports v2.

Writes output/statistics.html plus the files behind its cards (data/stats/):

    class_scale.json, helix_pairs.json, helix_pair_cells.json, helix_receptor_cells.json,
    class_positions.json, cfr_atlas.json, class_variants.json, cfr_variants.json, receptors.json
        the class payloads (analysis/class_atlas.py, analysis/class_results.py, analysis/cfr_variants.py),
        fetched by static/js/stats-story.js when a card comes within 600 px of the viewport
    <table>.csv                         the plain table behind every card (Table view, CSV export)
    coverage.csv, scaffold.csv          written here from the Methods rows and the scaffold payload
    gpcompare_statistics_tables.zip     every CSV in data/stats, one download

The page itself is server-rendered where a reader needs it without JavaScript: the header, the section headings, the threshold strips of card 1a as
an SVG, the top-ranked table, the pair table and Methods. Every number comes from a payload or a tracked
table; release labels come from data_versions.json. No card names a source layer on the page.
"""

import csv
import html as _html
import io
import json
import math
import re
import shutil
import zipfile
from pathlib import Path

from jinja2 import Environment

from ...analysis import class_results
from ...analysis.cfr_analysis import CFR_TOP_N
from ...analysis.class_atlas import FAMILY_MIN_KW, stats_data_for_page, write_manifest
from ...analysis.cfr_variants import write_cfr_variants
from ...analysis.manuscript_stats import write_am_comparison
from .. import data_versions

#: Rows of the server pair table (the Table view of the "Most recurrent pairs" tab).
NETWORK_ROWS_SHOWN = 20

#: Where the page's data files go, under the site root.
STATS_DIR = 'data/stats'
ZIP_NAME = 'gpcompare_statistics_tables.zip'

#: The class payloads the cards fetch.
CLASS_PAYLOADS = ('class_scale', 'helix_pairs', 'helix_pair_cells', 'helix_receptor_cells', 'class_positions',
                  'cfr_atlas', 'class_variants', 'cfr_variants', 'receptors')

#: Files of the page this generator no longer writes (removed from a reused output folder before zipping).
RETIRED_FILES = ('chart-histogram.json', 'chart-histogram.csv', 'chart-tm-bar.json', 'chart-tm-bar.csv',
                 'chart-cv-scatter.json', 'chart-cv-scatter.csv', 'chart-conservation.json',
                 'chart-conservation.csv', 'chart-cfr-dotplot.csv', 'chart-pathogenicity.csv', 'cfr_top50.csv',
                 'cfr_pairs_top20.csv', 'conservation_by_residue.csv', 'overview.json')

MINUS = '−'


def _esc(s):
    return _html.escape('' if s is None else str(s), quote=False)


def _attr(s):
    return _html.escape('' if s is None else str(s), quote=True)


# ---------------------------------------------------------------------------- server SVG (card 1a)

def strip_layout(values, lo, hi, x0, x1, r, gap=0.6):
    """Wilkinson dot strip: [(x, offset, index)] with offsets in dot steps (0, +1, -1, +2, ...). Values are
    stacked in value order so the server and the browser draw the same strip (static/js/stats-story.js)."""
    step = 2 * r + gap
    order = sorted(range(len(values)), key=lambda i: (values[i], i))
    cols, pts = {}, []
    for i in order:
        x = x0 + (values[i] - lo) / float(hi - lo) * (x1 - x0)
        k = int(math.floor(x / step + 0.5))
        c = cols.get(k, 0)
        cols[k] = c + 1
        off = 0 if c == 0 else (1 if c % 2 else -1) * int(math.ceil(c / 2.0))
        pts.append((k * step, off, i))
    return pts, step


def _num(v):
    t = ('%.1f' % v).rstrip('0').rstrip('.')
    return '0' if t in ('-0', '') else t


def _dots_path(points):
    """Round-capped zero-length segments, one per dot, as one compact relative path."""
    pts = sorted(points)
    out, px, py = [], 0.0, 0.0
    for i, (x, y) in enumerate(pts):
        x, y = round(x, 1), round(y, 1)
        if i == 0:
            out.append('M%s %sh0' % (_num(x), _num(y)))
        else:
            dx, dy = _num(x - px), _num(y - py)
            out.append('m%s%s%sh0' % (dx, ' ' if not dy.startswith('-') else '', dy))
        px, py = x, y
    return ''.join(out)


def strip_domain(values, half=False):
    lo, hi = min(values), max(values)
    if half:
        return math.floor(lo * 2) / 2.0, math.ceil(hi * 2) / 2.0
    return float(math.floor(lo)), float(math.ceil(hi))


def _ticks(lo, hi, step):
    out, t = [], lo
    while t <= hi + 1e-9:
        out.append(round(t, 2))
        t += step
    return out


def _tick_text(t):
    return ('%g' % t)


def svg_threshold_strips(class_scale, width=1080):
    """Card 1a as one SVG at a 1080 px viewBox: two dot strips side by side (thresholds; above-threshold pairs
    per 100), every dot of a strip in one <path> (round-capped zero-length segments), a teal median rule with
    its value. Colors come from CSS classes (stats.css), so the drawing follows the theme without JS."""
    cols = class_scale['receptor_columns']
    rows = [dict(zip(cols, r)) for r in class_scale['receptors']]
    c = class_scale['census']
    gap = 40
    pw = (width - gap) / 2.0
    r = 3.0
    panels = [
        ('Threshold |ΔRRCS|', [x['threshold'] for x in rows], True,
         'range %.2f to %.2f, median %.2f' % (c['threshold_min'], c['threshold_max'], c['threshold_median']), 2),
        ('Above-threshold pairs per 100 pairs', [x['above_per_100'] for x in rows], False,
         'median %.2f per receptor' % c['above_per_100_median'], 2),
    ]
    layouts = []
    for title, vals, half, note, dec in panels:
        lo, hi = strip_domain(vals, half)
        pts, step = strip_layout(vals, lo, hi, 8, pw - 8, r)
        layouts.append((title, vals, lo, hi, pts, step, note, half))
    max_off = max(max(abs(p[1]) for p in L[4]) for L in layouts)
    top = 30
    half_h = (max_off + 1) * layouts[0][5]
    cy = top + half_h
    axis_y = cy + half_h + 6
    height = int(axis_y + 26)
    out = ['<svg class="strip-svg" viewBox="0 0 %d %d" role="img" aria-label="%s" preserveAspectRatio="xMinYMin meet">'
           % (width, height, _attr('One dot per receptor: its |ΔRRCS| threshold, and its above-threshold pairs per '
                                   '100 contact pairs'))]
    for k, (title, vals, lo, hi, pts, step, note, half) in enumerate(layouts):
        ox = k * (pw + gap)
        xs = lambda v: 8 + (v - lo) / (hi - lo) * (pw - 16)  # noqa: E731
        med = sorted(vals)[len(vals) // 2] if len(vals) % 2 else sum(sorted(vals)[len(vals) // 2 - 1:len(vals) // 2 + 1]) / 2.0
        out.append('<g transform="translate(%.0f 0)">' % ox)
        out.append('<text class="s-title" x="0" y="13">%s</text>' % _esc(title))
        out.append('<text class="s-note" x="%.1f" y="13" text-anchor="end">%s</text>' % (pw, _esc(note)))
        d = _dots_path([(p[0], cy + p[1] * step) for p in pts])
        out.append('<path class="s-dots" d="%s" stroke-width="%.1f"/>' % (d, 2 * r))
        mx = xs(med)
        out.append('<line class="s-median" x1="%.1f" x2="%.1f" y1="%.1f" y2="%.1f"/>' % (mx, mx, top - 4, cy + half_h + 2))
        out.append('<line class="s-axis" x1="8" x2="%.1f" y1="%.1f" y2="%.1f"/>' % (pw - 8, axis_y, axis_y))
        for t in _ticks(lo, hi, 0.5 if half else 1.0):
            out.append('<text class="s-tick" x="%.1f" y="%.1f" text-anchor="middle">%s</text>'
                       % (xs(t), axis_y + 15, _tick_text(t)))
        out.append('</g>')
    out.append('</svg>')
    return ''.join(out)


# ---------------------------------------------------------------------------- Methods coverage

def _coverage_rows(store, payloads, am, cfr_var, src, total, rrcs_label, numbering_label):
    """The Methods rows: every count from a payload or the AlphaMissense summary, every label from
    data_versions.json, every name from the store (receptor_labels)."""
    pos = payloads.get('class_positions') or {}
    if not pos or not am:
        return [], []
    gids = list(store.gpcr_ids)
    rj = payloads.get('receptors') or {}
    sym_col = (rj.get('columns') or []).index('symbol') if 'symbol' in (rj.get('columns') or []) else None
    symbols = {r[0]: r[sym_col] for r in rj.get('rows') or []} if sym_col is not None else {}
    labels = class_results.receptor_labels(gids, symbols)
    dropped = [g for g in gids if g in set(am.get('dropped') or [])]
    vdir = Path(getattr(store, 'variant_dir', ''))
    no_records = [g for g in gids if not (vdir / ('%s_variants.csv' % g)).is_file()]
    if am.get('query_receptors') is not None and len(gids) - len(no_records) != am['query_receptors']:
        raise ValueError('allele query: %d receptors with records, the summary says %d'
                         % (len(gids) - len(no_records), am['query_receptors']))
    layer = getattr(store, 'report_layer', None)
    v_none = [g for g in gids if layer is not None and len(layer.variants.get(g, ())) == 0]
    v_n = ((cfr_var or {}).get('summary', {}).get('coverage') or {}).get('receptors_with_alleles')
    if v_n is not None and v_n != len(gids) - len(v_none):
        raise ValueError('cfr_variants covers %d receptors, the report layer %d' % (v_n, len(gids) - len(v_none)))
    lab = lambda k, d: src.get(k, {}).get('label', d)  # noqa: E731
    maps = src.get('gpcrdb_residue_maps') or {}
    rows = class_results.coverage_rows(
        total=total, rrcs_label=rrcs_label, numbering_label=numbering_label,
        recovery=pos['recovery'], conservation=pos['conservation'], am_receptors=am['receptors'],
        am_dropped=[labels[g] for g in dropped], am_no_records=[labels[g] for g in no_records],
        batch_gnomad='%s (%s)' % (lab('gnomad_batch', 'gnomAD (batch)'), _month(src.get('gnomad_batch', {}))),
        site_gnomad=lab('gnomad', 'gnomAD'), clinvar=lab('clinvar', 'ClinVar'),
        alphamissense='AlphaMissense', conservation_label=lab('conservation', 'conservation'),
        variants_receptors=v_n if v_n is not None else len(gids) - len(v_none),
        variants_none=[labels[g] for g in v_none],
        maps_label=('%s, fetched %s' % (maps['label'], maps['fetched'])) if maps.get('fetched') else maps.get('label'),
        maps_exception=maps.get('exception'))
    return rows, [(g, labels[g]) for g in v_none]


def _month(source):
    """'February 2026' from a data_versions fetched date ('2026-02-02/2026-02-03')."""
    import datetime
    f = str(source.get('fetched') or '').split('/')[0]
    try:
        return datetime.date.fromisoformat(f).strftime('%B %Y')
    except ValueError:
        return f


def _short(label):
    """'RRCS batch 2026-02-02' from 'GPCompaRe RRCS batch 2026-02-02'."""
    return re.sub(r'^GPCompaRe\s+', '', label or '')


# ---------------------------------------------------------------------------- tables

def _write_text(path, text):
    path.write_text(text, encoding='utf-8')


def scaffold_csv(pos):
    """scaffold.csv: the ADRB2 layout residues with the recurrence of their generic position."""
    sc = pos['scaffold']
    C = {c: i for i, c in enumerate(sc['columns'])}
    rk = {r[2]: r for r in pos['ranking']}
    rc = {c: i for i, c in enumerate(pos['ranking_columns'])}
    motif = {}
    for m in pos['motifs']:
        for g in m['positions']:
            motif[g] = m['name']
    bands = pos['bands']
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator='\n')
    w.writerow(['residue', 'aa', 'generic_number', 'receptors_with_cfr', 'band', 'motif'])
    for r in sc['residues']:
        gn = r[C['gn']]
        if not gn:
            n = ''
        elif 'n' in C and r[C['n']] is not None:
            n = r[C['n']]   # every generic position, recurrent or not (class_results.build_class_positions)
        else:
            n = rk[gn][rc['n']] if gn in rk else 0
        band = ''
        if gn:
            band = class_results.band_label(*next((b['lo'], b['hi']) for b in bands
                                                  if n >= b['lo'] and (b['hi'] is None or n <= b['hi'])))
        w.writerow([r[C['num']], r[C['aa']], gn, n, band, motif.get(gn, '')])
    return buf.getvalue()


# ---------------------------------------------------------------------------- cards

_ABS = '|ΔRRCS|'
_TAG_OR_TEXT = re.compile(r'(<script\b.*?</script>|<style\b.*?</style>|<title\b.*?</title>|<svg\b.*?</svg>|<[^>]+>)',
                          re.S | re.I)


def keep_abs_together(html):
    """|ΔRRCS| never breaks after its first bar: in the text of the page (not in tags, attributes, scripts, SVG or
    the title) it sits in a no-wrap span."""
    parts = _TAG_OR_TEXT.split(html)
    for i in range(0, len(parts), 2):   # even indexes are text between tags
        if _ABS in parts[i]:
            parts[i] = parts[i].replace(_ABS, '<span class="nw">%s</span>' % _ABS)
    return ''.join(parts)


def _card(cid, title, guide, scope_n, scope_rest, csv_name=None, method='', export=None, table=True):
    """Keep the full guide, scope and data source in the Method panel for display and export."""
    short = SHORT_GUIDES.get(cid, guide)
    about = '' if short == guide or not guide else '<p>%s</p>' % guide
    source = '<p data-src>Scope: <span data-src-scope>%s</span>.%s</p>' % (
        _esc(scope_n.rstrip('.')), (' <span data-src-data>%s</span>' % _esc(scope_rest)) if scope_rest else '')
    return {'id': cid, 'title': title, 'guide': short,
            'csv': ('%s/%s' % (STATS_DIR, csv_name)) if csv_name else None,
            'method': about + method + source,
            'export': export or cid.replace('chart-', ''), 'table': table}


#: The one visible line of a card, only where the chart cannot be read without it ('' = none). Cards not listed
#: keep their guide (the histogram, inside its own disclosure).
SHORT_GUIDES = {
    'chart-thresholds': 'One dot per receptor.',
    'chart-helix-pairs': ('Lines join helices with above-threshold contacts. Width: receptors that agree in '
                          'direction.'),
    'chart-segments': '',
    'chart-scaffold': '%s snake layout. Point at a residue for its position and count.',
    'chart-ranking': '',
    'chart-recovery': 'Known activation positions found walking down the ranking. Dashed: chance.',
    'chart-partners': '',
    'chart-cfr-atlas': 'Rows: receptors, grouped by ligand type. Columns: the top-ranked positions.',
    'chart-pathogenicity': 'Missense substitutions seen in gnomAD at strongly changing contacts.',
    'chart-am-bands': 'Positions grouped by how many receptors have a CFR there.',
    'chart-position-conservation': 'Mean conservation per position. The ranking does not use it.',
    'chart-am-quintiles': 'Residues grouped by conservation, Q1 lowest.',
    'chart-cfr-variants': 'All gnomAD missense substitutions at each top-ranked position: a separate allele set.',
    'chart-receptors': '',
}


def _cards(ctx):
    """Every card of the page, in page order: title, guide (the full reading; it moves into the Method panel where
    SHORT_GUIDES gives the card a shorter line), scope (count + rest), CSV, method note."""
    c = ctx
    n = c['total']
    cards = [
        _card('chart-thresholds', 'Each receptor has its own threshold',
              'A contact pair is above threshold when its |ΔRRCS| reaches its receptor\'s threshold: the mean '
              'plus one standard deviation of that receptor\'s |ΔRRCS| values. Left: the threshold of each '
              'receptor. Right: how many of every 100 contact pairs pass it.',
              '%d receptors.' % n, c['rrcs'] + '.', 'thresholds.csv',
              '<p>%s</p><p>Above-threshold pairs per 100 pairs: the receptor\'s above-threshold contact pairs '
              'divided by all its contact pairs, times 100.</p>' % _esc(c['threshold_rule'])),
        _card('chart-histogram', 'ΔRRCS of every contact pair', c['notes'].get('histogram', ''),
              '%s contact pairs, %d receptors.' % (format(c['pairs'], ','), n), '',
              'histogram.csv',
              '<p>ΔRRCS = RRCS in the active model minus RRCS in the inactive model, for every contact pair of '
              'every receptor. Bins are 1 unit wide; the y axis is logarithmic.</p>'),
        _card('chart-helix-pairs', 'The helix bundle, seen from the extracellular side',
              'Each line joins two helices that share above-threshold contacts. Color: mean net ΔRRCS per '
              'receptor, <span class="t-up">red</span> stronger in the active model, '
              '<span class="t-down">blue</span> stronger in the inactive model. Width: receptors that change in '
              'the majority direction. Pairs carried by fewer than %d receptors are not drawn.' % c['min_receptors'],
              '%d receptors.' % n, '%s; %s.' % (c['rrcs'], c['numbering']),
              'helix_pairs.csv',
              '<p>For each receptor, every contact pair at or above its threshold is assigned to the segment pair '
              'of its two residues (GPCRdb segment annotation). Net ΔRRCS per receptor and helix pair is the '
              'sum of signed ΔRRCS over those pairs. The line color is the mean of that net over all receptors '
              'in the group (receptors without the pair count as 0); the share in agreement is over receptors '
              'with the pair. Magnitude mode: mean |ΔRRCS| per contact over all contacts between two of TM1 to TM7, '
              'above-threshold or not, for pairs with at least %d contacts (H8 pairs not included), on the %s; disc '
              'size and the width of the H8 bar: mean |ΔRRCS| per contact endpoint on the helix, unsigned.</p>'
              '<p>Grid: each cell shows the mean net ΔRRCS per receptor of the pair (bold) and the share of receptors '
              'with the pair whose net has that sign; where cells are small, point at a cell for its values. Blank '
              'cells: fewer than %d receptors carry the pair, and within-helix pairs. Loops and termini appear '
              'under All segments.</p><p>A receptor group with fewer than %d receptors shows how many of its '
              'receptors carry each pair, without a class direction; each receptor\'s own bundle is on its report. '
              'The bars beside the bundle count the receptors carrying each pair, split by the sign of their net '
              'change. Click a line, a row or a cell for the receptors behind it.</p>'
              % (c['min_contacts'], c['maps'], c['min_receptors'], c['min_receptors'])),
        _card('chart-segments', 'Change per contact, by segment', c['notes'].get('segments', ''),
              '%d receptors.' % n, '%s.' % c['maps'], 'segments.csv',
              '<p>Every contact endpoint counts once for the segment of its residue. Unsigned: how much contacts '
              'change, not in which direction.</p>'),
        _card('chart-scaffold', 'Recurrence on the receptor scaffold',
              'Each residue of the %s layout is colored by how many of the %d receptors have a CFR at its generic '
              'position. Ringed residues mark activation motifs. Hover a residue for its position and count.'
              % (c['scaffold_gene'], n),
              '%d receptors.' % n, 'Layout: %s snake plot from GPCRdb.' % c['scaffold_gene'],
              'scaffold.csv',
              '<p>Residues are placed as in the GPCRdb snake plot of %s, from 6 residues before TM1 to 8 after H8. '
              'The fill is the recurrence band of the generic position (the same bands as the recurrence groups in '
              'Variant predictions). Residues without a GPCRdb generic number are hollow.</p>' % c['scaffold_gene']),
        _card('chart-ranking', 'The %d top-ranked positions' % CFR_TOP_N,
              'Ranked by CFR score, which weighs how many receptors have a CFR at the position together with the '
              'mean |ΔRRCS| of those contacts. Bar: receptors with a CFR there, of %d. Last column: mean '
              '|ΔRRCS|. Tags: activation motifs.' % n,
              '%d receptors, %d positions.' % (n, c['recurrent']), '%s.' % c['maps'],
              'ranking_368.csv',
              '<p>CFR score: the mean of normalized recurrence (receptors in which the position is a CFR) and '
              'normalized mean |ΔRRCS| of those contacts. %d generic positions are CFRs in three or more '
              'receptors; the %d with the highest score are marked across the site. Recurrence is counted on the '
              'full GPCRdb residue maps.</p><p>%s</p><p>%s</p>'
              % (c['recurrent'], CFR_TOP_N, _esc(c['notes'].get('ranking_outlier', '')),
                 _esc(c['notes'].get('motifs_in_top', '')))),
        _card('chart-recovery', 'Known activation positions down the ranking', c['recovery_guide'],
              '%d positions, %d known.' % (c['universe'], c['known']),
              'Structure positions numbered in at least half of the %d receptors.' % n,
              'activation_recovery.csv',
              '<p>%s</p><p>Known positions: %s.</p>' % (_esc(c['recovery_rule']), _esc(c['reference_source']))),
        _card('chart-partners', 'Positions recur in more receptors than their exact contacts do', c['partners_guide'],
              '%d receptors, %d positions, %s distinct pairs.' % (n, c['recurrent'], format(c['n_pairs'], ',')), '',
              'partners.csv',
              '<p>Partners are generic positions joined to the position by an above-threshold contact in which both '
              'residues are CFRs. The pair counts are receptors in which that exact pair of generic positions is '
              'above threshold.</p>'),
        _card('chart-cfr-atlas', 'Every receptor at the %d top-ranked positions' % CFR_TOP_N,
              'One row per receptor, one column per top-ranked position. Rows grouped by ligand type and sorted by '
              'how many of the %d are CFRs.' % CFR_TOP_N,
              '%d receptors, %d positions.' % (n, CFR_TOP_N), '', 'cfr_atlas.csv',
              '<p>Direction view: red, the net change of the CFR contacts is stronger in the active model; blue, '
              'stronger in the inactive model. On a phone the grid folds into one row per ligand type (the share '
              'with a CFR at each position); the full receptor-by-position grid is in the Table view.</p>'
              '<p>A position is numbered in a receptor when the GPCRdb residue map assigns it that generic number. '
              'It is a CFR there when at least one contact pair touching that residue is at or above the '
              'receptor\'s threshold. Direction: the sign of the summed ΔRRCS of those contacts.</p>'),
        _card('chart-pathogenicity', 'Predicted class of the substitutions seen in people', c['am_guide'],
              '%d receptors.' % c['am_receptors'], '%s; AlphaMissense.' % c['batch_gnomad'],
              'am_comparison.csv', c['am_method']),
        _card('chart-am-bands', 'Predicted pathogenic share by recurrence',
              'Share of decisive AlphaMissense calls that are predicted pathogenic, with positions grouped by the '
              'number of receptors in which they are a CFR. Same allele set as above.',
              '%d receptors, %d positions.' % (c['am_receptors'], c['band_positions']), '',
              'am_bands.csv', '<p>%s</p>' % _esc(c['notes'].get('am_bands_method', ''))),
        _card('chart-position-conservation', 'Conservation at top-ranked and other positions',
              'Mean conservation of the residues at each generic position (VarSite, via ProtVar), for positions '
              'with at least %d scored residues. Conservation is observed across species; the ranking does not '
              'use it.' % c['min_residues'],
              '%d positions.' % c['cons_positions'], '%s.' % c['conservation_label'],
              'position_conservation.csv',
              '<p>Per generic position, the mean conservation score of the residues numbered there, over the '
              'receptors with a score. Rings: activation motif positions.</p>'),
        _card('chart-am-quintiles', 'Within groups of similar conservation', c['fifths_guide'],
              '%d receptors, %s decisive calls.' % (c['am_receptors'], format(c['decisive_fifths'], ',')), '',
              'am_conservation_fifths.csv',
              '<p>%s</p>' % _esc(c['notes'].get('am_fifths_method', ''))),
        _card('chart-cfr-variants', 'Variants at each top-ranked position', c['variants_guide'],
              '%d receptors.' % c['variants_receptors'], '%s; %s; AlphaMissense.' % (c['site_gnomad'], c['clinvar']),
              'cfr_variants.csv',
              '<p>Unique receptor, position, reference and alternate substitutions, pooled over the receptors in '
              'which the position is numbered. Predicted pathogenic share: predicted pathogenic over predicted '
              'pathogenic plus predicted benign.</p>'),
        _card('chart-receptors', 'Receptor explorer',
              'One dot per receptor. Color: ligand group. Dot size: top-ranked positions with a CFR in the receptor.',
              '%d receptors.' % n, '', 'receptors.csv',
              '<p>Above-threshold pairs per 100 pairs: above-threshold contact pairs over all contact pairs. Share '
              'stronger in the active model: the fraction of above-threshold pairs with ΔRRCS above 0. Total '
              '|ΔRRCS|: the sum over all contact pairs; it grows with receptor size. Similar receptors: cosine '
              'similarity of the signed fingerprint over the %d top-ranked positions, a browsing aid.</p>'
              % CFR_TOP_N, table=False),   # its own Table tab is the table view; the CSV stays in Export
    ]
    out = {cd['id']: cd for cd in cards}
    out['chart-scaffold']['guide'] = out['chart-scaffold']['guide'] % c['scaffold_gene']
    return out


# ---------------------------------------------------------------------------- the page

def generate_statistics_page(env: Environment, store, analysis_results, output_dir):
    output_dir = Path(output_dir)
    stats_dir = output_dir / STATS_DIR
    stats_dir.mkdir(parents=True, exist_ok=True)
    for name in RETIRED_FILES:
        p = stats_dir / name
        if p.is_file():
            p.unlink()
    shutil.rmtree(stats_dir / 'figures', ignore_errors=True)   # retired: data/stats/figures/*.json

    paper = analysis_results.get('manuscript', {})
    dv = data_versions.load()
    src = dv.get('sources', {})
    total = len(store.gpcr_ids)

    # the ranked table and the pair table (class tables, never recomputed)
    top50 = paper.get('top50')
    cfr_table = [] if top50 is None else top50.to_dict('records')
    pairs = paper.get('pairs')
    cfr_network = [] if pairs is None else pairs.head(NETWORK_ROWS_SHOWN).to_dict('records')
    am = paper.get('am_comparison') or {}

    # the class payloads (analysis/class_atlas.py, class_results.py), the per-position variants (needs the
    # Studio packs) and the AlphaMissense summary as JSON
    atlas = stats_data_for_page(store, analysis_results, output_dir)
    payloads = atlas.get('payloads') or {}
    cfr_var = None
    if getattr(store, 'report_layer', None) is not None:
        cfr_var = write_cfr_variants(output_dir, store.gpcr_ids)
    write_am_comparison(output_dir, am or None)

    rrcs_label = src.get('rrcs_batch', {}).get('label', 'RRCS batch')
    numbering = src.get('gpcrdb_numbering', {})
    numbering_label = '%s%s' % (numbering.get('label', 'GPCRdb numbering'),
                                (', fetched %s' % numbering['fetched']) if numbering.get('fetched') else '')
    batch_gnomad = src.get('gnomad_batch', {}).get('label', 'gnomAD (batch)')
    site_gnomad = src.get('gnomad', {}).get('label', 'gnomAD')
    clinvar = src.get('clinvar', {}).get('label', 'ClinVar')
    conservation_label = src.get('conservation', {}).get('label', 'conservation')

    coverage_rows, variants_none = _coverage_rows(store, payloads, am, cfr_var, src, total, rrcs_label,
                                                  numbering_label)
    _write_text(stats_dir / 'coverage.csv', class_results.coverage_csv(coverage_rows))

    sc = payloads.get('class_scale') or {}
    pos = payloads.get('class_positions') or {}
    cv = payloads.get('class_variants') or {}
    hp = payloads.get('helix_pairs') or {}
    have = bool(sc and pos and cv and hp and payloads.get('receptors'))
    notes = class_results.computed_notes(payloads) if have else {}
    if pos:
        _write_text(stats_dir / 'scaffold.csv', scaffold_csv(pos))

    census = sc.get('census') or {}
    rec = pos.get('recovery') or {}
    cons = pos.get('conservation') or {}
    totals = cv.get('totals') or {}
    v_cov = ((cfr_var or {}).get('summary', {}).get('coverage') or {})
    variants_receptors = v_cov.get('receptors_with_alleles') or (total - len(variants_none))
    none_names = class_results.names_list([l for _, l in variants_none]) if variants_none else ''
    month = _month(src.get('gnomad_batch', {}))
    am_receptors = cv.get('receptors') or am.get('receptors') or 0
    numbering_short = 'GPCRdb numbering fetched %s' % numbering['fetched'] if numbering.get('fetched') else 'GPCRdb numbering'
    maps_src = src.get('gpcrdb_residue_maps') or {}
    maps_short = ('GPCRdb residue maps fetched %s' % maps_src['fetched']) if maps_src.get('fetched') else 'GPCRdb residue maps'
    # every table on these maps numbers one receptor on its own entry: the scope lines say which
    exc = re.match(r'(\S+) on its own GPCRdb entry, fetched (\S+)$', maps_src.get('exception') or '')
    if exc:
        maps_short += ' (%s: own entry, %s)' % exc.groups()
    elif maps_src.get('exception'):
        maps_short += ' (%s)' % maps_src['exception']

    ctx = {
        'total': total, 'rrcs': _short(rrcs_label), 'numbering': numbering_short, 'maps': maps_short,
        'pairs': census.get('pairs', 0), 'recurrent': census.get('recurrent_positions', 0),
        'min_receptors': hp.get('min_receptors', 10),
        'min_contacts': (hp.get('magnitude_rule') or {}).get('min_contacts', 50),
        'threshold_rule': (sc.get('meta') or {}).get('threshold_rule', ''),
        'scaffold_gene': (pos.get('scaffold') or {}).get('gene', 'ADRB2'),
        'notes': notes, 'universe': rec.get('universe', 0), 'known': rec.get('known', 0),
        'recovery_rule': rec.get('rule', ''), 'reference_source': pos.get('reference_source', ''),
        'recovery_guide': (
            'Reference: %d known activation positions (the common activation pathway of Zhou et al. 2019, plus '
            'D2.50, DRY, PIF, CWxP, NPxxY, the sodium pocket and 6.30). The curve walks down the %d structure '
            'positions (GPCRdb structure-based numbers such as 6x48) numbered in at least half of the receptors, in '
            'CFR score order, and counts the known positions among the first N. A structure position takes the '
            'highest CFR score of its generic numbers. Dashed line: the count expected if the order ignored '
            'activation.'
            % (rec.get('known', 0), rec.get('universe', 0))),
        'n_pairs': (pos.get('pairs') or {}).get('n_distinct', 0),
        'partners_guide': ('Filled dot: receptors with a CFR at the position. Open dot: receptors in which it '
                           'contacts its most frequent partner, the same pair of generic positions. Right: how '
                           'many different partner positions it has across the class.'),
        'am_receptors': am_receptors, 'batch_gnomad': batch_gnomad, 'site_gnomad': site_gnomad, 'clinvar': clinvar,
        'am_guide': ('Unique missense substitutions observed in %s (accessed %s) at residues in contacts with '
                     '|ΔRRCS| of 3.0 or more, at generic-numbered positions of %d receptors. Bars: decisive '
                     'calls (predicted pathogenic or predicted benign); ambiguous calls are counted beside them '
                     'and left out of the share.' % (batch_gnomad, month, am_receptors)),
        'band_positions': totals.get('positions_bands', 0),
        'min_residues': cons.get('min_residues', 20),
        'cons_positions': cons.get('n_top', 0) + cons.get('n_other', 0),
        'conservation_label': conservation_label,
        'decisive_fifths': totals.get('decisive_fifths', 0),
        'fifths_guide': ('Decisive calls split into five groups (Q1 to Q5) by the conservation of the residue, '
                         'lowest first. '
                         'In each group: predicted pathogenic share at the top %d positions (solid) and at other '
                         'positions (light). %s' % (CFR_TOP_N, notes.get('am_fifths_guide_count', ''))),
        'variants_receptors': variants_receptors,
        'variants_guide': ('Every unique missense substitution in %s at each of the %d top-ranked positions, over '
                           'all residues of %d receptors%s. Bar: AlphaMissense class of those substitutions. '
                           'Number: predicted pathogenic share of decisive calls. A different allele set from the '
                           'comparisons above, so the shares differ.'
                           % (site_gnomad, CFR_TOP_N, variants_receptors,
                              (' (%s have none)' % none_names) if none_names else '')),
        'am_method': '',
    }
    groups = cv.get('groups') or []
    ctx['am_method'] = (
        '<p>AlphaMissense predicted classes. Predictions, not clinical evidence. Conservation is an observation '
        'across species.</p><p>Allele set: %s missense alleles, %s query of residues in contacts with |ΔRRCS| of '
        '3.0 or more, %d receptors. Residues compared: the %d top-ranked positions against all other positions '
        'with a GPCRdb generic number.</p>' % (_esc(batch_gnomad), _esc(month), am_receptors, CFR_TOP_N))
    if groups:
        ctx['am_method'] += ''.join(
            '<p>%s: %s scored substitutions, %s decisive (%s predicted pathogenic, %s predicted benign) and %s '
            'ambiguous.</p>' % (_esc(g['label']), format(g['scored'], ','), format(g['decisive'], ','),
                                format(g['predicted_pathogenic'], ','), format(g['predicted_benign'], ','),
                                format(g['ambiguous'], ',')) for g in groups) + (
            '<p>The comparison group is every other generic-numbered position, which includes recurrent positions '
            'ranked below the top %d.</p>' % CFR_TOP_N)
        un = cv.get('unclassified') or {}
        if un.get('substitutions'):
            ctx['am_method'] += (
                '<p>%s substitutions in this set, in %d receptors (%s of them at the top %d positions), have no '
                'AlphaMissense class in this comparison and are not counted, here or in the recurrence and '
                'conservation groups below.</p>' % (format(un['substitutions'], ','), un['receptors'],
                                                   format(un['top50'], ','), CFR_TOP_N))
    cards = _cards(ctx)

    # the 4a composition rows (all three classes), rounded once
    am_rows = [{
        'label': g['label'], 'scored': g['scored'], 'decisive': g['decisive'], 'ambiguous': g['ambiguous'],
        'predicted_pathogenic': g['predicted_pathogenic'], 'predicted_benign': g['predicted_benign'],
        'pct': g['pct_predicted_pathogenic_of_decisive'],
        'p': g['pct_of_scored']['predicted_pathogenic'], 'a': g['pct_of_scored']['ambiguous'],
        'b': g['pct_of_scored']['predicted_benign']} for g in groups]

    kruskal = ((payloads.get('receptors') or {}).get('kruskal') or {}).get('sum_abs')
    families_text = ''
    if kruskal:
        a, b = kruskal['ligand_types'], kruskal['families']
        families_text = (
            'The Families tab compares groups with a Kruskal-Wallis test on total |ΔRRCS|. Across all %d '
            'ligand types: H = %.1f, p = %.3f (%d receptors). Across the %d families with at least %d receptors: '
            'H = %.1f, p = %.3f (%d receptors). A test of spread across groups, not between two chosen groups. '
            'The total grows with receptor size.'
            % (a['k'], a['H'], a['p'], a['n'], b['k'], FAMILY_MIN_KW, b['H'], b['p'], b['n']))

    census_items = [
        (format(census.get('receptors', total), ','), 'receptors', '#sec-e'),
        (format(census.get('families', 0), ','), 'families', '#sec-e'),
        (format(census.get('ligand_types', 0), ','), 'ligand types', '#sec-e'),
        (format(census.get('pairs', 0), ','), 'contact pairs', '#sec-scale'),
        (format(census.get('recurrent_positions', 0), ','), 'recurrent positions', '#sec-c'),
        (format(census.get('top_ranked', CFR_TOP_N), ','), 'top-ranked positions', '#sec-c'),
    ]

    config = {
        'urls': {k: '%s/%s.json' % (STATS_DIR, k) for k in CLASS_PAYLOADS},
        'stats_dir': STATS_DIR, 'top_n': CFR_TOP_N, 'n_receptors': total,
        'cards': {cid: {'export': cd['export'], 'csv': cd['csv']} for cid, cd in cards.items()},
        'csv_extra': {'helix_interfaces': '%s/helix_interfaces.csv' % STATS_DIR,
                      'pairs': '%s/pairs.csv' % STATS_DIR},
        'labels': {'site_gnomad': site_gnomad, 'variants_none_gids': [g for g, _ in variants_none],
                   'scope_maps': '%s; %s.' % (_short(rrcs_label), maps_short)},
    }

    # one zip of every table
    zip_path = stats_dir / ZIP_NAME
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
        for p in sorted(stats_dir.glob('*.csv')):
            z.write(p, p.name)
    n_tables = sum(1 for _ in stats_dir.glob('*.csv'))
    write_manifest(output_dir)   # every file of data/stats/, the ones written above included

    sections = {
        'sec-scale': 'Contact changes',
        'sec-a': 'Helix contacts',
        'sec-c': 'Recurrent positions',
        'sec-d': 'Variant predictions',
        'sec-e': 'Receptors and families',
        'sec-methods': 'Methods and data',
    }

    exc = atlas.get('exclusions') or {}
    exclusions = ({'listed': exc['listed'], 'names': class_results.names_list(exc['not_modeled'])}
                  if exc.get('listed') and exc.get('not_modeled') else None)

    template = env.get_template('statistics.html')
    html = template.render(
        static_prefix='',
        active_page='statistics',
        nav_home_url='index.html',
        nav_browse_url='browse/index.html',
        nav_stats_url='statistics.html',
        nav_downloads_url='downloads.html',
        nav_contact_url='contact.html',
        page_title='Database Statistics · GPCompaRe',
        page_path='statistics.html',
        page_description=('Cross-receptor statistics for %d human Class A GPCRs: what changes between the inactive '
                          'and the active model, where in the helix bundle, which positions recur, what it means '
                          'for variants, and where each receptor sits.' % total),
        extra_css=['static/css/stats.css'],
        total_gpcrs=total,
        cards=cards,
        census=census_items,
        sections=sections,
        notes=notes,
        svg_thresholds=svg_threshold_strips(sc) if sc else '',
        cfr_table=cfr_table,
        cfr_network=cfr_network,
        cfr_network_total=len(pairs) if pairs is not None else 0,
        n_both_top50=(pos.get('pairs') or {}).get('n_both_top50', 0),
        cfr_top_n=CFR_TOP_N,
        cfr_total_positions=census.get('recurrent_positions') or paper.get('n_recurrent_positions', 0),
        am_rows=am_rows,
        am_receptors=am_receptors,
        am_allele_set=batch_gnomad,
        am_month=month,
        coverage_rows=coverage_rows,
        reference=[dict(zip(pos.get('reference_columns', []), r)) for r in pos.get('reference', [])],
        reference_source=pos.get('reference_source', ''),
        families_text=families_text,
        exclusions=exclusions,
        kruskal=kruskal,
        stats_dir=STATS_DIR,
        zip_href='%s/%s' % (STATS_DIR, ZIP_NAME),
        n_tables=n_tables,
        config_json=json.dumps(config, separators=(',', ':'), ensure_ascii=False).replace('</', '<\\/'),
    )

    html = keep_abs_together(html)
    out_path = output_dir / 'statistics.html'
    out_path.write_text(re.sub(r'\n[ \t]+', '\n', html), encoding='utf-8')
    print(f"  Generated: statistics.html ({n_tables} tables in {STATS_DIR}/)")
