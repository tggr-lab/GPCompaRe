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
         '● One receptor'),
        ('Above-threshold pairs per 100 pairs', [x['above_per_100'] for x in rows], False, ''),
    ]
    layouts = []
    for title, vals, half, note in panels:
        lo, hi = strip_domain(vals, half)
        pts, step = strip_layout(vals, lo, hi, 8, pw - 8, r)
        layouts.append((title, vals, lo, hi, pts, step, note, half))
    max_off = max(max(abs(p[1]) for p in L[4]) for L in layouts)
    top = 42
    half_h = (max_off + 1) * layouts[0][5]
    cy = top + half_h
    axis_y = cy + half_h + 6
    height = int(axis_y + 48)
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
        if half:
            low, high = xs(c['threshold_min']), xs(c['threshold_max'])
            range_y = axis_y + 27
            out.append('<path class="s-axis" fill="none" d="M%.1f %.1fv4H%.1fv-4"/>' % (low, range_y - 4, high))
            out.append('<text class="s-note" x="%.1f" y="%.1f">Min %.2f</text>' % (low, range_y + 14, c['threshold_min']))
            out.append('<text class="s-note" x="%.1f" y="%.1f" text-anchor="end">Max %.2f</text>'
                       % (high, range_y + 14, c['threshold_max']))
        d = _dots_path([(p[0], cy + p[1] * step) for p in pts])
        out.append('<path class="s-dots" d="%s" stroke-width="%.1f"/>' % (d, 2 * r))
        mx = xs(med)
        out.append('<text class="s-note" x="%.1f" y="%.1f" text-anchor="middle">Median %.2f</text>' % (mx, top - 9, med))
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
        return [], [], []
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
    # The downloadable coverage CSV keeps its release schema. Cells on the page have short, separate lines.
    rec, cons = pos['recovery'], pos['conservation']
    receptor_count = [f'{total} receptors']
    batch = _short(rrcs_label)
    map_source = [batch, 'Full GPCRdb residue maps' + (f" · {maps['fetched']}" if maps.get('fetched') else '')]
    if maps.get('exception'):
        map_source.append(maps['exception'].replace(' on its own GPCRdb entry, fetched ', ' own entry · '))
    minimum = cons['min_residues']
    excluded_am = ['Annotation mismatch', ', '.join(labels[g] for g in dropped)] if dropped else []
    if no_records:
        excluded_am += ['No query records', ', '.join(labels[g] for g in no_records)]
    display = [
        (['Thresholds, histogram, helix direction', 'CFR matrix, receptor explorer'], receptor_count,
         [batch, 'GPCRdb numbering' + (' · ' + src['gpcrdb_numbering']['fetched'] if src.get('gpcrdb_numbering', {}).get('fetched') else '')], []),
        (['Ranking, scaffold, partners and pairs'], [*receptor_count, 'GPCRdb generic numbers only'], map_source,
         ['Unnumbered residues', 'Mostly loops and termini']),
        (['Segments and helix magnitude'], receptor_count, ['Same as ranking'], []),
        (['Activation recovery'], [f"{rec['universe']} structure positions", f"{rec['known']} known",
                                   f'Numbered in at least half ({(total + 1) // 2}/{total})'], ['Same as ranking'], []),
        (['Conservation by position'], [f"{cons['n_top'] + cons['n_other']} positions", f'≥{minimum} scored residues/position'],
         [lab('conservation', 'VarSite via ProtVar'), 'Source-specific mapping (±1 residue/position)'], [f'Fewer than {minimum} scored residues']),
        (['AlphaMissense comparison', 'Recurrence bands, conservation quintiles'], [f"{am['receptors']} receptors"],
         [lab('gnomad_batch', 'gnomAD'), _month(src.get('gnomad_batch', {})), 'AlphaMissense'], excluded_am),
        (['Variants per top-ranked position'], [f"{v_n if v_n is not None else len(gids) - len(v_none)} receptors"],
         [lab('gnomad', 'gnomAD'), lab('clinvar', 'ClinVar'), 'AlphaMissense'],
         [', '.join(labels[g] for g in v_none), 'No protein-coding missense records'] if v_none else []),
    ]
    return rows, [(g, labels[g]) for g in v_none], display


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


