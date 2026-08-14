import { describe, expect, it, vi } from "vitest";

import { BatteryAction } from "../../src/actions/battery-action";
import type { SessionRender } from "../../src/actions/action-session";
import { BatteryRuntime } from "../../src/actions/battery-runtime";
import type { DeviceCatalog } from "../../src/devices/catalog";
import {
  makeDeviceKey,
  type BatteryStatus,
  type DeviceRef,
  type DiscoveryResult,
} from "../../src/devices/types";
import { deferred } from "../helpers/deferred";

function decodeIcon(dataUrl: string): string {
  return Buffer.from(dataUrl.split(",")[1], "base64").toString("utf8");
}

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

function windowsKeyboard(): DeviceRef {
  return {
    key: makeDeviceKey("windows", "BTHLE\\DEV_MXKEYS"),
    provider: "windows",
    providerLabel: "Windows Bluetooth",
    nativeId: "BTHLE\\DEV_MXKEYS",
    name: "MX Keys Mini",
    deviceType: "Keyboard",
  };
}

function runtime(discovery: Promise<DiscoveryResult>) {
  return {
    appear: vi.fn(),
    updateSettings: vi.fn(),
    keyDown: vi.fn(),
    activeKey: vi.fn(() => null as string | null),
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

  it("persists the exact active device after cycling", async () => {
    const apex = steelSeriesDevice();
    const mxKeys = windowsKeyboard();
    const persisted = {
      schemaVersion: 2,
      selectedDevices: [apex, mxKeys],
      pollInterval: 10,
    };
    const fakeRuntime = runtime(Promise.resolve({
      devices: [apex, mxKeys],
      errors: [],
      refreshedAt: 1,
    }));
    vi.mocked(fakeRuntime.activeKey).mockReturnValue(mxKeys.key);
    const handle = actionHandle(persisted);
    const action = new BatteryAction({ runtime: fakeRuntime });

    await action.onWillAppear({
      action: handle,
      payload: { settings: persisted },
    } as never);
    await action.onKeyDown({
      action: handle,
      payload: { settings: persisted },
    } as never);

    expect(handle.setSettings).toHaveBeenCalledWith({
      ...persisted,
      activeDeviceKey: mxKeys.key,
    });
  });

  it("starts persisting before a key disappears", async () => {
    const apex = steelSeriesDevice();
    const mxKeys = windowsKeyboard();
    const persisted = {
      schemaVersion: 2,
      selectedDevices: [apex, mxKeys],
      activeDeviceKey: apex.key,
    };
    const fakeRuntime = runtime(Promise.resolve({
      devices: [apex, mxKeys],
      errors: [],
      refreshedAt: 1,
    }));
    vi.mocked(fakeRuntime.activeKey).mockReturnValue(mxKeys.key);
    const handle = actionHandle(persisted);
    const action = new BatteryAction({ runtime: fakeRuntime });
    await action.onWillAppear({
      action: handle,
      payload: { settings: persisted },
    } as never);

    const cycling = action.onKeyDown({
      action: handle,
      payload: { settings: persisted },
    } as never);
    await action.onWillDisappear({ action: handle } as never);
    await cycling;

    expect(handle.setSettings).toHaveBeenCalledWith({
      ...persisted,
      activeDeviceKey: mxKeys.key,
    });
  });

  it("does not overwrite a newer settings edit with a key write", async () => {
    const apex = steelSeriesDevice();
    const mxKeys = windowsKeyboard();
    const beforeEdit = {
      schemaVersion: 2,
      selectedDevices: [apex, mxKeys],
      activeDeviceKey: apex.key,
      showDeviceName: false,
    };
    const afterEdit = {
      schemaVersion: 2,
      selectedDevices: [apex],
      activeDeviceKey: mxKeys.key,
      showDeviceName: true,
    };
    const fakeRuntime = runtime(Promise.resolve({
      devices: [apex, mxKeys],
      errors: [],
      refreshedAt: 1,
    }));
    let activeKey = mxKeys.key;
    vi.mocked(fakeRuntime.activeKey).mockImplementation(() => activeKey);
    const handle = actionHandle(beforeEdit);
    const action = new BatteryAction({ runtime: fakeRuntime });
    await action.onWillAppear({
      action: handle,
      payload: { settings: beforeEdit },
    } as never);

    const cycling = action.onKeyDown({
      action: handle,
      payload: { settings: beforeEdit },
    } as never);
    activeKey = apex.key;
    await action.onDidReceiveSettings({
      action: handle,
      payload: { settings: afterEdit },
    } as never);
    await cycling;

    expect(handle.setSettings).toHaveBeenLastCalledWith({
      ...afterEdit,
      activeDeviceKey: apex.key,
    });
  });

  it("persists the final exact position after rapid key presses", async () => {
    const apex = steelSeriesDevice();
    const mxKeys = windowsKeyboard();
    const persisted = {
      schemaVersion: 2,
      selectedDevices: [apex, mxKeys],
      activeDeviceKey: apex.key,
    };
    const fakeRuntime = runtime(Promise.resolve({
      devices: [apex, mxKeys],
      errors: [],
      refreshedAt: 1,
    }));
    let activeIndex = 0;
    vi.mocked(fakeRuntime.keyDown).mockImplementation(() => {
      activeIndex = (activeIndex + 1) % 2;
    });
    vi.mocked(fakeRuntime.activeKey).mockImplementation(
      () => [apex, mxKeys][activeIndex].key
    );
    const handle = actionHandle(persisted);
    const action = new BatteryAction({ runtime: fakeRuntime });
    await action.onWillAppear({
      action: handle,
      payload: { settings: persisted },
    } as never);

    await Promise.all([
      action.onKeyDown({ action: handle, payload: { settings: persisted } } as never),
      action.onKeyDown({ action: handle, payload: { settings: persisted } } as never),
      action.onKeyDown({ action: handle, payload: { settings: persisted } } as never),
    ]);

    expect(
      vi.mocked(handle.setSettings).mock.calls.map(
        ([settings]) => settings.activeDeviceKey
      )
    ).toEqual([mxKeys.key, apex.key, mxKeys.key]);
  });

  it("restores a cycled device in a fresh action runtime", async () => {
    const apex = steelSeriesDevice();
    const mxKeys = windowsKeyboard();
    let persisted = {
      schemaVersion: 2,
      selectedDevices: [apex, mxKeys],
      activeDeviceKey: apex.key,
    };
    const available = (device: DeviceRef): BatteryStatus => ({
      state: "connected",
      level: { kind: "percentage", value: 75 },
      charging: false,
      provider: device.provider,
      providerLabel: device.providerLabel,
      observedAt: 1,
    });
    const discovery = {
      devices: [apex, mxKeys],
      errors: [],
      refreshedAt: 1,
    };
    const catalog = {
      discover: vi.fn(async () => discovery),
      invalidateDiscovery: vi.fn(),
      readStatus: vi.fn(async (device: DeviceRef) => available(device)),
    } as unknown as DeviceCatalog;
    const firstRuntime = new BatteryRuntime(catalog, vi.fn());
    const firstHandle = actionHandle(persisted);
    vi.mocked(firstHandle.setSettings).mockImplementation(async (settings) => {
      persisted = settings as typeof persisted;
    });
    const firstAction = new BatteryAction({ runtime: firstRuntime });
    await firstAction.onWillAppear({
      action: firstHandle,
      payload: { settings: persisted },
    } as never);
    await vi.waitFor(() =>
      expect(firstRuntime.activeKey("context-1")).toBe(apex.key)
    );

    await firstAction.onKeyDown({
      action: firstHandle,
      payload: { settings: persisted },
    } as never);
    expect(persisted.activeDeviceKey).toBe(mxKeys.key);
    await firstAction.onWillDisappear({ action: firstHandle } as never);
    firstRuntime.destroy();

    const secondRuntime = new BatteryRuntime(catalog, vi.fn());
    const secondHandle = actionHandle(persisted);
    const secondAction = new BatteryAction({ runtime: secondRuntime });
    await secondAction.onWillAppear({
      action: secondHandle,
      payload: { settings: persisted },
    } as never);

    await vi.waitFor(() =>
      expect(secondRuntime.activeKey("context-1")).toBe(mxKeys.key)
    );
    await secondAction.onWillDisappear({ action: secondHandle } as never);
    secondRuntime.destroy();
  });

  it("repairs a saved position after the active device is removed", async () => {
    const apex = steelSeriesDevice();
    const mxKeys = windowsKeyboard();
    const initial = {
      schemaVersion: 2,
      selectedDevices: [apex, mxKeys],
      activeDeviceKey: mxKeys.key,
    };
    const afterRemoval = {
      ...initial,
      selectedDevices: [apex],
    };
    const fakeRuntime = runtime(Promise.resolve({
      devices: [apex],
      errors: [],
      refreshedAt: 1,
    }));
    vi.mocked(fakeRuntime.activeKey).mockReturnValue(apex.key);
    const handle = actionHandle(initial);
    const action = new BatteryAction({ runtime: fakeRuntime });
    await action.onWillAppear({
      action: handle,
      payload: { settings: initial },
    } as never);

    await action.onDidReceiveSettings({
      action: handle,
      payload: { settings: afterRemoval },
    } as never);

    expect(fakeRuntime.updateSettings).toHaveBeenCalledWith(
      "context-1",
      afterRemoval
    );
    expect(handle.setSettings).toHaveBeenCalledWith({
      ...afterRemoval,
      activeDeviceKey: apex.key,
    });
  });

  it("renders the active device position for a multi-device action", async () => {
    const apex = steelSeriesDevice();
    const mxKeys = windowsKeyboard();
    const persisted = {
      schemaVersion: 2,
      selectedDevices: [apex, mxKeys],
      activeDeviceKey: mxKeys.key,
    };
    const fakeRuntime = runtime(Promise.resolve({
      devices: [apex, mxKeys],
      errors: [],
      refreshedAt: 1,
    }));
    const handle = actionHandle(persisted);
    const action = new BatteryAction({ runtime: fakeRuntime });
    await action.onWillAppear({
      action: handle,
      payload: { settings: persisted },
    } as never);

    await (action as unknown as {
      render(contextId: string, render: SessionRender): Promise<void>;
    }).render("context-1", {
      kind: "status",
      device: mxKeys,
      status: {
        state: "connected",
        level: { kind: "percentage", value: 81 },
        charging: false,
        provider: "windows",
        providerLabel: "Windows Bluetooth",
        observedAt: 1,
      },
      settings: {
        selectedDevices: [apex, mxKeys],
        activeDeviceKey: mxKeys.key,
        pollInterval: 30,
        showPercentage: true,
        showDeviceType: false,
        showDeviceName: false,
        showStatusText: false,
        deviceTypeFontSize: 13,
        backgroundColor: "#0d1117",
      },
    });

    const svg = decodeIcon(vi.mocked(handle.setImage).mock.calls.at(-1)?.[0] ?? "");
    expect(svg.match(/data-cycle-index=/g)).toHaveLength(2);
    expect(svg).toMatch(/data-cycle-index="0" data-active="false"/);
    expect(svg).toMatch(/data-cycle-index="1" data-active="true"/);
  });

  it("shows the newly selected position while its status is loading", async () => {
    const apex = steelSeriesDevice();
    const mxKeys = windowsKeyboard();
    const persisted = {
      schemaVersion: 2,
      selectedDevices: [apex, mxKeys],
      activeDeviceKey: mxKeys.key,
    };
    const fakeRuntime = runtime(Promise.resolve({
      devices: [apex, mxKeys],
      errors: [],
      refreshedAt: 1,
    }));
    const handle = actionHandle(persisted);
    const action = new BatteryAction({ runtime: fakeRuntime });
    await action.onWillAppear({
      action: handle,
      payload: { settings: persisted },
    } as never);

    await (action as unknown as {
      render(contextId: string, render: SessionRender): Promise<void>;
    }).render("context-1", {
      kind: "loading",
      device: mxKeys,
      settings: {
        selectedDevices: [apex, mxKeys],
        activeDeviceKey: mxKeys.key,
        pollInterval: 30,
        showPercentage: true,
        showDeviceType: false,
        showDeviceName: false,
        showStatusText: false,
        deviceTypeFontSize: 13,
        backgroundColor: "#0d1117",
      },
    });

    const svg = decodeIcon(vi.mocked(handle.setImage).mock.calls.at(-1)?.[0] ?? "");
    expect(svg).toMatch(/data-cycle-index="1" data-active="true"/);
  });

  it("keeps the selected position visible when that device is disconnected", async () => {
    const apex = steelSeriesDevice();
    const mxKeys = windowsKeyboard();
    const persisted = {
      schemaVersion: 2,
      selectedDevices: [apex, mxKeys],
      activeDeviceKey: mxKeys.key,
    };
    const fakeRuntime = runtime(Promise.resolve({
      devices: [apex, mxKeys],
      errors: [],
      refreshedAt: 1,
    }));
    const handle = actionHandle(persisted);
    const action = new BatteryAction({ runtime: fakeRuntime });
    await action.onWillAppear({
      action: handle,
      payload: { settings: persisted },
    } as never);

    await (action as unknown as {
      render(contextId: string, render: SessionRender): Promise<void>;
    }).render("context-1", {
      kind: "status",
      device: mxKeys,
      status: {
        state: "disconnected",
        level: { kind: "unavailable" },
        charging: false,
        provider: "windows",
        providerLabel: "Windows Bluetooth",
        observedAt: 1,
      },
      settings: {
        selectedDevices: [apex, mxKeys],
        activeDeviceKey: mxKeys.key,
        pollInterval: 30,
        showPercentage: true,
        showDeviceType: false,
        showDeviceName: false,
        showStatusText: false,
        deviceTypeFontSize: 13,
        backgroundColor: "#0d1117",
      },
    });

    const svg = decodeIcon(vi.mocked(handle.setImage).mock.calls.at(-1)?.[0] ?? "");
    expect(svg).toContain("Disconnected");
    expect(svg).toMatch(/data-cycle-index="1" data-active="true"/);
  });
});
