import { describe, expect, it, vi } from "vitest";

import { makeDeviceKey, type DeviceRef } from "../../src/devices/types";
import type { HidppHandle } from "../../src/logitech/hidpp-protocol";
import {
  DirectLogitechSource,
  type LogitechHidAdapter,
  type LogitechHidDeviceInfo,
} from "../../src/logitech/hidpp-source";

const NATIVE_ID = "model:g502 x plus wireless gaming mouse|mouse";

function device(
  overrides: Partial<LogitechHidDeviceInfo> = {}
): LogitechHidDeviceInfo {
  return {
    vendorId: 0x046d,
    productId: 0xc547,
    path: "g502-hidpp-long",
    product: "G502 X PLUS Wireless Gaming Mouse",
    release: 0x4401,
    interface: 2,
    usagePage: 0xff00,
    usage: 0x02,
    ...overrides,
  };
}

function reference(): DeviceRef {
  return {
    key: makeDeviceKey("logitech", NATIVE_ID),
    provider: "logitech",
    providerLabel: "Logitech",
    nativeId: NATIVE_ID,
    name: "G502 X PLUS Wireless Gaming Mouse",
    deviceType: "Mouse",
  };
}

function replies(): Buffer[] {
  return [
    Buffer.from([
      0x11, 0x01, 0x00, 0x18, 0x04, 0x02, 0x5a, ...Array(13).fill(0),
    ]),
    Buffer.from([
      0x11, 0x01, 0x00, 0x08, 0x05, 0x00, 0x00, ...Array(13).fill(0),
    ]),
    Buffer.from([
      0x11, 0x01, 0x05, 0x08, 73, 70, 0, ...Array(13).fill(0),
    ]),
  ];
}

function handle(reads = replies()): HidppHandle {
  return {
    write: vi.fn(async (data: Buffer) => data.length),
    read: vi.fn(async () => reads.shift()),
    close: vi.fn(async () => undefined),
  };
}

function setup(devices: LogitechHidDeviceInfo[] = [device()]) {
  const openedHandle = handle();
  const adapter: LogitechHidAdapter = {
    devicesAsync: vi.fn(async () => devices),
    open: vi.fn(async () => openedHandle),
  };
  return {
    source: new DirectLogitechSource({ adapter, now: () => 1_234 }),
    adapter,
    openedHandle,
  };
}

describe("DirectLogitechSource allowlisted discovery", () => {
  it("discovers exactly one G502 X Plus HID++ long-report endpoint with the existing model identity", async () => {
    const { source, adapter } = setup();

    await expect(source.discover()).resolves.toEqual([
      {
        key: makeDeviceKey("logitech", NATIVE_ID),
        provider: "logitech",
        providerLabel: "Logitech",
        nativeId: NATIVE_ID,
        name: "G502 X PLUS Wireless Gaming Mouse",
        deviceType: "Mouse",
        physicalId: `logitech-model:${NATIVE_ID}`,
      },
    ]);
    expect(adapter.open).not.toHaveBeenCalled();
  });

  it.each([
    ["generic mouse", { usagePage: 0x01, usage: 0x02 }],
    ["keyboard", { usagePage: 0x01, usage: 0x06 }],
    ["consumer control", { usagePage: 0x0c, usage: 0x01 }],
    ["short-report vendor collection", { usagePage: 0xff00, usage: 0x01 }],
    ["unknown product", { productId: 0xc548 }],
    ["unknown vendor", { vendorId: 0x1038 }],
    ["missing path", { path: undefined }],
  ])("omits the %s endpoint", async (_name, overrides) => {
    const { source } = setup([device(overrides)]);

    await expect(source.discover()).resolves.toEqual([]);
  });

  it("fails closed when enumeration exposes duplicate long-report endpoints", async () => {
    const { source } = setup([
      device({ path: "g502-a" }),
      device({ path: "g502-b" }),
    ]);

    await expect(source.discover()).resolves.toEqual([]);
  });
});

