"""Which method built each GPCRdb model (GPCompaReports_v2/data/model_methods.json).

GPCRdb labels every model of its 2024-05-15 build AlphaFold2-Multistate or plain AlphaFold2. The site
shows them as "AlphaFold-Multistate" and "AlphaFold2".

    load()                 the file as a dict (cached)
    for_receptor(gid)      {'active': name or None, 'inactive': name or None}, display names
    line(gid)              "Inactive model: AlphaFold2; active model: AlphaFold-Multistate" ("Both models: ..."
                           when they match), or '' when unknown
    uses(gid, name)        True when either model of the receptor was built with that method
    counts()               {'active': {display name: n}, 'inactive': {...}, 'receptors': n}, unknown left out
    install(env)           env.globals['model_methods'] = this module
"""
import json
import sys
from pathlib import Path

PATH = Path(__file__).resolve().parent.parent / 'data' / 'model_methods.json'
STATES = ('active', 'inactive')
AFMS = 'AlphaFold-Multistate'
AF2 = 'AlphaFold2'
_cache = None


def load(path=None):
    global _cache
    if path is not None:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    if _cache is None:
        _cache = json.loads(PATH.read_text(encoding='utf-8'))
    return _cache


def _display(method):
    if not method:
        return None
    return load()['display'].get(method, method)


def for_receptor(gid):
    rec = load()['receptors'].get(gid) or {}
    return {s: _display((rec.get(s) or {}).get('method')) for s in STATES}


def line(gid):
    m = for_receptor(gid)
    if not (m['active'] and m['inactive']):
        return ''
    if m['active'] == m['inactive']:
        return 'Both models: %s' % m['active']
    return 'Inactive model: %s; active model: %s' % (m['inactive'], m['active'])


def uses(gid, name):
    return name in for_receptor(gid).values()


def counts():
    c = load()['counts']
    out = {'receptors': c['receptors']}
    for s in STATES:
        out[s] = {_display(k): v for k, v in c[s].items() if k != 'unknown'}
    return out


def install(env):
    env.globals['model_methods'] = sys.modules[__name__]
    return env
