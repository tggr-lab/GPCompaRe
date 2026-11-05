/**
 * Search v2: the CFR neighbourhood of a residue, and the variants of one receptor that sit in it.
 *
 * How a residue relates to the core functional residue (CFR) positions of its own receptor, by four exact rules
 * (one place, so the card, the receptor list and the tests agree):
 *
 *   at         the residue's generic number is a CFR position: one of the meta.cfrTop (50) top-ranked class-wide
 *              CFR positions by CFR score (residues/<gid>.json `cfr`: the rule of the card's CFR flag, the report
 *              snake plots and residue table, and the Statistics page)
 *   connected  the residue takes part in a contact above the receptor's |ΔRRCS| threshold (detail/ `pairs`, the
 *              report's pair list) whose partner residue is at a CFR position
 *   near       the residue lies within NEAR_SEQ (2) residues of a CFR position along the chain and in the same
 *              segment (both in TM6, both in ECL2, ...)
 *   touch      the residue has a modelled contact with a CFR residue (RRCS > 0 in either model) that stays below the
 *              threshold (detail/ `cfrc`); unknown (null) for an index built without those contacts
 *
 * Every relation is listed for a residue (a CFR residue can also be connected to another CFR); its `group` is the
 * first that applies in the order at, connected, near, touch, so a residue is counted once in a list.
 *
 * Pure: the inputs are the decoded residues and detail shards (shards.js) or fixtures of the same shape.
 *
 * @module search/cfrhood
 */

/** "Near in sequence": at most this many residues away along the chain, in the same segment. */
export const NEAR_SEQ = 2;
/** Group keys, in precedence order. */
export const CFR_GROUPS = Object.freeze(['at', 'connected', 'near', 'touch']);

const byAbsDelta = (x, y) => Math.abs(y.delta) - Math.abs(x.delta) || x.pos - y.pos;

/**
 * @param {{length: number, residue: (pos: number) => ({aa, generic, segment, cfr, cfrRank}|null)}} res decoded residues
 * @param {{pairs?: {a, b, delta, active, inactive}[], cfrContacts?: {a, b, delta}[]|null}|null} det decoded detail
 * @returns {{cfr: {pos, aa, generic, segment, rank}[], hasContacts: boolean, hasTouch: boolean, of: (pos: number) => Hood|null}}
 *
 * Hood: {pos, aa, generic, segment, at: boolean, rank: number|null, group: 'at'|'connected'|'near'|'touch'|null,
 *        connected: [{pos, aa, generic, segment, rank, delta, active, inactive, a, b}],   largest |ΔRRCS| first
 *        near: [{pos, aa, generic, segment, rank, offset}],   offset = CFR position - this residue (-2..2, not 0)
 *        touch: [{pos, aa, generic, segment, rank, delta, a, b}] | null}   below-threshold contacts with CFR residues
 */
export function cfrNeighbourhood(res, det) {
  const n = res?.length ?? 0;
  const info = (p) => {
    const x = res.residue(p);
    return { pos: p, aa: x.aa, generic: x.generic || null, segment: x.segment || null, rank: x.cfrRank ?? null };
  };
  const cfr = new Map();
  for (let p = 1; p <= n; p++) if (res.residue(p)?.cfr) cfr.set(p, info(p));
  const add = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  const connected = new Map();
  for (const c of det?.pairs ?? []) {
    if (c.a === c.b) continue;
    for (const [me, other] of [[c.a, c.b], [c.b, c.a]]) {
      if (cfr.has(other)) add(connected, me, { ...cfr.get(other), delta: c.delta, active: c.active, inactive: c.inactive, activePresent: c.activePresent, inactivePresent: c.inactivePresent, a: c.a, b: c.b });
    }
  }
  const hasTouch = Array.isArray(det?.cfrContacts);
  const touch = new Map();
  for (const c of det?.cfrContacts ?? []) {
    if (c.a === c.b) continue;
    for (const [me, other] of [[c.a, c.b], [c.b, c.a]]) if (cfr.has(other)) add(touch, me, { ...cfr.get(other), delta: c.delta, a: c.a, b: c.b });
  }
  const of = (pos) => {
    const x = res?.residue(pos);
    if (!x) return null;
    const near = [];
    for (let k = -NEAR_SEQ; k <= NEAR_SEQ; k++) {
      const c = k ? cfr.get(pos + k) : null;
      if (c && x.segment && c.segment === x.segment) near.push({ ...c, offset: k });
    }
    near.sort((u, v) => Math.abs(u.offset) - Math.abs(v.offset) || u.offset - v.offset);
    const conn = [...(connected.get(pos) ?? [])].sort(byAbsDelta);
    const t = hasTouch ? [...(touch.get(pos) ?? [])].sort(byAbsDelta) : null;
    const at = cfr.has(pos);
    const group = at ? 'at' : conn.length ? 'connected' : near.length ? 'near' : t?.length ? 'touch' : null;
    return { pos, aa: x.aa, generic: x.generic || null, segment: x.segment || null, at, rank: at ? cfr.get(pos).rank : null, group, connected: conn, near, touch: t };
  };
  return { cfr: [...cfr.values()], hasContacts: Array.isArray(det?.pairs), hasTouch, of };
}

