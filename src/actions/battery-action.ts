import streamDeck, {
  action,
  KeyDownEvent,
  SingletonAction,
  WillAppearEvent,
  WillDisappearEvent,
  DidReceiveSettingsEvent,
  SendToPluginEvent,
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";

import { SteelSeriesClient } from "../steelseries/client";
import { LogitechClient } from "../logitech/client";
import type { BatteryInfo } from "../types";
import {
  generateBatteryIcon,
  generateErrorIcon,
  generateLoadingIcon,
  type IconOptions,
} from "../utils/icon-generator";

/** Per-action settings stored by Stream Deck */
interface BatteryActionSettings extends JsonObject {
  deviceId?: number;
  deviceName?: string;
  deviceBrand?: string; // "steelseries" | "logitech"
  logiDeviceId?: string; // Logitech device ID string (e.g. "dev00000007")
  pollInterval?: number;
  showPercentage?: boolean;
  showDeviceType?: boolean;
  showDeviceName?: boolean;
  showStatusText?: boolean;
  deviceTypeFontSize?: number;
  backgroundColor?: string;
  [key: string]: JsonValue;
}

/** Shared client instances */
const ssClient = new SteelSeriesClient();
const logiClient = new LogitechClient();

/** Active polling timers per action context */
const pollingTimers = new Map<string, ReturnType<typeof setInterval>>();

/** Cached battery info per device */
const batteryCache = new Map<number, BatteryInfo>();

@action({ UUID: "com.jcooler.peripheral-battery.monitor" })
export class BatteryAction extends SingletonAction<BatteryActionSettings> {
  override async onWillAppear(
    ev: WillAppearEvent<BatteryActionSettings>
  ): Promise<void> {
    const settings = ev.payload.settings;

    // Show loading state
    await ev.action.setImage(generateLoadingIcon());

    // Initialize both clients (either or both may succeed)
    const [ssOk, logiOk] = await Promise.all([
      ssClient.initialize().catch(() => false),
      logiClient.initialize().catch(() => false),
    ]);

    if (!ssOk && !logiOk) {
      await ev.action.setImage(generateErrorIcon("No Software Found"));
      return;
    }

    // If no device configured, try auto-detect
    if (!settings.deviceId) {
      await this.autoDetectAndConfigure(ev);
      return;
    }

    // Start polling
    await this.updateBatteryFromEvent(ev);
    this.startPolling(ev.action.id, settings);
  }

  override async onWillDisappear(
    ev: WillDisappearEvent<BatteryActionSettings>
  ): Promise<void> {
    this.stopPolling(ev.action.id);
  }

  override async onKeyDown(
    ev: KeyDownEvent<BatteryActionSettings>
  ): Promise<void> {
    // Manual refresh on key press
    await ev.action.setImage(generateLoadingIcon());
    await this.updateBatteryFromEvent(ev);
  }

  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<BatteryActionSettings>
  ): Promise<void> {
    // Settings changed from Property Inspector — restart polling with new device
    this.stopPolling(ev.action.id);
    await this.updateBatteryFromEvent(ev);
    this.startPolling(ev.action.id, ev.payload.settings);
  }

  override async onSendToPlugin(
    ev: SendToPluginEvent<JsonValue, BatteryActionSettings>
  ): Promise<void> {
    // Handle messages from the Property Inspector
    const payload = ev.payload as Record<string, unknown>;
    if (payload.event === "getDevices") {
      const deviceList: { id: number; name: string; type: string; brand: string; logiId?: string }[] = [];

      // SteelSeries devices
      try {
        const ssDevices = await ssClient.getDevices();
        ssDevices
          .filter(
            (d) =>
              d.connected === 1 &&
              (d.genericDevicePropertiesStatus?.includes("batteryLevels") ||
                d.deviceTypeName?.toLowerCase() === "headset" ||
                (d.display_name || d.name).toLowerCase().includes("wireless"))
          )
          .forEach((d) =>
            deviceList.push({
              id: d.id,
              name: `[SS] ${d.display_name || d.name}`,
              type: d.deviceTypeName || String(d.type),
              brand: "steelseries",
            })
          );
      } catch { /* SS not available */ }

      // Logitech devices
      try {
        const logiDevices = await logiClient.getDevices();
        logiDevices.forEach((d) =>
          deviceList.push({
            id: hashStr(d.id),
            name: `[Logi] ${d.extendedDisplayName || d.id}`,
            type: mapLogiType(d.deviceType),
            brand: "logitech",
            logiId: d.id,
          })
        );
      } catch { /* Logi not available */ }

      // Send device list to Property Inspector (may fail if PI is not visible)
      try {
        await streamDeck.ui.sendToPropertyInspector({ event: "deviceList", devices: deviceList });
      } catch {
        streamDeck.logger.debug("PI not available for device list");
      }
    }
  }

  /** Try to auto-detect the first available wireless device from any brand */
  private async autoDetectAndConfigure(
    ev: WillAppearEvent<BatteryActionSettings>
  ): Promise<void> {
    // Try SteelSeries first
    try {
      const ssDevices = await ssClient.getDevices();
      const wireless = ssDevices.filter(
        (d) =>
          d.connected === 1 &&
          (d.genericDevicePropertiesStatus?.includes("batteryLevels") ||
            d.deviceTypeName?.toLowerCase() === "headset" ||
            (d.display_name || d.name).toLowerCase().includes("wireless"))
      );
      if (wireless.length > 0) {
        const device = wireless[0];
        const settings: BatteryActionSettings = {
          deviceId: device.id,
          deviceName: device.display_name || device.name,
          deviceBrand: "steelseries",
          pollInterval: 30,
          showPercentage: true,
        };
        await ev.action.setSettings(settings);
        await this.updateBatteryForDevice(ev.action, settings);
        this.startPolling(ev.action.id, settings);
        return;
      }
    } catch { /* SS not available */ }

    // Try Logitech
    try {
      const logiDevices = await logiClient.getDevices();
      if (logiDevices.length > 0) {
        const device = logiDevices[0];
        const settings: BatteryActionSettings = {
          deviceId: hashStr(device.id),
          deviceName: device.extendedDisplayName || device.id,
          deviceBrand: "logitech",
          logiDeviceId: device.id,
          pollInterval: 30,
          showPercentage: true,
        };
        await ev.action.setSettings(settings);
        await this.updateBatteryForDevice(ev.action, settings);
        this.startPolling(ev.action.id, settings);
        return;
      }
    } catch { /* Logi not available */ }

    await ev.action.setImage(generateErrorIcon("No Devices"));
  }

  /** Update battery from an event (extracts action and settings) */
  private async updateBatteryFromEvent(
    ev: { action: { id: string; setImage(image: string): Promise<void>; setTitle(title: string): Promise<void> }; payload: { settings: BatteryActionSettings } }
  ): Promise<void> {
    await this.updateBatteryForDevice(ev.action, ev.payload.settings);
  }

  /** Build icon options from settings */
  private iconOpts(settings: BatteryActionSettings): IconOptions {
    return {
      showPercentage: settings.showPercentage !== false,
      showDeviceType: settings.showDeviceType === true,
      showDeviceName: settings.showDeviceName === true,
      showStatusText: settings.showStatusText === true,
      deviceTypeFontSize: (settings.deviceTypeFontSize as number) || 13,
      backgroundColor: (settings.backgroundColor as string) || "#0d1117",
    };
  }

  /** Fetch battery and update the key display — supports both SteelSeries and Logitech */
  private async updateBatteryForDevice(
    actionHandle: { id: string; setImage(image: string): Promise<void>; setTitle(title: string): Promise<void> },
    settings: BatteryActionSettings
  ): Promise<void> {
    if (!settings.deviceId) return;
    const bg = (settings.backgroundColor as string) || undefined;
    const brand = (settings.deviceBrand as string) || "steelseries";

    try {
      let batteryInfo: BatteryInfo | null = null;

      if (brand === "logitech" && settings.logiDeviceId) {
        // Logitech — find device by logiDeviceId string
        const devices = await logiClient.getDevices();
        const device = devices.find((d) => d.id === settings.logiDeviceId);
        if (!device) {
          await actionHandle.setImage(generateErrorIcon("Not Found", bg));
          return;
        }
        batteryInfo = await logiClient.getBatteryInfo(device);
      } else {
        // SteelSeries — find device by numeric id
        const devices = await ssClient.getDevices();
        const device = devices.find((d) => d.id === settings.deviceId);
        if (!device) {
          await actionHandle.setImage(generateErrorIcon("Not Found", bg));
          return;
        }
        batteryInfo = await ssClient.getBatteryInfo(device);
      }

      if (!batteryInfo || !batteryInfo.isConnected || batteryInfo.batteryLevel < 0) {
        await actionHandle.setImage(generateErrorIcon("Disconnected", bg));
        return;
      }

      batteryCache.set(settings.deviceId as number, batteryInfo);
      await actionHandle.setImage(generateBatteryIcon(batteryInfo, this.iconOpts(settings)));
    } catch (err) {
      streamDeck.logger.error(`Battery update failed: ${err}`);
      // Try to reinitialize on failure (handles sleep/wake, software restart)
      if (brand === "logitech") {
        logiClient.initialize().catch(() => {});
      } else {
        ssClient.reinitialize().catch(() => {});
      }
      await actionHandle.setImage(generateErrorIcon("Reconnecting", bg));
    }
  }

  /** Start periodic battery polling */
  private startPolling(
    contextId: string,
    settings: BatteryActionSettings
  ): void {
    const interval = Math.max(10, (settings.pollInterval as number) || 30) * 1000;

    this.stopPolling(contextId);

    const timer = setInterval(() => {
      // Wrap in self-executing async with full error handling to prevent unhandled rejections
      (async () => {
        try {
          for (const act of this.actions) {
            if (act.id === contextId) {
              await this.updateBatteryForDevice(act, settings);
              break;
            }
          }
        } catch (err) {
          streamDeck.logger.error(`Polling error: ${err}`);
        }
      })();
    }, interval);

    pollingTimers.set(contextId, timer);
  }

  /** Stop polling for a specific action */
  private stopPolling(contextId: string): void {
    const timer = pollingTimers.get(contextId);
    if (timer) {
      clearInterval(timer);
      pollingTimers.delete(contextId);
    }
  }
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function mapLogiType(type: string): string {
  const t = (type || "").toLowerCase();
  if (t.includes("mouse")) return "Mouse";
  if (t.includes("keyboard")) return "Keyboard";
  if (t.includes("headset")) return "Headset";
  return type || "Device";
}
