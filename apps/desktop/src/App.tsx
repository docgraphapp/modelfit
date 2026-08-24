import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Assessment, HardwareInfo, Recommendations } from "./types";

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

function fmtCtx(n: number) {
  return `${n / 1024}k`;
}

function PickCard({
  tag,
  a,
  highlight,
}: {
  tag: string;
  a: Assessment;
  highlight?: boolean;
}) {
  return (
    <div
      className={`flex-1 rounded-2xl border p-5 ${
        highlight
          ? "border-emerald-300 bg-emerald-50/60 dark:border-emerald-800 dark:bg-emerald-950/40"
          : "border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
      }`}
    >
      <div className="flex items-baseline justify-between">
        <span
          className={`text-[11px] font-semibold uppercase tracking-wider ${
            highlight ? "text-emerald-600 dark:text-emerald-400" : "text-neutral-400"
          }`}
        >
          {tag}
        </span>
        <span className="text-sm font-semibold tabular-nums">{Math.round(a.score)}/100</span>
      </div>
      <div className="mt-2 text-[15px] font-semibold leading-snug">{a.name}</div>
      <div className="text-xs text-neutral-400">{a.quant}</div>
      <div className="mt-3 space-y-1 text-[13px] text-neutral-500 dark:text-neutral-400">
        <div>{FIT_WORDS[a.fit]} · ~{a.estMemoryGb} GB</div>
        <div>
          ~{Math.round(a.estTokPerSec)} tok/s
          {a.confidence === "medium" && <span className="text-neutral-400"> (est.)</span>}
        </div>
      </div>
    </div>
  );
}

