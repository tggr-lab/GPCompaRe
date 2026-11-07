"""Generate the statistics page for GPCompaReports v2.

Writes output/statistics.html plus the files behind its chart cards:

    data/stats/<chart-id>.json        a Plotly payload fetched when the card scrolls near
                                      (data, layout, config); small paper charts stay
                                      inline in the page as window.CHART_DATA[id]
    data/stats/<chart-id>.csv         the table behind every card (the card's CSV button and
                                      its table view read this same file)
    data/stats/helix_pairs.json       class atlas views written by analysis/class_atlas.py and
    data/stats/cfr_atlas.json         analysis/tm_domain_analysis.py (agent A) and
    data/stats/receptors.json         analysis/cfr_variants.py (agent C); the page renders
    data/stats/cfr_variants.json      them in the browser (static/js/stats-page.js) and shows
                                      a short note where a file is absent
    data/stats/gpcompare_statistics_tables.zip   every CSV in data/stats, one download

Theme overrides are applied client-side via Plotly.relayout() from the data-chart-layout-*
attributes on each chart div (templates/_partials/chart-card.html + static/js/site.js,
static/js/stats-page.js).

The ranked CFR tables and the AlphaMissense class comparison are read from tracked tables
(data/manuscript_2026-08-24, data/supplement_2026-11-05b) and never recomputed; the other cards are
computed from the RRCS batch run and the Studio packs at build. Release labels come from
data_versions.json. No card names a source layer on the page.
"""

import base64
import csv
import io
import json
import zipfile
from pathlib import Path

import numpy as np
import plotly.graph_objects as go
from jinja2 import Environment

from ...analysis.cfr_analysis import CFR_TOP_N
from ...analysis.class_atlas import stats_data_for_page
from ...analysis.cfr_variants import write_cfr_variants
from ...analysis.manuscript_stats import write_am_comparison
from ...analysis.variant_correlation import write_conservation_residues_csv
from .. import data_versions
from ..plotly_theming import theme_overrides

#: Rows shown in the contact-pair table. Unrelated to CFR_TOP_N: this is how
#: many of the ranked pairs fit on the page, not where the CFR cutoff sits.
NETWORK_ROWS_SHOWN = 20

#: Where the page's data files go, under the site root.
STATS_DIR = 'data/stats'
ZIP_NAME = 'gpcompare_statistics_tables.zip'

#: The four receptors without site variant data: two causes, stated separately
#: (tests/test_variant_coverage_note.py).
VARIANT_LAYER_RECEPTORS = 279

#: The class atlas files the browser renders (written by other analysis modules).
ATLAS_FILES = {
    'helix_pairs': 'helix_pairs.json',
    'cfr_atlas': 'cfr_atlas.json',
    'receptors': 'receptors.json',
    'cfr_variants': 'cfr_variants.json',
}

#: Dotplot labels: only the top-ranked positions get a text label; the rest stay on hover.
DOTPLOT_LABELS = 10


# ---------------------------------------------------------------------------- figure helpers

def _fig_dict(fig):
    """Plotly figure -> plain dict (data, layout) with JSON-safe values."""
    if fig is None:
        return None
    if isinstance(fig, dict):
        return json.loads(json.dumps(fig))
    return json.loads(fig.to_json())


def _payload(fig_dict, title=None):
    """The chart payload the page draws: no modebar (the card has its own export buttons),
    responsive, autosized to its container (the card sets the height in CSS, smaller on
    phones). The layout title is kept for the exported image; in the page the card head
    carries the title, and stats-page.js blanks the Plotly title before drawing."""
    if fig_dict is None:
        return None
    layout = fig_dict.setdefault('layout', {})
    layout.pop('height', None)
    layout.pop('width', None)
    layout['autosize'] = True
    if title is not None:
        layout['title'] = {'text': title}
    t = layout.get('title')
    if isinstance(t, dict) and t.get('text'):
        t.setdefault('font', {})['size'] = 13
        t['x'] = 0
        t['xanchor'] = 'left'
        t['automargin'] = True
    margin = layout.setdefault('margin', {})
    margin.setdefault('l', 56)
    margin.setdefault('r', 16)
    margin.setdefault('b', 56)
    margin.setdefault('t', 48 if (isinstance(t, dict) and t.get('text')) else 16)
    fig_dict['config'] = {'displayModeBar': False, 'responsive': True, 'displaylogo': False}
    return fig_dict


