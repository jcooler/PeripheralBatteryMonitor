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
import type { CoreProps, DevicesResponse, SteelSeriesDevice } from "./types";

const PROVIDER_ID = "steelseries" as const;
const PROVIDER_LABEL = "SteelSeries GG";
const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const LIVE_DATA_MAX_AGE_MS = 15 * 60 * 1_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

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
  on(event: "message", listener: (data: Buffer) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  close(): void;
  /** Exposed by test doubles; the client intentionally never calls it. */
  send?(data: unknown): void;
}

interface SteelSeriesClientOptions {
  corePropsPaths?: string[];
  readTextFile?: (path: string) => Promise<string>;
  httpGet?: SteelSeriesHttpGetter;
  createSocket?: (
    url: string,
    options: SteelSeriesSocketOptions
  ) => SteelSeriesSocket;
  now?: () => number;
  liveDataMaxAgeMs?: number;
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
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          response.resume();
          finish(new Error(`SteelSeries GG returned HTTP ${status}`));
          return;
        }
        response.on("error", (error) => finish(error));
        response.on("aborted", () =>
          finish(new Error("SteelSeries GG response was aborted"))
        );
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

  private encryptedAddress: string | null = null;
  private initialized = false;
  private initPromise: Promise<boolean> | null = null;
  private cachedDevices = new Map<string, SteelSeriesDevice>();
  private batteryData = new Map<string, LiveBattery>();
  private connectionData = new Map<string, boolean>();
  private headsetConnectionData = new Map<string, string>();
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

    const battery = this.batteryData.get(ref.nativeId);
    if (
      !battery ||
      this.now() - battery.observedAt > this.liveDataMaxAgeMs
    ) {
      return unavailableStatus(
        ref,
        this.now(),
        "Waiting for passive SteelSeries battery data"
      );
    }

    return {
      state: "connected",
      level: { kind: "percentage", value: battery.level },
      charging: battery.charging,
      provider: PROVIDER_ID,
      providerLabel: PROVIDER_LABEL,
      observedAt: battery.observedAt,
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
    this.clearLiveData();
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
        this.initialized = true;
        this.reconnectAttempt = 0;
        this.connectSocket(props.encryptedAddress);
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
    const ready = await this.initialize();
    if (!ready || !this.encryptedAddress) {
      throw new Error("SteelSeries GG unavailable");
    }

    const lifecycleGeneration = this.lifecycleGeneration;
    const discoveryGeneration = this.discoveryGeneration;
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

    const batteryDevices = payload.devices.filter(hasBatteryCapability);
    this.cachedDevices = new Map(
      batteryDevices.map((device) => [String(device.id), device])
    );
    return batteryDevices;
  }

  private connectSocket(address: string): void {
    this.clearReconnectTimer();
    const generation = ++this.socketGeneration;
    const oldSocket = this.socket;
    this.socket = null;
    oldSocket?.close();

    const socket = this.createSocket(`wss://${address}/sock`, {
      headers: { Origin: "file://" },
      rejectUnauthorized: false,
    });
    this.socket = socket;

    socket.on("message", (data) => {
      if (!this.isCurrentSocket(socket, generation)) return;
      this.handleSocketMessage(data);
    });
    socket.on("close", () => {
      if (!this.isCurrentSocket(socket, generation) || this.destroyed) return;
      this.socket = null;
      this.initialized = false;
      this.encryptedAddress = null;
      this.lifecycleGeneration += 1;
      this.discoveryGeneration += 1;
      this.cachedDevices.clear();
      this.clearLiveData();
      this.scheduleReconnect();
    });
    socket.on("error", () => {
      // The matching close event owns recovery.
    });
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
        this.batteryData.set(nativeId, {
          level,
          charging: typeof charging === "number" ? charging === 1 : null,
          observedAt: this.now(),
        });
      }
    }

    if (isRecord(data.batteryEvent)) {
      const level = data.batteryEvent.batteryPercent;
      if (isPercentage(level)) {
        const existing = this.batteryData.get(nativeId);
        this.batteryData.set(nativeId, {
          level,
          charging: existing?.charging ?? null,
          observedAt: this.now(),
        });
      }
    }

    if (isRecord(data.connection_status)) {
      const status = data.connection_status.status;
      if (typeof status === "number") {
        this.connectionData.set(nativeId, status === 1);
      }
    }

    if (isRecord(data.connectionEvent)) {
      const status = data.connectionEvent.connectionStatus;
      if (typeof status === "string") {
        this.headsetConnectionData.set(nativeId, status);
      }
    }

    if (isRecord(data.chargingEvent)) {
      const status = data.chargingEvent.chargingStatus;
      const existing = this.batteryData.get(nativeId);
      if (existing && typeof status === "string") {
        existing.charging = status === "PLUGGED_IN_CHARGING";
      }
    }
  }

  private isConnected(device: SteelSeriesDevice): boolean {
    const nativeId = String(device.id);
    if (isHeadsetType(device)) {
      const headsetStatus = this.headsetConnectionData.get(nativeId);
      if (headsetStatus) {
        return (
          headsetStatus !== "PAIRED_NOT_CONNECTED" &&
          headsetStatus !== "UNKNOWN_OR_HEADSET_NOT_CONNECTED"
        );
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
    this.clearLiveData();
  }

  private clearLiveData(): void {
    this.batteryData.clear();
    this.connectionData.clear();
    this.headsetConnectionData.clear();
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
      const connected = await this.reinitialize();
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

function hasBatteryCapability(device: SteelSeriesDevice): boolean {
  return device.genericDevicePropertiesStatus?.includes("batteryLevels") === true;
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
  let parsed: URL;
  try {
    parsed = new URL(`https://${address}`);
  } catch {
    throw new Error("SteelSeries GG address is invalid");
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const ipVersion = isIP(hostname);
  const loopback =
    hostname === "localhost" ||
    hostname === "::1" ||
    (ipVersion === 4 && hostname.startsWith("127."));
  const port = Number(parsed.port);
  if (!loopback) throw new Error("SteelSeries GG address must be loopback");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SteelSeries GG address has an invalid port");
  }
  return { hostname, port };
}
