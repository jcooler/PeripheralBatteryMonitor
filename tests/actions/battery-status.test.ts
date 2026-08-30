import { describe, expect, it } from "vitest";

import { batteryStatusError } from "../../src/actions/battery-status";
import type { BatteryInfo } from "../../src/types";

function info(overrides: Partial<BatteryInfo> = {}): BatteryInfo {
  return {
    deviceId: 1,
    deviceName: "Mouse",
    deviceType: "Mouse",
    batteryLevel: 50,
    isCharging: false,
    isConnected: true,
    ...overrides,
  };
}

describe("legacy battery status rendering", () => {
  it("labels a connected device with no passive value as unavailable", () => {
    expect(batteryStatusError(info({ batteryLevel: -1 }))).toBe("Unavailable");
  });

  it("labels a disconnected device as disconnected", () => {
    expect(batteryStatusError(info({ isConnected: false, batteryLevel: -1 }))).toBe(
      "Disconnected"
    );
  });

  it("returns no error for an available percentage", () => {
    expect(batteryStatusError(info())).toBeNull();
  });
});
