/** Normalized battery info for display — shared across all device brands */
export interface BatteryInfo {
  deviceId: number;
  deviceName: string;
  deviceType: string;
  /** Battery percentage 0-100, or -1 if unavailable */
  batteryLevel: number;
  /** Whether the device is currently charging */
  isCharging: boolean;
  /** Whether this percentage is the last known reading rather than a fresh value. */
  isLastKnown?: boolean;
  /** Whether the device is connected */
  isConnected: boolean;
  /** Human-readable source of this status, shown when status text is enabled. */
  providerLabel?: string;
  /** For headsets: base station battery level */
  chargerLevel?: number;
}
