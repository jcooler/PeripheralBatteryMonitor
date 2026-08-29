import { readFile } from "node:fs/promises";
import { request as nodeHttpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { join } from "node:path";
import WebSocketModule from "ws";

import {
  makeDeviceKey,
  unavailableStatus,
  type BatteryStatus,
  type DeviceDescriptor,
  type DeviceProvider,
  type DeviceRef,
} from "../devices/types";
import type { BatteryInfo } from "../types";
import type {
  SteelSeriesBatteryCacheEntry,
  SteelSeriesBatteryCacheStore,
} from "./battery-cache";
import type { CoreProps, DevicesResponse, SteelSeriesDevice } from "./types";

const PROVIDER_ID = "steelseries" as const;
const PROVIDER_LABEL = "SteelSeries GG";
const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const LIVE_DATA_MAX_AGE_MS = 15 * 60 * 1_000;
const BATTERY_HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_NAME_LENGTH = 160;
const MAX_TYPE_LENGTH = 80;
const SAFE_DISPLAY_METADATA_PATTERN = /^[\p{L}\p{N} .+'()&_/-]+$/u;
const SENSITIVE_DISPLAY_METADATA_PATTERN =
  /(?:\b(?:https?|wss?|file):\/\/|(?:^|\s)[A-Za-z]:[\\/]|\\\\|\/(?:dev|sys|proc|usb|hidraw)(?:[\\/]|$)|\b(?:hid|usb)(?:[:#\\/]|[_-]?vid|[_-][0-9a-f]{4}(?:[_-]|$))|\b(?:vid|pid)[_:= -]?[0-9a-f]{4}\b|\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b|\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b|\bserial(?=[A-Za-z0-9])|\b(?:serial|s\/n|sn)[_:= -]+[A-Za-z0-9]|\bsn(?=\d))/i;
const CACHE_WARNING = "SteelSeries battery cache unavailable";

const DEFAULT_CORE_PROPS_PATHS = [
  join(
    process.env.PROGRAMDATA || "C:\\ProgramData",
    "SteelSeries",
    "SteelSeries Engine 3",
    "coreProps.json"
  ),
  "/Library/Application Support/SteelSeries Engine 3/coreProps.json",
];

export interface SteelSeriesHttpRequest {
  address: string;
  method: "GET";
  path: "/devices";
  signal?: AbortSignal;
}

export type SteelSeriesHttpGetter = (
  request: SteelSeriesHttpRequest
) => Promise<unknown>;

export interface SteelSeriesSocketOptions {
  headers: { Origin: string };
  rejectUnauthorized: false;
}

export interface SteelSeriesSocket {
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: Buffer) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  close(): void;
  /** Exposed by test doubles; the client intentionally never calls it. */
  send?(data: unknown): void;
}

export interface SteelSeriesClientOptions {
  corePropsPaths?: string[];
  readTextFile?: (path: string) => Promise<string>;
  httpGet?: SteelSeriesHttpGetter;
  createSocket?: (
    url: string,
    options: SteelSeriesSocketOptions
  ) => SteelSeriesSocket;
  now?: () => number;
  liveDataMaxAgeMs?: number;
  handshakeTimeoutMs?: number;
  batteryCache?: SteelSeriesBatteryCacheStore;
  diagnosticSink?: { warn(message: string): void };
}

interface LiveBattery {
  level: number;
  charging: boolean | null;
  observedAt: number;
}

type HttpsRequestImplementation = typeof nodeHttpsRequest;

export function createSteelSeriesHttpsGetter(
  requestImpl: HttpsRequestImplementation = nodeHttpsRequest
): SteelSeriesHttpGetter {
  return async (request) => {
    if (request.method !== "GET" || request.path !== "/devices") {
      throw new Error("SteelSeries transport permits only GET /devices");
    }
    const { hostname, port } = parseLoopbackAddress(request.address);

    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let responseBytes = 0;
      const chunks: Buffer[] = [];

      const finish = (error?: Error, value?: unknown): void => {
        if (settled) return;
        settled = true;
        request.signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(value);
      };

      const options: RequestOptions = {
        hostname,
        port,
        path: request.path,
        method: "GET",
        headers: { Accept: "application/json" },
        rejectUnauthorized: false,
      };
      const outgoing = requestImpl(options, (response) => {
        response.on("error", (error) => finish(error));
        response.on("aborted", () =>
          finish(new Error("SteelSeries GG response was aborted"))
        );
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          response.resume();
          finish(new Error(`SteelSeries GG returned HTTP ${status}`));
          return;
        }
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          responseBytes += buffer.length;
          if (responseBytes > MAX_RESPONSE_BYTES) {
            const error = new Error("SteelSeries response is too large");
            finish(error);
            outgoing.destroy(error);
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => {
          try {
            finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            finish(new Error("SteelSeries GG returned invalid JSON"));
          }
        });
      });

      const onAbort = (): void => {
        const error = new Error("SteelSeries request aborted");
        error.name = "AbortError";
        finish(error);
        outgoing.destroy(error);
      };
      outgoing.on("error", (error) => finish(error));
      outgoing.setTimeout(5_000, () => {
        const error = new Error("SteelSeries GG request timed out");
        finish(error);
        outgoing.destroy(error);
      });
      if (request.signal?.aborted) onAbort();
      else request.signal?.addEventListener("abort", onAbort, { once: true });
      outgoing.end();
    });
  };
}

export class SteelSeriesClient implements DeviceProvider {
  readonly id = PROVIDER_ID;
  readonly label = PROVIDER_LABEL;

  private readonly corePropsPaths: string[];
  private readonly readTextFile: (path: string) => Promise<string>;
  private readonly httpGet: SteelSeriesHttpGetter;
  private readonly createSocket: (
    url: string,
    options: SteelSeriesSocketOptions
  ) => SteelSeriesSocket;
  private readonly now: () => number;
  private readonly liveDataMaxAgeMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly batteryCache: SteelSeriesBatteryCacheStore | undefined;
  private readonly diagnosticSink: { warn(message: string): void } | undefined;

  private encryptedAddress: string | null = null;
  private initialized = false;
  private initPromise: Promise<boolean> | null = null;
  private cachedDevices = new Map<string, SteelSeriesDevice>();
  private inventoryWasDiscovered = false;
  private liveBatteryData = new Map<string, LiveBattery>();
  private cachedBatteryData = new Map<string, SteelSeriesBatteryCacheEntry>();
  private batteryCacheHydration: Promise<void> | null = null;
  private batteryTombstones = new Set<string>();
  private connectionData = new Map<string, boolean>();
  private headsetConnectionData = new Map<string, string>();
  private connectionEventSequence = 0;
  private connectionEventSequences = new Map<string, number>();
  private socket: SteelSeriesSocket | null = null;
  private socketGeneration = 0;
  private lifecycleGeneration = 0;
  private discoveryGeneration = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private destroyed = false;

  constructor(options: SteelSeriesClientOptions = {}) {
    this.corePropsPaths = options.corePropsPaths ?? DEFAULT_CORE_PROPS_PATHS;
    this.readTextFile = options.readTextFile ?? ((path) => readFile(path, "utf8"));
    this.httpGet = options.httpGet ?? createSteelSeriesHttpsGetter();
    this.createSocket =
      options.createSocket ??
      ((url, socketOptions) =>
        new WebSocketModule(url, socketOptions) as unknown as SteelSeriesSocket);
    this.now = options.now ?? Date.now;
    this.liveDataMaxAgeMs = options.liveDataMaxAgeMs ?? LIVE_DATA_MAX_AGE_MS;
    this.handshakeTimeoutMs =
      options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.batteryCache = options.batteryCache;
    this.diagnosticSink = options.diagnosticSink;
  }

  async initialize(): Promise<boolean> {
    if (this.destroyed) return false;
    if (this.initialized && this.encryptedAddress && this.socket) return true;
    if (this.initPromise) return this.initPromise;

    const generation = this.lifecycleGeneration;
    const promise = this.doInitialize(generation);
    this.initPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.initPromise === promise) this.initPromise = null;
    }
  }

  async reinitialize(): Promise<boolean> {
    if (this.destroyed) return false;
    this.resetEngineGeneration();
    return this.initialize();
  }

  async discover(signal?: AbortSignal): Promise<DeviceDescriptor[]> {
    const devices = await this.fetchDevices(signal);
    return devices.map(toDescriptor);
  }

  async readStatus(ref: DeviceRef): Promise<BatteryStatus> {
    await this.ensureBatteryCacheHydrated();
    if (
      ref.provider !== PROVIDER_ID ||
      ref.key !== makeDeviceKey(PROVIDER_ID, ref.nativeId)
    ) {
      return unavailableStatus(ref, this.now(), "Invalid SteelSeries identity");
    }

    const device = this.cachedDevices.get(ref.nativeId);
    if (!device) {
      return unavailableStatus(ref, this.now(), "SteelSeries device not found");
    }
    if (!matchesConfiguredMetadata(device, ref)) {
      return unavailableStatus(
        ref,
        this.now(),
        "SteelSeries identity metadata changed"
      );
    }

    const connected = this.isConnected(device);
    if (!connected) {
      return {
        state: "disconnected",
        level: { kind: "unavailable" },
        charging: null,
        provider: PROVIDER_ID,
        providerLabel: PROVIDER_LABEL,
        observedAt: this.now(),
        detail: "Disconnected",
      };
    }

    const battery = this.newestBattery(String(device.id));
    if (!battery) {
      return unavailableStatus(
        ref,
        this.now(),
        "Waiting for passive SteelSeries battery data"
      );
    }

    const isFresh = this.now() - battery.observedAt <= this.liveDataMaxAgeMs;
    return {
      state: "connected",
      level: { kind: "percentage", value: battery.level },
      charging: isFresh ? battery.charging : null,
      provider: PROVIDER_ID,
      providerLabel: PROVIDER_LABEL,
      observedAt: battery.observedAt,
      ...(isFresh ? {} : { freshness: "last-known" as const }),
    };
  }

  /** Compatibility wrapper until the Stream Deck action uses DeviceCatalog. */
  async getDevices(): Promise<SteelSeriesDevice[]> {
    try {
      return await this.fetchDevices();
    } catch {
      return [];
    }
  }

  /** Compatibility wrapper; intentionally performs no network operation. */
  async getBatteryInfo(device: SteelSeriesDevice): Promise<BatteryInfo> {
    const ref = toDescriptor(device);
    if (this.cachedDevices.get(ref.nativeId) !== device) {
      return unavailableLegacyBattery(device);
    }
    const status = await this.readStatus(ref);
    return {
      deviceId: device.id,
      deviceName: ref.name,
      deviceType: ref.deviceType,
      batteryLevel:
        status.level.kind === "percentage" ? status.level.value : -1,
      isCharging: status.charging === true,
      isConnected: status.state !== "disconnected",
    };
  }

  invalidateDiscovery(): void {
    this.discoveryGeneration += 1;
    this.cachedDevices.clear();
  }

  destroy(): void {
    this.destroyed = true;
    this.lifecycleGeneration += 1;
    this.discoveryGeneration += 1;
    this.clearReconnectTimer();
    this.socketGeneration += 1;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.cachedDevices.clear();
    this.inventoryWasDiscovered = false;
    this.liveBatteryData.clear();
    this.cachedBatteryData.clear();
    this.batteryTombstones.clear();
    this.clearConnectionEvidence();
    this.initialized = false;
    this.encryptedAddress = null;
  }

  private async doInitialize(generation: number): Promise<boolean> {
    for (const path of this.corePropsPaths) {
      try {
        const raw = await this.readTextFile(path);
        if (!this.isCurrentLifecycle(generation)) return false;
        const props = JSON.parse(raw) as Partial<CoreProps>;
        if (!props.encryptedAddress) continue;
        parseLoopbackAddress(props.encryptedAddress);
        if (!this.isCurrentLifecycle(generation)) return false;
        this.encryptedAddress = props.encryptedAddress;
        this.initialized = false;
        const connected = await this.connectSocket(
          props.encryptedAddress,
          generation
        );
        if (!connected || !this.isCurrentLifecycle(generation)) return false;
        this.initialized = true;
        this.reconnectAttempt = 0;
        return true;
      } catch {
        if (!this.isCurrentLifecycle(generation)) return false;
        // Try the next platform-specific coreProps path.
      }
    }
    if (!this.isCurrentLifecycle(generation)) return false;
    this.initialized = false;
    this.encryptedAddress = null;
    this.scheduleReconnect();
    return false;
  }

  private async fetchDevices(signal?: AbortSignal): Promise<SteelSeriesDevice[]> {
    await this.ensureBatteryCacheHydrated();
    const ready = await this.initialize();
    if (!ready || !this.encryptedAddress) {
      throw new Error("SteelSeries GG unavailable");
    }

    const lifecycleGeneration = this.lifecycleGeneration;
    const discoveryGeneration = this.discoveryGeneration;
    const connectionEventSequence = this.connectionEventSequence;
    const address = this.encryptedAddress;
    const payload = (await this.httpGet({
      address,
      method: "GET",
      path: "/devices",
      signal,
    })) as Partial<DevicesResponse> | null;
    if (
      !this.isCurrentLifecycle(lifecycleGeneration) ||
      discoveryGeneration !== this.discoveryGeneration ||
      address !== this.encryptedAddress
    ) {
      throw new Error("SteelSeries engine generation changed");
    }
    if (!payload || !Array.isArray(payload.devices)) {
      throw new Error("SteelSeries GG returned an invalid device list");
    }

    const validInventory = payload.devices.filter(isSteelSeriesDevice);
    const identityCounts = new Map<number, number>();
    for (const device of validInventory) {
      identityCounts.set(device.id, (identityCounts.get(device.id) ?? 0) + 1);
    }
    const batteryDevices = validInventory.filter(
      (device) =>
        hasBatteryCapability(device) && identityCounts.get(device.id) === 1
    );
    for (const device of batteryDevices) {
      const nativeId = String(device.id);
      const lastConnectionEvent = this.connectionEventSequences.get(nativeId) ?? 0;
      if (lastConnectionEvent <= connectionEventSequence) {
        this.connectionData.delete(nativeId);
        this.headsetConnectionData.delete(nativeId);
        this.connectionEventSequences.delete(nativeId);
        if (device.connected === 0) this.discardBattery(nativeId);
      }
    }
    const nextDevices = new Map(
      batteryDevices.map((device) => [String(device.id), device])
    );
    this.cachedDevices = nextDevices;
    for (const [id, count] of identityCounts) {
      const nativeId = String(id);
      const device = nextDevices.get(nativeId);
      if (count !== 1 || device === undefined) {
        if (
          this.liveBatteryData.has(nativeId) ||
          this.cachedBatteryData.has(nativeId)
        ) {
          this.discardBattery(nativeId);
        }
        continue;
      }
      const metadata = exactBatteryMetadata(device);
      const cached = this.cachedBatteryData.get(nativeId);
      if (
        device.connected === 0 ||
        (cached !== undefined &&
          (cached.name !== metadata.name ||
            cached.deviceType !== metadata.deviceType))
      ) {
        this.discardBattery(nativeId);
        continue;
      }
      this.persistValidatedLiveBattery(device);
    }
    this.inventoryWasDiscovered = true;
    return batteryDevices;
  }

  private connectSocket(
    address: string,
    lifecycleGeneration: number
  ): Promise<boolean> {
    this.clearReconnectTimer();
    const generation = ++this.socketGeneration;
    const oldSocket = this.socket;
    this.socket = null;
    oldSocket?.close();

    let socket: SteelSeriesSocket;
    try {
      socket = this.createSocket(`wss://${address}/sock`, {
        headers: { Origin: "file://" },
        rejectUnauthorized: false,
      });
    } catch {
      this.encryptedAddress = null;
      this.scheduleReconnect();
      return Promise.resolve(false);
    }
    this.socket = socket;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let opened = false;
      const finish = (result: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(handshakeTimer);
        resolve(result);
      };
      const handshakeTimer = setTimeout(() => {
        if (!this.isCurrentSocket(socket, generation) || opened) return;
        this.handleSocketLoss(socket, generation);
        socket.close();
        finish(false);
      }, this.handshakeTimeoutMs);

      socket.on("open", () => {
        if (
          !this.isCurrentSocket(socket, generation) ||
          !this.isCurrentLifecycle(lifecycleGeneration)
        ) {
          return;
        }
        opened = true;
        finish(true);
      });
      socket.on("message", (data) => {
        if (!opened || !this.isCurrentSocket(socket, generation)) return;
        this.handleSocketMessage(data);
      });
      socket.on("close", () => {
        if (!this.isCurrentSocket(socket, generation)) return;
        this.handleSocketLoss(socket, generation);
        finish(false);
      });
      socket.on("error", () => {
        if (!this.isCurrentSocket(socket, generation)) return;
        this.handleSocketLoss(socket, generation);
        socket.close();
        finish(false);
      });
    });
  }

  private handleSocketLoss(
    socket: SteelSeriesSocket,
    generation: number
  ): void {
    if (!this.isCurrentSocket(socket, generation)) return;
    this.socket = null;
    this.initialized = false;
    this.encryptedAddress = null;
    this.lifecycleGeneration += 1;
    this.discoveryGeneration += 1;
    this.cachedDevices.clear();
    this.clearConnectionEvidence();
    this.scheduleReconnect();
  }

  private isCurrentSocket(
    socket: SteelSeriesSocket,
    generation: number
  ): boolean {
    return this.socket === socket && this.socketGeneration === generation;
  }

  private handleSocketMessage(data: Buffer): void {
    try {
      const message = JSON.parse(Buffer.from(data).toString("utf8")) as {
        event?: string;
        data?: Record<string, unknown>;
      };
      if (message.event === "device_event" && message.data) {
        this.handleDeviceEvent(message.data);
      }
    } catch {
      // Malformed events are ignored without changing the last valid status.
    }
  }

  private handleDeviceEvent(data: Record<string, unknown>): void {
    const rawId = data.id;
    if (typeof rawId !== "number" && typeof rawId !== "string") return;
    const nativeId = String(rawId);

    if (isRecord(data.battery_status)) {
      const level = data.battery_status.level;
      const charging = data.battery_status.charging;
      if (isPercentage(level)) {
        this.batteryTombstones.delete(nativeId);
        this.liveBatteryData.set(nativeId, {
          level,
          charging: typeof charging === "number" ? charging === 1 : null,
          observedAt: this.now(),
        });
      }
    }

    if (isRecord(data.batteryEvent)) {
      const level = data.batteryEvent.batteryPercent;
      if (isPercentage(level)) {
        const existing = this.liveBatteryData.get(nativeId);
        this.batteryTombstones.delete(nativeId);
        this.liveBatteryData.set(nativeId, {
          level,
          charging: existing?.charging ?? null,
          observedAt: this.now(),
        });
      }
    }

    if (isRecord(data.connection_status)) {
      const status = data.connection_status.status;
      if (status === 0 || status === 1) {
        const connected = status === 1;
        this.recordConnectionEvent(nativeId);
        this.connectionData.set(nativeId, connected);
        if (!connected) this.discardBattery(nativeId);
      }
    }

    if (isRecord(data.connectionEvent)) {
      const status = data.connectionEvent.connectionStatus;
      if (typeof status === "string") {
        this.recordConnectionEvent(nativeId);
        this.headsetConnectionData.set(nativeId, status);
        if (!isConnectedHeadsetState(status)) {
          this.discardBattery(nativeId);
        }
      }
    }

    if (isRecord(data.chargingEvent)) {
      const status = data.chargingEvent.chargingStatus;
      const existing = this.liveBatteryData.get(nativeId);
      if (existing && typeof status === "string") {
        existing.charging = status === "PLUGGED_IN_CHARGING";
      }
    }

    const device = this.cachedDevices.get(nativeId);
    if (device) this.persistValidatedLiveBattery(device);
  }

  private isConnected(device: SteelSeriesDevice): boolean {
    const nativeId = String(device.id);
    if (isHeadsetType(device)) {
      const headsetStatus = this.headsetConnectionData.get(nativeId);
      if (headsetStatus) {
        return isConnectedHeadsetState(headsetStatus);
      }
    }
    return this.connectionData.get(nativeId) ?? device.connected === 1;
  }

  private resetEngineGeneration(): void {
    this.clearReconnectTimer();
    this.lifecycleGeneration += 1;
    this.discoveryGeneration += 1;
    this.socketGeneration += 1;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.initialized = false;
    this.encryptedAddress = null;
    this.initPromise = null;
    this.cachedDevices.clear();
    this.clearConnectionEvidence();
  }

  private clearConnectionEvidence(): void {
    this.connectionData.clear();
    this.headsetConnectionData.clear();
    this.connectionEventSequence = 0;
    this.connectionEventSequences.clear();
  }

  private recordConnectionEvent(nativeId: string): void {
    this.connectionEventSequence += 1;
    this.connectionEventSequences.set(nativeId, this.connectionEventSequence);
  }

  private newestBattery(
    nativeId: string
  ): SteelSeriesBatteryCacheEntry | undefined {
    if (this.batteryTombstones.has(nativeId)) return undefined;
    const device = this.cachedDevices.get(nativeId);
    if (!device) return undefined;
    const metadata = exactBatteryMetadata(device);

    const live = this.liveBatteryData.get(nativeId);
    const liveEntry = live
      ? { nativeId, ...metadata, ...live }
      : undefined;
    const cached = this.cachedBatteryData.get(nativeId);
    const cachedEntry =
      cached && cached.name === metadata.name && cached.deviceType === metadata.deviceType
        ? cached
        : undefined;
    const newest =
      liveEntry && (!cachedEntry || liveEntry.observedAt >= cachedEntry.observedAt)
        ? liveEntry
        : cachedEntry;
    if (!newest) return undefined;
    if (this.now() - newest.observedAt > BATTERY_HISTORY_MAX_AGE_MS) {
      this.discardBattery(nativeId);
      return undefined;
    }
    return newest;
  }

  private persistValidatedLiveBattery(device: SteelSeriesDevice): void {
    if (!this.batteryCache || !hasBatteryCapability(device)) return;
    const nativeId = String(device.id);
    if (
      this.cachedDevices.get(nativeId) !== device ||
      this.batteryTombstones.has(nativeId) ||
      !this.isConnected(device)
    ) {
      return;
    }
    const metadata = batteryMetadata(device);
    const live = this.liveBatteryData.get(nativeId);
    if (!metadata || !live) return;
    const entry: SteelSeriesBatteryCacheEntry = {
      nativeId,
      ...metadata,
      ...live,
    };
    if (!isValidBatteryCacheEntry(entry, this.now())) return;
    void this.batteryCache.upsert(entry).catch(() => this.warnCacheUnavailable());
  }

  private discardBattery(nativeId: string): void {
    this.liveBatteryData.delete(nativeId);
    this.cachedBatteryData.delete(nativeId);
    if (this.batteryTombstones.has(nativeId)) return;
    this.batteryTombstones.add(nativeId);
    if (this.batteryCache) {
      void this.batteryCache.remove(nativeId).catch(() => this.warnCacheUnavailable());
    }
  }

  private ensureBatteryCacheHydrated(): Promise<void> {
    if (!this.batteryCache) return Promise.resolve();
    if (this.batteryCacheHydration) return this.batteryCacheHydration;
    this.batteryCacheHydration = this.batteryCache
      .load()
      .then((entries) => {
        const now = this.now();
        for (const candidate of entries) {
          const nativeId = validBatteryCacheNativeId(candidate?.nativeId)
            ? candidate.nativeId
            : undefined;
          if (!isValidBatteryCacheEntry(candidate, now)) {
            if (nativeId !== undefined) this.discardBattery(nativeId);
            continue;
          }
          if (this.batteryTombstones.has(candidate.nativeId)) continue;
          const live = this.liveBatteryData.get(candidate.nativeId);
          if (!live || candidate.observedAt > live.observedAt) {
            this.cachedBatteryData.set(candidate.nativeId, { ...candidate });
          }
        }
      })
      .catch(() => this.warnCacheUnavailable());
    return this.batteryCacheHydration;
  }

  private warnCacheUnavailable(): void {
    this.diagnosticSink?.warn(CACHE_WARNING);
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;
    const delay = Math.min(
      RECONNECT_DELAY_MS * 2 ** this.reconnectAttempt,
      MAX_RECONNECT_DELAY_MS
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.destroyed) return;
      const restoreInventory = this.inventoryWasDiscovered;
      const connected = await this.reinitialize();
      if (connected && restoreInventory) {
        try {
          await this.fetchDevices();
        } catch {
          // The configured identity remains unavailable until a later refresh.
        }
      }
      if (!connected) this.scheduleReconnect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private isCurrentLifecycle(generation: number): boolean {
    return !this.destroyed && this.lifecycleGeneration === generation;
  }
}

