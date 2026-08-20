import {
  makeDeviceKey,
  type DeviceDescriptor,
  type DeviceRef,
  type ProviderId,
} from "../devices/types";
import {
  mapLogitechDeviceType,
  normalizeIdentityText,
} from "../logitech/identity";

export interface PersistedBatterySettings {
  [key: string]: unknown;
  schemaVersion?: number;
  selectedDevices?: readonly unknown[];
  activeDeviceKey?: string;
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
  activeDeviceKey: string | null;
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

export interface PreparedSettingsMigration {
  selectedDevices: DeviceRef[];
  activeDeviceKey: string | null;
  safeToPersist: boolean;
  changed: boolean;
}

const PROVIDER_LABELS: Record<ProviderId, string> = {
  steelseries: "SteelSeries GG",
  logitech: "Logitech G Hub",
  xinput: "XInput",
  windows: "Windows Bluetooth",
  "windows-gamepad": "Windows Gamepad",
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
    (hasOrderedList &&
      (raw.schemaVersion !== 2 ||
        selectedDevices.some(isLegacyLogitechSelection))) ||
    (!hasOrderedList && selectedDevices.length > 0);

  return {
    migrated,
    settings: {
      selectedDevices,
      activeDeviceKey:
        typeof raw.activeDeviceKey === "string" &&
        selectedDevices.some((device) => device.key === raw.activeDeviceKey)
          ? raw.activeDeviceKey
          : null,
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
  discoveredDevices: readonly DeviceDescriptor[],
  activeDeviceKey: string | null = null
): PreparedSettingsMigration {
  const discoveredByKey = new Map(
    discoveredDevices.map((device) => [device.key, device])
  );
  let safeToPersist = true;
  let changed = false;
  const translatedKeys = new Map<string, string>();
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
      if (device.provider === "steelseries" && device.deviceType === "Device") {
        const preparedCanonical = toDeviceRef(canonical);
        if (!sameDeviceRef(device, preparedCanonical)) changed = true;
        return preparedCanonical;
      }
      return device;
    }
    if (isLegacyLogitechSelection(device)) {
      const migrated = findExactLegacyLogitechMatch(
        device,
        discoveredDevices
      );
      if (!migrated) {
        safeToPersist = false;
        return device;
      }
      const preparedCanonical = toDeviceRef(migrated);
      translatedKeys.set(device.key, preparedCanonical.key);
      changed = true;
      return preparedCanonical;
    }
    if (device.provider === "steelseries" && device.deviceType === "Device") {
      safeToPersist = false;
    }
    return device;
  });
  const translatedActiveDeviceKey = activeDeviceKey
    ? translatedKeys.get(activeDeviceKey) ?? activeDeviceKey
    : null;
  if (translatedActiveDeviceKey !== activeDeviceKey) changed = true;
  return {
    selectedDevices: prepared,
    activeDeviceKey: translatedActiveDeviceKey,
    safeToPersist,
    changed,
  };
}

function findExactLegacyLogitechMatch(
  saved: DeviceRef,
  discoveredDevices: readonly DeviceDescriptor[]
): DeviceDescriptor | null {
  const logitechDevices = discoveredDevices.filter(
    (device) => device.provider === "logitech"
  );
  const aliasMatches = logitechDevices.filter((device) =>
    device.transientNativeIds?.includes(saved.nativeId)
  );
  if (aliasMatches.length === 1) return aliasMatches[0];
  if (aliasMatches.length > 1) return null;

  const nameMatches = logitechDevices.filter(
    (device) =>
      normalizedIdentityEquals(saved.name, device.name) &&
      (normalizeIdentityText(saved.deviceType) === "device" ||
        normalizedIdentityEquals(
          mapLogitechDeviceType(saved.deviceType),
          mapLogitechDeviceType(device.deviceType)
        ))
  );
  return nameMatches.length === 1 ? nameMatches[0] : null;
}

function normalizedIdentityEquals(left: string, right: string): boolean {
  return normalizeIdentityText(left) === normalizeIdentityText(right);
}

function isLegacyLogitechSelection(device: DeviceRef): boolean {
  return (
    device.provider === "logitech" && device.nativeId.startsWith("session:")
  );
}

function toDeviceRef(device: DeviceDescriptor): DeviceRef {
  return {
    key: device.key,
    provider: device.provider,
    providerLabel: device.providerLabel,
    nativeId: device.nativeId,
    name: device.name,
    deviceType: device.deviceType,
    ...(device.physicalId ? { physicalId: device.physicalId } : {}),
  };
}

function sameDeviceRef(left: DeviceRef, right: DeviceRef): boolean {
  return (
    left.key === right.key &&
    left.provider === right.provider &&
    left.providerLabel === right.providerLabel &&
    left.nativeId === right.nativeId &&
    left.name === right.name &&
    left.deviceType === right.deviceType &&
    left.physicalId === right.physicalId
  );
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
