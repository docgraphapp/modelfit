// Browser-only Tauri shim for designing the UI without the native shell.
// Loaded from main.tsx only when import.meta.env.DEV is true AND the real
// Tauri runtime is absent, so it is dead-code-eliminated from production
// builds and inert inside the real app.
import type {
  Assessment,
  Calibration,
  HardwareInfo,
  Recommendations,
  RegistryInfo,
  RuntimeStatus,
} from "../types";

const hw: HardwareInfo = {
  os: "macos",
  osVersion: "macOS 15.6",
  arch: "aarch64",
  cpuModel: "Apple M3 Pro",
  physicalCores: 12,
  logicalCores: 12,
  totalRamGb: 36,
  availableRamGb: 21.4,
  diskAvailableGb: 312.6,
  unifiedMemory: true,
  gpus: [{ vendor: "Apple", name: "Apple M3 Pro GPU", vramGb: 36, coreCount: 18 }],
  accelerations: ["metal", "cpu"],
};

// url params control which scenario renders: ?scenario=nofit|noruntime
// With no scenario, real data from `cargo run -p modelfit-recommendation
// --example probe > public/machine.json` (if present) plus the live local
// Ollama replace the synthetic fixtures.
const params = new URLSearchParams(location.search);
const scenario = params.get("scenario");
// The real shell decorates the window on macOS only, so the harness follows the
// host it runs on. ?chrome=custom forces the undecorated Windows/Linux look —
// orthogonal to scenario, so real data still loads.
const decorated =
  params.get("chrome") !== "custom" && navigator.userAgent.includes("Macintosh");

interface RealData {
  hardware: HardwareInfo;
  registryVersion: string;
  modelCount: number;
  recommendations: Record<string, Record<string, Recommendations>>;
  // Present when machine.json was generated with `--measured …`.
  recommendationsMeasured?: Record<string, Record<string, Recommendations>>;
  calibration?: Calibration;
}

let real: RealData | null = null;
if (!scenario) {
  try {
    const resp = await fetch("/machine.json");
    if (resp.ok) real = (await resp.json()) as RealData;
  } catch {
    /* synthetic fixtures */
  }
}

async function realRuntimeStatus(): Promise<RuntimeStatus | null> {
  try {
    const [version, tags] = await Promise.all([
      fetch("http://localhost:11434/api/version").then((r) => r.json()),
      fetch("http://localhost:11434/api/tags").then((r) => r.json()),
    ]);
    return {
      running: true,
      version: version.version,
      installedTags: (tags.models ?? []).map((m: { name: string }) => m.name),
    };
  } catch {
    return null;
  }
}

interface Row {
  id: string;
  name: string;
  quant: string;
  tag: string | null;
  mem: number;
  tps: number;
  fit: Assessment["fit"];
  quality: number;
  score: number;
  excluded: string | null;
}

const ROWS: Row[] = [
  { id: "qwen3-32b", name: "Qwen3 32B", quant: "Q4_K_M", tag: "qwen3:32b", mem: 21.9, tps: 11, fit: "tight", quality: 8.6, score: 78, excluded: null },
  { id: "gemma3-27b", name: "Gemma 3 27B", quant: "Q4_K_M", tag: "gemma3:27b", mem: 18.6, tps: 14, fit: "comfortable", quality: 8.3, score: 84, excluded: null },
  { id: "qwen3-30b-a3b", name: "Qwen3 30B A3B", quant: "Q4_K_M", tag: "qwen3:30b-a3b", mem: 19.8, tps: 58, fit: "comfortable", quality: 8.2, score: 88, excluded: null },
  { id: "qwen2.5-coder-14b", name: "Qwen2.5 Coder 14B", quant: "Q4_K_M", tag: "qwen2.5-coder:14b", mem: 10.4, tps: 24, fit: "comfortable", quality: 7.9, score: 81, excluded: null },
  { id: "phi4-14b", name: "Phi-4 14B", quant: "Q4_K_M", tag: "phi4:14b", mem: 10.1, tps: 25, fit: "comfortable", quality: 7.8, score: 80, excluded: null },
  { id: "llama3.1-8b", name: "Llama 3.1 8B", quant: "Q4_K_M", tag: "llama3.1:8b", mem: 6.2, tps: 42, fit: "comfortable", quality: 7.3, score: 76, excluded: null },
  { id: "qwen3-4b", name: "Qwen3 4B", quant: "Q4_K_M", tag: "qwen3:4b", mem: 3.6, tps: 78, fit: "comfortable", quality: 7.2, score: 74, excluded: null },
  { id: "llama3.2-3b", name: "Llama 3.2 3B", quant: "Q4_K_M", tag: "llama3.2:3b", mem: 2.9, tps: 96, fit: "comfortable", quality: 6.6, score: 69, excluded: null },
  { id: "llama3.3-70b", name: "Llama 3.3 70B", quant: "Q4_K_M", tag: "llama3.3:70b", mem: 44.2, tps: 5, fit: "toobig", quality: 8.9, score: 0, excluded: "needs ~44 GB, your usable memory is 26 GB" },
  { id: "qwen3-235b", name: "Qwen3 235B A22B", quant: "Q4_K_M", tag: null, mem: 142.0, tps: 8, fit: "toobig", quality: 9.3, score: 0, excluded: "needs ~142 GB, your usable memory is 26 GB" },
  { id: "deepseek-r1-70b", name: "DeepSeek-R1 70B", quant: "Q4_K_M", tag: "deepseek-r1:70b", mem: 44.9, tps: 5, fit: "toobig", quality: 9.0, score: 0, excluded: "needs ~45 GB, your usable memory is 26 GB" },
];

