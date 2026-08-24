export interface GpuInfo {
  vendor: string;
  name: string;
  vramGb: number | null;
  coreCount: number | null;
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
  confidence: "high" | "medium";
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
