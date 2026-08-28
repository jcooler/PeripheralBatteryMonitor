const LONG_REPORT_ID = 0x11;
const LONG_REPORT_LENGTH = 20;
const ROOT_FEATURE_INDEX = 0x00;
const ROOT_GET_FEATURE_FUNCTION = 0x00;
const ROOT_GET_PROTOCOL_VERSION_FUNCTION = 0x01;
const BATTERY_STATUS_FUNCTION = 0x00;
const BATTERY_UNIFIED_LEVEL_STATUS_FEATURE = 0x1000;
const HIDPP20_ERROR_FEATURE_INDEX = 0xff;
const DEFAULT_SOFTWARE_ID = 0x08;
const DEFAULT_REQUEST_TIMEOUT_MS = 1_000;
const PROTOCOL_PING_DATA = 0x5a;

export interface HidppHandle {
  write(data: Buffer): Promise<number>;
  read(timeoutMs?: number): Promise<Buffer | undefined>;
  close(): Promise<void>;
}

export interface HidppRequest {
  readonly deviceIndex: number;
  readonly featureIndex: number;
  readonly functionId: number;
  readonly packet: Buffer;
}

export interface HidppBatteryReading {
  readonly percentage: number;
  readonly nextLevel: number;
  readonly charging: boolean;
  readonly status: number;
}

export interface HidppProtocolOptions {
  softwareId?: number;
  requestTimeoutMs?: number;
  now?: () => number;
}

export function buildRootProtocolVersionRequest(
  deviceIndex: number,
  softwareId = DEFAULT_SOFTWARE_ID
): Buffer {
  return buildLongRequest(
    deviceIndex,
    ROOT_FEATURE_INDEX,
    ROOT_GET_PROTOCOL_VERSION_FUNCTION,
    softwareId,
    [0x00, 0x00, PROTOCOL_PING_DATA]
  );
}

export function buildRootFeatureRequest(
  deviceIndex: number,
  softwareId: number,
  featureId: number
): Buffer {
  if (featureId !== BATTERY_UNIFIED_LEVEL_STATUS_FEATURE) {
    throw new Error("HID++ feature is not allowlisted");
  }
  return buildLongRequest(
    deviceIndex,
    ROOT_FEATURE_INDEX,
    ROOT_GET_FEATURE_FUNCTION,
    softwareId,
    [(featureId >> 8) & 0xff, featureId & 0xff]
  );
}

export function buildBatteryStatusRequest(
  deviceIndex: number,
  softwareId: number,
  featureIndex: number
): Buffer {
  if (!isByte(featureIndex) || featureIndex === ROOT_FEATURE_INDEX) {
    throw new Error("HID++ battery feature index is invalid");
  }
  return buildLongRequest(
    deviceIndex,
    featureIndex,
    BATTERY_STATUS_FUNCTION,
    softwareId,
    []
  );
}

export class HidppProtocolClient {
  private readonly softwareId: number;
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;
  private requestTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly handle: HidppHandle,
    options: HidppProtocolOptions = {}
  ) {
    this.softwareId = options.softwareId ?? DEFAULT_SOFTWARE_ID;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    requireNibble(this.softwareId, "software ID");
    if (this.softwareId === 0) {
      throw new Error("HID++ software ID must be nonzero");
    }
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new Error("HID++ request timeout must be positive");
    }
  }

  async getProtocolVersion(
    deviceIndex: number,
    signal?: AbortSignal
  ): Promise<{ major: number; minor: number }> {
    const response = await this.sendCorrelated(
      request(
        deviceIndex,
        ROOT_FEATURE_INDEX,
        ROOT_GET_PROTOCOL_VERSION_FUNCTION,
        buildRootProtocolVersionRequest(deviceIndex, this.softwareId)
      ),
      signal
    );
    if (response[6] !== PROTOCOL_PING_DATA) {
      throw new Error("HID++ protocol reply ping data is invalid");
    }
    return { major: response[4], minor: response[5] };
  }

  async getFeature(
    deviceIndex: number,
    featureId: number,
    signal?: AbortSignal
  ): Promise<{ index: number; type: number; version: number }> {
    const response = await this.sendCorrelated(
      request(
        deviceIndex,
        ROOT_FEATURE_INDEX,
        ROOT_GET_FEATURE_FUNCTION,
        buildRootFeatureRequest(deviceIndex, this.softwareId, featureId)
      ),
      signal
    );
    const index = response[4];
    if (index === ROOT_FEATURE_INDEX) {
      throw new Error("HID++ battery feature is unsupported");
    }
    return { index, type: response[5], version: response[6] };
  }

  async getBatteryStatus(
    deviceIndex: number,
    featureIndex: number,
    signal?: AbortSignal
  ): Promise<HidppBatteryReading> {
    const response = await this.sendCorrelated(
      request(
        deviceIndex,
        featureIndex,
        BATTERY_STATUS_FUNCTION,
        buildBatteryStatusRequest(deviceIndex, this.softwareId, featureIndex)
      ),
      signal
    );
    const percentage = response[4];
    const nextLevel = response[5];
    const status = response[6];
    if (percentage > 100 || nextLevel > 100) {
      throw new Error("HID++ battery percentage is invalid");
    }
    if (status > 4) {
      throw new Error("HID++ battery status is unavailable");
    }
    return {
      percentage,
      nextLevel,
      charging: status === 1 || status === 2 || status === 4,
      status,
    };
  }

  private sendCorrelated(
    hidppRequest: HidppRequest,
    signal?: AbortSignal
  ): Promise<Buffer> {
    const operation = this.requestTail.then(() =>
      this.executeRequest(hidppRequest, signal)
    );
    this.requestTail = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private async executeRequest(
    hidppRequest: HidppRequest,
    signal?: AbortSignal
  ): Promise<Buffer> {
    throwIfAborted(signal);
    await raceWithAbortAndTimeout(
      this.handle.write(hidppRequest.packet),
      signal,
      this.requestTimeoutMs
    );
    const deadline = this.now() + this.requestTimeoutMs;
    while (true) {
      throwIfAborted(signal);
      const remaining = deadline - this.now();
      if (remaining <= 0) throw timeoutError();
      const report = await raceWithAbortAndTimeout(
        this.handle.read(remaining),
        signal,
        remaining
      );
      if (report === undefined) throw timeoutError();
      if (isCorrelatedError(report, hidppRequest, this.softwareId)) {
        throw new Error(`HID++ request failed with error ${report[5]}`);
      }
      if (isCorrelatedReply(report, hidppRequest, this.softwareId)) {
        return report;
      }
    }
  }
}

