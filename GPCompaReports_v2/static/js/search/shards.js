/**
 * Search v2: loading and decoding the index shards under `search2/` (written by
 * website/page_generators/search_index_v2.py). Pure apart from the injected loader.
 *
 * Loader contract: `loader(path) -> Promise<object>` where `path` is relative to the search2 root
 * ('meta.json', 'variants/par2_human.json'). It rejects (or resolves to null) when a shard is absent.
 * In the browser: `(p) => fetch(base + p).then((r) => (r.ok ? r.json() : null))`; in node tests:
 * `async (p) => JSON.parse(await readFile(join(dir, p), 'utf8'))`.
 *
 * @module search/shards
 */

import { aliasKey } from './normalize.js';
import { complement } from './txmap.js';

const AA3 = {
  A: 'Ala', R: 'Arg', N: 'Asn', D: 'Asp', C: 'Cys', Q: 'Gln', E: 'Glu', G: 'Gly', H: 'His', I: 'Ile',
  L: 'Leu', K: 'Lys', M: 'Met', F: 'Phe', P: 'Pro', S: 'Ser', T: 'Thr', W: 'Trp', Y: 'Tyr', V: 'Val', '*': 'Ter',
};
export const three = (a) => AA3[a] ?? a;

/** A memoising wrapper: every shard is fetched once; missing shards read as null. */
export function cachedLoader(loader) {
  if (loader && loader.__search2Cache) return loader;
  const memo = new Map();
  const f = (path) => {
    if (!memo.has(path)) memo.set(path, Promise.resolve().then(() => loader(path)).catch(() => null));
    return memo.get(path);
  };
  f.__search2Cache = true;
  return f;
}

// ------------------------------------------------------------------------------------- meta

/**
 * Decoded meta: receptors (objects), index by gid, alias map (key -> [{display, idx, tier, collision}]),
 * windows and the receptor matcher for parse().
 */
export function decodeMeta(raw) {
  const F = raw.receptorFields;
  const receptors = raw.receptors.map((r, idx) => {
    const o = { idx };
    F.forEach((k, i) => { o[k] = r[i]; });
    return o;
  });
  const byGid = new Map(receptors.map((r) => [r.gid, r]));
  const aliases = new Map();
  for (const [key, display, idx, tier, collision] of raw.aliases) {
    if (!aliases.has(key)) aliases.set(key, []);
    aliases.get(key).push({ display, idx, tier, collision: collision ?? '' });
  }
  const keys = [...aliases.keys()];
  const excluded = (raw.excluded ?? []).map(([symbol, name, reason]) => ({ symbol, name, reason, keys: [aliasKey(symbol), aliasKey(name)] }));
  return { raw, receptors, byGid, aliases, keys, excluded, windows: raw.windows, shards: raw.shards, releases: raw.releases, cfrRank: raw.cfrRank ?? {}, cfrTop: raw.cfrTop };
}

/**
 * The receptor matcher parse() takes as ctx.matchReceptor: exact alias-key matches of the best tier
 * (an HGNC symbol, accession, entry name or id outranks an alias, which outranks a previous symbol),
 * then every receptor whose key starts with the typed key (two characters or more) as non-exact.
 */
export function makeMatcher(meta) {
  return (term) => {
    const k = aliasKey(term);
    if (!k) return [];
    const out = [];
    const hit = meta.aliases.get(k);
    if (hit) {
      const best = Math.min(...hit.map((h) => h.tier));
      for (const h of hit) if (h.tier === best && !out.some((o) => o.idx === h.idx)) out.push({ gid: meta.receptors[h.idx].gid, idx: h.idx, exact: true });
    }
    if (k.length >= 2) {
      for (const key of meta.keys) {
        if (key === k || !key.startsWith(k)) continue;
        for (const h of meta.aliases.get(key)) if (!out.some((o) => o.idx === h.idx)) out.push({ gid: meta.receptors[h.idx].gid, idx: h.idx, exact: false });
      }
    }
    return out;
  };
}

// --------------------------------------------------------------------------------- residues

