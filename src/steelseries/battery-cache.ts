import type { JsonObject, JsonValue } from "@elgato/utils";

const CACHE_KEY = "steelseriesBatteryCacheV1";
const SCHEMA_VERSION = 1;
const MAX_ENTRIES = 32;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_NAME_LENGTH = 160;
const MAX_TYPE_LENGTH = 80;

export interface SteelSeriesBatteryCacheEntry {
  nativeId: string;
  name: string;
  deviceType: string;
  level: number;
  charging: boolean | null;
  observedAt: number;
}

export interface SteelSeriesBatteryCacheStore {
  load(): Promise<readonly SteelSeriesBatteryCacheEntry[]>;
  upsert(entry: SteelSeriesBatteryCacheEntry): Promise<void>;
  remove(nativeId: string): Promise<void>;
}

export interface SteelSeriesGlobalSettingsBackend {
  getGlobalSettings(): Promise<JsonObject>;
  setGlobalSettings(settings: JsonObject): Promise<void>;
}

export interface SteelSeriesBatteryCacheStoreOptions {
  now?: () => number;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNativeId(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) return undefined;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? value : undefined;
}

function validMetadata(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value
  );
}

function parseEntry(value: unknown, now: number): SteelSeriesBatteryCacheEntry | undefined {
  if (!isRecord(value)) return undefined;
  const nativeId = parseNativeId(value.nativeId);
  if (
    nativeId === undefined ||
    !validMetadata(value.name, MAX_NAME_LENGTH) ||
    !validMetadata(value.deviceType, MAX_TYPE_LENGTH) ||
    typeof value.level !== "number" ||
    !Number.isInteger(value.level) ||
    value.level < 0 ||
    value.level > 100 ||
    (value.charging !== true && value.charging !== false && value.charging !== null) ||
    typeof value.observedAt !== "number" ||
    !Number.isFinite(value.observedAt) ||
    value.observedAt < 0 ||
    value.observedAt > now ||
    now - value.observedAt > MAX_AGE_MS
  ) {
    return undefined;
  }
  return {
    nativeId,
    name: value.name,
    deviceType: value.deviceType,
    level: value.level,
    charging: value.charging,
    observedAt: value.observedAt,
  };
}

function compareEntries(left: SteelSeriesBatteryCacheEntry, right: SteelSeriesBatteryCacheEntry): number {
  if (left.observedAt !== right.observedAt) return right.observedAt - left.observedAt;
  return left.nativeId < right.nativeId ? -1 : left.nativeId > right.nativeId ? 1 : 0;
}

function orderedEntries(desired: Map<string, SteelSeriesBatteryCacheEntry>): SteelSeriesBatteryCacheEntry[] {
  return [...desired.values()]
    .sort(compareEntries)
    .slice(0, MAX_ENTRIES)
    .map((entry) => ({ ...entry }));
}

function parseSettings(settings: JsonObject, now: number): SteelSeriesBatteryCacheEntry[] {
  const rawCache: JsonValue | undefined = settings[CACHE_KEY];
  if (!isRecord(rawCache) || rawCache.schemaVersion !== SCHEMA_VERSION || !Array.isArray(rawCache.entries)) {
    return [];
  }

  const candidateIds = rawCache.entries.map((entry) => parseNativeId(isRecord(entry) ? entry.nativeId : undefined));
  const idCounts = new Map<string, number>();
  for (const nativeId of candidateIds) {
    if (nativeId !== undefined) idCounts.set(nativeId, (idCounts.get(nativeId) ?? 0) + 1);
  }

  const desired = new Map<string, SteelSeriesBatteryCacheEntry>();
  rawCache.entries.forEach((entry, index) => {
    const nativeId = candidateIds[index];
    if (nativeId === undefined || idCounts.get(nativeId) !== 1) return;
    const parsed = parseEntry(entry, now);
    if (parsed !== undefined) desired.set(parsed.nativeId, parsed);
  });
  return orderedEntries(desired);
}

function entryAsJson(entry: SteelSeriesBatteryCacheEntry): JsonObject {
  return { ...entry } as unknown as JsonObject;
}

function cacheAsJson(desired: Map<string, SteelSeriesBatteryCacheEntry>): JsonObject {
  return {
    schemaVersion: SCHEMA_VERSION,
    entries: orderedEntries(desired).map(entryAsJson),
  };
}

function mapEntries(entries: readonly SteelSeriesBatteryCacheEntry[]): Map<string, SteelSeriesBatteryCacheEntry> {
  return new Map(entries.map((entry) => [entry.nativeId, { ...entry }]));
}

export function createSteelSeriesBatteryCacheStore(
  backend: SteelSeriesGlobalSettingsBackend,
  options: SteelSeriesBatteryCacheStoreOptions = {}
): SteelSeriesBatteryCacheStore {
  const now = options.now ?? Date.now;
  let desired: Map<string, SteelSeriesBatteryCacheEntry> | undefined;
  let tail: Promise<void> = Promise.resolve();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  const hydrateIfNeeded = async (settings?: JsonObject): Promise<Map<string, SteelSeriesBatteryCacheEntry>> => {
    if (desired !== undefined) return desired;
    const source = settings ?? (await backend.getGlobalSettings());
    desired = mapEntries(parseSettings(source, now()));
    return desired;
  };

  const load = (): Promise<readonly SteelSeriesBatteryCacheEntry[]> =>
    enqueue(async () => {
      const hydrated = await hydrateIfNeeded();
      return orderedEntries(hydrated);
    });

  const upsert = (entry: SteelSeriesBatteryCacheEntry): Promise<void> =>
    enqueue(async () => {
      const settings = await backend.getGlobalSettings();
      const hydrated = await hydrateIfNeeded(settings);
      const parsed = parseEntry(entry, now());
      if (parsed === undefined) throw new Error("Invalid SteelSeries battery cache entry");
      const existing = hydrated.get(parsed.nativeId);
      if (existing === undefined || parsed.observedAt > existing.observedAt) {
        hydrated.set(parsed.nativeId, parsed);
      }
      const nextSettings: JsonObject = { ...settings, [CACHE_KEY]: cacheAsJson(hydrated) };
      await backend.setGlobalSettings(nextSettings);
    });

  const remove = (nativeId: string): Promise<void> =>
    enqueue(async () => {
      if (parseNativeId(nativeId) === undefined) throw new Error("Invalid SteelSeries native ID");
      const settings = await backend.getGlobalSettings();
      const hydrated = await hydrateIfNeeded(settings);
      hydrated.delete(nativeId);
      const nextSettings: JsonObject = { ...settings, [CACHE_KEY]: cacheAsJson(hydrated) };
      await backend.setGlobalSettings(nextSettings);
    });

  return { load, upsert, remove };
}
