import { describe, expect, it } from "vitest";

import {
  buildDeviceRows,
  buildPluginMessage,
  buildSetSettingsMessage,
  createInspectorController,
  describeDiscoveryState,
  displaySettingsPatch,
  mergeSettings,
  moveSelectedDevice,
  renderDeviceList,
  selectedDevicesFromSettings,
  setDeviceIncluded,
} from "../../com.jcooler.peripheral-battery.sdPlugin/ui/device-list.js";

const windowsKeyboard = {
  key: "windows:BTH-2",
  provider: "windows",
  providerLabel: "untrusted label",
  nativeId: "BTH-2",
  name: "Office Keyboard",
  deviceType: "Keyboard",
};

const steelSeriesMouse = {
  key: "steelseries:7",
  provider: "steelseries",
  providerLabel: "untrusted label",
  nativeId: "7",
  name: "Aerox 5 Wireless",
  deviceType: "Mouse",
};

const xinputController = {
  key: "xinput:slot%3A0",
  provider: "xinput",
  providerLabel: "untrusted label",
  nativeId: "slot:0",
  name: "Xbox Wireless Controller",
  deviceType: "Controller",
};

const adapterController = {
  key: "windows-gamepad:raw-controller-1",
  provider: "windows-gamepad",
  providerLabel: "untrusted label",
  nativeId: "raw-controller-1",
  name: "Xbox One Game Controller",
  deviceType: "Controller",
};

