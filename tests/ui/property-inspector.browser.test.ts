import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";

const repoRoot = resolve(import.meta.dirname, "../..");
const uiRoot = resolve(
  repoRoot,
  "com.jcooler.peripheral-battery.sdPlugin/ui"
);

describe("Property Inspector browser layout", () => {
  let browser: Browser;
  let server: Server;
  let origin = "";
  let fixture: Record<string, any>;

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      const file = request.url === "/device-list.js" ? "device-list.js" : "battery.html";
      const body = await readFile(resolve(uiRoot, file));
      response.writeHead(200, {
        "content-type": file.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : "text/html; charset=utf-8",
      });
      response.end(body);
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not bind");
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    fixture = JSON.parse(
      await readFile(
        resolve(repoRoot, "tests/fixtures/property-inspector-logitech-qa.json"),
        "utf8"
      )
    );
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolveClose, rejectClose) => {
      server?.close((error) => error ? rejectClose(error) : resolveClose());
    });
  });

  it("contains hostile provider status text without horizontal scrolling at 250px", async () => {
    const { context, page } = await openFixturePage(browser, origin, fixture);

    try {
      const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        statusText: document.getElementById("status")?.textContent,
      }));
      expect(dimensions.statusText).toContain("<script>");
      expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
    } finally {
      await context.close();
    }
  });

  it("long-press touch drag reorders, renumbers, and persists at 250px", async () => {
    const { context, page } = await openFixturePage(browser, origin, fixture);
    try {
      const firstGrip = await centerOf(page.locator(".drag-grip").nth(0));
      const thirdRow = await centerOf(page.locator(".device-row-selected").nth(2));

      await dispatchTouchGesture(page, {
        start: firstGrip,
        end: { x: thirdRow.x, y: thirdRow.y },
        holdMs: 800,
        moveSteps: 6,
      });

      const names = await page.locator(".device-row-selected .device-name").allTextContents();
      const numbers = await page.locator(".cycle-position").allTextContents();
      const persisted = await page.evaluate(() =>
        globalThis.__fixtureSocket().sent.filter((message) => message.event === "setSettings")
      );
      expect(names).toEqual([
        "MX Keys S Wireless Illuminated Keyboard With A Deliberately Long Display Name",
        "Saved Aerox <img src=x onerror=globalThis.fixturePwned=true>",
        "G502 X Plus",
      ]);
      expect(numbers).toEqual(["1", "2", "3"]);
      expect(persisted).toHaveLength(1);
      expect(persisted[0].payload.selectedDevices.map((device: any) => device.nativeId)).toEqual([
        "model:046d:b35b:mx-keys",
        "404",
        "serial:G502X-PLUS-001",
      ]);
      await expect.poll(() => page.locator("#reorderAnnouncement").textContent()).toBe(
        "Moved G502 X Plus to position 3 of 3"
      );
    } finally {
      await context.close();
    }
  });

  it("touch tap on a grip does not reorder or persist", async () => {
    const { context, page } = await openFixturePage(browser, origin, fixture);
    try {
      const initialNames = await page.locator(".device-row-selected .device-name").allTextContents();
      const firstGrip = await centerOf(page.locator(".drag-grip").nth(0));
      await dispatchTouchGesture(page, {
        start: firstGrip,
        end: firstGrip,
        holdMs: 80,
        moveSteps: 0,
      });

      expect(await page.locator(".device-row-selected .device-name").allTextContents()).toEqual(initialNames);
      expect(
        await page.evaluate(() =>
          globalThis.__fixtureSocket().sent.filter((message) => message.event === "setSettings")
        )
      ).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("touch scroll starting on a grip moves the page without reordering", async () => {
    const { context, page } = await openFixturePage(browser, origin, fixture, 420);
    try {
      const initialNames = await page.locator(".device-row-selected .device-name").allTextContents();
      const secondGrip = await centerOf(page.locator(".drag-grip").nth(1));
      await dispatchTouchGesture(page, {
        start: secondGrip,
        end: { x: secondGrip.x, y: secondGrip.y - 140 },
        holdMs: 40,
        moveSteps: 8,
      });

      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
      expect(await page.locator(".device-row-selected .device-name").allTextContents()).toEqual(initialNames);
      expect(
        await page.evaluate(() =>
          globalThis.__fixtureSocket().sent.filter((message) => message.event === "setSettings")
        )
      ).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});

async function openFixturePage(
  browser: Browser,
  origin: string,
  fixture: Record<string, any>,
  height = 900
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: 250, height },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    class FixtureWebSocket extends EventTarget {
      static instance: FixtureWebSocket | undefined;
      readyState = 0;
      sent: any[] = [];

      constructor() {
        super();
        FixtureWebSocket.instance = this;
        queueMicrotask(() => {
          this.readyState = 1;
          this.dispatchEvent(new Event("open"));
        });
      }

      send(data: string) {
        this.sent.push(JSON.parse(data));
      }

      receive(message: unknown) {
        this.dispatchEvent(
          new MessageEvent("message", { data: JSON.stringify(message) })
        );
      }
    }
    Object.defineProperty(globalThis, "WebSocket", { value: FixtureWebSocket });
    Object.defineProperty(globalThis, "__fixtureSocket", {
      value: () => FixtureWebSocket.instance,
    });
  });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => typeof window.connectElgatoStreamDeckSocket === "function"
  );
  await page.evaluate((state) => {
    window.connectElgatoStreamDeckSocket(
      "9876",
      state.context,
      "registerPropertyInspector",
      "{}",
      JSON.stringify({
        action: state.action,
        payload: { settings: state.settings },
      })
    );
  }, fixture);
  await page.waitForFunction(() => globalThis.__fixtureSocket()?.readyState === 1);
  await page.evaluate((state) => {
    globalThis.__fixtureSocket().receive({
      event: "sendToPropertyInspector",
      payload: state.discovery,
    });
  }, fixture);
  await page.locator(".device-row-selected").first().waitFor({ state: "visible" });
  return { context, page };
}

async function centerOf(locator: ReturnType<Page["locator"]>): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Touch target has no bounding box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function dispatchTouchGesture(
  page: Page,
  options: {
    start: { x: number; y: number };
    end: { x: number; y: number };
    holdMs: number;
    moveSteps: number;
  }
): Promise<void> {
  const session = await page.context().newCDPSession(page);
  const point = (x: number, y: number) => ({
    x,
    y,
    id: 1,
    radiusX: 4,
    radiusY: 4,
    force: 1,
  });
  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point(options.start.x, options.start.y)],
    });
    await page.waitForTimeout(options.holdMs);
    for (let step = 1; step <= options.moveSteps; step += 1) {
      const progress = step / options.moveSteps;
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [point(
          options.start.x + (options.end.x - options.start.x) * progress,
          options.start.y + (options.end.y - options.start.y) * progress
        )],
      });
      await page.waitForTimeout(20);
    }
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await session.detach();
  }
}

declare global {
  interface Window {
    connectElgatoStreamDeckSocket: (
      port: string,
      uuid: string,
      registerEvent: string,
      info: string,
      actionInfo: string
    ) => void;
  }

  // Browser-only fixture hook installed with addInitScript.
  var __fixtureSocket: () => {
    readyState: number;
    sent: any[];
    receive(message: unknown): void;
  };
}
