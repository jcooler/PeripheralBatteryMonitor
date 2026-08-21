import streamDeck, {
  DidReceiveSettingsEvent,
  KeyDownEvent,
  SendToPluginEvent,
  SingletonAction,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";

import { DeviceCatalog } from "../devices/catalog";
import {
  safeProviderDiscoveryError,
  type BatteryStatus,
  type DeviceDescriptor,
  type DiscoveryResult,
} from "../devices/types";
import type { BatteryInfo } from "../types";
import {
  generateBatteryIcon,
  generateErrorIcon,
  generateLoadingIcon,
  generateQualitativeBatteryIcon,
  type CycleIndicator,
  type IconOptions,
} from "../utils/icon-generator";
import { BatteryRuntime } from "./battery-runtime";
import { InspectorMessenger } from "./inspector-messenger";
import { createActiveProviders } from "./provider-set";
import type { SessionRender } from "./action-session";
import {
  parseBatterySettings,
  prepareMigratedDevices,
  toPersistedDevice,
  type NormalizedBatterySettings,
  type PersistedBatterySettings,
} from "./settings";

interface BatteryActionSettings extends JsonObject {
  schemaVersion?: number;
  selectedDevices?: JsonObject[];
  activeDeviceKey?: string;
  pollInterval?: number;
  showPercentage?: boolean;
  showDeviceType?: boolean;
  showDeviceName?: boolean;
  showStatusText?: boolean;
  deviceTypeFontSize?: number;
  backgroundColor?: string;
  // Legacy v1 fields are retained only for one-time exact migration.
  deviceId?: number;
  deviceName?: string;
  deviceBrand?: string;
  logiDeviceId?: string;
  xboxIndex?: number;
  [key: string]: JsonValue;
}

interface ActionHandle {
  id: string;
  setImage(image: string): Promise<void>;
  setTitle(title: string): Promise<void>;
  getSettings<T extends JsonObject>(): Promise<T>;
  setSettings(settings: BatteryActionSettings): Promise<void>;
}

const catalog = new DeviceCatalog(createActiveProviders());

export type BatteryActionRuntime = Pick<
  BatteryRuntime,
  | "appear"
  | "updateSettings"
  | "keyDown"
  | "manualRefresh"
  | "disappear"
  | "refreshDevices"
  | "activeKey"
>;

export interface BatteryActionOptions {
  runtime?: BatteryActionRuntime;
  inspector?: InspectorMessenger<JsonObject>;
}

interface RuntimeStatusSummary {
  deviceKey: string;
  state: "connected" | "disconnected" | "unavailable";
  batteryText: string;
}

interface ContextRuntimeSummary {
  currentDeviceKey: string | null;
  statuses: Map<string, RuntimeStatusSummary>;
}

export class BatteryAction extends SingletonAction<BatteryActionSettings> {
  private readonly handles = new Map<string, ActionHandle>();
  private readonly runtime: BatteryActionRuntime;
  private readonly inspector: InspectorMessenger<JsonObject>;
  private readonly runtimeSummaries = new Map<string, ContextRuntimeSummary>();
  private readonly renderGenerations = new Map<string, symbol>();

  constructor(options: BatteryActionOptions = {}) {
    super();
    this.runtime =
      options.runtime ??
      new BatteryRuntime(
        catalog,
        (contextId, render) => this.render(contextId, render)
      );
    this.inspector =
      options.inspector ??
      new InspectorMessenger<JsonObject>({
        activeContextId: () => streamDeck.ui.action?.id,
        send: (message) => streamDeck.ui.sendToPropertyInspector(message),
      });
  }

  override async onWillAppear(
    ev: WillAppearEvent<BatteryActionSettings>
  ): Promise<void> {
    this.handles.set(ev.action.id, ev.action);
    const persisted = ev.payload.settings as unknown as PersistedBatterySettings;
    this.runtime.appear(ev.action.id, persisted);

    if (parseBatterySettings(persisted).migrated) {
      let discovery: DiscoveryResult;
      try {
        discovery = await this.runtime.refreshDevices(false, false);
      } catch (error) {
        streamDeck.logger.warn(
          `Could not verify legacy device settings: ${errorMessage(error)}`
        );
        return;
      }
      if (this.handles.get(ev.action.id) !== ev.action) return;

      let latestSettings = ev.payload.settings;
      try {
        latestSettings = await ev.action.getSettings<BatteryActionSettings>();
      } catch {
        // The appearance payload is still safe if Stream Deck cannot re-read it.
      }
      const latestParsed = parseBatterySettings(
        latestSettings as unknown as PersistedBatterySettings
      );
      if (!latestParsed.migrated) return;
      const prepared = prepareMigratedDevices(
        latestParsed.settings.selectedDevices,
        discovery.devices,
        latestParsed.settings.activeDeviceKey
      );
      if (this.handles.get(ev.action.id) !== ev.action) return;
      if (!prepared.safeToPersist) {
        streamDeck.logger.warn(
          "Legacy device settings remain unmodified until every exact migration can be verified"
        );
        return;
      }

      const migrated = {
        ...latestSettings,
        schemaVersion: 2,
        selectedDevices: prepared.selectedDevices.map(
          (device) => toPersistedDevice(device) as JsonObject
        ),
      } satisfies BatteryActionSettings;
      if (prepared.activeDeviceKey) {
        migrated.activeDeviceKey = prepared.activeDeviceKey;
      } else {
        delete migrated.activeDeviceKey;
      }
      delete migrated.logiDeviceId;
      this.runtime.updateSettings(ev.action.id, migrated);
      this.runtime.manualRefresh(ev.action.id);
      try {
        await ev.action.setSettings(migrated);
      } catch (error) {
        streamDeck.logger.warn(`Could not persist migrated settings: ${errorMessage(error)}`);
      }
    }
  }

  override async onWillDisappear(
    ev: WillDisappearEvent<BatteryActionSettings>
  ): Promise<void> {
    this.runtime.disappear(ev.action.id);
    this.handles.delete(ev.action.id);
    this.runtimeSummaries.delete(ev.action.id);
    this.renderGenerations.delete(ev.action.id);
  }

  override async onKeyDown(
    ev: KeyDownEvent<BatteryActionSettings>
  ): Promise<void> {
    this.runtime.keyDown(ev.action.id);
    const activeDeviceKey = this.runtime.activeKey(ev.action.id);
    if (!activeDeviceKey) return;
    try {
      await ev.action.setSettings({
        ...ev.payload.settings,
        activeDeviceKey,
      });
    } catch (error) {
      streamDeck.logger.warn(
        `Could not persist active device: ${errorMessage(error)}`
      );
    }
  }

  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<BatteryActionSettings>
  ): Promise<void> {
    const persisted =
      ev.payload.settings as unknown as PersistedBatterySettings;
    this.runtime.updateSettings(ev.action.id, persisted);

    const activeDeviceKey = this.runtime.activeKey(ev.action.id);
    const savedActiveDeviceKey =
      typeof persisted.activeDeviceKey === "string"
        ? persisted.activeDeviceKey
        : null;
    if (
      activeDeviceKey === savedActiveDeviceKey ||
      this.handles.get(ev.action.id) !== ev.action
    ) {
      return;
    }

    const correctedSettings = { ...ev.payload.settings };
    if (activeDeviceKey) correctedSettings.activeDeviceKey = activeDeviceKey;
    else delete correctedSettings.activeDeviceKey;
    try {
      await ev.action.setSettings(correctedSettings);
    } catch (error) {
      streamDeck.logger.warn(
        `Could not reconcile active device: ${errorMessage(error)}`
      );
    }
  }

  override async onSendToPlugin(
    ev: SendToPluginEvent<JsonValue, BatteryActionSettings>
  ): Promise<void> {
    const payload = isRecord(ev.payload) ? ev.payload : {};
    if (
      payload.event !== "getDevices" &&
      payload.event !== "refreshDevices"
    ) {
      return;
    }

    const contextId = ev.action.id;
    await this.inspector.send(contextId, {
      event: "deviceList",
      state: "loading",
    });
    await this.sendCachedRuntimeSummary(contextId);
    try {
      const result = await this.runtime.refreshDevices(
        payload.event === "refreshDevices"
      );
      await this.inspector.send(contextId, discoveryMessage(result));
    } catch {
      await this.inspector.send(contextId, {
        event: "deviceList",
        state: "error",
        message: "Device discovery failed",
        devices: [],
        errors: [],
      });
    }
  }

  private async render(
    contextId: string,
    render: SessionRender
  ): Promise<void> {
    const handle = this.handles.get(contextId);
    if (!handle) return;
    const generation = Symbol(contextId);
    this.renderGenerations.set(contextId, generation);
    const isCurrentRender = () =>
      this.handles.get(contextId) === handle &&
      this.renderGenerations.get(contextId) === generation;
    const options = iconOptions(render.settings);
    const indicator =
      render.kind === "empty"
        ? undefined
        : cycleIndicator(render.settings, render.device);

    if (render.kind === "loading") {
      await handle.setImage(
        generateLoadingIcon(render.settings.backgroundColor, indicator)
      );
      if (!isCurrentRender()) return;
      await this.sendRuntimeSummary(contextId, render.device.key);
      return;
    }
    if (render.kind === "empty") {
      await handle.setImage(
        generateErrorIcon("Select Device", render.settings.backgroundColor)
      );
      if (!isCurrentRender()) return;
      this.runtimeSummaries.set(contextId, {
        currentDeviceKey: null,
        statuses: new Map(),
      });
      await this.sendCachedRuntimeSummary(contextId);
      return;
    }

    const { device, status } = render;
    if (status.state !== "connected" || status.level.kind === "unavailable") {
      const message =
        status.state === "disconnected"
          ? "Disconnected"
          : /no battery|wired/i.test(status.detail ?? "")
            ? "No Battery"
            : /not found|absent/i.test(status.detail ?? "")
              ? "Not Found"
              : "Unavailable";
      await handle.setImage(
        generateErrorIcon(message, render.settings.backgroundColor, indicator)
      );
      if (!isCurrentRender()) return;
      this.cacheRuntimeStatus(contextId, device.key, status);
      await this.sendCachedRuntimeSummary(contextId);
      return;
    }

    if (status.level.kind === "qualitative") {
      await handle.setImage(
        generateQualitativeBatteryIcon(
          {
            deviceName: device.name,
            deviceType: device.deviceType,
            level: status.level.value,
            providerLabel: status.providerLabel,
          },
          options,
          indicator
        )
      );
      if (!isCurrentRender()) return;
      this.cacheRuntimeStatus(contextId, device.key, status);
      await this.sendCachedRuntimeSummary(contextId);
      return;
    }

    const info: BatteryInfo = {
      deviceId: 0,
      deviceName: device.name,
      deviceType: device.deviceType,
      batteryLevel: status.level.value,
      isCharging: status.charging === true,
      isConnected: true,
      providerLabel: status.providerLabel,
    };
    await handle.setImage(generateBatteryIcon(info, options, indicator));
    if (!isCurrentRender()) return;
    this.cacheRuntimeStatus(contextId, device.key, status);
    await this.sendCachedRuntimeSummary(contextId);
  }

  private cacheRuntimeStatus(
    contextId: string,
    currentDeviceKey: string,
    status: BatteryStatus
  ): void {
    const summary = this.runtimeSummaries.get(contextId) ?? {
      currentDeviceKey,
      statuses: new Map<string, RuntimeStatusSummary>(),
    };
    summary.currentDeviceKey = currentDeviceKey;
    summary.statuses.set(currentDeviceKey, sanitizeRuntimeStatus(currentDeviceKey, status));
    this.runtimeSummaries.set(contextId, summary);
  }

  private async sendRuntimeSummary(
    contextId: string,
    currentDeviceKey: string
  ): Promise<void> {
    const summary = this.runtimeSummaries.get(contextId) ?? {
      currentDeviceKey,
      statuses: new Map<string, RuntimeStatusSummary>(),
    };
    summary.currentDeviceKey = currentDeviceKey;
    this.runtimeSummaries.set(contextId, summary);
    await this.sendCachedRuntimeSummary(contextId);
  }

  private async sendCachedRuntimeSummary(contextId: string): Promise<void> {
    const summary = this.runtimeSummaries.get(contextId);
    if (!summary) return;
    await this.inspector.send(contextId, {
      event: "deviceRuntimeStatus",
      currentDeviceKey: summary.currentDeviceKey,
      statuses: [...summary.statuses.values()].map((status) => ({ ...status })),
    });
  }

}

