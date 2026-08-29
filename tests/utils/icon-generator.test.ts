import { describe, expect, it } from "vitest";

import {
  generateBatteryIcon,
  generateErrorIcon,
  generateLoadingIcon,
  generateQualitativeBatteryIcon,
} from "../../src/utils/icon-generator";

function decode(dataUrl: string): string {
  return Buffer.from(dataUrl.split(",")[1], "base64").toString("utf8");
}

interface CycleDot {
  index: number;
  active: boolean;
  cx: number;
  cy: number;
  radius: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
}

function attribute(tag: string, name: string): string {
  const value = tag.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1];
  if (value === undefined) throw new Error(`Missing ${name} in ${tag}`);
  return value;
}

function cycleDots(svg: string): CycleDot[] {
  return [...svg.matchAll(/<circle\b[^>]*\bdata-cycle-index="\d+"[^>]*>/g)].map(
    ([tag]) => ({
      index: Number(attribute(tag, "data-cycle-index")),
      active: attribute(tag, "data-active") === "true",
      cx: Number(attribute(tag, "cx")),
      cy: Number(attribute(tag, "cy")),
      radius: Number(attribute(tag, "r")),
      fill: attribute(tag, "fill"),
      stroke: attribute(tag, "stroke"),
      strokeWidth: Number(attribute(tag, "stroke-width")),
    })
  );
}

function contrastRatio(first: string, second: string): number {
  const luminance = (hex: string): number => {
    const channels = hex.slice(1).match(/.{2}/g)?.slice(0, 3) ?? [];
    const linear = channels.map((channel) => {
      const value = Number.parseInt(channel, 16) / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

function percentageIcon(cycle?: { count: number; activeIndex: number }): string {
  return decode(generateBatteryIcon({
    deviceId: 1,
    deviceName: "Aerox",
    deviceType: "Mouse",
    batteryLevel: 63,
    isCharging: false,
    isConnected: true,
    providerLabel: "SteelSeries GG",
  }, undefined, cycle));
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

  it("visibly distinguishes a last-known percentage from a fresh charging reading", () => {
    const lastKnownSvg = decode(generateBatteryIcon({
      deviceId: 1,
      deviceName: "Aerox",
      deviceType: "Mouse",
      batteryLevel: 85,
      isCharging: true,
      isConnected: true,
      isLastKnown: true,
      providerLabel: "SteelSeries GG",
    }, { showStatusText: true }));
    const freshSvg = decode(generateBatteryIcon({
      deviceId: 1,
      deviceName: "Aerox",
      deviceType: "Mouse",
      batteryLevel: 85,
      isCharging: true,
      isConnected: true,
      providerLabel: "SteelSeries GG",
    }, { showStatusText: true }));

    expect(lastKnownSvg).toContain("~85%");
    expect(lastKnownSvg).toContain("Last known");
    expect(lastKnownSvg).not.toContain("SteelSeries GG");
    expect(lastKnownSvg).not.toContain("<polygon");
    expect(freshSvg).toContain("85%");
    expect(freshSvg).toContain("SteelSeries GG");
    expect(freshSvg).toContain("<polygon");
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

  it("renders one ordered dot per device and highlights the active position", () => {
    const svg = percentageIcon({ count: 3, activeIndex: 1 });

    expect(svg).toContain('data-cycle-indicator="true"');
    expect(cycleDots(svg)).toEqual([
      {
        index: 0,
        active: false,
        cx: 64,
        cy: 136,
        radius: 2.5,
        fill: "#9da7b3",
        stroke: "#010409",
        strokeWidth: 1.25,
      },
      {
        index: 1,
        active: true,
        cx: 72,
        cy: 136,
        radius: 2.5,
        fill: "#f0f6fc",
        stroke: "#010409",
        strokeWidth: 1.25,
      },
      {
        index: 2,
        active: false,
        cx: 80,
        cy: 136,
        radius: 2.5,
        fill: "#9da7b3",
        stroke: "#010409",
        strokeWidth: 1.25,
      },
    ]);
  });

  it.each([
    { count: 0, activeIndex: 0 },
    { count: 1, activeIndex: 0 },
    { count: 3, activeIndex: -1 },
    { count: 3, activeIndex: 3 },
    { count: 3, activeIndex: 1.5 },
  ])("omits cycle dots for an unusable position %#", (cycle) => {
    expect(cycleDots(percentageIcon(cycle))).toEqual([]);
  });

  it.each([
    ["qualitative", () => generateQualitativeBatteryIcon({
      deviceName: "Xbox Controller",
      deviceType: "Controller",
      level: "medium",
      providerLabel: "XInput",
    }, undefined, { count: 2, activeIndex: 0 })],
    ["error", () => generateErrorIcon(
      "Unavailable",
      undefined,
      { count: 2, activeIndex: 0 }
    )],
    ["loading", () => generateLoadingIcon(
      undefined,
      { count: 2, activeIndex: 0 }
    )],
  ] as const)("renders cycle position for a %s icon", (_kind, generate) => {
    const dots = cycleDots(decode(generate()));

    expect(dots).toHaveLength(2);
    expect(dots.map((dot) => dot.active)).toEqual([true, false]);
    expect(dots.every((dot) => dot.cy === 136)).toBe(true);
  });

  it("keeps all twenty cycle dots centered and within the icon bounds", () => {
    const dots = cycleDots(percentageIcon({ count: 20, activeIndex: 19 }));
    const left = Math.min(...dots.map((dot) => dot.cx));
    const right = Math.max(...dots.map((dot) => dot.cx));

    expect(dots).toHaveLength(20);
    expect(dots.map((dot) => dot.index)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
      10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    ]);
    expect(left).toBe(24);
    expect(right).toBe(120);
    expect(dots.every((dot) => dot.cx - dot.radius >= 0)).toBe(true);
    expect(dots.every((dot) => dot.cx + dot.radius <= 144)).toBe(true);
    expect(dots.filter((dot) => dot.active).map((dot) => dot.index)).toEqual([19]);
  });

  it.each(["#ffffff", "#484f58"])(
    "keeps every cycle dot distinguishable on a %s background",
    (backgroundColor) => {
      const svg = decode(generateBatteryIcon({
        deviceId: 1,
        deviceName: "Keyboard",
        deviceType: "Keyboard",
        batteryLevel: 80,
        isCharging: false,
        isConnected: true,
      }, { backgroundColor }, { count: 2, activeIndex: 1 }));

      for (const dot of cycleDots(svg)) {
        expect(
          Math.max(
            contrastRatio(backgroundColor, dot.fill),
            contrastRatio(backgroundColor, dot.stroke)
          )
        ).toBeGreaterThanOrEqual(3);
        expect(dot.strokeWidth).toBeGreaterThanOrEqual(1.25);
      }
    }
  );
});
