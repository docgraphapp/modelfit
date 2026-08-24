import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Assessment, HardwareInfo, Recommendations } from "./types";

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

export default function App() {
  const [hw, setHw] = useState<HardwareInfo | null>(null);
  const [recs, setRecs] = useState<Recommendations | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<HardwareInfo>("detect_hardware")
      .then(setHw)
      .catch((e) => setError(String(e)));
    invoke<Recommendations>("get_recommendations", { request: null })
      .then(setRecs)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col px-8 py-10">
      <header className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight">ModelFit</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Find the best AI model for your machine.
        </p>
      </header>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          Could not detect hardware: {error}
        </div>
      )}

      {!hw && !error && (
        <div className="text-sm text-neutral-400">Detecting your machine…</div>
      )}

      {hw && (
        <>
          <section className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-semibold">{hw.cpuModel}</h2>
              <span className="text-xs text-neutral-400">{hw.osVersion}</span>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
              <Spec
                label="Memory"
                value={`${hw.totalRamGb} GB${hw.unifiedMemory ? " unified" : ""}`}
              />
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
              {hw.gpus[0]?.vramGb != null && !hw.unifiedMemory && (
                <Spec label="VRAM" value={`${hw.gpus[0].vramGb} GB`} />
              )}
              <Spec label="Free disk" value={`${Math.round(hw.diskAvailableGb)} GB`} />
              <Spec label="Available RAM" value={`${hw.availableRamGb} GB`} />
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
                <PickCard tag="Best" a={recs.best} highlight />
                {recs.safe && recs.safe.modelId !== recs.best.modelId && (
                  <PickCard tag="Safe" a={recs.safe} />
                )}
                {recs.fast &&
                  recs.fast.modelId !== recs.best.modelId &&
                  recs.fast.modelId !== recs.safe?.modelId && (
                    <PickCard tag="Fast" a={recs.fast} />
                  )}
              </div>
              <p className="mt-3 text-xs text-neutral-400">
                Speeds are estimates from your chip's memory bandwidth — a real
                benchmark arrives in a later milestone.
              </p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
