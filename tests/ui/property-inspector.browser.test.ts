import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";

const repoRoot = resolve(import.meta.dirname, "../..");
const uiRoot = resolve(
  repoRoot,
  "com.jcooler.peripheral-battery.sdPlugin/ui"
);

describe("Property Inspector browser layout", () => {
  let browser: Browser;
  let server: Server;
  let origin = "";

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
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolveClose, rejectClose) => {
      server?.close((error) => error ? rejectClose(error) : resolveClose());
    });
  });

  it("contains hostile provider status text without horizontal scrolling at 250px", async () => {
    const fixture = JSON.parse(
      await readFile(
        resolve(repoRoot, "tests/fixtures/property-inspector-logitech-qa.json"),
        "utf8"
      )
    );
    const context = await browser.newContext({
      viewport: { width: 250, height: 900 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      class FixtureWebSocket extends EventTarget {
        static instance: FixtureWebSocket | undefined;
        readyState = 0;

        constructor() {
          super();
          FixtureWebSocket.instance = this;
          queueMicrotask(() => {
            this.readyState = 1;
            this.dispatchEvent(new Event("open"));
          });
        }

        send() {}

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

    try {
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
});

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
    receive(message: unknown): void;
  };
}