def _cards(total, sc, hp, pos, cv, variants_n, sources):
    """Per-chart export metadata and the short Methods reference."""
    cohort = f'{total} receptors'
    recurring = len(pos.get('ranking', []))
    top = pos.get('top_n', CFR_TOP_N)
    gene = (pos.get('scaffold') or {}).get('gene', 'ADRB2')
    rec = pos.get('recovery') or {}
    cons = pos.get('conservation') or {}
    counts = pos.get('motif_counts') or {}
    totals = cv.get('totals') or {}
    un = cv.get('unclassified') or {}
    am_n = f"{cv.get('receptors', 0)} receptors"
    batch, maps, numbering, variants, scoring, conservation = sources
    mapped_contacts = f'{batch} · {maps}'
    contacts = (hp.get('magnitude_rule') or {}).get('min_contacts', 50)
    carriers = hp.get('min_receptors', 10)
    bands = totals.get('decisive_bands', 0)
    scored = totals.get('decisive_groups', 0)
    fifths = totals.get('decisive_fifths', 0)

    def card(key, title, scope, units, source, csv_file, label, note):
        return dict(id='chart-' + key, export=key, title=title, scope=scope, units=units, source=source,
                    csv=f'{STATS_DIR}/{csv_file}.csv', table=key != 'receptors', label=label, note=note)

    items = [
        card('thresholds', 'Thresholds by receptor', cohort, '|ΔRRCS| and pairs per 100', batch, 'thresholds',
             'Thresholds', 'Include pairs at or above the receptor mean |ΔRRCS| plus one standard deviation, with a 0.2 minimum.'),
        card('histogram', 'ΔRRCS of every contact pair', f"{sc.get('census', {}).get('pairs', 0):,} pairs, {cohort}",
             'ΔRRCS and contact-pair counts', batch, 'histogram', 'Contact distribution', 'Bin width is one ΔRRCS unit.'),
        card('helix-pairs', 'Helix-pair contacts', cohort, 'mean net ΔRRCS per receptor',
             f'{batch} · {numbering}', 'helix_pairs', 'Helix pairs',
             f'Direction: ≥{carriers} carriers, absent pairs zero, agreement among carriers. Omit within-helix pairs. Magnitude: all TM1–TM7 contacts (≥{contacts}/interface).'),
        card('segments', 'Change per contact, by segment', cohort, 'mean |ΔRRCS| per contact endpoint', mapped_contacts,
             'segments', 'Segments', 'Each endpoint counts once toward its residue’s segment, including contacts below threshold.'),
        card('scaffold', f'CFR recurrence on the {gene} scaffold', cohort, 'receptors per generic position',
             f'GPCRdb {gene} snake plot · {mapped_contacts}', 'scaffold', 'Scaffold',
             f'GPCRdb {gene} layout spans six residues before TM1 through eight after H8. Bands match variant recurrence groups.'),
        card('ranking', f'The {top} top-ranked positions', f'{cohort}, {recurring} positions',
             'CFR score, receptors and mean |ΔRRCS|', mapped_contacts, 'ranking_368', 'CFR ranking',
             f"{counts.get('in_top', 0)} of {counts.get('positions', 0)} activation motif positions rank in the top {top}."),
        card('recovery', 'Activation position recovery', f"{rec.get('universe', 0)} positions, {rec.get('known', 0)} known",
             'known positions per rank', mapped_contacts, 'activation_recovery', 'Recovery',
             'Each structure position takes its highest generic CFR score. Chance equals rank × known/eligible positions.'),
        card('partners', 'Position and pair recurrence', f"{cohort}, {recurring} positions, {pos.get('pairs', {}).get('n_distinct', 0):,} distinct pairs",
             'receptor share (%) and distinct partners', mapped_contacts, 'partners', 'Partners',
             'Count each receptor once per exact above-threshold pair of generic-numbered CFRs.'),
        card('cfr-atlas', f'CFRs at the top {top} positions', f'{cohort}, {top} positions', 'CFR presence', f'{batch} · {numbering}',
             'cfr_atlas', 'CFR matrix', 'Rows sort by CFR count within ligand type. Direction uses summed ΔRRCS. Phones show ligand-group shares.'),
        card('pathogenicity', 'AlphaMissense predictions by position group', am_n,
             'class % of scored, predicted pathogenic % of decisive', scoring, 'am_comparison', 'AlphaMissense',
             (f"Missense sites: contact |ΔRRCS| ≥3.0. Exclude {un.get('substitutions', 0):,} unclassified substitutions "
              f"across {un.get('receptors', 0)} receptors ({un.get('top50', 0)} at top {top}). Predictions only.")),
        card('am-bands', 'Predicted pathogenic share by recurrence', f"{am_n}, {totals.get('positions_bands', 0)} positions",
             'predicted pathogenic % of decisive', scoring, 'am_bands', 'Recurrence bands',
             f'Modeled contacts cover {bands:,} of {scored:,} decisive calls. The other {scored - bands:,} lack modeled contacts.'),
        card('position-conservation', 'Conservation at top-ranked and other positions',
             f"{cons.get('n_top', 0) + cons.get('n_other', 0)} positions", 'mean residue conservation (0 to 1)',
             conservation, 'position_conservation', 'Conservation',
             'Average cross-species scores over numbered, scored residues. CFR ranking uses contact data alone.'),
        card('am-quintiles', 'Predicted pathogenic share by conservation', f'{am_n}, {fifths:,} decisive calls',
             'predicted pathogenic % of decisive', scoring + ' · ' + conservation, 'am_conservation_fifths',
             'Conservation quintiles', f'Of {bands:,} decisive calls with modeled contacts, {bands - fifths:,} lack residue conservation scores.'),
        card('cfr-variants', 'Variants at each top-ranked position', f'{variants_n} receptors',
             'substitution count and predicted pathogenic % of decisive', variants, 'cfr_variants', 'Position variants',
             'Pool numbered receptors. Count each receptor, position, reference and alternate amino acid combination once.'),
        card('receptors', 'Receptor explorer', cohort, 'receptor counts and contact metrics', batch, 'receptors',
             'Explorer', f'Similarity compares signed top-{top} fingerprints by cosine. Total |ΔRRCS| grows with receptor size.'),
    ]
    return {item['id']: item for item in items}

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

    coverage_rows, variants_none, coverage_display = _coverage_rows(
        store, payloads, am, cfr_var, src, total, rrcs_label, numbering_label)
    _write_text(stats_dir / 'coverage.csv', class_results.coverage_csv(coverage_rows))

    sc = payloads.get('class_scale') or {}
    pos = payloads.get('class_positions') or {}
    cv = payloads.get('class_variants') or {}
    hp = payloads.get('helix_pairs') or {}
    if pos:
        _write_text(stats_dir / 'scaffold.csv', scaffold_csv(pos))

    census = sc.get('census') or {}
    v_cov = ((cfr_var or {}).get('summary', {}).get('coverage') or {})
    variants_receptors = v_cov.get('receptors_with_alleles') or (total - len(variants_none))
    numbering_short = 'GPCRdb numbering fetched %s' % numbering['fetched'] if numbering.get('fetched') else 'GPCRdb numbering'
    maps_src = src.get('gpcrdb_residue_maps') or {}
    maps_short = ('GPCRdb residue maps fetched %s' % maps_src['fetched']) if maps_src.get('fetched') else 'GPCRdb residue maps'
    # every table on these maps numbers one receptor on its own entry: the scope lines say which
    exc = re.match(r'(\S+) on its own GPCRdb entry, fetched (\S+)$', maps_src.get('exception') or '')
    if exc:
        maps_short += ' (%s: own entry, %s)' % exc.groups()
    elif maps_src.get('exception'):
        maps_short += ' (%s)' % maps_src['exception']

    sources = (_short(rrcs_label), maps_short, numbering_short, f'{site_gnomad} · {clinvar} · AlphaMissense',
               f'{batch_gnomad} · AlphaMissense', conservation_label)
    cards = _cards(total, sc, hp, pos, cv, variants_receptors, sources)
    groups = cv.get('groups') or []
    if groups:
        # The chart download includes the three existing shares of all scored calls.
        # Keep the versioned bulk tables and their size manifest reproducible.
        source = stats_dir / 'am_comparison.csv'
        by_label = {g['label']: g['pct_of_scored'] for g in groups}
        classes = ('predicted_pathogenic', 'ambiguous', 'predicted_benign')
        chart_csv = 'data/am_comparison_scored.csv'
        with source.open(encoding='utf-8', newline='') as src_csv, (output_dir / chart_csv).open(
                'w', encoding='utf-8', newline='') as out_csv:
            reader = csv.DictReader(src_csv)
            writer = csv.writer(out_csv, lineterminator='\n')
            writer.writerow([*reader.fieldnames, *('pct_' + k + '_of_scored' for k in classes)])
            for row in reader:
                writer.writerow([*row.values(), *(by_label[row['group']][k] for k in classes)])
        cards['chart-pathogenicity']['csv'] = chart_csv

    kruskal = ((payloads.get('receptors') or {}).get('kruskal') or {}).get('sum_abs')
    family_tests = []
    if kruskal:
        ligand, family = kruskal['ligand_types'], kruskal['families']
        family_tests = [
            ('%d ligand types' % ligand['k'], ligand['n'], ligand['H'], ligand['p']),
            ('%d families (≥%d receptors)' % (family['k'], FAMILY_MIN_KW), family['n'], family['H'], family['p']),
        ]

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
        'cards': {cid: {k: cd[k] for k in ('title', 'scope', 'units', 'source', 'export', 'csv')}
                  for cid, cd in cards.items()},
        'csv_extra': {'helix_interfaces': '%s/helix_interfaces.csv' % STATS_DIR,
                      'pairs': '%s/pairs.csv' % STATS_DIR},
        'labels': {'site_gnomad': site_gnomad, 'variants_none_gids': [g for g, _ in variants_none],
                   'scope_maps': '%s · %s' % (_short(rrcs_label), maps_short)},
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
        svg_thresholds=svg_threshold_strips(sc) if sc else '',
        cfr_table=cfr_table,
        cfr_network=cfr_network,
        cfr_network_total=len(pairs) if pairs is not None else 0,
        top_pairs_both_ranked=(pos.get('pairs') or {}).get('top_all_both_top50', False),
        cfr_top_n=CFR_TOP_N,
        cfr_total_positions=census.get('recurrent_positions') or paper.get('n_recurrent_positions', 0),
        coverage_display=coverage_display,
        reference=[dict(zip(pos.get('reference_columns', []), r)) for r in pos.get('reference', [])],
        reference_source=pos.get('reference_source', '').partition(', plus ')[0],
        reference_additions=pos.get('reference_source', '').partition(', plus ')[2].replace(' and ', ', ').split(', '),
        family_tests=family_tests,
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
