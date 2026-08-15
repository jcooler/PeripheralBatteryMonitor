import { runPowerShell } from "../process/powershell";
import { createLinkedAbortController } from "../process/abort";
import {
  makeDeviceKey,
  type BatteryStatus,
  type DeviceDescriptor,
  type DeviceProvider,
  type DeviceRef,
} from "../devices/types";

export type PowerShellExecutor = (
  script: string,
  options?: { signal?: AbortSignal }
) => Promise<string>;

interface WindowsBluetoothProviderOptions {
  execute?: PowerShellExecutor;
  platform?: NodeJS.Platform;
  now?: () => number;
}

interface WindowsBatteryRecord {
  deviceId: string;
  name: string;
  batteryLevel: number;
  connected: boolean | null;
  containerId?: string;
}

interface WindowsSnapshot extends WindowsBatteryRecord {
  observedAt: number;
}

const BATTERY_PROPERTY = "{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2";
const CONNECTED_PROPERTY = "{83DA6326-97A6-4088-9453-A1923F573B29} 15";
const CONTAINER_PROPERTY = "{8C7ED206-3F8A-4827-B3AB-AE9E1FAEFC6C} 2";

const WINDOWS_BLUETOOTH_DISCOVERY_SCRIPT = String.raw`
$batteryKey = '${BATTERY_PROPERTY}'
$connectedKey = '${CONNECTED_PROPERTY}'
$containerKey = '${CONTAINER_PROPERTY}'
$results = @()

Get-CimInstance -Namespace root\cimv2 -ClassName Win32_PnPEntity -ErrorAction Stop |
  Where-Object { $_.DeviceID -match '^BTH(?:ENUM|LEDEVICE|LE)\\' } |
  ForEach-Object {
    $device = $_
    try {
      $properties = Invoke-CimMethod -InputObject $device -MethodName GetDeviceProperties -Arguments @{
        devicePropertyKeys = @($batteryKey, $connectedKey, $containerKey)
      } -ErrorAction Stop
      $battery = ($properties.DeviceProperties | Where-Object KeyName -eq $batteryKey).Data
      if ($null -ne $battery) {
        $connected = ($properties.DeviceProperties | Where-Object KeyName -eq $connectedKey).Data
        $container = ($properties.DeviceProperties | Where-Object KeyName -eq $containerKey).Data
        $results += [PSCustomObject]@{
          deviceId = $device.DeviceID
          name = $device.Name
          batteryLevel = $battery
          connected = $connected
          containerId = if ($null -eq $container) { $null } else { [string]$container }
        }
      }
    } catch {}
  }

$results | ConvertTo-Json -Compress
`;

export class WindowsBluetoothProvider implements DeviceProvider {
  readonly id = "windows" as const;
  readonly label = "Windows Bluetooth";

  private readonly execute: PowerShellExecutor;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private snapshots = new Map<string, WindowsSnapshot>();
  private discoveryCompleted = false;
  private latestDiscoveryAt = 0;
  private discoveryGeneration = 0;
  private discoveryAbort?: AbortController;

  constructor(options: WindowsBluetoothProviderOptions = {}) {
    this.execute =
      options.execute ??
      ((script, runOptions) =>
        runPowerShell(script, { signal: runOptions?.signal }));
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
  }

