#!/usr/bin/env python3
"""Unit checks for the registry pipeline's file-matching and tier rules.

These run without network access. They exist because both bugs they cover were
found by the *registry* failing validation after a build — which is a slow,
expensive way to learn that a filename matched the wrong file.

Usage: python3 scripts/check-registry-pipeline.py
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "registry-pipeline"))

from build import find_quant_file, quality_of, validate  # noqa: E402

failures: list[str] = []


def check(name: str, got, want):
    if got != want:
        failures.append(f"{name}: got {got!r}, want {want!r}")


# --- quant file matching ----------------------------------------------------
# "Q6_K" is a prefix of "Q6_K_L", and big models ship both as multi-part
# shards. Matching by substring summed the parts of both, which is how a 70B
# model came to claim 165 GB at Q6_K — larger than its own Q8_0.
SHARDED = {
    "m-Q6_K/m-Q6_K-00001-of-00002.gguf": 30,
    "m-Q6_K/m-Q6_K-00002-of-00002.gguf": 27,
    "m-Q6_K_L/m-Q6_K_L-00001-of-00002.gguf": 40,
    "m-Q6_K_L/m-Q6_K_L-00002-of-00002.gguf": 38,
}
check("shards sum one variant only", find_quant_file(SHARDED, "Q6_K")[1], 57)
check("the longer variant is its own quant", find_quant_file(SHARDED, "Q6_K_L")[1], 78)

FLAT = {"m-Q6_K.gguf": 100, "m-Q6_K_L.gguf": 120, "m-Q4_K_M.gguf": 50}
check("a plain file is not confused with its _L sibling", find_quant_file(FLAT, "Q6_K")[1], 100)
check("exact quant wins", find_quant_file(FLAT, "Q4_K_M")[1], 50)
check("a quant that is not published is absent", find_quant_file(FLAT, "Q3_K_M"), None)

# A single file always beats a sharded copy of the same quant.
check("single file beats shards", find_quant_file({**FLAT, **SHARDED}, "Q6_K")[1], 100)

# Subfolder copies must not beat the top-level file.
check(
    "top-level file preferred",
    find_quant_file({"a/b/m-Q4_K_M.gguf": 9, "m-Q4_K_M.gguf": 50}, "Q4_K_M")[0],
    "m-Q4_K_M.gguf",
)

# --- gguf download records (ADR 0145 in DocGraph) ---------------------------
# A downloader needs every shard, in order, each with the sha256 the HF tree
# publishes; a bare byte count still matches but yields no hash.
from build import FileFact  # noqa: E402

HASHED = {
    "m-Q6_K-00002-of-00002.gguf": FileFact(27, "b" * 64),
    "m-Q6_K-00001-of-00002.gguf": FileFact(30, "a" * 64),
}
hit = find_quant_file(HASHED, "Q6_K")
check("shards are listed in part order", [p for p, _, _ in hit.files],
      ["m-Q6_K-00001-of-00002.gguf", "m-Q6_K-00002-of-00002.gguf"])
check("each shard keeps its hash", [h for _, _, h in hit.files], ["a" * 64, "b" * 64])
check("first shard is the load path", hit[0], "m-Q6_K-00001-of-00002.gguf")
check("a bare size carries no hash", find_quant_file(FLAT, "Q6_K").files, [("m-Q6_K.gguf", 100, None)])

# --- the two tiers ----------------------------------------------------------
# The one rule the whole discovered tier rests on: an automated entry carries
# no quality, so the app can never offer it as a pick.
check("a discovered entry has no quality", quality_of({"quality": None}), None)
check("a missing quality key is not a score", quality_of({}), None)
check(
    "a curated entry is marked as hand-written",
    quality_of({"quality": {"general": 7.0, "coding": 6.0}}),
    {"general": 7.0, "coding": 6.0, "source": "hand"},
)

# An automated source claiming to be hand-curated is the failure the tiers
# exist to prevent, so validation must reject a source it does not know.
def one_model(**over):
    m = {
        "id": "x",
        "parametersB": 8.0,
        "quantizations": {"Q4_K_M": {"fileSizeGb": 4.8, "kvCacheGbPer1kCtx": 0.1, "ollamaTag": "x:8b"}},
    }
    m.update(over)
    return {"models": [m]}


check("a known source validates", validate(one_model(quality={"general": 7, "coding": 6, "source": "hand"})), [])
check("no quality at all validates", validate(one_model(quality=None)), [])
bogus = validate(one_model(quality={"general": 7, "coding": 6, "source": "vibes"}))
check("an unknown quality source is rejected", len(bogus), 1)
out_of_range = validate(one_model(quality={"general": 99, "coding": 6, "source": "hand"}))
check("an impossible score is rejected", len(out_of_range), 1)

if failures:
    for f in failures:
        print(f"FAIL {f}", file=sys.stderr)
    sys.exit(1)
print("registry pipeline checks passed")
