# ModelFit

**Find the best AI model for your machine.**

ModelFit is a small, fast desktop app that inspects your hardware and tells you
which local LLMs you can realistically run — at what quantization, context
length, and expected speed — with one-click install into Ollama.

**[modelfit.docgraph.app](https://modelfit.docgraph.app)** · A [DocGraph](https://docgraph.app) product.

## Why

"Can my machine run Qwen3 32B?" is answered today by Reddit threads and VRAM
calculators. Most tools stop at *does it fit*. ModelFit answers the three
questions that actually matter:

1. **Can the model run?** — weights + KV cache + overhead vs. your usable memory
2. **How fast will it run?** — estimated tokens/sec from memory bandwidth;
   "fits" and "usable" are different things
3. **What's the *best* model for this machine and task?** — quality × speed,
   per objective (overall / quality / speed / coding)

The answer is always three picks: **BEST**, **SAFE**, and **FAST** — with every
excluded model explaining *why* ("needs ~26 GB, your usable memory is 21 GB").

## Highlights

- **Zero prerequisites** — no runtime, no Python, no Node needed. Install the
  ~10 MB app and get recommendations immediately.
- **Real hardware detection** — Apple Silicon unified memory, GPU cores,
  VRAM, acceleration backends (Metal/CUDA/ROCm). Detected specs are editable.
- **Correct math where naive calculators fail** — MoE models budget memory by
  total parameters but speed by *active* parameters; KV cache is computed from
  your requested context length, not a flat guess.
- **Measured, not just estimated** — one click benchmarks a small model you
  already have (or a 2 GB fallback), derives your machine's real effective
  memory bandwidth, and re-extrapolates every speed estimate from it. Time to
  first token is reported only once that benchmark has run.
- **Every number says how well it's known** — measured here / calibrated /
  estimated / unverified, each hoverable for the inputs behind it
  ("7.1 GB weights + 2.8 GB KV cache at 8k context + 1.5 GB runtime overhead").
  A guess and a measurement never look alike.
- **One-click install** — pulls the recommended model into
  [Ollama](https://ollama.com) with live progress.
- **Data-driven model registry** — models live in a remotely-updated
  `registry.json`, not in code. New models arrive without an app update. It has
  two tiers: *curated* entries carry a hand-written quality score and are the
  only ones ever offered as a pick; *discovered* entries are found
  automatically and listed with real memory and speed, but never recommended —
  because "best for you" is a claim only a curated score can carry.

## Status

Early development. Working today on macOS (Apple Silicon):

- [x] Hardware detection
- [x] Recommendation engine (16 unit tests)
- [x] Dashboard: objective presets, context selector, all-models table,
      hardware edit
- [x] Ollama integration: status, one-click install, calibration benchmark
- [x] Remote registry + update pipeline
- [x] Confidence tiers and estimate basis on every number
- [x] Automated discovery of the listed-but-not-recommended tier
- [ ] Windows / Linux detection parity, installers

## Architecture

```
apps/desktop/          Tauri 2 + React + TypeScript + Tailwind
crates/
  hardware/            native detection (sysinfo + platform APIs)
  registry/            model-facts schema + bundled snapshot
  recommendation/      pure-math engine: constraints → weighted score
  runtime-adapters/    RuntimeAdapter trait + Ollama impl (llama.cpp: v2)
  share/               benchmark-share payload + Copy diagnostics report
registry/              bundled registry.json snapshot
registry-pipeline/     CI-only Python: models.yaml (curated) +
                       discover.py → discovered.yaml → registry.json
```

The engine is an embeddable Rust library — the desktop app, a future CLI, and
other DocGraph products are thin frontends over the same crates. A runtime
(Ollama) is only the *executor* of a recommendation, never a dependency of
producing one.

See [REQUIREMENTS.md](REQUIREMENTS.md) for the full product spec and design
decisions.

## Building from source

Prerequisites: Rust (stable), Node 20+, and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
# run tests
cargo test

# run the app in dev mode
cd apps/desktop
npm install
cargo tauri dev

# build a release bundle
cargo tauri build
```

## License

[MIT](LICENSE) © DocGraph
