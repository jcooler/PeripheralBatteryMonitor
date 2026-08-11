import { describe, expect, it, vi } from "vitest";

import { makeDeviceKey, type DeviceRef } from "../../src/devices/types";
import {
  XInputProvider,
  type XInputPowerShellExecutor,
} from "../../src/xbox/client";
import { deferred } from "../helpers/deferred";

const WINDOWS = "win32" as NodeJS.Platform;

function createProvider(
  records: unknown,
  now = 1_000
): {
  provider: XInputProvider;
  execute: ReturnType<typeof vi.fn<XInputPowerShellExecutor>>;
} {
  const execute = vi
    .fn<XInputPowerShellExecutor>()
    .mockResolvedValue(JSON.stringify(records));
  return {
    provider: new XInputProvider({ execute, platform: WINDOWS, now: () => now }),
    execute,
  };
}

function record(
  index: number,
  batteryType: number,
  batteryLevel: number,
  connected = true,
  resultCode = connected ? 0 : 1_167
): Record<string, unknown> {
  return { index, connected, resultCode, batteryType, batteryLevel };
}

function ref(index: number): DeviceRef {
  const nativeId = `slot:${index}`;
  return {
    key: makeDeviceKey("xinput", nativeId),
    provider: "xinput",
    providerLabel: "XInput",
    nativeId,
    name: `Xbox Controller (XInput slot ${index + 1})`,
    deviceType: "Controller",
  };
}

