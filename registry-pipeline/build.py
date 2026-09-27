#!/usr/bin/env python3
"""ModelFit registry builder.

Reads models.yaml (curated) and, when present, discovered.yaml (written by
discover.py), enriches both from Hugging Face (exact GGUF file sizes +
KV-cache cost computed from GGUF header metadata), validates, and emits
registry/registry.json — the file the app bundles and fetches remotely.

The two tiers are the design, not an implementation detail. A curated entry
carries a hand-written quality score and is the only kind the app will offer
as a BEST / SAFE / FAST pick. A discovered entry carries facts read out of the
model file and no quality at all: it is listed, so "will this run here" is
answered for hundreds of models, and it is never recommended, so a pick always
rests on a number a person stood behind.

Runs in CI on a schedule; never on user machines. Every HF lookup has a
curated fallback so one moved repo can't break the build.

Usage:  python3 build.py [--offline] [--out PATH]
"""

from __future__ import annotations

import argparse
import datetime
import re
from typing import NamedTuple
import json
import struct
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import yaml

HERE = Path(__file__).parent
UA = {"User-Agent": "modelfit-registry-pipeline/1.0"}

GIB = 1024**3

# Known quantizations, smallest to largest. FP16 is deliberately absent: at
# ~2 bytes/weight it is rarely the right local choice and would trip the
# bytes/weight guard below.
QUANT_ORDER = ["Q3_K_M", "Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0"]


# Hugging Face rate-limits anonymous traffic, and a discovery pass makes
# hundreds of requests. A 429 is the server saying "wait", not "no" — but an
# unhandled one aborts the run and throws away every model already fetched,
# which is an hour of network for nothing. Handled here, at the one place
# every request goes through, rather than at each call site.
RETRY_STATUSES = {429, 500, 502, 503, 504}
MAX_RETRIES = 6
# Minimum gap between requests. Cheaper than being throttled: the backoff
# above costs whole minutes once the server is already annoyed.
MIN_REQUEST_INTERVAL = 0.12
_last_request = 0.0


def _urlopen(req, timeout: int):
    """urlopen with polite pacing and backoff on the statuses that mean "later"."""
    global _last_request
    delay = 2.0
    for attempt in range(MAX_RETRIES):
        gap = time.monotonic() - _last_request
        if gap < MIN_REQUEST_INTERVAL:
            time.sleep(MIN_REQUEST_INTERVAL - gap)
        _last_request = time.monotonic()
        try:
            return urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            if e.code not in RETRY_STATUSES or attempt == MAX_RETRIES - 1:
                raise
            # The server's own Retry-After beats our guess whenever it sends one.
            try:
                wait = float(e.headers.get("Retry-After") or 0)
            except (TypeError, ValueError):
                wait = 0.0
            time.sleep(min(max(wait, delay), 90.0))
            delay *= 2
        except (urllib.error.URLError, TimeoutError):
            if attempt == MAX_RETRIES - 1:
                raise
            time.sleep(delay)
            delay *= 2
    raise RuntimeError("unreachable")


def http_json(url: str):
    req = urllib.request.Request(url, headers=UA)
    with _urlopen(req, timeout=30) as r:
        return json.load(r)


def http_range(url: str, n: int) -> bytes:
    req = urllib.request.Request(url, headers={**UA, "Range": f"bytes=0-{n - 1}"})
    with _urlopen(req, timeout=60) as r:
        return r.read()


class FileFact(NamedTuple):
    size: int
    # The LFS object id IS the file's sha256 — what a downloader verifies
    # against. Absent only for a non-LFS file, which no real GGUF is.
    sha256: str | None


class QuantHit(NamedTuple):
    path: str          # the first (or only) file of the quant
    size: int          # total bytes across every shard
    files: list[tuple[str, int, str | None]]  # (path, size, sha256) per shard


def list_repo_files(repo: str) -> dict[str, FileFact]:
    """filename (basename, may be in subfolder) -> (size in bytes, sha256)."""
    files: dict[str, FileFact] = {}
    tree = http_json(f"https://huggingface.co/api/models/{repo}/tree/main?recursive=true")
    for entry in tree:
        if entry.get("type") == "file" and entry["path"].lower().endswith(".gguf"):
            lfs = entry.get("lfs") or {}
            size = entry.get("size") or lfs.get("size")
            if size:
                files[entry["path"]] = FileFact(int(size), lfs.get("oid"))
    return files


