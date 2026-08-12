import {
  makeDeviceKey,
  type DeviceRef,
  type ProviderId,
} from "../devices/types";

export interface PersistedBatterySettings {
  [key: string]: unknown;
  schemaVersion?: number;
  selectedDevices?: readonly unknown[];
  pollInterval?: number;
  showPercentage?: boolean;
  showDeviceType?: boolean;
  showDeviceName?: boolean;
  showStatusText?: boolean;
  deviceTypeFontSize?: number;
  backgroundColor?: string;
  deviceId?: number;
  deviceName?: string;
  deviceBrand?: string;
  logiDeviceId?: string;
  xboxIndex?: number;
}

export interface NormalizedBatterySettings {
  selectedDevices: DeviceRef[];
  pollInterval: number;
  showPercentage: boolean;
  showDeviceType: boolean;
  showDeviceName: boolean;
  showStatusText: boolean;
  deviceTypeFontSize: number;
  backgroundColor: string;
}

export interface ParsedBatterySettings {
  settings: NormalizedBatterySettings;
  migrated: boolean;
}

const PROVIDER_LABELS: Record<ProviderId, string> = {
  steelseries: "SteelSeries GG",
  logitech: "Logitech G Hub",
  xinput: "XInput",
  windows: "Windows Bluetooth",
  hid: "HID",
};

const PROVIDERS = new Set<ProviderId>(
  Object.keys(PROVIDER_LABELS) as ProviderId[]
);

export function parseBatterySettings(
  value: PersistedBatterySettings | unknown
): ParsedBatterySettings {
  const raw = isRecord(value) ? value : {};
  const orderedList = Array.isArray(raw.selectedDevices)
    ? raw.selectedDevices
    : null;
  const hasOrderedList = orderedList !== null;
  const selectedDevices = orderedList
    ? parseSelectedDevices(orderedList)
    : migrateLegacyDevice(raw);
  const migrated =
    (hasOrderedList && raw.schemaVersion !== 2) ||
    (!hasOrderedList && selectedDevices.length > 0);

  return {
    migrated,
    settings: {
      selectedDevices,
      pollInterval: clampNumber(raw.pollInterval, 10, 3_600, 30),
      showPercentage: raw.showPercentage !== false,
      showDeviceType: raw.showDeviceType === true,
      showDeviceName: raw.showDeviceName === true,
      showStatusText: raw.showStatusText === true,
      deviceTypeFontSize: clampNumber(
        raw.deviceTypeFontSize,
        8,
        32,
        13
      ),
      backgroundColor:
        typeof raw.backgroundColor === "string" &&
        /^#[0-9a-f]{6}$/i.test(raw.backgroundColor)
          ? raw.backgroundColor
          : "#0d1117",
    },
  };
}

export function toPersistedDevice(device: DeviceRef): Record<string, string> {
  return {
    key: makeDeviceKey(device.provider, device.nativeId),
    provider: device.provider,
    providerLabel: PROVIDER_LABELS[device.provider],
    nativeId: device.nativeId,
    name: device.name,
    deviceType: device.deviceType,
    ...(device.physicalId ? { physicalId: device.physicalId } : {}),
  };
}

export function providerLabel(provider: ProviderId): string {
  return PROVIDER_LABELS[provider];
}

export function prepareMigratedDevices(
  selectedDevices: readonly DeviceRef[],
  discoveredDevices: readonly DeviceRef[]
): { selectedDevices: DeviceRef[]; safeToPersist: boolean } {
  const discoveredByKey = new Map(
    discoveredDevices.map((device) => [device.key, device])
  );
  let safeToPersist = true;
  const prepared = selectedDevices.map((device) => {
    const canonical = discoveredByKey.get(device.key);
    if (canonical) {
      if (
        device.provider === "steelseries" &&
        device.deviceType === "Device" &&
        device.name !== canonical.name
      ) {
        safeToPersist = false;
        return device;
      }
      return canonical;
    }
    if (device.provider === "steelseries" && device.deviceType === "Device") {
      safeToPersist = false;
    }
    return device;
  });
  return { selectedDevices: prepared, safeToPersist };
}

function parseSelectedDevices(values: unknown[]): DeviceRef[] {
  const result: DeviceRef[] = [];
  const seen = new Set<string>();
  const seenPhysicalIds = new Set<string>();
  for (const value of values) {
    if (!isRecord(value) || !isProvider(value.provider)) continue;
    if (typeof value.nativeId !== "string" || !value.nativeId.trim()) continue;
    const nativeId = value.nativeId.trim();
    const key = makeDeviceKey(value.provider, nativeId);
    if (seen.has(key)) continue;
    const physicalId =
      typeof value.physicalId === "string" && value.physicalId.trim()
        ? value.physicalId.trim()
        : undefined;
    if (physicalId && seenPhysicalIds.has(physicalId)) continue;
    seen.add(key);
    if (physicalId) seenPhysicalIds.add(physicalId);
    result.push({
      key,
      provider: value.provider,
      providerLabel: PROVIDER_LABELS[value.provider],
      nativeId,
      name:
        typeof value.name === "string" && value.name.trim()
          ? value.name.trim()
          : "Unknown device",
      deviceType:
        typeof value.deviceType === "string" && value.deviceType.trim()
          ? value.deviceType.trim()
          : "Device",
      ...(physicalId ? { physicalId } : {}),
    });
  }
  return result;
}

function migrateLegacyDevice(raw: Record<string, unknown>): DeviceRef[] {
  const rawName =
    typeof raw.deviceName === "string" && raw.deviceName.trim()
      ? raw.deviceName.trim()
      : "Configured device";

  if (
    raw.deviceBrand === "steelseries" &&
    typeof raw.deviceId === "number" &&
    Number.isSafeInteger(raw.deviceId) &&
    raw.deviceId >= 0
  ) {
    return [
      legacyRef(
        "steelseries",
        String(raw.deviceId),
        stripLegacyPrefix(rawName, "steelseries")
      ),
    ];
  }
  if (
    raw.deviceBrand === "logitech" &&
    typeof raw.logiDeviceId === "string" &&
    raw.logiDeviceId.trim()
  ) {
    return [
      legacyRef(
        "logitech",
        `session:${raw.logiDeviceId.trim()}`,
        stripLegacyPrefix(rawName, "logitech")
      ),
    ];
  }
  if (
    raw.deviceBrand === "xbox" &&
    typeof raw.xboxIndex === "number" &&
    Number.isInteger(raw.xboxIndex) &&
    raw.xboxIndex >= 0 &&
    raw.xboxIndex <= 3
  ) {
    return [
      legacyRef(
        "xinput",
        `slot:${raw.xboxIndex}`,
        stripLegacyPrefix(rawName, "xinput"),
        "Controller"
      ),
    ];
  }
  return [];
}

function stripLegacyPrefix(name: string, provider: ProviderId): string {
  const pattern =
    provider === "steelseries"
      ? /^\[SS\]\s*/
      : provider === "logitech"
        ? /^\[Logi\]\s*/
        : provider === "xinput"
          ? /^\[Xbox\]\s*/
          : null;
  return pattern ? name.replace(pattern, "") || "Configured device" : name;
}

function legacyRef(
  provider: ProviderId,
  nativeId: string,
  name: string,
  deviceType = "Device"
): DeviceRef {
  return {
    key: makeDeviceKey(provider, nativeId),
    provider,
    providerLabel: PROVIDER_LABELS[provider],
    nativeId,
    name,
    deviceType,
  };
}

function isProvider(value: unknown): value is ProviderId {
  return typeof value === "string" && PROVIDERS.has(value as ProviderId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clampNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}
