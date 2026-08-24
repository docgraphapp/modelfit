# ModelFit — Requirements & Tech Stack

**Positioning:** *ModelFit — Find the best AI model for your machine.*

A cross-platform desktop app that inspects your machine and tells you the best local LLMs you can realistically run — and at what quantization, context length, and expected speed — with one-click install.

Product copy speaks the user's language, not the engine's: "Your machine can comfortably run: Qwen3 30B-A3B Q4_K_M — 94/100, Recommended". *Comfortably / tight / too slow for chat* are the headroom and constraint concepts made human — keep this register across all UI text.

Status: draft v0.1 · 2026-08-25

---

## 1. Product vision

Not a "hardware checker" — a **Local AI Advisor**. It combines:

```
YOUR HARDWARE + AVAILABLE MODELS + QUANTIZATION + MEASURED BENCHMARKS
                              ↓
                     "What should I run?"
```

The tool answers three distinct questions (most existing tools stop at the first):

1. **Can the model run?** — weights + KV cache + inference overhead + runtime overhead < available memory
2. **How fast will it run?** — estimated tokens/sec; "fits" and "usable" are different things
3. **What is the *best* model for this machine and task?** — quality × speed trade-off per use case

Output is always three picks, not one: **BEST** (top score), **SAFE** (comfortable headroom), **FAST** (snappiest usable).

### Expansion path (post-v1)

The name and architecture are deliberately model-type-agnostic. The engine is generic "memory + throughput vs hardware" math, and the registry already carries `capabilities` — so expansion is new registry entries plus scoring presets, not a new engine:

```
ModelFit
├── LLMs                (v1)
├── Embedding models    (near-free: same runtimes, same math)
├── Vision/multimodal   (same runtimes)
├── Speech (Whisper)    (new runtime adapter)
└── Image generation    (new runtimes + it/s benchmark axis)
```

### Non-goals (v1)

- **LLM-only scope** — the expansion above is roadmap, not v1; image-gen/speech add new runtimes and benchmark axes
- Not an inference engine or chat app — it recommends and installs into existing runtimes
- No bundled llama.cpp in v1 (see §6)
- No Python shipped in the installer, ever (see §7)

---

## 2. Functional requirements

### FR-1 Hardware detection (native, automatic)

- CPU model, cores/threads
- Total and available system RAM
- GPU(s): vendor, model, dedicated VRAM
- Apple Silicon unified memory (single pool — changes the whole fit calculation)
- Available disk space (models are 5–40 GB)
- OS + architecture (macOS/Windows/Linux, x86_64/arm64)
- Acceleration availability: Metal / CUDA (+ version) / ROCm / Vulkan
- **Confirm/edit screen**: detected specs are shown and editable. This is both the trust-builder and the fallback for fuzzy cases (AMD/Intel VRAM via DXGI/sysfs, iGPU shared memory — report a ceiling, let the user adjust).

### FR-2 Runtime detection

- Ollama installed/running? (probe `localhost:11434`) — version, installed models
- LM Studio present? llama.cpp on PATH? (informational in v1)
- No runtime found → dashboard reports it and offers guided Ollama setup. **The app never requires a runtime to deliver recommendations** (see §5).

### FR-3 Model registry (data, not code)

- Remote `registry.json` fetched on startup from our static host; bundled snapshot as offline/first-run fallback; cached locally.
- **Manual "Update registry"**: button in Settings (+ refresh affordance on the Models view) fetches the latest registry on demand. Shows current registry version/date ("Registry: 2026-08-25 · 214 models"), reports what changed ("+3 new models"), and recomputes recommendations immediately. On failure, keeps the cached registry and says so.
- Models are never hard-coded. Adding a model = editing data, no app release.
- Covers chat, coding, reasoning, embedding, and vision models across families (Qwen, Llama, Gemma, Mistral, DeepSeek, …).

**Schema — per model (fields that make estimates *correct*, learned the hard way):**

```jsonc
{
  "id": "qwen3-30b-a3b",
  "name": "Qwen3 30B-A3B",
  "family": "qwen",
  "parameters_b": 30,          // total params → drives MEMORY
  "active_parameters_b": 3,    // MoE active params → drives SPEED (== parameters_b for dense)
  "max_context": 32768,
  "capabilities": ["chat", "reasoning", "coding"],
  "quality_scores": { "general": 8.9, "coding": 8.4 },   // from public benchmarks
  "quantizations": {
    "Q4_K_M": {
      "file_size_gb": 18.6,
      "bytes_per_weight": 0.56,
      "kv_cache_gb_per_1k_ctx": 0.12   // KV cache computed per requested context, never a flat number
    }
  },
  "runtimes": { "ollama_tag": "qwen3:30b-a3b" }
}
```

