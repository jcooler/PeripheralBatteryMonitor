import { describe, expect, it, vi } from "vitest";

import { BatteryAction } from "../../src/actions/battery-action";
import type { SessionRender } from "../../src/actions/action-session";
import type { BatteryRuntime } from "../../src/actions/battery-runtime";
import { makeDeviceKey, type DeviceRef, type DiscoveryResult } from "../../src/devices/types";
import { deferred } from "../helpers/deferred";

function steelSeriesDevice(): DeviceRef {
  return {
    key: makeDeviceKey("steelseries", "42"),
    provider: "steelseries",
    providerLabel: "SteelSeries GG",
    nativeId: "42",
    name: "Aerox 5 Wireless",
    deviceType: "Mouse",
  };
}

function runtime(discovery: Promise<DiscoveryResult>) {
  return {
    appear: vi.fn(),
    updateSettings: vi.fn(),
    keyDown: vi.fn(),
    manualRefresh: vi.fn(),
    disappear: vi.fn(),
    refreshDevices: vi.fn(() => discovery),
  } as unknown as BatteryRuntime;
}

function actionHandle(settings: Record<string, unknown>) {
  return {
    id: "context-1",
    setImage: vi.fn(async () => undefined),
    setTitle: vi.fn(async () => undefined),
    setSettings: vi.fn(async () => undefined),
    getSettings: vi.fn(async () => settings),
  };
}

describe("BatteryAction Stream Deck adapter", () => {
  it("enriches a prefixed v1 selection and renders through its exact action handle", async () => {
    const device = steelSeriesDevice();
    const legacy = {
      deviceBrand: "steelseries",
      deviceId: 42,
      deviceName: "[SS] Aerox 5 Wireless",
    };
    const fakeRuntime = runtime(Promise.resolve({
      devices: [device],
      errors: [],
      refreshedAt: 1,
    }));
    const handle = actionHandle(legacy);
    const action = new BatteryAction({ runtime: fakeRuntime });

    await action.onWillAppear({
      action: handle,
      payload: { settings: legacy },
    } as never);

    expect(fakeRuntime.appear).toHaveBeenCalledWith("context-1", legacy);
    expect(handle.setSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: 2,
        selectedDevices: [expect.objectContaining({
          key: "steelseries:42",
          name: "Aerox 5 Wireless",
          deviceType: "Mouse",
        })],
      })
    );

    await (action as unknown as {
      render(contextId: string, render: SessionRender): Promise<void>;
    }).render("context-1", {
      kind: "status",
      device,
      status: {
        state: "connected",
        level: { kind: "percentage", value: 63 },
        charging: false,
        provider: "steelseries",
        providerLabel: "SteelSeries GG",
        observedAt: 1,
      },
      settings: {
        selectedDevices: [device],
        pollInterval: 30,
        showPercentage: true,
        showDeviceType: false,
        showDeviceName: false,
        showStatusText: true,
        deviceTypeFontSize: 13,
        backgroundColor: "#0d1117",
      },
    });
    expect(handle.setImage).toHaveBeenCalledWith(
      expect.stringMatching(/^data:image\/svg\+xml;base64,/)
    );
  });

  it("does not persist a migration after the action disappears during discovery", async () => {
    const pending = deferred<DiscoveryResult>();
    const legacy = {
      deviceBrand: "steelseries",
      deviceId: 42,
      deviceName: "[SS] Aerox 5 Wireless",
    };
    const fakeRuntime = runtime(pending.promise);
    const handle = actionHandle(legacy);
    const action = new BatteryAction({ runtime: fakeRuntime });

    const appearing = action.onWillAppear({
      action: handle,
      payload: { settings: legacy },
    } as never);
    await vi.waitFor(() =>
      expect(fakeRuntime.refreshDevices).toHaveBeenCalledTimes(1)
    );
    await action.onWillDisappear({ action: handle } as never);
    pending.resolve({ devices: [steelSeriesDevice()], errors: [], refreshedAt: 1 });
    await appearing;

    expect(fakeRuntime.disappear).toHaveBeenCalledWith("context-1");
    expect(handle.setSettings).not.toHaveBeenCalled();
    expect(fakeRuntime.updateSettings).not.toHaveBeenCalled();
  });
});
