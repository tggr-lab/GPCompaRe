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
  /** The receptor map's data: segment runs, CFR positions, per-residue mean AlphaMissense (0..1) and |ΔRRCS| max. */
  const track = () => ({
    length: n,
    segments: raw.segments.map(([name, a, b]) => [name, a, b]),
    cfr: Object.keys(raw.cfr).map(Number).sort((a, b) => a - b),
    am: raw.am.map(scale),
    dmax: raw.dmax.map(scale),
  });
  return { gid: raw.gid, seq: raw.aa, length: n, residue, findGeneric, track };
}

// ------------------------------------------------------------------------ residue summaries

/** Segment name of a numbered residue from its generic number's segment part ('3' -> TM3, '12' -> ICL1). */
export const SEGMENT_OF = Object.freeze({
  1: 'TM1', 2: 'TM2', 3: 'TM3', 4: 'TM4', 5: 'TM5', 6: 'TM6', 7: 'TM7', 8: 'H8',
  12: 'ICL1', 23: 'ECL1', 34: 'ICL2', 45: 'ECL2', 56: 'ICL3', 67: 'ECL3',
});

const tenth = (v) => (v === null || v === undefined ? null : v / 10);

/** One residue summary row: {generic, segment, net, dmaxSigned, partner, nsig, cons} (x10 integers decoded). */
function summaryRow(generic, segment, net, sm, partner, nsig, cons) {
  return { generic: generic || null, segment: segment || '', net: tenth(net), dmaxSigned: tenth(sm), partner: partner ?? null, nsig: nsig ?? 0, cons: tenth(cons) };
}

/**
 * Decoded generic shard: display number -> [{idx, pos, aa, ...summary row}]. Reads the columnar layout
 * ({i, p, a, s, n, m, q, k, c}) and the earlier row layout ([[idx, pos, aa], ...]).
 */
export function decodeGeneric(raw) {
  const out = {};
  for (const [disp, v] of Object.entries(raw ?? {})) {
    if (Array.isArray(v)) {
      out[disp] = v.map(([idx, pos, aa]) => ({ idx, pos, aa, ...summaryRow(disp, SEGMENT_OF[disp.split('.')[0].split('x')[0]], null, null, null, 0, null) }));
      continue;
    }
    out[disp] = v.i.map((idx, k) => ({
      idx, pos: v.p[k], aa: v.a[k],
      ...summaryRow(disp, Array.isArray(v.s) ? v.s[k] : v.s, v.n[k], v.m[k], v.q[k] === null ? null : v.p[k] + v.q[k], v.k[k], v.c[k]),
    }));
  }
  return out;
}

/**
 * Decoded respos block (positions s..s+B-1 of every receptor): `at(idx, pos)` -> summary row or null.
 */
export function decodeRespos(raw) {
  const s = raw.s;
  const by = new Map();
  for (const [idx, n, gnRuns, segRuns, net, sm, q, k, c] of raw.r) {
    const gn = new Array(n).fill('');
    for (const [off, len, disp] of gnRuns) {
      const m = /^(\d+)\.(\d+)x(\d+)$/.exec(disp);
      for (let j = 0; j < len; j++) gn[off + j] = j === 0 || !m ? disp : `${m[1]}.${Number(m[2]) + j}x${Number(m[3]) + j}`;
    }
    const seg = gn.map((g) => (g ? SEGMENT_OF[g.split('.')[0].split('x')[0]] ?? '' : ''));
    for (const [off, len, name] of segRuns) for (let j = 0; j < len; j++) seg[off + j] = name;
    by.set(idx, { n, gn, seg, net, sm, q, k, c });
  }
  return {
    start: s,
    at(idx, pos) {
      const e = by.get(idx);
      const j = pos - s;
      if (!e || j < 0 || j >= e.n) return null;
      return summaryRow(e.gn[j], e.seg[j], e.net[j], e.sm[j], e.q[j] === null ? null : pos + e.q[j], e.k[j], e.c[j]);
    },
  };
}