function toDescriptor(device: SteelSeriesDevice): DeviceDescriptor {
  const nativeId = String(device.id);
  return {
    key: makeDeviceKey(PROVIDER_ID, nativeId),
    provider: PROVIDER_ID,
    providerLabel: PROVIDER_LABEL,
    nativeId,
    name: device.display_name || device.name,
    deviceType: device.deviceTypeName || String(device.type),
  };
}

function batteryMetadata(
  device: SteelSeriesDevice
): Pick<SteelSeriesBatteryCacheEntry, "name" | "deviceType"> | undefined {
  const { name, deviceType } = exactBatteryMetadata(device);
  if (
    !validDisplayMetadata(name, MAX_NAME_LENGTH) ||
    !validDisplayMetadata(deviceType, MAX_TYPE_LENGTH)
  ) {
    return undefined;
  }
  return { name, deviceType };
}

function exactBatteryMetadata(
  device: SteelSeriesDevice
): Pick<SteelSeriesBatteryCacheEntry, "name" | "deviceType"> {
  return {
    name: device.display_name || device.name,
    deviceType: device.deviceTypeName || String(device.type),
  };
}

function validDisplayMetadata(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    SAFE_DISPLAY_METADATA_PATTERN.test(value) &&
    !SENSITIVE_DISPLAY_METADATA_PATTERN.test(value)
  );
}

