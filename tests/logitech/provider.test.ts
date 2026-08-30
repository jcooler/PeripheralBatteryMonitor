import { describe, expect, it, vi } from "vitest";

import {
  makeDeviceKey,
  type BatteryStatus,
  type DeviceDescriptor,
  type DeviceRef,
  type ProviderNotice,
} from "../../src/devices/types";
import {
  LogitechClient,
  type LogitechProviderSource,
} from "../../src/logitech/client";

const DIRECT_NATIVE_ID =
  "model:g502 x plus wireless gaming mouse|mouse";

function descriptor(
  nativeId: string,
  name: string,
  providerLabel: string
): DeviceDescriptor {
  return {
    key: makeDeviceKey("logitech", nativeId),
    provider: "logitech",
    providerLabel,
    nativeId,
    name,
    deviceType: nativeId.includes("keyboard") ? "Keyboard" : "Mouse",
    physicalId: `logitech-model:${nativeId}`,
  };
}

function status(
  ref: DeviceRef,
  state: BatteryStatus["state"],
  detail: string
): BatteryStatus {
  return {
    state,
    level:
      state === "connected"
        ? { kind: "percentage", value: 73 }
        : { kind: "unavailable" },
    charging: state === "connected" ? false : null,
    provider: "logitech",
    providerLabel: ref.providerLabel,
    observedAt: 123,
    detail,
  };
}

function source(
  devices: DeviceDescriptor[],
  read: (ref: DeviceRef) => BatteryStatus = (ref) =>
    status(ref, "connected", "source")
): LogitechProviderSource & {
  discover: ReturnType<typeof vi.fn>;
  readStatus: ReturnType<typeof vi.fn>;
  invalidateDiscovery: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
} {
  const notices: readonly ProviderNotice[] = [];
  return {
    discover: vi.fn(async () => devices),
    readStatus: vi.fn(async (ref: DeviceRef) => read(ref)),
    invalidateDiscovery: vi.fn(),
    discoveryNotices: vi.fn(() => notices),
    destroy: vi.fn(),
  };
}