  async discover(signal?: AbortSignal): Promise<DeviceDescriptor[]> {
    this.discoveryAbort?.abort(
      new Error("Windows Bluetooth discovery was superseded")
    );
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

      const output = await this.execute(WINDOWS_BLUETOOTH_DISCOVERY_SCRIPT, {
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (generation !== this.discoveryGeneration) {
        throw new Error("Windows Bluetooth discovery was invalidated");
      }

      const observedAt = this.now();
      const records = parseRecords(output);
      const nextSnapshots = new Map<string, WindowsSnapshot>();
      for (const record of records) {
        nextSnapshots.set(record.deviceId, { ...record, observedAt });
      }

      this.snapshots = nextSnapshots;
      this.discoveryCompleted = true;
      this.latestDiscoveryAt = observedAt;
      return [...nextSnapshots.values()]
        .filter((snapshot) => snapshot.connected === true)
        .map(toDescriptor);
    } finally {
      linked.unlink();
      if (this.discoveryAbort === controller) this.discoveryAbort = undefined;
    }
  }

  async readStatus(ref: DeviceRef): Promise<BatteryStatus> {
    if (
      ref.provider !== this.id ||
      ref.key !== makeDeviceKey(this.id, ref.nativeId)
    ) {
      return this.unavailable(
        this.discoveryCompleted ? this.latestDiscoveryAt : this.now(),
        "Invalid Windows Bluetooth device identity"
      );
    }

    if (!this.discoveryCompleted) {
      return this.unavailable(
        this.now(),
        "Windows Bluetooth discovery has not completed"
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
        detail: "Device absent from the latest Windows Bluetooth discovery",
      };
    }

    if (snapshot.connected === null) {
      return this.unavailable(
        snapshot.observedAt,
        "Windows does not report the current connection state"
      );
    }

    if (!snapshot.connected) {
      return {
        state: "disconnected",
        level: { kind: "unavailable" },
        charging: null,
        provider: this.id,
        providerLabel: this.label,
        observedAt: snapshot.observedAt,
        detail: "Windows reports the Bluetooth device as disconnected",
      };
    }

    return {
      state: "connected",
      level: { kind: "percentage", value: snapshot.batteryLevel },
      charging: null,
      provider: this.id,
      providerLabel: this.label,
      observedAt: snapshot.observedAt,
      detail: "Cached Windows PnP battery property",
    };
  }

  invalidateDiscovery(): void {
    this.discoveryGeneration += 1;
    this.discoveryAbort?.abort(
      new Error("Windows Bluetooth discovery was invalidated")
    );
    this.discoveryAbort = undefined;
    this.snapshots.clear();
    this.discoveryCompleted = false;
    this.latestDiscoveryAt = 0;
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

function parseRecords(output: string): WindowsBatteryRecord[] {
  const trimmed = output.trim();
  if (!trimmed) return [];

  const parsed: unknown = JSON.parse(trimmed);
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  const records: WindowsBatteryRecord[] = [];

  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const deviceId = canonicalDeviceId(candidate.deviceId);
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    const batteryLevel = candidate.batteryLevel;
    const connected = candidate.connected;
    if (
      !deviceId ||
      !name ||
      typeof batteryLevel !== "number" ||
      !Number.isInteger(batteryLevel) ||
      batteryLevel < 0 ||
      batteryLevel > 100 ||
      (typeof connected !== "boolean" && connected !== null)
    ) {
      continue;
    }

    records.push({
      deviceId,
      name,
      batteryLevel,
      connected,
      containerId: normalizeContainerId(candidate.containerId),
    });
  }

  return records;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function canonicalDeviceId(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function normalizeContainerId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/^\{?|\}?$/g, "").toLowerCase();
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(normalized)
    ? `container:${normalized}`
    : undefined;
}

function toDescriptor(snapshot: WindowsSnapshot): DeviceDescriptor {
  return {
    key: makeDeviceKey("windows", snapshot.deviceId),
    provider: "windows",
    providerLabel: "Windows Bluetooth",
    nativeId: snapshot.deviceId,
    name: snapshot.name,
    deviceType: detectDeviceType(snapshot.name),
    ...(snapshot.containerId ? { physicalId: snapshot.containerId } : {}),
  };
}

function detectDeviceType(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized.includes("controller") || normalized.includes("gamepad")) {
    return "Controller";
  }
  if (normalized.includes("keyboard") || normalized.includes("keys")) {
    return "Keyboard";
  }
  if (
    normalized.includes("mouse") ||
    normalized.includes("master") ||
    normalized.includes("anywhere")
  ) {
    return "Mouse";
  }
  if (normalized.includes("headset") || normalized.includes("headphone")) {
    return "Headset";
  }
  if (normalized.includes("pen") || normalized.includes("stylus")) return "Pen";
  return "Device";
}
