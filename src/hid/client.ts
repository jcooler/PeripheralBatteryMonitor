import { HIDAsync, devicesAsync } from "node-hid";

import {
  makeDeviceKey,
  unavailableStatus,
  type BatteryStatus,
  type DeviceDescriptor,
  type DeviceProvider,
  type DeviceRef,
} from "../devices/types";
import { parseDualSenseInputReport } from "./report";

const PROVIDER_ID = "hid" as const;
const PROVIDER_LABEL = "HID";
const SONY_VENDOR_ID = 0x054c;
const DUALSENSE_PRODUCT_ID = 0x0ce6;
const DUALSENSE_EDGE_PRODUCT_ID = 0x0df2;
const GENERIC_DESKTOP_USAGE_PAGE = 0x01;
const GAMEPAD_USAGE = 0x05;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 3_000;
const DEFAULT_OPEN_TIMEOUT_MS = 1_000;
const DEFAULT_READ_TIMEOUT_MS = 1_000;

export interface HidDeviceInfo {
  vendorId: number;
  productId: number;
  path?: string;
  serialNumber?: string;
  product?: string;
  usagePage?: number;
  usage?: number;
}

export interface HidHandle {
  read(timeoutMs?: number): Promise<Buffer | undefined>;
  close(): Promise<void>;
}

export interface HidAdapter {
  devicesAsync(): Promise<HidDeviceInfo[]>;
  open(path: string): Promise<HidHandle>;
}

export interface HidBatteryProviderOptions {
  adapter?: HidAdapter;
  now?: () => number;
  discoveryTimeoutMs?: number;
  openTimeoutMs?: number;
  readTimeoutMs?: number;
}

interface Endpoint {
  serial: string;
  path: string;
  productId: number;
}

const nodeHidAdapter: HidAdapter = {
  devicesAsync: () => devicesAsync(),
  open: (path) => HIDAsync.open(path),
};

export class HidBatteryProvider implements DeviceProvider {
  readonly id = PROVIDER_ID;
  readonly label = PROVIDER_LABEL;

  private readonly adapter: HidAdapter;
  private readonly now: () => number;
  private readonly discoveryTimeoutMs: number;
  private readonly openTimeoutMs: number;
  private readonly readTimeoutMs: number;
  private endpoints = new Map<string, Endpoint>();
  private discoveryCompleted = false;
  private discoveryGeneration = 0;

  constructor(options: HidBatteryProviderOptions = {}) {
    this.adapter = options.adapter ?? nodeHidAdapter;
    this.now = options.now ?? Date.now;
    this.discoveryTimeoutMs =
      options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
    this.openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
    this.readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  }

  async discover(signal?: AbortSignal): Promise<DeviceDescriptor[]> {
    const generation = ++this.discoveryGeneration;
    const devices = await withDeadline(
      this.adapter.devicesAsync(),
      this.discoveryTimeoutMs,
      signal,
      "HID discovery timed out"
    );
    if (generation !== this.discoveryGeneration) {
      throw new Error("HID discovery was invalidated");
    }

    const candidatesBySerial = new Map<string, Endpoint[]>();
    for (const candidate of devices) {
      const endpoint = toSupportedEndpoint(candidate);
      if (!endpoint) continue;
      const candidates = candidatesBySerial.get(endpoint.serial) ?? [];
      candidates.push(endpoint);
      candidatesBySerial.set(endpoint.serial, candidates);
    }

    const nextEndpoints = new Map<string, Endpoint>();
    for (const [serial, candidates] of candidatesBySerial) {
      candidates.sort((left, right) => left.path.localeCompare(right.path));
      const previous = this.endpoints.get(serial);
      const endpoint =
        candidates.find((candidate) => candidate.path === previous?.path) ??
        candidates[0];
      if (endpoint) nextEndpoints.set(serial, endpoint);
    }

    this.endpoints = nextEndpoints;
    this.discoveryCompleted = true;
    return [...nextEndpoints.values()]
      .sort((left, right) => left.serial.localeCompare(right.serial))
      .map(toDescriptor);
  }