def _arr(v):
    """A figure array as a Python list. Plotly's JSON encodes numeric arrays as {'dtype', 'bdata'[, 'shape']}
    (base64 typed arrays); plain lists pass through."""
    if isinstance(v, dict) and 'bdata' in v:
        a = np.frombuffer(base64.b64decode(v['bdata']), dtype=np.dtype(v.get('dtype', 'f8')))
        shape = v.get('shape')
        if shape:
            a = a.reshape([int(x) for x in str(shape).split(',')])
        return a.tolist()
    return v if isinstance(v, list) else ([] if v is None else list(v) if hasattr(v, '__iter__') and not isinstance(v, str) else v)


def _cell(v):
    if isinstance(v, float):
        return repr(round(v, 6)) if v == v else ''
    return '' if v is None else v


def rows_from_figure(fig_dict):
    """The table behind a Plotly figure: (header, rows).

    Heatmaps become long tables (row, column, value, and the text where the trace has one);
    everything else becomes series, x, y plus the hover/custom columns the trace carries.
    The same rows serve the CSV download and the card's table view, so the two agree.
    """
    traces = (fig_dict or {}).get('data') or []
    if not traces:
        return [], []
    if any(t.get('type') == 'heatmap' for t in traces):
        header = ['row', 'column', 'value']
        rows = []
        for t in traces:
            if t.get('type') != 'heatmap':
                continue
            xs, ys, z = _arr(t.get('x')) or [], _arr(t.get('y')) or [], _arr(t.get('z')) or []
            text = _arr(t.get('text')) if t.get('text') is not None else None
            if text and 'text' not in header:
                header.append('text')
            for i, row in enumerate(z):
                for j, v in enumerate(row):
                    y = ys[i] if i < len(ys) else i
                    x = xs[j] if j < len(xs) else j
                    out = [y, x, _cell(v)]
                    if text:
                        tt = text[i][j] if i < len(text) and j < len(text[i]) else ''
                        out.append(_cell(tt))
                    rows.append(out)
        return header, rows

    header = ['series', 'x', 'y']
    extra = []   # ('text' | 'customdata_k', ...)
    for t in traces:
        if isinstance(_arr(t.get('text')), list) and _arr(t.get('text')) and 'text' not in extra:
            extra.append('text')
        cd = _arr(t.get('customdata'))
        if isinstance(cd, list) and cd:
            n = len(cd[0]) if isinstance(cd[0], list) else 1
            for k in range(n):
                key = 'customdata_%d' % k
                if key not in extra:
                    extra.append(key)
    header = header + extra
    rows = []
    for t in traces:
        name = t.get('name') or ''
        xs, ys = _arr(t.get('x')) or [], _arr(t.get('y')) or []
        n = max(len(xs), len(ys))
        text = _arr(t.get('text')) if isinstance(_arr(t.get('text')), list) else None
        cd = _arr(t.get('customdata')) if isinstance(_arr(t.get('customdata')), list) else None
        for i in range(n):
            row = [name, _cell(xs[i] if i < len(xs) else None), _cell(ys[i] if i < len(ys) else None)]
            for key in extra:
                if key == 'text':
                    row.append(_cell(text[i]) if text and i < len(text) else '')
                else:
                    k = int(key.split('_')[1])
                    v = ''
                    if cd and i < len(cd):
                        c = cd[i]
                        v = c[k] if isinstance(c, list) and k < len(c) else (c if k == 0 else '')
                    row.append(_cell(v))
            rows.append(row)
    return header, rows


