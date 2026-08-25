#!/usr/bin/env python3
"""ModelFit registry builder.

Reads the curated models.yaml, enriches it from Hugging Face (exact GGUF file
sizes + KV-cache cost computed from GGUF header metadata), validates, and
emits registry/registry.json — the file the app bundles and fetches remotely.

Runs in CI on a schedule; never on user machines. Every HF lookup has a
curated fallback so one moved repo can't break the build.

Usage:  python3 build.py [--offline] [--out PATH]
"""

from __future__ import annotations

import argparse
import datetime
import json
import struct
import sys
import urllib.request
from pathlib import Path

import yaml

HERE = Path(__file__).parent
UA = {"User-Agent": "modelfit-registry-pipeline/1.0"}

GIB = 1024**3


def http_json(url: str):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def http_range(url: str, n: int) -> bytes:
    req = urllib.request.Request(url, headers={**UA, "Range": f"bytes=0-{n - 1}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def list_repo_files(repo: str) -> dict[str, int]:
    """filename (basename, may be in subfolder) -> size in bytes."""
    files: dict[str, int] = {}
    tree = http_json(f"https://huggingface.co/api/models/{repo}/tree/main?recursive=true")
    for entry in tree:
        if entry.get("type") == "file" and entry["path"].lower().endswith(".gguf"):
            size = entry.get("size") or (entry.get("lfs") or {}).get("size")
            if size:
                files[entry["path"]] = int(size)
    return files


def find_quant_file(files: dict[str, int], quant: str) -> tuple[str, int] | None:
    """Match e.g. 'Q4_K_M' to '...Q4_K_M.gguf' (case-insensitive), ignoring
    multi-part shards (-00001-of-)."""
    needle = quant.lower()
    candidates = [
        (p, s)
        for p, s in files.items()
        if needle in p.lower() and "-of-" not in p.lower()
    ]
    if not candidates:
        # Sharded quant: sum the parts.
        parts = [(p, s) for p, s in files.items() if needle in p.lower() and "-of-" in p.lower()]
        if parts:
            return (parts[0][0], sum(s for _, s in parts))
        return None
    # Prefer the shortest path (top-level file over subfolder variants).
    return min(candidates, key=lambda t: len(t[0]))


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
    """Read scalar metadata KVs from the head of a GGUF file via range request."""
    buf = http_range(url, fetch_bytes)
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


def kv_gb_per_1k(meta: dict, arch: str) -> float | None:
    """KV cache (GB, f16) per 1024 tokens from GGUF metadata."""
    def g(suffix: str):
        return meta.get(f"{arch}.{suffix}")

    layers = g("block_count")
    heads = g("attention.head_count")
    kv_heads = g("attention.head_count_kv") or heads
    embed = g("embedding_length")
    head_dim = g("attention.key_length") or (embed // heads if embed and heads else None)
    if not (layers and kv_heads and head_dim):
        return None
    bytes_per_token = layers * 2 * kv_heads * head_dim * 2  # K+V, f16
    return round(bytes_per_token * 1024 / 1e9, 3)


# --- build -------------------------------------------------------------------


def build(offline: bool) -> tuple[dict, list[str]]:
    models = yaml.safe_load((HERE / "models.yaml").read_text())
    warnings: list[str] = []
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
            hit = find_quant_file(files, qname) if files else None
            if hit:
                path, size = hit
                size_gb = round(size / GIB, 2)
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
            quants[qname] = {"fileSizeGb": size_gb, "kvCacheGbPer1kCtx": None}
        if kv is None:
            kv = m["fallback_kv_gb_per_1k"]
            if not offline and repo:
                warnings.append(f"{m['id']}: KV from fallback, not GGUF metadata")
        for q in quants.values():
            q["kvCacheGbPer1kCtx"] = kv

        out_models.append(
            {
                "id": m["id"],
                "name": m["name"],
                "family": m["family"],
                "parametersB": m["parameters_b"],
                "activeParametersB": m.get("active_parameters_b"),
                "maxContext": m["max_context"],
                "capabilities": m["capabilities"],
                "quality": m["quality"],
                "quantizations": quants,
                "ollamaTag": m["ollama_tag"],
            }
        )

    registry = {
        "schemaVersion": 1,
        "version": datetime.date.today().isoformat(),
        "models": out_models,
    }
    return registry, warnings


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
        for qname, q in m["quantizations"].items():
            if not (0.1 < q["fileSizeGb"] < 2000):
                errors.append(f"{mid} {qname}: implausible size {q['fileSizeGb']}")
            if not (0.005 < q["kvCacheGbPer1kCtx"] < 5):
                errors.append(f"{mid} {qname}: implausible KV {q['kvCacheGbPer1kCtx']}")
            # Size sanity vs parameter count: Q4 ≈ 0.55–0.75 B/weight, Q8 ≈ 1.0–1.2.
            bpw = q["fileSizeGb"] / m["parametersB"]
            if not (0.3 < bpw < 1.6):
                errors.append(f"{mid} {qname}: bytes/weight {bpw:.2f} out of range")
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