# "<name>-Q6_K.gguf" or, for a model too big for one file,
# "<name>-Q6_K-00001-of-00002.gguf". The quant must end the stem: a substring
# test matches "Q6_K" inside "Q6_K_L", and summing the shards of both variants
# is how a 70B model ends up claiming 165 GB at Q6_K.
SHARD_SUFFIX = r"(?:-\d{5}-of-\d{5})?"


def find_quant_file(files: dict[str, FileFact], quant: str) -> QuantHit | None:
    """The files of one quant and their total bytes, summing shards when it has any."""
    pattern = re.compile(rf"[-._]{re.escape(quant)}{SHARD_SUFFIX}\.gguf$", re.IGNORECASE)
    matches = [(p, f) for p, f in files.items() if pattern.search(p)]
    if not matches:
        return None
    plain = [(p, f) for p, f in matches if not re.search(r"-\d{5}-of-\d{5}\.gguf$", p)]
    if plain:
        # A single file always wins: prefer the shortest path, so a top-level
        # file beats a subfolder copy of the same quant.
        path, fact = min(plain, key=lambda t: len(t[0]))
        return QuantHit(path, fact.size, [(path, fact.size, fact.sha256)])
    shards = [(p, f) for p, f in matches if (p, f) not in plain]
    # Shards of one quant may sit beside another variant's; group by the stem
    # before the part number so only one model's parts are added together.
    groups: dict[str, list[tuple[str, FileFact]]] = {}
    for path, fact in shards:
        groups.setdefault(re.sub(r"-\d{5}-of-\d{5}\.gguf$", "", path), []).append((path, fact))
    stem, parts = min(groups.items(), key=lambda kv: len(kv[0]))
    parts.sort(key=lambda t: t[0])
    return QuantHit(
        parts[0][0],
        sum(f.size for _, f in parts),
        [(p, f.size, f.sha256) for p, f in parts],
    )


# --- minimal GGUF v2/v3 header reader (metadata only) -----------------------

GGUF_MAGIC = b"GGUF"
_T_STR = 8
_SIMPLE = {0: "B", 1: "b", 2: "H", 3: "h", 4: "I", 5: "i", 6: "f", 7: "?", 10: "Q", 11: "q", 12: "d"}
_SIZES = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}


class _Reader:
    def __init__(self, buf: bytes):
        self.buf = buf
        self.pos = 0

    def take(self, n: int) -> bytes:
        if self.pos + n > len(self.buf):
            raise EOFError("GGUF header larger than fetched range")
        b = self.buf[self.pos : self.pos + n]
        self.pos += n
        return b

    def u64(self) -> int:
        return struct.unpack("<Q", self.take(8))[0]

    def string(self) -> str:
        return self.take(self.u64()).decode("utf-8", "replace")

    def value(self, vtype: int):
        if vtype in _SIMPLE:
            fmt = _SIMPLE[vtype]
            return struct.unpack("<" + fmt, self.take(_SIZES[vtype]))[0]
        if vtype == _T_STR:
            return self.string()
        if vtype == 9:  # array
            etype = struct.unpack("<I", self.take(4))[0]
            count = self.u64()
            # Skip arrays wholesale; we only need scalar metadata.
            if etype == _T_STR:
                for _ in range(count):
                    self.take(self.u64())
            elif etype in _SIZES:
                self.take(_SIZES[etype] * count)
            else:
                raise ValueError(f"nested array of type {etype}")
            return None
        raise ValueError(f"unknown GGUF value type {vtype}")


def gguf_metadata(url: str, fetch_bytes: int = 8 * 1024 * 1024) -> dict:
    """Read scalar metadata KVs from the head of a GGUF file via range request.

    The header ends up as large as the tokenizer it carries: a 262K-token
    vocabulary (Gemma) needs well past the 8 MB that covers most repos, so a
    short read is retried with a bigger window before giving up.
    """
    for size in (fetch_bytes, fetch_bytes * 3):
        try:
            return _gguf_metadata_from(http_range(url, size))
        except EOFError:
            last = size
    raise EOFError(f"GGUF header larger than {last} bytes")


def _gguf_metadata_from(buf: bytes) -> dict:
    r = _Reader(buf)
    if r.take(4) != GGUF_MAGIC:
        raise ValueError("not a GGUF file")
    version = struct.unpack("<I", r.take(4))[0]
    if version < 2:
        raise ValueError(f"GGUF v{version} unsupported")
    r.u64()  # tensor count
    n_kv = r.u64()
    meta: dict = {}
    for _ in range(n_kv):
        key = r.string()
        vtype = struct.unpack("<I", r.take(4))[0]
        val = r.value(vtype)
        if val is not None:
            meta[key] = val
    return meta