def _write_csv(path, header, rows, preamble=None):
    """A CSV with an optional '# ' comment preamble (source, scope, release)."""
    buf = io.StringIO()
    for line in preamble or []:
        buf.write('# %s\n' % line)
    w = csv.writer(buf)
    if header:
        w.writerow(header)
    w.writerows(rows)
    path.write_text(buf.getvalue(), encoding='utf-8')


# ---------------------------------------------------------------------------- cards

class Card(dict):
    """One chart card. Keys the partial reads:

    id, title, lead, layer ('site' | 'paper'), source (release label), receptors (int or str),
    caption, method (HTML), csv (site path or None), src (lazy JSON site path or None),
    scope (caption text), inline (bool: payload inline as window.STATS_CHART_DATA[id]), height, height_phone (px),
    search (site URL or None), kind ('plotly' | 'atlas'), atlas (atlas key for JS views),
    available (bool), note (text shown when a data file is absent).
    """


def _card(id, title, lead, layer, source, receptors, caption, method='', height=460,
          height_phone=360, search=None, kind='plotly', atlas=None):
    return Card(id=id, title=title, lead=lead, layer=layer, source=source, receptors=receptors,
                scope='%s receptors' % receptors, caption=caption, method=method, csv=None, src=None,
                inline=False, height=height, height_phone=height_phone, search=search, kind=kind,
                atlas=atlas, available=True, note='')


def _am_method(am):
    """The AlphaMissense card's method note: scope, then the counts behind each bar."""
    n = am.get('receptors', 276)
    out = ['<p>Unique substitutions at generic-numbered positions of %s receptors (GPR3, GPR4 and XCR1 not '
           'included), alleles placed on model residue numbering. The comparison group is every other '
           'generic-numbered position, which includes recurrent positions ranked below the cutoff.</p>' % n]
    groups = am.get('groups') or []
    if groups:
        out.append('<p>%s</p>' % ' '.join(
            '%s: %s scored substitutions, %s decisive (%s predicted pathogenic, %s predicted benign) and %s '
            'ambiguous.' % (g['label'], format(g['n'], ','), format(g['decisive'], ','),
                            format(g['pathogenic_n'], ','), format(g['benign_n'], ','),
                            format(g['ambiguous_n'], ',')) for g in groups))
    pct = am.get('decisive_pct')
    if pct:
        out.append('<p>Among decisive calls (pathogenic or benign), %.1f%% at the top positions and %.1f%% at '
                   'other generic-numbered positions are predicted pathogenic.</p>' % (pct['top'], pct['other']))
    return ''.join(out)


# ---------------------------------------------------------------------------- site numbers

def _median(values):
    v = sorted(values)
    if not v:
        return None
    n = len(v)
    return v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2.0


def _thresholds(store):
    """Per-receptor |ΔRRCS| thresholds of the batch run (REFILTER_SUMMARY.csv), if present."""
    path = Path(store.batch_dir) / 'REFILTER_SUMMARY.csv'
    out = {}
    if not path.is_file():
        return out
    with path.open(encoding='utf-8') as f:
        for row in csv.DictReader(f):
            try:
                out[row['gid']] = float(row['threshold'])
            except (KeyError, ValueError):
                continue
    return out


def site_numbers(store):
    """The orientation tiles' site-layer counts, from the loaded batch data."""
    infos = [store.gpcr_info[g] for g in store.gpcr_ids]
    thr = _thresholds(store)
    med = _median([thr[g] for g in store.gpcr_ids if g in thr])
    families = {i.get('receptor_family') for i in infos if i.get('receptor_family')}
    ligands = {i.get('ligand_type') for i in infos if i.get('ligand_type')}
    return {
        'receptors': len(infos),
        'families': len(families),
        'ligand_types': len(ligands),
        'pairs': sum(int(i.get('total_contacts') or 0) for i in infos),
        'above': sum(int(i.get('significant_changes') or 0) for i in infos),
        'median_threshold': med,
    }


# ---------------------------------------------------------------------------- figures built here