/**
 * The variants of one receptor at residues in the CFR neighbourhood: one row per gnomAD allele (with the ClinVar
 * records joined to it by the record's gnomAD id) and one row per ClinVar missense record that has no gnomAD allele
 * in the index. ClinVar records of other kinds (synonymous, stop, frameshift, ...) do not change the residue to
 * another amino acid and are only counted (`skipped`).
 *
 * @param {ReturnType<typeof cfrNeighbourhood>} hood
 * @param {{alleles: object[], clinvar: object[]}|null} vars decoded variants shard
 * @param {((pos: number) => ({[alt]: {am, amClass}}|null))|null} amAt per-substitution AlphaMissense (detail/), optional
 * @returns {{rows: CfrRow[], skipped: number}}
 *
 * CfrRow: {group, pos, ref, alt, hood, allele: Allele|null, clinvar: ClinvarRecord[], am: number|null, amClass: string|null}
 */
export function cfrVariantRows(hood, vars, amAt = null) {
  const rows = [];
  if (!hood || !vars) return { rows, skipped: 0 };
  const memo = new Map();
  const hoodOf = (p) => { if (!memo.has(p)) memo.set(p, hood.of(p)); return memo.get(p); };
  const cvByAllele = new Map();
  for (const c of vars.clinvar ?? []) if (c.gnomadId) { if (!cvByAllele.has(c.gnomadId)) cvByAllele.set(c.gnomadId, []); cvByAllele.get(c.gnomadId).push(c); }
  const joined = new Set();
  const amOf = (pos, alt, own) => {
    if (own && own.am !== null && own.am !== undefined) return { am: own.am, amClass: own.amClass ?? null };
    const p = amAt?.(pos)?.[alt];
    return p ? { am: p.am, amClass: p.amClass } : { am: null, amClass: null };
  };
  for (const a of vars.alleles ?? []) {
    const h = hoodOf(a.pos);
    if (!h?.group) continue;
    const cv = cvByAllele.get(a.id) ?? [];
    for (const c of cv) joined.add(c.variationId);
    rows.push({ group: h.group, pos: a.pos, ref: a.ref, alt: a.alt, hood: h, allele: a, clinvar: cv, ...amOf(a.pos, a.alt, a) });
  }
  let skipped = 0;
  for (const c of vars.clinvar ?? []) {
    if (!c.pos || joined.has(c.variationId)) continue;
    const h = hoodOf(c.pos);
    if (!h?.group) continue;
    if (c.kind !== 'missense' || !/^[A-Z]$/.test(c.alt ?? '')) { skipped += 1; continue; }
    rows.push({ group: h.group, pos: c.pos, ref: c.ref, alt: c.alt, hood: h, allele: null, clinvar: [c], ...amOf(c.pos, c.alt, null) });
  }
  const order = (g) => CFR_GROUPS.indexOf(g);
  rows.sort((x, y) => order(x.group) - order(y.group) || x.pos - y.pos || String(x.alt).localeCompare(String(y.alt)) || (x.allele ? 0 : 1) - (y.allele ? 0 : 1));
  return { rows, skipped };
}

/** P/LP: a ClinVar classification that starts "Pathogenic" or "Likely pathogenic" (as the card's grouping). */
export const isPlp = (c) => /^(?:pathogenic|likely pathogenic)/i.test(String(c?.classification ?? ''));
