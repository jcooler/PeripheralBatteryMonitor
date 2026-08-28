import {
  makeDeviceKey,
  unavailableStatus,
  type BatteryStatus,
  type DeviceDescriptor,
  type DeviceProvider,
  type DeviceRef,
  type ProviderNotice,
} from "../devices/types";
import {
  GHubClient,
  type LogitechDiagnosticSink,
} from "./ghub-client";
import { DirectLogitechSource } from "./hidpp-source";

const PROVIDER_ID = "logitech" as const;
const PROVIDER_LABEL = "Logitech";

export interface LogitechProviderSource {
  discover(signal?: AbortSignal): Promise<DeviceDescriptor[]>;
  readStatus(ref: DeviceRef, signal?: AbortSignal): Promise<BatteryStatus>;
  invalidateDiscovery?(reason?: string): void;
  discoveryNotices?(): readonly ProviderNotice[];
  supports?(ref: DeviceRef): boolean;
  destroy?(): void;
}

export interface LogitechClientOptions {
  directSource?: LogitechProviderSource;
  ghubClient?: LogitechProviderSource;
  diagnosticSink?: LogitechDiagnosticSink;
  now?: () => number;
}

interface SourceCoverage {
  readonly direct: boolean;
  readonly ghub: boolean;
  readonly generation: number;
}

export class LogitechClient implements DeviceProvider {
  readonly id = PROVIDER_ID;
  readonly label = PROVIDER_LABEL;

  private readonly directSource: LogitechProviderSource;
  private readonly ghubClient: LogitechProviderSource;
  private readonly now: () => number;
  private coverage = new Map<string, SourceCoverage>();
  private notices: readonly ProviderNotice[] = [];
  private discoveryGeneration = 0;
  private destroyed = false;

  constructor(options: LogitechClientOptions = {}) {
    this.directSource = options.directSource ?? new DirectLogitechSource();
    this.ghubClient =
      options.ghubClient ??
      new GHubClient({
        diagnosticSink: options.diagnosticSink,
        reconnect: false,
      });
    this.now = options.now ?? Date.now;
  }

  async discover(signal?: AbortSignal): Promise<DeviceDescriptor[]> {
    if (this.destroyed) throw new Error("Logitech provider stopped");
    const generation = ++this.discoveryGeneration;
    const [directResult, ghubResult] = await Promise.allSettled([
      this.directSource.discover(signal),
      this.ghubClient.discover(signal),
    ]);
    if (generation !== this.discoveryGeneration) {
      throw new Error("Logitech discovery was invalidated");
    }
    if (directResult.status === "rejected" && ghubResult.status === "rejected") {
      this.coverage.clear();
      this.notices = [];
      throw new Error("Logitech discovery unavailable");
    }

    const directDevices =
      directResult.status === "fulfilled" ? directResult.value : [];
    const ghubDevices =
      ghubResult.status === "fulfilled" ? ghubResult.value : [];
    const nextCoverage = new Map<string, SourceCoverage>();
    for (const device of directDevices) {
      nextCoverage.set(device.nativeId, {
        direct: true,
        ghub: false,
        generation,
      });
    }
    for (const device of ghubDevices) {
      const existing = nextCoverage.get(device.nativeId);
      nextCoverage.set(device.nativeId, {
        direct: existing?.direct ?? false,
        ghub: true,
        generation,
      });
    }
    this.coverage = nextCoverage;
    this.notices = Object.freeze([
      ...(directResult.status === "fulfilled"
        ? this.directSource.discoveryNotices?.() ?? []
        : []),
      ...(ghubResult.status === "fulfilled"
        ? this.ghubClient.discoveryNotices?.() ?? []
        : []),
    ]);

    const merged = new Map<string, DeviceDescriptor>();
    for (const device of directDevices) {
      merged.set(device.nativeId, trustedDescriptor(device));
    }
    for (const device of ghubDevices) {
      if (!merged.has(device.nativeId)) {
        merged.set(device.nativeId, trustedDescriptor(device));
      }
    }
    return [...merged.values()];
  }

  discoveryNotices(): readonly ProviderNotice[] {
    return Object.freeze(this.notices.map((notice) => Object.freeze({ ...notice })));
  }

  async readStatus(
    ref: DeviceRef,
    signal?: AbortSignal
  ): Promise<BatteryStatus> {
    if (
      ref.provider !== PROVIDER_ID ||
      ref.key !== makeDeviceKey(PROVIDER_ID, ref.nativeId)
    ) {
      return unavailableStatus(ref, this.now(), "Invalid Logitech identity");
    }
    const coverage = this.coverage.get(ref.nativeId);
    const directSupported =
      coverage?.direct === true || this.directSource.supports?.(ref) === true;
    if (directSupported) {
      const directStatus = await this.directSource.readStatus(ref, signal);
      if (directStatus.state !== "unavailable") {
        return trustedStatus(directStatus, directStatus.detail);
      }
      const fallback = await this.readGHubFallback(ref, signal);
      return fallback ?? trustedStatus(directStatus, directStatus.detail);
    }

    if (coverage?.ghub) {
      const fallback = await this.ghubClient.readStatus(ref, signal);
      return trustedStatus(fallback, "G Hub fallback");
    }
    return unavailableStatus(
      { ...ref, providerLabel: PROVIDER_LABEL },
      this.now(),
      "Logitech device not found; refresh discovery"
    );
  }

  invalidateDiscovery(reason?: string): void {
    this.discoveryGeneration += 1;
    this.coverage.clear();
    this.notices = [];
    this.directSource.invalidateDiscovery?.(reason);
    this.ghubClient.invalidateDiscovery?.(reason);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.discoveryGeneration += 1;
    this.coverage.clear();
    this.notices = [];
    this.directSource.destroy?.();
    this.ghubClient.destroy?.();
  }

  private async readGHubFallback(
    ref: DeviceRef,
    signal?: AbortSignal
  ): Promise<BatteryStatus | null> {
    let coverage = this.coverage.get(ref.nativeId);
    if (!coverage?.ghub) {
      try {
        const devices = await this.ghubClient.discover(signal);
        if (!devices.some((device) => device.nativeId === ref.nativeId)) {
          return null;
        }
        coverage = {
          direct: coverage?.direct ?? false,
          ghub: true,
          generation: this.discoveryGeneration,
        };
        this.coverage.set(ref.nativeId, coverage);
      } catch {
        return null;
      }
    }
    const fallback = await this.ghubClient.readStatus(ref, signal);
    return trustedStatus(fallback, "G Hub fallback");
  }
}

function trustedDescriptor(device: DeviceDescriptor): DeviceDescriptor {
  return { ...device, providerLabel: PROVIDER_LABEL };
}

function trustedStatus(
  status: BatteryStatus,
  detail: string | undefined
): BatteryStatus {
  return {
    ...status,
    provider: PROVIDER_ID,
    providerLabel: PROVIDER_LABEL,
    ...(detail === undefined ? {} : { detail }),
  };
}
