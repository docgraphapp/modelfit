import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import TitleBar from "./TitleBar";
import type {
  Assessment,
  Calibration,
  HardwareInfo,
  PullProgress,
  Recommendations,
  RegistryInfo,
  RuntimeStatus,
} from "./types";

const CALIBRATION_KEY = "modelfit:calibration";

function loadCalibration(): Calibration | null {
  try {
    const raw = localStorage.getItem(CALIBRATION_KEY);
    return raw ? (JSON.parse(raw) as Calibration) : null;
  } catch {
    return null;
  }
}

type Objective = "overall" | "quality" | "speed" | "coding";

const OBJECTIVES: { id: Objective; label: string }[] = [
  { id: "overall", label: "Overall" },
  { id: "quality", label: "Quality" },
  { id: "speed", label: "Speed" },
  { id: "coding", label: "Coding" },
];

const CONTEXTS = [4096, 8192, 16384, 32768, 65536, 131072];

const ACCEL_LABELS: Record<string, string> = {
  cpu: "CPU",
  metal: "Metal",
  cuda: "CUDA",
  rocm: "ROCm",
  vulkan: "Vulkan",
};

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
  const pct = Math.min(100, (a.estMemoryGb / usable) * 100);
  return (
    <div>
      <div
        role="meter"
        aria-label={`Estimated memory: ${a.estMemoryGb} of ${usable} GB usable`}
        aria-valuenow={a.estMemoryGb}
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
          <span>{FIT_WORDS[a.fit]}</span>
          <span className="tabular-nums">
            ~{a.estMemoryGb} of {usable} GB usable
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

function Confidence({ a }: { a: Assessment }) {
  if (a.confidence === "measured") {
    return (
      <span className="text-emerald-600 dark:text-emerald-500" title="Extrapolated from a real benchmark on this machine">
        {" "}measured
      </span>
    );
  }
  return <span className="text-neutral-400 dark:text-neutral-500"> est.</span>;
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
        <span
          title="Quality × speed score for the selected objective, 0–100"
          className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
        >
          {Math.round(a.score)}<span className="font-normal opacity-60">/100</span>
        </span>
      </div>
      <div className="mt-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-xl font-semibold leading-tight tracking-tight">{a.name}</h2>
        <span className="text-[13px] text-neutral-400 dark:text-neutral-500">{a.quant}</span>
      </div>
      <div className="mt-4 flex gap-8">
        <div>
          <div className="text-lg font-semibold tabular-nums leading-tight">
            ~{Math.round(a.estTokPerSec)}
            <span className="text-[13px] font-normal text-neutral-400"> tok/s</span>
            <span className="text-[13px] font-normal"><Confidence a={a} /></span>
          </div>
          <div className="text-xs text-neutral-400 dark:text-neutral-500">generation speed</div>
        </div>
        <div>
          <div className="text-lg font-semibold tabular-nums leading-tight">
            ~{a.estMemoryGb}
            <span className="text-[13px] font-normal text-neutral-400"> GB</span>
          </div>
          <div className="text-xs text-neutral-400 dark:text-neutral-500">memory needed</div>
        </div>
      </div>
      <div className="mt-4">
        <FitGauge a={a} usable={usable} />
      </div>
      {children}
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
      <div className="text-xs text-neutral-400">{a.quant}</div>
      <div className="mt-3 text-[13px] tabular-nums text-neutral-500 dark:text-neutral-400">
        ~{Math.round(a.estTokPerSec)} tok/s<Confidence a={a} /> · ~{a.estMemoryGb} GB
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

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
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
            d="M 8.64 21.25 A 8.5 8.5 0 1 1 23.7 13.41"
            fill="none"
            stroke="url(#brand-arc)"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
          <path d="M 22.9 13.9 L 15.5 18.1 A 1.7 1.7 0 0 1 16.4 15.4 Z" fill="#fafafa" />
          <circle cx="16" cy="17" r="2.6" fill="#0c0c0e" stroke="#10b981" strokeWidth="1.4" />
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
  const specs = hw
    ? ([
        `${hw.totalRamGb} GB${hw.unifiedMemory ? " unified" : ""}`,
        `${hw.physicalCores}-core CPU`,
        gpu && (gpu.coreCount ? `${gpu.coreCount}-core GPU` : gpu.name),
        gpu && !hw.unifiedMemory && gpu.vramGb != null && `${gpu.vramGb} GB VRAM`,
        `${Math.round(hw.diskAvailableGb)} GB free disk`,
        ...hw.accelerations.filter((a) => a !== "cpu").map((a) => ACCEL_LABELS[a] ?? a),
      ].filter(Boolean) as string[])
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
        <Brand />
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
                  key={s}
                  className="rounded-md bg-neutral-100 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
                >
                  {s}
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

export default function App() {
  const [hw, setHw] = useState<HardwareInfo | null>(null);
  const [recs, setRecs] = useState<Recommendations | null>(null);
  const [objective, setObjective] = useState<Objective>("overall");
  const [contextLength, setContextLength] = useState(8192);
  const [view, setView] = useState<"picks" | "all">("picks");
  const [error, setError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [calibration, setCalibration] = useState<Calibration | null>(loadCalibration);
  const [benchmarking, setBenchmarking] = useState(false);
  const [pulling, setPulling] = useState<Record<string, PullProgress>>({});
  const [registry, setRegistry] = useState<RegistryInfo | null>(null);
  const [registryMsg, setRegistryMsg] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const calibrationRef = useRef(calibration);
  calibrationRef.current = calibration;
  const recomputeSeq = useRef(0);

  const recompute = useCallback(
    (hardware: HardwareInfo, obj: Objective, ctx: number, cal?: Calibration | null) => {
      const c = cal !== undefined ? cal : calibrationRef.current;
      const seq = ++recomputeSeq.current;
      invoke<Recommendations>("get_recommendations", {
        hardware,
        request: {
          objective: obj,
          contextLength: ctx,
          measuredEffectiveBandwidthGbps: c?.effectiveBandwidthGbps ?? null,
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
    return () => {
      unlisten.then((f) => f());
    };
  }, [recompute, refreshRuntime]);

  const update = (obj: Objective, ctx: number, hardware?: HardwareInfo) => {
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

  const runBenchmark = () => {
    setBenchmarking(true);
    setError(null);
    invoke<Calibration>("run_calibration")
      .then((cal) => {
        setCalibration(cal);
        localStorage.setItem(CALIBRATION_KEY, JSON.stringify(cal));
        if (hw) recompute(hw, objective, contextLength, cal);
        refreshRuntime();
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBenchmarking(false));
  };

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
      <TitleBar />
      <div className="mx-auto flex min-h-[calc(100vh-2.5rem)] w-full max-w-6xl flex-col px-5 pb-5 pt-2 sm:px-7">
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
              <label
                title="How much conversation the model can hold at once — longer context needs more memory"
                className="flex items-center gap-2 text-[13px] text-neutral-500 dark:text-neutral-400"
              >
                Context
                <select
                  value={contextLength}
                  onChange={(e) => update(objective, Number(e.target.value))}
                  className="rounded-lg border border-neutral-200 bg-white px-2 py-1 text-[13px] font-medium text-neutral-700 outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
                >
                  {CONTEXTS.map((c) => (
                    <option key={c} value={c}>
                      {fmtCtx(c)}
                    </option>
                  ))}
                </select>
              </label>
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
                      (a, b) => a.estMemoryGb - b.estMemoryGb,
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
                          <th className="px-3 py-2.5 text-right font-medium">Memory</th>
                          <th className="px-3 py-2.5 text-right font-medium">Speed</th>
                          <th className="px-3 py-2.5 text-right font-medium">Score</th>
                          <th className="px-4 py-2.5 font-medium">Verdict</th>
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
                              </span>
                            </td>
                            <td
                              className={`whitespace-nowrap px-3 py-2.5 text-right tabular-nums ${
                                a.excludedReason ? "text-neutral-400 dark:text-neutral-500" : ""
                              }`}
                            >
                              {a.estMemoryGb} GB
                            </td>
                            <td
                              className={`whitespace-nowrap px-3 py-2.5 text-right tabular-nums ${
                                a.excludedReason ? "text-neutral-400 dark:text-neutral-500" : ""
                              }`}
                            >
                              ~{Math.round(a.estTokPerSec)} t/s
                            </td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-right font-medium tabular-nums">
                              {a.excludedReason ? (
                                <span className="text-neutral-300 dark:text-neutral-600">—</span>
                              ) : (
                                Math.round(a.score)
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
                    Ollama {runtime.version} · {runtime.installedTags.length} model
                    {runtime.installedTags.length === 1 ? "" : "s"} installed
                  </>
                ) : (
                  <>
                    <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-neutral-300 dark:bg-neutral-600" />
                    No runtime detected — install and benchmark need{" "}
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
                      measured {Math.round(calibration.effectiveBandwidthGbps)} GB/s via{" "}
                      {calibration.modelTag}
                    </span>
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
                {recs?.bandwidthMeasured
                  ? `Speeds are extrapolated from a real benchmark on this machine (${Math.round(
                      recs.bandwidthGbps,
                    )} GB/s effective bandwidth).`
                  : "Speeds are estimates from your chip's memory bandwidth — run the benchmark for measured numbers."}
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
                </div>
              )}
            </footer>
          </>
        )}
      </div>
    </>
  );
}
