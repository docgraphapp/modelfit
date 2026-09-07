#!/usr/bin/env python3
"""ModelFit registry discovery: find GGUF models worth listing, automatically.

Writes `discovered.yaml`, which build.py merges with the hand-curated
`models.yaml`. Everything here lands in the DISCOVERED tier: listed with its
memory and speed, never offered as a BEST / SAFE / FAST pick.

That split is the whole design. A pick asserts "this is the best model for
your machine", and that claim rests on a quality score. Scraping hundreds of
models with heuristic scores — the way llmfit does — would put a model nobody
assessed at the top of the page, which spends exactly the trust the
recommendation exists to earn. So discovery is automated and eligibility is
curated: promoting a discovered model is one entry added to models.yaml.

Only facts read out of the model itself are recorded here — parameter count,
context length, quantization file sizes, KV-cache cost from the GGUF header.
No quality is invented.

Usage:  python3 discover.py [--limit N] [--min-downloads N] [--out PATH]
"""

from __future__ import annotations

import argparse
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import yaml

from build import (
    GIB,
    QUANT_ORDER,
    UA,
    find_quant_file,
    gguf_metadata,
    http_json,
    kv_gb_per_1k,
    list_repo_files,
    ollama_tag_for,
)

HERE = Path(__file__).parent

# Publishers whose GGUF conversions are consistent enough to read
# automatically: stable file naming, real imatrix quants, and a track record of
# not shipping broken conversions. Discovery never leaves this list — the point
# is a catalogue we can explain, not the largest one.
TRUSTED_AUTHORS = [
    "bartowski",
    "unsloth",
    "lmstudio-community",
    "Qwen",
    "google",
    "mistralai",
    "microsoft",
    "ggml-org",
]

# The quants worth listing, smallest useful to largest sane. Mirrors build.py's
# ladder: a rung outside it fails validation there anyway.
WANTED_QUANTS = list(QUANT_ORDER)

# Guard rails on what is worth listing at all.
MIN_PARAMS_B = 0.4
MAX_PARAMS_B = 700.0
MIN_CONTEXT = 2048

# A size token anywhere in a model name: "-27b", "-0.8b", "-e4b", "-500m".
# Matched anywhere, not just at the end, because a name can carry its size in
# the middle ("Qwen3.8-27B-Uncensored") and appending a second one produces
# "qwen3.8-27b-uncensored-27b".
SIZE_TOKEN = re.compile(r"[-_]\d+(?:\.\d+)?[bm](?:[-_]|$)|[-_][a-z]\d+(?:\.\d+)?b(?:[-_]|$)")

# "E4B"-style names (Gemma's per-layer-embedding variants) advertise an
# effective parameter count below the weights they load — the same split
# between memory and speed that makes MoE unassessable here. Skipped for the
# same reason, and for the same fix: curate one with real numbers.
EFFECTIVE_PARAM_NAME = re.compile(r"-e\d+(?:\.\d+)?b\b", re.IGNORECASE)

# Repos that are not chat/instruct models, or are variants we cannot assess.
SKIP_NAME_MARKERS = (
    "-base-",
    "embedding",
    "embed-",
    "reranker",
    "whisper",
    "-vl-",  # vision towers ship extra projector files the size math misses
    "diffusion",
    "stable-",
    "flux",
    "clip",
    "draft",
    # Safety-stripped finetunes. Excluded from the automated feed as a
    # catalogue default, not a technical limit: they assess like any other
    # model, but shipping them in a product's default list is a decision to
    # make deliberately rather than inherit from a downloads ranking. Delete
    # these three lines to include them.
    "uncensored",
    "abliterated",
    "nsfw",
)


def http_json_maybe(url: str):
    try:
        return http_json(url)
    except Exception:  # noqa: BLE001
        return None


def search_author(author: str, limit: int) -> list[dict]:
    """GGUF repos by one publisher, most downloaded first."""
    q = urllib.parse.urlencode(
        {
            "author": author,
            "filter": "gguf",
            "sort": "downloads",
            "direction": "-1",
            "limit": str(limit),
        }
    )
    return http_json_maybe(f"https://huggingface.co/api/models?{q}") or []


def base_model_of(info: dict) -> str | None:
    """The upstream model a GGUF repo was converted from.

    Two publishers quantizing the same weights are the same model to a user, so
    this is the dedupe key. It is also the only honest way to say "we already
    have this" when the curated entry came from a different repo.
    """
    card = info.get("cardData") or {}
    base = card.get("base_model")
    if isinstance(base, list):
        base = base[0] if base else None
    if isinstance(base, str) and "/" in base:
        return base.lower()
    for tag in info.get("tags", []):
        if tag.startswith("base_model:") and not tag.startswith("base_model:quantized:"):
            return tag.split(":", 1)[1].lower()
    return None


