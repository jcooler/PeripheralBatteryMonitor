import { describe, expect, it, vi } from "vitest";

import { DeviceCatalog } from "../../src/devices/catalog";
import {
  makeDeviceKey,
  type BatteryStatus,
  type DeviceDescriptor,
  type DeviceProvider,
  type DeviceRef,
  type ProviderNotice,
} from "../../src/devices/types";
import { deferred } from "../helpers/deferred";

function descriptor(
  provider: DeviceProvider["id"],
  nativeId: string,
  name: string,
  physicalId?: string
): DeviceDescriptor {
  return {
    key: makeDeviceKey(provider, nativeId),
    provider,
    providerLabel: provider === "steelseries" ? "SteelSeries GG" : "Windows Bluetooth",
    nativeId,
    name,
    deviceType: "Mouse",
    physicalId,
  };
}

function percentageStatus(ref: DeviceRef, value: number): BatteryStatus {
  return {
    state: "connected",
    level: { kind: "percentage", value },
    charging: false,
    provider: ref.provider,
    providerLabel: ref.providerLabel,
    observedAt: 1_000,
  };
}

function provider(
  id: DeviceProvider["id"],
  devices: DeviceDescriptor[]
): DeviceProvider & {
  discover: ReturnType<typeof vi.fn<DeviceProvider["discover"]>>;
  readStatus: ReturnType<typeof vi.fn<DeviceProvider["readStatus"]>>;
} {
  return {
    id,
    label: devices[0]?.providerLabel ?? id,
    discover: vi.fn(async () => devices),
    readStatus: vi.fn(async (ref) => percentageStatus(ref, 75)),
  };
}

describe("provider-qualified device identity", () => {
  it("keeps equal native IDs from different providers distinct", () => {
    expect(makeDeviceKey("steelseries", "7")).toBe("steelseries:7");
    expect(makeDeviceKey("windows", "7")).toBe("windows:7");
  });

  it("does not merge different devices merely because their names match", async () => {
    const ss = provider("steelseries", [descriptor("steelseries", "1", "Rival Wireless")]);
    const windows = provider("windows", [descriptor("windows", "BTH-44", "Rival Wireless")]);
    const gamepad = provider("windows-gamepad", [
      descriptor("windows-gamepad", "raw-1", "Rival Wireless"),
    ]);
    const catalog = new DeviceCatalog([ss, windows, gamepad], { now: () => 0 });

    const result = await catalog.discover();

    expect(result.devices.map((device) => device.key)).toEqual([
      "steelseries:1",
      "windows:BTH-44",
      "windows-gamepad:raw-1",
    ]);
  });

  it("deduplicates only an exact reliable physical identity", async () => {
    const ss = provider("steelseries", [
      descriptor("steelseries", "1", "Aerox", "usb:1038:185a:ABC"),
    ]);
    const windows = provider("windows", [
      descriptor("windows", "USB-2", "Aerox Mouse", "usb:1038:185a:ABC"),
    ]);
    const catalog = new DeviceCatalog([ss, windows], { now: () => 0 });

    const result = await catalog.discover();

    expect(result.devices).toHaveLength(1);
    expect(result.devices[0].key).toBe("windows:USB-2");
  });
});