/** Decoded residue shard: residue(pos) -> {pos, aa, segment, generic, bw, gpcrdb, cfrRank, dmax, nsig, cons, am}. */
export function decodeResidues(raw, meta) {
  const n = raw.aa.length;
  const seg = new Array(n + 1).fill('');
  for (const [name, a, b] of raw.segments) for (let i = a; i <= b; i++) seg[i] = name;
  const gn = new Array(n + 1).fill('');
  for (const [start, len, disp] of raw.gn) {
    const m = /^(\d+)\.(\d+)x(\d+)$/.exec(disp);
    for (let k = 0; k < len; k++) gn[start + k] = k === 0 || !m ? disp : `${m[1]}.${Number(m[2]) + k}x${Number(m[3]) + k}`;
  }
  const scale = (v) => (v === null || v === undefined ? null : v / 100);
  const residue = (pos) => {
    if (!(pos >= 1 && pos <= n)) return null;
    const g = gn[pos];
    const [bwPart, xPart] = g ? g.split('x') : ['', ''];
    const segNum = bwPart ? bwPart.split('.')[0] : '';
    return {
      pos, aa: raw.aa[pos - 1], segment: seg[pos], generic: g, bw: bwPart || null,
      gpcrdb: g ? `${segNum}x${xPart}` : null,
      cfrRank: g && meta?.cfrRank?.[g] ? meta.cfrRank[g] : null,
      cfr: !!raw.cfr[String(pos)],
      dmax: scale(raw.dmax[pos - 1]), nsig: raw.nsig[String(pos)] ?? 0,
      conservation: scale(raw.cons[pos - 1]), amMean: scale(raw.am[pos - 1]),
    };
  };
  const findGeneric = (bw, gpcrdb) => {
    const out = [];
    for (let p = 1; p <= n; p++) {
      const g = gn[p];
      if (!g) continue;
      const [b, x] = g.split('x');
      const gx = `${b.split('.')[0]}x${x}`;
      if ((bw === null || bw === b) && (gpcrdb === null || gpcrdb === gx)) out.push(p);
    }
    return out;
  };
  return { gid: raw.gid, seq: raw.aa, length: n, residue, findGeneric };
}

// --------------------------------------------------------------------------------- variants

/**
 * Decoded variant shard. alleles[i] = {i, pos, ref, alt, txPos, hgvsp, hgvsc, transcript, id, chrom,
 * g38, ref38, alt38, id37, rsids, ac, an, af, hom, source, am, amClass, conflict}; clinvar records
 * {variationId, accession, title, nm, classification, stars, conditions, gnomadId, pos, ref, alt, kind,
 * packed, spdi}.
 */