describe("DirectLogitechSource bounded status lifecycle", () => {
  it("opens non-exclusively, negotiates HID++ 2.0, resolves 0x1000, reads battery, and closes", async () => {
    const { source, adapter, openedHandle } = setup();
    await source.discover();

    await expect(source.readStatus(reference())).resolves.toEqual({
      state: "connected",
      level: { kind: "percentage", value: 73 },
      charging: false,
      provider: "logitech",
      providerLabel: "Logitech",
      observedAt: 1_234,
      detail: "Direct HID++",
    });
    expect(adapter.open).toHaveBeenCalledWith("g502-hidpp-long", {
      nonExclusive: true,
    });
    expect(openedHandle.close).toHaveBeenCalledTimes(1);
    expect(openedHandle.write).toHaveBeenCalledTimes(3);
  });

  it("reports a sleeping or absent endpoint as disconnected without opening another device", async () => {
    const { source, adapter } = setup([]);
    await source.discover();

    await expect(source.readStatus(reference())).resolves.toMatchObject({
      state: "disconnected",
      level: { kind: "unavailable" },
      detail: "G502 endpoint absent from the latest direct discovery",
    });
    expect(adapter.open).not.toHaveBeenCalled();
  });

  it("rejects a provider-qualified identity mismatch before opening", async () => {
    const { source, adapter } = setup();
    await source.discover();

    await expect(
      source.readStatus({ ...reference(), nativeId: "model:other|mouse" })
    ).resolves.toMatchObject({
      state: "unavailable",
      detail: "Invalid Logitech identity",
    });
    expect(adapter.open).not.toHaveBeenCalled();
  });

  it("returns unavailable and closes for unsupported HID++ protocol", async () => {
    const unsupported = handle([
      Buffer.from([
        0x11, 0x01, 0x00, 0x18, 0x01, 0x00, 0x5a,
        ...Array(13).fill(0),
      ]),
    ]);
    const adapter: LogitechHidAdapter = {
      devicesAsync: vi.fn(async () => [device()]),
      open: vi.fn(async () => unsupported),
    };
    const source = new DirectLogitechSource({ adapter, now: () => 1_234 });
    await source.discover();

    await expect(source.readStatus(reference())).resolves.toMatchObject({
      state: "unavailable",
      detail: "Direct HID++ protocol is unsupported",
    });
    expect(unsupported.close).toHaveBeenCalledTimes(1);
    expect(unsupported.write).toHaveBeenCalledTimes(1);
  });

  it("returns unavailable and closes when feature 0x1000 is missing", async () => {
    const missingFeature = handle([
      replies()[0],
      Buffer.from([
        0x11, 0x01, 0x00, 0x08, 0x00, 0x00, 0x00,
        ...Array(13).fill(0),
      ]),
      Buffer.from([
        0x11, 0x01, 0x00, 0x08, 0x00, 0x00, 0x00,
        ...Array(13).fill(0),
      ]),
    ]);
    const adapter: LogitechHidAdapter = {
      devicesAsync: vi.fn(async () => [device()]),
      open: vi.fn(async () => missingFeature),
    };
    const source = new DirectLogitechSource({ adapter, now: () => 1_234 });
    await source.discover();

    await expect(source.readStatus(reference())).resolves.toMatchObject({
      state: "unavailable",
      detail: "Direct HID++ battery feature is unavailable",
    });
    expect(missingFeature.close).toHaveBeenCalledTimes(1);
  });

  it("uses the named read-only 0x1004 status operation when 0x1000 is absent", async () => {
    const unifiedBattery = handle([
      replies()[0],
      Buffer.from([
        0x11, 0x01, 0x00, 0x08, 0x00, 0x00, 0x00,
        ...Array(13).fill(0),
      ]),
      Buffer.from([
        0x11, 0x01, 0x00, 0x08, 0x06, 0x00, 0x00,
        ...Array(13).fill(0),
      ]),
      Buffer.from([
        0x11, 0x01, 0x06, 0x18, 68, 60, 1, ...Array(13).fill(0),
      ]),
    ]);
    const adapter: LogitechHidAdapter = {
      devicesAsync: vi.fn(async () => [device()]),
      open: vi.fn(async () => unifiedBattery),
    };
    const source = new DirectLogitechSource({ adapter, now: () => 1_234 });
    await source.discover();

    await expect(source.readStatus(reference())).resolves.toMatchObject({
      state: "connected",
      level: { kind: "percentage", value: 68 },
      charging: true,
      detail: "Direct HID++",
    });
    expect(unifiedBattery.close).toHaveBeenCalledTimes(1);
    expect(unifiedBattery.write).toHaveBeenCalledTimes(4);
  });

  it("reports open failure as disconnected without exposing the HID path", async () => {
    const { source, adapter } = setup();
    vi.mocked(adapter.open).mockRejectedValueOnce(
      new Error("cannot open \\?\\hid#private-path")
    );
    await source.discover();

    await expect(source.readStatus(reference())).resolves.toMatchObject({
      state: "disconnected",
      detail: "Direct HID++ endpoint could not be opened",
    });
  });

  it("returns unavailable and closes when a protocol request times out", async () => {
    const timedOut = handle([]);
    const adapter: LogitechHidAdapter = {
      devicesAsync: vi.fn(async () => [device()]),
      open: vi.fn(async () => timedOut),
    };
    const source = new DirectLogitechSource({
      adapter,
      now: () => 1_234,
      requestTimeoutMs: 5,
    });
    await source.discover();

    await expect(source.readStatus(reference())).resolves.toMatchObject({
      state: "unavailable",
      detail: "Direct HID++ request timed out",
    });
    expect(timedOut.close).toHaveBeenCalledTimes(1);
  });

  it("honors cancellation and closes an already-open handle exactly once", async () => {
    const pending = handle([]);
    vi.mocked(pending.read).mockImplementationOnce(() => new Promise(() => {}));
    const adapter: LogitechHidAdapter = {
      devicesAsync: vi.fn(async () => [device()]),
      open: vi.fn(async () => pending),
    };
    const source = new DirectLogitechSource({ adapter });
    await source.discover();
    const controller = new AbortController();
    const result = source.readStatus(reference(), controller.signal);

    await vi.waitFor(() => expect(adapter.open).toHaveBeenCalledTimes(1));

    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(pending.close).toHaveBeenCalledTimes(1);
  });

  it("does not open after invalidation while a read waits behind the endpoint queue", async () => {
    let releaseFirst!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = handle();
    vi.mocked(first.read).mockImplementationOnce(async () => {
      await firstRead;
      return replies()[0];
    });
    const second = handle();
    const adapter: LogitechHidAdapter = {
      devicesAsync: vi.fn(async () => [device()]),
      open: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
    };
    const source = new DirectLogitechSource({ adapter });
    await source.discover();
    const active = source.readStatus(reference());
    await vi.waitFor(() => expect(adapter.open).toHaveBeenCalledTimes(1));
    const queued = source.readStatus(reference());

    source.invalidateDiscovery();
    releaseFirst();

    await active;
    await expect(queued).resolves.toMatchObject({
      state: "unavailable",
      detail: "Direct HID++ discovery was invalidated",
    });
    expect(adapter.open).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent reads for the one receiver endpoint", async () => {
    let activeOpens = 0;
    let maxActiveOpens = 0;
    const adapter: LogitechHidAdapter = {
      devicesAsync: vi.fn(async () => [device()]),
      open: vi.fn(async () => {
        activeOpens += 1;
        maxActiveOpens = Math.max(maxActiveOpens, activeOpens);
        const opened = handle();
        const originalClose = opened.close;
        opened.close = vi.fn(async () => {
          await originalClose();
          activeOpens -= 1;
        });
        return opened;
      }),
    };
    const source = new DirectLogitechSource({ adapter });
    await source.discover();

    await Promise.all([
      source.readStatus(reference()),
      source.readStatus(reference()),
    ]);

    expect(maxActiveOpens).toBe(1);
    expect(adapter.open).toHaveBeenCalledTimes(2);
  });
});
