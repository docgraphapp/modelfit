export interface GpuInfo {
  vendor: string;
  name: string;
  vramGb: number | null;
  coreCount: number | null;
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
