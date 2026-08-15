import { runPowerShell } from "../process/powershell";
import { createLinkedAbortController } from "../process/abort";
import {
  makeDeviceKey,
  type BatteryStatus,
  type DeviceDescriptor,
  type DeviceProvider,
  type DeviceRef,
} from "../devices/types";

export type WindowsGamepadExecutor = (
  script: string,
  options?: { signal?: AbortSignal }
) => Promise<string>;

interface WindowsGamepadProviderOptions {
  execute?: WindowsGamepadExecutor;
  platform?: NodeJS.Platform;
  now?: () => number;
}

interface WindowsGamepadRecord {
  nativeId: string;
  name: string;
  batteryStatus: string | null;
  remainingMWh: number | null;
  fullMWh: number | null;
}

interface WindowsGamepadSnapshot extends WindowsGamepadRecord {
  observedAt: number;
}

const MICROSOFT_VENDOR_ID = 0x045e;
const XBOX_WIRELESS_ADAPTER_GAMEPAD_PRODUCT_ID = 0x0b00;

const WINDOWS_GAMEPAD_DISCOVERY_SCRIPT = String.raw`
Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
$rawType = [Windows.Gaming.Input.RawGameController, Windows.Gaming.Input, ContentType=WindowsRuntime]

# Windows populates the WinRT controller list asynchronously on first access.
$controllerSnapshot = @()
$supportedControllerSnapshot = @()
for ($attempt = 0; $attempt -le 5; $attempt++) {
  $controllerSnapshot = @($rawType::RawGameControllers | ForEach-Object { $_ })
  $supportedControllerSnapshot = @(
    $controllerSnapshot | Where-Object {
      [bool]$_.IsWireless -and
      [int]$_.HardwareVendorId -eq 1118 -and
      [int]$_.HardwareProductId -eq 2816
    }
  )
  if ($supportedControllerSnapshot.Count -gt 0 -or $attempt -eq 5) { break }
  Start-Sleep -Milliseconds 400
}

$controllers = @(
  $supportedControllerSnapshot | ForEach-Object {
    $controller = $_
    try {
      $isSupportedAdapterController = (
        [bool]$controller.IsWireless -and
        [int]$controller.HardwareVendorId -eq 1118 -and
        [int]$controller.HardwareProductId -eq 2816
      )
      if ($isSupportedAdapterController) {
        $status = $null
        $remaining = $null
        $full = $null
        try {
          $report = $controller.TryGetBatteryReport()
          if ($null -ne $report) {
            $status = [string]$report.Status
            $remaining = $report.RemainingCapacityInMilliwattHours
            $full = $report.FullChargeCapacityInMilliwattHours
          }
        } catch {}
        [PSCustomObject]@{
          id = ([string]$controller.NonRoamableId).TrimEnd([char]0)
          name = [string]$controller.DisplayName
          wireless = [bool]$controller.IsWireless
          vendorId = [int]$controller.HardwareVendorId
          productId = [int]$controller.HardwareProductId
          status = $status
          remainingMWh = $remaining
          fullMWh = $full
        }
      }
    } catch {}
  }
)

[PSCustomObject]@{ controllers = $controllers } |
  ConvertTo-Json -Compress -Depth 4
`;

export class WindowsGamepadProvider implements DeviceProvider {
  readonly id = "windows-gamepad" as const;
  readonly label = "Windows Gamepad";

  private readonly execute: WindowsGamepadExecutor;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private snapshots = new Map<string, WindowsGamepadSnapshot>();
  private ambiguousIds = new Set<string>();
  private discoveryCompleted = false;
  private latestDiscoveryAt = 0;
  private discoveryGeneration = 0;
  private discoveryAbort?: AbortController;

  constructor(options: WindowsGamepadProviderOptions = {}) {
    this.execute =
      options.execute ??
      ((script, runOptions) =>
        runPowerShell(script, {
          signal: runOptions?.signal,
          timeoutMs: 5_000,
          maxOutputBytes: 128 * 1024,
        }));
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
  }