describe("Property Inspector device-list model", () => {
  it("shows selected devices first in configured order and marks only the first as initial", () => {
    const rows = buildDeviceRows(
      [windowsKeyboard, steelSeriesMouse, xinputController],
      [xinputController, windowsKeyboard]
    );

    expect(rows.map((row) => ({ key: row.device.key, included: row.included, initial: row.initial }))).toEqual([
      { key: "xinput:slot%3A0", included: true, initial: true },
      { key: "windows:BTH-2", included: true, initial: false },
      { key: "steelseries:7", included: false, initial: false },
    ]);
  });

  it("retains a configured device that discovery cannot currently find", () => {
    const missing = {
      ...steelSeriesMouse,
      name: "Saved Aerox",
    };

    const rows = buildDeviceRows([windowsKeyboard], [missing]);

    expect(rows[0]).toMatchObject({
      included: true,
      available: false,
      initial: true,
      device: { key: "steelseries:7", name: "Saved Aerox" },
    });
    expect(rows[1]).toMatchObject({
      included: false,
      available: true,
      device: { key: "windows:BTH-2" },
    });
  });

  it("restores a saved gamepad only for the same exact Windows controller identity", () => {
    const sameNameBluetooth = {
      ...windowsKeyboard,
      nativeId: "BTH-XBOX",
      key: "windows:BTH-XBOX",
      name: adapterController.name,
      deviceType: "Controller",
    };

    const missingRows = buildDeviceRows(
      [sameNameBluetooth],
      [adapterController]
    );
    expect(missingRows[0]).toMatchObject({
      included: true,
      available: false,
      device: { key: "windows-gamepad:raw-controller-1" },
    });
    expect(missingRows[1]).toMatchObject({
      included: false,
      available: true,
      device: { key: "windows:BTH-XBOX" },
    });

    const restoredRows = buildDeviceRows(
      [sameNameBluetooth, adapterController],
      [adapterController]
    );
    expect(restoredRows[0]).toMatchObject({
      included: true,
      available: true,
      device: { key: "windows-gamepad:raw-controller-1" },
    });
  });

  it("retains prefixed v1 selections as exact unavailable rows", () => {
    const legacySettings = {
      deviceBrand: "steelseries",
      deviceId: 7,
      deviceName: "[SS] Saved Aerox",
    };

    expect(selectedDevicesFromSettings(legacySettings, [])).toEqual([
      expect.objectContaining({
        key: "steelseries:7",
        providerLabel: "SteelSeries GG",
        nativeId: "7",
        name: "Saved Aerox",
        deviceType: "Device",
      }),
    ]);
    const rows = buildDeviceRows(
      [],
      selectedDevicesFromSettings(legacySettings, [])
    );
    expect(rows[0]).toMatchObject({
      included: true,
      available: false,
      initial: true,
    });
  });

  it("uses trusted human-readable provider labels for every supported provider", () => {
    const inputs = [
      steelSeriesMouse,
      windowsKeyboard,
      adapterController,
      xinputController,
      { ...steelSeriesMouse, key: "logitech:mouse-1", provider: "logitech", nativeId: "mouse-1" },
      { ...steelSeriesMouse, key: "hid:pad-1", provider: "hid", nativeId: "pad-1" },
    ];

    expect(buildDeviceRows(inputs, []).map((row) => row.device.providerLabel)).toEqual([
      "SteelSeries GG",
      "Windows Bluetooth",
      "Windows Gamepad",
      "XInput",
      "Logitech G Hub",
      "HID",
    ]);
  });

  it("ignores malformed and duplicate catalog entries instead of creating duplicate controls", () => {
    const rows = buildDeviceRows(
      [windowsKeyboard, { ...windowsKeyboard, name: "Duplicate" }, { name: "Broken" }],
      []
    );

    expect(rows.map((row) => row.device.name)).toEqual(["Office Keyboard"]);
  });

  it("represents a reliable physical identity once without switching a configured provider", () => {
    const savedWindowsDevice = {
      ...windowsKeyboard,
      physicalId: "container:controller-1",
    };
    const discoveredHidDuplicate = {
      key: "hid:controller-1",
      provider: "hid",
      providerLabel: "HID",
      nativeId: "controller-1",
      name: "Controller through HID",
      deviceType: "Controller",
      physicalId: "container:controller-1",
    };
    const keyDistinctWithoutPhysicalIdentity = {
      ...discoveredHidDuplicate,
      key: "hid:controller-2",
      nativeId: "controller-2",
      name: "Controller without physical identity",
      physicalId: undefined,
    };

    const configuredRows = buildDeviceRows(
      [discoveredHidDuplicate, keyDistinctWithoutPhysicalIdentity],
      [savedWindowsDevice]
    );
    const discoveryOnlyRows = buildDeviceRows(
      [discoveredHidDuplicate, savedWindowsDevice, keyDistinctWithoutPhysicalIdentity],
      []
    );
    const configuredProviderDiscovered = buildDeviceRows(
      [discoveredHidDuplicate, savedWindowsDevice],
      [savedWindowsDevice]
    );

    expect(configuredRows.map((row) => row.device.key)).toEqual([
      "windows:BTH-2",
      "hid:controller-2",
    ]);
    expect(configuredRows[0]).toMatchObject({ included: true, available: false });
    expect(discoveryOnlyRows.map((row) => row.device.key)).toEqual([
      "hid:controller-1",
      "hid:controller-2",
    ]);
    expect(configuredProviderDiscovered).toHaveLength(1);
    expect(configuredProviderDiscovered[0]).toMatchObject({
      included: true,
      available: true,
      device: { key: "windows:BTH-2" },
    });
    expect(
      setDeviceIncluded([savedWindowsDevice], discoveredHidDuplicate, true).map(
        (device) => device.key
      )
    ).toEqual(["windows:BTH-2"]);
  });

  it("adds newly included devices to the end and removes only the unchecked device", () => {
    const selected = [windowsKeyboard, steelSeriesMouse];

    const withController = setDeviceIncluded(selected, xinputController, true);
    const withoutKeyboard = setDeviceIncluded(withController, windowsKeyboard, false);

    expect(withController.map((device) => device.key)).toEqual([
      "windows:BTH-2",
      "steelseries:7",
      "xinput:slot%3A0",
    ]);
    expect(withoutKeyboard.map((device) => device.key)).toEqual([
      "steelseries:7",
      "xinput:slot%3A0",
    ]);
  });

  it("moves one selected device one position without disturbing the rest", () => {
    const selected = [windowsKeyboard, steelSeriesMouse, xinputController];

    expect(moveSelectedDevice(selected, "xinput:slot%3A0", "up").map((device) => device.key)).toEqual([
      "windows:BTH-2",
      "xinput:slot%3A0",
      "steelseries:7",
    ]);
    expect(moveSelectedDevice(selected, "windows:BTH-2", "up").map((device) => device.key)).toEqual([
      "windows:BTH-2",
      "steelseries:7",
      "xinput:slot%3A0",
    ]);
  });

  it("preserves the ordered device list when a display option changes", () => {
    const selectedDevices = [windowsKeyboard, steelSeriesMouse];
    const current = { schemaVersion: 2, selectedDevices, showDeviceName: false, customSetting: "keep" };

    const next = mergeSettings(current, { showDeviceName: true });

    expect(next).toEqual({
      schemaVersion: 2,
      selectedDevices,
      showDeviceName: true,
      customSetting: "keep",
    });
    expect(next.selectedDevices).toBe(selectedDevices);
  });

  it("creates complete Stream Deck websocket envelopes for settings and plugin messages", () => {
    expect(
      buildSetSettingsMessage({
        action: "com.jcooler.peripheral-battery.monitor",
        context: "context-1",
        settings: { schemaVersion: 2, selectedDevices: [windowsKeyboard] },
      })
    ).toEqual({
      event: "setSettings",
      action: "com.jcooler.peripheral-battery.monitor",
      context: "context-1",
      payload: { schemaVersion: 2, selectedDevices: [windowsKeyboard] },
    });

    expect(
      buildPluginMessage({
        action: "com.jcooler.peripheral-battery.monitor",
        context: "context-1",
        payload: { event: "refreshDevices" },
      })
    ).toEqual({
      event: "sendToPlugin",
      action: "com.jcooler.peripheral-battery.monitor",
      context: "context-1",
      payload: { event: "refreshDevices" },
    });
  });

  it("describes loading, success, empty, and error discovery states", () => {
    expect(describeDiscoveryState({ state: "loading" })).toEqual({ tone: "loading", text: "Loading devices…" });
    expect(describeDiscoveryState({ state: "success", devices: [windowsKeyboard] })).toEqual({
      tone: "success",
      text: "1 device found",
    });
    expect(describeDiscoveryState({ state: "empty" })).toEqual({
      tone: "empty",
      text: "No battery devices found. Refresh after connecting a device.",
    });
    expect(describeDiscoveryState({ state: "error", message: "Windows scan failed" })).toEqual({
      tone: "error",
      text: "Windows scan failed",
    });
  });

  it("maps every existing display control to its persisted setting", () => {
    expect(displaySettingsPatch("pollInterval", "60", false)).toEqual({ pollInterval: 60 });
    expect(displaySettingsPatch("showPercentage", "", false)).toEqual({ showPercentage: false });
    expect(displaySettingsPatch("showDeviceType", "", true)).toEqual({ showDeviceType: true });
    expect(displaySettingsPatch("showDeviceName", "", true)).toEqual({ showDeviceName: true });
    expect(displaySettingsPatch("showStatusText", "", true)).toEqual({ showStatusText: true });
    expect(displaySettingsPatch("deviceTypeFontSize", "18", false)).toEqual({ deviceTypeFontSize: 18 });
    expect(displaySettingsPatch("backgroundColor", "#123456", false)).toEqual({ backgroundColor: "#123456" });
    expect(displaySettingsPatch("unknown", "value", false)).toEqual({});
  });

  it("renders one accessible inclusion control per device with ordered controls for selected devices", () => {
    const document = new FakeDocument();
    const list = document.createElement("ol");
    const included: Array<[string, boolean]> = [];
    const moved: Array<[string, string]> = [];
    const rows = buildDeviceRows(
      [windowsKeyboard, steelSeriesMouse, xinputController],
      [xinputController, windowsKeyboard]
    );

    renderDeviceList(list, rows, {
      onIncluded: (device, checked) => included.push([device.key, checked]),
      onMove: (key, direction) => moved.push([key, direction]),
    });

    expect(findAll(list, "input")).toHaveLength(3);
    expect(findAll(list, "input").map((input) => input.attributes.get("aria-label"))).toEqual([
      "Include Xbox Wireless Controller in cycle",
      "Include Office Keyboard in cycle",
      "Include Aerox 5 Wireless in cycle",
    ]);
    expect(findAll(list, "button").map((button) => button.attributes.get("aria-label"))).toEqual([
      "Move Xbox Wireless Controller up",
      "Move Xbox Wireless Controller down",
      "Move Office Keyboard up",
      "Move Office Keyboard down",
    ]);
    expect(collectText(list)).toContain("Default");
    expect(collectText(list)).not.toContain("Initial");
    expect(collectText(list)).toContain("XInput");
    expect(collectText(list)).toContain("Windows Bluetooth");

    const inputs = findAll(list, "input");
    inputs[2].checked = true;
    inputs[2].dispatch("change");
    findAll(list, "button")[1].dispatch("click");
    expect(included).toEqual([["steelseries:7", true]]);
    expect(moved).toEqual([["xinput:slot%3A0", "down"]]);
  });

  it("renders untrusted device names as text and labels configured missing devices unavailable", () => {
    const document = new FakeDocument();
    const list = document.createElement("ol");
    const malicious = {
      ...steelSeriesMouse,
      name: '<img src=x onerror="globalThis.pwned=true">',
    };

    renderDeviceList(list, buildDeviceRows([], [malicious]), {
      onIncluded() {},
      onMove() {},
    });

    expect(findAll(list, "img")).toHaveLength(0);
    expect(collectText(list)).toContain('<img src=x onerror="globalThis.pwned=true">');
    expect(collectText(list)).toContain("Unavailable");
  });

  it("requests cached discovery on open and a deliberate refresh from the refresh control", () => {
    const sent: unknown[] = [];
    const statuses: unknown[] = [];
    const controller = createInspectorController({
      send: (message) => sent.push(message),
      view: {
        applySettings() {},
        renderRows() {},
        showStatus: (status) => statuses.push(status),
      },
    });

    controller.open({
      action: "com.jcooler.peripheral-battery.monitor",
      context: "context-1",
      settings: { schemaVersion: 2, selectedDevices: [] },
    });
    controller.refresh();

    expect(sent).toEqual([
      {
        event: "sendToPlugin",
        action: "com.jcooler.peripheral-battery.monitor",
        context: "context-1",
        payload: { event: "getDevices" },
      },
      {
        event: "sendToPlugin",
        action: "com.jcooler.peripheral-battery.monitor",
        context: "context-1",
        payload: { event: "refreshDevices" },
      },
    ]);
    expect(statuses).toEqual([
      { tone: "loading", text: "Loading devices…" },
      { tone: "loading", text: "Loading devices…" },
    ]);
  });

  it("persists inclusion, ordering, and display edits without losing the selected list", () => {
    const sent: any[] = [];
    const controller = createInspectorController({
      send: (message) => sent.push(message),
      view: { applySettings() {}, renderRows() {}, showStatus() {} },
    });
    controller.open({
      action: "com.jcooler.peripheral-battery.monitor",
      context: "context-1",
      settings: { schemaVersion: 2, selectedDevices: [windowsKeyboard], showDeviceName: false },
    });
    sent.length = 0;

    controller.include(steelSeriesMouse, true);
    controller.move("steelseries:7", "up");
    controller.changeSettings({ showDeviceName: true });

    expect(sent).toHaveLength(3);
    expect(sent[0].payload.selectedDevices.map((device: any) => device.key)).toEqual([
      "windows:BTH-2",
      "steelseries:7",
    ]);
    expect(sent[1].payload.selectedDevices.map((device: any) => device.key)).toEqual([
      "steelseries:7",
      "windows:BTH-2",
    ]);
    expect(sent[2].payload).toMatchObject({
      showDeviceName: true,
      selectedDevices: [
        expect.objectContaining({ key: "steelseries:7" }),
        expect.objectContaining({ key: "windows:BTH-2" }),
      ],
    });
    expect(sent.every((message) => message.action && message.context && message.event === "setSettings")).toBe(true);
  });

  it("preserves a legacy unavailable selection when including another device", () => {
    const sent: any[] = [];
    const controller = createInspectorController({
      send: (message) => sent.push(message),
      view: { applySettings() {}, renderRows() {}, showStatus() {} },
    });
    controller.open({
      action: "action",
      context: "context",
      settings: {
        deviceBrand: "steelseries",
        deviceId: 7,
        deviceName: "[SS] Saved Aerox",
      },
    });
    controller.receiveDeviceList({
      state: "success",
      devices: [windowsKeyboard],
    });
    sent.length = 0;

    controller.include(windowsKeyboard, true);

    expect(sent[0].payload.selectedDevices.map((device: any) => device.key)).toEqual([
      "steelseries:7",
      "windows:BTH-2",
    ]);
  });

  it("keeps configured missing devices visible across empty and error discovery results", () => {
    const rendered: any[] = [];
    const statuses: unknown[] = [];
    const controller = createInspectorController({
      send() {},
      view: {
        applySettings() {},
        renderRows: (rows) => rendered.push(rows),
        showStatus: (status) => statuses.push(status),
      },
    });
    controller.open({
      action: "action",
      context: "context",
      settings: { schemaVersion: 2, selectedDevices: [steelSeriesMouse] },
    });

    controller.receiveDeviceList({ state: "empty", devices: [] });
    controller.receiveDeviceList({ state: "error", message: "HID scan failed", devices: [] });

    expect(rendered.at(-1)[0]).toMatchObject({
      included: true,
      available: false,
      device: { key: "steelseries:7" },
    });
    expect(statuses.slice(-2)).toEqual([
      { tone: "empty", text: "No battery devices found. Refresh after connecting a device." },
      { tone: "error", text: "HID scan failed" },
    ]);
  });
});

class FakeDocument {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }
}

class FakeElement {
  readonly tagName: string;
  readonly ownerDocument: FakeDocument;
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<() => void>>();
  textContent = "";
  className = "";
  id = "";
  type = "";
  checked = false;
  disabled = false;

  constructor(tagName: string, ownerDocument: FakeDocument) {
    this.tagName = tagName.toLowerCase();
    this.ownerDocument = ownerDocument;
  }

  set innerHTML(_value: string) {
    throw new Error("renderDeviceList must not use innerHTML");
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...children);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(name: string, listener: () => void): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  dispatch(name: string): void {
    for (const listener of this.listeners.get(name) ?? []) listener();
  }
}

function findAll(root: FakeElement, tagName: string): FakeElement[] {
  const found = root.tagName === tagName ? [root] : [];
  for (const child of root.children) found.push(...findAll(child, tagName));
  return found;
}

function collectText(root: FakeElement): string {
  return [root.textContent, ...root.children.map(collectText)].join(" ");
}
