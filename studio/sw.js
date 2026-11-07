const sw = self;
const BUILD = {"app":"a11cbc7f17f02837","pack":"f4c4c6cffe203aca","precache":["assets/LinkPanel-DwB9eSTh.css","assets/LinkPanel-iajJK-7O.js","assets/SearchPanel-1xvKSr3V.css","assets/SearchPanel-CW6e0uBF.js","assets/Viewer3D-D1PmuSsC.js","assets/Viewer3D-RClo9hYH.css","assets/actions-CRBRG0so.js","assets/actions-DRJPGfhW.js","assets/dbRoute-CztM9eJ0.js","assets/ensemble.worker-CcuMlIjF.js","assets/exportPlot-CBwJo69q.js","assets/figure-cCpnTRCS.js","assets/glossary-DYhZt4j1.js","assets/html-Dm0YXBdy.js","assets/index-Ci1YPASL.css","assets/index-DUjX0wr3.js","assets/jumpVariants-D_ZvJH5j.js","assets/lazy-f_mcMwsX.js","assets/limits-CKzggxGb.js","assets/pipeline-D9Y6mPJI.js","assets/plotsChunk-CCK-YHsV.css","assets/plotsChunk-wrP_Ul8T.js","assets/preload-helper-CXT1U_Kj.js","assets/prepare.worker-hJbOtfek.js","assets/references-T2OieEYf.js","assets/run-CqOfKie9.js","assets/segmentOrder-CS8uFl10.js","assets/selection-DBUvAvJ2.js","assets/source-serif-4-greek-DrHU7SY7.woff2","assets/source-serif-4-latin-BpEBLj1O.woff2","assets/target-Cm0if5o6.js","assets/types-TYOlIAtk.js","assets/ui-Cewi3BLj.css","assets/ui-CpYjlRpb.js","assets/variants-p0ecPgoT.js","assets/words-YxYZB-p6.js","index.html","pack/index.json","pack/global.c618ed55f325a5f6.json"]};
const SCOPE = sw.registration.scope;
// per scope: two deployments on one origin (the site root and a subpath) keep their own caches
const PREFIX = `gpcompare-studio ${new URL(SCOPE).pathname} `;
const APP_CACHE = `${PREFIX}app-${BUILD.app}`;
const PACK_PREFIX = `${PREFIX}pack-`;
const PACK_CACHE = `${PACK_PREFIX}${BUILD.pack}`;
const PACK_ROOT = new URL("pack/", SCOPE).href;
const INDEX = new URL("index.html", SCOPE).href;
const PACK_INDEX = new URL("pack/index.json", SCOPE).href;
/** a pack file under its release name: immutable, so safe to answer from any release's cache */
const RELEASE_NAME = /\.[0-9a-f]{16}\.[^/]+$/;
/** a navigation slower than this is answered from the cache (a network that hangs rather than fails) */
const NAVIGATION_TIMEOUT_MS = 5e3;
/** a host's Vary (Origin, Accept-Encoding) would make a module script's CORS request miss what install stored */
const MATCH = { ignoreVary: true };
/** the pack release each open page said it uses, by client id (lost when the worker stops: see step 5 above) */
const releases = new Map();
sw.addEventListener("install", (e) => {
	e.waitUntil(caches.open(APP_CACHE).then((cache) => cache.addAll(BUILD.precache.map((p) => new Request(new URL(p, SCOPE).href, { cache: "reload" })))));
});
sw.addEventListener("activate", (e) => {
	e.waitUntil((async () => {
		// pack caches of other releases stay until no open page uses them (dropOldPacks)
		for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== APP_CACHE && !key.startsWith(PACK_PREFIX)) await caches.delete(key);
		await sw.clients.claim();
		await dropOldPacks();
	})());
});
/** Delete the pack caches of other releases once every open page of this scope has said it uses this one. */
async function dropOldPacks() {
	// the pages this worker controls: an uncontrolled page never reads its caches
	const open = await sw.clients.matchAll({ type: "window" });
	if (!open.every((c) => releases.get(c.id) === BUILD.pack)) return;
	for (const key of await caches.keys()) if (key.startsWith(PACK_PREFIX) && key !== PACK_CACHE) await caches.delete(key);
}
sw.addEventListener("message", (e) => {
	const data = e.data;
	if (data?.type === "skip-waiting") void sw.skipWaiting();
	else if (data?.type === "cache-pack" && Array.isArray(data.urls)) {
		const urls = data.urls.filter((u) => typeof u === "string" && u.startsWith(PACK_ROOT) && RELEASE_NAME.test(u.split(/[?#]/)[0]));
		e.waitUntil(Promise.all(urls.map((u) => fromCache(new Request(u)).catch(() => null))));
	} else if (data?.type === "pack-release" && typeof data.release === "string" && e.source && "id" in e.source) {
		releases.set(e.source.id, data.release);
		e.waitUntil(dropOldPacks());
	}
});
sw.addEventListener("fetch", (e) => {
	const req = e.request;
	if (req.method !== "GET" || !req.url.startsWith(SCOPE)) return;
	const path = req.url.split(/[?#]/)[0];
	if (req.mode === "navigate" && (path === SCOPE || path === INDEX)) e.respondWith(networkFirst(req, INDEX));
	else if (req.url === PACK_INDEX) e.respondWith(networkFirst(req, PACK_INDEX));
	else e.respondWith(fromCache(req));
});
/** The network's answer, or this version's precached `cached` when the network fails or hangs. */
async function networkFirst(req, cached) {
	const net = fetch(req);
	net.catch(() => {});
	const slow = new Promise((resolve) => setTimeout(() => resolve(null), NAVIGATION_TIMEOUT_MS));
	try {
		const res = await Promise.race([net, slow]);
		// a server error is answered from the cache too
		if (res?.ok) return res;
	} catch {}
	// the cached copy is the active version's own, so it always matches the chunks precached with it
	return await caches.match(cached, {
		...MATCH,
		cacheName: APP_CACHE
	}) ?? net;
}
async function fromCache(req) {
	const hit = await caches.match(req, {
		...MATCH,
		cacheName: APP_CACHE
	});
	if (hit) return hit;
	if (!req.url.startsWith(PACK_ROOT) || !RELEASE_NAME.test(req.url.split(/[?#]/)[0])) return fetch(req);
	// an immutable name: any release's cache of this scope holds the same bytes
	for (const key of await caches.keys()) {
		if (!key.startsWith(PACK_PREFIX)) continue;
		const stored = await (await caches.open(key)).match(req, MATCH);
		if (stored) return stored;
	}
	const res = await fetch(req);
	// a host answering a missing file with its index.html is not pack data
	if (res.ok && !(res.headers.get("content-type") ?? "").includes("text/html")) await (await caches.open(PACK_CACHE)).put(req, res.clone());
	return res;
}