# Sliding-window attention: how many layers attend to the whole context.
# The GGUF header says a window exists but not which layers ignore it, so the
# pattern is curated per family. Gemma interleaves five local layers with one
# global one (llama.cpp's gemma3/gemma4 graphs); other SWA architectures fall
# back to "every layer is global", which is the conservative reading.
GLOBAL_LAYER_FRACTION = {"gemma3": 1 / 6, "gemma3n": 1 / 6, "gemma4": 1 / 6}

# Context the sliding-window layers' fixed cost is amortized over. Their cache
# never grows past the window, so it is a constant, not a per-1k rate; the
# registry carries a single rate, so it is folded in at the context the app
# opens on. Above it the estimate runs slightly high, which is the safe side.
KV_REFERENCE_CTX = 8192


def kv_gb_per_1k(meta: dict, arch: str) -> float | None:
    """KV cache (GB, f16) per 1024 tokens from GGUF metadata.

    Layers that attend to the whole context grow with it. Layers behind a
    sliding window stop growing once the window is full — costing them the
    full context is what made a 256K-context Gemma look unrunnable on any
    laptop — so they are charged their window and no more.
    """
    def g(suffix: str):
        return meta.get(f"{arch}.{suffix}")

    layers = g("block_count")
    heads = g("attention.head_count")
    kv_heads = g("attention.head_count_kv") or heads
    embed = g("embedding_length")
    head_dim = g("attention.key_length") or (embed // heads if embed and heads else None)
    if not (layers and kv_heads and head_dim):
        return None

    per_layer_token = 2 * kv_heads * head_dim * 2  # K+V, f16
    window = g("attention.sliding_window")
    if not window:
        return round(layers * per_layer_token * 1024 / 1e9, 3)

    global_layers = max(1, round(layers * GLOBAL_LAYER_FRACTION.get(arch, 1.0)))
    swa_layers = layers - global_layers
    swa_head_dim = g("attention.key_length_swa") or head_dim
    swa_per_layer_token = 2 * kv_heads * swa_head_dim * 2

    growth = global_layers * per_layer_token * 1024
    capped = swa_layers * swa_per_layer_token * min(window, KV_REFERENCE_CTX)
    return round((growth + capped * 1024 / KV_REFERENCE_CTX) / 1e9, 3)


def manifest_exists(url: str) -> bool:
    """HEAD a registry manifest: 200 means the tag is real and pullable."""
    req = urllib.request.Request(url, method="HEAD", headers=UA)
    try:
        with _urlopen(req, timeout=25) as r:
            return r.status == 200
    except Exception:  # noqa: BLE001
        return False


def ollama_tag_for(m: dict, quant: str, offline: bool) -> tuple[str | None, str | None]:
    """Install tag for one quant, as (tag, warning).

    Ollama's library only publishes some quants (usually q4_K_M and q8_0), so
    prefer the curated library tag and fall back to Hugging Face's
    Ollama-compatible endpoint — `ollama run hf.co/<repo>:<QUANT>` — which
    serves every quant in the repo. Both forms are verified before use, so a
    renamed upstream tag can never ship as a broken install button.
    """
    base = m.get("ollama_tag")
    hf_tag = f"hf.co/{m['hf_repo']}:{quant}" if m.get("hf_repo") else None
    if offline:
        # Nothing is reachable to verify against; the hf.co form is derived
        # purely from curated data, so it is the safer offline guess.
        return (hf_tag or base), None

    if base and ":" in base:
        name, ver = base.split(":", 1)
        lib = f"{ver}{m.get('ollama_quant_infix', '')}-q{quant[1:]}"
        if manifest_exists(f"https://registry.ollama.ai/v2/library/{name}/manifests/{lib}"):
            return f"{name}:{lib}", None

    if hf_tag:
        repo = m["hf_repo"]
        if manifest_exists(f"https://huggingface.co/v2/{repo}/manifests/{quant}"):
            return hf_tag, None

    return None, f"{m['id']}: no installable tag for {quant}"


# --- build -------------------------------------------------------------------


def load_sources() -> tuple[list[dict], list[str]]:
    """Curated entries first, then any discovered ones not already curated."""
    models = yaml.safe_load((HERE / "models.yaml").read_text())
    notes: list[str] = []
    discovered_path = HERE / "discovered.yaml"
    if not discovered_path.exists():
        return models, notes
    discovered = yaml.safe_load(discovered_path.read_text()) or []
    curated_ids = {m["id"] for m in models}
    for m in discovered:
        if m["id"] in curated_ids:
            # Promotion: the entry was copied into models.yaml and given a
            # quality score. The curated one wins and the stale copy is dropped
            # rather than shadowing it.
            notes.append(f"{m['id']}: discovered entry superseded by the curated one")
            continue
        # A discovered entry must never arrive carrying a quality score: that
        # is the one field the automated path is not allowed to fill.
        m["quality"] = None
        models.append(m)
    return models, notes


def build(offline: bool) -> tuple[dict, list[str]]:
    models, warnings = load_sources()
    out_models = []

    for m in models:
        repo = m.get("hf_repo")
        files: dict[str, int] = {}
        meta: dict = {}
        kv = None
        if repo and not offline:
            try:
                files = list_repo_files(repo)
            except Exception as e:  # noqa: BLE001
                warnings.append(f"{m['id']}: file listing failed ({e}); using fallbacks")
        quants = {}
        for qname, qcfg in m["quants"].items():
            size_gb = qcfg["fallback_size_gb"]
            size_source = "fallback"
            gguf = None
            hit = find_quant_file(files, qname) if files else None
            if hit:
                path, size = hit.path, hit.size
                size_gb = round(size / GIB, 2)
                size_source = "hf"
                # A direct-download record for runtimes that load a GGUF
                # themselves (DocGraph's bundled llama-server, ADR 0145)
                # rather than pulling an Ollama tag. Emitted only when every
                # shard carries a sha256: a download nobody can verify is not
                # a record worth publishing.
                if all(sha for _, _, sha in hit.files):
                    gguf = {
                        "repo": repo,
                        "files": [
                            {"path": p, "sizeBytes": sz, "sha256": sha}
                            for p, sz, sha in hit.files
                        ],
                    }
                else:
                    warnings.append(f"{m['id']}: quant {qname} has a shard without an LFS sha256; no gguf record")
                if kv is None and not offline:
                    try:
                        meta = gguf_metadata(
                            f"https://huggingface.co/{repo}/resolve/main/{path}"
                        )
                        arch = meta.get("general.architecture", "")
                        kv = kv_gb_per_1k(meta, arch)
                    except Exception as e:  # noqa: BLE001
                        warnings.append(f"{m['id']}: GGUF header read failed ({e})")
            elif files:
                warnings.append(f"{m['id']}: quant {qname} not found in {repo}; fallback size")
            tag, tag_warn = ollama_tag_for(m, qname, offline)
            if tag_warn:
                warnings.append(tag_warn)
            quants[qname] = {
                "fileSizeGb": size_gb,
                "kvCacheGbPer1kCtx": None,
                "ollamaTag": tag,
                # The app labels every estimate with how well it is known, so
                # each number carries where it came from. A curated fallback
                # is a guess and must not be presented as a read fact.
                "sizeSource": size_source,
            }
            if gguf:
                quants[qname]["gguf"] = gguf
        kv_source = "gguf"
        if kv is None:
            kv = m["fallback_kv_gb_per_1k"]
            kv_source = "fallback"
            if not offline and repo:
                warnings.append(f"{m['id']}: KV from fallback, not GGUF metadata")
        for q in quants.values():
            q["kvCacheGbPer1kCtx"] = kv
            q["kvSource"] = kv_source

        out_models.append(
            {
                "id": m["id"],
                "name": m["name"],
                "family": m["family"],
                "parametersB": m["parameters_b"],
                "activeParametersB": m.get("active_parameters_b"),
                "maxContext": m["max_context"],
                "capabilities": m["capabilities"],
                # Curated entries carry a hand-written score; discovered ones
                # carry none, which is what keeps them out of the picks.
                "quality": quality_of(m),
                "quantizations": quants,
                "ollamaTag": m.get("ollama_tag"),
            }
        )

    registry = {
        "schemaVersion": 1,
        "version": datetime.date.today().isoformat(),
        "models": out_models,
    }
    return registry, warnings


def quality_of(m: dict) -> dict | None:
    q = m.get("quality")
    if not q:
        return None
    # `source` names where the numbers came from. Only "hand" makes a model
    # eligible to be recommended, so it is written explicitly rather than left
    # to a default that a future edit could quietly change.
    return {"general": q["general"], "coding": q["coding"], "source": q.get("source", "hand")}


def validate(registry: dict) -> list[str]:
    errors = []
    seen = set()
    for m in registry["models"]:
        mid = m["id"]
        if mid in seen:
            errors.append(f"duplicate id {mid}")
        seen.add(mid)
        if m["parametersB"] <= 0:
            errors.append(f"{mid}: bad parametersB")
        active = m.get("activeParametersB")
        if active is not None and active >= m["parametersB"]:
            errors.append(f"{mid}: MoE active >= total")
        if not m["quantizations"]:
            errors.append(f"{mid}: no quantizations")
        q = m.get("quality")
        if q is not None:
            if not (0 < q["general"] <= 10) or not (0 < q["coding"] <= 10):
                errors.append(f"{mid}: quality out of range")
            # An automated source that claimed to be hand-curated would put an
            # unvetted model straight into BEST — the one failure this whole
            # two-tier split exists to prevent.
            if q.get("source") not in ("hand", "leaderboard-v2"):
                errors.append(f"{mid}: unknown quality source {q.get('source')!r}")
        for qname, q in m["quantizations"].items():
            if not (0.1 < q["fileSizeGb"] < 2000):
                errors.append(f"{mid} {qname}: implausible size {q['fileSizeGb']}")
            if not (0.005 < q["kvCacheGbPer1kCtx"] < 5):
                errors.append(f"{mid} {qname}: implausible KV {q['kvCacheGbPer1kCtx']}")
            # Size sanity vs parameter count: Q4 ≈ 0.55–0.75 B/weight, Q8 ≈ 1.0–1.2.
            bpw = q["fileSizeGb"] / m["parametersB"]
            if not (0.3 < bpw < 1.6):
                errors.append(f"{mid} {qname}: bytes/weight {bpw:.2f} out of range")
            g = q.get("gguf")
            if g is not None:
                # The record exists so a downloader can verify bytes it never
                # chose; a malformed hash or a size that disagrees with the
                # listing would fail every install of this rung.
                if q.get("sizeSource") != "hf":
                    errors.append(f"{mid} {qname}: gguf record on a fallback-sized rung")
                if not g.get("repo") or not g.get("files"):
                    errors.append(f"{mid} {qname}: gguf record is incomplete")
                total = 0
                for f in g.get("files", []):
                    if not re.fullmatch(r"[0-9a-f]{64}", f.get("sha256") or ""):
                        errors.append(f"{mid} {qname}: {f.get('path')} has no sha256")
                    if not f.get("path", "").lower().endswith(".gguf"):
                        errors.append(f"{mid} {qname}: {f.get('path')} is not a .gguf")
                    total += int(f.get("sizeBytes") or 0)
                if abs(total / GIB - q["fileSizeGb"]) > 0.01:
                    errors.append(f"{mid} {qname}: gguf bytes {total} disagree with fileSizeGb")
        # Quant files are matched by substring, so a repo that names things
        # unusually can silently bind the wrong file. More bits must always
        # mean a bigger file — if that ordering breaks, the match was wrong.
        ladder = [(q, m["quantizations"][q]["fileSizeGb"])
                  for q in QUANT_ORDER if q in m["quantizations"]]
        for (qa, sa), (qb, sb) in zip(ladder, ladder[1:]):
            if sb <= sa:
                errors.append(f"{mid}: {qb} ({sb} GB) is not larger than {qa} ({sa} GB)")
        unknown = set(m["quantizations"]) - set(QUANT_ORDER)
        if unknown:
            errors.append(f"{mid}: quant not in the known ladder: {sorted(unknown)}")
        # A model nothing can install is not a recommendation we can act on.
        if not any(q.get("ollamaTag") for q in m["quantizations"].values()):
            errors.append(f"{mid}: no quant has an installable tag")
    return errors


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true", help="skip HF, use fallbacks only")
    ap.add_argument("--out", default=str(HERE.parent / "registry" / "registry.json"))
    args = ap.parse_args()

    registry, warnings = build(args.offline)
    for w in warnings:
        print(f"warn: {w}", file=sys.stderr)

    errors = validate(registry)
    if errors:
        for e in errors:
            print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(registry, indent=2) + "\n")
    print(f"wrote {out} · {len(registry['models'])} models · version {registry['version']}")


if __name__ == "__main__":
    main()
