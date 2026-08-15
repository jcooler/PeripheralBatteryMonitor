export type ProviderId =
  | "steelseries"
  | "logitech"
  | "xinput"
  | "windows"
  | "windows-gamepad"
  | "hid";

export interface DeviceRef {
  key: string;
  provider: ProviderId;
  providerLabel: string;
  nativeId: string;
  name: string;
  deviceType: string;
  /** Cross-provider identity only when derived from a serial/container identity. */
  physicalId?: string;
}

export interface DeviceDescriptor extends DeviceRef {}

export type BatteryLevel =
  | { kind: "percentage"; value: number }
  | { kind: "qualitative"; value: "empty" | "low" | "medium" | "full" }
  | { kind: "unavailable" };

export interface BatteryStatus {
  state: "connected" | "disconnected" | "unavailable";
  level: BatteryLevel;
  /** Null means the source cannot report charging state. */
  charging: boolean | null;
  provider: ProviderId;
  providerLabel: string;
  observedAt: number;
  detail?: string;
}

export interface DeviceProvider {
  readonly id: ProviderId;
  readonly label: string;
  discover(signal?: AbortSignal): Promise<DeviceDescriptor[]>;
  readStatus(ref: DeviceRef, signal?: AbortSignal): Promise<BatteryStatus>;
  invalidateDiscovery?(reason?: string): void;
}

export interface ProviderDiscoveryError {
  provider: ProviderId;
  providerLabel: string;
  message: string;
}

export interface DiscoveryResult {
  devices: DeviceDescriptor[];
  errors: ProviderDiscoveryError[];
  refreshedAt: number;
}

export function makeDeviceKey(provider: ProviderId, nativeId: string): string {
  return `${provider}:${encodeURIComponent(nativeId)}`;
}

export function unavailableStatus(
  ref: DeviceRef,
  observedAt: number,
  detail: string
): BatteryStatus {
  return {
    state: "unavailable",
    level: { kind: "unavailable" },
    charging: null,
    provider: ref.provider,
    providerLabel: ref.providerLabel,
    observedAt,
    detail,
  };
}