function validBatteryCacheNativeId(value: unknown): value is string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
    return false;
  }
  return Number.isSafeInteger(Number(value));
}

function isValidBatteryCacheEntry(
  value: unknown,
  now: number
): value is SteelSeriesBatteryCacheEntry {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 6 ||
    keys.join(",") !== "charging,deviceType,level,name,nativeId,observedAt"
  ) {
    return false;
  }
  return (
    validBatteryCacheNativeId(value.nativeId) &&
    validDisplayMetadata(value.name, MAX_NAME_LENGTH) &&
    validDisplayMetadata(value.deviceType, MAX_TYPE_LENGTH) &&
    typeof value.level === "number" &&
    Number.isInteger(value.level) &&
    value.level >= 0 &&
    value.level <= 100 &&
    (value.charging === true || value.charging === false || value.charging === null) &&
    typeof value.observedAt === "number" &&
    Number.isFinite(value.observedAt) &&
    value.observedAt >= 0 &&
    value.observedAt <= now &&
    now - value.observedAt <= BATTERY_HISTORY_MAX_AGE_MS
  );
}

function matchesConfiguredMetadata(
  device: SteelSeriesDevice,
  ref: DeviceRef
): boolean {
  const currentName = device.display_name || device.name;
  const currentType = device.deviceTypeName || String(device.type);
  return (
    ref.name === currentName &&
    (ref.deviceType === currentType || ref.deviceType === "Device")
  );
}