  async discover(signal?: AbortSignal): Promise<DeviceDescriptor[]> {
    this.discoveryAbort?.abort(
      new Error("Windows Gaming Input discovery was superseded")
    );
    const linked = createLinkedAbortController(signal);
    const controller = linked.controller;
    this.discoveryAbort = controller;
    const generation = ++this.discoveryGeneration;

    try {
      controller.signal.throwIfAborted();
      if (this.platform !== "win32") {
        this.replaceSnapshot([], this.now());
        return [];
      }

      const output = await this.execute(WINDOWS_GAMEPAD_DISCOVERY_SCRIPT, {
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (generation !== this.discoveryGeneration) {
        throw new Error("Windows Gaming Input discovery was invalidated");
      }

      const observedAt = this.now();
      this.replaceSnapshot(parseRecords(output), observedAt);
      return [...this.snapshots.values()]
        .filter((snapshot) => batteryResult(snapshot).level.kind === "percentage")
        .map(toDescriptor);
    } finally {
      linked.unlink();
      if (this.discoveryAbort === controller) this.discoveryAbort = undefined;
    }
  }

  async readStatus(
    ref: DeviceRef,
    signal?: AbortSignal
  ): Promise<BatteryStatus> {
    signal?.throwIfAborted();
    if (
      ref.provider !== this.id ||
      ref.key !== makeDeviceKey(this.id, ref.nativeId)
    ) {
      return this.unavailable(
        this.discoveryCompleted ? this.latestDiscoveryAt : this.now(),
        "Invalid Windows Gaming Input device identity"
      );
    }

    if (!this.discoveryCompleted) {
      return this.unavailable(
        this.now(),
        "Windows Gaming Input discovery has not completed"
      );
    }

    if (this.ambiguousIds.has(ref.nativeId)) {
      return this.unavailable(
        this.latestDiscoveryAt,
        "Duplicate Windows Gaming Input identity"
      );
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
        detail: "Controller absent from the latest Windows Gaming Input snapshot",
      };
    }

    return batteryResult(snapshot);
  }

  invalidateDiscovery(): void {
    this.discoveryGeneration += 1;
    this.discoveryAbort?.abort(
      new Error("Windows Gaming Input discovery was invalidated")
    );
    this.discoveryAbort = undefined;
    this.snapshots.clear();
    this.ambiguousIds.clear();
    this.discoveryCompleted = false;
    this.latestDiscoveryAt = 0;
  }

  private replaceSnapshot(
    records: WindowsGamepadRecord[],
    observedAt: number
  ): void {
    const snapshots = new Map<string, WindowsGamepadSnapshot>();
    const ambiguousIds = new Set<string>();
    for (const record of records) {
      if (ambiguousIds.has(record.nativeId)) continue;
      if (snapshots.has(record.nativeId)) {
        snapshots.delete(record.nativeId);
        ambiguousIds.add(record.nativeId);
        continue;
      }
      snapshots.set(record.nativeId, { ...record, observedAt });
    }
    this.snapshots = snapshots;
    this.ambiguousIds = ambiguousIds;
    this.discoveryCompleted = true;
    this.latestDiscoveryAt = observedAt;
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

function parseRecords(output: string): WindowsGamepadRecord[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  if (!isRecord(parsed)) return [];
  const rawControllers = parsed.controllers;
  const candidates = Array.isArray(rawControllers)
    ? rawControllers
    : isRecord(rawControllers)
      ? [rawControllers]
      : [];
  const records: WindowsGamepadRecord[] = [];

  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const nativeId = normalizeNativeId(candidate.id);
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    if (
      !nativeId ||
      !name ||
      candidate.wireless !== true ||
      candidate.vendorId !== MICROSOFT_VENDOR_ID ||
      candidate.productId !== XBOX_WIRELESS_ADAPTER_GAMEPAD_PRODUCT_ID
    ) {
      continue;
    }

    records.push({
      nativeId,
      name,
      batteryStatus:
        typeof candidate.status === "string" ? candidate.status : null,
      remainingMWh: finiteNumberOrNull(candidate.remainingMWh),
      fullMWh: finiteNumberOrNull(candidate.fullMWh),
    });
  }

  return records;
}

function batteryResult(snapshot: WindowsGamepadSnapshot): BatteryStatus {
  const base = {
    charging: null,
    provider: "windows-gamepad" as const,
    providerLabel: "Windows Gamepad",
    observedAt: snapshot.observedAt,
  };

  if (snapshot.batteryStatus === null) {
    return {
      ...base,
      state: "unavailable",
      level: { kind: "unavailable" },
      detail: "Windows Gaming Input battery report unavailable",
    };
  }

  if (snapshot.batteryStatus === "NotPresent") {
    return {
      ...base,
      state: "unavailable",
      level: { kind: "unavailable" },
      detail: "Windows reports no battery",
    };
  }

  if (
    snapshot.batteryStatus !== "Charging" &&
    snapshot.batteryStatus !== "Discharging" &&
    snapshot.batteryStatus !== "Idle"
  ) {
    return {
      ...base,
      state: "unavailable",
      level: { kind: "unavailable" },
      detail: "Unsupported Windows battery status",
    };
  }

  if (snapshot.remainingMWh === null || snapshot.fullMWh === null) {
    return {
      ...base,
      state: "unavailable",
      level: { kind: "unavailable" },
      detail: "Windows did not report battery capacity",
    };
  }

  if (
    snapshot.fullMWh <= 0 ||
    snapshot.remainingMWh < 0 ||
    snapshot.remainingMWh > snapshot.fullMWh
  ) {
    return {
      ...base,
      state: "unavailable",
      level: { kind: "unavailable" },
      detail: "Windows reported invalid battery capacity",
    };
  }

  return {
    ...base,
    state: "connected",
    level: {
      kind: "percentage",
      value: Math.round((snapshot.remainingMWh / snapshot.fullMWh) * 100),
    },
    charging: snapshot.batteryStatus === "Charging",
    detail: "Windows Gaming Input capacity report",
  };
}

function toDescriptor(snapshot: WindowsGamepadSnapshot): DeviceDescriptor {
  return {
    key: makeDeviceKey("windows-gamepad", snapshot.nativeId),
    provider: "windows-gamepad",
    providerLabel: "Windows Gamepad",
    nativeId: snapshot.nativeId,
    name: snapshot.name,
    deviceType: "Controller",
  };
}

function normalizeNativeId(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\0+$/g, "");
  if (
    !normalized ||
    normalized !== normalized.trim() ||
    normalized.includes("\0") ||
    normalized.length > 512
  ) {
    return "";
  }
  return normalized;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
