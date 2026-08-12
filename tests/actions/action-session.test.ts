import { afterEach, describe, expect, it, vi } from "vitest";

import { ActionSession, type SessionRender } from "../../src/actions/action-session";
import type { PersistedBatterySettings } from "../../src/actions/settings";
import {
  makeDeviceKey,
  type BatteryStatus,
  type DeviceRef,
} from "../../src/devices/types";
import { deferred } from "../helpers/deferred";

function ref(nativeId: string): DeviceRef {
  return {
    key: makeDeviceKey("windows", nativeId),
    provider: "windows",
    providerLabel: "Windows Bluetooth",
    nativeId,
    name: nativeId,
    deviceType: "Mouse",
  };
}

function settings(devices: DeviceRef[], extra: PersistedBatterySettings = {}): PersistedBatterySettings {
  return {
    schemaVersion: 2,
    selectedDevices: devices,
    pollInterval: 10,
    ...extra,
  };
}

function status(device: DeviceRef, value: number): BatteryStatus {
  return {
    state: "connected",
    level: { kind: "percentage", value },
    charging: false,
    provider: device.provider,
    providerLabel: device.providerLabel,
    observedAt: value,
  };
}

function setup(readStatus = vi.fn(async (device: DeviceRef) => status(device, 50))) {
  const renders: SessionRender[] = [];
  const onResume = vi.fn();
  const session = new ActionSession({
    readStatus,
    render: (render) => {
      renders.push(render);
    },
    onResume,
  });
  return { onResume, readStatus, renders, session };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ordered device cycle", () => {
  it("uses the first configured device initially and cycles in explicit order", async () => {
    const a = ref("A");
    const b = ref("B");
    const c = ref("C");
    const { readStatus, session } = setup();

    session.appear(settings([a, b, c]));
    await vi.waitFor(() => expect(readStatus).toHaveBeenCalledTimes(1));
    expect(session.activeKey).toBe(a.key);

    session.keyDown();
    await vi.waitFor(() => expect(readStatus).toHaveBeenCalledTimes(2));
    expect(session.activeKey).toBe(b.key);
    session.keyDown();
    await vi.waitFor(() => expect(readStatus).toHaveBeenCalledTimes(3));
    expect(session.activeKey).toBe(c.key);
    session.keyDown();
    await vi.waitFor(() => expect(readStatus).toHaveBeenCalledTimes(4));
    expect(session.activeKey).toBe(a.key);
  });

  it("preserves cycle position across polling and unrelated settings updates", async () => {
    vi.useFakeTimers();
    const a = ref("A");
    const b = ref("B");
    const { readStatus, session } = setup();
    session.appear(settings([a, b]));
    await vi.advanceTimersByTimeAsync(0);
    session.keyDown();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.activeKey).toBe(b.key);

    session.updateSettings(settings([a, b], { showDeviceName: true, backgroundColor: "#222222" }));
    expect(session.activeKey).toBe(b.key);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(session.activeKey).toBe(b.key);
    expect(readStatus.mock.calls.at(-1)?.[0]).toMatchObject({ key: b.key });
  });

  it("preserves the active key across reordering and resets only if it is removed", async () => {
    const a = ref("A");
    const b = ref("B");
    const c = ref("C");
    const { session } = setup();
    session.appear(settings([a, b, c]));
    session.keyDown();
    await vi.waitFor(() => expect(session.activeKey).toBe(b.key));

    session.updateSettings(settings([c, b, a]));
    expect(session.activeKey).toBe(b.key);
    session.updateSettings(settings([c, a]));
    expect(session.activeKey).toBe(c.key);
  });
});

describe("refresh concurrency", () => {
  it("never renders a stale result after switching devices", async () => {
    const a = ref("A");
    const b = ref("B");
    const aResult = deferred<BatteryStatus>();
    const bResult = deferred<BatteryStatus>();
    const readStatus = vi
      .fn<(device: DeviceRef, signal?: AbortSignal) => Promise<BatteryStatus>>()
      .mockImplementationOnce((_device, signal) => {
        expect(signal?.aborted).toBe(false);
        return aResult.promise;
      })
      .mockImplementationOnce(() => bResult.promise);
    const { renders, session } = setup(readStatus);
    session.appear(settings([a, b]));
    await vi.waitFor(() => expect(readStatus).toHaveBeenCalledTimes(1));

    session.keyDown();
    expect(readStatus.mock.calls[0][1]?.aborted).toBe(true);
    aResult.resolve(status(a, 10));
    await vi.waitFor(() => expect(readStatus).toHaveBeenCalledTimes(2));
    bResult.resolve(status(b, 90));
    await vi.waitFor(() =>
      expect(renders.filter((render) => render.kind === "status")).toHaveLength(1)
    );

    const rendered = renders.find((render) => render.kind === "status");
    expect(rendered).toMatchObject({ device: { key: b.key }, status: { observedAt: 90 } });
  });

  it("coalesces refresh requests and never overlaps reads for one action", async () => {
    const a = ref("A");
    const first = deferred<BatteryStatus>();
    const second = deferred<BatteryStatus>();
    let concurrent = 0;
    let maxConcurrent = 0;
    const readStatus = vi
      .fn<(device: DeviceRef) => Promise<BatteryStatus>>()
      .mockImplementationOnce(async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        const result = await first.promise;
        concurrent -= 1;
        return result;
      })
      .mockImplementationOnce(async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        const result = await second.promise;
        concurrent -= 1;
        return result;
      });
    const { session } = setup(readStatus);
    session.appear(settings([a]));
    await vi.waitFor(() => expect(readStatus).toHaveBeenCalledTimes(1));

    session.manualRefresh();
    session.manualRefresh();
    session.manualRefresh();
    expect(readStatus).toHaveBeenCalledTimes(1);
    first.resolve(status(a, 20));
    await vi.waitFor(() => expect(readStatus).toHaveBeenCalledTimes(2));
    second.resolve(status(a, 30));
    await vi.waitFor(() => expect(maxConcurrent).toBe(1));
  });

  it("suppresses completion and future timers after disappearance", async () => {
    vi.useFakeTimers();
    const a = ref("A");
    const pending = deferred<BatteryStatus>();
    const readStatus = vi.fn(() => pending.promise);
    const { renders, session } = setup(readStatus);
    session.appear(settings([a]));
    await vi.advanceTimersByTimeAsync(0);
    session.disappear();
    pending.resolve(status(a, 50));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(renders.some((render) => render.kind === "status")).toBe(false);
    expect(readStatus).toHaveBeenCalledTimes(1);
  });

  it("waits for deliberate resume recovery before reading status again", async () => {
    const a = ref("A");
    const resumed = deferred<void>();
    const readStatus = vi.fn(async () => status(a, 50));
    const onResume = vi.fn(() => resumed.promise);
    let now = 0;
    let scheduled: (() => void) | null = null;
    const session = new ActionSession({
      readStatus,
      render: vi.fn(),
      onResume,
      now: () => now,
      setTimer: (callback) => {
        scheduled = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: vi.fn(),
    });
    session.appear(settings([a]));
    await vi.waitFor(() => expect(readStatus).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(scheduled).not.toBeNull());

    now = 20_000;
    (scheduled as () => void)();
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(readStatus).toHaveBeenCalledTimes(1);
    resumed.resolve();

    await vi.waitFor(() => expect(readStatus).toHaveBeenCalledTimes(2));
  });
});