def slug(base: str, params_b: float) -> str:
    """Registry id: the model's own name, with a size added only if it lacks one.

    A model's published name is what people search for, so "Qwen2.5-Coder-7B"
    stays `qwen2.5-coder-7b` even though its weights count 7.62B and would
    round to 8. Recomputing the size from the file would rename models out from
    under the people looking for them.
    """
    name = base.split("/")[-1].lower()
    for junk in ("-instruct", "-it", "-chat", "-gguf", "-hf"):
        name = name.replace(junk, "")
    name = name.strip("-")
    if SIZE_TOKEN.search(name):
        return name
    size = f"{params_b:.0f}b" if params_b >= 1 else f"{params_b:.1f}b"
    return f"{name}-{size}"


# Words a publisher appends that the curated names all leave off: "Llama 3.2
# 3B", not "Llama 3.2 3B Instruct". Every model here is an instruct/chat
# conversion, so the word distinguishes nothing and only costs column width.
NAME_NOISE = {"instruct", "it", "chat", "hf", "gguf"}


def display_name(base: str) -> str:
    """The name as a person writes it: "Qwen2.5 Coder 0.5B", not "qwen2.5-coder-0.5b-instruct"."""
    words = []
    for word in re.split(r"[-_\s]+", base.split("/")[-1]):
        if not word or word.lower() in NAME_NOISE:
            continue
        # A size token is spoken in caps ("0.5B", "70B"); everything else is
        # title-cased unless the publisher already capitalised it themselves,
        # which is usually deliberate ("R1", "VL").
        if re.fullmatch(r"\d+(?:\.\d+)?[bm]", word, re.IGNORECASE):
            words.append(word.upper())
        elif word.islower():
            words.append(word[0].upper() + word[1:])
        else:
            words.append(word)
    return " ".join(words)


def family_of(architecture: str, base: str) -> str:
    arch = (architecture or "").lower()
    for fam in ("qwen", "llama", "gemma", "mistral", "phi", "deepseek", "granite", "olmo"):
        if fam in arch or fam in base.lower():
            return fam
    return arch or "other"


def is_moe(meta: dict, architecture: str) -> bool:
    """MoE detection from the file's own header, with the arch name as backup.

    MoE models are skipped rather than guessed at: memory is driven by total
    parameters and speed by the *active* subset, and recovering the active
    count needs per-expert tensor math this pipeline does not do. A dense
    estimate for a MoE model reports a 30B as 30B-slow when it runs like a 3B —
    wrong in a way the user would notice and blame us for. They are listed here
    as skipped so a person can add them to models.yaml with real numbers.
    """
    experts = meta.get(f"{architecture}.expert_count")
    if isinstance(experts, int) and experts > 1:
        return True
    return "moe" in (architecture or "").lower()


def capabilities_for(info: dict) -> list[str]:
    """Only what the repo actually claims. No inference from the model name."""
    caps = ["chat"]
    tags = {t.lower() for t in info.get("tags", [])}
    card_tags = {str(t).lower() for t in ((info.get("cardData") or {}).get("tags") or [])}
    tags |= card_tags
    name = info["id"].lower()
    if "code" in name or "coder" in name or "code" in tags:
        caps.append("coding")
    if "reasoning" in tags or "-r1" in name or "think" in name:
        caps.append("reasoning")
    if info.get("pipeline_tag") == "image-text-to-text":
        caps.append("vision")
    return caps


