import { describe, expect, it, vi } from "vitest";

import { makeDeviceKey, type DeviceRef } from "../../src/devices/types";
import {
  HidBatteryProvider,
  type HidAdapter,
  type HidDeviceInfo,
  type HidHandle,
} from "../../src/hid/client";

const SONY_VENDOR_ID = 0x054c;
const DUALSENSE_PRODUCT_ID = 0x0ce6;
const DUALSENSE_EDGE_PRODUCT_ID = 0x0df2;

function device(overrides: Partial<HidDeviceInfo> = {}): HidDeviceInfo {
  return {
    vendorId: SONY_VENDOR_ID,
    productId: DUALSENSE_PRODUCT_ID,
    usagePage: 0x01,
    usage: 0x05,
    serialNumber: "aa:bb:cc:dd:ee:ff",
    path: "usb-endpoint",
    product: "Wireless Controller",
    ...overrides,
  };
}

function reference(serial = "AA:BB:CC:DD:EE:FF"): DeviceRef {
  return {
    key: makeDeviceKey("hid", serial),
    provider: "hid",
    providerLabel: "HID",
    nativeId: serial,
    name: "Sony DualSense",
    deviceType: "Controller",
  };
}

function usbReport(status: number): Buffer {
  const report = Buffer.alloc(64);
  report[0] = 0x01;
  report[53] = status;
  return report;
}

function createHandle(readResult: Buffer | undefined = usbReport(0x05)) {
  const prohibited = {
    write: vi.fn(),
    sendFeatureReport: vi.fn(),
    getFeatureReport: vi.fn(),
  };
  const handle: HidHandle & typeof prohibited = {
    read: vi.fn().mockResolvedValue(readResult),
    close: vi.fn().mockResolvedValue(undefined),
    ...prohibited,
  };
  return handle;
}

function createProvider(devices: HidDeviceInfo[] = [device()]) {
  const handle = createHandle();
  const adapter: HidAdapter = {
    devicesAsync: vi.fn().mockResolvedValue(devices),
    open: vi.fn().mockResolvedValue(handle),
  };
  return {
    provider: new HidBatteryProvider({ adapter, now: () => 1_234 }),
    adapter,
    handle,
  };
}

describe("HidBatteryProvider discovery", () => {
  it("discovers only positively identified DualSense gamepad collections", async () => {
    const validEdge = device({
      productId: DUALSENSE_EDGE_PRODUCT_ID,
      serialNumber: "  edge-serial  ",
      path: "edge-endpoint",
    });
    const { provider, adapter } = createProvider([
      device(),
      validEdge,
      device({ vendorId: 0x1038, serialNumber: "arena-speaker" }),
      device({ productId: 0x09cc, serialNumber: "dualshock-4" }),
      device({ usage: 0x06, serialNumber: "sony-keyboard" }),
      device({ usagePage: 0x0c, serialNumber: "consumer-control" }),
      device({ serialNumber: undefined, path: "no-stable-identity" }),
      device({ serialNumber: "no-endpoint", path: undefined }),
    ]);

    await expect(provider.discover()).resolves.toEqual([
      {
        key: makeDeviceKey("hid", "AA:BB:CC:DD:EE:FF"),
        provider: "hid",
        providerLabel: "HID",
        nativeId: "AA:BB:CC:DD:EE:FF",
        name: "Sony DualSense",
        deviceType: "Controller",
        physicalId: "serial:AA:BB:CC:DD:EE:FF",
      },
      {
        key: makeDeviceKey("hid", "EDGE-SERIAL"),
        provider: "hid",
        providerLabel: "HID",
        nativeId: "EDGE-SERIAL",
        name: "Sony DualSense Edge",
        deviceType: "Controller",
        physicalId: "serial:EDGE-SERIAL",
      },
    ]);
    expect(adapter.devicesAsync).toHaveBeenCalledTimes(1);
    expect(adapter.open).not.toHaveBeenCalled();
  });

  it("deduplicates collections by serial without exposing or using a name/path identity", async () => {
    const { provider } = createProvider([
      device({ path: "z-gamepad" }),
      device({ path: "a-gamepad", product: "Same controller" }),
    ]);

    await expect(provider.discover()).resolves.toHaveLength(1);
  });

  it("keeps the current endpoint until fresh discovery confirms a transport transition", async () => {
    let enumerated = [device({ path: "usb-endpoint" })];
    const usbHandle = createHandle(usbReport(0x05));
    const btHandle = createHandle(usbReport(0x06));
    const adapter: HidAdapter = {
      devicesAsync: vi.fn(async () => enumerated),
      open: vi.fn(async (path) => {
        if (path === "usb-endpoint") return usbHandle;
        if (path === "bluetooth-endpoint") return btHandle;
        throw new Error(`unexpected endpoint ${path}`);
      }),
    };
    const provider = new HidBatteryProvider({ adapter, now: () => 1_234 });

    await provider.discover();
    enumerated = [device({ path: "bluetooth-endpoint" })];
    await provider.readStatus(reference());
    expect(adapter.open).toHaveBeenLastCalledWith("usb-endpoint");

    await provider.discover();
    await provider.readStatus(reference());
    expect(adapter.open).toHaveBeenLastCalledWith("bluetooth-endpoint");
  });

  it("never falls back to another controller when the configured serial is absent", async () => {
    const { provider, adapter } = createProvider([
      device({ serialNumber: "OTHER-SERIAL", path: "other-endpoint" }),
    ]);

    await provider.discover();
    await expect(provider.readStatus(reference())).resolves.toMatchObject({
      state: "disconnected",
      level: { kind: "unavailable" },
      provider: "hid",
    });
    expect(adapter.open).not.toHaveBeenCalled();
  });

  it("fails closed when the provider-qualified key and native identity disagree", async () => {
    const { provider, adapter } = createProvider();
    await provider.discover();
    const mismatched = {
      ...reference(),
      key: makeDeviceKey("hid", "OTHER-SERIAL"),
    };

    await expect(provider.readStatus(mismatched)).resolves.toMatchObject({
      state: "unavailable",
      detail: "Invalid HID identity",
    });
    expect(adapter.open).not.toHaveBeenCalled();
  });

  it("does not use discovery APIs during a cached status read", async () => {
    const { provider, adapter } = createProvider();
    await provider.discover();

    await provider.readStatus(reference());

    expect(adapter.devicesAsync).toHaveBeenCalledTimes(1);
    expect(adapter.open).toHaveBeenCalledTimes(1);
  });
});

