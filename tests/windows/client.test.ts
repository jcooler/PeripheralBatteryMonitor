import { describe, expect, it, vi } from "vitest";

import { makeDeviceKey, type DeviceRef } from "../../src/devices/types";
import {
  WindowsBluetoothProvider,
  type PowerShellExecutor,
} from "../../src/windows/client";
import { deferred } from "../helpers/deferred";

const WINDOWS = "win32" as NodeJS.Platform;

function createProvider(
  output: string,
  now = 1_000
): {
  provider: WindowsBluetoothProvider;
  execute: ReturnType<typeof vi.fn<PowerShellExecutor>>;
} {
  const execute = vi.fn<PowerShellExecutor>().mockResolvedValue(output);
  return {
    provider: new WindowsBluetoothProvider({
      execute,
      platform: WINDOWS,
      now: () => now,
    }),
    execute,
  };
}

describe("WindowsBluetoothProvider", () => {
  it("discovers only valid battery records using stable canonical PnP identity", async () => {
    const { provider, execute } = createProvider(
      JSON.stringify([
        {
          deviceId: "bthledevice\\dev_001122334455\\8&abc",
          name: "MX Master 3S",
          batteryLevel: 64,
          connected: true,
          containerId: "{8F4B5068-915A-4C65-B46E-957D6957102D}",
        },
        {
          deviceId: "BTHLEDEVICE\\DEV_BAD\\1",
          name: "Impossible Battery",
          batteryLevel: 101,
          connected: true,
        },
        {
          deviceId: "BTHLEDEVICE\\DEV_TEXT\\1",
          name: "Text Battery",
          batteryLevel: "50",
          connected: true,
        },
      ])
    );

    await expect(provider.discover()).resolves.toEqual([
      {
        key: makeDeviceKey(
          "windows",
          "BTHLEDEVICE\\DEV_001122334455\\8&ABC"
        ),
        provider: "windows",
        providerLabel: "Windows Bluetooth",
        nativeId: "BTHLEDEVICE\\DEV_001122334455\\8&ABC",
        name: "MX Master 3S",
        deviceType: "Mouse",
        physicalId: "container:8f4b5068-915a-4c65-b46e-957d6957102d",
      },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toContain("Get-CimInstance");
    expect(execute.mock.calls[0]?.[0]).toContain("GetDeviceProperties");
    expect(execute.mock.calls[0]?.[0]).toContain("batteryLevel = $battery");
    expect(execute.mock.calls[0]?.[0]).not.toContain(
      "batteryLevel = [int]$battery"
    );
    expect(execute.mock.calls[0]?.[0]).toContain("connected = $connected");
    expect(execute.mock.calls[0]?.[0]).not.toContain(
      "connected = if ($null -eq $connected)"
    );
  });

  it("reads the cached status without launching another PowerShell scan", async () => {
    const { provider, execute } = createProvider(
      JSON.stringify({
        deviceId: "BTHENUM\\DEV_A\\1",
        name: "Bluetooth Keyboard",
        batteryLevel: 42,
        connected: true,
      }),
      12_345
    );
    const [device] = await provider.discover();

    for (let index = 0; index < 10; index += 1) {
      await expect(provider.readStatus(device)).resolves.toEqual({
        state: "connected",
        level: { kind: "percentage", value: 42 },
        charging: null,
        provider: "windows",
        providerLabel: "Windows Bluetooth",
        observedAt: 12_345,
        detail: "Cached Windows PnP battery property",
      });
    }
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to a different device with the same name", async () => {
    const { provider } = createProvider(
      JSON.stringify([
        {
          deviceId: "BTHLE\\DEV_ONE\\1",
          name: "Wireless Controller",
          batteryLevel: 80,
          connected: true,
        },
        {
          deviceId: "BTHLE\\DEV_TWO\\1",
          name: "Wireless Controller",
          batteryLevel: 20,
          connected: true,
        },
      ]),
      500
    );
    await provider.discover();
    const missing: DeviceRef = {
      key: makeDeviceKey("windows", "BTHLE\\DEV_MISSING\\1"),
      provider: "windows",
      providerLabel: "Windows Bluetooth",
      nativeId: "BTHLE\\DEV_MISSING\\1",
      name: "Wireless Controller",
      deviceType: "Controller",
    };

    await expect(provider.readStatus(missing)).resolves.toEqual({
      state: "disconnected",
      level: { kind: "unavailable" },
      charging: null,
      provider: "windows",
      providerLabel: "Windows Bluetooth",
      observedAt: 500,
      detail: "Device absent from the latest Windows Bluetooth discovery",
    });
  });

  it("fails closed when the key and native PnP identity disagree", async () => {
    const { provider } = createProvider(
      JSON.stringify([
        {
          deviceId: "BTHLE\\DEV_ONE\\1",
          name: "Mouse One",
          batteryLevel: 80,
          connected: true,
        },
        {
          deviceId: "BTHLE\\DEV_TWO\\1",
          name: "Mouse Two",
          batteryLevel: 20,
          connected: true,
        },
      ]),
      600
    );
    const [first, second] = await provider.discover();
    const mismatched: DeviceRef = {
      ...first,
      nativeId: second.nativeId,
    };

    await expect(provider.readStatus(mismatched)).resolves.toEqual({
      state: "unavailable",
      level: { kind: "unavailable" },
      charging: null,
      provider: "windows",
      providerLabel: "Windows Bluetooth",
      observedAt: 600,
      detail: "Invalid Windows Bluetooth device identity",
    });
  });

  it("reports a discovered but disconnected device honestly", async () => {
    const { provider } = createProvider(
      JSON.stringify({
        deviceId: "BTHLE\\DEV_SLEEPING\\1",
        name: "Bluetooth Mouse",
        batteryLevel: 75,
        connected: false,
      }),
      900
    );
    const [device] = await provider.discover();

    await expect(provider.readStatus(device)).resolves.toMatchObject({
      state: "disconnected",
      level: { kind: "unavailable" },
      charging: null,
      observedAt: 900,
    });
  });

  it("does not claim connectivity when Windows omits that property", async () => {
    const { provider } = createProvider(
      JSON.stringify({
        deviceId: "BTHLE\\DEV_UNKNOWN\\1",
        name: "Bluetooth Pen",
        batteryLevel: 33,
        connected: null,
      }),
      901
    );
    const [device] = await provider.discover();

    await expect(provider.readStatus(device)).resolves.toMatchObject({
      state: "unavailable",
      level: { kind: "unavailable" },
      charging: null,
      observedAt: 901,
      detail: "Windows does not report the current connection state",
    });
  });

  it("requires discovery again after deliberate invalidation", async () => {
    const { provider, execute } = createProvider(
      JSON.stringify({
        deviceId: "BTHLE\\DEV_A\\1",
        name: "Bluetooth Keyboard",
        batteryLevel: 55,
        connected: true,
      }),
      700
    );
    const [device] = await provider.discover();

    provider.invalidateDiscovery("manual refresh");

    await expect(provider.readStatus(device)).resolves.toMatchObject({
      state: "unavailable",
      level: { kind: "unavailable" },
      detail: "Windows Bluetooth discovery has not completed",
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight PowerShell scan when discovery is invalidated", async () => {
    const pending = deferred<string>();
    const entered = deferred<void>();
    let scanSignal: AbortSignal | undefined;
    const execute = vi.fn<PowerShellExecutor>((_script, options) => {
      scanSignal = options?.signal;
      entered.resolve();
      return pending.promise;
    });
    const provider = new WindowsBluetoothProvider({
      execute,
      platform: WINDOWS,
      now: () => 100,
    });

    const stale = provider.discover();
    await entered.promise;
    provider.invalidateDiscovery("manual refresh");

    expect(scanSignal).toBeDefined();
    expect(scanSignal?.aborted).toBe(true);
    pending.resolve("[]");
    await expect(stale).rejects.toThrow("invalidated");
  });

  it("does not invoke PowerShell on unsupported platforms", async () => {
    const execute = vi.fn<PowerShellExecutor>();
    const provider = new WindowsBluetoothProvider({
      execute,
      platform: "linux",
      now: () => 100,
    });

    await expect(provider.discover()).resolves.toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
});
