/**
 * Search v2 UI: the browser shard loader. Fetches search2/<path> as JSON; a missing shard reads as
 * null. Shards that meta.json says do not exist (a pseudogene has no transcript or CDS shard) are
 * not requested at all, so the browser console shows no 404s.
 *
 * @module search-ui/loader
 */

import { cachedLoader } from '../search/shards.js';

export function makeLoader(indexUrl) {
  let absent = null; // Set of 'kind/gid.json' paths known not to exist
  const raw = async (path) => {
    if (absent && absent.has(path)) return null;
    const r = await fetch(new URL(path, indexUrl));
    if (!r.ok) return null;
    const json = await r.json();
    if (path === 'meta.json') {
      const gidAt = json.receptorFields.indexOf('gid');
      absent = new Set();
      for (const kind of ['variants', 'transcripts', 'cds']) {
        const have = new Set(json.shards?.[kind] ?? []);
        json.receptors.forEach((rec, idx) => { if (!have.has(idx)) absent.add(`${kind}/${rec[gidAt]}.json`); });
      }
    }
    return json;
  };
  return cachedLoader(raw);
}
