// Browser-only Tauri shim for designing the UI without the native shell.
// Loaded from main.tsx only when import.meta.env.DEV is true AND the real
// Tauri runtime is absent, so it is dead-code-eliminated from production
// builds and inert inside the real app.
import type {
  Assessment,
  Estimate,
  Calibration,
  HardwareInfo,
  Recommendations,
  RegistryInfo,
  RuntimeStatus,
  UpdateInfo,
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

// url params control which scenario renders:
//   ?scenario=nofit|noruntime|update|update-fail
// With no scenario, real data from `cargo run -p modelfit-recommendation
// --example probe > dev-data/machine.json` (dev server only; never bundled) plus the live local
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
    const installedTags: string[] = (tags.models ?? []).map((m: { name: string }) =>
      m.name.replace(/:latest$/, ""),
    );
    const capabilities: Record<string, string[]> = {};
    await Promise.all(
      installedTags.map(async (tag) => {
        try {
          const show = await fetch("http://localhost:11434/api/show", {
            method: "POST",
            body: JSON.stringify({ model: tag }),
          }).then((r) => r.json());
          if (Array.isArray(show.capabilities)) capabilities[tag] = show.capabilities;
        } catch {
          /* unknown, not "none" */
        }
      }),
    );
    return { running: true, version: version.version, installedTags, capabilities };
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
  caps: string[];
}

const ROWS: Row[] = [
  { id: "qwen3-32b", name: "Qwen3 32B", quant: "Q4_K_M", tag: "qwen3:32b", mem: 21.9, tps: 11, fit: "tight", quality: 8.6, score: 78, excluded: null, caps: ["chat", "reasoning", "tools"] },
  { id: "gemma3-27b", name: "Gemma 3 27B", quant: "Q4_K_M", tag: "gemma3:27b", mem: 18.6, tps: 14, fit: "comfortable", quality: 8.3, score: 84, excluded: null, caps: ["chat", "vision"] },
  { id: "qwen3-30b-a3b", name: "Qwen3 30B A3B", quant: "Q4_K_M", tag: "qwen3:30b-a3b", mem: 19.8, tps: 58, fit: "comfortable", quality: 8.2, score: 88, excluded: null, caps: ["chat", "reasoning", "tools"] },
  { id: "qwen2.5-coder-14b", name: "Qwen2.5 Coder 14B", quant: "Q4_K_M", tag: "qwen2.5-coder:14b", mem: 10.4, tps: 24, fit: "comfortable", quality: 7.9, score: 81, excluded: null, caps: ["chat", "coding", "tools"] },
  { id: "phi4-14b", name: "Phi-4 14B", quant: "Q4_K_M", tag: "phi4:14b", mem: 10.1, tps: 25, fit: "comfortable", quality: 7.8, score: 80, excluded: null, caps: ["chat"] },
  { id: "llama3.1-8b", name: "Llama 3.1 8B", quant: "Q4_K_M", tag: "llama3.1:8b", mem: 6.2, tps: 42, fit: "comfortable", quality: 7.3, score: 76, excluded: null, caps: ["chat", "tools"] },
  { id: "qwen3-4b", name: "Qwen3 4B", quant: "Q4_K_M", tag: "qwen3:4b", mem: 3.6, tps: 78, fit: "comfortable", quality: 7.2, score: 74, excluded: null, caps: ["chat", "reasoning", "tools"] },
  { id: "llama3.2-3b", name: "Llama 3.2 3B", quant: "Q4_K_M", tag: "llama3.2:3b", mem: 2.9, tps: 96, fit: "comfortable", quality: 6.6, score: 69, excluded: null, caps: ["chat", "tools"] },
  { id: "llama3.3-70b", name: "Llama 3.3 70B", quant: "Q4_K_M", tag: "llama3.3:70b", mem: 44.2, tps: 5, fit: "toobig", quality: 8.9, score: 0, excluded: "needs ~44 GB, your usable memory is 26 GB", caps: ["chat", "tools"] },
  { id: "qwen3-235b", name: "Qwen3 235B A22B", quant: "Q4_K_M", tag: null, mem: 142.0, tps: 8, fit: "toobig", quality: 9.3, score: 0, excluded: "needs ~142 GB, your usable memory is 26 GB", caps: ["chat", "reasoning", "tools"] },
  { id: "deepseek-r1-70b", name: "DeepSeek-R1 70B", quant: "Q4_K_M", tag: "deepseek-r1:70b", mem: 44.9, tps: 5, fit: "toobig", quality: 9.0, score: 0, excluded: "needs ~45 GB, your usable memory is 26 GB", caps: ["chat", "reasoning"] },
];

