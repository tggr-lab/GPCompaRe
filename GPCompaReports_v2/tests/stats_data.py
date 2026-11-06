"""The Statistics page's site-layer payloads (analysis/class_atlas.py), built once per test session on
the real data. Tests skip without the batch run (GPCOMPARE_BATCH_DIR) or the Studio packs."""
import functools

import pytest

from .test_search_index_v2 import _batch_dir


@functools.lru_cache(maxsize=1)
def _build():
    from GPCompaReports_v2.analysis import class_atlas, pack_layer
    from GPCompaReports_v2.analysis.data_loader import GPCRDataStore
    batch = _batch_dir()
    if not (batch / 'csv_data').exists():
        return None, 'no batch data at %s (set GPCOMPARE_BATCH_DIR)' % batch
    if pack_layer.pack_index() is None:
        return None, 'no Studio packs at %s (set STUDIO_ROOT)' % pack_layer.pack_dir()
    store = GPCRDataStore(batch_dir=batch).load_all()
    return (store, class_atlas.build_class_atlas(store)), None


def real_data():
    """(store, atlas) or a pytest skip."""
    built, why = _build()
    if built is None:
        pytest.skip(why)
    return built
