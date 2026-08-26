export interface GpuInfo {
  vendor: string;
  name: string;
  vramGb: number | null;
  coreCount: number | null;
}

export interface QuantOption {
  quant: string;
  estMemoryGb: number;
  estTokPerSec: number;
  ollamaTag: string | null;
}

export interface Assessment {
  modelId: string;
  name: string;
  quant: string;
  ollamaTag: string | null;
  estMemoryGb: number;
  estTokPerSec: number;
  fit: "comfortable" | "tight" | "toobig";
  quality: number;
  score: number;
  excludedReason: string | null;
  confidence: "high" | "medium" | "measured";
  /// Richer quantizations this machine can also hold.
  alsoFits: QuantOption[];
}

export interface Recommendations {
  best: Assessment | null;
  safe: Assessment | null;
  fast: Assessment | null;
  all: Assessment[];
  usableMemoryGb: number;
  bandwidthGbps: number;
  bandwidthMeasured: boolean;
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
