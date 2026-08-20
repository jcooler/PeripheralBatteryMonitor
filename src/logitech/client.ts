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
import {
  identifyLogitechDevices,
  mapLogitechDeviceType,
  type LogitechIdentityCandidate,
} from "./identity";

const PROVIDER_ID = "logitech" as const;
const PROVIDER_LABEL = "Logitech G Hub";
const GHUB_WS_URL = "ws://localhost:9010";
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;
const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

export interface GHubDevice {
  id: string;
  extendedDisplayName?: string;
  deviceType?: string;
  serialNumber?: string;
  serial?: string;
  deviceSerialNumber?: string;
  connected?: boolean;
  capabilities?: {
    hasBatteryStatus?: boolean;
  };
}

interface GHubBatteryState {
  percentage?: unknown;
  charging?: unknown;
}

export interface LogitechSocket {
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: Buffer) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  send(data: string): void;
  close(): void;
}

export interface LogitechClientOptions {
  createSocket?: () => LogitechSocket;
  now?: () => number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  generation: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class LogitechClient implements DeviceProvider {
  readonly id = PROVIDER_ID;
  readonly label = PROVIDER_LABEL;

  private readonly createSocket: () => LogitechSocket;
  private readonly now: () => number;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  private socket: LogitechSocket | null = null;
  private socketGeneration = 0;
  private connected = false;
  private connectPromise: Promise<boolean> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private requestId = 0;
  private pendingRequests = new Map<string, PendingRequest>();
  private endpoints = new Map<string, GHubDevice>();
  private discoveryGeneration = 0;
  private discoveryInFlight: Promise<DeviceDescriptor[]> | null = null;
  private hasDiscovered = false;
  private destroyed = false;

  constructor(options: LogitechClientOptions = {}) {
    this.createSocket =
      options.createSocket ??
      (() =>
        new WebSocketModule(GHUB_WS_URL, ["json"], {
          headers: {
            Origin: "file://",
            Pragma: "no-cache",
            "Cache-Control": "no-cache",
          },
        }) as unknown as LogitechSocket);
    this.now = options.now ?? Date.now;
    this.connectTimeoutMs =
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async initialize(): Promise<boolean> {
    if (this.destroyed) return false;
    if (this.connected && this.socket) return true;
    if (this.connectPromise) return this.connectPromise;

    const promise = this.connect();
    this.connectPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.connectPromise === promise) this.connectPromise = null;
    }
  }

  discover(signal?: AbortSignal): Promise<DeviceDescriptor[]> {
    if (this.discoveryInFlight) return this.discoveryInFlight;
    const request = this.fetchDevices(signal);
    this.discoveryInFlight = request;
    void request
      .finally(() => {
        if (this.discoveryInFlight === request) this.discoveryInFlight = null;
      })
      .catch(() => undefined);
    return request;
  }

