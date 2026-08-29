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

  it("shows compact trusted Logitech source labels without exposing arbitrary runtime text", async () => {
    const { context, page } = await openFixturePage(browser, origin, fixture);
    try {
      expect(await page.locator(".provider-label").allTextContents()).toContain(
        "Logitech"
      );
      expect(await page.locator(".source-label").allTextContents()).toEqual([
        "Direct HID++",
        "G Hub fallback",
      ]);
      expect(await page.locator(".device-list").textContent()).not.toContain(
        "private-runtime-source"
      );
    } finally {
      await context.close();
    }
  });

  it.each([250, 280, 360, 1280])("renders trusted freshness labels without overflow at %ipx", async (width) => {
    const { context, page, browserErrors } = await openFixturePage(
      browser,
      origin,
      freshnessFixture(),
      900,
      width
    );
    try {
      const layout = await page.evaluate(() => {
        const selectedRows = [...document.querySelectorAll<HTMLElement>(
          ".device-row-selected"
        )];
        const ids = [...document.querySelectorAll<HTMLElement>("[id]")].map(
          (element) => element.id
        );
        return {
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          freshness: selectedRows.map((row) => ({
            name: row.querySelector(".device-name")?.textContent,
            text: row.querySelector(".freshness-label")?.textContent,
            visible: row.querySelector<HTMLElement>(".freshness-label")?.checkVisibility(),
          })),
          controlsContained: selectedRows.every((row) => {
            const position = row.querySelector<HTMLElement>(".cycle-position")!
              .getBoundingClientRect();
            const identity = row.querySelector<HTMLElement>(".device-identity")!
              .getBoundingClientRect();
            const remove = row.querySelector<HTMLElement>(".remove-device")!
              .getBoundingClientRect();
            const grip = row.querySelector<HTMLElement>(".drag-grip")!
              .getBoundingClientRect();
            return (
              position.left >= 0 &&
              position.right <= identity.left &&
              identity.right <= grip.left &&
              grip.right <= document.documentElement.clientWidth &&
              remove.left >= identity.left &&
              remove.right <= identity.right
            );
          }),
          duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index),
          injectedElements: document.querySelectorAll(
            ".device-list img, .device-list svg, .status-bar script"
          ).length,
        };
      });

      expect(layout.scrollWidth).toBe(layout.clientWidth);
      expect(layout.freshness).toEqual([
        { name: "Apex Pro", text: "Last seen 23m ago", visible: true },
        { name: "Arctis Nova 7", text: "Last seen 3d ago", visible: true },
      ]);
      expect(layout.controlsContained).toBe(true);
      expect(layout.duplicateIds).toEqual([]);
      expect(layout.injectedElements).toBe(0);
      expect(browserErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it.each([250, 280, 360, 1280])("mouse drag reorders selected rows at %ipx", async (width) => {
    const { context, page, browserErrors } = await openFixturePage(browser, origin, fixture, 900, width);
    try {
      const names = await selectedNames(page);
      await page.locator("#refreshBtn").focus();
      await page.locator(".drag-grip").first().dragTo(
        page.locator(".device-row-selected").nth(2)
      );

      await expectPersistedSettings(page, 1);
      expect(await selectedNames(page)).toEqual([names[1], names[2], names[0]]);
      expect(await page.locator(".cycle-position").allTextContents()).toEqual(["1", "2", "3"]);
      await expectHealthyInspector(page, browserErrors);
    } finally {
      await context.close();
    }
  });

  it.each([250, 280, 360, 1280])("keyboard Alt+Arrow reorders selected rows at %ipx", async (width) => {
    const { context, page, browserErrors } = await openFixturePage(browser, origin, fixture, 900, width);
    try {
      const names = await selectedNames(page);
      const row = page.locator(".device-row-selected").first();
      await row.focus();
      await row.press("Alt+ArrowDown");

      await expectPersistedSettings(page, 1);
      expect(await selectedNames(page)).toEqual([names[1], names[0], names[2]]);
      expect(await page.locator(".cycle-position").allTextContents()).toEqual(["1", "2", "3"]);
      expect(await page.evaluate(() =>
        document.activeElement?.querySelector(".device-name")?.textContent
      )).toBe(names[0]);
      await expectHealthyInspector(page, browserErrors);
    } finally {
      await context.close();
    }
  });

  it.each([250, 280, 360, 1280])("long-press touch drag reorders selected rows at %ipx", async (width) => {
    const { context, page, browserErrors } = await openFixturePage(browser, origin, fixture, 900, width);
    try {
      const names = await selectedNames(page);
      await page.locator("#refreshBtn").focus();
      const firstGrip = await centerOf(page.locator(".drag-grip").first());
      const thirdRow = await centerOf(page.locator(".device-row-selected").nth(2));
      await dispatchTouchGesture(page, {
        start: firstGrip,
        end: { x: thirdRow.x, y: thirdRow.y },
        holdMs: 800,
        moveSteps: 6,
      });

      await expectPersistedSettings(page, 1);
      expect(await selectedNames(page)).toEqual([names[1], names[2], names[0]]);
      expect(await page.locator(".cycle-position").allTextContents()).toEqual(["1", "2", "3"]);
      await expectHealthyInspector(page, browserErrors);
    } finally {
      await context.close();
    }
  }, 15_000);

  it.each([250, 280, 360, 1280])("keyboard Remove removes a selected row at %ipx", async (width) => {
    const { context, page, browserErrors } = await openFixturePage(browser, origin, fixture, 900, width);
    try {
      const names = await selectedNames(page);
      const remove = page.locator(".remove-device").first();
      await remove.focus();
      await remove.press("Enter");

      await expectPersistedSettings(page, 1);
      expect(await selectedNames(page)).toEqual(names.slice(1));
      await expectHealthyInspector(page, browserErrors);
    } finally {
      await context.close();
    }
  });

  it.each([250, 280, 360, 1280])("touch Remove removes a selected row at %ipx", async (width) => {
    const { context, page, browserErrors } = await openFixturePage(browser, origin, fixture, 900, width);
    try {
      const names = await selectedNames(page);
      await page.locator(".remove-device").nth(1).tap();

      await expectPersistedSettings(page, 1);
      expect(await selectedNames(page)).toEqual([names[0], names[2]]);
      await expectHealthyInspector(page, browserErrors);
    } finally {
      await context.close();
    }
  });

  it.each([250, 280, 360, 1280])("mouse Remove removes a selected row at %ipx", async (width) => {
    const { context, page, browserErrors } = await openFixturePage(browser, origin, fixture, 900, width);
    try {
      const names = await selectedNames(page);
      await page.locator(".remove-device").nth(2).click();

      await expectPersistedSettings(page, 1);
      expect(await selectedNames(page)).toEqual(names.slice(0, 2));
      await expectHealthyInspector(page, browserErrors);
    } finally {
      await context.close();
    }
  });

  it.each([250, 280, 360])("keeps selected-row controls contained and error-free at %ipx", async (width) => {
    const { context, page, browserErrors } = await openFixturePage(
      browser,
      origin,
      fixture,
      900,
      width
    );
    try {
      const layout = await page.evaluate(() => {
        const selectedRows = [...document.querySelectorAll<HTMLElement>(
          ".device-row-selected"
        )];
        const ids = [...document.querySelectorAll<HTMLElement>("[id]")].map(
          (element) => element.id
        );
        return {
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          structures: selectedRows.map((row) =>
            [...row.querySelector(".device-line")!.children].map(
              (child) => (child as HTMLElement).className
            )
          ),
          separated: selectedRows.every((row) => {
            const position = row.querySelector<HTMLElement>(".cycle-position")!
              .getBoundingClientRect();
            const identity = row.querySelector<HTMLElement>(".device-identity")!
              .getBoundingClientRect();
            const grip = row.querySelector<HTMLElement>(".drag-grip")!
              .getBoundingClientRect();
            const remove = row.querySelector<HTMLElement>(".remove-device")!
              .getBoundingClientRect();
            return (
              position.left >= 0 &&
              position.right <= identity.left &&
              identity.right <= grip.left &&
              grip.right <= document.documentElement.clientWidth &&
              remove.left >= identity.left &&
              remove.right <= identity.right &&
              remove.height >= 28
            );
          }),
          duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index),
          injectedElements: document.querySelectorAll(
            ".device-list img, .device-list svg, .status-bar script"
          ).length,
          fixturePwned: Boolean((globalThis as any).fixturePwned),
        };
      });

      expect(layout.scrollWidth).toBe(layout.clientWidth);
      expect(layout.structures).toEqual([
        ["cycle-position", "device-identity", "drag-grip"],
        ["cycle-position", "device-identity", "drag-grip"],
        ["cycle-position", "device-identity", "drag-grip"],
      ]);
      expect(layout.separated).toBe(true);
      expect(layout.duplicateIds).toEqual([]);
      expect(layout.injectedElements).toBe(0);
      expect(layout.fixturePwned).toBe(false);
      expect(browserErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("long-press touch drag reorders, renumbers, and persists at 250px", async () => {
    const { context, page } = await openFixturePage(browser, origin, fixture);
    try {
      await page.locator("#refreshBtn").focus();
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
        "model:mx keys s wireless illuminated keyboard with a deliberately long display name|keyboard",
        "404",
        "serial:G502X-PLUS-001",
      ]);
      await expect.poll(() => page.locator("#reorderAnnouncement").textContent()).toBe(
        "Moved G502 X Plus to position 3 of 3"
      );
      expect(await page.evaluate(() =>
        document.activeElement?.classList.contains("device-row-selected") ?? false
      )).toBe(false);
    } finally {
      await context.close();
    }
  }, 15_000);

  it("removes ordinary, active, and missing selected rows through keyboard, touch, and mouse at 250px", async () => {
    const cases = [
      {
        name: "G502 X Plus",
        mode: "keyboard",
        expectedClass: "device-row-current",
      },
      {
        name: "MX Keys S Wireless Illuminated Keyboard With A Deliberately Long Display Name",
        mode: "touch",
        expectedClass: "device-row-selected",
      },
      {
        name: "Saved Aerox <img src=x onerror=globalThis.fixturePwned=true>",
        mode: "mouse",
        expectedClass: "device-row-missing",
      },
    ] as const;

    for (const testCase of cases) {
      const { context, page } = await openFixturePage(browser, origin, fixture);
      try {
        const row = page.locator(".device-row-selected").filter({ hasText: testCase.name }).first();
        const remove = row.getByRole("button", {
          name: `Remove ${testCase.name} from cycle`,
        });
        await row.waitFor({ state: "visible" });
        expect(await row.evaluate((element, className) =>
          element.classList.contains(className), testCase.expectedClass
        )).toBe(true);
        expect(await row.locator(".device-line").evaluate((line) =>
          [...line.children].map((child) => child.className)
        )).toEqual(["cycle-position", "device-identity", "drag-grip"]);
        expect(await remove.evaluate((button) =>
          button.closest(".device-identity") !== null
        )).toBe(true);
        const target = await remove.boundingBox();
        expect(target?.height ?? 0).toBeGreaterThanOrEqual(28);

        if (testCase.mode === "keyboard") {
          await remove.focus();
          await remove.press("Enter");
        } else if (testCase.mode === "touch") {
          await remove.tap();
        } else {
          await remove.click();
        }

        await expect.poll(() => page.locator(".device-row-selected").count()).toBe(2);
        expect(await page.locator(".device-row-selected .device-name").allTextContents())
          .not.toContain(testCase.name);
        const persisted = await page.evaluate(() =>
          globalThis.__fixtureSocket().sent.filter((message) => message.event === "setSettings")
        );
        expect(persisted).toHaveLength(1);
        expect(persisted[0].payload.selectedDevices.map((device: any) => device.name))
          .not.toContain(testCase.name);
        expect(await page.evaluate(() => document.documentElement.scrollWidth))
          .toBe(await page.evaluate(() => document.documentElement.clientWidth));
      } finally {
        await context.close();
      }
    }
  }, 15_000);

  it("keeps the moved row focused across two consecutive Alt+Arrow moves", async () => {
    const { context, page } = await openFixturePage(browser, origin, fixture);
    try {
      const movedName = "G502 X Plus";
      const movedRow = page.locator(".device-row-selected").filter({
        has: page.locator(".device-name", { hasText: movedName }),
      });
      await movedRow.focus();

      await movedRow.press("Alt+ArrowDown");
      await expect.poll(() => page.evaluate(() =>
        document.activeElement?.querySelector(".device-name")?.textContent
      )).toBe(movedName);
      await movedRow.press("Alt+ArrowDown");
      await expect.poll(() => page.evaluate(() =>
        document.activeElement?.querySelector(".device-name")?.textContent
      )).toBe(movedName);

      expect(await page.locator(".device-row-selected .device-name").allTextContents()).toEqual([
        "MX Keys S Wireless Illuminated Keyboard With A Deliberately Long Display Name",
        "Saved Aerox <img src=x onerror=globalThis.fixturePwned=true>",
        "G502 X Plus",
      ]);
      expect(
        await page.evaluate(() =>
          globalThis.__fixtureSocket().sent.filter((message) => message.event === "setSettings").length
        )
      ).toBe(2);
    } finally {
      await context.close();
    }
  });

  it("does not move focus onto a reordered row after mouse drag", async () => {
    const { context, page } = await openFixturePage(browser, origin, fixture);
    try {
      await page.locator("#refreshBtn").focus();
      await page.locator(".drag-grip").first().dragTo(
        page.locator(".device-row-selected").nth(2)
      );
      await expect.poll(() => page.evaluate(() =>
        globalThis.__fixtureSocket().sent.filter((message) => message.event === "setSettings").length
      )).toBe(1);
      expect(await page.evaluate(() =>
        document.activeElement?.classList.contains("device-row-selected") ?? false
      )).toBe(false);
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
  height = 900,
  width = 250
): Promise<{ context: BrowserContext; page: Page; browserErrors: string[] }> {
  const context = await browser.newContext({
    viewport: { width, height },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => browserErrors.push(`page: ${error.message}`));
  page.on("requestfailed", (request) => {
    browserErrors.push(
      `request: ${request.url()} ${request.failure()?.errorText ?? "failed"}`
    );
  });
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
    const runtime = state.lastKnownAges
      ? {
          ...state.runtime,
          statuses: state.runtime.statuses.map((status: Record<string, any>) => ({
            ...status,
            freshness: "last-known",
            observedAt: Date.now() - state.lastKnownAges[status.deviceKey],
          })),
        }
      : state.runtime;
    globalThis.__fixtureSocket().receive({
      event: "sendToPropertyInspector",
      payload: state.discovery,
    });
    globalThis.__fixtureSocket().receive({
      event: "sendToPropertyInspector",
      payload: runtime,
    });
  }, fixture);
  await page.locator(".device-row-selected").first().waitFor({ state: "visible" });
  return { context, page, browserErrors };
}

function freshnessFixture(): Record<string, any> {
  const apex = {
    key: "steelseries:apex-pro",
    provider: "steelseries",
    providerLabel: "SteelSeries GG",
    nativeId: "apex-pro",
    name: "Apex Pro",
    deviceType: "Keyboard",
  };
  const arctis = {
    key: "steelseries:arctis-nova-7",
    provider: "steelseries",
    providerLabel: "SteelSeries GG",
    nativeId: "arctis-nova-7",
    name: "Arctis Nova 7",
    deviceType: "Headset",
  };
  return {
    action: "com.jcooler.peripheral-battery.monitor",
    context: "freshness-property-inspector-context",
    settings: { schemaVersion: 2, selectedDevices: [apex, arctis] },
    discovery: { event: "deviceList", state: "success", devices: [apex, arctis] },
    runtime: {
      event: "deviceRuntimeStatus",
      currentDeviceKey: apex.key,
      statuses: [
        { deviceKey: apex.key, state: "connected", batteryText: "~85%" },
        { deviceKey: arctis.key, state: "connected", batteryText: "~72%" },
      ],
    },
    lastKnownAges: {
      [apex.key]: 23 * 60 * 1_000,
      [arctis.key]: 3 * 24 * 60 * 60 * 1_000,
    },
  };
}

async function selectedNames(page: Page): Promise<string[]> {
  return page.locator(".device-row-selected .device-name").allTextContents();
}

async function expectPersistedSettings(page: Page, count: number): Promise<void> {
  await expect.poll(() => page.evaluate(() =>
    globalThis.__fixtureSocket().sent.filter((message) => message.event === "setSettings").length
  )).toBe(count);
}

async function expectHealthyInspector(page: Page, browserErrors: string[]): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    duplicateIds: [...document.querySelectorAll<HTMLElement>("[id]")]
      .map((element) => element.id)
      .filter((id, index, ids) => ids.indexOf(id) !== index),
    injectedElements: document.querySelectorAll(
      ".device-list img, .device-list svg, .status-bar script"
    ).length,
  }));
  expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
  expect(dimensions.duplicateIds).toEqual([]);
  expect(dimensions.injectedElements).toBe(0);
  expect(browserErrors).toEqual([]);
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