function toAssessment(r: Row, measured: boolean, ctxKv = 0): Assessment {
  return {
    modelId: r.id,
    name: r.name,
    quant: r.quant,
    ollamaTag: r.tag,
    estMemoryGb: Math.round((r.mem + ctxKv) * 10) / 10,
    estTokPerSec: measured ? r.tps * 1.12 : r.tps,
    fit: r.fit,
    quality: r.quality,
    score: r.score,
    excludedReason: r.excluded,
    confidence: measured ? "measured" : "medium",
    // Mirror the engine: a richer rung is offered, not auto-selected. Q8_0 is
    // ~1.75x the bytes per weight of Q4_K_M, so it costs proportional speed.
    alsoFits:
      r.fit === "comfortable" && r.quant === "Q4_K_M" && (r.mem + ctxKv) * 1.6 <= 26 * 0.8
        ? [
            {
              quant: "Q8_0",
              estMemoryGb: Math.round((r.mem + ctxKv) * 1.6 * 10) / 10,
              estTokPerSec: (measured ? r.tps * 1.12 : r.tps) * 0.57,
              ollamaTag: r.tag && `${r.tag}-q8_0`,
            },
          ]
        : [],
  };
}

function recommendations(req: {
  objective: string;
  contextLength: number;
  measuredEffectiveBandwidthGbps: number | null;
}): Recommendations {
  const measured = req.measuredEffectiveBandwidthGbps != null;
  const ctxKv = ((req.contextLength - 8192) / 1024) * 0.12;
  const all = ROWS.map((r) => toAssessment(r, measured, ctxKv));
  const runnable = all.filter((a) => !a.excludedReason);
  if (scenario === "nofit" || runnable.length === 0) {
    return {
      best: null,
      safe: null,
      fast: null,
      all: all.map((a) => ({
        ...a,
        excludedReason: a.excludedReason ?? `needs ~${a.estMemoryGb} GB at 128k context`,
        fit: "toobig",
      })),
      usableMemoryGb: 26,
      bandwidthGbps: measured ? 187 : 150,
      bandwidthMeasured: measured,
    };
  }
  const byScore = [...runnable].sort((a, b) => b.score - a.score);
  const comfortable = runnable.filter((a) => a.fit === "comfortable");
  const bySpeed = [...runnable].sort((a, b) => b.estTokPerSec - a.estTokPerSec);
  const best =
    req.objective === "coding"
      ? runnable.find((a) => a.modelId.includes("coder")) ?? byScore[0]
      : req.objective === "speed"
        ? bySpeed[0]
        : req.objective === "quality"
          ? [...runnable].sort((a, b) => b.quality - a.quality)[0]
          : byScore[0];
  const safe = comfortable.sort((a, b) => b.score - a.score)[0] ?? null;
  return {
    best,
    safe,
    fast: bySpeed[0] ?? null,
    all,
    usableMemoryGb: 26,
    bandwidthGbps: measured ? 187 : 150,
    bandwidthMeasured: measured,
  };
}

// Precomputed results are only valid for the machine they were generated on.
// When the user edits specs (plan-for-a-different-machine), re-derive each
// model's fit and the picks against the new usable memory. Scores for models
// the backend never scored (they were excluded) fall back to quality×10 —
// approximate, but the harness stays responsive to edits instead of lying.
function adjustForHardware(
  base: Recommendations,
  edited: HardwareInfo,
  detected: HardwareInfo,
): Recommendations {
  const ratio = edited.totalRamGb / detected.totalRamGb;
  if (Math.abs(ratio - 1) < 1e-6) return base;
  const usable = Math.round(base.usableMemoryGb * ratio * 10) / 10;
  const all = base.all.map((a) => {
    // A context-length cap is a property of the model, not the machine.
    if (a.excludedReason?.includes("max context")) return a;
    const need = a.estMemoryGb;
    if (need > usable)
      return {
        ...a,
        fit: "toobig" as const,
        excludedReason: `needs ~${need.toFixed(1)} GB, your usable memory is ${usable.toFixed(1)} GB`,
      };
    if (need > usable * 0.9)
      return {
        ...a,
        fit: "toobig" as const,
        excludedReason: `needs ~${need.toFixed(1)} GB — too close to your ${usable.toFixed(1)} GB usable memory (10% headroom required)`,
      };
    return {
      ...a,
      fit: (need <= usable * 0.7 ? "comfortable" : "tight") as Assessment["fit"],
      score: a.excludedReason || !a.score ? Math.round(a.quality * 10) : a.score,
      excludedReason: null,
    };
  });
  const runnable = all.filter((a) => !a.excludedReason);
  const byScore = [...runnable].sort((x, y) => y.score - x.score);
  const bySpeed = [...runnable].sort((x, y) => y.estTokPerSec - x.estTokPerSec);
  const comfortable = runnable
    .filter((a) => a.fit === "comfortable")
    .sort((x, y) => y.score - x.score);
  return {
    ...base,
    all,
    usableMemoryGb: usable,
    best: byScore[0] ?? null,
    safe: comfortable[0] ?? null,
    fast: bySpeed[0] ?? null,
  };
}