  async readStatus(
    ref: DeviceRef,
    signal?: AbortSignal
  ): Promise<BatteryStatus> {
    if (
      ref.provider !== PROVIDER_ID ||
      ref.key !== makeDeviceKey(PROVIDER_ID, ref.nativeId)
    ) {
      return unavailableStatus(ref, this.now(), "Invalid Logitech identity");
    }

    const ready = await this.initialize();
    if (!ready) {
      return unavailableStatus(ref, this.now(), "Logitech G Hub unavailable");
    }

    const device = this.endpoints.get(ref.nativeId);
    if (!device) {
      return unavailableStatus(
        ref,
        this.now(),
        "Logitech device not found; refresh discovery"
      );
    }
    if (device.connected === false) {
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

    try {
      const response = (await this.sendRequest(
        `/battery/${encodeURIComponent(device.id)}/state`,
        signal
      )) as { payload?: GHubBatteryState };
      const percentage = response?.payload?.percentage;
      if (!isPercentage(percentage)) {
        return unavailableStatus(
          ref,
          this.now(),
          "Logitech G Hub did not report a valid battery percentage"
        );
      }
      const charging = response.payload?.charging;
      return {
        state: "connected",
        level: { kind: "percentage", value: percentage },
        charging: typeof charging === "boolean" ? charging : null,
        provider: PROVIDER_ID,
        providerLabel: PROVIDER_LABEL,
        observedAt: this.now(),
      };
    } catch (error) {
      return unavailableStatus(ref, this.now(), errorMessage(error));
    }
  }

  invalidateDiscovery(): void {
    this.discoveryGeneration += 1;
    this.discoveryInFlight = null;
    this.endpoints.clear();
  }

  /** Compatibility wrapper until the Stream Deck action uses DeviceCatalog. */
  async getDevices(): Promise<GHubDevice[]> {
    try {
      await this.discover();
      return [...this.endpoints.values()];
    } catch {
      return [];
    }
  }

  /** Compatibility wrapper; resolves only a current persistent identity. */
  async getBatteryInfo(device: GHubDevice): Promise<BatteryInfo> {
    const candidate = identifyLogitechDevices([...this.endpoints.values()]).candidates.find(
      ({ device: endpoint }) => endpoint === device
    );
    if (!candidate) return unavailableLegacyBattery(device);

    const ref = toDescriptor(candidate);
    const status = await this.readStatus(ref);
    return {
      deviceId: hashString(ref.nativeId),
      deviceName: ref.name,
      deviceType: ref.deviceType,
      batteryLevel:
        status.level.kind === "percentage" ? status.level.value : -1,
      isCharging: status.charging === true,
      isConnected: status.state !== "disconnected",
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearReconnectTimer();
    this.socketGeneration += 1;
    this.discoveryGeneration += 1;
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    socket?.close();
    this.endpoints.clear();
    this.rejectPending(new Error("Logitech G Hub client stopped"));
  }

  private connect(): Promise<boolean> {
    const generation = ++this.socketGeneration;
    const oldSocket = this.socket;
    this.socket = null;
    this.connected = false;
    oldSocket?.close();

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (result: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };

      let socket: LogitechSocket;
      try {
        socket = this.createSocket();
      } catch {
        this.scheduleReconnect();
        resolve(false);
        return;
      }
      this.socket = socket;

      const timeout = setTimeout(() => {
        if (!this.isCurrentSocket(socket, generation)) return;
        this.handleSocketLoss(
          socket,
          generation,
          new Error("Logitech G Hub connection timed out")
        );
        socket.close();
        finish(false);
      }, this.connectTimeoutMs);

      socket.on("open", () => {
        if (!this.isCurrentSocket(socket, generation)) return;
        this.connected = true;
        this.reconnectAttempt = 0;
        this.clearReconnectTimer();
        finish(true);
        if (this.hasDiscovered) {
          queueMicrotask(() => void this.discover().catch(() => undefined));
        }
      });
      socket.on("message", (data) => {
        if (!this.isCurrentSocket(socket, generation)) return;
        this.handleMessage(data, generation);
      });
      socket.on("close", () => {
        if (!this.isCurrentSocket(socket, generation)) return;
        this.handleSocketLoss(
          socket,
          generation,
          new Error("Logitech G Hub connection closed")
        );
        finish(false);
      });
      socket.on("error", (error) => {
        if (!this.isCurrentSocket(socket, generation)) return;
        this.handleSocketLoss(socket, generation, error);
        socket.close();
        finish(false);
      });
    });
  }

  private async fetchDevices(signal?: AbortSignal): Promise<DeviceDescriptor[]> {
    const ready = await this.initialize();
    if (!ready) throw new Error("Logitech G Hub unavailable");
    const generation = this.discoveryGeneration;
    const response = (await this.sendRequest("/devices/list", signal)) as {
      payload?: { deviceInfos?: unknown };
    };
    if (generation !== this.discoveryGeneration || this.destroyed) {
      throw new Error("Logitech discovery generation changed");
    }
    const rawDevices = response?.payload?.deviceInfos;
    if (!Array.isArray(rawDevices)) {
      throw new Error("Logitech G Hub returned an invalid device list");
    }

    const identities = identifyLogitechDevices(rawDevices.filter(isGHubDevice));
    const identityCounts = new Map<string, number>();
    for (const candidate of identities.candidates) {
      identityCounts.set(
        candidate.nativeId,
        (identityCounts.get(candidate.nativeId) ?? 0) + 1
      );
    }

    const endpoints = new Map<string, GHubDevice>();
    const descriptors: DeviceDescriptor[] = [];
    for (const candidate of identities.candidates) {
      if (identityCounts.get(candidate.nativeId) !== 1) continue;
      endpoints.set(candidate.nativeId, candidate.device);
      descriptors.push(toDescriptor(candidate));
    }
    if (generation !== this.discoveryGeneration || this.destroyed) {
      throw new Error("Logitech discovery generation changed");
    }
    this.endpoints = endpoints;
    this.hasDiscovered = true;
    return descriptors;
  }

