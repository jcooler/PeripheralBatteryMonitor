import {
  unavailableStatus,
  type BatteryStatus,
  type DeviceRef,
} from "../devices/types";
import {
  parseBatterySettings,
  type NormalizedBatterySettings,
  type PersistedBatterySettings,
} from "./settings";

export type SessionRender =
  | {
      kind: "loading";
      device: DeviceRef;
      settings: NormalizedBatterySettings;
    }
  | {
      kind: "status";
      device: DeviceRef;
      status: BatteryStatus;
      settings: NormalizedBatterySettings;
    }
  | {
      kind: "empty";
      settings: NormalizedBatterySettings;
    };

interface ActionSessionOptions {
  readStatus(
    device: DeviceRef,
    signal?: AbortSignal
  ): Promise<BatteryStatus>;
  render(render: SessionRender): void | Promise<void>;
  onResume?(): void | Promise<void>;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface RefreshRequest {
  generation: number;
  deviceKey: string;
}

export class ActionSession {
  private readonly readStatus: ActionSessionOptions["readStatus"];
  private readonly render: ActionSessionOptions["render"];
  private readonly onResume?: ActionSessionOptions["onResume"];
  private readonly now: () => number;
  private readonly setTimer: NonNullable<ActionSessionOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<ActionSessionOptions["clearTimer"]>;

  private visible = false;
  private currentSettings = parseBatterySettings({}).settings;
  private activeDeviceKey: string | null = null;
  private generation = 0;
  private pending: RefreshRequest | null = null;
  private draining = false;
  private activeAbort: AbortController | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollDueAt: number | null = null;
  private lastStatus = new Map<string, BatteryStatus>();

  constructor(options: ActionSessionOptions) {
    this.readStatus = options.readStatus;
    this.render = options.render;
    this.onResume = options.onResume;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  get activeKey(): string | null {
    return this.activeDeviceKey;
  }

  appear(settings: PersistedBatterySettings | unknown): void {
    this.cancelCurrentWork();
    this.visible = true;
    this.currentSettings = parseBatterySettings(settings).settings;
    this.activeDeviceKey =
      this.currentSettings.activeDeviceKey ??
      this.currentSettings.selectedDevices[0]?.key ??
      null;
    if (!this.activeDeviceKey) {
      this.safeRender({ kind: "empty", settings: this.currentSettings });
      return;
    }
    this.requestRefresh(true);
  }

  updateSettings(settings: PersistedBatterySettings | unknown): void {
    if (!this.visible) return;
    const previous = this.currentSettings;
    const next = parseBatterySettings(settings).settings;
    const oldActive = this.activeDeviceKey;
    this.currentSettings = next;

    if (next.selectedDevices.length === 0) {
      this.activeDeviceKey = null;
      this.cancelRefreshOnly();
      this.safeRender({ kind: "empty", settings: next });
      return;
    }

    this.activeDeviceKey = next.selectedDevices.some(
      (device) => device.key === oldActive
    )
      ? oldActive
      : next.activeDeviceKey ?? next.selectedDevices[0].key;

    if (this.activeDeviceKey !== oldActive) {
      this.requestRefresh(true);
      return;
    }

    const status = this.activeDeviceKey
      ? this.lastStatus.get(this.activeDeviceKey)
      : undefined;
    const device = this.activeDevice();
    if (status && device) {
      this.safeRender({ kind: "status", device, status, settings: next });
    }
    if (previous.pollInterval !== next.pollInterval) {
      this.schedulePoll();
    }
  }

  keyDown(): void {
    if (!this.visible) return;
    const devices = this.currentSettings.selectedDevices;
    if (devices.length === 0) {
      this.safeRender({ kind: "empty", settings: this.currentSettings });
      return;
    }
    const currentIndex = devices.findIndex(
      (device) => device.key === this.activeDeviceKey
    );
    const nextIndex =
      devices.length === 1
        ? 0
        : ((currentIndex < 0 ? 0 : currentIndex) + 1) % devices.length;
    this.activeDeviceKey = devices[nextIndex].key;
    this.requestRefresh(true);
  }

  manualRefresh(): void {
    if (!this.visible || !this.activeDeviceKey) return;
    this.requestRefresh(true);
  }

  disappear(): void {
    if (!this.visible) return;
    this.visible = false;
    this.cancelCurrentWork();
    this.activeDeviceKey = null;
  }

  private requestRefresh(showLoading: boolean): void {
    const device = this.activeDevice();
    if (!this.visible || !device) return;
    this.clearPollTimer();
    this.generation += 1;
    this.activeAbort?.abort();
    const request = {
      generation: this.generation,
      deviceKey: device.key,
    };
    this.pending = request;
    if (showLoading) {
      this.safeRender({
        kind: "loading",
        device,
        settings: this.currentSettings,
      });
    }
    if (!this.draining) void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.visible && this.pending) {
        const request = this.pending;
        this.pending = null;
        const device = this.deviceByKey(request.deviceKey);
        if (!device || !this.isCurrent(request)) continue;

        const controller = new AbortController();
        this.activeAbort = controller;
        let status: BatteryStatus;
        try {
          status = await this.readStatus(device, controller.signal);
        } catch (error) {
          status = unavailableStatus(device, this.now(), errorMessage(error));
        } finally {
          if (this.activeAbort === controller) this.activeAbort = null;
        }

        if (!this.isCurrent(request)) continue;
        this.lastStatus.set(device.key, status);
        await this.safeRender({
          kind: "status",
          device: this.deviceByKey(device.key) ?? device,
          status,
          settings: this.currentSettings,
        });
      }
    } finally {
      this.draining = false;
      if (this.visible && this.pending) void this.drain();
      else if (this.visible && this.activeDeviceKey) this.schedulePoll();
    }
  }

