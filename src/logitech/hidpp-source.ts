import { HIDAsync, devicesAsync } from "node-hid";

import {
  makeDeviceKey,
  unavailableStatus,
  type BatteryStatus,
  type DeviceDescriptor,
  type DeviceRef,
} from "../devices/types";
import {
  HidppProtocolClient,
  type HidppHandle,
} from "./hidpp-protocol";
import { makeLogitechModelIdentity } from "./identity";

const PROVIDER_ID = "logitech" as const;
const PROVIDER_LABEL = "Logitech";
const LOGITECH_VENDOR_ID = 0x046d;
const G502_X_PLUS_RECEIVER_PRODUCT_ID = 0xc547;
const HIDPP_USAGE_PAGE = 0xff00;
const HIDPP_LONG_REPORT_USAGE = 0x02;
const RECEIVER_DEVICE_INDEX = 0x01;
const G502_NAME = "G502 X PLUS Wireless Gaming Mouse";
const DEFAULT_DISCOVERY_TIMEOUT_MS = 3_000;
const DEFAULT_OPEN_TIMEOUT_MS = 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 1_000;

const G502_IDENTITY = requiredModelIdentity(G502_NAME, "mouse");

export interface LogitechHidDeviceInfo {
  vendorId: number;
  productId: number;
  path?: string;
  product?: string;
  release?: number;
  interface?: number;
  usagePage?: number;
  usage?: number;
}

export interface LogitechHidAdapter {
  devicesAsync(): Promise<LogitechHidDeviceInfo[]>;
  open(path: string, options: { nonExclusive: true }): Promise<HidppHandle>;
}

export interface DirectLogitechSourceOptions {
  adapter?: LogitechHidAdapter;
  now?: () => number;
  discoveryTimeoutMs?: number;
  openTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface Endpoint {
  readonly path: string;
  readonly nativeId: string;
  readonly generation: number;
}

const nodeHidAdapter: LogitechHidAdapter = {
  devicesAsync: () => devicesAsync(),
  open: (path, options) => HIDAsync.open(path, options),
};

export class DirectLogitechSource {
  readonly id = PROVIDER_ID;
  readonly label = PROVIDER_LABEL;

  private readonly adapter: LogitechHidAdapter;
  private readonly now: () => number;
  private readonly discoveryTimeoutMs: number;
  private readonly openTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private endpoint: Endpoint | null = null;
  private discoveryCompleted = false;
  private discoveryGeneration = 0;
  private readonly endpointQueues = new Map<string, Promise<void>>();

  constructor(options: DirectLogitechSourceOptions = {}) {
    this.adapter = options.adapter ?? nodeHidAdapter;
    this.now = options.now ?? Date.now;
    this.discoveryTimeoutMs =
      options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
    this.openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async discover(signal?: AbortSignal): Promise<DeviceDescriptor[]> {
    const generation = ++this.discoveryGeneration;
    const devices = await withDeadline(
      this.adapter.devicesAsync(),
      this.discoveryTimeoutMs,
      signal,
      "Direct HID++ discovery timed out"
    );
    if (generation !== this.discoveryGeneration) {
      throw new Error("Direct HID++ discovery was invalidated");
    }

    const candidates = devices.flatMap((candidate) => {
      const path = allowlistedPath(candidate);
      return path ? [path] : [];
    });
    this.endpoint =
      candidates.length === 1
        ? {
            path: candidates[0],
            nativeId: G502_IDENTITY.nativeId,
            generation,
          }
        : null;
    this.discoveryCompleted = true;
    return this.endpoint ? [toDescriptor()] : [];
  }

  async readStatus(
    ref: DeviceRef,
    signal?: AbortSignal
  ): Promise<BatteryStatus> {
    if (signal?.aborted) throw abortReason(signal);
    if (!isValidReference(ref)) {
      return unavailableStatus(ref, this.now(), "Invalid Logitech identity");
    }
    if (!this.discoveryCompleted) {
      return unavailableStatus(
        ref,
        this.now(),
        "Direct HID++ discovery has not completed"
      );
    }
    const endpoint = this.endpoint;
    if (!endpoint) {
      return disconnectedStatus(
        this.now(),
        "G502 endpoint absent from the latest direct discovery"
      );
    }

    return this.enqueue(endpoint.nativeId, () =>
      this.readQueued(endpoint, ref, signal)
    );
  }

  invalidateDiscovery(_reason?: string): void {
    this.discoveryGeneration += 1;
    this.endpoint = null;
    this.discoveryCompleted = false;
  }

  private enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.endpointQueues.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.endpointQueues.set(key, tail);
    void tail.then(() => {
      if (this.endpointQueues.get(key) === tail) this.endpointQueues.delete(key);
    });
    return result;
  }

