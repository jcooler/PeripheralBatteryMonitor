import { describe, expect, test } from "vitest";
import type { JsonObject } from "@elgato/utils";
import {
  createSteelSeriesBatteryCacheStore,
  type SteelSeriesBatteryCacheEntry,
  type SteelSeriesGlobalSettingsBackend,
} from "../../src/steelseries/battery-cache";

const MINUTE_MS = 60 * 1_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const now = 40 * DAY_MS;

const apexEntry: SteelSeriesBatteryCacheEntry = {
  nativeId: "330",
  name: "Apex Pro TKL Wireless",
  deviceType: "Keyboard",
  level: 85,
  charging: false,
  observedAt: now - 20 * MINUTE_MS,
};

const arctisEntry: SteelSeriesBatteryCacheEntry = {
  nativeId: "245",
  name: "Arctis Nova 7",
  deviceType: "Headset",
  level: 62,
  charging: true,
  observedAt: now - 10 * MINUTE_MS,
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

class FakeGlobalSettingsBackend implements SteelSeriesGlobalSettingsBackend {
  private settings: JsonObject;
  readonly writes: JsonObject[] = [];
  private failuresRemaining = 0;

  constructor(initial: JsonObject = {}) {
    this.settings = clone(initial);
  }

  failNextWrite(): void {
    this.failuresRemaining += 1;
  }

  async getGlobalSettings(): Promise<JsonObject> {
    return clone(this.settings);
  }

  async setGlobalSettings(settings: JsonObject): Promise<void> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("backend write rejected");
    }
    this.settings = clone(settings);
    this.writes.push(clone(settings));
  }

  get latest(): JsonObject {
    return clone(this.settings);
  }
}

function cacheIds(settings: JsonObject): string[] {
  const cache = settings.steelseriesBatteryCacheV1;
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) return [];
  const entries = cache.entries;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.nativeId === "string"
      ? [entry.nativeId]
      : []
  );
}

function storedEntry(overrides: Partial<SteelSeriesBatteryCacheEntry> = {}): JsonObject {
  return { ...apexEntry, ...overrides } as unknown as JsonObject;
}