  private schedulePoll(): void {
    this.clearPollTimer();
    if (!this.visible || !this.activeDeviceKey || this.draining) return;
    const delay = this.currentSettings.pollInterval * 1_000;
    const dueAt = this.now() + delay;
    const scheduledGeneration = this.generation;
    const scheduledKey = this.activeDeviceKey;
    this.pollDueAt = dueAt;
    this.pollTimer = this.setTimer(() => {
      this.pollTimer = null;
      const lateness = this.now() - dueAt;
      this.pollDueAt = null;
      const refreshIfCurrent = (): void => {
        if (
          this.visible &&
          this.generation === scheduledGeneration &&
          this.activeDeviceKey === scheduledKey
        ) {
          this.requestRefresh(false);
        }
      };
      if (lateness > Math.max(5_000, delay / 2)) {
        try {
          void Promise.resolve(this.onResume?.())
            .catch(() => undefined)
            .finally(refreshIfCurrent);
        } catch {
          refreshIfCurrent();
        }
      } else {
        refreshIfCurrent();
      }
    }, delay);
  }

  private activeDevice(): DeviceRef | undefined {
    if (!this.activeDeviceKey) return undefined;
    return this.deviceByKey(this.activeDeviceKey);
  }

  private deviceByKey(key: string): DeviceRef | undefined {
    return this.currentSettings.selectedDevices.find(
      (device) => device.key === key
    );
  }

  private isCurrent(request: RefreshRequest): boolean {
    return (
      this.visible &&
      request.generation === this.generation &&
      request.deviceKey === this.activeDeviceKey
    );
  }

  private cancelRefreshOnly(): void {
    this.generation += 1;
    this.activeAbort?.abort();
    this.activeAbort = null;
    this.pending = null;
    this.clearPollTimer();
  }

  private cancelCurrentWork(): void {
    this.cancelRefreshOnly();
    this.lastStatus.clear();
  }

  private clearPollTimer(): void {
    if (this.pollTimer) this.clearTimer(this.pollTimer);
    this.pollTimer = null;
    this.pollDueAt = null;
  }

  private async safeRender(render: SessionRender): Promise<void> {
    try {
      await this.render(render);
    } catch {
      // A disappearing Stream Deck action can reject an otherwise valid render.
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
