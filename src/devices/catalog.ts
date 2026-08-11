import {
  makeDeviceKey,
  unavailableStatus,
  type BatteryStatus,
  type DeviceDescriptor,
  type DeviceProvider,
  type DeviceRef,
  type DiscoveryResult,
  type ProviderDiscoveryError,
  type ProviderId,
} from "./types";

interface CatalogOptions {
  discoveryTtlMs?: number;
  now?: () => number;
}

interface ProviderCache {
  devices?: DeviceDescriptor[];
  cachedAt?: number;
  inFlight?: Promise<DeviceDescriptor[]>;
}

const DEFAULT_DISCOVERY_TTL_MS = 5 * 60 * 1_000;

export class DeviceCatalog {
  private readonly providers = new Map<ProviderId, DeviceProvider>();
  private readonly cache = new Map<ProviderId, ProviderCache>();
  private readonly discoveryTtlMs: number;
  private readonly now: () => number;

  constructor(providers: DeviceProvider[], options: CatalogOptions = {}) {
    for (const provider of providers) {
      if (this.providers.has(provider.id)) {
        throw new Error(`Duplicate provider: ${provider.id}`);
      }
      this.providers.set(provider.id, provider);
      this.cache.set(provider.id, {});
    }
    this.discoveryTtlMs = options.discoveryTtlMs ?? DEFAULT_DISCOVERY_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async discover(
    options: { force?: boolean; signal?: AbortSignal } = {}
  ): Promise<DiscoveryResult> {
    const refreshedAt = this.now();
    const settled = await Promise.all(
      [...this.providers.values()].map(async (provider) => {
        try {
          return {
            provider,
            devices: await this.discoverProvider(
              provider,
              options.force === true,
              options.signal
            ),
          };
        } catch (error) {
          return { provider, error };
        }
      })
    );

    const errors: ProviderDiscoveryError[] = [];
    const candidates: DeviceDescriptor[] = [];
    for (const item of settled) {
      if ("error" in item) {
        errors.push({
          provider: item.provider.id,
          providerLabel: item.provider.label,
          message: errorMessage(item.error),
        });
      } else {
        candidates.push(...item.devices);
      }
    }

    return {
      devices: deduplicateByPhysicalIdentity(candidates),
      errors,
      refreshedAt,
    };
  }

  invalidateDiscovery(providerId?: ProviderId): void {
    if (providerId) {
      const provider = this.providers.get(providerId);
      this.cache.set(providerId, {});
      provider?.invalidateDiscovery?.("catalog invalidated");
      return;
    }

    for (const [id, provider] of this.providers) {
      this.cache.set(id, {});
      provider.invalidateDiscovery?.("catalog invalidated");
    }
  }

  async readStatus(ref: DeviceRef, signal?: AbortSignal): Promise<BatteryStatus> {
    if (ref.key !== makeDeviceKey(ref.provider, ref.nativeId)) {
      return unavailableStatus(ref, this.now(), "Invalid device identity");
    }

    const provider = this.providers.get(ref.provider);
    if (!provider) {
      return unavailableStatus(ref, this.now(), "Provider unavailable");
    }

    try {
      return await provider.readStatus(ref, signal);
    } catch (error) {
      return unavailableStatus(ref, this.now(), errorMessage(error));
    }
  }

  private discoverProvider(
    provider: DeviceProvider,
    force: boolean,
    signal?: AbortSignal
  ): Promise<DeviceDescriptor[]> {
    const entry = this.cache.get(provider.id) ?? {};
    this.cache.set(provider.id, entry);

    if (entry.inFlight) return entry.inFlight;
    if (
      !force &&
      entry.devices !== undefined &&
      entry.cachedAt !== undefined &&
      this.now() - entry.cachedAt < this.discoveryTtlMs
    ) {
      return Promise.resolve(entry.devices);
    }

    const request = provider.discover(signal).then((devices) => {
      const checked = devices.map((device) => validateDescriptor(provider, device));
      entry.devices = checked;
      entry.cachedAt = this.now();
      return checked;
    });
    entry.inFlight = request;
    void request.finally(() => {
      if (entry.inFlight === request) entry.inFlight = undefined;
    }).catch(() => undefined);
    return request;
  }
}

function validateDescriptor(
  provider: DeviceProvider,
  device: DeviceDescriptor
): DeviceDescriptor {
  if (device.provider !== provider.id) {
    throw new Error(`${provider.label} returned a device for ${device.provider}`);
  }
  if (device.key !== makeDeviceKey(device.provider, device.nativeId)) {
    throw new Error(`${provider.label} returned an invalid device key`);
  }
  return device;
}

function deduplicateByPhysicalIdentity(
  devices: DeviceDescriptor[]
): DeviceDescriptor[] {
  const seenKeys = new Set<string>();
  const seenPhysicalIds = new Set<string>();
  const result: DeviceDescriptor[] = [];

  for (const device of devices) {
    if (seenKeys.has(device.key)) continue;
    if (device.physicalId && seenPhysicalIds.has(device.physicalId)) continue;
    seenKeys.add(device.key);
    if (device.physicalId) seenPhysicalIds.add(device.physicalId);
    result.push(device);
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