function sanitizeRuntimeStatus(
  deviceKey: string,
  status: BatteryStatus
): RuntimeStatusSummary {
  if (status.state === "disconnected") {
    return { deviceKey, state: "disconnected", batteryText: "Disconnected" };
  }
  if (status.state === "unavailable" || status.level.kind === "unavailable") {
    return { deviceKey, state: "unavailable", batteryText: "Unavailable" };
  }
  if (status.level.kind === "percentage") {
    const percentage = Math.round(Math.max(0, Math.min(100, status.level.value)));
    return { deviceKey, state: "connected", batteryText: `${percentage}%` };
  }
  const qualitativeLabels = {
    empty: "Empty",
    low: "Low",
    medium: "Medium",
    full: "Full",
  } as const;
  return {
    deviceKey,
    state: "connected",
    batteryText: qualitativeLabels[status.level.value],
  };
}

function iconOptions(settings: NormalizedBatterySettings): IconOptions {
  return {
    showPercentage: settings.showPercentage,
    showDeviceType: settings.showDeviceType,
    showDeviceName: settings.showDeviceName,
    showStatusText: settings.showStatusText,
    deviceTypeFontSize: settings.deviceTypeFontSize,
    backgroundColor: settings.backgroundColor,
  };
}

function cycleIndicator(
  settings: NormalizedBatterySettings,
  device: DeviceDescriptor
): CycleIndicator | undefined {
  if (settings.selectedDevices.length <= 1) return undefined;
  const activeIndex = settings.selectedDevices.findIndex(
    (candidate) => candidate.key === device.key
  );
  return activeIndex < 0
    ? undefined
    : { count: settings.selectedDevices.length, activeIndex };
}

function discoveryMessage(result: DiscoveryResult): JsonObject {
  const state =
    result.devices.length > 0 && result.errors.length > 0
      ? "partial"
      : result.devices.length > 0
        ? "success"
      : result.errors.length > 0
        ? "error"
        : "empty";
  return {
    event: "deviceList",
    state,
    message:
      state === "success"
        ? `${result.devices.length} device${result.devices.length === 1 ? "" : "s"} found`
        : state === "partial"
          ? `${result.devices.length} device${result.devices.length === 1 ? "" : "s"} found; some providers failed`
        : state === "empty"
          ? "No battery devices found"
          : "Device discovery failed",
    devices: result.devices.map(toInspectorDevice),
    errors: result.errors.map((error) => ({
      ...safeProviderDiscoveryError(error.provider),
    })),
    notices: (result.notices ?? []).map((notice) => ({ ...notice })),
    refreshedAt: result.refreshedAt,
  };
}

function toInspectorDevice(device: DeviceDescriptor): JsonObject {
  return toPersistedDevice(device) as JsonObject;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
