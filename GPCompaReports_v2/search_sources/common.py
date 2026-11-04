"""Shared helpers for the search_sources fetch scripts (python3 stdlib only)."""
import gzip
import http.client
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
# Studio pack checkout holding the 283-receptor packs and the cached gnomAD/ClinVar/Ensembl sources.
STUDIO = Path(os.environ.get(
    "STUDIO_ROOT",
    "/home/yamir/Documents/gpcr_synth/gpcompare_studio_web/.claude/worktrees/main-merge"))
PACK = STUDIO / "public" / "pack"          # index.json + <gid>.json
SOURCES = STUDIO / "pack" / "sources"      # gnomad/ clinvar/ ensembl/ ...
UA = "GPCompaRe-search-sources/1.0 (TGGR lab; yamir)"

ENSEMBL38 = "https://rest.ensembl.org"
ENSEMBL37 = "https://grch37.rest.ensembl.org"


def receptors():
    """List of dicts (gid, gene, uniprotId, uniprotName, ...) in index order."""
    return json.load(open(PACK / "index.json"))["receptors"]


def load_gz_json(path):
    with gzip.open(path, "rt") as fh:
        return json.load(fh)


def write_gz_json(path, obj, indent=None):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    # mtime=0 keeps the gzip bytes reproducible
    with open(tmp, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0, compresslevel=9) as gz:
        gz.write(json.dumps(obj, separators=(",", ":"), sort_keys=True, indent=indent).encode())
    os.replace(tmp, path)


def write_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1, sort_keys=True) + "\n")
    os.replace(tmp, path)


class Client:
    """Rate-limited JSON/text HTTP client: <= `rate` requests/s, honours Retry-After, retries 5xx."""

    def __init__(self, base, rate=8.0, accept="application/json"):
        self.base = base.rstrip("/")
        self.gap = 1.0 / rate
        self.accept = accept
        self.last = 0.0
        self.requests = 0
        self.failures = []
        self.last_headers = {}
        self.lock = threading.Lock()

    def post(self, path, payload, retries=10):
        return self.get(path, retries=retries, payload=payload)

    def get(self, path, accept=None, retries=10, raw=False, ok404=False, payload=None):
        url = path if path.startswith("http") else self.base + path
        delay = 1.0
        for attempt in range(retries):
            with self.lock:    # global rate limit shared by all threads
                wait = self.gap - (time.monotonic() - self.last)
                if wait > 0:
                    time.sleep(wait)
                self.last = time.monotonic()
                self.requests += 1
            hdr = {"Accept": accept or self.accept, "User-Agent": UA}
            data = None
            if payload is not None:
                data = json.dumps(payload).encode()
                hdr["Content-Type"] = "application/json"
            req = urllib.request.Request(url, data=data, headers=hdr)
            try:
                with urllib.request.urlopen(req, timeout=180) as resp:
                    body = resp.read()
                    self.last_headers = dict(resp.headers)
                    if raw:
                        return body
                    text = body.decode()
                    return json.loads(text) if (accept or self.accept).endswith("json") else text
            except urllib.error.HTTPError as e:
                if e.code == 404 and ok404:
                    return None
                if e.code in (429, 503, 500, 502, 504):
                    ra = e.headers.get("Retry-After")
                    sleep = float(ra) if ra and ra.replace(".", "", 1).isdigit() else delay
                    time.sleep(sleep + 0.2)
                    delay = min(delay * 2, 30)
                    continue
                body = e.read().decode(errors="replace")[:200]
                self.failures.append((url, e.code, body))
                raise
            except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException) as e:
                time.sleep(delay)
                delay = min(delay * 2, 30)
                last = e
        self.failures.append((url, "retries-exhausted", ""))
        raise RuntimeError(f"giving up on {url}")
