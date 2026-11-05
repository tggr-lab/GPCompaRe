"""The version registry (GPCompaReports_v2/data_versions.json): one place that names every data release.

    load()                      the registry as a dict (cached)
    install(env)                env.globals['data_versions'] = load(), for every template
    write_site_copy(output_dir) <site>/data_versions.json, for JS
    label(key) / long_label(key)
    search_releases()           the `releases` block of search2/meta.json

Templates read labels from `data_versions.sources.<key>.label`; nothing else should spell a release.
"""
import json
import shutil
from pathlib import Path

PATH = Path(__file__).resolve().parent.parent / 'data_versions.json'
_cache = None

# search2/meta.json `releases`: key -> the registry fields search has always carried
_SEARCH_FIELDS = {
    'gnomad': ('label', 'dataset', 'fetched'),
    'clinvar': ('label', 'build', 'fetched'),
    'ensembl': ('label', 'grch38', 'grch37', 'fetched'),
    'refseq': ('label', 'fetched'),
    'hgnc': ('label', 'fetched'),
    'uniprot': ('label', 'fetched'),
    'alphamissense': ('label',),
}


def load(path=None):
    global _cache
    if path is not None:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    if _cache is None:
        _cache = json.loads(PATH.read_text(encoding='utf-8'))
    return _cache


def source(key):
    return load()['sources'][key]


def label(key):
    return source(key)['label']


def long_label(key):
    s = source(key)
    return s.get('long_label') or s['label']


def install(env):
    env.globals['data_versions'] = load()
    return env


def write_site_copy(output_dir):
    dst = Path(output_dir) / 'data_versions.json'
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(PATH, dst)
    return dst


def search_releases():
    """search2/meta.json `releases`: the same keys and fields as before the registry, plus
    `database` (the RRCS batch) and `reportTable` (what the report variant tables are built from)."""
    out = {}
    for key, fields in _SEARCH_FIELDS.items():
        s = source(key)
        out[key] = {f: s[f] for f in fields if f in s}
    out['database'] = {'label': label('rrcs_batch')}
    out['reportTable'] = report_table_release()
    return out


def report_table_release(key='gnomad'):
    """What the report pages' variant tables list: the gnomAD release and the selection rule."""
    s = source(key)
    return {'label': s['label'], 'key': key, 'rule': '|dRRCS| >= 3.0',
            'sameAsSearch': key == 'gnomad'}
