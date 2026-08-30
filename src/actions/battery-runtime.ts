import { DeviceCatalog } from "../devices/catalog";
import type { DiscoveryResult } from "../devices/types";
import { ActionSession, type SessionRender } from "./action-session";
import type { PersistedBatterySettings } from "./settings";

interface BatteryRuntimeOptions {
  discoveryRefreshMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

const DEFAULT_DISCOVERY_REFRESH_MS = 5 * 60 * 1_000;

export class BatteryRuntime {
  private readonly sessions = new Map<string, ActionSession>();
  private readonly catalog: DeviceCatalog;
  private readonly render: (
    contextId: string,
    render: SessionRender
  ) => void | Promise<void>;
  private readonly discoveryRefreshMs: number;
  private readonly setTimer: NonNullable<BatteryRuntimeOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<BatteryRuntimeOptions["clearTimer"]>;
  private discoveryInFlight: Promise<DiscoveryResult> | null = null;
  private discoveryInFlightIsForced = false;
  private discoveryRefreshSessions = false;
  private queuedForceRefresh: Promise<DiscoveryResult> | null = null;
  private queuedForceRefreshSessions = false;
  private maintenanceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    catalog: DeviceCatalog,
    render: BatteryRuntime["render"],
    options: BatteryRuntimeOptions = {}
  ) {
    this.catalog = catalog;
    this.render = render;
    this.discoveryRefreshMs =
      options.discoveryRefreshMs ?? DEFAULT_DISCOVERY_REFRESH_MS;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  appear(contextId: string, settings: PersistedBatterySettings | unknown): void {
    this.disappear(contextId);
    const session = new ActionSession({
      readStatus: (device, signal) => this.catalog.readStatus(device, signal),
      render: (render) => this.render(contextId, render),
      onResume: async () => {
        await this.refreshDevices(true, false);
      },
    });
    this.sessions.set(contextId, session);
    session.appear(settings);
    this.startMaintenance();
    void this.refreshDevices(false).catch(() => undefined);
  }

  updateSettings(
    contextId: string,
    settings: PersistedBatterySettings | unknown
  ): void {
    this.sessions.get(contextId)?.updateSettings(settings);
  }

  keyDown(contextId: string): void {
    this.sessions.get(contextId)?.keyDown();
  }

  manualRefresh(contextId: string): void {
    this.sessions.get(contextId)?.manualRefresh();
  }

  disappear(contextId: string): void {
    const session = this.sessions.get(contextId);
    if (!session) return;
    session.disappear();
    this.sessions.delete(contextId);
    if (this.sessions.size === 0) this.stopMaintenance();
  }

  activeKey(contextId: string): string | null {
    return this.sessions.get(contextId)?.activeKey ?? null;
  }

  async refreshDevices(
    force: boolean,
    refreshSessions = true
  ): Promise<DiscoveryResult> {
    if (this.discoveryInFlight) {
      if (!force || this.discoveryInFlightIsForced) {
        this.discoveryRefreshSessions ||= refreshSessions;
        return this.discoveryInFlight;
      }

      this.queuedForceRefreshSessions ||= refreshSessions;
      if (!this.queuedForceRefresh) {
        const activeRequest = this.discoveryInFlight;
        const queuedRequest = activeRequest
          .catch(() => undefined)
          .then(() => {
            const shouldRefreshSessions = this.queuedForceRefreshSessions;
            this.queuedForceRefreshSessions = false;
            return this.startDiscovery(true, shouldRefreshSessions);
          });
        this.queuedForceRefresh = queuedRequest;
        const clearQueuedRequest = (): void => {
          if (this.queuedForceRefresh === queuedRequest) {
            this.queuedForceRefresh = null;
          }
        };
        void queuedRequest.then(clearQueuedRequest, clearQueuedRequest);
      }
      return this.queuedForceRefresh;
    }

    return this.startDiscovery(force, refreshSessions);
  }

  private async startDiscovery(
    force: boolean,
    refreshSessions: boolean
  ): Promise<DiscoveryResult> {
    if (force) this.catalog.invalidateDiscovery();
    this.discoveryInFlightIsForced = force;
    this.discoveryRefreshSessions = refreshSessions;

    const request = this.catalog.discover({ force });
    this.discoveryInFlight = request;
    try {
      const result = await request;
      if (this.discoveryRefreshSessions) {
        for (const session of this.sessions.values()) {
          session.manualRefresh();
        }
      }
      return result;
    } finally {
      if (this.discoveryInFlight === request) {
        this.discoveryInFlight = null;
        this.discoveryInFlightIsForced = false;
        this.discoveryRefreshSessions = false;
      }
    }
  }

  destroy(): void {
    for (const session of this.sessions.values()) session.disappear();
    this.sessions.clear();
    this.stopMaintenance();
  }

  private startMaintenance(): void {
    if (this.maintenanceTimer || this.sessions.size === 0) return;
    this.maintenanceTimer = this.setTimer(() => {
      this.maintenanceTimer = null;
      void this.refreshDevices(true)
        .catch(() => undefined)
        .finally(() => this.startMaintenance());
    }, this.discoveryRefreshMs);
  }

  private stopMaintenance(): void {
    if (!this.maintenanceTimer) return;
    this.clearTimer(this.maintenanceTimer);
    this.maintenanceTimer = null;
  }
}
