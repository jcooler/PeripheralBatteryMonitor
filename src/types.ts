/** Normalized battery info for display — shared across all device brands */
export interface BatteryInfo {
  deviceId: number;
  deviceName: string;
  deviceType: string;
  /** Battery percentage 0-100, or -1 if unavailable */
  batteryLevel: number;
  /** Whether the device is currently charging */
  isCharging: boolean;
  /** Whether the device is connected */
  isConnected: boolean;
  /** For headsets: base station battery level */
  chargerLevel?: number;
}
