import { describe, expect, it } from "vitest";

import {
  parseBatterySettings,
  prepareMigratedDevices,
  type PersistedBatterySettings,
} from "../../src/actions/settings";

describe("battery action settings", () => {
  it("preserves one explicit ordered device list and removes duplicate keys", () => {
    const parsed = parseBatterySettings({
      schemaVersion: 2,
      selectedDevices: [
        {
          provider: "windows",
          nativeId: "BTH-2",
          providerLabel: "ignored",
          name: "Keyboard",
          deviceType: "Keyboard",
        },
        {
          provider: "steelseries",
          nativeId: "7",
          providerLabel: "ignored",
          name: "Aerox",
          deviceType: "Mouse",
        },
        {
          provider: "windows-gamepad",
          nativeId: "raw-controller-1",
          providerLabel: "ignored",
          name: "Xbox One Game Controller",
          deviceType: "Controller",
        },
        {
          provider: "windows",
          nativeId: "BTH-2",
          providerLabel: "ignored",
          name: "Duplicate",
          deviceType: "Keyboard",
        },
      ],
    });

    expect(parsed.settings.selectedDevices.map((device) => device.key)).toEqual([
      "windows:BTH-2",
      "steelseries:7",
      "windows-gamepad:raw-controller-1",
    ]);
    expect(parsed.settings.selectedDevices.map((device) => device.providerLabel)).toEqual([
      "Windows Bluetooth",
      "SteelSeries GG",
      "Windows Gamepad",
    ]);
    expect(parsed.migrated).toBe(false);
  });

  it("keeps only the first ordered device for a reliable physical identity", () => {
    const parsed = parseBatterySettings({
      schemaVersion: 2,
      selectedDevices: [
        {
          provider: "windows",
          nativeId: "BTH-1",
          name: "Controller through Windows",
          deviceType: "Controller",
          physicalId: "container:controller-1",
        },
        {
          provider: "hid",
          nativeId: "serial:controller-1",
          name: "The same controller through HID",
          deviceType: "Controller",
          physicalId: "container:controller-1",
        },
        {
          provider: "xinput",
          nativeId: "slot:0",
          name: "Session-only controller",
          deviceType: "Controller",
        },
      ],
    });

    expect(parsed.settings.selectedDevices.map((device) => device.key)).toEqual([
      "windows:BTH-1",
      "xinput:slot%3A0",
    ]);
  });

  it("migrates only legacy identities proven by the old schema", () => {
    const steelSeries = parseBatterySettings({
      deviceBrand: "steelseries",
      deviceId: 42,
      deviceName: "[SS] Aerox",
    });
    const logitech = parseBatterySettings({
      deviceBrand: "logitech",
      deviceId: 5,
      logiDeviceId: "dev00000005",
      deviceName: "[Logi] G Pro",
    });
    const xinput = parseBatterySettings({
      deviceBrand: "xbox",
      xboxIndex: 2,
      deviceName: "[Xbox] Controller 3",
    });

    expect(steelSeries.settings.selectedDevices[0]).toMatchObject({
      key: "steelseries:42",
      nativeId: "42",
      name: "Aerox",
    });
    expect(logitech.settings.selectedDevices[0]).toMatchObject({
      key: "logitech:session%3Adev00000005",
      nativeId: "session:dev00000005",
      name: "G Pro",
    });
    expect(xinput.settings.selectedDevices[0]).toMatchObject({
      key: "xinput:slot%3A2",
      nativeId: "slot:2",
      name: "Controller 3",
    });
    expect(steelSeries.migrated && logitech.migrated && xinput.migrated).toBe(true);
  });

  it("enriches legacy SteelSeries metadata by exact catalog key before persistence", () => {
    const legacy = parseBatterySettings({
      deviceBrand: "steelseries",
      deviceId: 42,
      deviceName: "Aerox 5 Wireless",
    }).settings.selectedDevices;
    const canonical = {
      ...legacy[0],
      name: "Aerox 5 Wireless",
      deviceType: "Mouse",
    };

    expect(prepareMigratedDevices(legacy, [canonical])).toEqual({
      selectedDevices: [canonical],
      safeToPersist: true,
    });
    expect(
      prepareMigratedDevices(legacy, [
        { ...canonical, key: "steelseries:99", nativeId: "99" },
      ])
    ).toEqual({
      selectedDevices: legacy,
      safeToPersist: false,
    });
    expect(
      prepareMigratedDevices(legacy, [
        { ...canonical, name: "Different device reusing ID 42" },
      ])
    ).toEqual({
      selectedDevices: legacy,
      safeToPersist: false,
    });
  });

  it("never defaults an ambiguous legacy setting to SteelSeries", () => {
    const parsed = parseBatterySettings({
      deviceId: 42,
      deviceName: "Wireless Device",
    });

    expect(parsed.settings.selectedDevices).toEqual([]);
    expect(parsed.migrated).toBe(false);
  });

  it("keeps display options while bounding the poll interval", () => {
    const input: PersistedBatterySettings = {
      pollInterval: 2,
      showPercentage: false,
      showDeviceType: true,
      showDeviceName: true,
      showStatusText: true,
      deviceTypeFontSize: 18,
      backgroundColor: "#123456",
    };

    expect(parseBatterySettings(input).settings).toMatchObject({
      pollInterval: 10,
      showPercentage: false,
      showDeviceType: true,
      showDeviceName: true,
      showStatusText: true,
      deviceTypeFontSize: 18,
      backgroundColor: "#123456",
    });
  });
});
