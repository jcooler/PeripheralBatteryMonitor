import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildDeviceRows,
  buildPluginMessage,
  buildSetSettingsMessage,
  createInspectorController,
  describeDiscoveryState,
  displaySettingsPatch,
  formatLastSeenAge,
  mergeSettings,
  moveSelectedDevice,
  reorderSelectedDevice,
  renderDeviceList,
  renderInspectorAnnouncement,
  renderInspectorRecovery,
  renderInspectorStatus,
  routeInspectorMessage,
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

const logitechMouse = {
  key: "logitech:model%3Ag502%20x%20plus%20wireless%20gaming%20mouse%7Cmouse",
  provider: "logitech",
  providerLabel: "untrusted label",
  nativeId: "model:g502 x plus wireless gaming mouse|mouse",
  name: "G502 X Plus",
  deviceType: "Mouse",
};

const logitechKeyboard = {
  key: "logitech:model%3Ag915%7Ckeyboard",
  provider: "logitech",
  providerLabel: "untrusted label",
  nativeId: "model:g915|keyboard",
  name: "G915",
  deviceType: "Keyboard",
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

  it.each([
    {
      label: "schema-v2 name mismatch",
      settings: {
        schemaVersion: 2,
        selectedDevices: [{
          ...steelSeriesMouse,
          name: "Saved Aerox 5 Wireless",
        }],
      },
      saved: { ...steelSeriesMouse, name: "Saved Aerox 5 Wireless" },
      discovered: { ...steelSeriesMouse, name: "Replacement Aerox 9 Wireless" },
    },
    {
      label: "schema-v2 type mismatch",
      settings: {
        schemaVersion: 2,
        selectedDevices: [{
          ...steelSeriesMouse,
          name: "Saved Aerox 5 Wireless",
        }],
      },
      saved: { ...steelSeriesMouse, name: "Saved Aerox 5 Wireless" },
      discovered: {
        ...steelSeriesMouse,
        name: "Saved Aerox 5 Wireless",
        deviceType: "Headset",
      },
    },
    {
      label: "v1 recycled name with a compatible generic type",
      settings: {
        deviceBrand: "steelseries",
        deviceId: 7,
        deviceName: "[SS] Saved Aerox 5 Wireless",
      },
      saved: {
        ...steelSeriesMouse,
        name: "Saved Aerox 5 Wireless",
        deviceType: "Device",
      },
      discovered: { ...steelSeriesMouse, name: "Replacement Aerox 9 Wireless" },
    },
  ])("keeps a recycled SteelSeries $label as separate unavailable and replacement rows", ({
    settings,
    saved,
    discovered,
  }) => {
    const hydrated = selectedDevicesFromSettings(settings, [discovered]);

    expect(hydrated).toMatchObject([{
      key: saved.key,
      name: saved.name,
      deviceType: saved.deviceType,
    }]);
    expect(buildDeviceRows([discovered], hydrated)).toMatchObject([
      {
        included: true,
        available: false,
        device: {
          key: saved.key,
          name: saved.name,
          deviceType: saved.deviceType,
        },
      },
      {
        included: false,
        available: true,
        device: {
          key: discovered.key,
          name: discovered.name,
          deviceType: discovered.deviceType,
        },
      },
    ]);
  });

  it.each([
    {
      label: "schema-v2",
      settings: {
        schemaVersion: 2,
        selectedDevices: [{
          ...steelSeriesMouse,
          name: "Saved Aerox 5 Wireless",
        }],
      },
    },
    {
      label: "v1",
      settings: {
        deviceBrand: "steelseries",
        deviceId: 7,
        deviceName: "[SS] Saved Aerox 5 Wireless",
      },
    },
  ])("requires explicit replacement selection without silently persisting $label metadata", ({ settings }) => {
    const replacement = {
      ...steelSeriesMouse,
      name: "Replacement Aerox 9 Wireless",
      deviceType: "Mouse",
    };
    const sent: any[] = [];
    const rendered: any[] = [];
    const controller = createInspectorController({
      send: (message) => sent.push(message),
      view: {
        applySettings() {},
        renderRows: (rows) => rendered.push(rows),
        showStatus() {},
      },
    });
    controller.open({ action: "action", context: "context", settings });
    sent.length = 0;

    controller.receiveDeviceList({ state: "success", devices: [replacement] });

    expect(sent).toEqual([]);
    expect(rendered.at(-1)).toMatchObject([
      { included: true, available: false, device: { name: "Saved Aerox 5 Wireless" } },
      { included: false, available: true, device: { name: "Replacement Aerox 9 Wireless" } },
    ]);

    controller.include(replacement, true);

    expect(sent).toHaveLength(1);
    expect(sent[0].payload.selectedDevices).toMatchObject([{
      key: replacement.key,
      providerLabel: "SteelSeries GG",
      name: replacement.name,
      deviceType: replacement.deviceType,
    }]);
    expect(rendered.at(-1)).toMatchObject([
      { included: true, available: true, device: { name: "Replacement Aerox 9 Wireless" } },
    ]);
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
      "Logitech",
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

  it("moves selected devices to a requested valid cycle position without disturbing the rest", () => {
    const selected = [windowsKeyboard, steelSeriesMouse, xinputController];

    expect(reorderSelectedDevice(selected, "windows:BTH-2", 2).map((device) => device.key)).toEqual([
      "steelseries:7",
      "xinput:slot%3A0",
      "windows:BTH-2",
    ]);
    expect(reorderSelectedDevice(selected, "steelseries:7", 0).map((device) => device.key)).toEqual([
      "steelseries:7",
      "windows:BTH-2",
      "xinput:slot%3A0",
    ]);
    expect(reorderSelectedDevice(selected, "xinput:slot%3A0", 0).map((device) => device.key)).toEqual([
      "xinput:slot%3A0",
      "windows:BTH-2",
      "steelseries:7",
    ]);
  });

  it("ignores invalid reorder commands and keeps discovery-only rows separate", () => {
    const selected = [windowsKeyboard, steelSeriesMouse];
    const invalidKey = reorderSelectedDevice(selected, "missing", 0);
    const invalidIndex = reorderSelectedDevice(selected, "windows:BTH-2", 4);

    expect(invalidKey.map((device) => device.key)).toEqual([
      "windows:BTH-2",
      "steelseries:7",
    ]);
    expect(invalidIndex.map((device) => device.key)).toEqual([
      "windows:BTH-2",
      "steelseries:7",
    ]);
    expect(buildDeviceRows([windowsKeyboard, steelSeriesMouse, xinputController], invalidIndex).map((row) => ({
      key: row.device.key,
      included: row.included,
    }))).toEqual([
      { key: "windows:BTH-2", included: true },
      { key: "steelseries:7", included: true },
      { key: "xinput:slot%3A0", included: false },
    ]);
  });

  it("adapts valid Alt-arrow directions through the same index reorder model", () => {
    const selected = [windowsKeyboard, steelSeriesMouse, xinputController];

    expect(moveSelectedDevice(selected, "steelseries:7", "up")).toEqual(
      reorderSelectedDevice(selected, "steelseries:7", 0)
    );
    expect(moveSelectedDevice(selected, "steelseries:7", "down")).toEqual(
      reorderSelectedDevice(selected, "steelseries:7", 2)
    );
    expect(moveSelectedDevice(selected, "steelseries:7", "sideways").map((device) => device.key)).toEqual(
      ["windows:BTH-2", "steelseries:7", "xinput:slot%3A0"]
    );
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
    expect(describeDiscoveryState({ state: "partial", devices: [windowsKeyboard] })).toEqual({
      tone: "partial",
      text: "1 device found; some providers failed",
    });
  });

  it("renders hostile discovery status and reorder announcements only as text", () => {
    const document = new FakeDocument();
    const status = document.createElement("div");
    const refresh = document.createElement("button");
    const announcement = document.createElement("div");
    const recovery = document.createElement("div");
    const hostileStatus = '<img src=x onerror="globalThis.statusPwned=true">';
    const hostileAnnouncement = '<svg onload="globalThis.announcePwned=true">';

    renderInspectorStatus(status, refresh, { tone: "error", text: hostileStatus });
    renderInspectorAnnouncement(announcement, hostileAnnouncement);
    renderInspectorRecovery(recovery, hostileAnnouncement);

    expect(status.textContent).toBe(hostileStatus);
    expect(announcement.textContent).toBe(hostileAnnouncement);
    expect(recovery.textContent).toBe(hostileAnnouncement);
    expect(findAll(status, "img")).toHaveLength(0);
    expect(findAll(announcement, "svg")).toHaveLength(0);
    expect(findAll(recovery, "svg")).toHaveLength(0);
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

  it("renders numbered selected rows with a single drag grip and unselected inclusion checkboxes", () => {
    const document = new FakeDocument();
    const list = document.createElement("ol");
    const included: Array<[string, boolean]> = [];
    const reordered: Array<[string, number]> = [];
    const rows = buildDeviceRows(
      [windowsKeyboard, steelSeriesMouse, xinputController],
      [xinputController, windowsKeyboard]
    );

    renderDeviceList(list, rows, {
      onIncluded: (device, checked) => included.push([device.key, checked]),
      onReorder: (key, targetIndex) => reordered.push([key, targetIndex]),
    });

    expect(findAll(list, "input")).toHaveLength(1);
    expect(findAll(list, "input").map((input) => input.attributes.get("aria-label"))).toEqual([
      "Include Aerox 5 Wireless in cycle",
    ]);
    expect(findByClass(list, "cycle-position").map((position) => position.textContent)).toEqual(["1", "2"]);
    expect(findByClass(list, "drag-grip")).toHaveLength(2);
    expect(findByClass(list, "order-button")).toHaveLength(0);
    expect(findByClass(list, "device-row-selected").map((row) => row.attributes.get("tabindex"))).toEqual(["0", "0"]);
    expect(findByClass(list, "drag-grip").map((grip) => grip.attributes.get("aria-label"))).toEqual([
      "Drag Xbox Wireless Controller to reorder",
      "Drag Office Keyboard to reorder",
    ]);
    expect(findByClass(list, "device-row-selected").map((row) => row.attributes.get("aria-label"))).toEqual([
      "Xbox Wireless Controller, position 1 of 2. Use Alt+Arrow keys to reorder.",
      "Office Keyboard, position 2 of 2. Use Alt+Arrow keys to reorder.",
    ]);
    expect(collectText(list)).toContain("XInput");
    expect(collectText(list)).toContain("Windows Bluetooth");
    expect(selectedRowsChildren(list)).toEqual([
      ["cycle-position", "device-identity", "drag-grip"],
      ["cycle-position", "device-identity", "drag-grip"],
    ]);

    const inputs = findAll(list, "input");
    inputs[0].checked = true;
    inputs[0].dispatch("change");
    expect(included).toEqual([["steelseries:7", true]]);
    expect(reordered).toEqual([]);
  });

  it("renders accessible Remove actions inside ordinary, active, and missing selected identities", () => {
    const document = new FakeDocument();
    const list = document.createElement("ol");
    const included: Array<[string, boolean]> = [];
    const rows = buildDeviceRows(
      [windowsKeyboard, steelSeriesMouse],
      [windowsKeyboard, steelSeriesMouse, xinputController],
      {
        currentDeviceKey: steelSeriesMouse.key,
        statuses: [{
          deviceKey: steelSeriesMouse.key,
          state: "connected",
          batteryText: "72%",
        }],
      }
    );

    renderDeviceList(list, rows, {
      onIncluded: (device, checked) => included.push([device.key, checked]),
      onReorder() {},
    });

    const selectedRows = findByClass(list, "device-row-selected");
    const removeButtons = findByClass(list, "remove-device");
    expect(selectedRows).toHaveLength(3);
    expect(findByClass(list, "device-row-current")).toHaveLength(1);
    expect(findByClass(list, "device-row-missing")).toHaveLength(1);
    expect(selectedRowsChildren(list)).toEqual([
      ["cycle-position", "device-identity", "drag-grip"],
      ["cycle-position", "device-identity", "drag-grip"],
      ["cycle-position", "device-identity", "drag-grip"],
    ]);
    expect(removeButtons.map((button) => button.type)).toEqual([
      "button",
      "button",
      "button",
    ]);
    expect(removeButtons.map((button) => button.attributes.get("aria-label"))).toEqual([
      "Remove Office Keyboard from cycle",
      "Remove Aerox 5 Wireless from cycle",
      "Remove Xbox Wireless Controller from cycle",
    ]);
    expect(selectedRows.map((row) =>
      findAll(findByClass(row, "device-identity")[0], "button").length
    )).toEqual([1, 1, 1]);

    for (const button of removeButtons) button.dispatch("click");
    expect(included).toEqual([
      ["windows:BTH-2", false],
      ["steelseries:7", false],
      ["xinput:slot%3A0", false],
    ]);
  });

  it("merges runtime summaries into exact device keys and renders current connection and battery state", () => {
    const rendered: any[] = [];
    const controller = createInspectorController({
      send() {},
      view: {
        applySettings() {},
        renderRows: (rows) => rendered.push(rows),
        showStatus() {},
      },
    });
    controller.open({
      action: "action",
      context: "context",
      settings: { schemaVersion: 2, selectedDevices: [windowsKeyboard, steelSeriesMouse] },
    });
    controller.receiveDeviceList({
      state: "success",
      devices: [windowsKeyboard, steelSeriesMouse, xinputController],
    });

    controller.receiveRuntimeStatus({
      currentDeviceKey: "windows:BTH-2",
      statuses: [
        { deviceKey: "windows:BTH-2", state: "connected", batteryText: "72%" },
        { deviceKey: "steelseries:7", state: "disconnected", batteryText: "Disconnected" },
        { deviceKey: "xinput:slot%3A0", state: "unavailable", batteryText: "Unavailable" },
        { deviceKey: "windows-gamepad:raw-controller-1", state: "connected", batteryText: "99%" },
      ],
    });

    expect(rendered.at(-1)).toMatchObject([
      {
        current: true,
        runtimeStatus: { state: "connected", batteryText: "72%" },
        device: { key: "windows:BTH-2" },
      },
      {
        current: false,
        runtimeStatus: { state: "disconnected", batteryText: "Disconnected" },
        device: { key: "steelseries:7" },
      },
      {
        current: false,
        runtimeStatus: { state: "unavailable", batteryText: "Unavailable" },
        device: { key: "xinput:slot%3A0" },
      },
    ]);

    const document = new FakeDocument();
    const list = document.createElement("ol");
    renderDeviceList(list, rendered.at(-1), { onIncluded() {}, onReorder() {} });
    expect(findByClass(list, "device-row-current")).toHaveLength(1);
    expect(collectText(list)).toContain("Connected");
    expect(collectText(list)).toContain("72%");
    expect(collectText(list)).toContain("Disconnected");
    expect(collectText(list)).toContain("Unavailable");
    expect(collectText(list)).not.toContain("99%");
  });

  it("formats trusted last-seen ages at minute, hour, and day boundaries", () => {
    const now = 1_800_000_000_000;

    expect(formatLastSeenAge(now - 15 * 60 * 1_000, now)).toBe("Last seen 15m ago");
    expect(formatLastSeenAge(now - 23 * 60 * 1_000, now)).toBe("Last seen 23m ago");
    expect(formatLastSeenAge(now - 59 * 60 * 1_000, now)).toBe("Last seen 59m ago");
    expect(formatLastSeenAge(now - 60 * 60 * 1_000, now)).toBe("Last seen 1h ago");
    expect(formatLastSeenAge(now - 23 * 60 * 60 * 1_000, now)).toBe("Last seen 23h ago");
    expect(formatLastSeenAge(now - 24 * 60 * 60 * 1_000, now)).toBe("Last seen 1d ago");
    expect(formatLastSeenAge(now - 30 * 24 * 60 * 60 * 1_000, now)).toBe("Last seen 30d ago");
  });

  it("accepts only complete connected last-known runtime statuses and renders their trusted freshness text", () => {
    const observedAt = Date.now() - 15 * 60 * 1_000;
    const rows = buildDeviceRows(
      [windowsKeyboard, steelSeriesMouse, xinputController],
      [windowsKeyboard, steelSeriesMouse, xinputController],
      {
        statuses: [
          {
            deviceKey: windowsKeyboard.key,
            state: "connected",
            batteryText: "~85%",
            freshness: "last-known",
            observedAt,
          },
          {
            deviceKey: steelSeriesMouse.key,
            state: "disconnected",
            batteryText: "~72%",
            freshness: "last-known",
            observedAt,
          },
          {
            deviceKey: xinputController.key,
            state: "connected",
            batteryText: "85%",
            freshness: "last-known",
            observedAt,
          },
        ],
      }
    );
    const document = new FakeDocument();
    const list = document.createElement("ol");

    renderDeviceList(list, rows, { onIncluded() {}, onReorder() {} });

    expect(rows[0].runtimeStatus).toMatchObject({
      batteryText: "~85%",
      freshness: "last-known",
      observedAt,
    });
    expect(rows.slice(1).map((row) => row.runtimeStatus)).toEqual([null, null]);
    expect(findByClass(list, "freshness-label").map((node) => node.textContent)).toEqual([
      "Last seen 15m ago",
    ]);
  });

  it("rejects a last-known runtime status when any required field is malformed", () => {
    const now = Date.now();
    const rows = buildDeviceRows(
      [windowsKeyboard, steelSeriesMouse, xinputController, logitechMouse, logitechKeyboard],
      [windowsKeyboard, steelSeriesMouse, xinputController, logitechMouse, logitechKeyboard],
      {
        statuses: [
          { deviceKey: windowsKeyboard.key, state: "connected", batteryText: "~85%", freshness: "last-known", observedAt: Number.NaN },
          { deviceKey: steelSeriesMouse.key, state: "connected", batteryText: "~85%", freshness: "last-known", observedAt: -1 },
          { deviceKey: xinputController.key, state: "connected", batteryText: "~85%", freshness: "last-known", observedAt: now + 24 * 60 * 60 * 1_000 },
          { deviceKey: logitechMouse.key, state: "connected", batteryText: "~85%", freshness: "last-known", observedAt: now - 31 * 24 * 60 * 60 * 1_000 },
          { deviceKey: logitechKeyboard.key, state: "connected", batteryText: "~0%", freshness: "fresh", observedAt: now },
        ],
      }
    );

    expect(rows.map((row) => row.runtimeStatus)).toEqual([null, null, null, null, null]);
  });

  it("renders only trusted Logitech source labels beside the public provider label", () => {
    const rows = buildDeviceRows(
      [logitechMouse, logitechKeyboard, windowsKeyboard],
      [logitechMouse, logitechKeyboard, windowsKeyboard],
      {
        currentDeviceKey: logitechMouse.key,
        statuses: [
          {
            deviceKey: logitechMouse.key,
            state: "connected",
            batteryText: "73%",
            source: "Direct HID++",
          },
          {
            deviceKey: logitechKeyboard.key,
            state: "connected",
            batteryText: "48%",
            source: "G Hub fallback",
          },
          {
            deviceKey: windowsKeyboard.key,
            state: "connected",
            batteryText: "80%",
            source: '<img src=x onerror="globalThis.pwned=true">',
          },
        ],
      }
    );
    const document = new FakeDocument();
    const list = document.createElement("ol");

    renderDeviceList(list, rows, { onIncluded() {}, onReorder() {} });

    expect(findByClass(list, "provider-label").map((node) => node.textContent)).toEqual([
      "Logitech",
      "Logitech",
      "Windows Bluetooth",
    ]);
    expect(findByClass(list, "source-label").map((node) => node.textContent)).toEqual([
      "Direct HID++",
      "G Hub fallback",
    ]);
    expect(collectText(list)).not.toContain("onerror");
  });

  it("keeps runtime summaries out of persisted settings", () => {
    const sent: any[] = [];
    const controller = createInspectorController({
      send: (message) => sent.push(message),
      view: { applySettings() {}, renderRows() {}, showStatus() {} },
    });
    controller.open({
      action: "action",
      context: "context",
      settings: { schemaVersion: 2, selectedDevices: [windowsKeyboard] },
    });
    controller.receiveRuntimeStatus({
      currentDeviceKey: windowsKeyboard.key,
      statuses: [{ deviceKey: windowsKeyboard.key, state: "connected", batteryText: "72%" }],
    });
    sent.length = 0;

    controller.changeSettings({ showDeviceName: true });

    expect(sent[0].payload).toMatchObject({ showDeviceName: true });
    expect(sent[0].payload).not.toHaveProperty("currentDeviceKey");
    expect(sent[0].payload).not.toHaveProperty("statuses");
  });

  it("drops non-persistent runtime state when the inspector opens another context", () => {
    const rendered: any[] = [];
    const controller = createInspectorController({
      send() {},
      view: {
        applySettings() {},
        renderRows: (rows) => rendered.push(rows),
        showStatus() {},
      },
    });
    const connection = {
      action: "action",
      settings: { schemaVersion: 2, selectedDevices: [windowsKeyboard] },
    };
    controller.open({ ...connection, context: "context-1" });
    controller.receiveDeviceList({ state: "success", devices: [windowsKeyboard] });
    controller.receiveRuntimeStatus({
      currentDeviceKey: windowsKeyboard.key,
      statuses: [{ deviceKey: windowsKeyboard.key, state: "connected", batteryText: "72%" }],
    });

    controller.open({ ...connection, context: "context-2" });

    expect(rendered.at(-1)[0]).toMatchObject({
      current: false,
      runtimeStatus: null,
    });
  });

  it("shows recovery only for recovered notices and clears it on ordinary interaction and refresh", () => {
    const recovery: string[] = [];
    const controller = createInspectorController({
      send() {},
      view: {
        applySettings() {},
        renderRows() {},
        showStatus() {},
        showRecovery: (text) => recovery.push(text),
      },
    });
    controller.open({
      action: "action",
      context: "context",
      settings: { schemaVersion: 2, selectedDevices: [windowsKeyboard] },
    });
    controller.receiveDeviceList({
      state: "success",
      devices: [windowsKeyboard],
      notices: [{ provider: "forged", kind: "recovered", message: "Forged recovery" }],
    });
    controller.receiveDeviceList({
      state: "success",
      devices: [windowsKeyboard],
      notices: [{ provider: "logitech", kind: "ambiguous", message: "Choose a match" }],
    });
    controller.receiveDeviceList({
      state: "success",
      devices: [windowsKeyboard],
      notices: [{ provider: "logitech", kind: "recovered", message: "G502 X Plus reconnected" }],
    });
    controller.changeSettings({ showDeviceName: true });
    controller.receiveDeviceList({
      state: "success",
      devices: [windowsKeyboard],
      notices: [{ provider: "logitech", kind: "recovered", message: "Recovered again" }],
    });
    controller.refresh();

    expect(recovery).toEqual(["G502 X Plus reconnected", "", "Recovered again", ""]);
  });

  it("routes runtime status messages additively while retaining device-list and settings routes", () => {
    const calls: string[] = [];
    const controller = {
      receiveDeviceList() { calls.push("devices"); },
      receiveRuntimeStatus() { calls.push("runtime"); },
      receiveSettings() { calls.push("settings"); },
    };

    routeInspectorMessage(controller, {
      event: "sendToPropertyInspector",
      payload: { event: "deviceList" },
    });
    routeInspectorMessage(controller, {
      event: "sendToPropertyInspector",
      payload: { event: "deviceRuntimeStatus" },
    });
    routeInspectorMessage(controller, {
      event: "didReceiveSettings",
      payload: { settings: { showDeviceName: true } },
    });

    expect(calls).toEqual(["devices", "runtime", "settings"]);
  });

  it("defines the compact selected-row grid without legacy arrow-control space", () => {
    const html = readFileSync(
      new URL("../../com.jcooler.peripheral-battery.sdPlugin/ui/battery.html", import.meta.url),
      "utf8"
    );

    expect(html).toMatch(/\.device-row-selected\s+\.device-line\s*\{[^}]*grid-template-columns:\s*24px\s+minmax\(0,\s*1fr\)\s+44px/s);
    expect(html).toMatch(/\.drag-grip\s*\{[^}]*(?:width|min-width):\s*44px;[^}]*(?:height|min-height):\s*44px/s);
    expect(html).toMatch(/\.device-name\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap/s);
    expect(html).not.toContain(".order-controls");
    expect(html).not.toContain(".order-button");
    expect(html).toContain('id="reorderAnnouncement"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toMatch(/drag[^<]*Alt\+Arrow/i);
  });

  it("reorders selected rows through drag targets and never makes an unselected row draggable", () => {
    const document = new FakeDocument();
    const list = document.createElement("ol");
    const reordered: Array<[string, number]> = [];
    const rows = buildDeviceRows(
      [windowsKeyboard, steelSeriesMouse, xinputController],
      [xinputController, windowsKeyboard]
    );

    renderDeviceList(list, rows, {
      onIncluded() {},
      onReorder: (key, targetIndex) => reordered.push([key, targetIndex]),
    });

    const grips = findByClass(list, "drag-grip");
    const selectedRows = findByClass(list, "device-row-selected");
    const unselectedRow = findByClass(list, "device-row").at(-1)!;
    const dragOver = new FakeEvent();

    expect(grips[0].attributes.get("aria-grabbed")).toBe("false");
    grips[0].dispatch("dragstart");
    expect(grips[0].attributes.get("aria-grabbed")).toBe("true");
    selectedRows[1].dispatch("dragover", dragOver);
    expect(dragOver.defaultPrevented).toBe(true);
    selectedRows[1].dispatch("drop");
    grips[0].dispatch("dragend");

    expect(reordered).toEqual([["xinput:slot%3A0", 1]]);
    expect(grips[0].attributes.get("aria-grabbed")).toBe("false");
    expect(unselectedRow.attributes.get("draggable")).toBeUndefined();
    expect(unselectedRow.listeners.get("dragover")).toBeUndefined();
  });

  it("handles only valid Alt-arrow reorder commands on the selected row keyboard surface", () => {
    const document = new FakeDocument();
    const list = document.createElement("ol");
    const reordered: Array<[string, number]> = [];
    const rows = buildDeviceRows(
      [windowsKeyboard, steelSeriesMouse],
      [windowsKeyboard, steelSeriesMouse]
    );

    renderDeviceList(list, rows, {
      onIncluded() {},
      onReorder: (key, targetIndex) => reordered.push([key, targetIndex]),
    });

    const selectedRows = findByClass(list, "device-row-selected");
    const firstUp = new FakeEvent({ altKey: true, key: "ArrowUp" });
    const firstDown = new FakeEvent({ altKey: true, key: "ArrowDown" });
    const plainDown = new FakeEvent({ key: "ArrowDown" });

    selectedRows[0].dispatch("keydown", firstUp);
    selectedRows[0].dispatch("keydown", firstDown);
    selectedRows[1].dispatch("keydown", plainDown);

    expect(firstUp.defaultPrevented).toBe(false);
    expect(firstDown.defaultPrevented).toBe(true);
    expect(plainDown.defaultPrevented).toBe(false);
    expect(reordered).toEqual([["windows:BTH-2", 1]]);
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
      onReorder() {},
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

  it("persists inclusion, reordering, and display edits without losing the selected list", () => {
    const sent: any[] = [];
    const announcements: string[] = [];
    const controller = createInspectorController({
      send: (message) => sent.push(message),
      view: { applySettings() {}, renderRows() {}, showStatus() {}, announce: (text) => announcements.push(text) },
    });
    controller.open({
      action: "com.jcooler.peripheral-battery.monitor",
      context: "context-1",
      settings: { schemaVersion: 2, selectedDevices: [windowsKeyboard], showDeviceName: false },
    });
    sent.length = 0;

    controller.include(steelSeriesMouse, true);
    controller.reorder("steelseries:7", 0);
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
    expect(announcements).toEqual([
      "Moved Aerox 5 Wireless to position 1 of 2",
      "",
    ]);
  });

  it.each([
    { label: "ordinary", device: windowsKeyboard, available: true, current: false },
    { label: "active", device: steelSeriesMouse, available: true, current: true },
    { label: "missing", device: xinputController, available: false, current: false },
  ])("removes an $label selected row through the controller", ({
    device,
    available,
    current,
  }) => {
    const sent: any[] = [];
    const rendered: any[] = [];
    const controller = createInspectorController({
      send: (message) => sent.push(message),
      view: {
        applySettings() {},
        renderRows: (rows) => rendered.push(rows),
        showStatus() {},
      },
    });
    controller.open({
      action: "action",
      context: "context",
      settings: {
        schemaVersion: 2,
        selectedDevices: [windowsKeyboard, steelSeriesMouse, xinputController],
        activeDeviceKey: steelSeriesMouse.key,
      },
    });
    controller.receiveDeviceList({
      state: "success",
      devices: [windowsKeyboard, steelSeriesMouse],
    });
    controller.receiveRuntimeStatus({
      currentDeviceKey: steelSeriesMouse.key,
      statuses: [],
    });
    sent.length = 0;

    expect(rendered.at(-1).find((row: any) => row.device.key === device.key)).toMatchObject({
      included: true,
      available,
      current,
    });
    controller.include(device, false);

    expect(sent).toHaveLength(1);
    expect(sent[0].payload.selectedDevices.map((entry: any) => entry.key)).toEqual(
      [windowsKeyboard, steelSeriesMouse, xinputController]
        .filter((entry) => entry.key !== device.key)
        .map((entry) => entry.key)
    );
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
  readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>();
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

  addEventListener(name: string, listener: (event: FakeEvent) => void): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  dispatch(name: string, event = new FakeEvent()): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

class FakeEvent {
  readonly altKey: boolean;
  readonly key: string;
  defaultPrevented = false;

  constructor({ altKey = false, key = "" }: { altKey?: boolean; key?: string } = {}) {
    this.altKey = altKey;
    this.key = key;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

function findAll(root: FakeElement, tagName: string): FakeElement[] {
  const found = root.tagName === tagName ? [root] : [];
  for (const child of root.children) found.push(...findAll(child, tagName));
  return found;
}

function findByClass(root: FakeElement, className: string): FakeElement[] {
  const found = root.className.split(/\s+/).includes(className) ? [root] : [];
  for (const child of root.children) found.push(...findByClass(child, className));
  return found;
}

function collectText(root: FakeElement): string {
  return [root.textContent, ...root.children.map(collectText)].join(" ");
}

function selectedRowsChildren(root: FakeElement): string[][] {
  return findByClass(root, "device-row-selected").map((row) =>
    row.children[0].children.map((child) => child.className)
  );
}
