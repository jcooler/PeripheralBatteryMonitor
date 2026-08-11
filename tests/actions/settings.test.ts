import { describe, expect, it } from "vitest";

import {
  parseBatterySettings,
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
    ]);
    expect(parsed.settings.selectedDevices.map((device) => device.providerLabel)).toEqual([
      "Windows Bluetooth",
      "SteelSeries GG",
    ]);
    expect(parsed.migrated).toBe(false);
  });

  it("migrates only legacy identities proven by the old schema", () => {
    const steelSeries = parseBatterySettings({
      deviceBrand: "steelseries",
      deviceId: 42,
      deviceName: "Aerox",
    });
    const logitech = parseBatterySettings({
      deviceBrand: "logitech",
      deviceId: 5,
      logiDeviceId: "dev00000005",
      deviceName: "G Pro",
    });
    const xinput = parseBatterySettings({
      deviceBrand: "xbox",
      xboxIndex: 2,
      deviceName: "Controller",
    });

    expect(steelSeries.settings.selectedDevices[0]).toMatchObject({
      key: "steelseries:42",
      nativeId: "42",
    });
    expect(logitech.settings.selectedDevices[0]).toMatchObject({
      key: "logitech:session%3Adev00000005",
      nativeId: "session:dev00000005",
    });
    expect(xinput.settings.selectedDevices[0]).toMatchObject({
      key: "xinput:slot%3A2",
      nativeId: "slot:2",
    });
    expect(steelSeries.migrated && logitech.migrated && xinput.migrated).toBe(true);
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
