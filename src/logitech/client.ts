import WebSocketModule from "ws";
import type { BatteryInfo } from "../types";

const GHUB_WS_URL = "ws://localhost:9010";

interface GHubDevice {
  id: string;
  extendedDisplayName: string;
  deviceType: string;
  capabilities?: {
    hasBatteryStatus?: boolean;
  };
}

interface GHubBatteryState {
  percentage: number;
  charging: boolean;
  mileage?: number;
}

export class LogitechClient {
  private ws: WebSocketModule | null = null;
  private connected = false;
  private cachedDevices: GHubDevice[] = [];
  private batteryCache = new Map<string, GHubBatteryState>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageTime = 0;
  private msgId = 0;
  private pendingRequests = new Map<string, { resolve: (data: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  private connectPromise: Promise<boolean> | null = null;

  async initialize(): Promise<boolean> {
    if (this.connected) return true;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connect();
    const result = await this.connectPromise;
    this.connectPromise = null;
    return result;
  }

  private connect(): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        this.ws = new WebSocketModule(GHUB_WS_URL, ["json"], {
          headers: {
            Origin: "file://",
            Pragma: "no-cache",
            "Cache-Control": "no-cache",
          },
        });

        const timeout = setTimeout(() => {
          if (!this.connected) {
            this.ws?.close();
            resolve(false);
          }
        }, 3000);

        this.ws.on("open", () => {
          clearTimeout(timeout);
          this.connected = true;
          this.lastMessageTime = Date.now();
          this.startHealthCheck();
          resolve(true);
        });

        this.ws.on("message", (data: Buffer) => {
          this.lastMessageTime = Date.now();
          try {
            const msg = JSON.parse(data.toString());
            const id = msg.msgId;
            if (id && this.pendingRequests.has(id)) {
              const entry = this.pendingRequests.get(id)!;
              clearTimeout(entry.timer);
              this.pendingRequests.delete(id);
              entry.resolve(msg);
            }
          } catch {
            // ignore parse errors
          }
        });

        this.ws.on("close", () => {
          this.connected = false;
          this.ws = null;
          this.stopHealthCheck();
          // Clear all pending request timers to prevent leaks
          for (const entry of this.pendingRequests.values()) clearTimeout(entry.timer);
          this.pendingRequests.clear();
          // Reconnect after 5 seconds (handles sleep/wake, G Hub restart)
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => { this.connectPromise = null; this.connect(); }, 5000);
        });

        this.ws.on("error", () => {
          // close event will follow
        });
      } catch {
        resolve(false);
      }
    });
  }

  /** Periodically ping G Hub to detect stale connections */
  private startHealthCheck(): void {
    this.stopHealthCheck();
    this.healthCheckTimer = setInterval(() => {
      // If no message received in 60 seconds, the connection is likely dead
      if (this.connected && Date.now() - this.lastMessageTime > 60000) {
        // Try a ping request — if it times out, force reconnect
        this.sendRequest("GET", "/devices/list").catch(() => {
          if (this.ws) {
            this.ws.close();
          }
        });
      }
    }, 30000); // Check every 30 seconds
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  private sendRequest(verb: string, path: string, payload?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.connected) {
        reject(new Error("Not connected"));
        return;
      }

      const id = `rr-${++this.msgId}`;
      const msg: Record<string, unknown> = { msgId: id, verb, path };
      if (payload) msg.payload = payload;

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error("Timeout"));
      }, 3000);

      this.pendingRequests.set(id, {
        resolve: (data) => { resolve(data); },
        timer,
      });

      this.ws.send(JSON.stringify(msg));
    });
  }

  async getDevices(): Promise<GHubDevice[]> {
    // Ensure we're connected before querying
    if (!this.connected) {
      await this.initialize();
    }
    try {
      const resp = (await this.sendRequest("GET", "/devices/list")) as {
        payload?: { deviceInfos?: GHubDevice[] };
      };
      const devices = resp?.payload?.deviceInfos || [];
      this.cachedDevices = devices.filter(
        (d) => d.capabilities?.hasBatteryStatus
      );
      return this.cachedDevices;
    } catch {
      // Request failed — connection might be dead, force reconnect
      if (this.ws) this.ws.close();
      return this.cachedDevices;
    }
  }

  async getBatteryInfo(device: GHubDevice): Promise<BatteryInfo> {
    const base: BatteryInfo = {
      deviceId: hashString(device.id),
      deviceName: device.extendedDisplayName || device.id,
      deviceType: mapDeviceType(device.deviceType),
      batteryLevel: -1,
      isCharging: false,
      isConnected: true,
    };

    try {
      const resp = (await this.sendRequest(
        "GET",
        `/battery/${device.id}/state`
      )) as {
        payload?: GHubBatteryState;
      };

      if (resp?.payload) {
        const bat = resp.payload;
        this.batteryCache.set(device.id, bat);
        base.batteryLevel = bat.percentage;
        base.isCharging = bat.charging;
      }
    } catch {
      // Use cached data if available
      const cached = this.batteryCache.get(device.id);
      if (cached) {
        base.batteryLevel = cached.percentage;
        base.isCharging = cached.charging;
      }
    }

    return base;
  }

  destroy(): void {
    this.stopHealthCheck();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
  }
}

function mapDeviceType(type: string): string {
  const t = (type || "").toLowerCase();
  if (t.includes("mouse")) return "Mouse";
  if (t.includes("keyboard")) return "Keyboard";
  if (t.includes("headset")) return "Headset";
  return type || "Device";
}

function hashString(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}