export function decodeVariants(raw) {
  const alleles = [];
  const tx = raw.gnomad ? `${raw.gnomad.tx}.${String(raw.gnomad.v).replace(/^(\d+).*$/, '$1')}` : null;
  let pos = 0; let g = 0; let an = 0;
  for (let i = 0; i < raw.n; i++) {
    pos += raw.pos[i];
    g += raw.g[i];
    an += raw.an[i];
    const ref = raw.ref[i]; const alt = raw.alt[i];
    const txPos = raw.tx[i];
    const [r38, a38] = raw.nt[i].split('>');
    const numbering = txPos ?? pos;
    let hgvsc = raw.hgvscX[String(i)] ?? null;
    if (hgvsc === null && raw.c[i] !== null) {
      const c = 3 * numbering - 2 + raw.c[i];
      hgvsc = `c.${c}${raw.strand === 1 ? r38 : complement(r38)}>${raw.strand === 1 ? a38 : complement(a38)}`;
    }
    const g37 = raw.g37[i];
    let id37 = null;
    if (g37 !== null && g37 !== undefined) {
      id37 = typeof g37 === 'number' ? `${raw.chrom}-${g + g37}-${r38}-${a38}` : g37;
    }
    const rs = raw.rs[i];
    alleles.push({
      i, pos, ref, alt, txPos, transcript: tx,
      hgvsp: raw.hgvspX[String(i)] ?? `p.${three(ref)}${numbering}${three(alt)}`,
      hgvsc, id: `${raw.chrom}-${g}-${r38}-${a38}`, chrom: raw.chrom, g38: g, ref38: r38, alt38: a38, id37,
      rsids: rs ? rs.map((n) => `rs${n}`) : [], ac: raw.ac[i], an, af: an ? raw.ac[i] / an : null,
      hom: raw.hom[i], source: raw.src[i] === 'e' ? 'exome' : 'genome',
      am: raw.am[i] === null ? null : raw.am[i] / 1000, amClass: { B: 'benign', A: 'ambiguous', P: 'pathogenic' }[raw.amc[i]] ?? null,
      conflict: raw.conflict[i] === '1',
    });
  }
  const cv = raw.clinvar;
  const F = cv.fields;
  const clinvar = cv.rows.map((r) => {
    const o = {};
    F.forEach((k, j) => { o[k] = r[j]; });
    o.classification = cv.classes[o.class];
    o.conditions = o.conditions.map((j) => cv.conditions[j]);
    o.accession = `VCV${String(o.variationId).padStart(9, '0')}${o.version ? `.${o.version}` : ''}`;
    o.nm = /^((?:NM|NR|XM)_\d+\.\d+)\(/.exec(o.title)?.[1] ?? null;
    o.packed = !!o.packed;
    o.url = `https://www.ncbi.nlm.nih.gov/clinvar/variation/${o.variationId}/`;
    return o;
  });
  const byPos = new Map();
  for (const a of alleles) { if (!byPos.has(a.pos)) byPos.set(a.pos, []); byPos.get(a.pos).push(a); }
  const byG38 = new Map();
  for (const a of alleles) { if (!byG38.has(a.g38)) byG38.set(a.g38, []); byG38.get(a.g38).push(a); }
  return {
    gid: raw.gid, chrom: raw.chrom, strand: raw.strand, gnomad: raw.gnomad, transcript: tx, alleles, byPos, byG38,
    byId: new Map(alleles.map((a) => [a.id, a])), clinvar,
    clinvarById: new Map(clinvar.map((c) => [c.variationId, c])),
    dropped: raw.dropped ?? [],
  };
}

// ------------------------------------------------------------------------------------- rsid

/** Decoded rsID shard: Map(rs number -> [receptor idx]). */
export function decodeRsid(raw, shard, shards) {
  const out = new Map();
  let q = 0;
  raw.q.forEach((d, j) => {
    q += d;
    const v = raw.v[j];
    out.set(q * shards + shard, Array.isArray(v) ? v : [v]);
  });
  return out;
}

// ------------------------------------------------------------------------------- loaders

const decoded = new WeakMap();

/** Shard accessors over a (cached) loader; decoded objects are memoised per loader. */
export function shardsFor(loader) {
  const L = cachedLoader(loader);
  if (decoded.has(L)) return decoded.get(L);
  const memo = new Map();
  const once = (key, f) => {
    if (!memo.has(key)) memo.set(key, f());
    return memo.get(key);
  };
  const api = {
    load: L,
    meta: () => once('meta', async () => { const m = await L('meta.json'); return m ? decodeMeta(m) : null; }),
    seq: () => once('seq', () => L('seq.json')),
    txindex: () => once('txindex', () => L('txindex.json')),
    residues: (gid) => once(`r:${gid}`, async () => { const m = await api.meta(); const r = await L(`residues/${gid}.json`); return r ? decodeResidues(r, m) : null; }),
    variants: (gid) => once(`v:${gid}`, async () => { const r = await L(`variants/${gid}.json`); return r ? decodeVariants(r) : null; }),
    transcripts: (gid) => once(`t:${gid}`, () => L(`transcripts/${gid}.json`)),
    bases: (gid) => once(`b:${gid}`, () => L(`cds/${gid}.json`)),
    generic: (seg) => once(`g:${seg}`, () => L(`generic/${seg}.json`)),
    rsid: async (n) => {
      const m = await api.meta();
      const k = m.shards.rsid;
      const shard = n % k;
      return once(`rs:${shard}`, async () => {
        const raw = await L(`rsid/${String(shard).padStart(2, '0')}.json`);
        return raw ? decodeRsid(raw, shard, k) : new Map();
      });
    },
    clinvar: async (id) => {
      const m = await api.meta();
      const shard = String(id % m.shards.clinvar).padStart(2, '0');
      return once(`cv:${shard}`, async () => (await L(`clinvar/${shard}.json`)) ?? {});
    },
    /** Observed substitutions at model position `pos`: {'<pos><ref><alt>': [receptor idx]} (gnomAD or ClinVar). */
    subst: async (pos) => {
      const m = await api.meta();
      if (!m.shards.subst) return null;
      const shard = String(pos % m.shards.subst).padStart(2, '0');
      return once(`su:${shard}`, async () => (await L(`subst/${shard}.json`)) ?? {});
    },
    hgvsc: async (cpos) => {
      const m = await api.meta();
      const shard = String(cpos % m.shards.hgvsc).padStart(2, '0');
      return once(`hc:${shard}`, async () => (await L(`hgvsc/${shard}.json`)) ?? {});
    },
  };
  decoded.set(L, api);
  return api;
}
