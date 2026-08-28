import type { GHubDevice } from "./client";

export interface LogitechIdentityCandidate {
  device: GHubDevice;
  nativeId: string;
  physicalId?: string;
  kind: "serial" | "model";
}

export interface LogitechIdentityResult {
  candidates: LogitechIdentityCandidate[];
  ambiguousModelFingerprints: string[];
}

export function normalizeIdentityText(value: string): string {
  return value.trim().normalize("NFC").replace(/\s+/gu, " ").toLowerCase();
}

export function mapLogitechDeviceType(type: string | undefined): string {
  const normalized = normalizeIdentityText(type ?? "");
  if (normalized.includes("mouse")) return "Mouse";
  if (normalized.includes("keyboard")) return "Keyboard";
  if (normalized.includes("headset")) return "Headset";
  return type?.trim() || "Device";
}

export function makeLogitechModelIdentity(
  displayName: string,
  deviceType: string | undefined
): { nativeId: string; physicalId: string } | null {
  const trimmedName = displayName.trim();
  if (!trimmedName) return null;
  const name = normalizeIdentityText(trimmedName);
  const type = normalizeIdentityText(mapLogitechDeviceType(deviceType));
  const nativeId = `model:${name}|${type}`;
  return {
    nativeId,
    physicalId: `logitech-model:${nativeId}`,
  };
}

export function identifyLogitechDevices(
  devices: readonly GHubDevice[]
): LogitechIdentityResult {
  const validDevices = devices.filter(isBatteryCapableEndpoint);
  const modelFingerprints = new Map<GHubDevice, string>();
  const modelCounts = new Map<string, number>();

  for (const device of validDevices) {
    if (serialIdentity(device)) continue;
    const fingerprint = modelFingerprint(device);
    if (!fingerprint) continue;
    modelFingerprints.set(device, fingerprint);
    modelCounts.set(fingerprint, (modelCounts.get(fingerprint) ?? 0) + 1);
  }

  const candidates: LogitechIdentityCandidate[] = [];
  for (const device of validDevices) {
    const serial = serialIdentity(device);
    if (serial) {
      candidates.push({
        device,
        nativeId: `serial:${serial}`,
        physicalId: `serial:${serial}`,
        kind: "serial",
      });
      continue;
    }

    const fingerprint = modelFingerprints.get(device);
    if (!fingerprint) continue;
    if (modelCounts.get(fingerprint) !== 1) continue;
    candidates.push({
      device,
      nativeId: fingerprint,
      physicalId: `logitech-model:${fingerprint}`,
      kind: "model",
    });
  }

  return {
    candidates,
    ambiguousModelFingerprints: [...modelCounts].flatMap(
      ([fingerprint, count]) => (count > 1 ? [fingerprint] : [])
    ),
  };
}

function isBatteryCapableEndpoint(device: GHubDevice): boolean {
  return (
    typeof device.id === "string" &&
    Boolean(device.id.trim()) &&
    device.capabilities?.hasBatteryStatus === true
  );
}

function serialIdentity(device: GHubDevice): string | null {
  for (const value of [
    device.serialNumber,
    device.serial,
    device.deviceSerialNumber,
  ]) {
    if (typeof value === "string" && value.trim()) {
      return normalizeIdentityText(value);
    }
  }
  return null;
}

function modelFingerprint(device: GHubDevice): string | null {
  const identity = makeLogitechModelIdentity(
    device.extendedDisplayName ?? "",
    device.deviceType
  );
  return identity?.nativeId ?? null;
}