// Rung name -> bytes per weight relative to Q4_K_M, from the real registry.
const LADDER: [string, number][] = [
  ["Q3_K_M", 0.82],
  ["Q4_K_M", 1.0],
  ["Q5_K_M", 1.17],
  ["Q6_K", 1.35],
  ["Q8_0", 1.75],
];

// The engine ships every number with how well it is known and what it assumes;
// the harness has to as well, or the marks it renders would be fiction.
function est(value: number, confidence: Estimate["confidence"], basis: string): Estimate {
  return { value, confidence, basis };
}

function toAssessment(r: Row, measured: boolean, ctxKv = 0): Assessment {
  const speedTier = measured ? "calibrated" : "estimated";
  const bandwidth = measured ? 187 : 150;
  const memoryOf = (mem: number) =>
    est(
      mem,
      "estimated",
      `${(mem - 1.5).toFixed(1)} GB weights + KV cache at this context + 1.5 GB runtime overhead`,
    );
  const speedOf = (tps: number) =>
    est(
      tps,
      speedTier,
      measured
        ? `${bandwidth} GB/s measured on this machine by the calibration benchmark`
        : `${bandwidth} GB/s effective bandwidth ÷ GB touched per token`,
    );
  return {
    modelId: r.id,
    name: r.name,
    quant: r.quant,
    ollamaTag: r.tag,
    memory: memoryOf(Math.round((r.mem + ctxKv) * 10) / 10),
    speed: speedOf(measured ? r.tps * 1.12 : r.tps),
    timeToFirstTokenS: measured
      ? est(
          Math.round((8192 / (1400 / Math.max(1, r.mem * 1.6))) * 10) / 10,
          "calibrated",
          "prompt tokens/sec measured here, against an 8k context",
        )
      : null,
    fit: r.fit,
    quality: r.quality,
    // The harness only carries curated fixtures; the discovered tier is
    // exercised by the engine's own tests.
    recommendable: true,
    qualitySource: "hand",
    score: r.score,
    excludedReason: r.excluded,
    capabilities: r.caps,
    toolsVerified: false,
    // Mirror the engine's ladder. Bytes per weight relative to Q4_K_M drive
    // both memory and speed, so the mock trades the same way the real one does.
    ladder: LADDER.map(([name, bpw]) => {
      const mem = Math.round(((r.mem + ctxKv) * bpw) * 10) / 10;
      return {
        quant: name,
        memory: memoryOf(mem),
        speed: speedOf(Math.round(((measured ? r.tps * 1.12 : r.tps) / bpw) * 10) / 10),
        fit: (mem <= 26 * 0.8 ? "comfortable" : mem <= 26 * 0.9 ? "tight" : "toobig") as
          Assessment["fit"],
        ollamaTag: r.tag && `${r.tag}-${name.toLowerCase()}`,
      };
    }),
  };
}

function bandwidthEstimate(measured: boolean): Estimate {
  return measured
    ? est(187, "calibrated", "187 GB/s measured on this machine by the calibration benchmark")
    : est(150, "estimated", "Apple M4 Pro spec-sheet memory bandwidth 273 GB/s × 55% real-world efficiency");
}

