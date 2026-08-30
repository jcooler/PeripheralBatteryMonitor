import { describe, expect, it, vi } from "vitest";

import { makeDeviceKey, type DeviceRef } from "../../src/devices/types";
import {
  WindowsGamepadProvider,
  type WindowsGamepadExecutor,
} from "../../src/windows/gamepad";
import { deferred } from "../helpers/deferred";

const WINDOWS = "win32" as NodeJS.Platform;

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "raw-gamepad-1",
    name: "Xbox One Game Controller",
    wireless: true,
    vendorId: 0x045e,
    productId: 0x0b00,
    status: "Discharging",
    remainingMWh: 700,
    fullMWh: 1_000,
    ...overrides,
  };
}

function output(...controllers: Record<string, unknown>[]): string {
  return JSON.stringify({ controllers });
}

function ref(nativeId = "raw-gamepad-1"): DeviceRef {
  return {
    key: makeDeviceKey("windows-gamepad", nativeId),
    provider: "windows-gamepad",
    providerLabel: "Windows Gamepad",
    nativeId,
    name: "Xbox One Game Controller",
    deviceType: "Controller",
  };
}

function createProvider(
  response = output(record()),
  now = 1_000
): {
  provider: WindowsGamepadProvider;
  execute: ReturnType<typeof vi.fn<WindowsGamepadExecutor>>;
} {
  const execute = vi.fn<WindowsGamepadExecutor>().mockResolvedValue(response);
  return {
    provider: new WindowsGamepadProvider({
      execute,
      platform: WINDOWS,
      now: () => now,
    }),
    execute,
  };
}

