import { readFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocketModule from "ws";
import type {
  CoreProps,
  DevicesResponse,
  SteelSeriesDevice,
  BatteryInfo,
  HeadsetBatteryStatus,
} from "./types";

const CORE_PROPS_PATHS = [
  join(
    process.env.PROGRAMDATA || "C:\\ProgramData",
    "SteelSeries",
    "SteelSeries Engine 3",
    "coreProps.json"
  ),
  "/Library/Application Support/SteelSeries Engine 3/coreProps.json",
];

export class SteelSeriesClient {
  private baseUrl: string | null = null;
  private encryptedAddress: string | null = null;
  private cachedDevices: SteelSeriesDevice[] = [];

  /** Live battery data from WebSocket, keyed by device id */
  private batteryData = new Map<
    number,
    { level: number; charging: number }
  >();

  /** Live connection status from WebSocket, keyed by device id */
  private connectionData = new Map<
    number,
    { connected: boolean }
  >();

  /** Headset connection status from WebSocket */
  private headsetConnectionData = new Map<
    number,
    { connectionStatus: string }
  >();

  private ws: WebSocketModule | null = null;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;
  private initPromise: Promise<boolean> | null = null;

  async reinitialize(): Promise<boolean> {
    this.initialized = false;
    this.baseUrl = null;
    this.initPromise = null;
    this.triggeredDevices.clear();
    return this.initialize();
  }

  async initialize(): Promise<boolean> {
    if (this.initialized && this.baseUrl) return true;
    // Prevent concurrent initialization races
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._doInitialize();
    return this.initPromise;
  }

  private async _doInitialize(): Promise<boolean> {

    for (const path of CORE_PROPS_PATHS) {
      try {
        const raw = await readFile(path, "utf-8");
        const props: CoreProps = JSON.parse(raw);
        if (props.encryptedAddress) {
          this.encryptedAddress = props.encryptedAddress;
          this.baseUrl = `https://${props.encryptedAddress}`;
          this.initialized = true;
          // Start WebSocket connection for real-time battery data
          this.connectWebSocket();
          return true;
        }
      } catch {
        // Try next path
      }
    }
    return false;
  }

  /** Connect to Engine WebSocket for real-time device events */
  private async connectWebSocket(): Promise<void> {
    if (!this.encryptedAddress) return;

    try {
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }

      const wsUrl = `wss://${this.encryptedAddress}/sock`;
      this.ws = new WebSocketModule(wsUrl, {
        headers: { Origin: "file://" },
        rejectUnauthorized: false,
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.event === "device_event" && msg.data) {
            this.handleDeviceEvent(msg.data);
          }
        } catch {
          // Ignore parse errors
        }
      });

      this.ws.on("close", () => {
        this.ws = null;
        // Reconnect after 5 seconds — re-read coreProps in case port changed (e.g. after sleep)
        if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
        this.wsReconnectTimer = setTimeout(async () => {
          // Reinitialize re-reads coreProps and calls connectWebSocket internally
          await this.reinitialize();
        }, 5000);
      });

      this.ws.on("error", () => {
        // Error will be followed by close event
      });
    } catch {
      // ws module not available, fall back to REST-only
    }
  }

  /** Handle a device_event from the WebSocket */
  private handleDeviceEvent(data: Record<string, unknown>): void {
    const id = data.id as number;
    if (!id) return;

    // Battery status: { charging: 0|1|2, level: 0-100 }
    if (data.battery_status) {
      const bs = data.battery_status as { charging: number; level: number };
      this.batteryData.set(id, bs);
    }

    // batteryEvent (newer format): { batteryPercent: 0-100 }
    if (data.batteryEvent) {
      const be = data.batteryEvent as { batteryPercent?: number };
      if (be.batteryPercent !== undefined) {
        const existing = this.batteryData.get(id) || { level: 0, charging: 0 };
        this.batteryData.set(id, { ...existing, level: be.batteryPercent });
      }
    }

    // Connection status for mice/keyboards: { status: 0|1, type: number }
    if (data.connection_status) {
      const cs = data.connection_status as { status: number };
      this.connectionData.set(id, { connected: cs.status === 1 });
    }

    // Connection event for headsets: { connectionStatus: string }
    if (data.connectionEvent) {
      const ce = data.connectionEvent as { connectionStatus: string };
      this.headsetConnectionData.set(id, ce);
    }

    // Charging event
    if (data.chargingEvent) {
      const ch = data.chargingEvent as { chargingStatus: string };
      const existing = this.batteryData.get(id);
      if (existing) {
        existing.charging =
          ch.chargingStatus === "PLUGGED_IN_CHARGING" ? 1 : 0;
      }
    }
  }

  /** Trigger device to report its status via WebSocket events (once per device) */
  private triggeredDevices = new Set<number>();

  async triggerStatusUpdate(deviceId: number): Promise<void> {
    if (this.triggeredDevices.has(deviceId)) return;
    this.triggeredDevices.add(deviceId);
    await this.request(`/device/${deviceId}/updateCachedProperties`, "POST", {});
  }

  private async request<T>(
    path: string,
    method: "GET" | "POST" = "GET",
    body?: unknown
  ): Promise<T | null> {
    if (!this.baseUrl) {
      const ok = await this.initialize();
      if (!ok) return null;
    }

    try {
      const url = `${this.baseUrl}${path}`;
      const options: RequestInit = {
        method,
        headers: { "Content-Type": "application/json" },
      };
      if (body !== undefined) {
        options.body = JSON.stringify(body);
      }

      // Scoped TLS bypass for SteelSeries Engine's self-signed localhost cert
      const prevTLS = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      let response: Response;
      try {
        response = await fetch(url, options);
      } finally {
        if (prevTLS === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTLS;
      }
      if (!response.ok) {
        // Server responded but with an error — might be stale port
        this.baseUrl = null;
        this.initialized = false;
        return null;
      }
      return (await response.json()) as T;
    } catch {
      this.baseUrl = null;
      return null;
    }
  }

  async getDevices(): Promise<SteelSeriesDevice[]> {
    const data = await this.request<DevicesResponse>("/devices");
    if (data?.devices && Array.isArray(data.devices)) {
      this.cachedDevices = data.devices;
    }
    return this.cachedDevices;
  }

  async getBatteryInfo(device: SteelSeriesDevice): Promise<BatteryInfo> {
    const base: BatteryInfo = {
      deviceId: device.id,
      deviceName: device.display_name || device.name,
      deviceType: device.deviceTypeName || String(device.type),
      batteryLevel: -1,
      isCharging: false,
      isConnected: false,
    };

    // Trigger initial status update (only once per device to seed WebSocket data)
    await this.triggerStatusUpdate(device.id);

    // Check headset connection status
    if (isHeadsetType(device)) {
      const hcs = this.headsetConnectionData.get(device.id);
      if (hcs) {
        base.isConnected =
          hcs.connectionStatus !== "PAIRED_NOT_CONNECTED" &&
          hcs.connectionStatus !== "UNKNOWN_OR_HEADSET_NOT_CONNECTED";
      }

      // Also try REST endpoint for headset battery
      if (base.isConnected || !hcs) {
        const result = await this.request<{ function_data: string }>(
          `/device/${device.id}/function/read_battery_status`,
          "POST",
          {}
        );
        if (result?.function_data) {
          try {
            const status: HeadsetBatteryStatus = JSON.parse(result.function_data);
            const chargingStatus = status.charging_status?.chargingStatus;
            base.batteryLevel = status.headset_battery_level?.level ?? -1;
            base.chargerLevel = status.charger_battery_level?.level;
            base.isCharging = chargingStatus === "PLUGGED_IN_CHARGING";
            base.isConnected =
              chargingStatus !== "UNKNOWN_OR_HEADSET_NOT_CONNECTED" &&
              chargingStatus !== "PAIRED_NOT_CONNECTED";
            return base;
          } catch {
            // Fall through
          }
        }
      }

      if (!base.isConnected) {
        base.batteryLevel = -1;
        return base;
      }
    }

    // Check WebSocket connection data for mice/keyboards
    const connData = this.connectionData.get(device.id);
    if (connData) {
      base.isConnected = connData.connected;
    } else {
      // Fallback: trust the device's connected field from REST
      base.isConnected = device.connected === 1;
    }

    if (!base.isConnected) {
      base.batteryLevel = -1;
      return base;
    }

    // Get battery from WebSocket data (most accurate)
    const wsBattery = this.batteryData.get(device.id);
    if (wsBattery) {
      base.batteryLevel = wsBattery.level;
      base.isCharging = wsBattery.charging === 1;
      return base;
    }

    // No WebSocket data available yet
    return base;
  }

  /** Clean up WebSocket connection */
  destroy(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
    }
  }
}

function isHeadsetType(device: SteelSeriesDevice): boolean {
  if (device.deviceTypeName?.toLowerCase() === "headset") return true;
  if (device.type === 3) return true;
  const name = device.name.toLowerCase();
  return name.includes("arctis") || name.includes("headset");
}
