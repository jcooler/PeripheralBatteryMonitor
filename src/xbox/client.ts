import { runPowerShell } from "../process/powershell";
import { createLinkedAbortController } from "../process/abort";
import {
  makeDeviceKey,
  type BatteryStatus,
  type DeviceDescriptor,
  type DeviceProvider,
  type DeviceRef,
} from "../devices/types";
import type { BatteryInfo } from "../types";

export type XInputPowerShellExecutor = (
  script: string,
  options?: { signal?: AbortSignal }
) => Promise<string>;

interface XInputProviderOptions {
  execute?: XInputPowerShellExecutor;
  platform?: NodeJS.Platform;
  now?: () => number;
}

export interface XboxControllerStatus {
  index: number;
  connected: boolean;
  resultCode: number;
  batteryType: number;
  batteryLevel: number;
}

interface XInputSnapshot extends XboxControllerStatus {
  observedAt: number;
}

const XINPUT_DISCOVERY_SCRIPT = String.raw`
Add-Type @'
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct XInputBatteryInformation {
    public byte BatteryType;
    public byte BatteryLevel;
}

public static class PassiveXInputBattery {
    [DllImport("XInput1_4.dll")]
    public static extern uint XInputGetBatteryInformation(
        uint userIndex,
        byte deviceType,
        out XInputBatteryInformation batteryInformation
    );
}
'@ -ErrorAction Stop

$results = @()
for ($index = 0; $index -lt 4; $index++) {
  $batteryInformation = New-Object XInputBatteryInformation
  $result = [PassiveXInputBattery]::XInputGetBatteryInformation(
    $index,
    0,
    [ref]$batteryInformation
  )
  $results += [PSCustomObject]@{
    index = $index
    connected = ($result -eq 0)
    resultCode = [long]$result
    batteryType = [int]$batteryInformation.BatteryType
    batteryLevel = [int]$batteryInformation.BatteryLevel
  }
}

$results | ConvertTo-Json -Compress
`;

const LEVELS = ["empty", "low", "medium", "full"] as const;

/**
 * Passive XInput battery provider.
 *
 * XInput identifies controllers only by one of four session-local slots. The
 * exact slot is persisted; the provider never substitutes a different slot,
 * though Windows may assign a controller a different slot after reconnect.
 */
export class XInputProvider implements DeviceProvider {
  readonly id = "xinput" as const;
  readonly label = "XInput";

  private readonly execute: XInputPowerShellExecutor;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private snapshots = new Map<string, XInputSnapshot>();
  private discoveryCompleted = false;
  private latestDiscoveryAt = 0;
  private discoveryGeneration = 0;
  private discoveryAbort?: AbortController;

  constructor(options: XInputProviderOptions = {}) {
    this.execute =
      options.execute ??
      ((script, runOptions) =>
        runPowerShell(script, {
          signal: runOptions?.signal,
          timeoutMs: 5_000,
          maxOutputBytes: 64 * 1024,
        }));
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
  }