describe("WindowsGamepadProvider", () => {
  it("discovers the exact supported wireless-adapter controller identity", async () => {
    const { provider } = createProvider(
      output(
        record({ id: "stable-id\0" }),
        record({ id: " padded-id " }),
        record({ id: "wired", wireless: false }),
        record({ id: "other-vendor", vendorId: 0x054c }),
        record({ id: "other-microsoft-gamepad", productId: 0x0b22 })
      )
    );

    await expect(provider.discover()).resolves.toEqual([
      {
        key: makeDeviceKey("windows-gamepad", "stable-id"),
        provider: "windows-gamepad",
        providerLabel: "Windows Gamepad",
        nativeId: "stable-id",
        name: "Xbox One Game Controller",
        deviceType: "Controller",
      },
    ]);
  });

  it("uses only read-only Windows Gaming Input identity and battery APIs", async () => {
    const { provider, execute } = createProvider();

    await provider.discover();

    const script = execute.mock.calls[0]?.[0] ?? "";
    expect(script).toContain("RawGameController");
    expect(script).toContain("NonRoamableId");
    expect(script).toContain("TryGetBatteryReport");
    const adapterGate = script.indexOf("$isSupportedAdapterController =");
    const batteryRead = script.indexOf("TryGetBatteryReport");
    const supportedRetry = script.indexOf(
      "if ($supportedControllerSnapshot.Count -gt 0"
    );
    expect(supportedRetry).toBeGreaterThanOrEqual(0);
    expect(supportedRetry).toBeLessThan(adapterGate);
    expect(adapterGate).toBeGreaterThanOrEqual(0);
    expect(adapterGate).toBeLessThan(batteryRead);
    expect(script.slice(adapterGate, batteryRead)).toContain("IsWireless");
    expect(script.slice(adapterGate, batteryRead)).toContain("1118");
    expect(script.slice(adapterGate, batteryRead)).toContain("2816");
    const unavailableDefaults = script.indexOf("$status = $null", adapterGate);
    const preservedRecord = script.indexOf("[PSCustomObject]@{", batteryRead);
    expect(unavailableDefaults).toBeLessThan(batteryRead);
    expect(preservedRecord).toBeGreaterThan(batteryRead);
    expect(script).not.toContain("XInput");
    expect(script).not.toContain("XInputSetState");
    expect(script).not.toContain("HidD_Set");
    expect(script).not.toContain("Vibration");
  });

  it("derives an honest percentage and charging state from the cached battery report", async () => {
    const { provider, execute } = createProvider(
      output(record({ status: "Charging", remainingMWh: 333, fullMWh: 1_000 })),
      12_345
    );
    const [device] = await provider.discover();

    for (let index = 0; index < 10; index += 1) {
      await expect(provider.readStatus(device)).resolves.toEqual({
        state: "connected",
        level: { kind: "percentage", value: 33 },
        charging: true,
        provider: "windows-gamepad",
        providerLabel: "Windows Gamepad",
        observedAt: 12_345,
        detail: "Windows Gaming Input capacity report",
      });
    }
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Discharging", false],
    ["Idle", false],
    ["Charging", true],
  ] as const)("maps Windows battery status %s without guessing", async (status, charging) => {
    const { provider } = createProvider(output(record({ status })));
    const [device] = await provider.discover();

    await expect(provider.readStatus(device)).resolves.toMatchObject({
      state: "connected",
      charging,
    });
  });

  it.each([
    ["NotPresent", 0, 0, "Windows reports no battery"],
    [null, null, null, "Windows Gaming Input battery report unavailable"],
    ["Unknown", 500, 1_000, "Unsupported Windows battery status"],
    ["Discharging", null, 1_000, "Windows did not report battery capacity"],
    ["Discharging", 500, null, "Windows did not report battery capacity"],
    ["Discharging", 500, 0, "Windows reported invalid battery capacity"],
    ["Discharging", -1, 1_000, "Windows reported invalid battery capacity"],
    ["Discharging", 1_001, 1_000, "Windows reported invalid battery capacity"],
  ])(
    "does not offer or invent a level for status=%s remaining=%s full=%s",
    async (status, remainingMWh, fullMWh, detail) => {
      const { provider } = createProvider(
        output(record({ status, remainingMWh, fullMWh }))
      );

      await expect(provider.discover()).resolves.toEqual([]);
      await expect(provider.readStatus(ref())).resolves.toMatchObject({
        state: "unavailable",
        level: { kind: "unavailable" },
        detail,
      });
    }
  );

  it("suppresses an ambiguous duplicate identity instead of choosing one record", async () => {
    const { provider } = createProvider(
      output(
        record({ remainingMWh: 700 }),
        record({ remainingMWh: 200 })
      )
    );

    await expect(provider.discover()).resolves.toEqual([]);
    await expect(provider.readStatus(ref())).resolves.toMatchObject({
      state: "unavailable",
      level: { kind: "unavailable" },
      detail: "Duplicate Windows Gaming Input identity",
    });
  });

  it("never substitutes a same-name controller when the saved identity disappears", async () => {
    const execute = vi
      .fn<WindowsGamepadExecutor>()
      .mockResolvedValueOnce(output(record({ id: "controller-a" })))
      .mockResolvedValueOnce(output(record({ id: "controller-b" })));
    const provider = new WindowsGamepadProvider({
      execute,
      platform: WINDOWS,
      now: () => 500,
    });
    const [saved] = await provider.discover();

    await expect(provider.discover()).resolves.toEqual([
      expect.objectContaining({ nativeId: "controller-b" }),
    ]);
    await expect(provider.readStatus(saved)).resolves.toEqual({
      state: "disconnected",
      level: { kind: "unavailable" },
      charging: null,
      provider: "windows-gamepad",
      providerLabel: "Windows Gamepad",
      observedAt: 500,
      detail: "Controller absent from the latest Windows Gaming Input snapshot",
    });
  });

  it("fails closed when the key and native identity disagree", async () => {
    const { provider } = createProvider();
    await provider.discover();
    const mismatched = { ...ref(), nativeId: "different-id" };

    await expect(provider.readStatus(mismatched)).resolves.toMatchObject({
      state: "unavailable",
      detail: "Invalid Windows Gaming Input device identity",
    });
  });

  it("aborts an in-flight scan when discovery is invalidated", async () => {
    const pending = deferred<string>();
    const entered = deferred<void>();
    let scanSignal: AbortSignal | undefined;
    const execute = vi.fn<WindowsGamepadExecutor>((_script, options) => {
      scanSignal = options?.signal;
      entered.resolve();
      return pending.promise;
    });
    const provider = new WindowsGamepadProvider({
      execute,
      platform: WINDOWS,
      now: () => 100,
    });

    const stale = provider.discover();
    await entered.promise;
    provider.invalidateDiscovery("manual refresh");

    expect(scanSignal?.aborted).toBe(true);
    pending.resolve(output(record()));
    await expect(stale).rejects.toThrow("invalidated");
  });

  it("does not invoke PowerShell on unsupported platforms", async () => {
    const execute = vi.fn<WindowsGamepadExecutor>();
    const provider = new WindowsGamepadProvider({
      execute,
      platform: "linux",
      now: () => 100,
    });

    await expect(provider.discover()).resolves.toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
});
