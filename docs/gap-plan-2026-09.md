# Gap Plan — September 2026

Closing the gaps against [llmfit](https://github.com/AlexsJones/llmfit)
(Rust TUI/CLI, ~35k stars, hundreds of models, community benchmarks),
recorded 2026-09-07 and adopted the same day (see REQUIREMENTS.md FR-3/FR-4/FR-5,
rejected alternatives, M7). Honors the decisions in
[REQUIREMENTS.md](../REQUIREMENTS.md) and
[feature-triage-2026-08.md](feature-triage-2026-08.md) — nothing here reopens
them.

What we keep that llmfit lacks: a GUI, a *decision* (BEST/SAFE/FAST + why
excluded) instead of a table, a remote registry that updates without a
release, and an embeddable engine. The plan is to close the gaps *through*
those strengths, not by copying a TUI.

## Sequence

| Phase | When | Items | Why this order |
|---|---|---|---|
| **A** | ✅ landed 2026-09-07 | 2 Confidence tiers · 6a Copy diagnostics · 6b estimate basis · 6f local measurement memory | Engine-only; no new data needed; every later phase reports through them |
| **B** | ✅ landed 2026-09-07 | 1 Catalog expansion · 6c TTFT from calibration | Data work; the registry pipeline already existed, it needed a discovery front-end |
| **C** | with M6 (Win/Linux parity) | 4 Run modes + utilization · 6d discrete-GPU bandwidth table | Only meaningful with discrete GPUs, which we don't detect properly yet |
| **Deferred** | not scheduled (2026-09-07) | 3 Community benchmark return path · 5 CLI/MCP | Designs kept below for when they are picked up |

## What landed (A + B)

- `Confidence { MeasuredLocal, Community, Calibrated, Estimated, Unknown }` and
  `Estimate { value, confidence, basis }` in the engine; every memory and speed
  figure — per model *and* per quantization rung — carries both.
- The UI spends a glyph only on a number that is better than an estimate (✓ ≈)
  or worse than one (?); `estimated` is the baseline the leading "~" already
  announces. Every figure is hoverable for its basis regardless.
- Measurements persist per runtime tag (`modelfit:measurements`) and survive
  restarts. A bare model tag — which is what the benchmark actually runs —
  resolves to the baseline rung, and to no other.
- `Copy diagnostics` in the footer, built in Rust from the engine's own state.
- Two-tier registry: `discover.py` writes the discovered tier from trusted
  publishers, reading only facts out of the model file. `Model::is_recommendable`
  gates BEST / SAFE / FAST on a hand-curated score, with tests that a registry
  containing nothing curated yields no picks at all.
- Time to first token, reported only when prefill was measured
  (`Calibration::prefill_capacity` = prompt tok/s × active params).

**Known gap from B:** discovery skips MoE and effective-parameter (Gemma "E4B")
models — memory follows total parameters and speed follows the active subset,
and recovering the active count needs per-expert tensor math the pipeline does
not do. They are reported as skipped so a person can curate them with real
numbers. A large share of current releases are MoE, so the discovered tier
skews dense until that is closed.

---

## 1. Catalog size — 19 → 100+ (Phase B)

> **⚠ Don't scrape blindly like llmfit — an unrated model in BEST would cost
> the trust that *is* the product.** llmfit embeds hundreds of HF entries with
> heuristic quality scores; our differentiator is that a pick is trustworthy.
> Discovery is automated, *eligibility* is curated. Two tiers in one registry:

- **Curated** (today's `models.yaml`): hand-authored quality, capabilities,
  Ollama tags. Eligible for BEST/SAFE/FAST.
- **Discovered** (new): auto-generated, shown in the all-models table with a
  `quality: null` → rendered "unrated", never picked. Promoted to curated by
  editing one YAML line.

**Pipeline additions** (`registry-pipeline/`):

1. `discover.py` — query HF API for GGUF repos from trusted publishers
   (`bartowski`, `unsloth`, `Qwen`, `google`, `mistralai`, `lmstudio-community`)
   sorted by downloads; emit `discovered.yaml` candidates. Params, MoE
   (`expert_count` / `expert_used_count`), context and KV-per-1k all come
   from the GGUF header reader that `build.py` already has — no new parsing.
2. **Ollama tag resolution** — `registry.ollama.ai/v2/library/<name>/tags/list`
   to map a model to install tags per quant; candidates without a resolvable
   tag stay installable-by-nothing → still listed (with the HF link) but
   flagged `noInstall`.
3. **Quality source** — pick one automated, licensed source for a *provisional*
   score (Open LLM Leaderboard v2 or Artificial Analysis index), stored as
   `quality: { general, coding, source: "hand" | "leaderboard-v2" }`.
   Provisional scores are visible but the engine treats `source != "hand"`
   like unrated for BEST. (Resolves the open question in REQUIREMENTS §8.)
4. **Schema stays v1.** All new fields are optional; the client hard-rejects
   `schemaVersion != 1` (triage item 3), so additive-only until a migration
   story exists.

Acceptance: registry ≥ 100 models, build stays green offline (fallbacks),
table renders unrated rows distinctly, BEST/SAFE/FAST never selects one.

## 2. Confidence tiers on every number (Phase A)

Today `Assessment.confidence` is `"high" | "medium"` for the whole row.
Replace with per-number provenance, llmfit-style:

```rust
pub enum Confidence { MeasuredLocal, Community, Calibrated, Estimated, Unknown }
pub struct Estimate<T> { value: T, confidence: Confidence, basis: String }
```

- **Speed**: `MeasuredLocal` when the user has run this exact tag through
  `measure()` (persist per-tag measurements locally); `Calibrated` when
  `measured_effective_bandwidth_gbps` is set; `Estimated` from the chip table;
  `Unknown` when the bandwidth fell through to the 100/300/50 defaults
  (`known_chip == false`). MoE downgrades one step.
- **Memory**: `Estimated` when quant size came from the HF listing,
  `Unknown` when from `fallback_size_gb`. Needs `sizeSource` written by
  `build.py` (optional field, schema stays v1).
- **UI**: one glyph per cell (✓ measured · ≈ calibrated · ~ estimated · ?
  unknown), tooltip shows `basis`. Reuse the glossary hover cards.

Cheap (engine + one UI pass), and the prerequisite for 3 and 6b.

## 3. Community benchmark return path — **DEFERRED 2026-09-07**

Not scheduled. Design kept so it can be picked up unchanged.

The `share` crate and the `benchmark.yml` issue form exist; the button is
behind a flag. The missing half is the *return path* — that's what makes
llmfit's estimates improve over time.

1. `registry-pipeline/ingest_benchmarks.py` — in `registry.yml` CI: fetch
   issues with the `benchmark` label, parse the structured form body, apply
   plausibility bands (tok/s within 0.3×–3× of our own estimate for that
   hardware; reject otherwise), emit `registry/benchmarks.json` keyed by
   `(cpu_model, gpu_name, ram_gb)`.
2. Client fetches `benchmarks.json` beside `registry.json` (same three
   failure domains, same cache path).
3. Engine: when a key matches and ≥ N samples exist, use the median
   effective bandwidth with `Confidence::Community` — below `Calibrated`,
   above `Estimated`. Never overrides a local measurement.
4. Leaderboard = GitHub label search (free, already decided in triage).

The triage constraint "estimates don't depend on this data" relaxes only via
the plausibility gate + N-sample minimum. Unflag the button at launch.

## 4. Run modes + utilization bands (Phase C)

`usable_memory_gb` picks one pool (unified / VRAM / RAM). llmfit's four modes
are more honest on discrete-GPU machines — which is exactly Win/Linux parity.

- Add `RunMode { Unified, GpuResident, CpuGpuSplit, CpuOnly }` to
  `Assessment` (+ `MoeOffload` later, needs expert-size data).
- `CpuGpuSplit`: weights > VRAM·0.95 but ≤ VRAM + usable RAM → estimate
  offloaded fraction `f`, speed ≈ harmonic blend of GPU and RAM bandwidth
  weighted by `f`; fit verdict computed against the combined pool with a
  stricter comfort fraction. Excluded-reason text names the mode
  ("22 GB fits only by offloading 40% to system RAM — ~6 tok/s").
- Expose `utilization_pct` next to `FitVerdict` so the UI can draw the
  band; keep Comfortable/Tight/TooBig as the verdict vocabulary.
- Apple Silicon: `Unified` only — nothing changes for today's users.

Blocked on `hardware` crate reporting `available_ram_gb` + VRAM reliably on
Win/Linux (M6). Add the engine enum earlier with `Unified`/`CpuOnly` only.

## 5. Non-GUI surface — `modelfit` CLI + MCP — **DEFERRED 2026-09-07**

Not scheduled. Design kept so it can be picked up unchanged.

New workspace member `apps/cli` (`clap`), thin over the crates; no Tauri.

```
modelfit                      # three picks + why, human table
modelfit recommend --json     # Recommendations struct as JSON (agents/scripts)
modelfit fit                  # all models ranked, exclusions inline
modelfit info <model-id>      # ladder, estimate basis, confidence per number
modelfit doctor               # hardware detection dump for bug reports
modelfit bench [--share]      # calibration via Ollama; --share prints the issue URL
modelfit --hardware prof.json # run against a saved/"dream machine" profile
```

`--json` output is the engine's `Serialize` types unchanged — one contract
for GUI, CLI, and share links. Distribution: `cargo install`, then a Homebrew
tap alongside the desktop cask. An MCP server (`modelfit mcp`) over the same
functions is ~100 lines once the CLI exists and is how agents will find us;
prefer it over an llmfit-style REST `serve`.

## 6. Other gaps worth taking

- **6a Copy diagnostics** — the hardware report in llmfit (`doctor`) is what
  makes bug reports actionable. A "Copy diagnostics" button in the app's
  hardware panel (the CLI subcommand goes with item 5, deferred).
- **6b Estimate basis** — every number carries "assumes X GB/s effective
  bandwidth, Y bytes/weight, Z GB KV at 8k". Falls out of `Estimate.basis`
  in item 2; surface it in the hover card and `info`.
- **6c TTFT / prompt speed** — `measure()` already returns
  `prompt_tok_per_sec`; the engine ignores it. Calibrate a prompt-processing
  ratio and report "≈ N s to first token at your context" — a number llmfit
  can only give when TFLOPS are known. Confidence: `Calibrated` or absent,
  never estimated from specs.
- **6d Discrete-GPU bandwidth table** — replace the flat 300 GB/s with a
  vendor/name → GB/s table (~50 SKUs covers the market). Required for
  Win/Linux parity regardless of llmfit.
- **6e Second runtime adapter** — llmfit supports five; triage says exactly
  one to prove the trait. Sequence after Phase B; MLX (on-brand) or LM Studio
  (most requested).
- **6f Local measurement memory** — persist `measure()` results per tag so a
  model the user actually ran shows ✓ forever. Tiny; enables the top tier of
  item 2.

## Not taking from llmfit

- TUI — the GUI *is* the product; scripts wait for the (deferred) CLI.
- REST `serve` + Docker image — if an agent surface is built it is MCP (deferred with the CLI); nothing to host.
- Compile-time model DB — our remote registry is strictly better.
- Multi-GPU, five backends, battery estimates — already deferred in triage.