describe("discovery cache", () => {
  it("returns a stable empty notice list when providers report no notices", async () => {
    const ss = provider("steelseries", [descriptor("steelseries", "1", "Aerox")]);
    const catalog = new DeviceCatalog([ss], { now: () => 0 });

    await expect(catalog.discover()).resolves.toMatchObject({ notices: [] });
  });

  it("captures provider notices as soon as that provider discovery resolves", async () => {
    const recovered: ProviderNotice = {
      provider: "logitech",
      kind: "recovered",
      message: "G502 X Plus reconnected through G Hub",
      deviceKey: "logitech:model%3Ag502%20x%20plus%7Cmouse",
    };
    let currentNotices: readonly ProviderNotice[] = [recovered];
    const logitech = provider("logitech", [
      descriptor("logitech", "model:g502 x plus|mouse", "G502 X Plus"),
    ]);
    logitech.discoveryNotices = vi.fn(() => currentNotices);
    const pendingWindows = deferred<DeviceDescriptor[]>();
    const windows = provider("windows", []);
    windows.discover.mockImplementation(() => pendingWindows.promise);
    const catalog = new DeviceCatalog([logitech, windows], { now: () => 0 });

    const discovery = catalog.discover();
    await vi.waitFor(() =>
      expect(logitech.discoveryNotices).toHaveBeenCalledTimes(1)
    );
    currentNotices = [];
    pendingWindows.resolve([]);

    await expect(discovery).resolves.toMatchObject({ notices: [recovered] });
  });

  it("replaces sensitive provider exceptions with fixed discovery categories", async () => {
    const failures = [
      ["steelseries", "serial:SS-SECRET-001"],
      ["logitech", "dev00000042"],
      ["hid", "\\\\?\\HID#VID_054C&PID_0CE6#SECRET"],
      ["windows", "BTHENUM\\DEV_AABBCCDDEEFF"],
      ["windows-gamepad", "stderr: GetGamepads failed with private output"],
      ["xinput", '{"payload": malformed'],
    ] as const;
    const failingProviders = failures.map(([id, message]) => {
      const failing = provider(id, []);
      failing.discover.mockRejectedValue(new Error(message));
      return failing;
    });
    const catalog = new DeviceCatalog(failingProviders, { now: () => 42 });

    const result = await catalog.discover();

    expect(result.errors).toEqual([
      { provider: "steelseries", providerLabel: "SteelSeries GG", message: "SteelSeries GG unavailable" },
      { provider: "logitech", providerLabel: "Logitech", message: "Logitech unavailable" },
      { provider: "hid", providerLabel: "HID", message: "HID unavailable" },
      { provider: "windows", providerLabel: "Windows Bluetooth", message: "Windows Bluetooth unavailable" },
      { provider: "windows-gamepad", providerLabel: "Windows Gamepad", message: "Windows Gamepad unavailable" },
      { provider: "xinput", providerLabel: "XInput", message: "XInput unavailable" },
    ]);
    const serialized = JSON.stringify(result.errors);
    for (const sensitive of [
      "SS-SECRET-001",
      "dev00000042",
      "VID_054C",
      "AABBCCDDEEFF",
      "stderr",
      "payload",
    ]) {
      expect(serialized).not.toContain(sensitive);
    }
  });

  it("reuses a provider snapshot until TTL expiry and refreshes when forced", async () => {
    let now = 10_000;
    const ss = provider("steelseries", [descriptor("steelseries", "1", "Aerox")]);
    const catalog = new DeviceCatalog([ss], { discoveryTtlMs: 5_000, now: () => now });

    await catalog.discover();
    now += 4_999;
    await catalog.discover();
    expect(ss.discover).toHaveBeenCalledTimes(1);

    await catalog.discover({ force: true });
    expect(ss.discover).toHaveBeenCalledTimes(2);

    now += 5_001;
    await catalog.discover();
    expect(ss.discover).toHaveBeenCalledTimes(3);
  });

  it("coalesces concurrent discovery for the same provider", async () => {
    const pending = deferred<DeviceDescriptor[]>();
    const ss = provider("steelseries", []);
    ss.discover.mockImplementation(() => pending.promise);
    const catalog = new DeviceCatalog([ss], { now: () => 0 });

    const first = catalog.discover();
    const second = catalog.discover();
    expect(ss.discover).toHaveBeenCalledTimes(1);

    pending.resolve([descriptor("steelseries", "1", "Aerox")]);
    await expect(first).resolves.toMatchObject({ devices: [{ key: "steelseries:1" }] });
    await expect(second).resolves.toMatchObject({ devices: [{ key: "steelseries:1" }] });
  });

  it("invalidates one expensive provider deliberately", async () => {
    const ss = provider("steelseries", [descriptor("steelseries", "1", "Aerox")]);
    const windows = provider("windows", [descriptor("windows", "2", "Keyboard")]);
    const catalog = new DeviceCatalog([ss, windows], { now: () => 0 });

    await catalog.discover();
    catalog.invalidateDiscovery("windows");
    await catalog.discover();

    expect(ss.discover).toHaveBeenCalledTimes(1);
    expect(windows.discover).toHaveBeenCalledTimes(2);
  });

  it("does not commit a discovery result invalidated while it was in flight", async () => {
    const oldRequest = deferred<DeviceDescriptor[]>();
    const newRequest = deferred<DeviceDescriptor[]>();
    const windows = provider("windows", []);
    windows.discover
      .mockImplementationOnce(() => oldRequest.promise)
      .mockImplementationOnce(() => newRequest.promise);
    const catalog = new DeviceCatalog([windows], { now: () => 0 });

    const stale = catalog.discover();
    catalog.invalidateDiscovery("windows");
    const current = catalog.discover();
    newRequest.resolve([descriptor("windows", "new", "Current")]);
    oldRequest.resolve([descriptor("windows", "old", "Stale")]);

    await expect(current).resolves.toMatchObject({
      devices: [{ key: "windows:new" }],
      errors: [],
    });
    await expect(stale).resolves.toMatchObject({
      devices: [],
      errors: [{ message: "Windows Bluetooth unavailable" }],
    });
    await expect(catalog.discover()).resolves.toMatchObject({
      devices: [{ key: "windows:new" }],
    });
    expect(windows.discover).toHaveBeenCalledTimes(2);
  });
});

describe("status dispatch", () => {
  it("reads the exact provider without running discovery", async () => {
    const selected = descriptor("windows", "BTH-1", "Keyboard");
    const ss = provider("steelseries", []);
    const windows = provider("windows", [selected]);
    const catalog = new DeviceCatalog([ss, windows], { now: () => 0 });

    const status = await catalog.readStatus(selected);

    expect(status.level).toEqual({ kind: "percentage", value: 75 });
    expect(windows.readStatus).toHaveBeenCalledWith(selected, undefined);
    expect(ss.readStatus).not.toHaveBeenCalled();
    expect(ss.discover).not.toHaveBeenCalled();
    expect(windows.discover).not.toHaveBeenCalled();
  });

  it("returns honest unavailable status for an unknown provider instead of falling back", async () => {
    const ss = provider("steelseries", [descriptor("steelseries", "1", "Aerox")]);
    const catalog = new DeviceCatalog([ss], { now: () => 42 });
    const missing: DeviceRef = {
      key: "hid:serial-9",
      provider: "hid",
      providerLabel: "HID",
      nativeId: "serial-9",
      name: "DualSense",
      deviceType: "Controller",
    };

    const status = await catalog.readStatus(missing);

    expect(status).toEqual({
      state: "unavailable",
      level: { kind: "unavailable" },
      charging: null,
      provider: "hid",
      providerLabel: "HID",
      observedAt: 42,
      detail: "Provider unavailable",
    });
    expect(ss.readStatus).not.toHaveBeenCalled();
  });
});