describe("SteelSeries battery cache loading", () => {
  test("loads a valid bounded cache entry and ignores unrelated settings", async () => {
    const backend = new FakeGlobalSettingsBackend({
      unrelated: { keep: true },
      steelseriesBatteryCacheV1: {
        schemaVersion: 1,
        entries: [storedEntry()],
      },
    });
    const store = createSteelSeriesBatteryCacheStore(backend, { now: () => now });

    await expect(store.load()).resolves.toEqual([apexEntry]);
  });

  test("treats missing and malformed cache containers as empty", async () => {
    const malformedContainers: JsonObject[] = [
      {},
      { steelseriesBatteryCacheV1: null },
      { steelseriesBatteryCacheV1: [] },
      { steelseriesBatteryCacheV1: { schemaVersion: 2, entries: [] } },
      { steelseriesBatteryCacheV1: { schemaVersion: 1, entries: {} } },
    ];

    for (const settings of malformedContainers) {
      const store = createSteelSeriesBatteryCacheStore(new FakeGlobalSettingsBackend(settings), {
        now: () => now,
      });
      await expect(store.load()).resolves.toEqual([]);
    }
  });

  test("drops entries with noncanonical or unsafe native IDs", async () => {
    const entries = [
      storedEntry({ nativeId: "" }),
      storedEntry({ nativeId: "01" }),
      storedEntry({ nativeId: "+1" }),
      storedEntry({ nativeId: "1.0" }),
      storedEntry({ nativeId: "9007199254740992" }),
      storedEntry({ nativeId: "330" }),
    ];
    const store = createSteelSeriesBatteryCacheStore(
      new FakeGlobalSettingsBackend({ steelseriesBatteryCacheV1: { schemaVersion: 1, entries } }),
      { now: () => now }
    );

    await expect(store.load()).resolves.toEqual([apexEntry]);
  });

  test("drops blank, untrimmed, and oversized metadata", async () => {
    const entries = [
      storedEntry({ nativeId: "1", name: "" }),
      storedEntry({ nativeId: "2", name: " Apex Pro TKL Wireless" }),
      storedEntry({ nativeId: "3", name: "a".repeat(161) }),
      storedEntry({ nativeId: "4", deviceType: "" }),
      storedEntry({ nativeId: "5", deviceType: " Keyboard" }),
      storedEntry({ nativeId: "6", deviceType: "a".repeat(81) }),
      storedEntry(),
    ];
    const store = createSteelSeriesBatteryCacheStore(
      new FakeGlobalSettingsBackend({ steelseriesBatteryCacheV1: { schemaVersion: 1, entries } }),
      { now: () => now }
    );

    await expect(store.load()).resolves.toEqual([apexEntry]);
  });

  test("drops metadata that contains URLs, paths, addresses, or hardware identifiers", async () => {
    const unsafeNames = [
      "https://steelseries.example/device",
      "C:\\Program Files\\SteelSeries",
      "hid#vid_1038&pid_185A#serial-001",
      "usb:1038:185A",
      "VID_1038&PID_185A",
      "127.0.0.1:57192",
      "serial:SS-SECRET-001",
      "S/N:SS-SECRET-001",
      "SN1234",
    ];
    const unsafeEntries = unsafeNames.map((name, index) =>
      storedEntry({ nativeId: String(index + 1), name })
    );
    unsafeEntries.push(
      storedEntry({ nativeId: "9", deviceType: "usb:1038:185A" }),
      storedEntry({
        nativeId: "10",
        name: "Apex Pro TKL Wireless v2.1+' (Gen_2) -",
        deviceType: "Mouse & Keyboard_Pro",
      })
    );
    const store = createSteelSeriesBatteryCacheStore(
      new FakeGlobalSettingsBackend({
        steelseriesBatteryCacheV1: { schemaVersion: 1, entries: unsafeEntries },
      }),
      { now: () => now }
    );

    await expect(store.load()).resolves.toEqual([
      {
        ...apexEntry,
        nativeId: "10",
        name: "Apex Pro TKL Wireless v2.1+' (Gen_2) -",
        deviceType: "Mouse & Keyboard_Pro",
      },
    ]);
  });

  test("drops invalid levels and charging values", async () => {
    const entries = [
      storedEntry({ nativeId: "1", level: -1 }),
      storedEntry({ nativeId: "2", level: 101 }),
      storedEntry({ nativeId: "3", level: 12.5 }),
      storedEntry({ nativeId: "4", level: "85" }),
      storedEntry({ nativeId: "5", charging: "false" }),
      storedEntry({ nativeId: "6", charging: 0 }),
      storedEntry({ nativeId: "7", charging: undefined }),
      storedEntry({ charging: null }),
    ];
    const store = createSteelSeriesBatteryCacheStore(
      new FakeGlobalSettingsBackend({ steelseriesBatteryCacheV1: { schemaVersion: 1, entries } }),
      { now: () => now }
    );

    await expect(store.load()).resolves.toEqual([{ ...apexEntry, charging: null }]);
  });

  test("drops non-finite, future, and stale timestamps", async () => {
    const entries = [
      storedEntry({ nativeId: "1", observedAt: Number.NaN }),
      storedEntry({ nativeId: "2", observedAt: Number.POSITIVE_INFINITY }),
      storedEntry({ nativeId: "3", observedAt: now + 1 }),
      storedEntry({ nativeId: "4", observedAt: now - 30 * DAY_MS - 1 }),
      storedEntry({ observedAt: now - 30 * DAY_MS }),
    ];
    const store = createSteelSeriesBatteryCacheStore(
      new FakeGlobalSettingsBackend({ steelseriesBatteryCacheV1: { schemaVersion: 1, entries } }),
      { now: () => now }
    );

    await expect(store.load()).resolves.toEqual([{ ...apexEntry, observedAt: now - 30 * DAY_MS }]);
  });

  test("drops every entry for an ambiguous duplicate native ID", async () => {
    const duplicate = storedEntry({ level: 20, observedAt: now - 1 * MINUTE_MS });
    const store = createSteelSeriesBatteryCacheStore(
      new FakeGlobalSettingsBackend({
        steelseriesBatteryCacheV1: {
          schemaVersion: 1,
          entries: [storedEntry(), duplicate, { ...arctisEntry } as unknown as JsonObject],
        },
      }),
      { now: () => now }
    );

    await expect(store.load()).resolves.toEqual([{ ...arctisEntry }]);
  });

  test("orders entries newest first deterministically and caps the result at 32", async () => {
    const entries = Array.from({ length: 35 }, (_, index) =>
      storedEntry({
        nativeId: String(index),
        name: `Device ${index}`,
        deviceType: "Mouse",
        observedAt: now - index * MINUTE_MS,
      })
    );
    const store = createSteelSeriesBatteryCacheStore(
      new FakeGlobalSettingsBackend({ steelseriesBatteryCacheV1: { schemaVersion: 1, entries } }),
      { now: () => now }
    );

    const loaded = await store.load();
    expect(loaded).toHaveLength(32);
    expect(loaded.map((entry) => entry.nativeId)).toEqual(
      Array.from({ length: 32 }, (_, index) => String(index))
    );
  });
});

describe("SteelSeries battery cache mutations", () => {
  test("serializes concurrent upserts, keeps newest duplicate state, and preserves unrelated settings", async () => {
    const backend = new FakeGlobalSettingsBackend({ unrelated: { keep: true } });
    const store = createSteelSeriesBatteryCacheStore(backend, { now: () => now });

    const first = store.upsert(apexEntry);
    const second = store.upsert(arctisEntry);
    await Promise.all([first, second]);

    expect(backend.latest.unrelated).toEqual({ keep: true });
    expect(cacheIds(backend.latest)).toEqual(["245", "330"]);
  });

  test("newest observedAt wins for the same ID and queued removal wins", async () => {
    const backend = new FakeGlobalSettingsBackend();
    const store = createSteelSeriesBatteryCacheStore(backend, { now: () => now });
    const older = { ...apexEntry, observedAt: now - 2 * MINUTE_MS, level: 50 };
    const newer = { ...apexEntry, observedAt: now - MINUTE_MS, level: 70 };

    await Promise.all([store.upsert(older), store.upsert(newer), store.remove(apexEntry.nativeId)]);
    await expect(store.load()).resolves.toEqual([]);

    await store.upsert(older);
    await store.upsert(newer);
    await expect(store.load()).resolves.toEqual([newer]);
  });

  test("retries the complete desired snapshot after a rejected write", async () => {
    const backend = new FakeGlobalSettingsBackend({ unrelated: { keep: true } });
    backend.failNextWrite();
    const store = createSteelSeriesBatteryCacheStore(backend, { now: () => now });

    await expect(store.upsert(apexEntry)).rejects.toThrow("backend write rejected");
    await store.upsert(arctisEntry);

    expect(cacheIds(backend.latest)).toEqual(["245", "330"]);
    expect(backend.latest.unrelated).toEqual({ keep: true });
  });
});
