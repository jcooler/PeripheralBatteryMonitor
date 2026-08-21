import { describe, expect, it, vi } from "vitest";

import { BatteryAction } from "../../src/actions/battery-action";
import type { SessionRender } from "../../src/actions/action-session";
import { BatteryRuntime } from "../../src/actions/battery-runtime";
import { InspectorMessenger } from "../../src/actions/inspector-messenger";
import type { DeviceCatalog } from "../../src/devices/catalog";
import {
  makeDeviceKey,
  type BatteryStatus,
  type DeviceDescriptor,
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
  it("persists one exact Logitech migration and does not loop on its settings event", async () => {
    const canonical: DeviceDescriptor = {
      key: makeDeviceKey("logitech", "model:g502 x plus|mouse"),
      provider: "logitech",
      providerLabel: "Logitech G Hub",
      nativeId: "model:g502 x plus|mouse",
      name: "G502 X Plus",
      deviceType: "Mouse",
      physicalId: "logitech-model:model:g502 x plus|mouse",
      transientNativeIds: ["session:dev00000006"],
    };
    const legacyDevice: DeviceRef = {
      key: makeDeviceKey("logitech", "session:dev00000006"),
      provider: "logitech",
      providerLabel: "Logitech G Hub",
      nativeId: "session:dev00000006",
      name: "G502 X Plus",
      deviceType: "Mouse",
    };
    const legacy = {
      schemaVersion: 2,
      selectedDevices: [legacyDevice],
      activeDeviceKey: legacyDevice.key,
      pollInterval: 45,
      showPercentage: false,
      showDeviceType: true,
      showDeviceName: true,
      showStatusText: true,
      deviceTypeFontSize: 18,
      backgroundColor: "#123456",
    };
    const fakeRuntime = runtime(Promise.resolve({
      devices: [canonical],
      errors: [],
      notices: [],
      refreshedAt: 1,
    }));
    const handle = actionHandle(legacy);
    const action = new BatteryAction({ runtime: fakeRuntime });

    await action.onWillAppear({
      action: handle,
      payload: { settings: legacy },
    } as never);

    const persisted = vi.mocked(handle.setSettings).mock.calls[0]?.[0];
    expect(persisted?.selectedDevices).toEqual([{
      key: canonical.key,
      provider: "logitech",
      providerLabel: "Logitech G Hub",
      nativeId: canonical.nativeId,
      name: "G502 X Plus",
      deviceType: "Mouse",
      physicalId: canonical.physicalId,
    }]);
    expect(JSON.stringify(persisted)).not.toContain("dev00000006");
    expect(JSON.stringify(persisted)).not.toContain("transientNativeIds");
    expect(persisted).toMatchObject({
      schemaVersion: 2,
      activeDeviceKey: canonical.key,
      pollInterval: 45,
      showPercentage: false,
      showDeviceType: true,
      showDeviceName: true,
      showStatusText: true,
      deviceTypeFontSize: 18,
      backgroundColor: "#123456",
    });
    expect(fakeRuntime.updateSettings).toHaveBeenCalledWith(
      "context-1",
      persisted
    );
    expect(fakeRuntime.manualRefresh).toHaveBeenCalledTimes(1);

    vi.mocked(fakeRuntime.activeKey).mockReturnValue(canonical.key);
    await action.onDidReceiveSettings({
      action: handle,
      payload: { settings: persisted },
    } as never);

    expect(handle.setSettings).toHaveBeenCalledTimes(1);
    expect(fakeRuntime.manualRefresh).toHaveBeenCalledTimes(1);
  });

  it("retains a migrated middle Logitech position in the real runtime without a second settings write", async () => {
    const before = windowsKeyboard();
    const legacyNativeId = "session:dev00000006";
    const legacy: DeviceRef = {
      key: makeDeviceKey("logitech", legacyNativeId),
      provider: "logitech",
      providerLabel: "Logitech G Hub",
      nativeId: legacyNativeId,
      name: "G502 X Plus",
      deviceType: "Mouse",
    };
    const canonical: DeviceDescriptor = {
      key: makeDeviceKey("logitech", "model:g502 x plus|mouse"),
      provider: "logitech",
      providerLabel: "Logitech G Hub",
      nativeId: "model:g502 x plus|mouse",
      name: "G502 X Plus",
      deviceType: "Mouse",
      physicalId: "logitech-model:model:g502 x plus|mouse",
      transientNativeIds: [legacyNativeId],
    };
    const after: DeviceRef = {
      key: makeDeviceKey("xinput", "slot:0"),
      provider: "xinput",
      providerLabel: "XInput",
      nativeId: "slot:0",
      name: "Controller 1",
      deviceType: "Controller",
    };
    const saved = {
      schemaVersion: 2,
      selectedDevices: [before, legacy, after],
      activeDeviceKey: legacy.key,
    };
    const discovery: DiscoveryResult = {
      devices: [before, canonical, after],
      errors: [],
      notices: [],
      refreshedAt: 1,
    };
    const catalog = {
      discover: vi.fn(async () => discovery),
      invalidateDiscovery: vi.fn(),
      readStatus: vi.fn(async (device: DeviceRef): Promise<BatteryStatus> => ({
        state: "connected",
        level: { kind: "percentage", value: 75 },
        charging: false,
        provider: device.provider,
        providerLabel: device.providerLabel,
        observedAt: 1,
      })),
    } as unknown as DeviceCatalog;
    const realRuntime = new BatteryRuntime(catalog, vi.fn());
    const handle = actionHandle(saved);
    const action = new BatteryAction({ runtime: realRuntime });

    try {
      await action.onWillAppear({
        action: handle,
        payload: { settings: saved },
      } as never);
      const migrated = vi.mocked(handle.setSettings).mock.calls[0]?.[0];
      expect(migrated?.activeDeviceKey).toBe(canonical.key);

      await action.onDidReceiveSettings({
        action: handle,
        payload: { settings: migrated },
      } as never);

      expect(realRuntime.activeKey("context-1")).toBe(canonical.key);
      expect(handle.setSettings).toHaveBeenCalledTimes(1);
    } finally {
      await action.onWillDisappear({ action: handle } as never);
      realRuntime.destroy();
    }
  });

  it.each([
    {
      label: "unresolved",
      savedName: "Pro Wireless Mouse",
      devices: [{
        key: makeDeviceKey("logitech", "model:g502 x plus|mouse"),
        provider: "logitech" as const,
        providerLabel: "Logitech G Hub",
        nativeId: "model:g502 x plus|mouse",
        name: "G502 X Plus",
        deviceType: "Mouse",
      }],
    },
    {
      label: "ambiguous",
      savedName: "G502 X Plus",
      devices: ["serial:first", "serial:second"].map((nativeId) => ({
        key: makeDeviceKey("logitech", nativeId),
        provider: "logitech" as const,
        providerLabel: "Logitech G Hub",
        nativeId,
        name: "G502 X Plus",
        deviceType: "Mouse",
      })),
    },
  ])("keeps a $label Logitech row unavailable without persisting", async ({
    savedName,
    devices,
  }) => {
    const nativeId = "session:stale-endpoint";
    const savedDevice: DeviceRef = {
      key: makeDeviceKey("logitech", nativeId),
      provider: "logitech",
      providerLabel: "Logitech G Hub",
      nativeId,
      name: savedName,
      deviceType: "Mouse",
    };
    const saved = {
      schemaVersion: 2,
      selectedDevices: [savedDevice],
      activeDeviceKey: savedDevice.key,
    };
    const fakeRuntime = runtime(Promise.resolve({
      devices,
      errors: [],
      notices: [],
      refreshedAt: 1,
    }));
    const handle = actionHandle(saved);
    const action = new BatteryAction({ runtime: fakeRuntime });

    await action.onWillAppear({
      action: handle,
      payload: { settings: saved },
    } as never);

    expect(fakeRuntime.appear).toHaveBeenCalledWith("context-1", saved);
    expect(handle.setSettings).not.toHaveBeenCalled();
    expect(fakeRuntime.updateSettings).not.toHaveBeenCalled();
    expect(fakeRuntime.manualRefresh).not.toHaveBeenCalled();
  });

  it("serializes sanitized notices and labels partial provider success", async () => {
    const device = steelSeriesDevice();
    const discovery: DiscoveryResult = {
      devices: [device],
      errors: [{
        provider: "windows",
        providerLabel: "Windows Bluetooth",
        message: "Windows Bluetooth unavailable",
      }],
      notices: [{
        provider: "logitech",
        kind: "recovered",
        message: "G502 X Plus reconnected through G Hub",
        deviceKey: "logitech:model%3Ag502%20x%20plus%7Cmouse",
      }],
      refreshedAt: 42,
    };
    const fakeRuntime = runtime(Promise.resolve(discovery));
    const sent: unknown[] = [];
    const inspector = new InspectorMessenger({
      activeContextId: () => "context-1",
      send: async (message) => { sent.push(message); },
    });
    const action = new BatteryAction({ runtime: fakeRuntime, inspector });

    await action.onSendToPlugin({
      action: actionHandle({}),
      payload: { event: "getDevices" },
    } as never);

    expect(sent.at(-1)).toMatchObject({
      event: "deviceList",
      state: "partial",
      devices: [{ key: device.key }],
      errors: discovery.errors,
      notices: discovery.notices,
      refreshedAt: 42,
    });
  });

  it("never forwards provider discovery details containing identifiers, paths, stderr, or payloads", async () => {
    const sensitiveMessages = [
      ["steelseries", "serial:SS-SECRET-001"],
      ["logitech", "dev00000042"],
      ["hid", "\\\\?\\HID#VID_054C&PID_0CE6#SECRET"],
      ["windows", "BTHENUM\\DEV_AABBCCDDEEFF"],
      ["windows-gamepad", "stderr: GetGamepads failed with private output"],
      ["xinput", '{"payload": malformed'],
    ] as const;
    const discovery: DiscoveryResult = {
      devices: [steelSeriesDevice()],
      errors: sensitiveMessages.map(([provider, message]) => ({
        provider,
        providerLabel: `untrusted ${provider} label ${message}`,
        message,
      })),
      notices: [],
      refreshedAt: 42,
    };
    const sent: any[] = [];
    const action = new BatteryAction({
      runtime: runtime(Promise.resolve(discovery)),
      inspector: new InspectorMessenger({
        activeContextId: () => "context-1",
        send: async (message) => { sent.push(message); },
      }),
    });

    await action.onSendToPlugin({
      action: actionHandle({}),
      payload: { event: "getDevices" },
    } as never);

    expect(sent.at(-1)?.errors).toEqual([
      { provider: "steelseries", providerLabel: "SteelSeries GG", message: "SteelSeries GG unavailable" },
      { provider: "logitech", providerLabel: "Logitech G Hub", message: "Logitech G Hub unavailable" },
      { provider: "hid", providerLabel: "HID", message: "HID unavailable" },
      { provider: "windows", providerLabel: "Windows Bluetooth", message: "Windows Bluetooth unavailable" },
      { provider: "windows-gamepad", providerLabel: "Windows Gamepad", message: "Windows Gamepad unavailable" },
      { provider: "xinput", providerLabel: "XInput", message: "XInput unavailable" },
    ]);
    const serialized = JSON.stringify(sent.at(-1));
    expect(serialized).not.toMatch(
      /SS-SECRET-001|dev00000042|VID_054C|AABBCCDDEEFF|stderr|payload/i
    );
  });

  it("uses one fixed Inspector error when top-level discovery rejects with private data", async () => {
    const privateFailure = [
      "serial:SS-SECRET-002",
      "dev00000043",
      "\\\\?\\HID#VID_046D&PID_C548#SECRET",
      "BTHENUM\\DEV_112233445566",
      "stderr: private process output",
      '{"payload": malformed',
    ].join(" | ");
    const sent: any[] = [];
    const action = new BatteryAction({
      runtime: runtime(Promise.reject(new Error(privateFailure))),
      inspector: new InspectorMessenger({
        activeContextId: () => "context-1",
        send: async (message) => { sent.push(message); },
      }),
    });

    await action.onSendToPlugin({
      action: actionHandle({}),
      payload: { event: "refreshDevices" },
    } as never);

    expect(sent.at(-1)).toEqual({
      event: "deviceList",
      state: "error",
      message: "Device discovery failed",
      devices: [],
      errors: [],
    });
    expect(JSON.stringify(sent.at(-1))).not.toMatch(
      /SS-SECRET-002|dev00000043|VID_046D|112233445566|stderr|payload/i
    );
  });

  it("sends fixed runtime battery summaries without exposing unavailable details", async () => {
    const percentageDevice = steelSeriesDevice();
    const qualitativeDevice = windowsKeyboard();
    const unavailableDevice: DeviceRef = {
      key: makeDeviceKey("xinput", "slot:0"),
      provider: "xinput",
      providerLabel: "XInput",
      nativeId: "slot:0",
      name: "Controller 1",
      deviceType: "Controller",
    };
    const selectedDevices = [percentageDevice, qualitativeDevice, unavailableDevice];
    const persisted = { schemaVersion: 2, selectedDevices };
    const fakeRuntime = runtime(Promise.resolve({ devices: selectedDevices, errors: [], refreshedAt: 1 }));
    const handle = actionHandle(persisted);
    const sent: unknown[] = [];
    const inspector = new InspectorMessenger({
      activeContextId: () => "context-1",
      send: async (message) => { sent.push(message); },
    });
    const action = new BatteryAction({ runtime: fakeRuntime, inspector });
    await action.onWillAppear({ action: handle, payload: { settings: persisted } } as never);
    const render = (value: SessionRender) =>
      (action as unknown as {
        render(contextId: string, render: SessionRender): Promise<void>;
      }).render("context-1", value);
    const settings = {
      selectedDevices,
      pollInterval: 30,
      showPercentage: true,
      showDeviceType: false,
      showDeviceName: false,
      showStatusText: false,
      deviceTypeFontSize: 13,
      backgroundColor: "#0d1117",
    };

    await render({
      kind: "status",
      device: percentageDevice,
      status: {
        state: "connected",
        level: { kind: "percentage", value: 72 },
        charging: false,
        provider: "steelseries",
        providerLabel: "SteelSeries GG",
        observedAt: 1,
      },
      settings,
    });
    await render({
      kind: "status",
      device: qualitativeDevice,
      status: {
        state: "connected",
        level: { kind: "qualitative", value: "low" },
        charging: null,
        provider: "windows",
        providerLabel: "Windows Bluetooth",
        observedAt: 2,
      },
      settings,
    });
    await render({
      kind: "status",
      device: unavailableDevice,
      status: {
        state: "unavailable",
        level: { kind: "unavailable" },
        charging: null,
        provider: "xinput",
        providerLabel: "XInput",
        observedAt: 3,
        detail: '<img src=x onerror="globalThis.pwned=true"> secret path',
      },
      settings,
    });

    expect(sent.at(-1)).toEqual({
      event: "deviceRuntimeStatus",
      currentDeviceKey: unavailableDevice.key,
      statuses: [
        { deviceKey: percentageDevice.key, state: "connected", batteryText: "72%" },
        { deviceKey: qualitativeDevice.key, state: "connected", batteryText: "Low" },
        { deviceKey: unavailableDevice.key, state: "unavailable", batteryText: "Unavailable" },
      ],
    });
    expect(JSON.stringify(sent)).not.toContain("secret path");
    expect(JSON.stringify(sent)).not.toContain("onerror");
  });

  it.each([
    ["empty", "Empty"],
    ["low", "Low"],
    ["medium", "Medium"],
    ["full", "Full"],
  ] as const)("uses the fixed %s qualitative label in runtime summaries", async (level, label) => {
    const device = steelSeriesDevice();
    const persisted = { schemaVersion: 2, selectedDevices: [device] };
    const fakeRuntime = runtime(Promise.resolve({ devices: [device], errors: [], refreshedAt: 1 }));
    const handle = actionHandle(persisted);
    const sent: any[] = [];
    const inspector = new InspectorMessenger({
      activeContextId: () => "context-1",
      send: async (message) => { sent.push(message); },
    });
    const action = new BatteryAction({ runtime: fakeRuntime, inspector });
    await action.onWillAppear({ action: handle, payload: { settings: persisted } } as never);

    await (action as unknown as {
      render(contextId: string, render: SessionRender): Promise<void>;
    }).render("context-1", {
      kind: "status",
      device,
      status: {
        state: "connected",
        level: { kind: "qualitative", value: level },
        charging: null,
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
        showStatusText: false,
        deviceTypeFontSize: 13,
        backgroundColor: "#0d1117",
      },
    });

    expect(sent.at(-1).statuses).toEqual([
      { deviceKey: device.key, state: "connected", batteryText: label },
    ]);
  });

  it("does not let an older image completion overwrite a newer runtime summary", async () => {
    const olderDevice = steelSeriesDevice();
    const newerDevice = windowsKeyboard();
    const selectedDevices = [olderDevice, newerDevice];
    const persisted = { schemaVersion: 2, selectedDevices };
    const fakeRuntime = runtime(Promise.resolve({
      devices: selectedDevices,
      errors: [],
      refreshedAt: 1,
    }));
    const olderImage = deferred<void>();
    const newerImage = deferred<void>();
    const handle = actionHandle(persisted);
    vi.mocked(handle.setImage)
      .mockImplementationOnce(() => olderImage.promise)
      .mockImplementationOnce(() => newerImage.promise);
    const sent: any[] = [];
    const inspector = new InspectorMessenger({
      activeContextId: () => "context-1",
      send: async (message) => { sent.push(message); },
    });
    const action = new BatteryAction({ runtime: fakeRuntime, inspector });
    await action.onWillAppear({ action: handle, payload: { settings: persisted } } as never);
    const settings = {
      selectedDevices,
      pollInterval: 30,
      showPercentage: true,
      showDeviceType: false,
      showDeviceName: false,
      showStatusText: false,
      deviceTypeFontSize: 13,
      backgroundColor: "#0d1117",
    };
    const render = (value: SessionRender) =>
      (action as unknown as {
        render(contextId: string, render: SessionRender): Promise<void>;
      }).render("context-1", value);

    const olderRender = render({
      kind: "status",
      device: olderDevice,
      status: {
        state: "disconnected",
        level: { kind: "unavailable" },
        charging: null,
        provider: "steelseries",
        providerLabel: "SteelSeries GG",
        observedAt: 1,
      },
      settings,
    });
    await vi.waitFor(() => expect(handle.setImage).toHaveBeenCalledTimes(1));
    const newerRender = render({
      kind: "status",
      device: newerDevice,
      status: {
        state: "connected",
        level: { kind: "percentage", value: 72 },
        charging: false,
        provider: "windows",
        providerLabel: "Windows Bluetooth",
        observedAt: 2,
      },
      settings,
    });
    await vi.waitFor(() => expect(handle.setImage).toHaveBeenCalledTimes(2));

    newerImage.resolve(undefined);
    await newerRender;
    olderImage.resolve(undefined);
    await olderRender;

    expect(sent.filter((message) => message.event === "deviceRuntimeStatus")).toEqual([{
      event: "deviceRuntimeStatus",
      currentDeviceKey: newerDevice.key,
      statuses: [{
        deviceKey: newerDevice.key,
        state: "connected",
        batteryText: "72%",
      }],
    }]);
  });

  it("does not recreate runtime state when an in-flight image finishes after disappear", async () => {
    const device = steelSeriesDevice();
    const persisted = { schemaVersion: 2, selectedDevices: [device] };
    const fakeRuntime = runtime(Promise.resolve({
      devices: [device],
      errors: [],
      refreshedAt: 1,
    }));
    const pendingImage = deferred<void>();
    const handle = actionHandle(persisted);
    vi.mocked(handle.setImage).mockImplementationOnce(() => pendingImage.promise);
    const sent: any[] = [];
    const inspector = new InspectorMessenger({
      activeContextId: () => "context-1",
      send: async (message) => { sent.push(message); },
    });
    const action = new BatteryAction({ runtime: fakeRuntime, inspector });
    await action.onWillAppear({ action: handle, payload: { settings: persisted } } as never);

    const rendering = (action as unknown as {
      render(contextId: string, render: SessionRender): Promise<void>;
    }).render("context-1", {
      kind: "loading",
      device,
      settings: {
        selectedDevices: [device],
        pollInterval: 30,
        showPercentage: true,
        showDeviceType: false,
        showDeviceName: false,
        showStatusText: false,
        deviceTypeFontSize: 13,
        backgroundColor: "#0d1117",
      },
    });
    await vi.waitFor(() => expect(handle.setImage).toHaveBeenCalledTimes(1));
    await action.onWillDisappear({ action: handle } as never);

    pendingImage.resolve(undefined);
    await rendering;

    expect(sent.filter((message) => message.event === "deviceRuntimeStatus")).toEqual([]);
    sent.length = 0;
    await action.onSendToPlugin({ action: handle, payload: { event: "getDevices" } } as never);
    expect(sent.filter((message) => message.event === "deviceRuntimeStatus")).toEqual([]);
  });

  it("replays a cached runtime summary to the inspector and clears it on disappear", async () => {
    const device = steelSeriesDevice();
    const persisted = { schemaVersion: 2, selectedDevices: [device] };
    const discovery = { devices: [device], errors: [], refreshedAt: 1 };
    const fakeRuntime = runtime(Promise.resolve(discovery));
    const handle = actionHandle(persisted);
    const sent: any[] = [];
    const inspector = new InspectorMessenger({
      activeContextId: () => "context-1",
      send: async (message) => { sent.push(message); },
    });
    const action = new BatteryAction({ runtime: fakeRuntime, inspector });
    await action.onWillAppear({ action: handle, payload: { settings: persisted } } as never);
    await (action as unknown as {
      render(contextId: string, render: SessionRender): Promise<void>;
    }).render("context-1", {
      kind: "status",
      device,
      status: {
        state: "disconnected",
        level: { kind: "unavailable" },
        charging: null,
        provider: "steelseries",
        providerLabel: "SteelSeries GG",
        observedAt: 1,
        detail: "device may be sleeping",
      },
      settings: {
        selectedDevices: [device],
        pollInterval: 30,
        showPercentage: true,
        showDeviceType: false,
        showDeviceName: false,
        showStatusText: false,
        deviceTypeFontSize: 13,
        backgroundColor: "#0d1117",
      },
    });
    sent.length = 0;

    await action.onSendToPlugin({ action: handle, payload: { event: "getDevices" } } as never);
    expect(sent.filter((message) => message.event === "deviceRuntimeStatus")).toEqual([{
      event: "deviceRuntimeStatus",
      currentDeviceKey: device.key,
      statuses: [{ deviceKey: device.key, state: "disconnected", batteryText: "Disconnected" }],
    }]);

    await action.onWillDisappear({ action: handle } as never);
    sent.length = 0;
    await action.onSendToPlugin({ action: handle, payload: { event: "getDevices" } } as never);
    expect(sent.filter((message) => message.event === "deviceRuntimeStatus")).toEqual([]);
  });

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