  async discover(signal?: AbortSignal): Promise<DeviceDescriptor[]> {
    this.discoveryAbort?.abort(new Error("XInput discovery was superseded"));
    const linked = createLinkedAbortController(signal);
    const controller = linked.controller;
    this.discoveryAbort = controller;
    const generation = ++this.discoveryGeneration;

    try {
      controller.signal.throwIfAborted();
      if (this.platform !== "win32") {
        this.snapshots.clear();
        this.discoveryCompleted = true;
        this.latestDiscoveryAt = this.now();
        return [];
      }

      const output = await this.execute(XINPUT_DISCOVERY_SCRIPT, {
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (generation !== this.discoveryGeneration) {
        throw new Error("XInput discovery was invalidated");
      }

      const observedAt = this.now();
      const nextSnapshots = new Map<string, XInputSnapshot>();
      for (const status of parseStatuses(output)) {
        nextSnapshots.set(nativeIdForSlot(status.index), {
          ...status,
          observedAt,
        });
      }

      this.snapshots = nextSnapshots;
      this.discoveryCompleted = true;
      this.latestDiscoveryAt = observedAt;
      return [...nextSnapshots.entries()]
        .filter(([, snapshot]) => snapshot.connected && isWireless(snapshot))
        .map(([nativeId, snapshot]) => toDescriptor(nativeId, snapshot));
    } finally {
      linked.unlink();
      if (this.discoveryAbort === controller) this.discoveryAbort = undefined;
    }
  }

  async readStatus(ref: DeviceRef): Promise<BatteryStatus> {
    if (
      ref.provider !== this.id ||
      ref.key !== makeDeviceKey(this.id, ref.nativeId) ||
      !/^slot:[0-3]$/.test(ref.nativeId)
    ) {
      return this.unavailable(
        this.discoveryCompleted ? this.latestDiscoveryAt : this.now(),
        "Invalid XInput device identity"
      );
    }

    if (!this.discoveryCompleted) {
      return this.unavailable(this.now(), "XInput discovery has not completed");
    }

    const snapshot = this.snapshots.get(ref.nativeId);
    if (!snapshot) {
      return {
        state: "disconnected",
        level: { kind: "unavailable" },
        charging: null,
        provider: this.id,
        providerLabel: this.label,
        observedAt: this.latestDiscoveryAt,
        detail: "XInput slot absent from the latest discovery",
      };
    }

    if (snapshot.resultCode !== 0 && snapshot.resultCode !== 1_167) {
      return this.unavailable(
        snapshot.observedAt,
        `XInput battery query failed with error ${snapshot.resultCode}`
      );
    }

    if (snapshot.resultCode === 1_167 || !snapshot.connected) {
      return {
        state: "disconnected",
        level: { kind: "unavailable" },
        charging: null,
        provider: this.id,
        providerLabel: this.label,
        observedAt: snapshot.observedAt,
        detail: "XInput reports this exact slot as disconnected",
      };
    }

    if (snapshot.batteryType === 1) {
      return this.unavailable(
        snapshot.observedAt,
        "XInput wired controller; no battery status is available"
      );
    }
    if (snapshot.batteryType === 0) {
      return this.unavailable(
        snapshot.observedAt,
        "XInput did not report a battery type"
      );
    }
    if (snapshot.batteryType === 255) {
      return this.unavailable(
        snapshot.observedAt,
        "XInput reported an unknown battery type"
      );
    }
    if (!isWireless(snapshot)) {
      return this.unavailable(
        snapshot.observedAt,
        `XInput returned unsupported battery type ${snapshot.batteryType}`
      );
    }

    const level = LEVELS[snapshot.batteryLevel];
    if (level === undefined) {
      return this.unavailable(
        snapshot.observedAt,
        "XInput returned an invalid battery level"
      );
    }

    return {
      state: "connected",
      level: { kind: "qualitative", value: level },
      charging: null,
      provider: this.id,
      providerLabel: this.label,
      observedAt: snapshot.observedAt,
      detail: `XInput reports ${capitalize(level)}; slot assignment can change after reconnect`,
    };
  }

  invalidateDiscovery(): void {
    this.discoveryGeneration += 1;
    this.discoveryAbort?.abort(new Error("XInput discovery was invalidated"));
    this.discoveryAbort = undefined;
    this.snapshots.clear();
    this.discoveryCompleted = false;
    this.latestDiscoveryAt = 0;
  }

  /** Transitional compatibility for the pre-provider action implementation. */
  async initialize(): Promise<boolean> {
    return (await this.discover()).length > 0;
  }

  /** Returns the current cached wireless choices without rescanning after init. */
  async getDevices(): Promise<XboxControllerStatus[]> {
    if (!this.discoveryCompleted) await this.discover();
    return [...this.snapshots.values()]
      .filter((snapshot) => snapshot.connected && isWireless(snapshot))
      .map(({ index, connected, resultCode, batteryType, batteryLevel }) => ({
        index,
        connected,
        resultCode,
        batteryType,
        batteryLevel,
      }));
  }

  /**
   * The legacy percentage-only model cannot represent XInput buckets, so it
   * deliberately returns unavailable rather than fabricating a percentage.
   */
  async getBatteryInfo(controller: XboxControllerStatus): Promise<BatteryInfo> {
    return {
      deviceId: 90_000 + controller.index,
      deviceName: `Xbox Controller (XInput slot ${controller.index + 1})`,
      deviceType: "Controller",
      batteryLevel: -1,
      isCharging: false,
      isConnected: controller.connected,
    };
  }

  private unavailable(observedAt: number, detail: string): BatteryStatus {
    return {
      state: "unavailable",
      level: { kind: "unavailable" },
      charging: null,
      provider: this.id,
      providerLabel: this.label,
      observedAt,
      detail,
    };
  }
}

/** Backward-compatible name while the action is migrated to DeviceProvider. */
export { XInputProvider as XboxClient };

function parseStatuses(output: string): XboxControllerStatus[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  const statuses: XboxControllerStatus[] = [];

  for (const candidate of candidates) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const value = candidate as Record<string, unknown>;
    if (
      typeof value.index !== "number" ||
      !Number.isInteger(value.index) ||
      value.index < 0 ||
      value.index > 3 ||
      typeof value.connected !== "boolean" ||
      typeof value.resultCode !== "number" ||
      !Number.isInteger(value.resultCode) ||
      typeof value.batteryType !== "number" ||
      !Number.isInteger(value.batteryType) ||
      typeof value.batteryLevel !== "number" ||
      !Number.isInteger(value.batteryLevel)
    ) {
      continue;
    }
    statuses.push({
      index: value.index,
      connected: value.resultCode === 0,
      resultCode: value.resultCode,
      batteryType: value.batteryType,
      batteryLevel: value.batteryLevel,
    });
  }

  return statuses;
}

function nativeIdForSlot(index: number): string {
  return `slot:${index}`;
}

function isWireless(status: XboxControllerStatus): boolean {
  return status.batteryType === 2 || status.batteryType === 3;
}

function toDescriptor(
  nativeId: string,
  snapshot: XInputSnapshot
): DeviceDescriptor {
  return {
    key: makeDeviceKey("xinput", nativeId),
    provider: "xinput",
    providerLabel: "XInput",
    nativeId,
    name: `Xbox Controller (XInput slot ${snapshot.index + 1})`,
    deviceType: "Controller",
  };
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
