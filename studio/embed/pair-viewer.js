/*! GPCompaRe pair viewer. Includes Mol* 5.13.1 (MIT, (c) 2017 - now Mol* contributors) and its dependencies: see NOTICE.txt and THIRD_PARTY_NOTICES.txt beside this file. */
//#region src/app/pack/gzip.ts
var e = (e) => e.length >= 2 && e[0] === 31 && e[1] === 139;
async function t(t) {
	if (!e(t)) return t;
	let n = new Blob([t]).stream().pipeThrough(new DecompressionStream("gzip"));
	return new Uint8Array(await new Response(n).arrayBuffer());
}
//#endregion
//#region src/engine/structure/types.ts
var n = (e, t) => `${e} ${t}`, r = class extends Error {
	line;
	constructor(e, t) {
		super(t > 0 ? `line ${t}: ${e}` : e), this.line = t, this.name = "StructureParseError";
	}
}, i = /^[+-]?\d+$/;
function a(e, t, n) {
	let a = e.trim();
	if (!i.test(a)) throw new r(`bad ${n} "${a}"`, t);
	return Number(a);
}
function o(e, t, n) {
	let i = e.trim(), a = i === "" ? NaN : Number(i);
	if (!Number.isFinite(a)) throw new r(`bad ${n} "${i}"`, t);
	return a;
}
function s(e, t) {
	let n = e.trim();
	return i.test(n) ? Number(n) : 1e5 + t;
}
//#endregion
//#region src/engine/structure/mmcif.ts
var c = (e) => e === " " || e === "	";
function l(e) {
	let t = [], n = e.split(/\r?\n/);
	for (let e = 0; e < n.length; e++) {
		let r = n[e];
		if (r.startsWith(";")) {
			let i = e + 1, a = [r.slice(1)];
			for (e++; e < n.length && !n[e].startsWith(";");) a.push(n[e]), e++;
			t.push({
				value: a.join("\n"),
				line: i,
				quoted: !0
			});
			continue;
		}
		let i = 0;
		for (; i < r.length;) {
			let n = r[i];
			if (c(n)) {
				i++;
				continue;
			}
			if (n === "#") break;
			if (n === "'" || n === "\"") {
				let a = i + 1;
				for (; a < r.length && (r[a] !== n || a + 1 !== r.length && !c(r[a + 1]));) a++;
				t.push({
					value: r.slice(i + 1, a),
					line: e + 1,
					quoted: !0
				}), i = a + 1;
				continue;
			}
			let a = i;
			for (; a < r.length && !c(r[a]);) a++;
			t.push({
				value: r.slice(i, a),
				line: e + 1,
				quoted: !1
			}), i = a;
		}
	}
	return t;
}
function u(e, t) {
	return e.length >= 4 ? e.slice(0, 4) : t.length === 1 ? ` ${e}`.padEnd(4) : e.padEnd(4);
}
var d = "_atom_site.";
function f(e, t) {
	let n = `_${t}.`, r = e.findIndex((e) => !e.quoted && e.value.startsWith(n));
	if (r < 0) return null;
	let i = [], a = (e) => !e.quoted && (e.value === "." || e.value === "?") ? "" : e.value, o = (e) => !!e && !e.quoted && (e.value.startsWith("_") || e.value.toLowerCase() === "loop_" || e.value.startsWith("data_")), s = r;
	if (e[r - 1]?.value.toLowerCase() === "loop_" && !e[r - 1].quoted) {
		for (; s < e.length && !e[s].quoted && e[s].value.startsWith(n);) i.push(e[s++].value.slice(n.length));
		let t = [];
		for (; s < e.length && !o(e[s]);) t.push(a(e[s++]));
		let r = [];
		for (let e = 0; e + i.length <= t.length; e += i.length) r.push(t.slice(e, e + i.length));
		return {
			col: (e) => i.indexOf(e),
			rows: r
		};
	}
	let c = [];
	for (; s + 1 < e.length && !e[s].quoted && e[s].value.startsWith(n);) i.push(e[s].value.slice(n.length)), c.push(a(e[s + 1])), s += 2;
	return {
		col: (e) => i.indexOf(e),
		rows: [c]
	};
}
function p(e) {
	let t = f(e, "ma_qa_metric"), n = f(e, "ma_qa_metric_local");
	if (!t || !n) return null;
	let r = /* @__PURE__ */ new Map(), [i, a, o] = [
		t.col("id"),
		t.col("mode"),
		t.col("type")
	];
	for (let e of t.rows) e[a] === "local" && (e[o] === "pLDDT" ? r.set(e[i], 1) : e[o] === "pLDDT in [0,1]" && r.set(e[i], 100));
	if (!r.size) return null;
	let [s, c, l, u, d] = [
		"label_asym_id",
		"label_seq_id",
		"metric_id",
		"metric_value",
		"model_id"
	].map((e) => n.col(e));
	if (s < 0 || c < 0 || l < 0 || u < 0) return null;
	let p = /* @__PURE__ */ new Map(), m = d < 0 ? "" : n.rows[0]?.[d] ?? "";
	for (let e of n.rows) {
		let t = r.get(e[l]);
		if (t === void 0 || d >= 0 && e[d] !== m) continue;
		let n = Number(e[u]);
		Number.isFinite(n) && p.set(`${e[s]} ${e[c]}`, n * t);
	}
	return p.size ? p : null;
}
function m(e) {
	let t = l(e), i = 0;
	for (; i < t.length;) {
		let e = t[i];
		if (!e.quoted && e.value.toLowerCase() === "loop_" && t[i + 1]?.value.startsWith(d)) break;
		i++;
	}
	if (i >= t.length) throw new r("no _atom_site loop", 0);
	i++;
	let c = [];
	for (; i < t.length && !t[i].quoted && t[i].value.startsWith(d);) c.push(t[i].value.slice(11)), i++;
	let f = [];
	for (; i < t.length;) {
		let e = t[i];
		if (!e.quoted && (e.value.startsWith("_") || e.value.toLowerCase() === "loop_" || e.value.startsWith("data_"))) break;
		f.push(e), i++;
	}
	if (f.length % c.length !== 0) throw new r(`_atom_site loop has ${f.length} values for ${c.length} columns`, f.at(-1)?.line ?? 0);
	let m = (e) => c.indexOf(e), h = (e) => {
		let t = m(e);
		if (t < 0) throw new r(`_atom_site.${e} missing`, 0);
		return t;
	}, g = (e, t) => m(e) >= 0 ? m(e) : h(t), _ = h("group_PDB"), v = h("Cartn_x"), y = h("Cartn_y"), b = h("Cartn_z"), x = g("auth_atom_id", "label_atom_id"), S = g("auth_comp_id", "label_comp_id"), C = g("auth_asym_id", "label_asym_id"), w = g("auth_seq_id", "label_seq_id"), T = m("id"), E = m("type_symbol"), D = m("label_alt_id"), O = m("pdbx_PDB_ins_code"), k = m("occupancy"), A = m("pdbx_PDB_model_num"), j = m("B_iso_or_equiv"), M = e.includes("_ma_qa_metric_local.") ? p(t) : null, N = m("label_asym_id"), P = m("label_seq_id"), F = M && N >= 0 && P >= 0 ? /* @__PURE__ */ new Map() : null, I = /* @__PURE__ */ new Map(), L = [];
	for (let e = 0; e < f.length; e += c.length) {
		let t = f.slice(e, e + c.length), r = (e) => {
			if (e < 0) return "";
			let n = t[e].value;
			return !t[e].quoted && (n === "." || n === "?") ? "" : n;
		}, i = t[0].line, l = r(_), d = l === "ATOM" ? "ATOM" : l === "HETATM" ? "HETATM" : null;
		if (d === null) continue;
		let p = r(x), m = r(E).toUpperCase() || (/[A-Za-z]/.exec(p)?.[0] ?? "").toUpperCase(), h = r(A) || "1";
		I.has(h) || I.set(h, I.size + 1);
		let g = r(k), R = I.get(h), z = r(C), B = a(r(w), i, "residue number");
		if (F && R === 1) {
			let e = M.get(`${r(N)} ${r(P)}`);
			e !== void 0 && F.set(n(z, B), e);
		}
		let V = r(j);
		L.push({
			record: d,
			serial: s(r(T), L.length),
			name: u(p, m),
			altLoc: r(D),
			resName: r(S),
			chainId: z,
			resSeq: B,
			iCode: r(O),
			x: o(r(v), i, "x coordinate"),
			y: o(r(y), i, "y coordinate"),
			z: o(r(b), i, "z coordinate"),
			occupancy: g === "" ? 1 : o(g, i, "occupancy"),
			b: V === "" ? NaN : Number(V),
			element: m,
			model: R,
			line: i
		});
	}
	if (L.length === 0) throw new r("no ATOM or HETATM records", 0);
	return {
		format: "mmcif",
		atoms: L,
		models: Math.max(1, I.size),
		...F?.size ? { plddt: F } : {}
	};
}
//#endregion
//#region src/engine/structure/pdb.ts
function h(e) {
	let t = [], n = e.split(/\r?\n/), i = 1, c = 1, l = !1, u = [];
	for (let e = 0; e < n.length; e++) {
		let r = n[e], d = r.slice(0, 6);
		if (d === "HEADER" || d === "TITLE ") {
			u.push(r.slice(10).trim());
			continue;
		}
		if (d === "MODEL ") {
			l && (i += 1), l = !0, c = i;
			continue;
		}
		if (d !== "ATOM  " && d !== "HETATM") continue;
		let f = e + 1, p = r.slice(54, 60), m = parseFloat(r.slice(60, 66));
		t.push({
			record: d === "ATOM  " ? "ATOM" : "HETATM",
			serial: s(r.slice(6, 11), t.length),
			name: r.slice(12, 16).padEnd(4),
			altLoc: r.slice(16, 17).trim(),
			resName: r.slice(17, 20).trim(),
			chainId: r.slice(21, 22).trim(),
			resSeq: a(r.slice(22, 26), f, "residue number"),
			iCode: r.slice(26, 27).trim(),
			x: o(r.slice(30, 38), f, "x coordinate"),
			y: o(r.slice(38, 46), f, "y coordinate"),
			z: o(r.slice(46, 54), f, "z coordinate"),
			occupancy: p.trim() === "" ? 1 : o(p, f, "occupancy"),
			b: m,
			element: r.slice(76, 78).trim().toUpperCase(),
			model: i,
			line: f
		});
	}
	if (t.length === 0) throw new r("no ATOM or HETATM records", 0);
	return {
		format: "pdb",
		atoms: t,
		models: c,
		...u.length ? { header: u.join(" ") } : {}
	};
}
//#endregion
//#region src/engine/structure/index.ts
function g(e, t) {
	let n = t.toLowerCase();
	if (n.endsWith(".cif") || n.endsWith(".mmcif")) return m(e);
	if (n.endsWith(".pdb") || n.endsWith(".ent")) return h(e);
	let r = e.slice(0, 4e3);
	return /^data_/m.test(r) && r.includes("_atom_site.") ? m(e) : h(e);
}
//#endregion
//#region src/app/v2/three/colorMath.ts
function _(e) {
	let t = e.trim(), n = /^#([0-9a-f]{3,8})$/i.exec(t);
	if (n) {
		let e = n[1];
		if ((e.length === 3 || e.length === 4) && (e = [...e].map((e) => e + e).join("")), e.length !== 6 && e.length !== 8) return null;
		let t = parseInt(e.slice(0, 6), 16);
		return [
			t >> 16 & 255,
			t >> 8 & 255,
			t & 255
		];
	}
	return n = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(t), n ? [
		Number(n[1]),
		Number(n[2]),
		Number(n[3])
	] : null;
}
var v = (e) => {
	let t = e / 255;
	return t <= .04045 ? t / 12.92 : ((t + .055) / 1.055) ** 2.4;
}, y = (e) => 255 * (e <= .0031308 ? 12.92 * e : 1.055 * e ** (1 / 2.4) - .055);
function b([e, t, n]) {
	let r = v(e), i = v(t), a = v(n), o = Math.cbrt(.4122214708 * r + .5363325363 * i + .0514459929 * a), s = Math.cbrt(.2119034982 * r + .6806995451 * i + .1073969566 * a), c = Math.cbrt(.0883024619 * r + .2817188376 * i + .6299787005 * a);
	return [
		.2104542553 * o + .793617785 * s - .0040720468 * c,
		1.9779984951 * o - 2.428592205 * s + .4505937099 * c,
		.0259040371 * o + .7827717662 * s - .808675766 * c
	];
}
function x([e, t, n]) {
	let r = (e + .3963377774 * t + .2158037573 * n) ** 3, i = (e - .1055613458 * t - .0638541728 * n) ** 3, a = (e - .0894841775 * t - 1.291485548 * n) ** 3, o = (e) => Math.max(0, Math.min(255, Math.round(y(Math.max(0, Math.min(1, e))))));
	return [
		o(4.0767416621 * r - 3.3077115913 * i + .2309699292 * a),
		o(-1.2684380046 * r + 2.6097574011 * i - .3413193965 * a),
		o(-.0041960863 * r - .7034186147 * i + 1.707614701 * a)
	];
}
function S(e, t, n) {
	let r = b(e), i = b(t);
	return x([
		r[0] + (i[0] - r[0]) * n,
		r[1] + (i[1] - r[1]) * n,
		r[2] + (i[2] - r[2]) * n
	]);
}
function C(e, t, n) {
	let r = [];
	for (let i = 0; i <= 128; i++) {
		let a = i / 128 * 2 - 1, o = Math.abs(a) ** .75;
		r.push(a < 0 ? S(t, e, o) : S(t, n, o));
	}
	return (e) => r[Math.round((Math.max(-1, Math.min(1, Number.isFinite(e) ? e : 0)) + 1) / 2 * 128)];
}
var w = {
	light: {
		surface: "#ffffff",
		ink: "#1f2328",
		active: "#B91C1C",
		inactive: "#1D4ED8",
		brand: "#0D9488",
		accent: "#EA580C",
		clinvar: "#B8129A"
	},
	dark: {
		surface: "#0d1117",
		ink: "#f0f6fc",
		active: "#F87171",
		inactive: "#60A5FA",
		brand: "#2DD4BF",
		accent: "#FB923C",
		clinvar: "#F05BD6"
	}
};
function T(e) {
	let t = typeof document > "u" ? null : getComputedStyle(document.documentElement), n = w[e], r = (e, r) => _(t?.getPropertyValue(e).trim() || n[r]) ?? _(n[r]);
	return {
		mode: e,
		surface: r("--bgColor-default", "surface"),
		ink: r("--fgColor-default", "ink"),
		active: r("--semantic-active", "active"),
		inactive: r("--semantic-inactive", "inactive"),
		brand: r("--brand-primary", "brand"),
		accent: r("--brand-accent", "accent"),
		clinvar: r("--clinvar", "clinvar")
	};
}
//#endregion
//#region src/engine/report/colors.ts
function E(e) {
	let t = e.map(Math.abs).filter((e) => e > 0).sort((e, t) => e - t);
	if (t.length === 0) return 1;
	let n = t[Math.min(t.length - 1, Math.round(.95 * (t.length - 1)))], r = 10 ** Math.floor(Math.log10(n));
	for (let e of [
		1,
		2,
		2.5,
		5,
		10
	]) if (e * r >= n) return e * r;
	return 10 * r;
}
//#endregion
//#region src/app/v2/three/kabsch.ts
var D = {
	rot: [
		1,
		0,
		0,
		0,
		1,
		0,
		0,
		0,
		1
	],
	t: [
		0,
		0,
		0
	],
	rmsd: 0,
	n: 0
};
function O(e, t, n, r) {
	let i = e.rot;
	return [
		i[0] * t + i[1] * n + i[2] * r + e.t[0],
		i[3] * t + i[4] * n + i[5] * r + e.t[1],
		i[6] * t + i[7] * n + i[8] * r + e.t[2]
	];
}
function k(e) {
	let t = e.map((e) => [...e]), n = [
		0,
		1,
		2,
		3
	].map((e) => [
		0,
		1,
		2,
		3
	].map((t) => +(e === t)));
	for (let e = 0; e < 50; e++) {
		let e = 0;
		for (let n = 0; n < 3; n++) for (let r = n + 1; r < 4; r++) e += t[n][r] ** 2;
		if (e < 1e-22) break;
		for (let e = 0; e < 3; e++) for (let r = e + 1; r < 4; r++) {
			let i = t[e][r];
			if (Math.abs(i) < 1e-300) continue;
			let a = (t[r][r] - t[e][e]) / (2 * i), o = Math.sign(a || 1) / (Math.abs(a) + Math.sqrt(a * a + 1)), s = 1 / Math.sqrt(o * o + 1), c = o * s;
			for (let n = 0; n < 4; n++) {
				let i = t[n][e], a = t[n][r];
				t[n][e] = s * i - c * a, t[n][r] = c * i + s * a;
			}
			for (let n = 0; n < 4; n++) {
				let i = t[e][n], a = t[r][n];
				t[e][n] = s * i - c * a, t[r][n] = c * i + s * a;
			}
			for (let t = 0; t < 4; t++) {
				let i = n[t][e], a = n[t][r];
				n[t][e] = s * i - c * a, n[t][r] = c * i + s * a;
			}
		}
	}
	return {
		values: [
			0,
			1,
			2,
			3
		].map((e) => t[e][e]),
		vectors: n
	};
}
function A(e, t) {
	let n = Math.min(e.length, t.length);
	if (n === 0) return D;
	let r = 0, i = 0, a = 0, o = 0, s = 0, c = 0;
	for (let l = 0; l < n; l++) {
		let n = e[l], u = t[l];
		r += n[0], i += n[1], a += n[2], o += u[0], s += u[1], c += u[2];
	}
	let l = [
		r / n,
		i / n,
		a / n
	], u = [
		o / n,
		s / n,
		c / n
	];
	if (n < 3) {
		let r = {
			rot: [
				1,
				0,
				0,
				0,
				1,
				0,
				0,
				0,
				1
			],
			t: [
				l[0] - u[0],
				l[1] - u[1],
				l[2] - u[2]
			],
			rmsd: 0,
			n
		};
		return {
			...r,
			rmsd: j(r, e, t, n)
		};
	}
	let d = 0, f = 0, p = 0, m = 0, h = 0, g = 0, _ = 0, v = 0, y = 0;
	for (let r = 0; r < n; r++) {
		let n = t[r], i = e[r], a = n[0] - u[0], o = n[1] - u[1], s = n[2] - u[2], c = i[0] - l[0], b = i[1] - l[1], x = i[2] - l[2];
		d += a * c, f += a * b, p += a * x, m += o * c, h += o * b, g += o * x, _ += s * c, v += s * b, y += s * x;
	}
	let { values: b, vectors: x } = k([
		[
			d + h + y,
			g - v,
			_ - p,
			f - m
		],
		[
			g - v,
			d - h - y,
			f + m,
			_ + p
		],
		[
			_ - p,
			f + m,
			-d + h - y,
			g + v
		],
		[
			f - m,
			_ + p,
			g + v,
			-d - h + y
		]
	]), S = 0;
	for (let e = 1; e < 4; e++) b[e] > b[S] && (S = e);
	let C = x[0][S], w = x[1][S], T = x[2][S], E = x[3][S], O = Math.hypot(C, w, T, E) || 1;
	C /= O, w /= O, T /= O, E /= O;
	let A = [
		C * C + w * w - T * T - E * E,
		2 * (w * T - C * E),
		2 * (w * E + C * T),
		2 * (w * T + C * E),
		C * C - w * w + T * T - E * E,
		2 * (T * E - C * w),
		2 * (w * E - C * T),
		2 * (T * E + C * w),
		C * C - w * w - T * T + E * E
	], M = {
		rot: A,
		t: [
			l[0] - (A[0] * u[0] + A[1] * u[1] + A[2] * u[2]),
			l[1] - (A[3] * u[0] + A[4] * u[1] + A[5] * u[2]),
			l[2] - (A[6] * u[0] + A[7] * u[1] + A[8] * u[2])
		],
		rmsd: 0,
		n
	};
	return {
		...M,
		rmsd: j(M, e, t, n)
	};
}
function j(e, t, n, r) {
	let i = 0;
	for (let a = 0; a < r; a++) {
		let r = n[a], [o, s, c] = O(e, r[0], r[1], r[2]), l = t[a];
		i += (o - l[0]) ** 2 + (s - l[1]) ** 2 + (c - l[2]) ** 2;
	}
	return Math.sqrt(i / r);
}
//#endregion
//#region src/app/v2/three/scene.ts
var M = (e, t) => String(e).padStart(t);
function N(e, t, n, r, i) {
	let a = e.name.padEnd(4).slice(0, 4);
	return `${e.record.padEnd(6)}${M(i % 1e5, 5)} ${a}${(e.altLoc || " ").slice(0, 1)}${M(e.resName.slice(0, 3), 3)} ${(e.chainId || "A").slice(0, 1)}${M(e.resSeq, 4)}${(e.iCode || " ").slice(0, 1)}   ${t.toFixed(3).padStart(8)}${n.toFixed(3).padStart(8)}${r.toFixed(3).padStart(8)}${e.occupancy.toFixed(2).padStart(6)}${"0.00".padStart(6)}          ${M(e.element.trim().toUpperCase().slice(0, 2), 2)}`;
}
function P(e, t = D) {
	let n = [], r = e[0]?.model ?? 1;
	return e.forEach((e, i) => {
		if (e.model !== r) return;
		let [a, o, s] = t === D ? [
			e.x,
			e.y,
			e.z
		] : O(t, e.x, e.y, e.z);
		n.push(N(e, a, o, s, i + 1));
	}), n.push("END"), n.join("\n");
}
var F = (e) => {
	let t = e.element.trim().toUpperCase();
	return t ? t !== "H" && t !== "D" : !/^\s*\d*[HD]/.test(e.name);
};
function I(e, t, n) {
	let r = /* @__PURE__ */ new Map(), i = /* @__PURE__ */ new Map(), a = e[0]?.model ?? 1;
	for (let o of e) {
		if (o.model !== a || !F(o)) continue;
		let e = n === D ? [
			o.x,
			o.y,
			o.z
		] : O(n, o.x, o.y, o.z), s = o.name.trim(), c = i.get(o.resSeq);
		if (c || i.set(o.resSeq, c = /* @__PURE__ */ new Map()), c.has(s) || c.set(s, e), s === "CA" && o.record === "ATOM") {
			let n = t.get(o.resSeq);
			n !== void 0 && !r.has(n) && r.set(n, e);
		}
	}
	let o = /* @__PURE__ */ new Map();
	for (let [e, n] of t) o.has(n) || o.set(n, e);
	return {
		pdb: P(e, n),
		toShared: t,
		toOwn: o,
		ca: r,
		atoms: i
	};
}
var L = {
	sub: (e, t) => [
		e[0] - t[0],
		e[1] - t[1],
		e[2] - t[2]
	],
	add: (e, t) => [
		e[0] + t[0],
		e[1] + t[1],
		e[2] + t[2]
	],
	mul: (e, t) => [
		e[0] * t,
		e[1] * t,
		e[2] * t
	],
	dot: (e, t) => e[0] * t[0] + e[1] * t[1] + e[2] * t[2],
	cross: (e, t) => [
		e[1] * t[2] - e[2] * t[1],
		e[2] * t[0] - e[0] * t[2],
		e[0] * t[1] - e[1] * t[0]
	],
	norm: (e) => {
		let t = Math.hypot(e[0], e[1], e[2]) || 1;
		return [
			e[0] / t,
			e[1] / t,
			e[2] / t
		];
	}
}, R = (e) => {
	let t = 0, n = 0, r = 0;
	for (let i of e) t += i[0], n += i[1], r += i[2];
	let i = e.length || 1;
	return [
		t / i,
		n / i,
		r / i
	];
};
function z(e, t) {
	let n = [
		0,
		0,
		0
	], r = [];
	for (let i = 1; i <= 7; i++) {
		let a = [...e.keys()].filter((e) => t(e) === `TM${i}`).sort((e, t) => e - t);
		if (a.length < 6) continue;
		let o = a.map((t) => e.get(t)), s = Math.floor(o.length / 2), c = L.sub(R(o.slice(s)), R(o.slice(0, s)));
		n = L.add(n, L.mul(L.norm(c), i % 2 ? -1 : 1)), r.push(...a);
	}
	if (r.length === 0 || Math.hypot(...n) < 1e-6) return null;
	n = L.norm(n);
	let i = L.sub([
		0,
		0,
		1
	], L.mul(n, n[2]));
	return Math.hypot(...i) < .3 && (i = L.sub([
		1,
		0,
		0
	], L.mul(n, n[0]))), i = L.norm(i), {
		up: n,
		back: i,
		tm: r
	};
}
function B(e, t, n, r) {
	let i = (e, t) => {
		let n = /* @__PURE__ */ new Map(), r = e[0]?.model ?? 1;
		for (let i of e) {
			if (i.model !== r || i.record !== "ATOM" || i.name.trim() !== "CA") continue;
			let e = t.get(i.resSeq);
			e !== void 0 && !n.has(e) && n.set(e, [
				i.x,
				i.y,
				i.z
			]);
		}
		return n;
	}, a = i(e, n.active), o = i(t, n.inactive), s = [...a.keys()].filter((e) => o.has(e)), c = A(s.map((e) => a.get(e)), s.map((e) => o.get(e))), l = I(e, n.active, D), u = I(t, n.inactive, c), d = z(l.ca, r), f = d ? d.tm : [...l.ca.keys()], p = R(f.map((e) => l.ca.get(e))), m = (e) => Math.hypot(e[0] - p[0], e[1] - p[1], e[2] - p[2]), h = 0;
	for (let e of f) h = Math.max(h, m(l.ca.get(e)));
	let g = h;
	for (let [e, t] of l.ca) {
		let n = r(e);
		n && n !== "N-term" && n !== "C-term" && (g = Math.max(g, m(t)));
	}
	let _ = d ? [...l.ca.keys()].filter((e) => {
		let t = r(e);
		return t !== "" && t !== "N-term" && t !== "C-term";
	}) : f;
	return {
		A: l,
		B: u,
		fit: c,
		axis: d ? {
			up: d.up,
			back: d.back
		} : null,
		core: f,
		coreCenter: p,
		coreRadius: Math.min(g, h * 1.4),
		body: _
	};
}
var V = (e, t) => e[Math.min(e.length - 1, Math.max(0, Math.round(t * (e.length - 1))))];
function H(e, t, n, r, i) {
	if (e.length === 0) return null;
	let a = L.norm(L.cross(t, n)), o = e.map((e) => L.dot(e, t)).sort((e, t) => e - t), s = e.map((e) => L.dot(e, a)).sort((e, t) => e - t), c = e.map((e) => L.dot(e, n)), l = V(o, r), u = V(o, 1 - r), d = V(s, r), f = V(s, 1 - r), p = c.reduce((e, t) => e + t, 0) / c.length;
	return {
		center: L.add(L.add(L.mul(t, (l + u) / 2), L.mul(a, (d + f) / 2)), L.mul(n, p)),
		halfW: (f - d) / 2 + i,
		halfH: (u - l) / 2 + i
	};
}
function U(e, t, n, r) {
	let i = [], a = ["A", "B"].filter((e) => r[e]);
	if (n === "pair" || n === "residue") for (let r of a) for (let a of n === "pair" ? t.sticks : t.sticks.slice(0, 1)) {
		let t = e[r].toOwn.get(a), n = t === void 0 ? void 0 : e[r].atoms.get(t);
		n && i.push(...n.values());
	}
	let o = n === "pair" ? [] : t.frame ?? e.body;
	for (let t of a) for (let n of o) {
		let r = e[t].ca.get(n);
		r && i.push(r);
	}
	let s = n === "receptor" ? {
		center: e.coreCenter,
		radius: e.coreRadius
	} : W(i);
	if (!s) return null;
	let c = n === "receptor" ? 1 : n === "segment" ? 2 : n === "residue" ? 3 : 2.5, l = Math.max(n === "pair" ? 7 : 8, s.radius + c);
	if (!e.axis) return {
		center: s.center,
		radius: l,
		orient: null
	};
	let { up: u, back: d } = e.axis, f = L.sub(s.center, e.coreCenter);
	f = L.sub(f, L.mul(u, f[0] * u[0] + f[1] * u[1] + f[2] * u[2]));
	let p = n !== "receptor" && Math.hypot(...f) > 3 ? L.norm(f) : d, m = L.mul(p, -1);
	if (n === "receptor" || n === "segment") {
		let e = H(i, u, m, n === "receptor" ? .02 : 0, n === "receptor" ? 3 : 4);
		if (e) return {
			center: e.center,
			radius: l,
			orient: {
				up: u,
				dir: m
			},
			box: {
				halfW: e.halfW,
				halfH: e.halfH
			}
		};
	}
	return {
		center: s.center,
		radius: l,
		orient: {
			up: u,
			dir: m
		}
	};
}
function W(e) {
	if (e.length === 0) return null;
	let t = R(e), n = 0;
	for (let r of e) n = Math.max(n, Math.hypot(r[0] - t[0], r[1] - t[1], r[2] - t[2]));
	return {
		center: t,
		radius: n
	};
}
function ee(e) {
	let t = e.mode === "dark";
	return {
		background: e.surface,
		neutral: S(e.surface, e.ink, t ? .42 : .3),
		active: e.active,
		inactive: e.inactive,
		fade: S(e.surface, e.ink, t ? .16 : .1),
		select: e.brand,
		highlight: e.accent,
		clinvar: e.clinvar,
		outline: t ? [
			0,
			0,
			0
		] : S(e.ink, e.surface, .25)
	};
}
var G = (e) => (e[0] & 255) << 16 | (e[1] & 255) << 8 | e[2] & 255;
function te(e, t, n = null) {
	let r = n ? new Set(n) : null, i = E([...e.values()]), a = C(S(t.neutral, t.inactive, .8), t.neutral, S(t.neutral, t.active, .8)), o = /* @__PURE__ */ new Map();
	for (let [n, s] of e) {
		let e = a(s / i);
		o.set(n, G(r && !r.has(n) ? S(e, t.fade, .72) : e));
	}
	return {
		colours: o,
		limit: i
	};
}
function ne(e, t, n) {
	let r = [];
	for (let i of ["A", "B"]) if (n[i]) for (let n of t) {
		let t = e[i].ca.get(n);
		t && r.push(t);
	}
	let i = W(r);
	if (!i) return null;
	let a = Math.max(16, i.radius + 8);
	if (!e.axis) return {
		center: i.center,
		radius: a,
		orient: null
	};
	let { up: o, back: s } = e.axis, c = L.sub(i.center, e.coreCenter);
	c = L.sub(c, L.mul(o, c[0] * o[0] + c[1] * o[1] + c[2] * o[2]));
	let l = Math.hypot(...c) > 3 ? L.norm(c) : s;
	return {
		center: i.center,
		radius: a,
		orient: {
			up: o,
			dir: L.mul(l, -1)
		}
	};
}
//#endregion
//#region src/app/embed/contacts.ts
var K = {
	show: "passing",
	top: 25,
	sign: "both"
}, q = (e, t) => e <= t ? `${e}-${t}` : `${t}-${e}`, J = (e) => typeof e == "number" && Number.isFinite(e) ? e : null;
function re(e) {
	let t = /* @__PURE__ */ new Map();
	for (let n of e ?? []) {
		let e = J(n?.a), r = J(n?.b), i = J(n?.delta);
		if (e === null || r === null || i === null || e === r) continue;
		let a = Math.min(e, r), o = Math.max(e, r), s = q(a, o);
		t.has(s) || t.set(s, {
			a,
			b: o,
			delta: i,
			active: J(n.active),
			inactive: J(n.inactive),
			passes: n.passes === void 0 || !!n.passes,
			key: s
		});
	}
	return [...t.values()].sort((e, t) => Math.abs(t.delta) - Math.abs(e.delta) || e.a - t.a || e.b - t.b);
}
function ie(e, t, n) {
	let r = {
		...K,
		...t
	}, i = e.filter((e) => r.sign === "active" ? e.delta > 0 : r.sign !== "inactive" || e.delta < 0), a;
	switch (r.show) {
		case "off":
			a = [];
			break;
		case "all":
			a = i;
			break;
		case "top":
			a = i.slice(0, Math.max(0, Math.floor(r.top)));
			break;
		default: a = i.filter((e) => e.passes);
	}
	let o = new Set(a.map((e) => e.key)), s = (e) => {
		e && !o.has(e.key) && (o.add(e.key), a = [...a, e]);
	}, c = null;
	if (n.residue !== null && r.show !== "off") {
		let e = i.filter((e) => e.a === n.residue || e.b === n.residue), t = e.filter((e) => e.passes);
		(t.length ? t : e.slice(0, 8)).forEach(s), c = new Set((t.length ? t : e.slice(0, 8)).map((e) => e.key));
	}
	let l = (t) => t ? e.find((e) => e.key === t) : void 0;
	return n.pair && (s(l(n.pair)), c = /* @__PURE__ */ new Set([n.pair])), n.highlight && s(l(n.highlight)), {
		drawn: a,
		emphasis: c
	};
}
var Y = /* @__PURE__ */ new Set([
	"N",
	"CA",
	"C",
	"O",
	"OXT"
]);
function X(e) {
	if (!e) return null;
	let t = [];
	for (let [n, r] of e) Y.has(n) || t.push(r);
	return t.length ? R(t) : e.get("CA") ?? null;
}
function ae(e) {
	let t = {
		A: /* @__PURE__ */ new Map(),
		B: /* @__PURE__ */ new Map()
	};
	return (n, r) => {
		let i = t[n];
		return i.has(r) || i.set(r, X(e[n].atoms.get(r))), i.get(r);
	};
}
var Z = (e) => Math.min(.85, Math.max(.24, .07 * e)), oe = .45, Q = (e, t) => t === "active" ? "A" : t === "inactive" ? "B" : e.delta >= 0 ? "A" : "B";
function se(e, t, n, r, i, a) {
	let o = [];
	for (let i of e.drawn) {
		let s = Q(i, n), c = t(s, i.a), l = t(s, i.b);
		if (!c || !l) continue;
		let u = Math.abs(i.delta), d = i.delta >= 0 ? r.active : r.inactive, f = a === i.key, p = f || !e.emphasis || e.emphasis.has(i.key), m = p ? d : S(d, r.fade, oe), h = Z(u);
		o.push({
			a: c,
			b: l,
			color: G(m),
			radius: f ? Math.max(h * 1.5, .45) : p && e.emphasis ? h * 1.2 : p ? h : h * .85,
			dashed: !1,
			key: i.key
		});
	}
	return o;
}
var ce = (e) => E(e.map((e) => e.delta)), le = {
	ALA: "A",
	ARG: "R",
	ASN: "N",
	ASP: "D",
	CYS: "C",
	GLN: "Q",
	GLU: "E",
	GLY: "G",
	HIS: "H",
	ILE: "I",
	LEU: "L",
	LYS: "K",
	MET: "M",
	PHE: "F",
	PRO: "P",
	SER: "S",
	THR: "T",
	TRP: "W",
	TYR: "Y",
	VAL: "V",
	HID: "H",
	HIE: "H",
	HIP: "H",
	HSD: "H",
	HSE: "H",
	HSP: "H",
	CYX: "C",
	MSE: "M"
}, $ = (e, t) => `${le[(t.get(e) ?? "").toUpperCase()] ?? ""}${e}`, ue = (e) => e < 0 ? `−${Math.abs(e).toFixed(2)}` : `+${e.toFixed(2)}`, de = (e, t) => `${$(e.a, t)}–${$(e.b, t)}  ΔRRCS ${ue(e.delta)}`;
function fe(e, t) {
	let n = [de(e, t)];
	return e.active !== null && e.inactive !== null && n.push(`Active ${e.active.toFixed(2)}, inactive ${e.inactive.toFixed(2)}`), n.push(e.delta >= 0 ? "Stronger in active" : "Stronger in inactive"), n.join("\n");
}
//#endregion
//#region src/app/embed/pairViewer.ts
var pe = 12, me = () => typeof matchMedia == "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
async function he(e) {
	let n;
	try {
		n = await fetch(e);
	} catch {
		throw Error(`The model could not be fetched: the network is unavailable (${e}).`);
	}
	if (n.status === 404) throw Error(`No model at ${e} (not found).`);
	if (!n.ok) throw Error(`The model could not be fetched (HTTP ${n.status}, ${e}).`);
	return new TextDecoder().decode(await t(new Uint8Array(await n.arrayBuffer())));
}
var ge = (e) => new Map(e.map((e) => [e.resSeq, e.resSeq]));
function _e(e) {
	if (e) return e;
	let t = typeof document < "u" ? document.documentElement.getAttribute("data-color-mode") : null;
	return t === "dark" || t === "light" ? t : typeof matchMedia == "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function ve(e, t) {
	let n = !1, r = null, i = null, a = [...t.highlight ?? []], o = null, s = "both", c = !1, l = null, u = [], d = re(t.contacts ?? []), f = ce(d), p = {
		...K,
		...t.contactOptions ?? {}
	}, m = null, h = null, _ = [], v = "", y = null, b = /* @__PURE__ */ new Map(), x = document.createElement("div");
	x.style.cssText = "position:relative;width:100%;height:100%;min-height:200px;overflow:hidden";
	let C = document.createElement("div");
	C.style.cssText = "position:absolute;inset:0", x.appendChild(C);
	let w = document.createElement("div");
	w.setAttribute("role", "status"), w.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;text-align:center;font:14px/1.4 system-ui,sans-serif;color:inherit", w.textContent = "Loading structures", x.appendChild(w);
	let E = document.createElement("div");
	E.className = "gpc-pv-label", E.setAttribute("aria-live", "polite"), E.style.cssText = "position:absolute;left:8px;top:8px;display:none;padding:3px 8px;border-radius:4px;font:600 13px/1.4 system-ui,sans-serif;white-space:pre;pointer-events:none;background:var(--bgColor-default,#fff);color:var(--fgColor-default,#1f2328);border:1px solid var(--borderColor-default,#d0d7de);opacity:.94", x.appendChild(E);
	let D = document.createElement("div");
	D.className = "gpc-pv-tip", D.setAttribute("role", "tooltip"), D.style.cssText = "position:absolute;display:none;max-width:260px;padding:4px 8px;border-radius:4px;font:12px/1.4 system-ui,sans-serif;white-space:pre-line;pointer-events:none;z-index:2;background:var(--bgColor-default,#fff);color:var(--fgColor-default,#1f2328);border:1px solid var(--borderColor-default,#d0d7de);box-shadow:0 2px 6px rgba(0,0,0,.18)", x.appendChild(D), e.appendChild(x);
	let O = (e) => e ? d.find((t) => t.key === e) : void 0, k = (e) => {
		let t = O(e);
		if (t) return de(t, b);
		let [n, r] = e.split("-").map(Number);
		return `${$(n, b)}\u2013${$(r, b)}`;
	}, A = () => {
		m ? (E.textContent = k(m), E.style.display = "block") : E.style.display = "none";
	}, j = (e, t) => {
		if (!e || !t) {
			D.style.display = "none";
			return;
		}
		D.textContent = e, D.style.display = "block";
		let n = x.getBoundingClientRect(), r = t[0] - (n.left + (window.scrollX || 0)), i = t[1] - (n.top + (window.scrollY || 0)), a = D.offsetWidth || 160, o = D.offsetHeight || 40;
		D.style.left = `${Math.max(4, Math.min(n.width - a - 4, r + 12))}px`, D.style.top = `${Math.max(4, i - o - 10 < 4 ? i + 16 : i - o - 10)}px`;
	}, M = () => ({
		A: s !== "inactive",
		B: s !== "active"
	}), N = () => ee(T(_e(t.colorMode))), P = t.residueColouring !== !1, F = () => {
		let e = N();
		if (!P) {
			let n = _e(t.colorMode) === "dark", r = G(S(e.background, T(n ? "dark" : "light").ink, n ? .4 : .2));
			return {
				A: /* @__PURE__ */ new Map(),
				B: /* @__PURE__ */ new Map(),
				neutral: r
			};
		}
		let n = /* @__PURE__ */ new Map();
		for (let [e, r] of Object.entries(t.residueValues ?? {})) Number.isFinite(r) && n.set(Number(e), r);
		let { colours: r } = te(n, e);
		return {
			A: r,
			B: r,
			neutral: G(e.neutral)
		};
	}, I = () => m ? m.split("-").map(Number) : [], L = () => [.../* @__PURE__ */ new Set([
		...o === null ? [] : [o],
		...I(),
		...a.length <= pe ? a : []
	])].filter((e) => i.A.atoms.has(e) || i.B.atoms.has(e)), z = () => {
		if (!i) return null;
		if (m) {
			let e = I();
			return U(i, {
				rows: [],
				frame: e,
				sticks: e,
				emphasis: e,
				pair: null
			}, "pair", M());
		}
		if (o === null) {
			if (!i.axis) {
				let e = [...i.A.ca.values()], t = R(e), n = (e) => Math.hypot(e[0] - t[0], e[1] - t[1], e[2] - t[2]), r = W(e.sort((e, t) => n(e) - n(t)).slice(0, Math.ceil(e.length * .85)));
				return r ? {
					center: r.center,
					radius: Math.max(12, r.radius * 1.2 + 4),
					orient: null
				} : null;
			}
			return U(i, {
				rows: [],
				frame: null,
				sticks: [],
				emphasis: null,
				pair: null
			}, "receptor", M());
		}
		return ne(i, [o], M());
	}, V = !1, H = !1, J = async (t) => {
		let n = r;
		if (!n || n.isDisposed || !i) return;
		let l = L(), u = M().A && M().B ? {
			cartoon: {
				A: 1,
				B: .22
			},
			sticks: {
				A: 1,
				B: .6
			}
		} : {
			cartoon: {
				A: 1,
				B: 1
			},
			sticks: {
				A: 1,
				B: 1
			}
		};
		n.setShown(M()), await n.apply({
			...t.colours ? { colours: F() } : {},
			alpha: u,
			sticks: {
				A: M().A ? l.filter((e) => i.A.atoms.has(e)) : [],
				B: M().B ? l.filter((e) => i.B.atoms.has(e)) : []
			}
		});
		let g = [.../* @__PURE__ */ new Set([...a, ...o === null ? [] : [o]])];
		n.select({
			A: g.filter((e) => i.A.atoms.has(e)),
			B: g.filter((e) => i.B.atoms.has(e))
		});
		let b = ie(d, p, {
			residue: o,
			pair: m,
			highlight: h
		}), x = se(b, y, s, N(), f, h), S = new Set(x.map((e) => e.key));
		_ = b.drawn.filter((e) => S.has(e.key));
		let C = `${s}|${x.map((e) => `${e.key}:${e.color}:${e.radius.toFixed(3)}`).join(",")}`;
		if (C !== v && (v = C, await n.setLinks(x)), e.setAttribute("data-contacts-drawn", String(_.length)), A(), t.frame) {
			let e = z();
			e && (n.handleResize(), n.frame(e.center, e.radius, c || me() ? 0 : 320, e.orient ?? void 0, e.box)), c = !1;
		}
	}, Y = {
		colours: !0,
		frame: !0
	}, X = async () => {
		if (V) H = !0;
		else {
			V = !0;
			try {
				do {
					H = !1;
					let e = Y;
					Y = {
						colours: !1,
						frame: !1
					}, await J(e);
				} while (H);
			} finally {
				V = !1;
			}
		}
	}, Z = (e) => {
		Y = {
			colours: Y.colours || !!e.colours,
			frame: Y.frame || !!e.frame
		}, X();
	}, oe = (e) => {
		let r = e instanceof Error ? e : Error(String(e));
		if (n) return r;
		let i = /webgl/i.test(r.message) ? "3D needs WebGL, which is off or unavailable in this browser." : r.message;
		return w.textContent = i, w.style.display = "flex", t.onError?.(r), r;
	}, Q = (async () => {
		let [e, a] = await Promise.all([he(t.activeUrl), he(t.inactiveUrl)]);
		if (n) throw Error("disposed");
		let o = g(e, "active.pdb").atoms, s = g(a, "inactive.pdb").atoms, d = Object.entries(t.segments ?? {});
		i = B(o, s, {
			active: ge(o),
			inactive: ge(s)
		}, (e) => d.find(([, [t, n]]) => e >= t && e <= n)?.[0] ?? ""), y = ae(i);
		for (let e of [...s, ...o]) b.set(e.resSeq, e.resName);
		let { Viewer: f } = await import("./chunks/viewer-Dp3s4rzu.js");
		if (n) throw Error("disposed");
		let p = N(), m = await f.create(C, G(p.background));
		if (r = m, n) throw m.dispose(), Error("disposed");
		if (m.setMarkColours(G(p.select), G(p.highlight)), m.setOutline(G(p.outline)), await m.load("A", i.A.pdb), await m.load("B", i.B.pdb), n) throw Error("disposed");
		m.plugin.canvas3d?.commit(!0), m.holdCamera();
		let h = "";
		l = m.onPointer((e) => {
			if (e?.kind === "residue" && e.resSeq !== void 0) t.onPick?.(e.resSeq);
			else if (e?.kind === "link") {
				let n = O(e.key ?? null);
				n && t.onPickContact?.(n);
			}
		}, (e) => {
			let n = "";
			if (e?.kind === "link") {
				let r = O(e.key ?? null);
				r && (n = `c${r.key}`, j(fe(r, b), e.page), n !== h && t.onHover?.({
					a: r.a,
					b: r.b,
					delta: r.delta
				}));
			} else if (e?.kind === "residue" && e.resSeq !== void 0) {
				let r = e.resSeq;
				n = `r${r}`;
				let i = t.residueValues?.[r];
				j(`${$(r, b)}${typeof i == "number" && Number.isFinite(i) ? `  net \u0394RRCS ${ue(i)}` : ""}`, e.page), n !== h && t.onHover?.({ res: r });
			}
			n || (j(null), h && t.onHover?.(null)), h = n;
		});
		let _ = "", v = new ResizeObserver(([e]) => {
			let t = e?.contentRect, n = t ? `${Math.round(t.width)}x${Math.round(t.height)}` : "";
			if (n === _ || !r || r.isDisposed) return;
			let i = _;
			_ = n, r.handleResize(), i && (c = !0, Z({ frame: !0 }));
		});
		if (v.observe(x), u.push(() => v.disconnect()), !t.colorMode) {
			let e = new MutationObserver(() => {
				let e = N();
				r?.setBackground(G(e.background)), r?.setMarkColours(G(e.select), G(e.highlight)), r?.setOutline(G(e.outline)), Z({ colours: !0 });
			});
			e.observe(document.documentElement, {
				attributes: !0,
				attributeFilter: ["data-color-mode"]
			}), u.push(() => e.disconnect());
		}
		return w.style.display = "none", Y = {
			colours: !0,
			frame: !0
		}, await X(), {
			rmsd: i.fit.rmsd,
			n: i.fit.n
		};
	})().catch((e) => {
		throw oe(e);
	});
	return Q.catch(() => {}), {
		ready: Q,
		focus(e) {
			o = e !== null && Number.isFinite(e) ? e : null, m = null, Z({ frame: !0 });
		},
		setContacts(e, t) {
			d = re(e), f = ce(d), t && (p = {
				...p,
				...t
			}), Z({});
		},
		setResidueColouring(e) {
			P = !!e, Z({ colours: !0 });
		},
		setContactOptions(e) {
			p = {
				...p,
				...e
			}, Z({});
		},
		highlightContact(e, t) {
			h = e === null || t === void 0 || !Number.isFinite(e) || !Number.isFinite(t) ? null : q(e, t), Z({});
		},
		focusContact(e, t) {
			Number.isFinite(e) && Number.isFinite(t) && e !== t && (m = q(e, t), o = null, A(), Z({ frame: !0 }));
		},
		hoverResidue(e) {
			let t = r;
			if (!t || t.isDisposed || !i) return;
			let n = e !== null && Number.isFinite(e) ? [e] : [];
			t.hover({
				A: n.filter((e) => i.A.atoms.has(e)),
				B: n.filter((e) => i.B.atoms.has(e))
			});
		},
		drawnContacts() {
			return [..._];
		},
		setHighlight(e) {
			a = [...e], Z({});
		},
		setShow(e) {
			s = e, Z({ frame: !0 });
		},
		dispose() {
			n || (n = !0, l?.(), u.forEach((e) => e()), r?.dispose(), x.remove());
		}
	};
}
//#endregion
export { ve as mountPairViewer };
