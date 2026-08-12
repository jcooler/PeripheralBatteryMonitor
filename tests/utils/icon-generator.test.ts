import { describe, expect, it } from "vitest";

import {
  generateBatteryIcon,
  generateQualitativeBatteryIcon,
} from "../../src/utils/icon-generator";

function decode(dataUrl: string): string {
  return Buffer.from(dataUrl.split(",")[1], "base64").toString("utf8");
}

describe("battery status icons", () => {
  it("renders an exact percentage and optional provider provenance", () => {
    const svg = decode(generateBatteryIcon({
      deviceId: 1,
      deviceName: "Aerox",
      deviceType: "Mouse",
      batteryLevel: 63,
      isCharging: false,
      isConnected: true,
      providerLabel: "SteelSeries GG",
    }, { showStatusText: true }));

    expect(svg).toContain("63%");
    expect(svg).toContain("SteelSeries GG");
  });

  it("renders XInput's qualitative state without inventing a percentage", () => {
    const svg = decode(generateQualitativeBatteryIcon({
      deviceName: "Xbox Controller",
      deviceType: "Controller",
      level: "medium",
      providerLabel: "XInput",
    }, { showPercentage: true, showStatusText: true }));

    expect(svg).toContain("MEDIUM");
    expect(svg).toContain("XInput");
    expect(svg).not.toMatch(/\d+%/);
  });

  it("escapes untrusted device text before embedding it in the SVG", () => {
    const svg = decode(generateBatteryIcon({
      deviceId: 1,
      deviceName: "Portable device",
      deviceType: "</text><script>alert(1)</script>",
      batteryLevel: 50,
      isCharging: false,
      isConnected: true,
    }, { showDeviceType: true }));

    expect(svg).toContain("&lt;/TEXT&gt;&lt;SCRIPT&gt;ALERT(1)&lt;/SCRIPT&gt;");
    expect(svg).not.toContain("<script>");
  });
});