// --------------------------------------------------------------------------------- variants

/**
 * Decoded variant shard. alleles[i] = {i, pos, ref, alt, txPos, hgvsp, hgvsc, transcript, id, chrom,
 * g38, ref38, alt38, id37, rsids, ac, an, af, hom, source, am, amClass, conflict, inReportTable}; clinvar records
 * {variationId, accession, title, nm, classification, stars, conditions, gnomadId, pos, ref, alt, kind,
 * packed, spdi}. `inReportTable` is true when the report page's variant table lists the allele's protein
 * change, false when it does not, and null for an index built without that table (no `rt`).
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
      inReportTable: typeof raw.rt === 'string' ? raw.rt[i] === '1' : null,
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

// --------------------------------------------------------------------------------- detail

const AM_CLASS = { B: 'benign', A: 'ambiguous', P: 'pathogenic' };
/** AlphaMissense class of a x1000 score (likely benign below 0.34, likely pathogenic above 0.564). */
const amClassOf = (v) => (v < 340 ? 'benign' : v > 564 ? 'pathogenic' : 'ambiguous');

/**
 * Decoded detail shard (loaded only for a full residue card):
 *   amAt(pos) -> {[alt]: {am, amClass}} over every substitution at the residue, or null without predictions
 *   contactsOf(pos) -> [{a, b, delta, active, inactive}] the residue's threshold-passing contacts, largest |ΔRRCS| first
 *   pairs -> every threshold-passing pair of the receptor
 */
export function decodeDetail(raw, alphabet = 'ACDEFGHIKLMNPQRSTVWY') {
  const letters = alphabet.split('');
  const amAt = (pos) => {
    const row = raw.am?.[pos - 1];
    if (!row) return null;
    const x = raw.amx?.[String(pos)];
    const out = {};
    letters.forEach((a, i) => {
      const v = row[i];
      if (v === null || v === undefined) return;
      out[a] = { am: v / 1000, amClass: x ? (AM_CLASS[x[i]] ?? amClassOf(v)) : amClassOf(v) };
    });
    return Object.keys(out).length ? out : null;
  };
  const pairs = (raw.pairs ?? []).map(([a, b, d, act, inact]) => ({ a, b, delta: d / 100, active: act / 100, inactive: inact / 100 }));
  const byPos = new Map();
  for (const p of pairs) {
    for (const q of (p.a === p.b ? [p.a] : [p.a, p.b])) {
      if (!byPos.has(q)) byPos.set(q, []);
      byPos.get(q).push(p);
    }
  }
  return { gid: raw.gid, amAt, pairs, contactsOf: (pos) => byPos.get(pos) ?? [] };
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
    /** Per-substitution AlphaMissense and contact pairs of one receptor; null for an index without detail/. */
    detail: (gid) => once(`d:${gid}`, async () => {
      const m = await api.meta();
      if (!m?.shards?.detail) return null;
      const r = await L(`detail/${gid}.json`);
      return r ? decodeDetail(r, m.raw.amAlphabet) : null;
    }),
    transcripts: (gid) => once(`t:${gid}`, () => L(`transcripts/${gid}.json`)),
    bases: (gid) => once(`b:${gid}`, () => L(`cds/${gid}.json`)),
    generic: (seg) => once(`g:${seg}`, async () => decodeGeneric(await L(`generic/${seg}.json`))),
    /** Residue summary block holding model position `pos` (all receptors); null for an index without respos/. */
    respos: async (pos) => {
      const m = await api.meta();
      const B = m.shards.respos;
      if (!B || !(pos >= 1)) return null;
      const k = String(Math.floor((pos - 1) / B)).padStart(2, '0');
      return once(`rp:${k}`, async () => { const r = await L(`respos/${k}.json`); return r ? decodeRespos(r) : null; });
    },
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
