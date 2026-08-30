import type { BatteryInfo } from "../types";

export function batteryStatusError(
  batteryInfo: BatteryInfo | null
): "Disconnected" | "Unavailable" | null {
  if (!batteryInfo) return "Unavailable";
  if (!batteryInfo.isConnected) return "Disconnected";
  if (batteryInfo.batteryLevel < 0) return "Unavailable";
  return null;
}