describe("Logitech direct-first composite provider", () => {
  it("deduplicates the same native identity in favor of direct and retains unique G Hub devices", async () => {
    const directMouse = descriptor(
      DIRECT_NATIVE_ID,
      "G502 X PLUS Wireless Gaming Mouse",
      "Logitech"
    );
    const ghubMouse = descriptor(
      DIRECT_NATIVE_ID,
      "G502 X Plus",
      "Logitech G Hub"
    );
    const ghubKeyboard = descriptor(
      "model:g915|keyboard",
      "G915",
      "Logitech G Hub"
    );
    const direct = source([directMouse]);
    const ghub = source([ghubMouse, ghubKeyboard]);
    const provider = new LogitechClient({ directSource: direct, ghubClient: ghub });

    await expect(provider.discover()).resolves.toEqual([
      directMouse,
      { ...ghubKeyboard, providerLabel: "Logitech" },
    ]);
  });

  it("keeps direct discovery usable when optional G Hub discovery fails", async () => {
    const directMouse = descriptor(
      DIRECT_NATIVE_ID,
      "G502 X PLUS Wireless Gaming Mouse",
      "Logitech"
    );
    const direct = source([directMouse]);
    const ghub = source([]);
    ghub.discover.mockRejectedValueOnce(new Error("port 9010 unavailable"));
    const provider = new LogitechClient({ directSource: direct, ghubClient: ghub });

    await expect(provider.discover()).resolves.toEqual([directMouse]);
    expect(provider.discoveryNotices()).toEqual([]);
  });

  it("does not touch G Hub during a successful direct status read", async () => {
    const directMouse = descriptor(
      DIRECT_NATIVE_ID,
      "G502 X PLUS Wireless Gaming Mouse",
      "Logitech"
    );
    const direct = source([directMouse], (ref) =>
      status(ref, "connected", "Direct HID++")
    );
    const ghub = source([]);
    const provider = new LogitechClient({ directSource: direct, ghubClient: ghub });
    await provider.discover();
    ghub.readStatus.mockClear();

    await expect(provider.readStatus(directMouse)).resolves.toMatchObject({
      state: "connected",
      providerLabel: "Logitech",
      detail: "Direct HID++",
    });
    expect(ghub.readStatus).not.toHaveBeenCalled();
  });

  it("treats direct disconnected status as authoritative without G Hub fallback", async () => {
    const directMouse = descriptor(
      DIRECT_NATIVE_ID,
      "G502 X PLUS Wireless Gaming Mouse",
      "Logitech"
    );
    const direct = source([directMouse], (ref) =>
      status(ref, "disconnected", "Sleeping")
    );
    const ghub = source([directMouse]);
    const provider = new LogitechClient({ directSource: direct, ghubClient: ghub });
    await provider.discover();

    await expect(provider.readStatus(directMouse)).resolves.toMatchObject({
      state: "disconnected",
      detail: "Sleeping",
    });
    expect(ghub.readStatus).not.toHaveBeenCalled();
  });

  it("uses G Hub fallback only when a direct-backed identity is unavailable", async () => {
    const directMouse = descriptor(
      DIRECT_NATIVE_ID,
      "G502 X PLUS Wireless Gaming Mouse",
      "Logitech"
    );
    const direct = source([directMouse], (ref) =>
      status(ref, "unavailable", "Direct HID++ request timed out")
    );
    const ghub = source([directMouse], (ref) =>
      status(ref, "connected", "G Hub internal")
    );
    const provider = new LogitechClient({ directSource: direct, ghubClient: ghub });
    await provider.discover();

    await expect(provider.readStatus(directMouse)).resolves.toMatchObject({
      state: "connected",
      level: { kind: "percentage", value: 73 },
      providerLabel: "Logitech",
      detail: "G Hub fallback",
    });
    expect(ghub.readStatus).toHaveBeenCalledTimes(1);
  });

  it("reads a unique G Hub identity without attempting the direct source", async () => {
    const directMouse = descriptor(
      DIRECT_NATIVE_ID,
      "G502 X PLUS Wireless Gaming Mouse",
      "Logitech"
    );
    const keyboard = descriptor(
      "model:g915|keyboard",
      "G915",
      "Logitech G Hub"
    );
    const direct = source([directMouse]);
    const ghub = source([keyboard], (ref) =>
      status(ref, "connected", "G Hub internal")
    );
    const provider = new LogitechClient({ directSource: direct, ghubClient: ghub });
    const devices = await provider.discover();

    await expect(provider.readStatus(devices[1])).resolves.toMatchObject({
      detail: "G Hub fallback",
      providerLabel: "Logitech",
    });
    expect(direct.readStatus).not.toHaveBeenCalled();
  });

  it("fails provider discovery only when neither source can supply a device list", async () => {
    const direct = source([]);
    const ghub = source([]);
    direct.discover.mockRejectedValueOnce(new Error("HID unavailable"));
    ghub.discover.mockRejectedValueOnce(new Error("G Hub unavailable"));
    const provider = new LogitechClient({ directSource: direct, ghubClient: ghub });

    await expect(provider.discover()).rejects.toThrow(
      "Logitech discovery unavailable"
    );
  });

  it("invalidates and destroys both bounded sources", () => {
    const direct = source([]);
    const ghub = source([]);
    const provider = new LogitechClient({ directSource: direct, ghubClient: ghub });

    provider.invalidateDiscovery("refresh");
    provider.destroy();

    expect(direct.invalidateDiscovery).toHaveBeenCalledWith("refresh");
    expect(ghub.invalidateDiscovery).toHaveBeenCalledWith("refresh");
    expect(direct.destroy).toHaveBeenCalledTimes(1);
    expect(ghub.destroy).toHaveBeenCalledTimes(1);
  });
});
