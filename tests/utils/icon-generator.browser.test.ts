import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";

import { generateBatteryIcon } from "../../src/utils/icon-generator";

describe("battery icon browser geometry", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  it.each([
    { batteryLevel: 0 },
    { batteryLevel: 100 },
  ])(
    "keeps a charging bolt beside $batteryLevel% without overlap or clipping",
    async ({ batteryLevel }) => {
      const page = await browser.newPage({ viewport: { width: 144, height: 144 } });
      const browserErrors: string[] = [];
      page.on("pageerror", (error) => browserErrors.push(error.message));
      const svg = decode(generateBatteryIcon({
        deviceId: 1,
        deviceName: "Apex Pro TKL Wireless",
        deviceType: "Keyboard",
        batteryLevel,
        isCharging: true,
        isConnected: true,
        providerLabel: "SteelSeries GG",
      }, {
        showPercentage: true,
        showDeviceType: true,
        showDeviceName: true,
        showStatusText: true,
      }));

      try {
        await page.setContent(`<body>${svg}</body>`);
        const geometry = await page.evaluate(() => {
          const root = document.querySelector("svg")!;
          const percentage = [...root.querySelectorAll("text")].find(
            (node) => node.textContent?.endsWith("%")
          ) as SVGGraphicsElement;
          const bolt = root.querySelector("polygon") as SVGGraphicsElement;
          const battery = root.querySelectorAll("rect")[1] as SVGGraphicsElement;
          const percentageBox = percentage.getBBox();
          const boltBox = bolt.getBBox();
          const batteryBox = battery.getBBox();
          const overlaps = !(
            percentageBox.x + percentageBox.width <= boltBox.x ||
            boltBox.x + boltBox.width <= percentageBox.x ||
            percentageBox.y + percentageBox.height <= boltBox.y ||
            boltBox.y + boltBox.height <= percentageBox.y
          );
          const contained = [percentageBox, boltBox].every((box) =>
            box.x >= batteryBox.x &&
            box.y >= batteryBox.y &&
            box.x + box.width <= batteryBox.x + batteryBox.width &&
            box.y + box.height <= batteryBox.y + batteryBox.height
          );
          return { overlaps, contained };
        });

        expect(geometry).toEqual({ overlaps: false, contained: true });
        expect(browserErrors).toEqual([]);
      } finally {
        await page.close();
      }
    },
    15_000
  );
});

function decode(dataUri: string): string {
  return Buffer.from(dataUri.split(",")[1], "base64").toString("utf8");
}