function recommendations(req: {
  objective: string;
  contextLength: number;
  measuredEffectiveBandwidthGbps: number | null;
}): Recommendations {
  const measured = req.measuredEffectiveBandwidthGbps != null;
  const ctxKv = ((req.contextLength - 8192) / 1024) * 0.12;
  const all = ROWS.map((r) => toAssessment(r, measured, ctxKv)).map((a) =>
    req.objective === "agents" && !a.excludedReason && !a.capabilities.includes("tools")
      ? { ...a, excludedReason: "no tool-calling support", score: 0 }
      : a,
  );
  const runnable = all.filter((a) => !a.excludedReason);
  if (scenario === "nofit" || runnable.length === 0) {
    return {
      best: null,
      safe: null,
      fast: null,
      all: all.map((a) => ({
        ...a,
        excludedReason: a.excludedReason ?? `needs ~${a.memory.value} GB at 128k context`,
        fit: "toobig",
      })),
      usableMemoryGb: 26,
      bandwidth: bandwidthEstimate(measured),
    };
  }
  const byScore = [...runnable].sort((a, b) => b.score - a.score);
  const comfortable = runnable.filter((a) => a.fit === "comfortable");
  const bySpeed = [...runnable].sort((a, b) => b.speed.value - a.speed.value);
  const best =
    req.objective === "coding"
      ? runnable.find((a) => a.modelId.includes("coder")) ?? byScore[0]
      : req.objective === "speed"
        ? bySpeed[0]
        : req.objective === "quality"
          ? [...runnable].sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0))[0]
          : byScore[0];
  const safe = comfortable.sort((a, b) => b.score - a.score)[0] ?? null;
  return {
    best,
    safe,
    fast: bySpeed[0] ?? null,
    all,
    usableMemoryGb: 26,
    bandwidth: bandwidthEstimate(measured),
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
    const need = a.memory.value;
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
      score: a.excludedReason || !a.score ? Math.round((a.quality ?? 0) * 10) : a.score,
      excludedReason: null,
    };
  });
  const runnable = all.filter((a) => !a.excludedReason);
  const byScore = [...runnable].sort((x, y) => y.score - x.score);
  const bySpeed = [...runnable].sort((x, y) => y.speed.value - x.speed.value);
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
    ? { running: false, version: null, installedTags: [], capabilities: {} }
    : {
        running: true,
        version: "0.11.4",
        installedTags: ["llama3.2:3b", "qwen3:4b"],
        capabilities: {
          "llama3.2:3b": ["completion", "tools"],
          "qwen3:4b": ["completion", "tools", "thinking"],
        },
      };

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
  // prompt tok/s × the 3.2B model's parameters.
  prefillCapacity: 612 * 3.2,
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
    case "diagnostics": {
      // The real command builds this in Rust from the engine's own state; the
      // harness only has to prove the button copies something shaped like it.
      const machine: HardwareInfo = args.hardware ?? real?.hardware ?? hw;
      const cal: Calibration | null = args.calibration ?? null;
      const rows: [string, string][] = [
        ["App", "0.1.0 (browser harness)"],
        ["Registry", `${real?.registryVersion ?? registryInfo.version} · ${real?.modelCount ?? registryInfo.modelCount} models`],
        ["OS", `${machine.os} ${machine.osVersion} (${machine.arch})`],
        ["CPU", `${machine.cpuModel} · ${machine.physicalCores} cores`],
        ["Memory", `${machine.totalRamGb} GB${machine.unifiedMemory ? " unified" : ""}`],
        ["Benchmark", cal ? `${cal.modelTag} · ${Math.round(cal.genTokPerSec)} tok/s` : "not run"],
      ];
      return `### ModelFit diagnostics\n\n| | |\n|---|---|\n${rows
        .map(([k, v]) => `| ${k} | ${v} |`)
        .join("\n")}\n`;
    }
    case "registry_info":
    case "update_registry":
      await sleep(cmd === "update_registry" ? 600 : 0);
      return real
        ? { ...registryInfo, version: real.registryVersion, modelCount: real.modelCount }
        : registryInfo;
    case "benchmark_share": {
      // Mirrors the backend: skip the prefix when the name already carries it.
      const joinOnce = (prefix: string, name: string) =>
        name.toLowerCase().includes(prefix.toLowerCase()) ? name : `${prefix} ${name}`;
      const hw = args.hardware;
      const cal = args.calibration;
      const gpu = hw?.gpus?.[0];
      const fields = [
        { id: "chip", label: "CPU / chip", value: hw?.cpuModel ?? "" },
        {
          id: "ram",
          label: "Memory",
          value: `${Math.round(hw?.totalRamGb ?? 0)} GB${hw?.unifiedMemory ? " unified" : ""}`,
        },
        {
          id: "gpu",
          label: "GPU",
          value: gpu
            ? `${joinOnce(gpu.vendor, gpu.name)}${gpu.coreCount ? ` · ${gpu.coreCount} cores` : ""}`
            : "none detected",
        },
        { id: "accel", label: "Acceleration", value: (hw?.accelerations ?? []).join(", ") },
        {
          id: "os",
          label: "OS",
          value: `${joinOnce(hw?.os ?? "", hw?.osVersion ?? "")} (${hw?.arch ?? ""})`,
        },
        { id: "model", label: "Benchmarked model", value: cal?.modelTag ?? "" },
        { id: "gen_tps", label: "Generation tokens/sec", value: (cal?.genTokPerSec ?? 0).toFixed(1) },
        { id: "prompt_tps", label: "Prompt tokens/sec", value: (cal?.promptTokPerSec ?? 0).toFixed(1) },
        {
          id: "bandwidth",
          label: "Effective bandwidth (GB/s)",
          value: (cal?.effectiveBandwidthGbps ?? 0).toFixed(1),
        },
        { id: "versions", label: "App / registry", value: `0.1.0 · ${registryInfo.version}` },
      ];
      const q = fields.map((f) => `${f.id}=${encodeURIComponent(f.value)}`).join("&");
      return {
        fields,
        url: `https://github.com/docgraphapp/modelfit/issues/new?template=benchmark.yml&labels=benchmark&${q}`,
      };
    }
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
    // In the real shell the check is a signed-manifest fetch the browser
    // harness cannot do. ?scenario=update makes one available so the banner,
    // the progress bar and the restart prompt can be designed; without it the
    // harness reports "up to date", which is what the button shows most days.
    case "check_for_update":
      await sleep(700);
      return {
        available: scenario === "update" || scenario === "update-fail",
        currentVersion: "0.1.0",
        version: scenario?.startsWith("update") ? "0.2.0" : "",
        notes: scenario?.startsWith("update")
          ? "Discrete-GPU detection, faster startup."
          : null,
        date: scenario?.startsWith("update") ? new Date().toISOString() : null,
      } satisfies UpdateInfo;
    case "install_update": {
      const total = 12_400_000;
      for (let done = 0; done <= total; done += total / 25) {
        // ?scenario=update-fail breaks partway through, which is where a real
        // download fails: the banner has to recover from a half-drawn bar.
        if (scenario === "update-fail" && done > total / 2) {
          throw new Error("connection closed while downloading");
        }
        emit("updater://progress", { downloaded: Math.min(done, total), total });
        await sleep(120);
      }
      return null;
    }
    case "restart_app":
      // No process to replace in a browser tab; a reload is the closest thing.
      console.info("[mockTauri] restart_app");
      location.reload();
      return null;
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
    case "fit_window_height":
      // A browser tab can't resize itself; log the height the shell would use.
      console.info(`[mockTauri] fit_window_height ${args.height}`);
      return null;
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

// The shell announces an available update a few seconds after launch rather
// than in response to a call; ?scenario=update reproduces that timing so the
// banner is designed against the way it really arrives.
if (scenario?.startsWith("update")) {
  setTimeout(() => {
    emit("updater://available", {
      available: true,
      currentVersion: "0.1.0",
      version: "0.2.0",
      notes: "Discrete-GPU detection, faster startup.",
      date: new Date().toISOString(),
    } satisfies UpdateInfo);
  }, 2000);
}

console.info("[mockTauri] browser design harness active", { scenario, decorated });