function Spec({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
        {label}
      </div>
      <div className="mt-0.5 text-[15px] font-medium">{value}</div>
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
    <div className="inline-flex rounded-full bg-neutral-100 p-0.5 dark:bg-neutral-800">
      {options.map((o) => (
        <button
          key={o.id}
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
    return <span className="text-xs text-neutral-400">{a.excludedReason}</span>;
  }
  const styles =
    a.fit === "comfortable"
      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
      : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles}`}>
      {FIT_WORDS[a.fit]}
    </span>
  );
}

function HardwareCard({
  hw,
  onEdited,
}: {
  hw: HardwareInfo;
  onEdited: (hw: HardwareInfo) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [ram, setRam] = useState(String(hw.totalRamGb));
  const [vram, setVram] = useState(String(hw.gpus[0]?.vramGb ?? ""));

  const apply = () => {
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

  return (
    <section className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">{hw.cpuModel}</h2>
        <div className="flex items-baseline gap-3">
          <span className="text-xs text-neutral-400">{hw.osVersion}</span>
          <button
            onClick={() => (editing ? apply() : setEditing(true))}
            className="text-xs font-medium text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
          >
            {editing ? "Done" : "Edit"}
          </button>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
        {editing ? (
          <div>
            <div className="text-xs uppercase tracking-wide text-neutral-400">Memory (GB)</div>
            <input
              value={ram}
              onChange={(e) => setRam(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && apply()}
              className="mt-0.5 w-24 rounded-lg border border-neutral-300 bg-transparent px-2 py-0.5 text-[15px] font-medium outline-none focus:border-neutral-500 dark:border-neutral-700"
            />
          </div>
        ) : (
          <Spec
            label="Memory"
            value={`${hw.totalRamGb} GB${hw.unifiedMemory ? " unified" : ""}`}
          />
        )}
        <Spec label="CPU cores" value={String(hw.physicalCores)} />
        {hw.gpus[0] && (
          <Spec
            label="GPU"
            value={
              hw.gpus[0].coreCount
                ? `${hw.gpus[0].vendor} · ${hw.gpus[0].coreCount} cores`
                : hw.gpus[0].name
            }
          />
        )}
        {hw.gpus[0] && !hw.unifiedMemory && (
          editing ? (
            <div>
              <div className="text-xs uppercase tracking-wide text-neutral-400">VRAM (GB)</div>
              <input
                value={vram}
                onChange={(e) => setVram(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && apply()}
                className="mt-0.5 w-24 rounded-lg border border-neutral-300 bg-transparent px-2 py-0.5 text-[15px] font-medium outline-none focus:border-neutral-500 dark:border-neutral-700"
              />
            </div>
          ) : (
            hw.gpus[0].vramGb != null && (
              <Spec label="VRAM" value={`${hw.gpus[0].vramGb} GB`} />
            )
          )
        )}
        <Spec label="Free disk" value={`${Math.round(hw.diskAvailableGb)} GB`} />
      </div>

      <div className="mt-5 flex gap-2">
        {hw.accelerations.map((a) => (
          <span
            key={a}
            className="rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
          >
            {ACCEL_LABELS[a] ?? a}
          </span>
        ))}
      </div>
    </section>
  );
}

export default function App() {
  const [hw, setHw] = useState<HardwareInfo | null>(null);
  const [recs, setRecs] = useState<Recommendations | null>(null);
  const [objective, setObjective] = useState<Objective>("overall");
  const [contextLength, setContextLength] = useState(8192);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recompute = useCallback(
    (hardware: HardwareInfo, obj: Objective, ctx: number) => {
      invoke<Recommendations>("get_recommendations", {
        hardware,
        request: { objective: obj, contextLength: ctx },
      })
        .then(setRecs)
        .catch((e) => setError(String(e)));
    },
    [],
  );

  useEffect(() => {
    invoke<HardwareInfo>("detect_hardware")
      .then((detected) => {
        setHw(detected);
        recompute(detected, "overall", 8192);
      })
      .catch((e) => setError(String(e)));
  }, [recompute]);

  const update = (obj: Objective, ctx: number, hardware?: HardwareInfo) => {
    const machine = hardware ?? hw;
    setObjective(obj);
    setContextLength(ctx);
    if (hardware) setHw(hardware);
    if (machine) recompute(machine, obj, ctx);
  };

  const picks = recs?.best
    ? [
        { tag: "Best", a: recs.best, highlight: true },
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
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col px-8 py-10">
      <header className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight">ModelFit</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Find the best AI model for your machine.
        </p>
      </header>

      {error && (
        <div className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          Something went wrong: {error}
        </div>
      )}

      {!hw && !error && (
        <div className="text-sm text-neutral-400">Detecting your machine…</div>
      )}

      {hw && (
        <>
          <HardwareCard hw={hw} onEdited={(next) => update(objective, contextLength, next)} />

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <Segmented
              options={OBJECTIVES}
              value={objective}
              onChange={(o) => update(o, contextLength)}
            />
            <label className="flex items-center gap-2 text-[13px] text-neutral-500 dark:text-neutral-400">
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

          {recs && !recs.best && (
            <section className="mt-6 rounded-2xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900">
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
            </section>
          )}

          {recs && recs.best && (
            <section className="mt-6">
              <div className="mb-3 flex items-baseline justify-between">
                <h3 className="text-sm font-semibold text-neutral-500 dark:text-neutral-400">
                  Your machine can comfortably run
                </h3>
                <span className="text-xs text-neutral-400">
                  {recs.usableMemoryGb} GB usable for models
                </span>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row">
                {picks.map((p) => (
                  <PickCard key={p.tag} tag={p.tag} a={p.a} highlight={p.highlight} />
                ))}
              </div>
            </section>
          )}

          {recs && (
            <section className="mt-6">
              <button
                onClick={() => setShowAll(!showAll)}
                className="text-[13px] font-medium text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
              >
                {showAll ? "Hide all models" : `Show all ${recs.all.length} models`}
              </button>
              {showAll && (
                <div className="mt-3 overflow-hidden rounded-2xl border border-neutral-200 dark:border-neutral-800">
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
                          className={`border-b border-neutral-100 last:border-0 dark:border-neutral-800/60 ${
                            a.excludedReason ? "opacity-55" : ""
                          }`}
                        >
                          <td className="px-4 py-2.5">
                            <span className="font-medium">{a.name}</span>{" "}
                            <span className="text-neutral-400">{a.quant}</span>
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums">
                            {a.estMemoryGb} GB
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums">
                            ~{Math.round(a.estTokPerSec)} t/s
                          </td>
                          <td className="px-3 py-2.5 text-right font-medium tabular-nums">
                            {a.excludedReason ? "—" : Math.round(a.score)}
                          </td>
                          <td className="max-w-[220px] px-4 py-2.5">
                            <FitBadge a={a} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          <p className="mt-4 text-xs text-neutral-400">
            Speeds are estimates from your chip's memory bandwidth — a real
            benchmark arrives in a later milestone.
          </p>
        </>
      )}
    </div>
  );
}
