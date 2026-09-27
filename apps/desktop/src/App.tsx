import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import TitleBar from "./TitleBar";
import Term from "./Term";
import type { TermId } from "./glossary";
import type {
  Assessment,
  BenchmarkShare,
  Calibration,
  Confidence as ConfidenceTier,
  Estimate,
  HardwareInfo,
  PullProgress,
  Recommendations,
  RegistryInfo,
  RuntimeStatus,
  UpdateInfo,
  UpdateProgress,
} from "./types";

const CALIBRATION_KEY = "modelfit:calibration";
// tok/s this machine has actually produced, by runtime tag. Kept separate from
// the calibration: a calibration is one reading that ages out when the machine
// changes, while these are facts about models the user has really run, and the
// engine reports them verbatim instead of extrapolating.
const MEASUREMENTS_KEY = "modelfit:measurements";
// The one app version the user has said "Later" to. A dismissal silences the
// startup banner for that version only, so the next release still gets one
// chance to be noticed; the manual check ignores it entirely (ADR-0001).
const UPDATE_DISMISSED_KEY = "modelfit:update-dismissed";

// Sharing a benchmark works end to end — Rust builder, prefilled GitHub issue
// form, preview dialog — but the framing still needs work ("Create new issue"
// is GitHub's own heading and cannot be changed, which makes it read like
// filing a bug). Hidden until that is polished; flip to true to restore.
// Everything behind this flag stays built and tested, and CI keeps checking
// the form fields still match: scripts/check-benchmark-form.py.
const SHARE_BENCHMARK_ENABLED = false;

function loadCalibration(): Calibration | null {
  try {
    const raw = localStorage.getItem(CALIBRATION_KEY);
    return raw ? (JSON.parse(raw) as Calibration) : null;
  } catch {
    return null;
  }
}

type Measurements = Record<string, number>;

function loadMeasurements(): Measurements {
  try {
    const raw = localStorage.getItem(MEASUREMENTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== "object") return {};
    // Storage is user-writable and survives version changes, so anything that
    // is not a usable tok/s reading is dropped rather than shown as measured.
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        ([tag, tps]) => tag && typeof tps === "number" && tps > 0 && Number.isFinite(tps),
      ),
    ) as Measurements;
  } catch {
    return {};
  }
}

type Objective = "overall" | "quality" | "speed" | "coding" | "agents";

const OBJECTIVES: { id: Objective; label: string }[] = [
  { id: "overall", label: "Overall" },
  { id: "quality", label: "Quality" },
  { id: "speed", label: "Speed" },
  { id: "coding", label: "Coding" },
  { id: "agents", label: "Agents" },
];

// Agent prompts carry a system prompt, tool schemas and every tool result, so
// the Agents objective starts at a context that can hold a real task.
const AGENTS_MIN_CONTEXT = 32768;

// Shown in this order; `chat` is left out because every model has it.
const CAPABILITIES: { id: string; label: string; hint: string }[] = [
  { id: "tools", label: "tools", hint: "Accepts a tools list — can drive an agent or MCP client" },
  { id: "reasoning", label: "reasoning", hint: "Thinks step by step before answering" },
  { id: "vision", label: "vision", hint: "Reads images as well as text" },
  { id: "coding", label: "coding", hint: "Tuned or strong at writing code" },
];

function CapabilityChips({ a, className = "" }: { a: Assessment; className?: string }) {
  const caps = CAPABILITIES.filter((c) => a.capabilities?.includes(c.id));
  if (caps.length === 0) return null;
  return (
    <span className={`inline-flex flex-wrap gap-1 ${className}`}>
      {caps.map((c) => {
        const verified = c.id === "tools" && a.toolsVerified;
        return (
          <span
            key={c.id}
            title={verified ? `${c.hint}. Confirmed by your installed copy.` : c.hint}
            className={`cursor-help rounded px-1.5 py-px text-[10px] font-medium ${
              c.id === "tools"
                ? "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300"
                : "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
            }`}
          >
            {c.label}
            {verified && <span aria-label="confirmed by your installed copy"> ✓</span>}
          </span>
        );
      })}
    </span>
  );
}

const CONTEXTS = [4096, 8192, 16384, 32768, 65536, 131072];

const ACCEL_LABELS: Record<string, string> = {
  cpu: "CPU",
  metal: "Metal",
  cuda: "CUDA",
  rocm: "ROCm",
  vulkan: "Vulkan",
};

/** A duration a reader can feel: sub-minute in seconds, above that in minutes. */
function formatSeconds(s: number): string {
  if (s < 1) return "<1s";
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  return rest ? `${m}m ${rest}s` : `${m}m`;
}

const FIT_WORDS: Record<Assessment["fit"], string> = {
  comfortable: "runs comfortably",
  tight: "runs, but tight",
  toobig: "too big",
};

const PICK_HINTS: Record<string, string> = {
  Best: "Highest quality × speed for this objective",
  Safe: "Highest-scoring model with comfortable headroom",
  Fast: "Fastest model that still clears the quality bar",
};

function fmtCtx(n: number) {
  return `${n / 1024}k`;
}

function fmtGb(bytes: number) {
  return (bytes / 1e9).toFixed(1);
}

const GAUGE_COLORS: Record<Assessment["fit"], string> = {
  comfortable: "bg-emerald-500",
  tight: "bg-amber-500",
  toobig: "bg-red-400 dark:bg-red-500",
};

function FitGauge({
  a,
  usable,
  compact,
}: {
  a: Assessment;
  usable: number;
  compact?: boolean;
}) {
  const pct = Math.min(100, (a.memory.value / usable) * 100);
  return (
    <div>
      <div
        role="meter"
        aria-label={`Estimated memory: ${a.memory.value} of ${usable} GB usable`}
        aria-valuenow={a.memory.value}
        aria-valuemin={0}
        aria-valuemax={usable}
        className={`overflow-hidden rounded-full bg-neutral-200/80 dark:bg-neutral-800 ${
          compact ? "h-1" : "h-1.5"
        }`}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 ease-out ${GAUGE_COLORS[a.fit]}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {!compact && (
        <div className="mt-1.5 flex justify-between text-xs text-neutral-400 dark:text-neutral-500">
          <Term id="fit">{FIT_WORDS[a.fit]}</Term>
          <span className="tabular-nums">
            ~{a.memory.value} of {usable} GB usable
          </span>
        </div>
      )}
    </div>
  );
}

function CopyRunCommand({ tag }: { tag: string }) {
  const [copied, setCopied] = useState(false);
  const cmd = `ollama run ${tag}`;
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(cmd).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        });
      }}
      title="Copy command"
      className="group mt-3 flex w-full items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-2.5 py-1.5 text-left font-mono text-xs text-neutral-600 hover:border-neutral-300 dark:border-neutral-700/80 dark:bg-neutral-800/60 dark:text-neutral-300 dark:hover:border-neutral-600"
    >
      <span className="truncate">{cmd}</span>
      <span
        className={`shrink-0 font-sans text-[11px] font-medium ${
          copied
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-neutral-400 group-hover:text-neutral-600 dark:group-hover:text-neutral-300"
        }`}
      >
        {copied ? "Copied ✓" : "Copy"}
      </span>
    </button>
  );
}