Key rules:
- **MoE**: memory math uses `parameters_b`; speed math uses `active_parameters_b`. (A 30B-A3B is ~8B-fast but 30B-heavy — naive calculators get this backwards.)
- **Context length is an input, not a property.** The same model flips between "fits" and "doesn't" based on requested context; KV cache is computed from it.

### FR-4 Recommendation engine

Pipeline: `hardware → hard constraints → candidates → memory estimate → speed estimate → weighted score → BEST / SAFE / FAST`

- **Constraints first, then score** (not a pure product-of-factors, which lets one factor tank everything opaquely):
  - must fit with ≥ 10% memory headroom at the requested context
  - must clear a task-dependent tok/s floor (chat needs speed; a summarizer tolerates less)
- **Weighted score on survivors**: quality vs speed weights set by task preset.
- **User-selectable objective**: Best quality / Best speed / Best coding / Best overall (+ context length selector).
- **Explainable**: excluded models say why ("needs 26 GB, you have 21 available", "est. 4 tok/s — below chat floor"). No opaque single numbers.

### FR-5 Benchmark engine (calibrate → extrapolate → verify)

First-run must reach a recommendation in **< 2 minutes** — therefore never download candidate models to rank them:

1. Download **one small calibration model** (~2 GB) via Ollama
2. Measure real prompt-eval and generation tok/s + memory
3. Derive the machine's **effective memory bandwidth**
4. **Extrapolate** speed for every registry model (`≈ bandwidth / bytes-touched-per-token`, using active params)
5. Full benchmark of a chosen model = **opt-in "Verify"** after install; measured results replace estimates and are labeled as measured

### FR-6 One-click install

- "Install" pulls the recommended tag via the Ollama API, with progress, disk-space check, cancel.
- Post-install: offer Verify benchmark.

### Design principle: light, smooth, no complexity

The app turns an overwhelming question into one clear answer — the UI must feel the same way:

- **One answer first**: dashboard = machine summary + "You can comfortably run: X" + Install. Everything else is progressive disclosure.
- **No configuration wall**: first run asks nothing; detection + defaults yield a recommendation instantly. Presets/context are refinements, never prerequisites.
- **Instant response**: estimates are local math — sliders and preset changes update results immediately, no spinners. Progress bars only for downloads/benchmarks.
- **Calm visuals**: whitespace, few colors, plain-language verdicts ("comfortable" / "tight") up front; dense numbers on expand/hover only.

### FR-7 Dashboard UI

Sidebar: Dashboard · Hardware · Models · Benchmarks · Downloads · Settings.

- **Dashboard**: machine summary, runtime status, BEST/SAFE/FAST cards with score, est. memory, est. tok/s, `[Install]` `[Verify]`
- **Hardware**: full detected specs + edit
- **Models**: filterable registry table (task, size, family), fit verdict per row at current context setting
- **Benchmarks**: calibration result, measured-vs-estimated history
- Confidence labels (HIGH / MEDIUM / measured) on every estimate

---

## 3. Non-functional requirements

| Requirement | Target |
|---|---|
| Zero prerequisites | App is fully functional (detect + recommend) with **no runtime, no Python, no Node** installed |
| Installer size | ~10–20 MB (native, no Chromium/Python bundled) |
| First-run to recommendation | < 2 min (estimates instantly; calibration optional) |
| Offline | Works with bundled registry snapshot; degrades gracefully |
| Platforms | macOS (arm64 + x86_64), Windows (x86_64), Linux (AppImage/deb/rpm) |
| Registry freshness | Updated without app releases (remote JSON); models ship weekly — a stale catalog kills the product |
| Privacy | Hardware info never leaves the machine; registry fetch is anonymous GET |
| Auto-update | Tauri updater, signed releases |

---

## 4. Tech stack

| Layer | Technology | Why |
|---|---|---|
| Desktop shell | **Tauri 2** | ~10 MB signed installers, native API access, existing team pipeline (build/sign/update) |
| Backend | **Rust** (workspace of crates) | Hardware detection is native-API work; testable pure-math core |
| Frontend | **React + TypeScript + Vite** | Team standard |
| UI kit | **Tailwind + shadcn/ui**, Recharts | Dashboard-style UI fast |
| State | **Zustand** (+ React Query for async) | |
| Hardware crates | `sysinfo`, `nvml-wrapper` (NVIDIA), `wgpu`/DXGI (vendor-agnostic), sysctl/`system_profiler` (Apple) | |
| HTTP | `reqwest` + `tokio` | Ollama API, registry fetch, GGUF header range-requests |
| Local storage | JSON cache → `rusqlite` when needed | |
| Inference runtime | **Ollama adapter (v1)** behind a runtime trait; llama.cpp-direct = v2 adapter | Ollama *is* llama.cpp with the GPU build matrix already solved; don't own CUDA/ROCm/Vulkan builds in v1 |
| Model registry hosting | Static JSON on **Cloudflare Pages/R2** | Existing infra |
| Registry pipeline | **Python** (server-side/CI only): `huggingface_hub` metadata, GGUF sizes, benchmark-score ingestion → emits `registry.json` | Python where its ecosystem wins; never shipped to users |
| CI/CD | GitHub Actions | Build matrix + registry pipeline |