  async readStatus(ref: DeviceRef, signal?: AbortSignal): Promise<BatteryStatus> {
    if (signal?.aborted) throw abortReason(signal);
    const serial = normalizeSerial(ref.nativeId);
    if (
      ref.provider !== PROVIDER_ID ||
      !serial ||
      ref.nativeId !== serial ||
      ref.key !== makeDeviceKey(PROVIDER_ID, serial)
    ) {
      return unavailableStatus(
        ref,
        this.now(),
        "Invalid HID identity"
      );
    }
    if (!this.discoveryCompleted) {
      return unavailableStatus(
        ref,
        this.now(),
        "HID discovery has not completed"
      );
    }

    const endpoint = this.endpoints.get(serial);
    if (!endpoint) {
      return disconnectedStatus(
        this.now(),
        "Device absent from the latest HID discovery"
      );
    }

    const openPromise = this.adapter.open(endpoint.path);
    let handle: HidHandle;
    try {
      handle = await withDeadline(
        openPromise,
        this.openTimeoutMs,
        signal,
        "HID endpoint open timed out"
      );
    } catch (error) {
      // If cancellation/timeout won a race with open(), close a late handle.
      void openPromise.then((lateHandle) => safeClose(lateHandle)).catch(() => {});
      if (isAbort(error)) throw error;
      return disconnectedStatus(
        this.now(),
        `HID endpoint is no longer available: ${errorMessage(error)}`
      );
    }

    const close = closeOnce(handle);
    try {
      let report: Buffer | undefined;
      try {
        report = await withDeadline(
          handle.read(this.readTimeoutMs),
          this.readTimeoutMs + 100,
          signal,
          "HID input read timed out"
        );
      } catch (error) {
        if (isAbort(error)) throw error;
        if (error instanceof DeadlineError) {
          return unavailableStatus(
            ref,
            this.now(),
            "No DualSense input report was available before timeout"
          );
        }
        return disconnectedStatus(
          this.now(),
          `HID input failed: ${errorMessage(error)}`
        );
      }

      if (!report) {
        return unavailableStatus(
          ref,
          this.now(),
          "No DualSense input report was available before timeout"
        );
      }

      const parsed = parseDualSenseInputReport(report);
      if (!parsed.ok) {
        return unavailableStatus(ref, this.now(), parsed.error);
      }

      return {
        state: "connected",
        level: { kind: "percentage", value: parsed.percentage },
        charging: parsed.charging,
        provider: PROVIDER_ID,
        providerLabel: PROVIDER_LABEL,
        observedAt: this.now(),
        detail: "Passive DualSense HID input report (10% increments)",
      };
    } finally {
      await close();
    }
  }

  invalidateDiscovery(_reason?: string): void {
    this.discoveryGeneration += 1;
    this.endpoints.clear();
    this.discoveryCompleted = false;
  }
}

function toSupportedEndpoint(device: HidDeviceInfo): Endpoint | null {
  if (
    device.vendorId !== SONY_VENDOR_ID ||
    (device.productId !== DUALSENSE_PRODUCT_ID &&
      device.productId !== DUALSENSE_EDGE_PRODUCT_ID) ||
    device.usagePage !== GENERIC_DESKTOP_USAGE_PAGE ||
    device.usage !== GAMEPAD_USAGE
  ) {
    return null;
  }
  const serial = normalizeSerial(device.serialNumber);
  const path = device.path?.trim();
  if (!serial || !path) return null;
  return { serial, path, productId: device.productId };
}

function toDescriptor(endpoint: Endpoint): DeviceDescriptor {
  return {
    key: makeDeviceKey(PROVIDER_ID, endpoint.serial),
    provider: PROVIDER_ID,
    providerLabel: PROVIDER_LABEL,
    nativeId: endpoint.serial,
    name:
      endpoint.productId === DUALSENSE_EDGE_PRODUCT_ID
        ? "Sony DualSense Edge"
        : "Sony DualSense",
    deviceType: "Controller",
    physicalId: `serial:${endpoint.serial}`,
  };
}

function normalizeSerial(value: string | undefined): string {
  return value?.trim().toUpperCase() ?? "";
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

function closeOnce(handle: HidHandle): () => Promise<void> {
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    await safeClose(handle);
  };
}

async function safeClose(handle: HidHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // A failed close cannot make an already-read battery report less true.
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