  private async readQueued(
    endpoint: Endpoint,
    ref: DeviceRef,
    signal?: AbortSignal
  ): Promise<BatteryStatus> {
    if (signal?.aborted) throw abortReason(signal);
    if (!this.isCurrentEndpoint(endpoint)) {
      return unavailableStatus(
        ref,
        this.now(),
        "Direct HID++ discovery was invalidated"
      );
    }

    const openOperation = this.adapter.open(endpoint.path, {
      nonExclusive: true,
    });
    let handle: HidppHandle;
    try {
      handle = await withDeadline(
        openOperation,
        this.openTimeoutMs,
        signal,
        "Direct HID++ endpoint open timed out"
      );
    } catch (error) {
      void openOperation.then((lateHandle) => safeClose(lateHandle)).catch(() => {});
      if (isAbort(error)) throw error;
      return disconnectedStatus(
        this.now(),
        "Direct HID++ endpoint could not be opened"
      );
    }

    try {
      const protocol = new HidppProtocolClient(handle, {
        requestTimeoutMs: this.requestTimeoutMs,
      });
      const version = await protocol.getProtocolVersion(
        RECEIVER_DEVICE_INDEX,
        signal
      );
      if (version.major !== 4) {
        return unavailableStatus(
          ref,
          this.now(),
          "Direct HID++ protocol is unsupported"
        );
      }

      let feature: { index: number };
      try {
        feature = await protocol.getFeature(
          RECEIVER_DEVICE_INDEX,
          0x1000,
          signal
        );
      } catch (error) {
        if (isAbort(error)) throw error;
        if (errorMessage(error).includes("feature is unsupported")) {
          return unavailableStatus(
            ref,
            this.now(),
            "Direct HID++ battery feature is unavailable"
          );
        }
        throw error;
      }
      const battery = await protocol.getBatteryStatus(
        RECEIVER_DEVICE_INDEX,
        feature.index,
        signal
      );
      if (!this.isCurrentEndpoint(endpoint)) {
        return unavailableStatus(
          ref,
          this.now(),
          "Direct HID++ discovery was invalidated"
        );
      }
      return {
        state: "connected",
        level: { kind: "percentage", value: battery.percentage },
        charging: battery.charging,
        provider: PROVIDER_ID,
        providerLabel: PROVIDER_LABEL,
        observedAt: this.now(),
        detail: "Direct HID++",
      };
    } catch (error) {
      if (isAbort(error)) throw error;
      const detail = errorMessage(error).includes("timed out")
        ? "Direct HID++ request timed out"
        : "Direct HID++ battery status is unavailable";
      return unavailableStatus(ref, this.now(), detail);
    } finally {
      await safeClose(handle);
    }
  }

  private isCurrentEndpoint(endpoint: Endpoint): boolean {
    return (
      this.discoveryCompleted &&
      this.endpoint === endpoint &&
      endpoint.generation === this.discoveryGeneration
    );
  }
}

function allowlistedPath(device: LogitechHidDeviceInfo): string | null {
  if (
    device.vendorId !== LOGITECH_VENDOR_ID ||
    device.productId !== G502_X_PLUS_RECEIVER_PRODUCT_ID ||
    device.usagePage !== HIDPP_USAGE_PAGE ||
    device.usage !== HIDPP_LONG_REPORT_USAGE
  ) {
    return null;
  }
  const path = device.path?.trim();
  return path || null;
}

function requiredModelIdentity(
  displayName: string,
  deviceType: string
): { nativeId: string; physicalId: string } {
  const identity = makeLogitechModelIdentity(displayName, deviceType);
  if (!identity) throw new Error("G502 identity is invalid");
  return identity;
}

function toDescriptor(): DeviceDescriptor {
  return {
    key: makeDeviceKey(PROVIDER_ID, G502_IDENTITY.nativeId),
    provider: PROVIDER_ID,
    providerLabel: PROVIDER_LABEL,
    nativeId: G502_IDENTITY.nativeId,
    name: G502_NAME,
    deviceType: "Mouse",
    physicalId: G502_IDENTITY.physicalId,
  };
}

function isValidReference(ref: DeviceRef): boolean {
  return (
    ref.provider === PROVIDER_ID &&
    ref.nativeId === G502_IDENTITY.nativeId &&
    ref.key === makeDeviceKey(PROVIDER_ID, G502_IDENTITY.nativeId)
  );
}

function disconnectedStatus(observedAt: number, detail: string): BatteryStatus {
  return {
    state: "disconnected",
    level: { kind: "unavailable" },
    charging: null,
    provider: PROVIDER_ID,
    providerLabel: PROVIDER_LABEL,
    observedAt,
    detail,
  };
}

class DeadlineError extends Error {}

function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  timeoutMessage: string
): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortReason(signal)));
    const timer = setTimeout(
      () => finish(() => reject(new DeadlineError(timeoutMessage))),
      timeoutMs
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    );
  });
}

async function safeClose(handle: HidppHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // The handle is generation-scoped and cannot be reused after this point.
  }
}

function abortReason(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