  private sendRequest(path: string, signal?: AbortSignal): Promise<unknown> {
    const socket = this.socket;
    const generation = this.socketGeneration;
    if (!socket || !this.connected) {
      return Promise.reject(new Error("Logitech G Hub is not connected"));
    }

    return new Promise<unknown>((resolve, reject) => {
      const id = `rr-${++this.requestId}`;
      const timer = setTimeout(() => {
        const error = new Error("Logitech G Hub request timed out");
        this.finishPending(
          id,
          error
        );
        if (this.isCurrentSocket(socket, generation)) {
          this.handleSocketLoss(socket, generation, error);
          socket.close();
        }
      }, this.requestTimeoutMs);
      const entry: PendingRequest = {
        generation,
        resolve,
        reject,
        timer,
        signal,
      };
      if (signal) {
        entry.onAbort = () => {
          const error = new Error("Logitech G Hub request aborted");
          error.name = "AbortError";
          this.finishPending(id, error);
        };
        if (signal.aborted) {
          clearTimeout(timer);
          entry.onAbort();
          return;
        }
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.pendingRequests.set(id, entry);
      try {
        socket.send(
          JSON.stringify({ msgId: id, verb: "GET", path })
        );
      } catch (error) {
        this.finishPending(
          id,
          error instanceof Error ? error : new Error(String(error))
        );
      }
    });
  }

  private handleMessage(data: Buffer, generation: number): void {
    try {
      const response = JSON.parse(Buffer.from(data).toString("utf8")) as {
        msgId?: unknown;
        error?: unknown;
      };
      if (typeof response.msgId !== "string") return;
      const pending = this.pendingRequests.get(response.msgId);
      if (!pending || pending.generation !== generation) return;
      if (response.error) {
        this.finishPending(
          response.msgId,
          new Error(`Logitech G Hub request failed: ${String(response.error)}`)
        );
      } else {
        this.finishPending(response.msgId, undefined, response);
      }
    } catch {
      // Malformed unsolicited messages do not affect pending requests.
    }
  }

  private finishPending(id: string, error?: Error, value?: unknown): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) return;
    this.pendingRequests.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    if (error) pending.reject(error);
    else pending.resolve(value);
  }

  private rejectPending(error: Error): void {
    for (const id of [...this.pendingRequests.keys()]) {
      this.finishPending(id, error);
    }
  }

  private handleSocketLoss(
    socket: LogitechSocket,
    generation: number,
    error: Error
  ): void {
    if (!this.isCurrentSocket(socket, generation)) return;
    this.socket = null;
    this.connected = false;
    this.discoveryGeneration += 1;
    this.discoveryInFlight = null;
    this.endpoints.clear();
    this.rejectPending(error);
    this.scheduleReconnect();
  }

  private isCurrentSocket(socket: LogitechSocket, generation: number): boolean {
    return (
      !this.destroyed &&
      this.socket === socket &&
      this.socketGeneration === generation
    );
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
      const connected = await this.initialize();
      if (!connected) this.scheduleReconnect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

function isGHubDevice(value: unknown): value is GHubDevice {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) {
    return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toDescriptor(
  candidate: LogitechIdentityCandidate
): DeviceDescriptor {
  const { device, nativeId, physicalId } = candidate;
  return {
    key: makeDeviceKey(PROVIDER_ID, nativeId),
    provider: PROVIDER_ID,
    providerLabel: PROVIDER_LABEL,
    nativeId,
    name: device.extendedDisplayName?.trim() || "Logitech device",
    deviceType: mapLogitechDeviceType(device.deviceType),
    ...(physicalId ? { physicalId } : {}),
  };
}

function unavailableLegacyBattery(device: GHubDevice): BatteryInfo {
  return {
    deviceId: hashString(device.id),
    deviceName: device.extendedDisplayName?.trim() || "Logitech device",
    deviceType: mapLogitechDeviceType(device.deviceType),
    batteryLevel: -1,
    isCharging: false,
    isConnected: false,
  };
}

function isPercentage(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Temporary numeric compatibility for the legacy action settings only. */
function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}