def _shrink_dotplot(fig_dict):
    """The paper bubble plot, below the atlas: smaller, only the top DOTPLOT_LABELS
    positions labeled (the labels of all 50 overlap). Data unchanged."""
    if not fig_dict:
        return fig_dict
    for t in fig_dict.get('data', []):
        text = _arr(t.get('text'))
        cd = _arr(t.get('customdata'))
        if not isinstance(text, list) or not isinstance(cd, list):
            continue
        # px.scatter hover_data order: generic_number, cfr_score_rank, recurrence_rank, pct_receptors
        keep = []
        for label, c in zip(text, cd):
            rank = c[1] if isinstance(c, list) and len(c) > 1 else None
            keep.append(label if isinstance(rank, (int, float)) and rank <= DOTPLOT_LABELS else '')
        t['text'] = keep
        t['textposition'] = 'top center'
    return fig_dict


def _with_margin(fig_dict, **kw):
    if fig_dict:
        fig_dict.setdefault('layout', {}).setdefault('margin', {}).update(kw)
    return fig_dict


def _strip_quadrant_labels(fig_dict):
    """The conserved-vs-variable scatter: drop the quadrant annotations that read function
    into a coefficient of variation; the points and axes stay."""
    if fig_dict and 'layout' in fig_dict:
        fig_dict['layout'].pop('annotations', None)
        fig_dict['layout'].pop('shapes', None)
    return fig_dict


# ---------------------------------------------------------------------------- the page

