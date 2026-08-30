import streamDeck from "@elgato/streamdeck";

import type { DeviceProvider } from "../devices/types";
import { HidBatteryProvider } from "../hid/client";
import { LogitechClient } from "../logitech/client";
import { createSteelSeriesBatteryCacheStore } from "../steelseries/battery-cache";
import { SteelSeriesClient } from "../steelseries/client";
import { WindowsBluetoothProvider } from "../windows/client";
import { WindowsGamepadProvider } from "../windows/gamepad";

/**
 * Providers whose persisted identity is safe for cycling.
 * XInput slots are intentionally excluded because a different controller can
 * silently reuse the same slot after reconnect.
 */
export function createActiveProviders(): DeviceProvider[] {
  const steelSeriesBatteryCache = createSteelSeriesBatteryCacheStore({
    getGlobalSettings: () => streamDeck.settings.getGlobalSettings(),
    setGlobalSettings: (settings) =>
      streamDeck.settings.setGlobalSettings(settings),
  });
  return [
    new HidBatteryProvider(),
    new WindowsBluetoothProvider(),
    new WindowsGamepadProvider(),
    new LogitechClient({
      diagnosticSink: {
        info: (message) => streamDeck.logger.info(message),
        warn: (message) => streamDeck.logger.warn(message),
      },
    }),
    new SteelSeriesClient({
      batteryCache: steelSeriesBatteryCache,
      diagnosticSink: {
        warn: (message) => streamDeck.logger.warn(message),
      },
    }),
  ];
}
