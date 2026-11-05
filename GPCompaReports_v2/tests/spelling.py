"""British spellings in user-facing text (the site is written in American English).

Shared by tests/test_american_spelling.py. Three extractors, each returning the text a reader
can see: visible text and reader-facing attributes of a built HTML page, the string literals of a
JavaScript file (comments skipped), and the `content:` strings of a stylesheet. `british_hits`
then finds the British forms in that text.

The pattern list is a word list, not a dictionary: the -our, -re, -ise/-yse, doubled-l and
odd-one-out spellings that have an American form. Ambiguous words are left out on purpose
("analyses" is also the American plural noun, "dialogue" is American prose).
"""
import re
from html.parser import HTMLParser

_STEMS = [
    # -our
    r'colour', r'favour', r'behaviour', r'honour', r'labour', r'neighbour', r'harbour', r'humour',
    r'flavour', r'endeavour', r'odour', r'armour', r'rumour', r'vapour', r'savour', r'valour',
    r'clamour', r'rigour', r'tumour',
    # -re
    r'centre', r'metre', r'litre', r'fibre', r'calibre', r'theatre',
    r'spectre', r'sombre', r'lustre',
    # -ise / -yse (verb forms only, so "analysis", "synthesis" and "emphasis" do not match)
    r'analys(?:e|ed|er|ers|ing)\b', r'(?:para|cata|dia|hydro|electro)lys(?:e|ed|ing)\b',
    r'(?:normal|organ|priorit|summar|recogn|visual|minim|maxim|optim|character|standard|categor|'
    r'custom|initial|serial|final|util|real|general|special|author|stabil|random|parameter|'
    r'memor|memo|penal|local|critic|harmon|apolog|rational|polar|equal|central|emphas|synthes|'
    r'hypothes|symbol|stigmat|capital|neutral|minimal|digit|vector|token|linear|binar|discret|'
    r'quant|sanit|synchron|regular|global|individual|vocal|util|mobil|immobil|steril|'
    r'ion|oxid|crystall|polymer|homogen|solubil|internal|external|annual|sensit|metabol|miner|'
    r'fertil|familiar|modern|computer|motor|econom|dramat|patron|subsid|terror|jeopard)'
    r'is(?:e|ed|es|er|ers|ing|ation|ations|able)\b',
    # doubled l
    r'labell(?:ed|ing|er)', r'modell(?:ed|ing|er|ers)', r'travell(?:ed|ing|er|ers)',
    r'cancell(?:ed|ing)', r'levell(?:ed|ing)', r'signall(?:ed|ing)', r'channell(?:ed|ing)',
    r'fuelled', r'fuelling', r'totalled', r'counsell', r'tunnell', r'jewell', r'marshall(?:ed|ing)',
    r'focuss(?:ed|es|ing)',
    # one-offs
    r'catalogue', r'licence', r'defence', r'offence', r'pretence', r'practis(?:e|ed|es|ing)\b',
    r'programme(?!r)', r'whilst', r'amongst', r'amidst', r'artefact', r'fulfil(?:s|ment)?\b',
    r'enrol(?:s|ment)?\b', r'instalment', r'skilful', r'wilful', r'(?<![a-z])grey', r'aluminium',
    r'sulphur', r'(?<![a-z])haem', r'anaes', r'oedem', r'leukaem', r'paediat', r'oesophag',
    r'oestr', r'(?<![a-z])foet', r'manoeuvr', r'judgement', r'(?<![a-z])ageing', r'cheque',
    r'(?<![a-z])tyres?\b', r'(?<![a-z])mould', r'sceptic', r'orientated', r'(?<![a-z])learnt\b',
    r'(?<![a-z])spelt\b', r'aeroplane', r'analogue',
]

BRITISH_RE = re.compile('|'.join('(?:%s)' % s for s in _STEMS), re.I)
_WORD_RE = re.compile(r'[A-Za-z][A-Za-z0-9_-]*')


def british_hits(text):
    """[(token, word)] for every British spelling in text. token is the whole run of
    letters, digits, '-' and '_' around the match (what an allowlist names)."""
    out = []
    for m in _WORD_RE.finditer(text):
        tok = m.group(0)
        hit = BRITISH_RE.search(tok)
        if hit:
            out.append((tok, hit.group(0)))
    return out


# ----------------------------------------------------------------------------------- HTML pages

READER_ATTRS = {'title', 'alt', 'placeholder', 'aria-label', 'aria-description', 'aria-roledescription',
                'data-tooltip', 'data-label', 'data-title', 'data-caption', 'data-note', 'value',
                'summary', 'label'}
_META_TEXT = {'description', 'og:title', 'og:description', 'twitter:title', 'twitter:description'}


