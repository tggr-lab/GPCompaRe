"""Build-time additions to the approved snake plot (owner approval 2026-11-05, P1 to P3).

The ouroboros SVG labels the loops and termini but not the helices, does not say which side of
the membrane is which, does not mark the x.50 reference residues, and sits in a canvas sized for
every loop expanded (about 430 px of empty bands in ADRB2). This module adds, without moving or
changing any residue, path or loop label:

  * one grey pill per helix present (TM1 to TM7, H8): not clickable, 11 px bold, #444, rx 3,
    white fill, #c7c7c7 stroke, centred on the helix column about 21 px above its top residue;
    H8 is placed from its own residues and moved beside them when the space above is taken;
  * "extracellular side" / "intracellular side" in italic #777 up the left margin, anchored to
    the band of TM1 to TM7 residues (so they do not move when a loop opens);
  * the x.50 reference residue of each helix: a thicker outline (a ring drawn over the residue's
    own outline, pointer-events none) and a 9 px tag with the residue's own frozen GPCRdb label
    (for example 3.50x50) beside the helix column, with a white halo; the tag is left out where
    it would touch a residue or another label, the outline stays;
  * a viewBox (and width/height in the same proportion) fitted to the collapsed plot: residues,
    loop labels, termini, paths, strokes and the labels above, plus 16 px padding.

Everything added sits in two groups appended at the end of <g id='snake'>:
<g class='snake-helix-labels'> (pills and sides) and <g class='snake-x50'> (rings and tags).
Neither contains a nested group, so the freeze rules can delete each with one exact pattern.

check_overlaps() is the build-time guard: every label (baked or ouroboros' own loop labels)
against every residue circle shown in the collapsed plot. bake() raises SnakeBakeError when a
helix pill cannot be placed off the residues, and relocates an ouroboros terminus label that
lies on residues (MC4R's C-term over H8) to the nearest free spot beside its own residues.
"""
import math
import re

PAD = 16.0
PILL_H = 15.0
PILL_GAP = 24.0          # pill centre above the top residue centre (bottom edge 4 px clear of it)
TAG_FONT = 9.0
TAG_CHAR_W = 5.4         # 9 px bold helvetica, digits and the x
SIDE_FONT = 10.5
SIDE_CHAR_W = 5.3
LABEL_CHAR_W = 7.0       # 11 px bold helvetica, pill text
HELICES = ['TM1', 'TM2', 'TM3', 'TM4', 'TM5', 'TM6', 'TM7', 'H8']
TERMINI = ('N-term', 'C-term')

_TAG_RE = re.compile(r"<(circle|rect|text|path|line)\b((?:[^>'\"]|'[^']*'|\"[^\"]*\")*)>", re.S)
_ATTR_RE = re.compile(r"([\w:-]+)\s*=\s*(?:'([^']*)'|\"([^\"]*)\")")
_SNAKE_G_RE = re.compile(r"<g id='snake' transform='translate\(([-\d.]+),\s*([-\d.]+)\)'>")
_SVG_OPEN_RE = re.compile(r"<svg\b[^>]*>", re.S)
_X50_RE = re.compile(r"^([1-8])\.50x50$")


class SnakeBakeError(RuntimeError):
    pass


def _attrs(s):
    return {m.group(1): (m.group(2) if m.group(2) is not None else m.group(3)) for m in _ATTR_RE.finditer(s)}