describe("HidBatteryProvider status reads", () => {
  it("reads a valid USB input report and performs no HID output or feature operation", async () => {
    const { provider, handle } = createProvider();
    await provider.discover();

    await expect(provider.readStatus(reference())).resolves.toEqual({
      state: "connected",
      level: { kind: "percentage", value: 50 },
      charging: false,
      provider: "hid",
      providerLabel: "HID",
      observedAt: 1_234,
      detail: "Passive DualSense HID input report (10% increments)",
    });
    expect(handle.read).toHaveBeenCalledWith(1_000);
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(handle.write).not.toHaveBeenCalled();
    expect(handle.sendFeatureReport).not.toHaveBeenCalled();
    expect(handle.getFeatureReport).not.toHaveBeenCalled();
  });

  it("reports an open failure as disconnected and never opens any alternate endpoint", async () => {
    const { provider, adapter } = createProvider();
    vi.mocked(adapter.open).mockRejectedValueOnce(new Error("device removed"));
    await provider.discover();

    await expect(provider.readStatus(reference())).resolves.toMatchObject({
      state: "disconnected",
      level: { kind: "unavailable" },
      detail: "HID endpoint is no longer available: device removed",
    });
    expect(adapter.open).toHaveBeenCalledTimes(1);
    expect(adapter.open).toHaveBeenCalledWith("usb-endpoint");
  });

  it("reports invalid input without inventing a battery value and still closes once", async () => {
    const { provider, handle } = createProvider();
    vi.mocked(handle.read).mockResolvedValueOnce(usbReport(0x0b));
    await provider.discover();

    await expect(provider.readStatus(reference())).resolves.toMatchObject({
      state: "unavailable",
      level: { kind: "unavailable" },
      detail: "Invalid DualSense battery capacity",
    });
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("returns unavailable when no input arrives before the read timeout and closes once", async () => {
    const { provider, handle } = createProvider();
    vi.mocked(handle.read).mockResolvedValueOnce(undefined);
    await provider.discover();

    await expect(provider.readStatus(reference())).resolves.toMatchObject({
      state: "unavailable",
      level: { kind: "unavailable" },
      detail: "No DualSense input report was available before timeout",
    });
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("enforces a deadline even when the HID adapter never resolves its read", async () => {
    vi.useFakeTimers();
    try {
      const handle = createHandle();
      vi.mocked(handle.read).mockImplementationOnce(() => new Promise(() => {}));
      const adapter: HidAdapter = {
        devicesAsync: vi.fn().mockResolvedValue([device()]),
        open: vi.fn().mockResolvedValue(handle),
      };
      const provider = new HidBatteryProvider({
        adapter,
        now: () => 1_234,
        readTimeoutMs: 25,
      });
      await provider.discover();

      const status = provider.readStatus(reference());
      await vi.advanceTimersByTimeAsync(125);

      await expect(status).resolves.toMatchObject({
        state: "unavailable",
        level: { kind: "unavailable" },
        detail: "No DualSense input report was available before timeout",
      });
      expect(handle.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors AbortSignal during a read and closes the handle exactly once", async () => {
    const { provider, handle } = createProvider();
    vi.mocked(handle.read).mockImplementationOnce(() => new Promise(() => {}));
    await provider.discover();
    const controller = new AbortController();
    const status = provider.readStatus(reference(), controller.signal);

    controller.abort();

    await expect(status).rejects.toMatchObject({ name: "AbortError" });
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("classifies a read failure as disconnected and closes the handle once", async () => {
    const { provider, handle } = createProvider();
    vi.mocked(handle.read).mockRejectedValueOnce(new Error("endpoint removed"));
    await provider.discover();

    await expect(provider.readStatus(reference())).resolves.toMatchObject({
      state: "disconnected",
      level: { kind: "unavailable" },
      detail: "HID input failed: endpoint removed",
    });
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("invalidates cached endpoints deliberately", async () => {
    const { provider, adapter } = createProvider();
    await provider.discover();

    provider.invalidateDiscovery("manual refresh");

    await expect(provider.readStatus(reference())).resolves.toMatchObject({
      state: "unavailable",
      level: { kind: "unavailable" },
      detail: "HID discovery has not completed",
    });
    expect(adapter.open).not.toHaveBeenCalled();
  });
});
