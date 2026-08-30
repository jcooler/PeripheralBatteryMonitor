import { afterEach, describe, expect, it, vi } from "vitest";

import { BatteryRuntime } from "../../src/actions/battery-runtime";
import type { PersistedBatterySettings } from "../../src/actions/settings";
import type { DeviceCatalog } from "../../src/devices/catalog";
import {
  makeDeviceKey,
  type BatteryStatus,
  type DeviceRef,
  type DiscoveryResult,
} from "../../src/devices/types";
import { deferred } from "../helpers/deferred";

function device(nativeId: string): DeviceRef {
  return {
    key: makeDeviceKey("windows", nativeId),
    provider: "windows",
    providerLabel: "Windows Bluetooth",
    nativeId,
    name: nativeId,
    deviceType: "Mouse",
  };
}

function settings(selectedDevices: DeviceRef[]): PersistedBatterySettings {
  return { schemaVersion: 2, selectedDevices, pollInterval: 10 };
}

function available(ref: DeviceRef): BatteryStatus {
  return {
    state: "connected",
    level: { kind: "percentage", value: 50 },
    charging: false,
    provider: ref.provider,
    providerLabel: ref.providerLabel,
    observedAt: 1,
  };
}

function setup() {
  const a = device("A");
  const discovery: DiscoveryResult = {
    devices: [a],
    errors: [],
    refreshedAt: 1,
  };
  const catalog = {
    discover: vi.fn(async () => discovery),
    invalidateDiscovery: vi.fn(),
    readStatus: vi.fn(async (ref: DeviceRef) => available(ref)),
  } as unknown as DeviceCatalog;
  const render = vi.fn();
  const runtime = new BatteryRuntime(catalog, render, {
    discoveryRefreshMs: 300_000,
  });
  return { a, catalog, render, runtime };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("BatteryRuntime discovery separation", () => {
  it("coalesces startup discovery across actions and refreshes their exact statuses", async () => {
    const { a, catalog, runtime } = setup();

    runtime.appear("one", settings([a]));
    runtime.appear("two", settings([a]));
    await vi.waitFor(() => expect(catalog.discover).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(catalog.readStatus).toHaveBeenCalledTimes(4));

    expect(runtime.activeKey("one")).toBe(a.key);
    expect(runtime.activeKey("two")).toBe(a.key);
  });

  it("does not invoke discovery on each display polling interval", async () => {
    vi.useFakeTimers();
    const { a, catalog, runtime } = setup();
    runtime.appear("one", settings([a]));
    await vi.advanceTimersByTimeAsync(0);
    const statusReads = vi.mocked(catalog.readStatus).mock.calls.length;

    await vi.advanceTimersByTimeAsync(40_000);

    expect(catalog.discover).toHaveBeenCalledTimes(1);
    expect(catalog.readStatus).toHaveBeenCalledTimes(statusReads + 4);
  });

  it("invalidates discovery only for an explicit force refresh", async () => {
    const { a, catalog, runtime } = setup();
    runtime.appear("one", settings([a]));
    await vi.waitFor(() => expect(catalog.discover).toHaveBeenCalledTimes(1));

    await runtime.refreshDevices(true);

    expect(catalog.invalidateDiscovery).toHaveBeenCalledTimes(1);
    expect(catalog.discover).toHaveBeenCalledTimes(2);
  });

  it("queues one real force refresh when startup discovery is still running", async () => {
    const { a, catalog, runtime } = setup();
    const first = deferred<DiscoveryResult>();
    vi.mocked(catalog.discover)
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ devices: [a], errors: [], refreshedAt: 2 });
    runtime.appear("one", settings([a]));
    await vi.waitFor(() => expect(catalog.discover).toHaveBeenCalledTimes(1));

    const forcedOne = runtime.refreshDevices(true);
    const forcedTwo = runtime.refreshDevices(true);
    first.resolve({ devices: [a], errors: [], refreshedAt: 1 });
    await Promise.all([forcedOne, forcedTwo]);

    expect(catalog.invalidateDiscovery).toHaveBeenCalledTimes(1);
    expect(catalog.discover).toHaveBeenCalledTimes(2);
  });

  it("coalesces simultaneous forced refreshes instead of running two scans", async () => {
    const { a, catalog, runtime } = setup();
    const forcedDiscovery = deferred<DiscoveryResult>();
    vi.mocked(catalog.discover).mockImplementationOnce(
      () => forcedDiscovery.promise
    );

    const forcedOne = runtime.refreshDevices(true);
    const forcedTwo = runtime.refreshDevices(true);
    expect(catalog.invalidateDiscovery).toHaveBeenCalledTimes(1);
    expect(catalog.discover).toHaveBeenCalledTimes(1);

    forcedDiscovery.resolve({ devices: [a], errors: [], refreshedAt: 1 });
    await Promise.all([forcedOne, forcedTwo]);

    expect(catalog.invalidateDiscovery).toHaveBeenCalledTimes(1);
    expect(catalog.discover).toHaveBeenCalledTimes(1);
  });

  it("cleans up a rejected queued force refresh so a later retry can run", async () => {
    const { a, catalog, runtime } = setup();
    const startup = deferred<DiscoveryResult>();
    vi.mocked(catalog.discover)
      .mockImplementationOnce(() => startup.promise)
      .mockRejectedValueOnce(new Error("scan failed"))
      .mockResolvedValue({ devices: [a], errors: [], refreshedAt: 3 });
    runtime.appear("one", settings([a]));
    await vi.waitFor(() => expect(catalog.discover).toHaveBeenCalledTimes(1));

    const failedRefresh = runtime.refreshDevices(true);
    startup.resolve({ devices: [a], errors: [], refreshedAt: 1 });
    await expect(failedRefresh).rejects.toThrow("scan failed");
    await expect(runtime.refreshDevices(true)).resolves.toMatchObject({
      refreshedAt: 3,
    });

    expect(catalog.discover).toHaveBeenCalledTimes(3);
  });

  it("removes sessions and stops maintenance when actions disappear", async () => {
    vi.useFakeTimers();
    const { a, catalog, runtime } = setup();
    runtime.appear("one", settings([a]));
    await vi.advanceTimersByTimeAsync(0);
    runtime.disappear("one");

    await vi.advanceTimersByTimeAsync(600_000);

    expect(catalog.discover).toHaveBeenCalledTimes(1);
    expect(runtime.activeKey("one")).toBeNull();
  });
});
