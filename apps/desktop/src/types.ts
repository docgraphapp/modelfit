export interface GpuInfo {
  vendor: string;
  name: string;
  vramGb: number | null;
  coreCount: number | null;
}

/** How well a number is known, most certain first. Mirrors the engine enum. */
export type Confidence =
  | "measuredLocal"
  | "community"
  | "calibrated"
  | "estimated"
  | "unknown";

/**
 * A number the app shows, with how well it is known and what it assumes.
 * `basis` is written for a tooltip: it names the inputs behind the value, so
 * the user can check it rather than take it on faith.
 */
export interface Estimate {
  value: number;
  confidence: Confidence;
  basis: string;
}

export interface QuantRung {
  quant: string;
  memory: Estimate;
  speed: Estimate;
  fit: "comfortable" | "tight" | "toobig";
  ollamaTag: string | null;
}

export interface Assessment {
  modelId: string;
  name: string;
  quant: string;
  ollamaTag: string | null;
  memory: Estimate;
  speed: Estimate;
  /** Seconds to the first token. Only present once prefill was measured. */
  timeToFirstTokenS: Estimate | null;
  fit: "comfortable" | "tight" | "toobig";
  /** Absent for a discovered model nothing has rated. */
  quality: number | null;
  /**
   * Whether this model may be offered as a pick. False for the discovered
   * tier — listed with real memory and speed, never recommended, because
   * "best for you" is a claim only a curated score can carry.
   */
  recommendable: boolean;
  qualitySource: string | null;
  score: number;
  excludedReason: string | null;
  /// Every quantization of this model, smallest first, assessed on this machine.
  ladder: QuantRung[];
}

export interface Recommendations {
  best: Assessment | null;
  safe: Assessment | null;
  fast: Assessment | null;
  all: Assessment[];
  usableMemoryGb: number;
  /** The one input the calibration benchmark improves, so it is reported once. */
  bandwidth: Estimate;
}

export interface RuntimeStatus {
  running: boolean;
  version: string | null;
  installedTags: string[];
}

export interface Calibration {
  modelTag: string;
  genTokPerSec: number;
  promptTokPerSec: number;
  effectiveBandwidthGbps: number;
  /** prompt tok/s × active params (B). Null when the runtime gave no timing. */
  prefillCapacity: number | null;
}

export interface RegistryInfo {
  version: string;
  modelCount: number;
  source: "bundled" | "updated";
  added: number | null;
}

export interface PullProgress {
  tag: string;
  status: string;
  total: number | null;
  completed: number | null;
}

export interface HardwareInfo {
  os: string;
  osVersion: string;
  arch: string;
  cpuModel: string;
  physicalCores: number;
  logicalCores: number;
  totalRamGb: number;
  availableRamGb: number;
  diskAvailableGb: number;
  unifiedMemory: boolean;
  gpus: GpuInfo[];
  accelerations: string[];
}

export interface ShareField {
  id: string;
  label: string;
  value: string;
}

export interface BenchmarkShare {
  fields: ShareField[];
  url: string;
}