const runtime: RuntimeStatus =
  scenario === "noruntime"
    ? { running: false, version: null, installedTags: [] }
    : { running: true, version: "0.11.4", installedTags: ["llama3.2:3b", "qwen3:4b"] };

const registryInfo: RegistryInfo = {
  version: "2026-08-25",
  modelCount: ROWS.length,
  source: "bundled",
  added: null,
};

const calibration: Calibration = {
  modelTag: "llama3.2:3b",
  genTokPerSec: 94,
  promptTokPerSec: 612,
  effectiveBandwidthGbps: 187,
};

type Handler = (payload: { event: string; id: number; payload: unknown }) => void;
const callbacks = new Map<number, Handler>();
const listeners = new Map<string, Set<number>>();
let nextCb = 1;

function emit(event: string, payload: unknown) {
  for (const id of listeners.get(event) ?? []) {
    callbacks.get(id)?.({ event, id, payload });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mockInvoke(cmd: string, args: any): Promise<unknown> {
  switch (cmd) {
    case "detect_hardware":
      await sleep(250);
      return real ? real.hardware : hw;
    case "get_recommendations": {
      await sleep(60);
      let base: Recommendations | null = null;
      if (real) {
        const measured =
          args.request.measuredEffectiveBandwidthGbps != null
            ? real.recommendationsMeasured
            : undefined;
        const byCtx = (measured ?? real.recommendations)[args.request.objective];
        base = byCtx?.[String(args.request.contextLength)] ?? null;
      }
      base ??= recommendations(args.request);
      // Honor edited specs (the real backend recomputes; the mock adjusts).
      return adjustForHardware(base, args.hardware, real?.hardware ?? hw);
    }
    case "runtime_status":
      if (real) return (await realRuntimeStatus()) ?? runtime;
      return runtime;
    case "registry_info":
    case "update_registry":
      await sleep(cmd === "update_registry" ? 600 : 0);
      return real
        ? { ...registryInfo, version: real.registryVersion, modelCount: real.modelCount }
        : registryInfo;
    case "run_calibration":
      // Real numbers from the last `calibrate` example run when available.
      await sleep(4000);
      return real?.calibration ?? calibration;
    case "install_model": {
      const total = 5_600_000_000;
      for (let done = 0; done <= total; done += total / 40) {
        emit("modelfit://pull-progress", {
          tag: args.tag,
          status: "pulling",
          total,
          completed: done,
        });
        await sleep(120);
      }
      runtime.installedTags.push(args.tag);
      return null;
    }
    case "open_external":
      // Logged as well as opened: pane-embedded browsers block the popup.
      console.info(`[mockTauri] open_external ${args.url}`);
      window.open(args.url, "_blank");
      return null;
    case "plugin:window|is_decorated":
      return decorated;
    case "plugin:window|minimize":
    case "plugin:window|close":
      // No window to act on in a browser tab; log so the click is still visible.
      console.info(`[mockTauri] ${cmd}`);
      return null;
    case "plugin:event|listen": {
      const id = args.handler as number;
      if (!listeners.has(args.event)) listeners.set(args.event, new Set());
      listeners.get(args.event)!.add(id);
      return id;
    }
    case "frontend_ready":
      return null; // browser harness has no hidden window to reveal
    case "plugin:event|unlisten":
      listeners.get(args.event)?.delete(args.eventId);
      return null;
    default:
      throw new Error(`mockTauri: unhandled command ${cmd}`);
  }
}

(window as any).__TAURI_INTERNALS__ = {
  invoke: mockInvoke,
  // getCurrentWindow()/getCurrentWebview() read their label from here.
  metadata: {
    currentWindow: { label: "main" },
    currentWebview: { windowLabel: "main", label: "main" },
  },
  transformCallback(cb: Handler) {
    const id = nextCb++;
    callbacks.set(id, cb);
    return id;
  },
};

// @tauri-apps/api's event module cleans up through this, not through invoke.
(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener(event: string, id: number) {
    listeners.get(event)?.delete(id);
    callbacks.delete(id);
  },
};

console.info("[mockTauri] browser design harness active", { scenario, decorated });