def _f(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _fmt(v):
    s = ('%.1f' % v)
    return s[:-2] if s.endswith('.0') else s


# ---------------------------------------------------------------- geometry of the collapsed plot

def _quad(p0, p1, p2, n=24):
    return [((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
             (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1])
            for t in (i / n for i in range(n + 1))]


def _cubic(p0, p1, p2, p3, n=24):
    out = []
    for i in range(n + 1):
        t = i / n
        a, b, c, d = (1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t * t, t ** 3
        out.append((a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]))
    return out


def path_points(d):
    """Points on an absolute M/L/Q/T/C path (the commands ouroboros writes), sampled on the curves."""
    toks = re.findall(r"[MLQTCmlqtc]|-?\d*\.?\d+(?:e-?\d+)?", d)
    pts, cur, last_ctrl, cmd, i = [], (0.0, 0.0), None, None, 0

    def take(k):
        nonlocal i
        vals = [float(x) for x in toks[i:i + k]]
        i += k
        return vals

    while i < len(toks):
        if re.match(r"[A-Za-z]", toks[i]):
            cmd = toks[i].upper()
            i += 1
            continue
        if cmd == 'M' or cmd == 'L':
            x, y = take(2)
            cur = (x, y)
            pts.append(cur)
            last_ctrl = None
        elif cmd == 'Q':
            x1, y1, x, y = take(4)
            pts.extend(_quad(cur, (x1, y1), (x, y)))
            last_ctrl, cur = (x1, y1), (x, y)
        elif cmd == 'T':
            x, y = take(2)
            c = (2 * cur[0] - last_ctrl[0], 2 * cur[1] - last_ctrl[1]) if last_ctrl else cur
            pts.extend(_quad(cur, c, (x, y)))
            last_ctrl, cur = c, (x, y)
        elif cmd == 'C':
            x1, y1, x2, y2, x, y = take(6)
            pts.extend(_cubic(cur, (x1, y1), (x2, y2), (x, y)))
            last_ctrl, cur = None, (x, y)
        else:
            i += 1
    return pts


def parse(svg):
    """The elements of <g id='snake'> with their geometry, in the snake group's coordinates."""
    g = _SNAKE_G_RE.search(svg)
    if not g:
        raise SnakeBakeError('no translated <g id=snake> in the SVG')
    tx, ty = float(g.group(1)), float(g.group(2))
    body = svg[g.end():]
    circles, labels, paths = [], [], []
    pending_text = {}
    for m in _TAG_RE.finditer(body):
        tag, a = m.group(1), _attrs(m.group(2))
        cls = a.get('class', '').split()
        long_ = 'long' in cls
        if tag == 'circle':
            title = a.get('original_title', '')
            circles.append({'id': a.get('id', ''), 'cx': _f(a.get('cx')), 'cy': _f(a.get('cy')), 'r': _f(a.get('r'), 12),
                            'sw': _f(a.get('stroke-width'), 2), 'seg': cls[0] if cls else '', 'long': long_,
                            'title': title.strip()})
        elif tag == 'rect' and 'segment' in cls:
            labels.append({'seg': cls[0], 'long': long_, 'x': _f(a.get('x')), 'y': _f(a.get('y')),
                           'w': _f(a.get('width')), 'h': _f(a.get('height')), 'tag': m.group(0), 'start': m.start(),
                           'raw_x': a.get('x'), 'raw_y': a.get('y')})
        elif tag == 'text' and 'segment' in cls:
            pending_text.setdefault((cls[0], long_), []).append({'x': _f(a.get('x')), 'y': _f(a.get('y')), 'tag': m.group(0),
                                                                 'raw_x': a.get('x'), 'raw_y': a.get('y')})
        elif tag == 'path':
            paths.append({'pts': path_points(a.get('d', '')), 'long': long_, 'sw': _f(a.get('stroke-width'), 2)})
        elif tag == 'line':
            paths.append({'pts': [(_f(a.get('x1')), _f(a.get('y1'))), (_f(a.get('x2')), _f(a.get('y2')))],
                          'long': long_, 'sw': _f(a.get('stroke-width'), 2)})
    for lab in labels:
        texts = pending_text.get((lab['seg'], lab['long'])) or []
        lab['text'] = texts.pop(0) if texts else None
    return {'tx': tx, 'ty': ty, 'circles': circles, 'labels': labels, 'paths': paths}


def _visible(items):
    return [it for it in items if not it['long']]


def _rect_hits_circle(rx0, ry0, rx1, ry1, c, margin=0.0):
    r = c['r'] + c['sw'] / 2 + margin
    nx = min(max(c['cx'], rx0), rx1)
    ny = min(max(c['cy'], ry0), ry1)
    return (nx - c['cx']) ** 2 + (ny - c['cy']) ** 2 < r * r


def _rects_overlap(a, b, margin=0.0):
    return not (a[2] + margin <= b[0] or b[2] + margin <= a[0] or a[3] + margin <= b[1] or b[3] + margin <= a[1])


# ---------------------------------------------------------------- the additions

def _helix_boxes(circles):
    box = {}
    for c in _visible(circles):
        if c['seg'] not in HELICES:
            continue
        b = box.setdefault(c['seg'], {'minX': 1e9, 'maxX': -1e9, 'minY': 1e9, 'maxY': -1e9, 'n': 0})
        b['minX'] = min(b['minX'], c['cx']); b['maxX'] = max(b['maxX'], c['cx'])
        b['minY'] = min(b['minY'], c['cy']); b['maxY'] = max(b['maxY'], c['cy']); b['n'] += 1
    for b in box.values():
        b['cx'] = (b['minX'] + b['maxX']) / 2
        b['cy'] = (b['minY'] + b['maxY']) / 2
    return box


def _free(rect, circles, rects, margin=1.0):
    if any(_rect_hits_circle(rect[0], rect[1], rect[2], rect[3], c, margin) for c in circles):
        return False
    return not any(_rects_overlap(rect, r, margin) for r in rects)


def _label_rects(labels):
    return [(l['x'], l['y'], l['x'] + l['w'], l['y'] + l['h']) for l in _visible(labels)]


def _place_pills(geo, box):
    """[(seg, x_centre, y_centre, width)] for every helix present, off every residue and label."""
    vis = _visible(geo['circles'])
    taken = _label_rects(geo['labels'])
    out = []
    for seg in HELICES:
        b = box.get(seg)
        if not b:
            continue
        w = len(seg) * LABEL_CHAR_W + 10
        own = [c for c in vis if c['seg'] == seg]
        if seg == 'H8':
            # H8 by its own geometry: above, else beside (right, left), else below
            cands = [(b['cx'], b['minY'] - PILL_GAP), (b['cx'], b['minY'] - PILL_GAP - 6),
                     (b['maxX'] + 14 + w / 2 + 6, b['cy']), (b['minX'] - 14 - w / 2 - 6, b['cy']),
                     (b['cx'], b['maxY'] + PILL_GAP)]
            ext = [(b['maxX'] + 14 + w / 2 + 6, b['minY']), (b['maxX'] + 14 + w / 2 + 6, b['maxY'])]
            cands = cands[:2] + ext[:1] + cands[2:] + ext[1:]
        else:
            top = min(own, key=lambda c: c['cy'])
            cands = [(b['cx'], b['minY'] - PILL_GAP), (top['cx'], b['minY'] - PILL_GAP),
                     (b['cx'], b['minY'] - PILL_GAP - 8), (top['cx'], b['minY'] - PILL_GAP - 8)]
        for x, y in cands:
            rect = (x - w / 2, y - 8, x + w / 2, y + 7)
            if _free(rect, vis, taken):
                out.append((seg, x, y, w))
                taken.append(rect)
                break
        else:
            raise SnakeBakeError('no free place for the %s label' % seg)
    return out, taken


def _sides(box):
    tms = [box[s] for s in HELICES[:7] if s in box]
    if not tms:
        return None
    top = min(b['minY'] for b in tms)
    bot = max(b['maxY'] for b in tms)
    left = (box['TM1']['minX'] if 'TM1' in box else min(b['minX'] for b in tms)) - 24
    ec_len = len('extracellular side') * SIDE_CHAR_W
    ic_len = len('intracellular side') * SIDE_CHAR_W
    ec_y = top + ec_len                   # anchor start, rotated: the text runs up to the band top
    ic_y = max(bot - ic_len, ec_y + 16)   # anchor end, rotated: the text runs down to the band bottom
    return {'x': left, 'ec_y': ec_y, 'ic_y': ic_y,
            'ec_rect': (left - SIDE_FONT, ec_y - ec_len, left + 3, ec_y),
            'ic_rect': (left - SIDE_FONT, ic_y, left + 3, ic_y + ic_len)}


def _x50(geo, box, taken):
    """[(circle, label, tag position or None)] for the x.50 residue of each helix present."""
    vis = _visible(geo['circles'])
    out = []
    for c in vis:
        parts = c['title'].split()
        if len(parts) != 2:
            continue
        m = _X50_RE.match(parts[1])
        if not m:
            continue
        seg = 'H8' if m.group(1) == '8' else 'TM' + m.group(1)
        if c['seg'] != seg or seg not in box:
            continue
        label = parts[1]
        w = len(label) * TAG_CHAR_W
        row = [o for o in vis if o['seg'] == seg and abs(o['cy'] - c['cy']) < 26]
        right = max(o['cx'] for o in row) + 15
        left = min(o['cx'] for o in row) - 15
        sides = [('start', right), ('end', left)] if seg != 'TM1' else [('end', left), ('start', right)]
        tag = None
        # on the residue's row beside the helix column, else up to 10 px above or below that row
        for dy in (0, -5, 5, -10, 10):
            for anchor, x in sides:
                x0 = x if anchor == 'start' else x - w
                yc = c['cy'] + dy
                rect = (x0 - 1.5, yc - 5.5, x0 + w + 1.5, yc + 4.5)
                if _free(rect, vis, taken, margin=0.5):
                    tag = (anchor, x, yc + 3.2, rect)
                    taken.append(rect)
                    break
            if tag:
                break
        out.append((c, label, tag))
    return out


def collapsed_bbox(geo, extra_rects=()):
    """Bounding box of the collapsed plot in the snake group's coordinates (strokes included)."""
    xs0, ys0, xs1, ys1 = [], [], [], []
    for c in _visible(geo['circles']):
        r = c['r'] + c['sw'] / 2
        xs0.append(c['cx'] - r); xs1.append(c['cx'] + r); ys0.append(c['cy'] - r); ys1.append(c['cy'] + r)
    for l in _visible(geo['labels']):
        xs0.append(l['x'] - 0.5); xs1.append(l['x'] + l['w'] + 0.5); ys0.append(l['y'] - 0.5); ys1.append(l['y'] + l['h'] + 0.5)
    for p in _visible(geo['paths']):
        if not p['pts']:
            continue
        h = p['sw'] / 2
        xs0.append(min(x for x, _ in p['pts']) - h); xs1.append(max(x for x, _ in p['pts']) + h)
        ys0.append(min(y for _, y in p['pts']) - h); ys1.append(max(y for _, y in p['pts']) + h)
    for r in extra_rects:
        xs0.append(r[0]); ys0.append(r[1]); xs1.append(r[2]); ys1.append(r[3])
    return min(xs0), min(ys0), max(xs1), max(ys1)


def check_overlaps(geo, extra_rects=()):
    """Labels lying on residues in the collapsed plot: [(what, residue id)]. Empty when clean."""
    vis = _visible(geo['circles'])
    bad = []
    for l in _visible(geo['labels']):
        rect = (l['x'], l['y'], l['x'] + l['w'], l['y'] + l['h'])
        bad += [('%s label' % l['seg'], c['id']) for c in vis if _rect_hits_circle(*rect, c)]
    for name, rect in extra_rects:
        bad += [(name, c['id']) for c in vis if _rect_hits_circle(*rect, c)]
    return bad


def _set_attr(tag, name, old, new):
    """tag with the attribute name='old' (a whole attribute, not the tail of rx= or ry=) set to new."""
    out, n = re.subn(r"(?<=\s)%s='%s'" % (re.escape(name), re.escape(old)), "%s='%s'" % (name, new), tag, count=1)
    if n != 1:
        raise SnakeBakeError('no %s=%r in %s' % (name, old, tag[:80]))
    return out


def _relocate_terminus_labels(svg, geo):
    """Move an ouroboros N-term / C-term label that lies on residues next to its own residues.

    Only the label's rect x/y and its text x/y change; the residues, the paths and the loop
    labels stay. Returns (svg, [(seg, (old_x, old_y), (new_x, new_y), [[new tag, old tag], ...])])."""
    vis = _visible(geo['circles'])
    moves = []
    others = [l for l in _visible(geo['labels'])]
    for lab in others:
        if lab['seg'] not in TERMINI or lab['text'] is None:
            continue
        rect = (lab['x'], lab['y'], lab['x'] + lab['w'], lab['y'] + lab['h'])
        if not any(_rect_hits_circle(*rect, c) for c in vis):
            continue
        taken = [(o['x'], o['y'], o['x'] + o['w'], o['y'] + o['h']) for o in others if o is not lab]
        anchor = [c for c in vis if c['seg'] in ('H8', 'TM7')] if lab['seg'] == 'C-term' else \
                 [c for c in vis if c['seg'] in ('TM1',)]
        if not anchor:
            anchor = vis
        best = None
        # walk outwards from the current spot on a grid until the label is clear of every residue
        for step in range(1, 40):
            for dx, dy in ((0, 1), (1, 0), (0, -1), (-1, 0), (1, 1), (-1, 1), (1, -1), (-1, -1)):
                nx, ny = lab['x'] + dx * step * 6, lab['y'] + dy * step * 6
                r2 = (nx, ny, nx + lab['w'], ny + lab['h'])
                if _free(r2, vis, taken, margin=2.0):
                    best = (nx, ny)
                    break
            if best:
                break
        if not best:
            raise SnakeBakeError('no free place for the %s label' % lab['seg'])
        nx, ny = best
        dx, dy = nx - lab['x'], ny - lab['y']
        new_rect = _set_attr(_set_attr(lab['tag'], 'x', lab['raw_x'], _fmt(nx)), 'y', lab['raw_y'], _fmt(ny))
        t = lab['text']
        new_text = _set_attr(_set_attr(t['tag'], 'x', t['raw_x'], _fmt(t['x'] + dx)), 'y', t['raw_y'], _fmt(t['y'] + dy))
        if svg.count(lab['tag']) != 1 or svg.count(t['tag']) != 1:
            raise SnakeBakeError('the %s label is not unique in the SVG' % lab['seg'])
        svg = svg.replace(lab['tag'], new_rect, 1).replace(t['tag'], new_text, 1)
        moves.append((lab['seg'], (lab['x'], lab['y']), (nx, ny), [[new_rect, lab['tag']], [new_text, t['tag']]]))
        lab['x'], lab['y'] = nx, ny
    return svg, moves


def bake(svg):
    """The approved SVG with the helix labels, sides, x.50 marks and the fitted viewBox.

    Returns (svg, record). record describes every change (for the per-receptor change log and the
    freeze rules): the moved terminus labels, the pills, the x.50 residues and tags, the old and new
    <svg> attributes, and the overlap check result (always empty, or this raises)."""
    geo = parse(svg)
    svg, moves = _relocate_terminus_labels(svg, geo)
    box = _helix_boxes(geo['circles'])
    pills, taken = _place_pills(geo, box)
    sides = _sides(box)
    if sides:
        taken += [sides['ec_rect'], sides['ic_rect']]
    marks = _x50(geo, box, taken)

    parts = ["<g class='snake-helix-labels' pointer-events='none'>"]
    rng = {}
    for c in _visible(geo['circles']):
        if c['seg'] in HELICES and c['title']:
            num = re.match(r"[A-Z](\d+)", c['title'])
            gn = c['title'].split()[1] if len(c['title'].split()) == 2 else ''
            if num:
                n = int(num.group(1))
                r = rng.setdefault(c['seg'], [n, n, gn, gn])
                if n < r[0]:
                    r[0], r[2] = n, gn
                if n > r[1]:
                    r[1], r[3] = n, gn
    for seg, x, y, w in pills:
        r = rng.get(seg)
        title = seg + (': residues %d to %d' % (r[0], r[1]) if r else '') + \
            (' (%s to %s)' % (r[2], r[3]) if r and r[2] and r[3] else '')
        parts.append("<rect x='%s' y='%s' width='%s' height='%s' rx='3' fill='white' stroke='#c7c7c7' stroke-width='0.8'><title>%s</title></rect>"
                     % (_fmt(x - w / 2), _fmt(y - 8), _fmt(w), _fmt(PILL_H), title))
        parts.append("<text x='%s' y='%s' text-anchor='middle' font-family='helvetica' font-size='11' font-weight='bold' fill='#444' letter-spacing='0.03em'>%s</text>"
                     % (_fmt(x), _fmt(y + 3.5), seg))
    if sides:
        parts.append("<text x='%s' y='%s' transform='rotate(-90 %s %s)' text-anchor='start' font-family='helvetica' font-size='10.5' font-style='italic' fill='#777'>extracellular side</text>"
                     % (_fmt(sides['x']), _fmt(sides['ec_y']), _fmt(sides['x']), _fmt(sides['ec_y'])))
        parts.append("<text x='%s' y='%s' transform='rotate(-90 %s %s)' text-anchor='end' font-family='helvetica' font-size='10.5' font-style='italic' fill='#777'>intracellular side</text>"
                     % (_fmt(sides['x']), _fmt(sides['ic_y']), _fmt(sides['x']), _fmt(sides['ic_y'])))
    parts.append("</g>")
    xparts = ["<g class='snake-x50' pointer-events='none'>"]
    for c, label, tag in marks:
        xparts.append("<circle cx='%s' cy='%s' r='13.1' fill='none' stroke='black' stroke-width='1.8'/>" % (_fmt(c['cx']), _fmt(c['cy'])))
    for c, label, tag in marks:
        if tag:
            anchor, x, y, _ = tag
            xparts.append("<text x='%s' y='%s' text-anchor='%s' font-family='helvetica' font-size='9' font-weight='bold' fill='#333' stroke='white' stroke-width='3' stroke-linejoin='round' paint-order='stroke'>%s</text>"
                          % (_fmt(x), _fmt(y), anchor, label))
    xparts.append("</g>")

    rects = [('%s helix label' % s, (x - w / 2, y - 8, x + w / 2, y + 7)) for s, x, y, w in pills]
    if sides:
        rects += [('extracellular side', sides['ec_rect']), ('intracellular side', sides['ic_rect'])]
    rects += [('%s tag' % label, tag[3]) for c, label, tag in marks if tag]
    bad = check_overlaps(geo, rects)
    if bad:
        raise SnakeBakeError('labels on residues: %s' % bad[:6])

    x0, y0, x1, y1 = collapsed_bbox(geo, [r for _, r in rects])
    x0 += geo['tx'] - PAD; x1 += geo['tx'] + PAD; y0 += geo['ty'] - PAD; y1 += geo['ty'] + PAD
    vb = (round(x0, 1), round(y0, 1), round(x1 - x0, 1), round(y1 - y0, 1))

    close = svg.rfind('</g></svg>')
    if close < 0:
        raise SnakeBakeError('the SVG does not end with </g></svg>')
    svg = svg[:close] + ''.join(parts) + ''.join(xparts) + svg[close:]

    m = _SVG_OPEN_RE.search(svg)
    old_open = m.group(0)
    new_open = re.sub(r"\bheight=(['\"])[\d.]+\1", 'height="%s"' % _fmt(vb[3]), old_open, count=1)
    new_open = re.sub(r"\bwidth=(['\"])[\d.]+\1", 'width="%s"' % _fmt(vb[2]), new_open, count=1)
    new_open = re.sub(r"viewBox=(['\"])[^'\"]*\1", "viewBox='%s %s %s %s'" % tuple(_fmt(v) for v in vb), new_open, count=1)
    svg = svg.replace(old_open, new_open, 1)
    record = {
        'svg_open': [old_open, new_open],
        'viewbox': ' '.join(_fmt(v) for v in vb),
        'helix_labels': [s for s, _, _, _ in pills],
        'h8_label': next(([_fmt(x), _fmt(y)] for s, x, y, _ in pills if s == 'H8'), None),
        'x50': [[label, int(c['id']) if c['id'].isdigit() else c['id'], bool(tag)] for c, label, tag in marks],
        'moved_labels': [[s, [_fmt(a), _fmt(b)], [_fmt(c), _fmt(d)]] for s, (a, b), (c, d), _ in moves],
        # exact [after, before] strings of every changed tag, for the freeze rules
        'replaced_tags': [pair for *_, pairs in moves for pair in pairs] + [[new_open, old_open]],
        'labels_group': ''.join(parts),
        'x50_group': ''.join(xparts),
        'overlaps': [],
    }
    return svg, record


_PILL_RE = re.compile(r"<rect x='([-\d.]+)' y='([-\d.]+)' width='([\d.]+)' height='([\d.]+)' rx='3' fill='white' stroke='#c7c7c7'")
_SIDE_RE = re.compile(r"<text x='([-\d.]+)' y='([-\d.]+)' transform='rotate\(-90[^']*\)' text-anchor='(start|end)'[^>]*>([^<]+)</text>")
_XTAG_RE = re.compile(r"<text x='([-\d.]+)' y='([-\d.]+)' text-anchor='(start|end)'[^>]*paint-order='stroke'>([^<]+)</text>")


def built_overlaps(svg):
    """The overlap check on a built SVG: every label in the collapsed plot (ouroboros' loop and
    terminus labels, the baked helix pills, side labels and x.50 tags) against every residue
    circle shown. Returns [(what, residue id)], empty when clean."""
    geo = parse(svg)
    g = re.search(r"<g class='snake-helix-labels'.*?</g>", svg, re.S)
    x = re.search(r"<g class='snake-x50'.*?</g>", svg, re.S)
    rects = []
    if g:
        for m in _PILL_RE.finditer(g.group(0)):
            x0, y0, w, h = (float(v) for v in m.groups())
            rects.append(('helix label', (x0, y0, x0 + w, y0 + h)))
        for m in _SIDE_RE.finditer(g.group(0)):
            sx, sy, anchor, text = float(m.group(1)), float(m.group(2)), m.group(3), m.group(4)
            n = len(text) * SIDE_CHAR_W
            rects.append((text, (sx - SIDE_FONT, sy - n, sx + 3, sy) if anchor == 'start' else (sx - SIDE_FONT, sy, sx + 3, sy + n)))
    if x:
        for m in _XTAG_RE.finditer(x.group(0)):
            tx_, ty_, anchor, text = float(m.group(1)), float(m.group(2)), m.group(3), m.group(4)
            w = len(text) * TAG_CHAR_W
            x0 = tx_ if anchor == 'start' else tx_ - w
            rects.append(('%s tag' % text, (x0, ty_ - 7, x0 + w, ty_ + 1)))
    return check_overlaps(geo, rects)