function InstallControl({
  a,
  runtime,
  pulling,
  onInstall,
  hero,
  benchmarking,
}: {
  a: Assessment;
  runtime: RuntimeStatus | null;
  pulling: Record<string, PullProgress>;
  onInstall: (tag: string) => void;
  hero?: boolean;
  benchmarking?: boolean;
}) {
  if (!a.ollamaTag) return null;
  const tag = a.ollamaTag;
  const progress = pulling[tag];
  if (progress) {
    const pct =
      progress.total && progress.completed
        ? Math.round((progress.completed / progress.total) * 100)
        : null;
    return (
      <div className="mt-4">
        <div className="h-1.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all"
            style={{ width: `${pct ?? 5}%` }}
          />
        </div>
        <div className="mt-1.5 flex justify-between text-xs text-neutral-400">
          <span>{pct != null ? `Downloading… ${pct}%` : progress.status || "starting…"}</span>
          {progress.total != null && progress.completed != null && (
            <span className="tabular-nums">
              {fmtGb(progress.completed)} / {fmtGb(progress.total)} GB
            </span>
          )}
        </div>
      </div>
    );
  }
  if (runtime?.running && runtime.installedTags.includes(tag)) {
    return (
      <div className="mt-4">
        <div className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
          Installed ✓
        </div>
        <CopyRunCommand tag={tag} />
      </div>
    );
  }
  if (!runtime?.running) {
    return (
      <button
        disabled
        title="Install Ollama to enable one-click install"
        className={`mt-4 cursor-not-allowed rounded-lg border border-dashed border-neutral-300 font-medium text-neutral-400 dark:border-neutral-700 dark:text-neutral-500 ${
          hero ? "px-4 py-1.5 text-[13px]" : "px-3 py-1 text-xs"
        }`}
      >
        Install — needs Ollama
      </button>
    );
  }
  return (
    <button
      onClick={() => onInstall(tag)}
      disabled={benchmarking}
      title={
        benchmarking
          ? "Wait for the benchmark to finish — a download now would skew the measurement"
          : undefined
      }
      className={`mt-4 rounded-lg font-medium transition-colors disabled:opacity-50 ${
        hero
          ? "bg-emerald-600 px-4 py-1.5 text-[13px] text-white hover:bg-emerald-500 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
          : "bg-neutral-900 px-3 py-1 text-xs text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
      }`}
    >
      Install
    </button>
  );
}

// How each tier reads. A number the user cannot check is just an assertion, so
// every figure carries its basis as a tooltip — the whole point of the tiers is
// that a guess and a measurement never look alike.
//
// `estimated` deliberately has no glyph: it is the baseline every figure on
// screen already announces with a leading "~", and stamping a second tilde on
// each one ("~65 tok/s ~") taught the reader nothing while making the dense
// rows unreadable. A mark is spent only on a number that is better than an
// estimate — or worse than one.
const CONFIDENCE_MARKS: Record<
  ConfidenceTier,
  { glyph: string; word: string; className: string }
> = {
  measuredLocal: {
    glyph: "✓",
    word: "measured on this machine",
    className: "text-emerald-600 dark:text-emerald-500",
  },
  community: {
    glyph: "✓",
    word: "measured on hardware like yours",
    className: "text-sky-600 dark:text-sky-500",
  },
  calibrated: {
    glyph: "≈",
    word: "calibrated",
    className: "text-emerald-700/80 dark:text-emerald-500/80",
  },
  estimated: {
    glyph: "",
    word: "est.",
    className: "text-neutral-400 dark:text-neutral-500",
  },
  unknown: {
    glyph: "?",
    word: "unverified",
    className: "text-amber-600 dark:text-amber-500",
  },
};

function markFor(e: Estimate) {
  return CONFIDENCE_MARKS[e.confidence] ?? CONFIDENCE_MARKS.estimated;
}

/**
 * A number the engine produced, hoverable for the basis behind it.
 *
 * Every figure carries its basis whether or not it earns a glyph — that is
 * what makes it checkable rather than merely asserted — so the hover target is
 * the number itself, not a symbol beside it.
 */
function Num({ e, children }: { e: Estimate; children: React.ReactNode }) {
  const mark = markFor(e);
  return (
    <span className="cursor-help" title={`${mark.word} — ${e.basis}`}>
      {children}
      {mark.glyph && (
        <span className={mark.className} aria-label={`${mark.word}. ${e.basis}`}>
          {" "}
          <span aria-hidden>{mark.glyph}</span>
        </span>
      )}
    </span>
  );
}

/// The hero has room for the tier in words, where the dense rows do not.
function ConfidenceWord({ e }: { e: Estimate }) {
  const mark = markFor(e);
  return (
    <span className={mark.className} title={e.basis}>
      {" "}
      <Term id="measured">{e.confidence === "measuredLocal" ? "measured" : mark.word}</Term>
    </span>
  );
}

function HeroPick({
  a,
  usable,
  children,
}: {
  a: Assessment;
  usable: number;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-emerald-200/80 bg-gradient-to-b from-emerald-50/70 to-white p-5 shadow-sm dark:border-emerald-900/60 dark:from-emerald-950/35 dark:to-neutral-900">
      <div className="flex items-baseline justify-between">
        <span
          title={PICK_HINTS.Best}
          className="text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-600 dark:text-emerald-400"
        >
          Best for this machine
        </span>
        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
          <Term id="score">
            {Math.round(a.score)}<span className="font-normal opacity-60">/100</span>
          </Term>
        </span>
      </div>
      <div className="mt-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-xl font-semibold leading-tight tracking-tight">{a.name}</h2>
        <span className="text-[13px] text-neutral-400 dark:text-neutral-500">
          <Term id="quantization">{a.quant}</Term>
        </span>
        <CapabilityChips a={a} />
      </div>
      <div className="mt-4 flex gap-8">
        <div>
          <div className="text-lg font-semibold tabular-nums leading-tight">
            ~{Math.round(a.speed.value)}
            <span className="text-[13px] font-normal text-neutral-400"> tok/s</span>
            <span className="text-[13px] font-normal">
              <ConfidenceWord e={a.speed} />
            </span>
          </div>
          <div className="text-xs text-neutral-400 dark:text-neutral-500">
            <Term id="tokensPerSecond">generation speed</Term>
          </div>
        </div>
        <div>
          <div className="text-lg font-semibold tabular-nums leading-tight">
            <Num e={a.memory}>
              ~{a.memory.value}
              <span className="text-[13px] font-normal text-neutral-400"> GB</span>
            </Num>
          </div>
          <div className="text-xs text-neutral-400 dark:text-neutral-500">
            <Term id="memory">memory needed</Term>
          </div>
        </div>
        {/* Only after the benchmark: prefill throughput cannot be read off a
            spec sheet, so before then there is no honest number to show. */}
        {a.timeToFirstTokenS && (
          <div>
            <div className="text-lg font-semibold tabular-nums leading-tight">
              <Num e={a.timeToFirstTokenS}>
                ~{formatSeconds(a.timeToFirstTokenS.value)}
              </Num>
            </div>
            <div className="text-xs text-neutral-400 dark:text-neutral-500">
              <Term id="prefillDecode">to first token</Term>
            </div>
          </div>
        )}
      </div>
      <div className="mt-4">
        <FitGauge a={a} usable={usable} />
      </div>
      <QuantLadder a={a} usable={usable} />
      {children}
    </div>
  );
}

