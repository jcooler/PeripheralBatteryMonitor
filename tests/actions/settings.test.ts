import { describe, expect, it } from "vitest";

import {
  parseBatterySettings,
  prepareMigratedDevices,
  type PersistedBatterySettings,
} from "../../src/actions/settings";
import {
  makeDeviceKey,
  type DeviceDescriptor,
  type DeviceRef,
} from "../../src/devices/types";

function logitechDevice(
  name: string,
  deviceType = "Mouse",
  nativeId = `model:${name.toLowerCase()}|${deviceType.toLowerCase()}`,
  transientNativeIds?: readonly string[]
): DeviceDescriptor {
  return {
    key: makeDeviceKey("logitech", nativeId),
    provider: "logitech",
    providerLabel: "Logitech G Hub",
    nativeId,
    name,
    deviceType,
    physicalId: `logitech-model:${nativeId}`,
    ...(transientNativeIds ? { transientNativeIds } : {}),
  };
}

function legacyLogitech(
  name: string,
  deviceType = "Mouse",
  endpoint = "dev00000006"
): DeviceRef {
  const nativeId = `session:${endpoint}`;
  return {
    key: makeDeviceKey("logitech", nativeId),
    provider: "logitech",
    providerLabel: "Logitech G Hub",
    nativeId,
    name,
    deviceType,
  };
}

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

  it("marks schema-v2 Logitech session selections as migration candidates", () => {
    const legacy = legacyLogitech("G502 X Plus");

    const parsed = parseBatterySettings({
      schemaVersion: 2,
      selectedDevices: [legacy],
      activeDeviceKey: legacy.key,
    });

    expect(parsed.migrated).toBe(true);
    expect(parsed.settings.selectedDevices).toEqual([legacy]);
    expect(parsed.settings.activeDeviceKey).toBe(legacy.key);
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
      activeDeviceKey: null,
      safeToPersist: true,
      changed: true,
    });
    expect(
      prepareMigratedDevices(legacy, [
        { ...canonical, key: "steelseries:99", nativeId: "99" },
      ])
    ).toEqual({
      selectedDevices: legacy,
      activeDeviceKey: null,
      safeToPersist: false,
      changed: false,
    });
    expect(
      prepareMigratedDevices(legacy, [
        { ...canonical, name: "Different device reusing ID 42" },
      ])
    ).toEqual({
      selectedDevices: legacy,
      activeDeviceKey: null,
      safeToPersist: false,
      changed: false,
    });
  });

  it("prioritizes one exact current Logitech session endpoint", () => {
    const legacy = legacyLogitech("Old saved display name", "Device");
    const canonical = logitechDevice(
      "G502 X Plus",
      "Mouse",
      "serial:stable-502",
      [legacy.nativeId]
    );

    expect(prepareMigratedDevices([legacy], [canonical])).toEqual({
      selectedDevices: [{
        key: canonical.key,
        provider: canonical.provider,
        providerLabel: canonical.providerLabel,
        nativeId: canonical.nativeId,
        name: canonical.name,
        deviceType: canonical.deviceType,
        physicalId: canonical.physicalId,
      }],
      activeDeviceKey: null,
      safeToPersist: true,
      changed: true,
    });
  });

  it("uses one exact normalized Logitech name and mapped type when the endpoint is stale", () => {
    const legacy = legacyLogitech("  G502\u00a0X   PLUS  ", "mouse");
    const canonical = logitechDevice("G502 X Plus", "Mouse");

    expect(prepareMigratedDevices([legacy], [canonical])).toMatchObject({
      selectedDevices: [{ key: canonical.key }],
      safeToPersist: true,
      changed: true,
    });
  });

  it("allows saved Logitech type Device only after one exact normalized name match", () => {
    const legacy = legacyLogitech("G915 TKL", "Device");
    const canonical = logitechDevice("G915 TKL", "Keyboard");

    expect(prepareMigratedDevices([legacy], [canonical])).toMatchObject({
      selectedDevices: [{ key: canonical.key, deviceType: "Keyboard" }],
      safeToPersist: true,
      changed: true,
    });
  });

  it.each([
    {
      name: "stale product name",
      legacy: legacyLogitech("Pro Wireless Mouse", "Mouse"),
      discovered: [logitechDevice("G502 X Plus", "Mouse")],
    },
    {
      name: "duplicate exact names",
      legacy: legacyLogitech("G502 X Plus", "Mouse"),
      discovered: [
        logitechDevice("G502 X Plus", "Mouse", "serial:first"),
        logitechDevice("G502 X Plus", "Mouse", "serial:second"),
      ],
    },
    {
      name: "same type with a different name",
      legacy: legacyLogitech("G502 X Plus", "Mouse"),
      discovered: [logitechDevice("G Pro X Superlight", "Mouse")],
    },
    {
      name: "substring-only name",
      legacy: legacyLogitech("G502", "Mouse"),
      discovered: [logitechDevice("G502 X Plus", "Mouse")],
    },
  ])("fails closed for $name", ({ legacy, discovered }) => {
    expect(prepareMigratedDevices([legacy], discovered)).toEqual({
      selectedDevices: [legacy],
      activeDeviceKey: null,
      safeToPersist: false,
      changed: false,
    });
  });

  it("changes only the Logitech row in place and translates its active key", () => {
    const before: DeviceRef = {
      key: makeDeviceKey("windows", "keyboard-1"),
      provider: "windows",
      providerLabel: "Windows Bluetooth",
      nativeId: "keyboard-1",
      name: "MX Keys Mini",
      deviceType: "Keyboard",
    };
    const legacy = legacyLogitech("G502 X Plus", "Mouse");
    const after: DeviceRef = {
      key: makeDeviceKey("xinput", "slot:0"),
      provider: "xinput",
      providerLabel: "XInput",
      nativeId: "slot:0",
      name: "Controller 1",
      deviceType: "Controller",
    };
    const canonical = logitechDevice("G502 X Plus", "Mouse");

    expect(
      prepareMigratedDevices(
        [before, legacy, after],
        [
          { ...before, name: "Discovery must not rename this keyboard" },
          canonical,
          { ...after, name: "Discovery must not rename this controller" },
        ],
        legacy.key
      )
    ).toEqual({
      selectedDevices: [before, {
        key: canonical.key,
        provider: canonical.provider,
        providerLabel: canonical.providerLabel,
        nativeId: canonical.nativeId,
        name: canonical.name,
        deviceType: canonical.deviceType,
        physicalId: canonical.physicalId,
      }, after],
      activeDeviceKey: canonical.key,
      safeToPersist: true,
      changed: true,
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
