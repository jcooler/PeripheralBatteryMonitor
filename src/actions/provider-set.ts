import type { DeviceProvider } from "../devices/types";
import { HidBatteryProvider } from "../hid/client";
import { LogitechClient } from "../logitech/client";
import { SteelSeriesClient } from "../steelseries/client";
import { WindowsBluetoothProvider } from "../windows/client";

/**
 * Providers whose persisted identity is safe for cycling.
 * XInput slots are intentionally excluded because a different controller can
 * silently reuse the same slot after reconnect.
 */
export function createActiveProviders(): DeviceProvider[] {
  return [
    new HidBatteryProvider(),
    new WindowsBluetoothProvider(),
    new LogitechClient(),
    new SteelSeriesClient(),
  ];
}