def generate_statistics_page(env: Environment, store, analysis_results, output_dir):
    output_dir = Path(output_dir)
    stats_dir = output_dir / STATS_DIR
    stats_dir.mkdir(parents=True, exist_ok=True)

    cross = analysis_results.get('cross_gpcr', {})
    tm = analysis_results.get('tm_domain', {})
    paper = analysis_results.get('manuscript', {})
    variant = analysis_results.get('variant', {})
    dv = data_versions.load()
    src = dv.get('sources', {})
    total = len(store.gpcr_ids)

    # The ranked table, the chart and the pair table are the paper's
    # results, not a site recomputation. Order is taken as given.
    top50 = paper.get('top50')
    cfr_table_data = [] if top50 is None else top50.to_dict('records')
    pairs = paper.get('pairs')
    cfr_network_data = ([] if pairs is None else pairs.head(NETWORK_ROWS_SHOWN).to_dict('records'))

    # The AlphaMissense class counts (276 receptors, alleles on model residue numbering), read from
    # data/supplement_2026-11-05b/ by manuscript_stats.load_am_comparison. The page shows the class
    # shares and counts only: no odds ratio, interval or test.
    am = paper.get('am_comparison') or {}

    # There is deliberately no per-variant table of the paper's analysis here: the submission
    # carries no family-wide listing of the individual variants behind Figure 3. The site's own
    # per-position view (data/stats/cfr_variants.json, agent C) is a separate, labeled site summary.

    # Site-layer payloads: the class atlas (helix pairs, CFR atlas, receptor explorer, overview;
    # analysis/class_atlas.py), the per-position variant summary (analysis/cfr_variants.py; needs the
    # Studio packs) and the paper AlphaMissense summary as JSON (analysis/manuscript_stats.py).
    atlas = stats_data_for_page(store, analysis_results, output_dir)
    overview = (atlas.get('payloads') or {}).get('overview') or {}
    cfr_var = None
    if getattr(store, 'report_layer', None) is not None:
        cfr_var = write_cfr_variants(output_dir, store.gpcr_ids)
    write_am_comparison(output_dir, am or None)
    per_residue = variant.get('conservation_residues')

    numbers = site_numbers(store)
    if overview.get('tiles'):
        ov = {t['key']: t['value'] for t in overview['tiles']}
        numbers.update({'pairs': ov.get('contact_pairs', numbers['pairs']),
                        'above': ov.get('above_threshold', numbers['above']),
                        'median_threshold': ov.get('median_threshold', numbers['median_threshold'])})

    rrcs_label = src.get('rrcs_batch', {}).get('label', 'RRCS batch')
    batch_gnomad = src.get('gnomad_batch', {}).get('label', 'gnomAD (batch)')
    site_gnomad = src.get('gnomad', {}).get('label', 'gnomAD')
    numbering = src.get('gpcrdb_numbering', {})
    numbering_label = '%s%s' % (numbering.get('label', 'GPCRdb numbering'),
                                (', fetched %s' % numbering['fetched']) if numbering.get('fetched') else '')
    site_src = '%s; %s' % (rrcs_label, numbering_label)

    # ---- the card registry (page order; the template places them) ----
    cards = {}

    def add(card, fig=None, inline=False, csv_rows=None, preamble=None):
        cid = card['id']
        fd = _fig_dict(fig)
        if fd is not None:
            payload = _payload(fd)
            if inline:
                card['inline'] = True
                card['payload_json'] = json.dumps(payload, separators=(',', ':'))
            else:
                (stats_dir / (cid + '.json')).write_text(json.dumps(payload, separators=(',', ':')), encoding='utf-8')
                card['src'] = '%s/%s.json' % (STATS_DIR, cid)
            if csv_rows is None:
                csv_rows = rows_from_figure(payload)
        if csv_rows is not None and csv_rows[0]:
            lines = ['%s. %s' % (card['title'], card['lead'])] + list(preamble or []) + [
                'Source: %s. Receptors: %s.' % (card['source'], card['receptors']),
                dv.get('database', {}).get('label', ''),
            ]
            _write_csv(stats_dir / (cid + '.csv'), csv_rows[0], csv_rows[1], [l for l in lines if l])
            card['csv'] = '%s/%s.csv' % (STATS_DIR, cid)
        cards[cid] = card
        return card

    # A. the helix-pair atlas (agent A's JSON; rendered in the browser)
    add(_card('chart-helix-pairs', 'Net contact change by helix pair',
              'Mean net ΔRRCS per receptor over its above-threshold contact pairs between two helices '
              '(TM1 to TM7 and H8). Red: stronger in the active model. Blue: stronger in the inactive model.',
              'site', site_src, total,
              'Direction view: cell = mean net ΔRRCS per receptor; the small percentage is the share of '
              'receptors with an above-threshold pair in the cell whose net change has the class-wide sign. '
              'Coverage view: share of receptors with at least one above-threshold pair in the cell. '
              'Cells with fewer than 10 receptors are blank. A net value sums gains and losses touching '
              'the same helix pair; hover gives them separately.',
              method='<p>For each receptor, every contact pair with |ΔRRCS| at or above the receptor\'s '
                     'own threshold (the batch run\'s per-receptor cutoff) is assigned to the segment pair of '
                     'its two residues from the GPCRdb segment annotation. Net ΔRRCS per receptor and cell '
                     'is the sum of signed ΔRRCS over those pairs; the cell shows the mean of that net over '
                     'receptors with at least one pair there. Loops and termini are not shown.</p>',
              height=520, height_phone=380, kind='atlas', atlas='helix_pairs'))

    # C. the CFR atlas (agent A's JSON) and the paper bubble plot under it
    add(_card('chart-cfr-atlas', 'The %d CFR positions across all %d receptors' % (CFR_TOP_N, total),
              'Rows: receptors grouped by ligand type (or family). Columns: the %d top-ranked positions '
              'by CFR score, helices first. Cell: above-threshold contact at that residue, mapped with '
              'no above-threshold contact, or position not numbered in this receptor.' % CFR_TOP_N,
              'site', site_src, total,
              'Default cell states: above-threshold contact (dark), mapped with none (white), not numbered '
              '(gray). The direction toggle colors the first state by net ΔRRCS at the residue.',
              method='<p>A position is numbered in a receptor when the GPCRdb residue map of the Studio pack '
                     'assigns it that generic number. It carries an above-threshold contact when at least '
                     'one contact pair touching that residue has |ΔRRCS| at or above the receptor\'s '
                     'threshold. Net ΔRRCS at the residue is the signed sum over those pairs.</p>',
              height=720, height_phone=520, kind='atlas', atlas='cfr_atlas'))

    add(_card('chart-cfr-dotplot', 'Recurrence and magnitude of the top %d positions' % CFR_TOP_N,
              'Each point is a position: how many receptors show an above-threshold change there, and '
              'the mean |ΔRRCS| among them. Size: CFR score. Labels on the top %d by rank.' % DOTPLOT_LABELS,
              'site', '%s; GPCRdb residue maps' % rrcs_label, total,
              'Recurrence is counted on the full GPCRdb residue maps of all %d receptors.' % total,
              method='<p>CFR score: the mean of normalized recurrence (receptors with an above-threshold change '
                     'at the position) and normalized mean |ΔRRCS|. The ranked list is cut at the top %d '
                     'positions for reporting; %s positions meet the recurrence criterion of three or more '
                     'receptors.</p>' % (CFR_TOP_N, format(paper.get('n_recurrent_positions', 0), ',')),
              height=440, height_phone=380),
        fig=_shrink_dotplot(_fig_dict(paper.get('fig_recurrence_dotplot'))), inline=True)

    # D. variants: the paper comparison in the clinical tint, then the site's per-position panel
    add(_card('chart-pathogenicity', 'AlphaMissense predicted class at CFR positions',
              'Share of scored missense substitutions predicted pathogenic, ambiguous or benign at the '
              'top %d positions by CFR score and at other generic-numbered positions.' % CFR_TOP_N,
              'site', '%s; alleles from %s' % (src.get('alphamissense', {}).get('label', 'AlphaMissense'),
                                               batch_gnomad),
              am.get('receptors', 276),
              'Bars are shares of all scored substitutions (denominator under each bar). Prediction, not '
              'clinical evidence.',
              method=_am_method(am),
              height=400, height_phone=380),
        fig=paper.get('fig_enrichment_bar'), inline=True)

    add(_card('chart-cfr-variants', 'Variants at each CFR position',
              'For each of the %d positions: unique missense substitutions seen in %s pooled across '
              'receptors, by AlphaMissense predicted class, with allele counts and ClinVar pathogenic or '
              'likely pathogenic records marked.' % (CFR_TOP_N, site_gnomad),
              'site', '%s; %s; %s' % (site_gnomad, src.get('alphamissense', {}).get('label', 'AlphaMissense'),
                                      src.get('clinvar', {}).get('label', 'ClinVar')),
              VARIANT_LAYER_RECEPTORS,
              'Unique receptor, position, reference and alternate substitutions; allele '
              'counts are shown separately. Prediction, not clinical evidence. Conservation on hover is an '
              'observation.',
              method='<p>Substitutions are pooled over the receptors in which the position is numbered. '
                     'The comparison chip shows the same bars for the recurrent positions ranked 51 to 368. '
                     'Bars with fewer than 20 substitutions are faded.</p>',
              height=480, height_phone=420, kind='atlas', atlas='cfr_variants'))
    cards['chart-cfr-variants']['scope'] = 'receptors with site variant data (%d of %d)' % (VARIANT_LAYER_RECEPTORS, total)

    # E. receptors and families (agent A's receptors.json)
    add(_card('chart-receptors', 'Every receptor, placed by how much changes and in which direction',
              'One point per receptor. Metric chips change the axes; color by ligand type or family; the '
              'find box highlights one receptor and lists the ones with the most similar CFR pattern.',
              'site', site_src, total,
              'Share stronger in the active model depends on the receptor threshold. Sum |ΔRRCS| grows with '
              'receptor size (contact count shown beside it). Pattern similarity is a browsing aid, not a '
              'classification. The Families tab compares groups with a Kruskal-Wallis test (families with at '
              'least 4 receptors; ligand types with at least 4), a description of spread across groups, not a '
              'test between two chosen families.',
              method='<p>Above-threshold pairs: contact pairs with |ΔRRCS| at or above the receptor\'s threshold. '
                     'Share active-favoring: the fraction of those pairs with ΔRRCS &gt; 0. CFR positions '
                     'above threshold: how many of the %d positions carry an above-threshold contact in the '
                     'receptor. Pattern similarity: cosine similarity over the signed %d-position CFR '
                     'fingerprint; receptors with fewer than 32 numbered CFR positions are left out.</p>'
                     % (CFR_TOP_N, CFR_TOP_N),
              height=520, height_phone=440, kind='atlas', atlas='receptors'))

    # folded charts (kept with their CSVs, out of the main flow)
    add(_card('chart-histogram', 'ΔRRCS distribution across all contact pairs',
              'All %s contact pairs of the %d receptors, binned.' % (format(numbers['pairs'], ','), total),
              'site', rrcs_label, total,
              'Most pairs do not change; the median receptor threshold is %s.'
              % ('%.2f' % numbers['median_threshold'] if numbers['median_threshold'] else 'per receptor'),
              height=360, height_phone=300),
        fig=cross.get('fig_delta_histogram'))
    add(_card('chart-tm-bar', 'Mean |ΔRRCS| by helix', 'Mean |ΔRRCS| of contact pairs touching each helix.',
              'site', site_src, total, 'The seven values lie within a narrow band; the helix-pair atlas above '
              'shows where the differences are.', height=360, height_phone=300),
        fig=_with_margin(_fig_dict(tm.get('fig_tm_bar')), r=48))
    add(_card('chart-cv-scatter', 'Conserved and variable positions',
              'Per generic position: mean |ΔRRCS| against its coefficient of variation across receptors.',
              'site', site_src, total,
              'A coefficient of variation describes spread, not function.',
              height=440, height_phone=380),
        fig=_strip_quadrant_labels(_fig_dict(tm.get('fig_conserved_variable'))))
    # The conservation card keeps the per-variant scatter of the site's variant layer (279 receptors,
    # the coverage note under it is pinned by tests/test_variant_coverage_note.py). The per-residue
    # density (variant_correlation.make_conservation_density, 283 receptors) is written as a CSV only
    # until that note is reworded; switching the card is a one-line change here.
    add(_card('chart-conservation', 'Conservation and contact change',
              'Residue conservation (VarSite via ProtVar) against |ΔRRCS| at variant residues, one point per '
              'variant row of the variant data.',
              'site', '%s; %s' % (site_gnomad, src.get('conservation', {}).get('label', 'conservation')),
              VARIANT_LAYER_RECEPTORS,
              'Shown for completeness, a null result: conservation is an observation about the sequence '
              'family, not a prediction of effect. A residue with several variants is counted once per variant.',
              height=440, height_phone=380),
        fig=variant.get('fig_conservation_scatter'))
    if per_residue is not None and not per_residue.empty:
        write_conservation_residues_csv(per_residue, stats_dir / 'conservation_by_residue.csv')

    # the paper tables as CSVs (table views read the same files)
    if cfr_table_data:
        cols = list(cfr_table_data[0].keys())
        _write_csv(stats_dir / 'cfr_top50.csv', cols, [[_cell(r[c]) for c in cols] for r in cfr_table_data],
                   ['Top %d Core Functional Residue positions by CFR score.' % CFR_TOP_N])
    if cfr_network_data:
        cols = list(cfr_network_data[0].keys())
        _write_csv(stats_dir / 'cfr_pairs_top20.csv', cols, [[_cell(r[c]) for c in cols] for r in cfr_network_data],
                   ['CFR contact pairs, the %d highest-ranked.' % len(cfr_network_data)])

    # atlas files: present or not (the page says so per card)
    for key, fname in ATLAS_FILES.items():
        present = (stats_dir / fname).is_file()
        for c in cards.values():
            if c.get('atlas') == key:
                c['src'] = '%s/%s' % (STATS_DIR, fname)
                c['available'] = present
                if not present:
                    c['note'] = 'This view is built from %s, which this build did not produce.' % fname
                csv_name = fname.replace('.json', '.csv')
                if (stats_dir / csv_name).is_file():
                    c['csv'] = '%s/%s' % (STATS_DIR, csv_name)
                if key == 'cfr_variants' and cfr_var is not None:
                    c['source'] = (cfr_var['summary'].get('label') or c['source']).rstrip('. ')

    # one zip of every table
    zip_path = stats_dir / ZIP_NAME
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
        for p in sorted(stats_dir.glob('*.csv')):
            z.write(p, p.name)
    n_tables = sum(1 for _ in stats_dir.glob('*.csv'))

    # coverage table (receptor counts per kind of result)
    coverage = [
        {'view': 'Structural summaries (helix pairs, CFR atlas, receptor explorer)', 'n': total,
         'source': '%s, %s' % (rrcs_label, numbering_label), 'excluded': ''},
        {'view': 'AlphaMissense class comparison', 'n': am.get('receptors', 276),
         'source': '%s, alleles from %s' % (src.get('alphamissense', {}).get('label', 'AlphaMissense'), batch_gnomad),
         'excluded': 'GPR3, GPR4 and XCR1'},
        {'view': 'Variant views (per-position variants, conservation)', 'n': VARIANT_LAYER_RECEPTORS,
         'source': '%s, %s' % (site_gnomad, src.get('clinvar', {}).get('label', 'ClinVar')),
         'excluded': 'NPY6R and TAAR3: pseudogene loci without protein-coding missense annotations. '
                     'GP182 and P2RY8: their identifiers were not successfully resolved during data collection.'},
    ]

    tiles = [
        {'value': format(numbers['receptors'], ','), 'label': 'human Class A receptors',
         'sub': '%d families, %d ligand types' % (numbers['families'], numbers['ligand_types']),
         'href': '#sec-e'},
        {'value': format(numbers['pairs'], ','), 'label': 'residue contact pairs compared',
         'sub': 'active against inactive model, per receptor', 'href': '#sec-a'},
        {'value': format(numbers['above'], ','), 'label': 'pairs above the receptor threshold',
         'sub': ('median threshold |ΔRRCS| %.2f' % numbers['median_threshold']) if numbers['median_threshold'] else 'per-receptor thresholds',
         'href': '#sec-a'},
        {'value': format(paper.get('n_recurrent_positions', 0), ','), 'label': 'recurrent positions',
         'sub': 'in 3 or more receptors', 'href': '#sec-c'},
        {'value': str(CFR_TOP_N), 'label': 'Core Functional Residues reported',
         'sub': 'top by CFR score', 'href': '#sec-c'},
    ]

    toc = [
        {'href': '#sec-a', 'q': 'Where does activation rewire the helix bundle?'},
        {'href': '#sec-c', 'q': 'Which positions change in most receptors?'},
        {'href': '#sec-d', 'q': 'Are variants at those positions predicted pathogenic?'},
        {'href': '#sec-e', 'q': 'Where does my receptor sit, and which are like it?'},
        {'href': '#sec-methods', 'q': 'Methods, sources and downloads'},
    ]

    light, dark = theme_overrides()

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
        page_description='Cross-receptor statistics for %d human Class A GPCRs: where activation rewires the '
                         'helix bundle, the %d Core Functional Residue positions across receptors, variants and '
                         'predicted pathogenicity at those positions, and a receptor explorer.' % (total, CFR_TOP_N),
        extra_css=['static/css/stats.css'],
        total_gpcrs=total,
        cards=cards,
        tiles=tiles,
        toc=toc,
        coverage=coverage,
        numbers=numbers,
        cfr_table=cfr_table_data,
        cfr_network=cfr_network_data,
        am=am,
        cfr_top_n=CFR_TOP_N,
        cfr_total_positions=paper.get('n_recurrent_positions', 0),
        cfr_network_total=paper.get('n_pairs_universe', 0),
        cfr_network_shown=len(cfr_network_data),
        stats_dir=STATS_DIR,
        zip_href='%s/%s' % (STATS_DIR, ZIP_NAME),
        n_tables=n_tables,
        variant_layer_receptors=VARIANT_LAYER_RECEPTORS,
        layout_light_json=json.dumps(light, separators=(',', ':')),
        layout_dark_json=json.dumps(dark, separators=(',', ':')),
    )

    out_path = output_dir / 'statistics.html'
    out_path.write_text(html, encoding='utf-8')
    print(f"  Generated: statistics.html ({n_tables} tables in {STATS_DIR}/)")