function request(
  deviceIndex: number,
  featureIndex: number,
  functionId: number,
  packet: Buffer
): HidppRequest {
  return { deviceIndex, featureIndex, functionId, packet };
}

function buildLongRequest(
  deviceIndex: number,
  featureIndex: number,
  functionId: number,
  softwareId: number,
  parameters: readonly number[]
): Buffer {
  requireByte(deviceIndex, "device index");
  requireByte(featureIndex, "feature index");
  requireNibble(functionId, "function ID");
  requireNibble(softwareId, "software ID");
  if (softwareId === 0) throw new Error("HID++ software ID must be nonzero");
  if (parameters.length > LONG_REPORT_LENGTH - 4) {
    throw new Error("HID++ request parameters are too long");
  }
  for (const parameter of parameters) requireByte(parameter, "parameter");

  const packet = Buffer.alloc(LONG_REPORT_LENGTH);
  packet[0] = LONG_REPORT_ID;
  packet[1] = deviceIndex;
  packet[2] = featureIndex;
  packet[3] = (functionId << 4) | softwareId;
  parameters.forEach((value, index) => {
    packet[index + 4] = value;
  });
  return packet;
}

function isCorrelatedReply(
  report: Buffer,
  hidppRequest: HidppRequest,
  softwareId: number
): boolean {
  return (
    isLongReport(report) &&
    report[1] === hidppRequest.deviceIndex &&
    report[2] === hidppRequest.featureIndex &&
    report[3] === ((hidppRequest.functionId << 4) | softwareId)
  );
}

function isCorrelatedError(
  report: Buffer,
  hidppRequest: HidppRequest,
  softwareId: number
): boolean {
  return (
    isLongReport(report) &&
    report[1] === hidppRequest.deviceIndex &&
    report[2] === HIDPP20_ERROR_FEATURE_INDEX &&
    report[3] === hidppRequest.featureIndex &&
    report[4] === ((hidppRequest.functionId << 4) | softwareId)
  );
}

function isLongReport(report: Buffer): boolean {
  return report.length === LONG_REPORT_LENGTH && report[0] === LONG_REPORT_ID;
}

function isByte(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xff;
}

function requireByte(value: number, label: string): void {
  if (!isByte(value)) throw new Error(`HID++ ${label} must be one byte`);
}

function requireNibble(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0x0f) {
    throw new Error(`HID++ ${label} must be one nibble`);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw abortError();
}

function abortError(): Error {
  const error = new Error("HID++ request aborted");
  error.name = "AbortError";
  return error;
}

function timeoutError(): Error {
  return new Error("HID++ request timed out");
}

function raceWithAbortAndTimeout<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value as T);
    };
    const onAbort = (): void => finish(abortError());
    const timer = setTimeout(() => finish(timeoutError()), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(undefined, value),
      (error) =>
        finish(error instanceof Error ? error : new Error(String(error)))
    );
  });
}