### Rejected alternatives (decided, don't reopen without new evidence)

- **Electron** — 150 MB+ shell for a utility app
- **Python desktop app / sidecar** — distribution pain (PyInstaller size, AV false positives, notarization); the app's runtime work (native APIs + arithmetic + HTTP) doesn't need Python's ecosystem
- **Bundling llama.cpp in v1** — GPU backend build-matrix ownership; deferred to v2 behind the existing runtime trait
- **Web app as primary** — browsers can't read hardware; dropdown-entered specs are wrong too often

---

## 5. Architecture

```
┌──────────────────────────────────────────────────┐
│  React + TS UI                                   │
│  Dashboard │ Hardware │ Models │ Benchmarks │ ⚙  │
└───────────────────┬──────────────────────────────┘
                    │ Tauri commands
┌───────────────────▼──────────────────────────────┐
│  Rust core (workspace)                           │
│  hardware · registry · recommendation ·          │
│  benchmark · downloader · runtime-adapters       │
└──────┬──────────────────────┬────────────────────┘
       │ trait RuntimeAdapter │ HTTPS
       ▼                      ▼
  Ollama (v1)          registry.json (Cloudflare)
  llama.cpp (v2)              ▲
                              │ built by CI
                       Python pipeline
                    (HF metadata, benchmarks)
```

**Core principle:** the recommendation engine is an embeddable library. Desktop UI, a future CLI, and integration into other apps (e.g. DocGraph's local-AI features) are thin frontends over the same crates. A runtime (Ollama) is only the *executor* of a recommendation, never a dependency of producing one.

### Repository layout

```
modelfit/
├── apps/desktop/          # Tauri 2 + React
├── crates/
│   ├── hardware/          # detection (per-platform modules)
│   ├── registry/          # schema, fetch, cache, GGUF metadata
│   ├── recommendation/    # constraints + scoring (pure, unit-tested)
│   ├── benchmark/         # calibration, extrapolation, verify
│   ├── runtime-adapters/  # trait + ollama impl (llama.cpp later)
│   └── downloader/
├── registry-pipeline/     # Python (CI-only) → registry.json
└── registry/              # bundled snapshot + JSON schema
```

---

## 6. Runtime strategy

- v1 ships **only the Ollama adapter**. Detection is a localhost probe; absence turns Benchmark/Install buttons into a guided "Get Ollama" flow — recommendations still fully work.
- The `RuntimeAdapter` trait (list models, pull, generate-with-timing) is designed so llama.cpp-direct ("advanced mode", raw GGUF) slots in as a v2 adapter with no architectural change. LM Studio likewise if demand appears.

## 7. Python boundary (settled)

Python exists **only** in `registry-pipeline/`, run by CI/server: ingest Hugging Face metadata + public benchmark scores → validate → publish `registry.json`. Nothing Python is bundled, installed, or executed on user machines. If a future feature truly needs on-device ML libs, the sidecar seam is a known, deliberate addition — not a v1 cost.

---

## 8. Milestones

| # | Milestone | Proves |
|---|---|---|
| M1 | `hardware` crate + Tauri shell showing real detected specs (Apple Silicon first) | Detection works natively; app runs standalone |
| M2 | Registry schema + bundled snapshot + `recommendation` crate with unit tests (incl. MoE + context-scaling cases) | Estimates correct on known configs |
| M3 | Dashboard UI: BEST/SAFE/FAST + objective presets + explainable exclusions | End-to-end recommendation, no runtime needed |
| M4 | Ollama adapter: detect, one-click install, calibration benchmark → extrapolation | The moat feature |
| M5 | Python registry pipeline in CI + Cloudflare hosting + registry auto-refresh | Staleness solved |
| M6 | Windows/Linux detection parity, installers, signing, updater | Shippable v1 |

Open questions: quality-score source & licensing (LMArena / Open LLM Leaderboard dumps); calibration model choice (small, permissive license, available as Ollama tag); scoring-weight defaults per task preset (tune in M3 with real users).
