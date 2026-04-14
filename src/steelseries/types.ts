/** Ports and addresses from SteelSeries coreProps.json */
export interface CoreProps {
  /** Engine HTTPS server (e.g. "127.0.0.1:57192") */
  encryptedAddress: string;
  /** GG HTTPS server */
  ggEncryptedAddress: string;
  /** GameSense SDK HTTP server */
  address: string;
}

/** Raw API response from GET /devices */
export interface DevicesResponse {
  devices: SteelSeriesDevice[];
}

/** A SteelSeries device as returned by GET /devices */
export interface SteelSeriesDevice {
  id: number;
  /** Internal name (e.g. "aerox_5_wireless") */
  name: string;
  /** Display name (e.g. "Aerox 5 Wireless") */
  display_name: string;
  /** Device type number (0=keyboard, 1=mouse, 3=headset, etc.) */
  type: number;
  /** Human-readable type name (e.g. "Mouse", "Keyboard", "Headset") */
  deviceTypeName: string;
  /** 1 if connected, 0 if not */
  connected: number;
  /** Feature flags including "batteryLevels" */
  genericDevicePropertiesStatus?: string[];
}

/** Battery status for headsets (Arctis Nova Pro, etc.) */
export interface HeadsetBatteryStatus {
  headset_battery_level: { level: number };
  charger_battery_level: { level: number };
  charging_status: {
    chargingStatus:
      | "DISCHARGING"
      | "PLUGGED_IN_CHARGING"
      | "PLUGGED_IN_NOT_CHARGING"
      | "PAIRED_CONNECTED"
      | "PAIRED_NOT_CONNECTED"
      | "UNKNOWN_OR_HEADSET_NOT_CONNECTED";
  };
}

/** Normalized battery info for display */
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