// The quantization ladder, shown rather than decided. More bits keep the model
// closer to its original weights, and cost memory and speed — a trade the
// engine cannot make for the reader, because quality is not modelled per quant.
// So both measured axes are drawn and the choice is left visible.
function QuantLadder({ a, usable }: { a: Assessment; usable: number }) {
  if (!a.ladder || a.ladder.length < 2) return null;
  // Bars share one scale so rungs are comparable, and the scale always spans
  // usable memory — otherwise a ladder that all fits would look full.
  const scale = Math.max(usable, ...a.ladder.map((r) => r.memory.value));
  const limit = (usable / scale) * 100;

  return (
    <div className="mt-4">
      <div className="flex items-baseline justify-between text-[11px] text-neutral-400 dark:text-neutral-500">
        <span className="font-medium uppercase tracking-[0.12em]">
          <Term id="quantization">Quantizations</Term>
        </span>
        <span title={`Your usable memory: ~${Math.round(usable)} GB`}>
          more bits = closer to the original weights
        </span>
      </div>

      <div className="mt-2">
        <ul className="space-y-1">
          {a.ladder.map((r) => {
            const chosen = r.quant === a.quant;
            const fits = r.fit !== "toobig";
            return (
              <li
                key={r.quant}
                className={`flex items-center gap-2 text-[11px] tabular-nums ${
                  chosen
                    ? "font-semibold text-neutral-800 dark:text-neutral-100"
                    : fits
                      ? "text-neutral-500 dark:text-neutral-400"
                      : "text-neutral-400 dark:text-neutral-600"
                }`}
              >
                <span className="w-20 shrink-0 truncate" title={chosen ? "Recommended" : undefined}>
                  {chosen && <span aria-hidden className="mr-1 text-emerald-500">▸</span>}
                  {r.quant}
                </span>
                <span className="relative h-1.5 flex-1 rounded-full bg-neutral-200/70 dark:bg-neutral-800">
                  <span
                    className={`block h-full rounded-full ${GAUGE_COLORS[r.fit]} ${
                      fits ? "" : "opacity-40"
                    }`}
                    style={{ width: `${Math.min(100, (r.memory.value / scale) * 100)}%` }}
                  />
                  {/* Your usable memory. Bars crossing it cannot run here.
                      Drawn per row so it stays aligned with the bar column. */}
                  <span
                    aria-hidden
                    className="absolute -top-0.5 h-2.5 w-px bg-neutral-400 dark:bg-neutral-500"
                    style={{ left: `${limit}%` }}
                  />
                </span>
                <span className="w-14 shrink-0 text-right">
                  <Num e={r.memory}>{r.memory.value} GB</Num>
                </span>
                <span className="w-[4.5rem] shrink-0 text-right">
                  {fits ? (
                    <Num e={r.speed}>~{Math.round(r.speed.value)} tok/s</Num>
                  ) : (
                    "won't fit"
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

// Sharing publishes to a public issue tracker, permanently. So the exact
// payload is shown first, verbatim and in full — the user approves what will
// be posted, not a description of it. Even then nothing is sent from here:
// the button only opens a prefilled GitHub form, which the user must submit.
function ShareBenchmarkDialog({
  share,
  onClose,
}: {
  share: BenchmarkShare;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-6 backdrop-blur-[2px] dark:bg-black/60"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Share my benchmark"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-5 shadow-xl dark:border-neutral-800 dark:bg-neutral-900"
      >
        <h2 className="text-sm font-semibold">Share my benchmark</h2>
        <p className="mt-1.5 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
          This opens a prefilled issue on GitHub with exactly the values below.
          They become public. Nothing is sent until you press Submit there.
        </p>

        <dl className="mt-3.5 max-h-64 space-y-1 overflow-y-auto rounded-xl bg-neutral-50 p-3 text-xs dark:bg-neutral-950/60">
          {share.fields.map((f) => (
            <div key={f.id} className="flex gap-3">
              <dt className="w-36 shrink-0 text-neutral-400 dark:text-neutral-500">{f.label}</dt>
              <dd className="min-w-0 flex-1 break-words text-neutral-700 dark:text-neutral-200">
                {f.value || "—"}
              </dd>
            </div>
          ))}
        </dl>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              invoke("open_external", { url: share.url }).catch(() => {});
              onClose();
            }}
            className="rounded-lg bg-neutral-900 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            Open GitHub
          </button>
        </div>
      </div>
    </div>
  );
}

function MiniPick({
  tag,
  a,
  usable,
  children,
}: {
  tag: string;
  a: Assessment;
  usable: number;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex-1 rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-baseline justify-between">
        <span
          title={PICK_HINTS[tag]}
          className="text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-400"
        >
          {tag}
        </span>
        <span className="text-xs font-semibold tabular-nums text-neutral-500 dark:text-neutral-400">
          {Math.round(a.score)}/100
        </span>
      </div>
      <div className="mt-2 text-[15px] font-semibold leading-snug">{a.name}</div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-400">
        <Term id="quantization">{a.quant}</Term>
        <CapabilityChips a={a} />
      </div>
      <div className="mt-3 text-[13px] tabular-nums text-neutral-500 dark:text-neutral-400">
        <Num e={a.speed}>~{Math.round(a.speed.value)} tok/s</Num> ·{" "}
        <Num e={a.memory}>~{a.memory.value} GB</Num>
      </div>
      <div className="mt-2.5">
        <FitGauge a={a} usable={usable} compact />
      </div>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div role="group" className="inline-flex rounded-full bg-neutral-100 p-0.5 dark:bg-neutral-800">
      {options.map((o) => (
        <button
          key={o.id}
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          className={`rounded-full px-3.5 py-1 text-[13px] font-medium transition-colors ${
            value === o.id
              ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-600 dark:text-white"
              : "text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// Discrete steps rather than a free-running range: these six values are the
// ones the rest of the UI already speaks, and snapping caps a full drag at
// five recomputes instead of one per pixel.
function ContextSlider({
  value,
  onChange,
  runnable,
  total,
}: {
  value: number;
  onChange: (v: number) => void;
  runnable: number | null;
  total: number | null;
}) {
  const idx = Math.max(0, CONTEXTS.indexOf(value));
  return (
    <div className="flex items-center gap-2.5">
      <label className="flex items-center gap-2.5 text-[13px] text-neutral-500 dark:text-neutral-400">
        <Term id="context">Context</Term>
        <input
          type="range"
          min={0}
          max={CONTEXTS.length - 1}
          step={1}
          value={idx}
          onChange={(e) => onChange(CONTEXTS[Number(e.target.value)])}
          aria-label="Context length"
          aria-valuetext={`${fmtCtx(value)} tokens`}
          style={
            { "--fill": `${(idx / (CONTEXTS.length - 1)) * 100}%` } as React.CSSProperties
          }
          className="ctx-slider w-28 sm:w-36"
        />
      </label>
      <span className="w-9 text-[13px] font-medium tabular-nums text-neutral-700 dark:text-neutral-200">
        {fmtCtx(value)}
      </span>
      {runnable !== null && total !== null && (
        <span
          title="Models that still run at this context length. A longer context grows the KV cache, which competes with the weights for memory."
          className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium tabular-nums transition-colors ${
            runnable === 0
              ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
              : "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
          }`}
        >
          {runnable} of {total} run
        </span>
      )}
    </div>
  );
}

function FitBadge({ a }: { a: Assessment }) {
  if (a.excludedReason) {
    return (
      <span className="text-xs leading-snug text-neutral-500 dark:text-neutral-400">
        {a.excludedReason}
      </span>
    );
  }
  const styles =
    a.fit === "comfortable"
      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
      : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400";
  return (
    <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${styles}`}>
      {FIT_WORDS[a.fit]}
    </span>
  );
}

function Brand({ ready }: { ready: boolean }) {
  // `ready` starts the gauge sweep. Until then the mark holds at zero, which
  // reads honestly next to the "Detecting your machine…" skeleton.
  return (
    <div className={`app-brand flex items-center gap-2.5 ${ready ? "is-ready" : ""}`}>
      <span
        aria-hidden
        className="relative flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-neutral-900 shadow-sm shadow-emerald-500/30 ring-1 ring-white/10"
      >
        {/* gauge needle landing in the green — same mark as the app icon */}
        <svg viewBox="0 0 32 32" className="h-8 w-8">
          <defs>
            <linearGradient id="brand-arc" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" stopColor="#059669" />
              <stop offset="0.6" stopColor="#10b981" />
              <stop offset="1" stopColor="#4ade80" />
            </linearGradient>
          </defs>
          <path
            d="M 8.64 21.25 A 8.5 8.5 0 1 1 23.36 21.25"
            fill="none"
            stroke="#3f3f46"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
          <path
            className="mark-arc"
            pathLength={100}
            d="M 8.64 21.25 A 8.5 8.5 0 1 1 23.7 13.41"
            fill="none"
            stroke="url(#brand-arc)"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
          <path className="mark-needle" d="M 22.9 13.9 L 15.5 18.1 A 1.7 1.7 0 0 1 16.4 15.4 Z" fill="#fafafa" />
          <circle className="mark-hub" cx="16" cy="17" r="2.6" fill="#0c0c0e" stroke="#10b981" strokeWidth="1.4" />
        </svg>
      </span>
      <div className="leading-tight">
        <h1 className="text-[15px] font-semibold tracking-tight">ModelFit</h1>
        <p className="text-[11px] text-neutral-400 dark:text-neutral-500">
          The best AI model for your machine
        </p>
      </div>
    </div>
  );
}

function HeaderCard({
  hw,
  onEdited,
}: {
  hw: HardwareInfo | null;
  onEdited: (hw: HardwareInfo) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [ram, setRam] = useState("");
  const [vram, setVram] = useState("");

  const startEdit = () => {
    if (!hw) return;
    setRam(String(hw.totalRamGb));
    setVram(String(hw.gpus[0]?.vramGb ?? ""));
    setEditing(true);
  };

  const apply = () => {
    if (!hw) return;
    const ramGb = parseFloat(ram);
    const vramGb = parseFloat(vram);
    const next: HardwareInfo = { ...hw, gpus: hw.gpus.map((g) => ({ ...g })) };
    if (Number.isFinite(ramGb) && ramGb > 0) {
      next.totalRamGb = ramGb;
      // Unified memory: the GPU pool IS the RAM pool.
      if (next.unifiedMemory && next.gpus[0]) next.gpus[0].vramGb = ramGb;
    }
    if (!next.unifiedMemory && next.gpus[0] && Number.isFinite(vramGb) && vramGb > 0) {
      next.gpus[0].vramGb = vramGb;
    }
    setEditing(false);
    onEdited(next);
  };

  const gpu = hw?.gpus[0];
  // A few chips are explainable; the rest are plain text.
  const specs = hw
    ? ([
        {
          text: `${hw.totalRamGb} GB${hw.unifiedMemory ? " unified" : ""}`,
          term: hw.unifiedMemory ? ("unifiedMemory" as const) : undefined,
        },
        { text: `${hw.physicalCores}-core CPU` },
        gpu && { text: gpu.coreCount ? `${gpu.coreCount}-core GPU` : gpu.name },
        gpu &&
          !hw.unifiedMemory &&
          gpu.vramGb != null && { text: `${gpu.vramGb} GB VRAM`, term: "vram" as const },
        { text: `${Math.round(hw.diskAvailableGb)} GB free disk` },
        ...hw.accelerations
          .filter((a) => a !== "cpu")
          .map((a) => ({ text: ACCEL_LABELS[a] ?? a, term: "backend" as const })),
      ].filter(Boolean) as { text: string; term?: TermId }[])
    : [];

  const editField = (
    label: string,
    value: string,
    setValue: (v: string) => void,
  ) => (
    <label className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
      {label}
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") apply();
          if (e.key === "Escape") setEditing(false);
        }}
        autoFocus={label.startsWith("Memory")}
        className="w-20 rounded-lg border border-neutral-300 bg-white px-2 py-1 text-[13px] font-medium tabular-nums text-neutral-900 outline-none focus:border-emerald-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-emerald-500"
      />
    </label>
  );

  return (
    <section className="relative overflow-hidden rounded-2xl border border-neutral-200 bg-white px-5 py-3.5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <div
        aria-hidden
        className="pointer-events-none absolute -left-20 -top-24 h-52 w-52 rounded-full bg-emerald-400/10 blur-3xl dark:bg-emerald-500/10"
      />
      <div className="relative flex flex-wrap items-center gap-x-5 gap-y-3">
        <Brand ready={!!hw} />
        <div
          aria-hidden
          className="hidden h-9 w-px bg-neutral-200 dark:bg-neutral-800 md:block"
        />
        {!hw ? (
          <span className="animate-pulse text-[13px] text-neutral-400 dark:text-neutral-500">
            Detecting your machine…
          </span>
        ) : (
          <div className="min-w-0 grow basis-full md:basis-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
              <h2 className="text-[15px] font-semibold tracking-tight">{hw.cpuModel}</h2>
              <span className="text-xs text-neutral-400 dark:text-neutral-500">
                {hw.osVersion}
              </span>
              <div className="ml-auto">
                {editing ? (
                  <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
                    {editField("Memory (GB)", ram, setRam)}
                    {gpu && !hw.unifiedMemory && editField("VRAM (GB)", vram, setVram)}
                    <button
                      onClick={() => setEditing(false)}
                      className="text-xs font-medium text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={apply}
                      className="rounded-lg bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
                    >
                      Done
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={startEdit}
                    title="Detected specs are editable — plan for a different machine"
                    className="rounded-lg border border-neutral-200 px-2.5 py-1 text-xs font-medium text-neutral-500 hover:border-neutral-400 hover:text-neutral-700 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-500 dark:hover:text-neutral-200"
                  >
                    Edit
                  </button>
                )}
              </div>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {specs.map((s) => (
                <span
                  key={s.text}
                  className="rounded-md bg-neutral-100 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
                >
                  {s.term ? <Term id={s.term}>{s.text}</Term> : s.text}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function ViewTabs({
  view,
  modelCount,
  onChange,
}: {
  view: "picks" | "all";
  modelCount: number;
  onChange: (v: "picks" | "all") => void;
}) {
  const tabs: { id: "picks" | "all"; label: React.ReactNode }[] = [
    { id: "picks", label: "Recommended" },
    {
      id: "all",
      label: (
        <>
          All models
          <span className="ml-1.5 rounded-full bg-neutral-100 px-1.5 py-px text-[11px] font-semibold tabular-nums text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
            {modelCount}
          </span>
        </>
      ),
    },
  ];
  return (
    <div
      role="tablist"
      aria-label="Results view"
      className="mt-4 flex gap-5 border-b border-neutral-200 dark:border-neutral-800"
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={view === t.id}
          onClick={() => onChange(t.id)}
          className={`-mb-px border-b-2 pb-2 text-[13px] font-medium transition-colors ${
            view === t.id
              ? "border-emerald-500 text-neutral-900 dark:text-neutral-100"
              : "border-transparent text-neutral-400 hover:border-neutral-300 hover:text-neutral-600 dark:hover:border-neutral-600 dark:hover:text-neutral-300"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="mt-4 animate-pulse" aria-label="Detecting your machine…" role="status">
      <div className="flex items-center justify-between">
        <div className="h-8 w-72 rounded-full bg-neutral-200/60 dark:bg-neutral-800/60" />
        <div className="h-8 w-24 rounded-lg bg-neutral-200/60 dark:bg-neutral-800/60" />
      </div>
      <div className="mt-6 h-52 rounded-2xl bg-neutral-200/60 dark:bg-neutral-800/60" />
      <div className="mt-3 flex gap-3">
        <div className="h-36 flex-1 rounded-2xl bg-neutral-200/60 dark:bg-neutral-800/60" />
        <div className="h-36 flex-1 rounded-2xl bg-neutral-200/60 dark:bg-neutral-800/60" />
      </div>
    </div>
  );
}

/// Phases of the install the banner has to render. Kept as one union rather
/// than several booleans so no render can show a progress bar and a "Later"
/// button at the same time.
type UpdateStage = "available" | "downloading" | "ready" | "failed";

/// Tauri hands back a plain string from a failed command, but anything thrown
/// on the way there arrives as an Error. The banner reads the message inside a
/// sentence, so the "Error: " prefix has to go.
function reason(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.replace(/^Error:\s*/, "");
}

function bytes(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}

/// Non-modal update notice: the app stays fully usable behind it, and only
/// the final restart is disruptive — which the user asks for explicitly
/// (ADR-0001). It sits under the title bar rather than over the content so it
/// never covers a recommendation the user is reading.
function UpdateBanner({
  info,
  stage,
  progress,
  error,
  onInstall,
  onRestart,
  onDismiss,
}: {
  info: UpdateInfo;
  stage: UpdateStage;
  progress: UpdateProgress | null;
  error: string | null;
  onInstall: () => void;
  onRestart: () => void;
  onDismiss: () => void;
}) {
  // A percentage is only honest when the server sent a content-length;
  // otherwise the bytes so far are all we can truthfully show.
  const pct =
    progress && progress.total
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;

  return (
    <div
      role="status"
      className="mx-auto mt-2 flex w-full max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:border-blue-900/70 dark:bg-blue-950/50 dark:text-blue-100"
    >
      <span className="flex-1">
        {stage === "ready" ? (
          <>
            Version {info.version} is installed. Restart to start using it.
          </>
        ) : stage === "failed" ? (
          <>Couldn't install the update{error ? `: ${error}` : "."}</>
        ) : (
          <>
            ModelFit {info.version} is available
            <span className="text-blue-700/70 dark:text-blue-200/60">
              {" "}
              · you have {info.currentVersion}
            </span>
          </>
        )}
      </span>

      {stage === "downloading" ? (
        <span className="flex items-center gap-2 text-blue-700 dark:text-blue-200">
          {/* Indeterminate width is still a moving bar: a stalled-looking
              full-width track reads as broken. */}
          <span className="h-1.5 w-28 overflow-hidden rounded-full bg-blue-200 dark:bg-blue-900">
            <span
              className="block h-full rounded-full bg-blue-500 transition-[width] duration-150"
              style={{ width: pct != null ? `${pct}%` : "40%" }}
            />
          </span>
          <span className="tabular-nums">
            {pct != null
              ? `${pct}%`
              : progress
                ? bytes(progress.downloaded)
                : "starting…"}
          </span>
        </span>
      ) : (
        <>
          <button
            onClick={stage === "ready" ? onRestart : onInstall}
            className="rounded-lg bg-blue-600 px-3 py-1 font-medium text-white hover:bg-blue-500"
          >
            {stage === "ready"
              ? "Restart now"
              : stage === "failed"
                ? "Try again"
                : "Install and restart"}
          </button>
          <button
            onClick={onDismiss}
            className="font-medium text-blue-700/80 underline decoration-blue-300 hover:text-blue-900 dark:text-blue-200/80 dark:hover:text-blue-100"
          >
            Later
          </button>
        </>
      )}
    </div>
  );
}

export default function App() {
  const [hw, setHw] = useState<HardwareInfo | null>(null);
  const [recs, setRecs] = useState<Recommendations | null>(null);
  const [objective, setObjective] = useState<Objective>("overall");
  const [contextLength, setContextLength] = useState(8192);
  const [view, setView] = useState<"picks" | "all">("picks");
  const [error, setError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [calibration, setCalibration] = useState<Calibration | null>(loadCalibration);
  const [measurements, setMeasurements] = useState<Measurements>(loadMeasurements);
  const [copiedDiagnostics, setCopiedDiagnostics] = useState(false);
  const [benchmarking, setBenchmarking] = useState(false);
  const [pulling, setPulling] = useState<Record<string, PullProgress>>({});
  const [registry, setRegistry] = useState<RegistryInfo | null>(null);
  const [registryMsg, setRegistryMsg] = useState<string | null>(null);
  const [share, setShare] = useState<BenchmarkShare | null>(null);
  const [updating, setUpdating] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState<UpdateInfo | null>(null);
  const [updateStage, setUpdateStage] = useState<UpdateStage>("available");
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  // Only the manual check reports "up to date" / "couldn't reach"; the
  // background one stays silent, so its outcome never lands here.
  const [updateCheckMsg, setUpdateCheckMsg] = useState<string | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const calibrationRef = useRef(calibration);
  calibrationRef.current = calibration;
  const measurementsRef = useRef(measurements);
  measurementsRef.current = measurements;
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const recomputeSeq = useRef(0);

  const recompute = useCallback(
    (
      hardware: HardwareInfo,
      obj: Objective,
      ctx: number,
      cal?: Calibration | null,
      meas?: Measurements,
    ) => {
      const c = cal !== undefined ? cal : calibrationRef.current;
      const seq = ++recomputeSeq.current;
      invoke<Recommendations>("get_recommendations", {
        hardware,
        request: {
          objective: obj,
          contextLength: ctx,
          measuredEffectiveBandwidthGbps: c?.effectiveBandwidthGbps ?? null,
          measuredTokPerSec: meas ?? measurementsRef.current,
          measuredPrefillCapacity: c?.prefillCapacity ?? null,
          runtimeCapabilities: runtimeRef.current?.capabilities ?? {},
        },
      })
        .then((r) => {
          // A stale response must not overwrite a newer request's result.
          if (seq !== recomputeSeq.current) return;
          setRecs(r);
          setError(null);
        })
        .catch((e) => {
          if (seq === recomputeSeq.current) setError(String(e));
        });
    },
    [],
  );

  const refreshRuntime = useCallback(() => {
    invoke<RuntimeStatus>("runtime_status").then(setRuntime).catch(() => {});
  }, []);

  useEffect(() => {
    invoke<HardwareInfo>("detect_hardware")
      .then((detected) => {
        setHw(detected);
        recompute(detected, "overall", 8192);
      })
      .catch((e) => setError(String(e)));
    refreshRuntime();
    invoke<RegistryInfo>("registry_info").then(setRegistry).catch(() => {});
    // Silent startup refresh; failures keep the cached/bundled registry.
    invoke<RegistryInfo>("update_registry")
      .then((info) => setRegistry(info))
      .catch(() => {});
    const unlisten = listen<PullProgress>("modelfit://pull-progress", (e) => {
      setPulling((prev) => ({ ...prev, [e.payload.tag]: e.payload }));
    });
    // The shell runs its own check a few seconds after launch and announces
    // the result here; the frontend never polls for it (ADR-0001).
    const unlistenUpdate = listen<UpdateInfo>("updater://available", (e) => {
      let dismissed: string | null = null;
      try {
        dismissed = localStorage.getItem(UPDATE_DISMISSED_KEY);
      } catch {
        // A blocked store just means the banner shows again; harmless.
      }
      if (e.payload.version === dismissed) return;
      setPendingUpdate(e.payload);
      setUpdateStage("available");
    });
    const unlistenProgress = listen<UpdateProgress>("updater://progress", (e) => {
      setUpdateProgress(e.payload);
    });
    return () => {
      unlisten.then((f) => f());
      unlistenUpdate.then((f) => f());
      unlistenProgress.then((f) => f());
    };
  }, [recompute, refreshRuntime]);

  // Fit the window to the first real screen so nothing important sits below
  // the fold on launch. The page keeps growing for a moment after the picks
  // paint — runtime status and the registry footer land on their own async
  // schedules — so this watches the body for a short settle window and keeps
  // reporting the tallest layout it sees, then stops: later view switches are
  // the user's to scroll, and a window resizing under every click would be
  // maddening. The shell clamps the number to what the display can hold.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || !hw || !recs) return;
    fitted.current = true;
    let tallest = 0;
    const report = () => {
      const h = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
      );
      if (h <= tallest) return;
      tallest = h;
      invoke("fit_window_height", { height: h }).catch(() => {});
    };
    const observer = new ResizeObserver(report);
    observer.observe(document.body);
    const stop = setTimeout(() => observer.disconnect(), 2500);
    return () => {
      observer.disconnect();
      clearTimeout(stop);
    };
  }, [hw, recs]);

  // The banner arrives seconds after launch, long after the fit-to-content
  // pass above has stopped watching, so it would otherwise push the bottom of
  // the page under the window edge. Only ever grows: dismissing it leaves a
  // little empty space, which is far less jarring than a window that resizes
  // itself while the user is reading.
  useEffect(() => {
    if (!pendingUpdate) return;
    const id = requestAnimationFrame(() => {
      invoke("fit_window_height", {
        height: Math.max(
          document.body.scrollHeight,
          document.documentElement.scrollHeight,
        ),
      }).catch(() => {});
    });
    return () => cancelAnimationFrame(id);
  }, [pendingUpdate]);

  // Runtime status lands after the first ranking, and again after every
  // install. What installed models say they can do settles their `tools`
  // tag, so the ranking is redone whenever that answer changes.
  const runtimeCapsKey = JSON.stringify(runtime?.capabilities ?? {});
  const lastCapsKey = useRef(runtimeCapsKey);
  useEffect(() => {
    if (runtimeCapsKey === lastCapsKey.current) return;
    lastCapsKey.current = runtimeCapsKey;
    if (hw) recompute(hw, objective, contextLength);
    // Only a change in what the runtime reports should trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeCapsKey]);

  const update = (obj: Objective, ctx: number, hardware?: HardwareInfo) => {
    if (obj === "agents" && objective !== "agents" && ctx < AGENTS_MIN_CONTEXT) {
      ctx = AGENTS_MIN_CONTEXT;
    }
    const machine = hardware ?? hw;
    setObjective(obj);
    setContextLength(ctx);
    if (hardware) setHw(hardware);
    if (machine) recompute(machine, obj, ctx);
  };

  const install = (tag: string) => {
    setPulling((prev) => ({
      ...prev,
      [tag]: { tag, status: "starting…", total: null, completed: null },
    }));
    invoke("install_model", { tag })
      .catch((e) => setError(String(e)))
      .finally(() => {
        setPulling((prev) => {
          const next = { ...prev };
          delete next[tag];
          return next;
        });
        refreshRuntime();
      });
  };

  const updateRegistry = () => {
    setUpdating(true);
    setRegistryMsg(null);
    invoke<RegistryInfo>("update_registry")
      .then((info) => {
        const changed =
          info.version !== registry?.version || info.modelCount !== registry?.modelCount;
        setRegistry(info);
        setRegistryMsg(
          info.added && info.added > 0
            ? `+${info.added} new model${info.added === 1 ? "" : "s"}`
            : changed
              ? "updated"
              : "up to date",
        );
        if (hw) recompute(hw, objective, contextLength);
      })
      .catch(() => setRegistryMsg("couldn't reach server — using current registry"))
      .finally(() => setUpdating(false));
  };

  // Manual "Check for updates". Same backend path as the background check,
  // but this one answers either way — someone clicked and is waiting. A
  // dismissed version is deliberately offered again here.
  const checkForUpdate = () => {
    setCheckingUpdate(true);
    setUpdateCheckMsg(null);
    invoke<UpdateInfo>("check_for_update")
      .then((info) => {
        if (info.available) {
          setPendingUpdate(info);
          setUpdateStage("available");
          setUpdateProgress(null);
          setUpdateError(null);
        } else {
          setUpdateCheckMsg(`up to date (${info.currentVersion})`);
        }
      })
      .catch(() => setUpdateCheckMsg("couldn't reach the update server"))
      .finally(() => setCheckingUpdate(false));
  };

  const installUpdate = () => {
    setUpdateStage("downloading");
    setUpdateProgress(null);
    setUpdateError(null);
    invoke("install_update")
      .then(() => setUpdateStage("ready"))
      .catch((e) => {
        setUpdateError(reason(e));
        setUpdateStage("failed");
      });
  };

  // Restarting throws away whatever is on screen, so it is its own click
  // after the download rather than something that happens under the user.
  const restartApp = () => {
    invoke("restart_app").catch((e) => {
      setUpdateError(reason(e));
      setUpdateStage("failed");
    });
  };

  const dismissUpdate = () => {
    if (pendingUpdate) {
      try {
        localStorage.setItem(UPDATE_DISMISSED_KEY, pendingUpdate.version);
      } catch {
        // Worst case the banner returns next launch.
      }
    }
    setPendingUpdate(null);
  };

  const openShare = () => {
    if (!hw || !calibration) return;
    invoke<BenchmarkShare>("benchmark_share", { hardware: hw, calibration })
      .then(setShare)
      .catch((e) => setError(String(e)));
  };

  const runBenchmark = () => {
    setBenchmarking(true);
    setError(null);
    invoke<Calibration>("run_calibration")
      .then((cal) => {
        setCalibration(cal);
        localStorage.setItem(CALIBRATION_KEY, JSON.stringify(cal));
        // The benchmark timed one real model on this machine, so that rung
        // stops being extrapolated — here and on every later launch. The
        // derived bandwidth still improves every other model's estimate.
        const next = { ...measurementsRef.current, [cal.modelTag]: cal.genTokPerSec };
        setMeasurements(next);
        try {
          localStorage.setItem(MEASUREMENTS_KEY, JSON.stringify(next));
        } catch {
          // A full or blocked store costs the memory of this reading, not the
          // benchmark the user just waited for.
        }
        if (hw) recompute(hw, objective, contextLength, cal, next);
        refreshRuntime();
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBenchmarking(false));
  };

  // The state behind the numbers on screen, for a bug report. Built in Rust so
  // it describes what the engine assumed rather than what the UI rendered.
  const copyDiagnostics = () => {
    invoke<string>("diagnostics", { hardware: hw, calibration })
      .then(async (text) => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          // Clipboard access can be refused; a selectable textarea is a worse
          // experience than the copy but better than losing the report.
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        setCopiedDiagnostics(true);
        window.setTimeout(() => setCopiedDiagnostics(false), 1600);
      })
      .catch((e) => setError(String(e)));
  };

  // Models the engine will actually recommend here — the number that visibly
  // falls as context (and so KV cache) grows.
  const runnable = recs ? recs.all.filter((a) => !a.excludedReason).length : null;

  const secondary = recs?.best
    ? [
        ...(recs.safe && recs.safe.modelId !== recs.best.modelId
          ? [{ tag: "Safe", a: recs.safe }]
          : []),
        ...(recs.fast &&
        recs.fast.modelId !== recs.best.modelId &&
        recs.fast.modelId !== recs.safe?.modelId
          ? [{ tag: "Fast", a: recs.fast }]
          : []),
      ]
    : [];

  return (
    <>
      {/* Column at least as tall as the window: the footer sits at the bottom
          on a short page, and the title bar's height no longer has to be
          subtracted by hand (which left a stray pixel of scroll). */}
      <div className="flex min-h-screen flex-col">
      <TitleBar />
      {pendingUpdate && (
        <UpdateBanner
          info={pendingUpdate}
          stage={updateStage}
          progress={updateProgress}
          error={updateError}
          onInstall={installUpdate}
          onRestart={restartApp}
          onDismiss={dismissUpdate}
        />
      )}
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-3 pb-3 pt-1">
        <HeaderCard hw={hw} onEdited={(next) => update(objective, contextLength, next)} />

        {error && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            Something went wrong: {error}
          </div>
        )}

        {!hw && !error && <Skeleton />}

        {hw && (
          <>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <Segmented
                options={OBJECTIVES}
                value={objective}
                onChange={(o) => update(o, contextLength)}
              />
              <ContextSlider
                value={contextLength}
                onChange={(c) => update(objective, c)}
                runnable={runnable}
                total={recs?.all.length ?? null}
              />
            </div>

            {recs && (
              <ViewTabs view={view} modelCount={recs.all.length} onChange={setView} />
            )}

            {view === "picks" && recs && !recs.best && (
              <section className="mt-4 rounded-2xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900">
                <h3 className="text-sm font-semibold">
                  No model clears the bar for this machine and objective
                </h3>
                <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
                  {(() => {
                    const closest = [...recs.all].sort(
                      (a, b) => a.memory.value - b.memory.value,
                    )[0];
                    return closest?.excludedReason
                      ? `Closest candidate: ${closest.name} — ${closest.excludedReason}.`
                      : "Try a smaller context length or a different objective.";
                  })()}
                </p>
                {contextLength > CONTEXTS[0] && (
                  <button
                    onClick={() =>
                      update(
                        objective,
                        CONTEXTS[Math.max(0, CONTEXTS.indexOf(contextLength) - 1)],
                      )
                    }
                    className="mt-3 rounded-lg border border-neutral-200 px-3 py-1 text-[13px] font-medium text-neutral-600 hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-500"
                  >
                    Try {fmtCtx(CONTEXTS[Math.max(0, CONTEXTS.indexOf(contextLength) - 1)])} context
                  </button>
                )}
              </section>
            )}

            {view === "picks" && recs && recs.best && (
              <section
                className={`mt-4 grid gap-3 ${
                  secondary.length > 0 ? "md:grid-cols-2" : ""
                }`}
                aria-label="Recommendations"
              >
                <HeroPick a={recs.best} usable={recs.usableMemoryGb}>
                  <InstallControl
                    a={recs.best}
                    runtime={runtime}
                    pulling={pulling}
                    onInstall={install}
                    hero
                    benchmarking={benchmarking}
                  />
                </HeroPick>
                {secondary.length > 0 && (
                  <div className="flex flex-col gap-3 sm:max-md:flex-row">
                    {secondary.map((p) => (
                      <MiniPick key={p.tag} tag={p.tag} a={p.a} usable={recs.usableMemoryGb}>
                        <InstallControl
                          a={p.a}
                          runtime={runtime}
                          pulling={pulling}
                          onInstall={install}
                          benchmarking={benchmarking}
                        />
                      </MiniPick>
                    ))}
                  </div>
                )}
              </section>
            )}

            {view === "all" && recs && (
              <section className="mt-4" aria-label="All models">
                <div className="overflow-hidden rounded-2xl border border-neutral-200 dark:border-neutral-800">
                    <table className="w-full text-[13px]">
                      <thead>
                        <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-400 dark:border-neutral-800">
                          <th className="px-4 py-2.5 font-medium">Model</th>
                          <th className="px-3 py-2.5 text-right font-medium">
                            <Term id="memory">Memory</Term>
                          </th>
                          <th className="px-3 py-2.5 text-right font-medium">
                            <Term id="tokensPerSecond">Speed</Term>
                          </th>
                          <th className="px-3 py-2.5 text-right font-medium">
                            <Term id="score">Score</Term>
                          </th>
                          <th className="px-4 py-2.5 font-medium">
                            <Term id="fit">Verdict</Term>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {recs.all.map((a) => (
                          <tr
                            key={a.modelId}
                            className="border-b border-neutral-100 transition-colors last:border-0 hover:bg-neutral-50 dark:border-neutral-800/60 dark:hover:bg-neutral-900"
                          >
                            <td className="px-4 py-2.5">
                              <span
                                className={`font-medium ${
                                  a.excludedReason
                                    ? "text-neutral-400 dark:text-neutral-500"
                                    : ""
                                }`}
                              >
                                {a.name}
                              </span>{" "}
                              <span className="text-neutral-400 dark:text-neutral-600">
                                {a.quant}
                              </span>{" "}
                              <CapabilityChips a={a} className="align-middle" />
                            </td>
                            <td
                              className={`whitespace-nowrap px-3 py-2.5 text-right tabular-nums ${
                                a.excludedReason ? "text-neutral-400 dark:text-neutral-500" : ""
                              }`}
                            >
                              <Num e={a.memory}>{a.memory.value} GB</Num>
                            </td>
                            <td
                              className={`whitespace-nowrap px-3 py-2.5 text-right tabular-nums ${
                                a.excludedReason ? "text-neutral-400 dark:text-neutral-500" : ""
                              }`}
                            >
                              <Num e={a.speed}>~{Math.round(a.speed.value)} t/s</Num>
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-right font-medium tabular-nums">
                              {a.excludedReason ? (
                                <span className="text-neutral-300 dark:text-neutral-600">—</span>
                              ) : a.recommendable ? (
                                Math.round(a.score)
                              ) : (
                                // Discovered, not curated: it runs, and we say
                                // so, but nothing here has rated how good it
                                // is — and a score invented to fill the column
                                // is exactly what would put it in BEST.
                                <span
                                  className="cursor-help text-neutral-300 dark:text-neutral-600"
                                  title={
                                    a.quality
                                      ? `Provisional score from ${a.qualitySource} — not curated, so this model is listed but never recommended`
                                      : "Not rated yet — listed with real memory and speed, but never recommended"
                                  }
                                >
                                  unrated
                                </span>
                              )}
                            </td>
                            <td className="max-w-[240px] px-4 py-2.5">
                              <FitBadge a={a} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                </div>
              </section>
            )}

            <section className="mb-4 mt-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-neutral-200 bg-white px-5 py-3 dark:border-neutral-800 dark:bg-neutral-900">
              <div className="text-[13px] text-neutral-500 dark:text-neutral-400">
                {runtime?.running ? (
                  <>
                    <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-emerald-500" />
                    <Term id="runtime">Ollama</Term> {runtime.version} ·{" "}
                    {runtime.installedTags.length} model
                    {runtime.installedTags.length === 1 ? "" : "s"} installed
                  </>
                ) : (
                  <>
                    <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-neutral-300 dark:bg-neutral-600" />
                    No <Term id="runtime">runtime</Term> detected — install and
                    benchmark need{" "}
                    <button
                      onClick={() =>
                        invoke("open_external", { url: "https://ollama.com/download" })
                      }
                      className="font-medium text-neutral-700 underline decoration-neutral-300 hover:text-neutral-900 dark:text-neutral-200 dark:hover:text-white"
                    >
                      Ollama
                    </button>
                  </>
                )}
              </div>
              {runtime?.running && (
                <div className="flex items-center gap-3 text-[13px]">
                  {calibration && !benchmarking && (
                    <span className="text-neutral-400">
                      <Term id="benchmark">measured</Term>{" "}
                      {Math.round(calibration.effectiveBandwidthGbps)} GB/s via{" "}
                      {calibration.modelTag}
                    </span>
                  )}
                  {SHARE_BENCHMARK_ENABLED && calibration && !benchmarking && (
                    <button
                      onClick={openShare}
                      title="Publish this result to ModelFit's public benchmark collection on GitHub"
                      className="rounded-lg border border-neutral-200 px-3 py-1 font-medium text-neutral-600 hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-500"
                    >
                      Share my benchmark
                    </button>
                  )}
                  <button
                    onClick={runBenchmark}
                    disabled={benchmarking || Object.keys(pulling).length > 0}
                    title={
                      Object.keys(pulling).length > 0
                        ? "Wait for the current download to finish — a concurrent pull would skew the measurement"
                        : "Runs a short generation on a small installed model to measure this machine's real memory bandwidth (~1 min)"
                    }
                    className="rounded-lg border border-neutral-200 px-3 py-1 font-medium text-neutral-600 hover:border-neutral-400 disabled:opacity-60 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-500"
                  >
                    {benchmarking ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-neutral-300 border-t-neutral-600 dark:border-neutral-600 dark:border-t-neutral-200" />
                        Benchmarking…
                      </span>
                    ) : calibration ? (
                      "Re-run benchmark"
                    ) : (
                      "Benchmark this machine"
                    )}
                  </button>
                </div>
              )}
            </section>

            <footer className="mt-auto space-y-1.5 border-t border-neutral-200/70 pt-3 text-xs text-neutral-400 dark:border-neutral-800/70">
              <p>
                {recs?.bandwidth.confidence === "calibrated" ? (
                  <>
                    Speeds are extrapolated from a real benchmark on this machine (
                    {Math.round(recs.bandwidth.value)} GB/s effective{" "}
                    <Term id="bandwidth">memory bandwidth</Term>).
                  </>
                ) : recs?.bandwidth.confidence === "unknown" ? (
                  <>
                    We have no <Term id="bandwidth">memory bandwidth</Term> figure for
                    this hardware, so speeds use a placeholder — run the{" "}
                    <Term id="benchmark">benchmark</Term> for real numbers.
                  </>
                ) : (
                  <>
                    Speeds are estimates from your chip's{" "}
                    <Term id="bandwidth">memory bandwidth</Term> — run the{" "}
                    <Term id="benchmark">benchmark</Term> for measured numbers.
                  </>
                )}
              </p>
              {registry && (
                <div className="flex items-center gap-2">
                  <span>
                    Registry {registry.version} · {registry.modelCount} models
                  </span>
                  <button
                    onClick={updateRegistry}
                    disabled={updating}
                    className="font-medium text-neutral-500 underline decoration-neutral-300 hover:text-neutral-700 disabled:opacity-50 dark:text-neutral-400 dark:hover:text-neutral-200"
                  >
                    {updating ? "updating…" : "Update"}
                  </button>
                  {registryMsg && <span>{registryMsg}</span>}
                  {/* Sits with the other "about this run" facts rather than in
                      the hero: it is only ever wanted when something looks
                      wrong, and that is the moment the user goes looking here. */}
                  <span aria-hidden>·</span>
                  <button
                    onClick={copyDiagnostics}
                    title="Copy this machine, the registry in force, and where each estimate comes from — for a bug report"
                    className="font-medium text-neutral-500 underline decoration-neutral-300 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
                  >
                    {copiedDiagnostics ? "Copied" : "Copy diagnostics"}
                  </button>
                  <span aria-hidden>·</span>
                  <button
                    onClick={checkForUpdate}
                    disabled={checkingUpdate}
                    title="Check whether a newer version of ModelFit is available"
                    className="font-medium text-neutral-500 underline decoration-neutral-300 hover:text-neutral-700 disabled:opacity-50 dark:text-neutral-400 dark:hover:text-neutral-200"
                  >
                    {checkingUpdate ? "checking…" : "Check for updates"}
                  </button>
                  {updateCheckMsg && <span>{updateCheckMsg}</span>}
                </div>
              )}
            </footer>
          </>
        )}
      </div>
      </div>
      {share && <ShareBenchmarkDialog share={share} onClose={() => setShare(null)} />}
    </>
  );
}