class _Reader(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.chunks = []      # (kind, text): 'text', 'attr' or 'script'
        self._raw = None       # tag whose content is collected raw ('script' or 'style')
        self._script_kind = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        for name, value in attrs:
            if value and name in READER_ATTRS:
                self.chunks.append(('attr', value))
        if tag == 'meta' and (a.get('name') in _META_TEXT or a.get('property') in _META_TEXT):
            self.chunks.append(('attr', a.get('content') or ''))
        if tag == 'script':
            self._raw = 'script'
            self._script_kind = 'json' if 'json' in (a.get('type') or '') else 'js'
        elif tag == 'style':
            self._raw = 'style'

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self._raw = None

    def handle_data(self, data):
        if self._raw == 'script':
            self.chunks.append(('script', data))
        elif self._raw == 'style':
            self.chunks.append(('style', data))
        else:
            self.chunks.append(('text', data))


def html_reader_text(html):
    """The reader-facing text of an HTML page as a list of strings: text nodes, reader-facing
    attributes, string literals of inline scripts (JSON data included: Plotly hover text and
    titles are read on screen) and `content:` strings of inline styles. SVG presentation
    attributes such as stroke='grey' are not reader text and are not collected."""
    p = _Reader()
    p.feed(html)
    out = []
    for kind, text in p.chunks:
        if kind in ('text', 'attr'):
            out.append(text)
        elif kind == 'script':
            out.extend(js_strings(text))
        else:
            out.extend(css_content_strings(text))
    return out


# --------------------------------------------------------------------------------- JavaScript

_REGEX_PREV = set('(,=:[!&|?{};+-*%<>~^') | {''}
_REGEX_WORDS = {'return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do'}


def js_strings(src):
    """The string literal contents of JavaScript source (template literals included, with their
    ${...} parts), comments and regular-expression literals skipped. A small scanner, enough
    for this site's hand-written files; not a full parser."""
    out = []
    i, n = 0, len(src)
    prev = ''          # last significant character
    prev_word = ''     # last identifier, to tell `return /re/` from `a / b`
    tmpl_depth = []    # brace depth inside each open template ${...}
    while i < n:
        c = src[i]
        if c in ' \t\r\n':
            i += 1
            continue
        if src.startswith('//', i):
            j = src.find('\n', i)
            i = n if j < 0 else j
            continue
        if src.startswith('/*', i):
            j = src.find('*/', i + 2)
            i = n if j < 0 else j + 2
            continue
        if c in '\'"':
            j = i + 1
            buf = []
            while j < n and src[j] != c and src[j] != '\n':
                if src[j] == '\\' and j + 1 < n:
                    buf.append(src[j + 1])
                    j += 2
                    continue
                buf.append(src[j])
                j += 1
            out.append(''.join(buf))
            i = j + 1
            prev, prev_word = 'str', ''
            continue
        if c == '`' or (c == '}' and tmpl_depth and tmpl_depth[-1] == 0):
            if c == '}':
                tmpl_depth.pop()
            j = i + 1
            buf = []
            while j < n:
                if src[j] == '\\' and j + 1 < n:
                    buf.append(src[j + 1])
                    j += 2
                    continue
                if src[j] == '`':
                    j += 1
                    break
                if src.startswith('${', j):
                    tmpl_depth.append(0)
                    j += 2
                    break
                buf.append(src[j])
                j += 1
            out.append(''.join(buf))
            i = j
            prev, prev_word = 'str', ''
            continue
        if c == '/' and (prev in _REGEX_PREV or prev_word in _REGEX_WORDS):
            j = i + 1
            in_class = False
            while j < n and src[j] != '\n':
                if src[j] == '\\':
                    j += 2
                    continue
                if src[j] == '[':
                    in_class = True
                elif src[j] == ']':
                    in_class = False
                elif src[j] == '/' and not in_class:
                    break
                j += 1
            j += 1
            while j < n and src[j].isalpha():
                j += 1
            i = j
            prev, prev_word = 'regex', ''
            continue
        if c.isalnum() or c in '_$':
            j = i
            while j < n and (src[j].isalnum() or src[j] in '_$'):
                j += 1
            prev_word = src[i:j]
            prev = 'word'
            i = j
            continue
        if tmpl_depth:
            if c == '{':
                tmpl_depth[-1] += 1
            elif c == '}':
                tmpl_depth[-1] -= 1
        prev, prev_word = c, ''
        i += 1
    return out


_CSS_COMMENT = re.compile(r'/\*.*?\*/', re.S)
_CSS_CONTENT = re.compile(r'content\s*:\s*(["\'])(.*?)\1', re.S)


def css_content_strings(src):
    """The `content:` strings of a stylesheet (the only CSS text a reader sees)."""
    return [m.group(2) for m in _CSS_CONTENT.finditer(_CSS_COMMENT.sub('', src))]