function unavailableLegacyBattery(device: SteelSeriesDevice): BatteryInfo {
  return {
    deviceId: device.id,
    deviceName: device.display_name || device.name,
    deviceType: device.deviceTypeName || String(device.type),
    batteryLevel: -1,
    isCharging: false,
    isConnected: false,
  };
}

function hasBatteryCapability(device: SteelSeriesDevice): boolean {
  return (
    Array.isArray(device.genericDevicePropertiesStatus) &&
    device.genericDevicePropertiesStatus.includes("batteryLevels")
  );
}

function isSteelSeriesDevice(value: unknown): value is SteelSeriesDevice {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    value.id >= 0 &&
    typeof value.name === "string" &&
    value.name.trim().length > 0 &&
    typeof value.display_name === "string" &&
    typeof value.type === "number" &&
    Number.isFinite(value.type) &&
    typeof value.deviceTypeName === "string" &&
    (value.connected === 0 || value.connected === 1) &&
    (value.genericDevicePropertiesStatus === undefined ||
      (Array.isArray(value.genericDevicePropertiesStatus) &&
        value.genericDevicePropertiesStatus.every(
          (property) => typeof property === "string"
        )))
  );
}

function isConnectedHeadsetState(status: string): boolean {
  return (
    status === "CONNECTED" ||
    status === "HEADSET_CONNECTED" ||
    status === "PAIRED_CONNECTED" ||
    status === "PAIRED_AND_CONNECTED"
  );
}

function isHeadsetType(device: SteelSeriesDevice): boolean {
  return (
    device.deviceTypeName?.toLowerCase() === "headset" ||
    device.type === 3
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPercentage(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  );
}

function parseLoopbackAddress(address: string): {
  hostname: string;
  port: number;
} {
  const bracketed = /^\[(::1)\]:(\d{1,5})$/.exec(address);
  const ordinary = /^([^:/?#@]+):(\d{1,5})$/.exec(address);
  const match = bracketed ?? ordinary;
  if (!match) throw new Error("SteelSeries GG address is invalid");
  const hostname = match[1].toLowerCase();
  const ipVersion = isIP(hostname);
  const loopback =
    hostname === "localhost" ||
    hostname === "::1" ||
    (ipVersion === 4 && hostname.startsWith("127."));
  const port = Number(match[2]);
  if (!loopback) throw new Error("SteelSeries GG address must be loopback");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SteelSeries GG address has an invalid port");
  }
  return { hostname, port };
}