def probe(repo: str, info: dict, offline: bool) -> tuple[dict | None, str | None]:
    """Everything discoverable about one repo, or (None, why-not)."""
    g = info.get("gguf") or {}
    total = g.get("total")
    if not total:
        return None, f"{repo}: no parameter count published"
    params_b = round(total / 1e9, 2)
    if not (MIN_PARAMS_B <= params_b <= MAX_PARAMS_B):
        return None, f"{repo}: {params_b}B outside the listed range"
    context = int(g.get("context_length") or 0)
    if context < MIN_CONTEXT:
        return None, f"{repo}: context {context} too small to assess"
    # A GGUF conversion that does not say what it was converted from is not
    # something we can name, dedupe, or vouch for — placeholder and redirect
    # repos look exactly like models until you ask this question.
    base = base_model_of(info)
    if not base:
        return None, f"{repo}: does not declare a base model"
    if EFFECTIVE_PARAM_NAME.search(base) or EFFECTIVE_PARAM_NAME.search(repo):
        return None, f"{repo}: effective-parameter variant — needs curated numbers"
    arch = g.get("architecture") or ""

    files = list_repo_files(repo)
    if not files:
        return None, f"{repo}: no GGUF files listed"

    quants: dict[str, dict] = {}
    kv = None
    for qname in WANTED_QUANTS:
        hit = find_quant_file(files, qname)
        if not hit:
            continue
        path, size = hit
        quants[qname] = {"fallback_size_gb": round(size / GIB, 2)}
        if kv is None:
            try:
                meta = gguf_metadata(f"https://huggingface.co/{repo}/resolve/main/{path}")
            except Exception as e:  # noqa: BLE001
                return None, f"{repo}: GGUF header unreadable ({e})"
            if is_moe(meta, meta.get("general.architecture", arch)):
                return None, f"{repo}: MoE — needs curated active-parameter count"
            kv = kv_gb_per_1k(meta, meta.get("general.architecture", arch))
    if not quants:
        return None, f"{repo}: none of {WANTED_QUANTS} published"
    if not kv:
        return None, f"{repo}: KV cache not derivable from the header"

    entry = {
        "id": slug(base, params_b),
        "name": display_name(base),
        "family": family_of(arch, base),
        "parameters_b": params_b,
        "max_context": context,
        "capabilities": capabilities_for(info),
        # Deliberately absent: nothing here rates a model. See the module docs.
        "quality": None,
        "ollama_tag": None,
        "hf_repo": repo,
        "quants": quants,
        "fallback_kv_gb_per_1k": kv,
    }
    # An entry nothing can install is not worth listing: build.py rejects it,
    # and a row with no Install button teaches the user nothing.
    if not any(ollama_tag_for(entry, q, offline)[0] for q in quants):
        return None, f"{repo}: no installable tag for any quant"
    return entry, None


def discover(limit: int, per_author: int, min_downloads: int, offline: bool):
    curated = yaml.safe_load((HERE / "models.yaml").read_text())
    taken_ids = {m["id"] for m in curated}
    taken_repos = {m.get("hf_repo", "").lower() for m in curated}
    # A curated entry and a discovered one for the same upstream weights are
    # the same model to a user; the curated one always wins.
    taken_bases = {m.get("hf_repo", "").split("/")[-1].lower() for m in curated}

    candidates: list[dict] = []
    for author in TRUSTED_AUTHORS:
        for row in search_author(author, per_author):
            if row.get("private") or row.get("gated"):
                continue
            if (row.get("downloads") or 0) < min_downloads:
                continue
            name = row["id"].lower()
            if any(marker in name for marker in SKIP_NAME_MARKERS):
                continue
            candidates.append(row)
    candidates.sort(key=lambda r: -(r.get("downloads") or 0))

    out: list[dict] = []
    skipped: list[str] = []
    seen_bases: set[str] = set()
    for row in candidates:
        if len(out) >= limit:
            break
        repo = row["id"]
        if repo.lower() in taken_repos:
            continue
        info = http_json_maybe(f"https://huggingface.co/api/models/{repo}")
        if not info:
            skipped.append(f"{repo}: model info unavailable")
            continue
        base = base_model_of(info)
        if base:
            stem = base.split("/")[-1].lower()
            if base in seen_bases or stem in taken_bases:
                continue
        entry, why = probe(repo, info, offline)
        if not entry:
            skipped.append(why or f"{repo}: skipped")
            continue
        if entry["id"] in taken_ids:
            skipped.append(f"{repo}: id {entry['id']} already curated")
            continue
        seen_bases.add(base or repo.lower())
        taken_ids.add(entry["id"])
        out.append(entry)
        print(f"  + {entry['id']:<34} {entry['parameters_b']:>6}B  {repo}", file=sys.stderr)
    return out, skipped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=90, help="max models to emit")
    ap.add_argument("--per-author", type=int, default=60, help="repos to consider per publisher")
    ap.add_argument("--min-downloads", type=int, default=5000)
    ap.add_argument("--offline", action="store_true", help="skip Ollama tag verification")
    ap.add_argument("--out", default=str(HERE / "discovered.yaml"))
    args = ap.parse_args()

    models, skipped = discover(args.limit, args.per_author, args.min_downloads, args.offline)
    for s in skipped:
        print(f"skip: {s}", file=sys.stderr)

    header = (
        "# GENERATED by discover.py — do not edit by hand.\n"
        "#\n"
        "# The DISCOVERED tier: listed in the app with memory and speed, never\n"
        "# offered as a BEST / SAFE / FAST pick, because nothing here has a\n"
        "# quality score a person stood behind. To promote one, copy it into\n"
        "# models.yaml and add a `quality:` block.\n"
    )
    Path(args.out).write_text(header + yaml.safe_dump(models, sort_keys=False, width=100))
    print(f"wrote {args.out} · {len(models)} discovered · {len(skipped)} skipped", file=sys.stderr)


if __name__ == "__main__":
    main()