describe("XInputProvider", () => {
  it("discovers only wireless battery devices with exact slot identities", async () => {
    const { provider } = createProvider([
      record(0, 2, 1),
      record(1, 1, 3),
      record(2, 255, 3),
      record(3, 0, 0, false),
    ]);

    await expect(provider.discover()).resolves.toEqual([
      {
        key: makeDeviceKey("xinput", "slot:0"),
        provider: "xinput",
        providerLabel: "XInput",
        nativeId: "slot:0",
        name: "Xbox Controller (XInput slot 1)",
        deviceType: "Controller",
      },
    ]);
  });

  it("uses only passive XInput battery reads with no state writes or polling stimulation", async () => {
    const { provider, execute } = createProvider([record(0, 2, 1)]);

    await provider.discover();

    const script = execute.mock.calls[0]?.[0] ?? "";
    expect(script).toContain("XInputGetBatteryInformation");
    expect(script).not.toContain("XInputSetState");
    expect(script).not.toContain("Start-Sleep");
    expect(script).not.toContain("XInputGetState");
  });

  it("uses the documented two-byte XInput battery-information structure", async () => {
    const { provider, execute } = createProvider([record(0, 2, 1)]);

    await provider.discover();

    const script = execute.mock.calls[0]?.[0] ?? "";
    expect(script).toContain("struct XInputBatteryInformation");
    expect(script).toContain("out XInputBatteryInformation batteryInformation");
    expect(script).not.toContain("out byte batteryType");
  });

  it.each([
    [0, "empty"],
    [1, "low"],
    [2, "medium"],
    [3, "full"],
  ] as const)(
    "preserves XInput level %s as the qualitative %s state",
    async (batteryLevel, expected) => {
      const { provider } = createProvider([
        record(0, 3, batteryLevel),
        record(1, 0, 0, false),
        record(2, 0, 0, false),
        record(3, 0, 0, false),
      ], 8_000);
      const [device] = await provider.discover();

      await expect(provider.readStatus(device)).resolves.toMatchObject({
        state: "connected",
        level: { kind: "qualitative", value: expected },
        charging: null,
        provider: "xinput",
        providerLabel: "XInput",
        observedAt: 8_000,
        detail: expect.stringContaining("slot assignment can change"),
      });
    }
  );

  it.each([
    [1, "wired controller; no battery status is available"],
    [0, "did not report a battery type"],
    [255, "reported an unknown battery type"],
  ] as const)(
    "reports connected battery type %s as unavailable instead of inventing a value",
    async (batteryType, expectedDetail) => {
      const { provider } = createProvider([record(0, batteryType, 3)], 4_000);
      await provider.discover();

      await expect(provider.readStatus(ref(0))).resolves.toEqual({
        state: "unavailable",
        level: { kind: "unavailable" },
        charging: null,
        provider: "xinput",
        providerLabel: "XInput",
        observedAt: 4_000,
        detail: `XInput ${expectedDetail}`,
      });
    }
  );

  it("reports an invalid wireless bucket as unavailable", async () => {
    const { provider } = createProvider([record(0, 2, 9)], 4_100);
    await provider.discover();

    await expect(provider.readStatus(ref(0))).resolves.toMatchObject({
      state: "unavailable",
      level: { kind: "unavailable" },
      charging: null,
      detail: "XInput returned an invalid battery level",
    });
  });

  it("does not fall back from a missing slot to another controller", async () => {
    const { provider } = createProvider([record(0, 2, 3)], 5_000);
    await provider.discover();

    await expect(provider.readStatus(ref(2))).resolves.toEqual({
      state: "disconnected",
      level: { kind: "unavailable" },
      charging: null,
      provider: "xinput",
      providerLabel: "XInput",
      observedAt: 5_000,
      detail: "XInput slot absent from the latest discovery",
    });
  });

  it("fails closed when the key and native XInput slot disagree", async () => {
    const { provider } = createProvider([
      record(0, 2, 3),
      record(1, 2, 0),
    ], 5_100);
    const [first, second] = await provider.discover();
    const mismatched: DeviceRef = {
      ...first,
      nativeId: second.nativeId,
    };

    await expect(provider.readStatus(mismatched)).resolves.toEqual({
      state: "unavailable",
      level: { kind: "unavailable" },
      charging: null,
      provider: "xinput",
      providerLabel: "XInput",
      observedAt: 5_100,
      detail: "Invalid XInput device identity",
    });
  });

  it("reports an unexpected XInput API error as unavailable, not disconnected", async () => {
    const { provider } = createProvider([record(0, 0, 0, false, 5)], 5_200);
    await provider.discover();

    await expect(provider.readStatus(ref(0))).resolves.toEqual({
      state: "unavailable",
      level: { kind: "unavailable" },
      charging: null,
      provider: "xinput",
      providerLabel: "XInput",
      observedAt: 5_200,
      detail: "XInput battery query failed with error 5",
    });
  });

  it("reports a disconnected exact slot without a battery value", async () => {
    const { provider } = createProvider([record(1, 0, 0, false)], 5_500);
    await provider.discover();

    await expect(provider.readStatus(ref(1))).resolves.toMatchObject({
      state: "disconnected",
      level: { kind: "unavailable" },
      charging: null,
      observedAt: 5_500,
    });
  });

  it("serves repeated status reads from the cached snapshot", async () => {
    const { provider, execute } = createProvider([record(0, 2, 2)]);
    const [device] = await provider.discover();

    for (let index = 0; index < 10; index += 1) {
      await provider.readStatus(device);
    }

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("requires a new discovery after deliberate invalidation", async () => {
    const { provider, execute } = createProvider([record(0, 2, 2)]);
    const [device] = await provider.discover();

    provider.invalidateDiscovery("manual refresh");

    await expect(provider.readStatus(device)).resolves.toMatchObject({
      state: "unavailable",
      level: { kind: "unavailable" },
      detail: "XInput discovery has not completed",
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight PowerShell snapshot when discovery is invalidated", async () => {
    const pending = deferred<string>();
    const entered = deferred<void>();
    let scanSignal: AbortSignal | undefined;
    const execute = vi.fn<XInputPowerShellExecutor>((_script, options) => {
      scanSignal = options?.signal;
      entered.resolve();
      return pending.promise;
    });
    const provider = new XInputProvider({
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
    const execute = vi.fn<XInputPowerShellExecutor>();
    const provider = new XInputProvider({
      execute,
      platform: "darwin",
      now: () => 100,
    });

    await expect(provider.discover()).resolves.toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
});
