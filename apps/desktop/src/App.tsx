import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { HardwareInfo } from "./types";

const ACCEL_LABELS: Record<string, string> = {
  cpu: "CPU",
  metal: "Metal",
  cuda: "CUDA",
  rocm: "ROCm",
  vulkan: "Vulkan",
};

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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<HardwareInfo>("detect_hardware")
      .then(setHw)
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

          <section className="mt-6 rounded-2xl border border-dashed border-neutral-200 p-6 text-center text-sm text-neutral-400 dark:border-neutral-800">
            Model recommendations arrive in the next milestone.
          </section>
        </>
      )}
    </div>
  );
}
