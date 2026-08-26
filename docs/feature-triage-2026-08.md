# Feature Triage — August 2026

Assessment of a batch of suggested features, recorded 2026-08-26. Context at
time of writing: macOS (Apple Silicon) only; Windows/Linux parity not yet
shipped. See [REQUIREMENTS.md](../REQUIREMENTS.md) for the product spec.

> **Correction (same day).** An earlier draft made the registry pipeline a
> prerequisite for the "do next" work, based on the unchecked box in the
> README. That box is stale: the pipeline is built and live. See
> [Registry pipeline: actual state](#registry-pipeline-actual-state) below.
> The four "do next" features are not blocked.

## Verdict summary

| Feature | Verdict |
|---|---|
| Context-length slider with live drop-off | **Do** — best effort-to-value on the list |
| Quantization trade-off visualizer | **Do** |
| Cloud hardware profiles ("Dream Machine") | **Do** |
| Shareable setup links | **Do** — strongest distribution play |
| Crowdsourced benchmarks | Do post-launch, GitHub-native — see revised plan below |
| Multi-GPU / eGPU support | Defer — after Win/Linux single-GPU parity |
| Additional backends (MLX, LM Studio, …) | Defer — one second adapter first |
| Battery / thermal estimates | Qualitative warning only, or skip |
| Model management / uninstall | Minimal version only — scope-creep risk |
| "Chat Now" app handoff | Fine as a small convenience button |
| Use-case presets (RAG / creative / agentic) | Only as fast as registry data can back them |

## Do next — compounds what already exists

These are mostly frontend over the existing engine and registry, and each one
amplifies the product's differentiator: explaining *why*, not just *whether*.

### Context-length slider with live drop-off
The dashboard already has a context selector and the engine computes KV cache
per requested context. Upgrading to a real-time slider where models visibly
fall off the "fits" list from 8k → 32k → 128k teaches the KV-cache insight
better than any explanation. Mostly a UI change.

### Quantization trade-off visualizer
Quality/speed/memory per quantization is already in the registry, and the
engine already reasons over it. Plotting the curve for a selected model
(Q4_0 → Q4_K_M → Q8 → FP16) shows the user why the recommendation picked what
it did. Trust in the recommendation is the product's currency; this builds it
cheaply.

### Cloud hardware profiles ("Dream Machine")
Detected specs are already editable, so this is a curated preset list
("Mac Studio M2 Ultra", "RTX 4090", …) over an existing feature. Low cost,
viral use case ("what could I run if I upgraded?"), and pairs naturally with
share links.

### Shareable setup links
"What can I run?" on Reddit/Discord is literally the README's opening problem.
A `modelfit.docgraph.app/build/<profile>` link that renders the recommendation
set makes ModelFit *the link people paste* as the answer — the best
distribution channel available to this product. Needs the website repo
(modelfit-web), but the payload is just a hardware profile; the engine does
the rest.

**Suggested milestone:** ship the four items above as one cohesive
"understand and share your build" release. They are not blocked on
infrastructure — the registry pipeline already delivers the data they need.
The one real dependency is *curation*: quant curves and honest use-case
presets need richer per-model facts in `registry-pipeline/models.yaml`, which
is hand-authored.

## Right idea, wrong time

### Crowdsourced benchmarks — revised 2026-08-26: GitHub-native, post-launch
The original deferral reasons (backend, anonymization, abuse filtering) are
sidestepped by making GitHub the backend: sharing is explicitly opt-in and
public by design, and there is zero infrastructure to run.

Plan: a "Share my benchmark" button in the app opens a prefilled GitHub
**Issue form** URL (`issues/new?template=benchmark.yml&...`) — not a
.md-file-via-PR flow, which loses most users at fork/branch/PR. Structured
fields: chip, RAM, OS, measured bandwidth, model, quant, tok/s, app version.
No OAuth and no token in the app; it only opens a URL. A label plus issue
search gives a browsable leaderboard for free, and the structured body keeps
the data machine-readable so estimates *could* use it later.

Constraints: app estimates do NOT depend on this data for now (self-reported,
unverified — treat as anecdata until validated). Show the user exactly what
will be shared before opening the URL; it is public forever. Needs published
users to be worth anything → post-launch, same bucket as share links.

### Multi-GPU / eGPU support
Correct long-term, but Windows/Linux single-GPU parity hasn't shipped.
Sequencing: parity first. Modeling tensor-split bandwidth penalties correctly
is real research work — a wrong estimate is worse than "not supported yet."

### Additional backends
The `RuntimeAdapter` trait means the architecture is ready. But every backend
is a permanent maintenance surface (install paths, model formats, progress
APIs). Do exactly one second adapter to prove the trait — MLX is the most
on-brand for the Apple Silicon focus, LM Studio the most requested — not a
broad sweep.

## Cautious / constrained

### Battery & thermal estimates
Honest numbers are very hard: throttling depends on chassis, ambient
temperature, and sustained-load behavior. A "drains X%/hour" figure would be
false precision and would erode the trust the calibrated estimates earn. A
coarse qualitative warning is defensible ("fanless machine: sustained
generation on this model will likely throttle"); anything more, skip.

### Model management / uninstall
Real user need (20 GB models pile up), but a full "Manage Models" tab is scope
creep toward "complete local LLM manager" — Ollama's and LM Studio's job, and
it dilutes the "small, fast, does one thing" identity. Acceptable minimal
version: show disk usage of installed models and delegate deletion to
`ollama rm`.

### "Chat Now" handoff
Fine as a small convenience button (deep-link to the user's chat UI, or copy
`ollama run <model>`). Don't over-invest in per-app integrations.

### Use-case presets (RAG / creative writing / agentic-JSON)
The mechanism is trivial — new weight profiles next to overall/quality/speed/
coding. The hard part is honest data: "good at needle-in-a-haystack" or
"follows JSON schemas strictly" must be backed by benchmark scores in the
registry, or the presets are vibes with a dropdown. Add presets only as fast
as per-model scores exist to back them.

## Registry pipeline: actual state

Verified 2026-08-26 by reading the code and hitting the live URL. The README's
unchecked "Remote registry + update pipeline" box is **stale** — this is built
and serving.

**What exists:**

- `registry-pipeline/build.py` — reads the hand-curated `models.yaml`
  (15 models), enriches each entry from Hugging Face with exact GGUF quant file
  sizes and KV-cache-per-1k-context computed from GGUF header metadata. Every
  lookup has a curated fallback, so a moved repo cannot break the build.
  Validates before writing: duplicate ids, MoE active >= total, plausibility
  bounds on size and KV, and a bytes-per-weight sanity check against the
  parameter count.
- `.github/workflows/registry.yml` — weekly cron (Mon 06:17 UTC) plus
  `workflow_dispatch`. Rebuilds, commits the snapshot if changed, then deploys
  the website and registry together to Cloudflare Pages (a Pages deploy
  replaces the whole site, so they must ship as one directory).
- `apps/desktop/src-tauri/src/lib.rs` — client fetch across three independent
  failure domains (docgraph.app -> pages.dev -> raw.githubusercontent.com),
  parse-and-validate before caching, ISO-date version comparison against the
  bundled snapshot, and a compiled-in fallback so the app always has a working
  registry. Startup does a silent refresh; failures keep the cached copy.

**Live:** `https://modelfit.docgraph.app/registry/v1/registry.json` returns
HTTP 200, version `2026-08-25`.

**What is actually left:**

1. **The cron has never run unattended.** There are no `modelfit-registry-bot`
   commits in history, and the workflow-parse fix (`57a419c`) landed
   2026-08-26. Trigger a manual `workflow_dispatch` to confirm the scheduled
   path works end to end rather than waiting for Monday.
2. **Tick the README checkbox.**
3. **Schema forward-compat.** The client hard-rejects `schemaVersion != 1`, so
   the day a v2 registry ships, every older app silently falls back to its
   bundled snapshot permanently. Decide the migration story before it is
   needed — e.g. serve `/registry/v1/` and `/registry/v2/` in parallel and
   retire v1 on a published schedule.
4. **Curation is the real bottleneck.** Quality scores, capabilities, and
   Ollama tags are hand-authored in `models.yaml` by design. This is exactly
   the constraint flagged for use-case presets above: RAG and agentic-JSON
   presets need new per-model benchmark data in that file, not new plumbing.
