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

export interface ProviderNotice {
  provider: ProviderId;
  kind: "ambiguous" | "recovered";
  message: string;
  deviceKey?: string;
}

export interface DeviceDescriptor extends DeviceRef {
  /** Runtime-only aliases used for exact migration; never persisted or sent to the inspector. */
  transientNativeIds?: readonly string[];
}

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
  discoveryNotices?(): readonly ProviderNotice[];
}

export interface ProviderDiscoveryError {
  provider: ProviderId;
  providerLabel: string;
  message: string;
}

const TRUSTED_PROVIDER_LABELS: Record<ProviderId, string> = {
  steelseries: "SteelSeries GG",
  logitech: "Logitech G Hub",
  xinput: "XInput",
  windows: "Windows Bluetooth",
  "windows-gamepad": "Windows Gamepad",
  hid: "HID",
};

/** Fixed discovery category for Inspector-safe provider failures. */
export function safeProviderDiscoveryError(
  provider: ProviderId
): ProviderDiscoveryError {
  const providerLabel = TRUSTED_PROVIDER_LABELS[provider];
  return {
    provider,
    providerLabel,
    message: `${providerLabel} unavailable`,
  };
}

export interface DiscoveryResult {
  devices: DeviceDescriptor[];
  errors: ProviderDiscoveryError[];
  notices?: ProviderNotice[];
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
