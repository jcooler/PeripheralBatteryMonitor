import { EventEmitter } from "node:events";
import type { RequestOptions } from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SteelSeriesClient,
  createSteelSeriesHttpsGetter,
  type SteelSeriesHttpRequest,
  type SteelSeriesSocket,
} from "../../src/steelseries/client";
import type {
  SteelSeriesBatteryCacheEntry,
  SteelSeriesBatteryCacheStore,
} from "../../src/steelseries/battery-cache";
import type { SteelSeriesDevice } from "../../src/steelseries/types";
import { parseBatterySettings } from "../../src/actions/settings";
import { deferred } from "../helpers/deferred";

class FakeSocket extends EventEmitter implements SteelSeriesSocket {
  readonly sent: unknown[] = [];
  closeCalls = 0;

  close(): void {
    this.closeCalls += 1;
  }

  send(data: unknown): void {
    this.sent.push(data);
  }
}

const batteryMouse: SteelSeriesDevice = {
  id: 42,
  name: "aerox_5_wireless",
  display_name: "Aerox 5 Wireless",
  type: 1,
  deviceTypeName: "Mouse",
  connected: 1,
  genericDevicePropertiesStatus: ["batteryLevels"],
};

const arenaSpeaker: SteelSeriesDevice = {
  id: 77,
  name: "arena_7",
  display_name: "Arena 7",
  type: 8,
  deviceTypeName: "Speaker",
  connected: 1,
  genericDevicePropertiesStatus: ["firmwareVersion"],
};

const batteryHeadset: SteelSeriesDevice = {
  id: 43,
  name: "arctis_nova_wireless",
  display_name: "Arctis Nova Wireless",
  type: 3,
  deviceTypeName: "Headset",
  connected: 1,
  genericDevicePropertiesStatus: ["batteryLevels"],
};

const batteryKeyboard: SteelSeriesDevice = {
  id: 45,
  name: "apex_pro_wireless",
  display_name: "Apex Pro Wireless",
  type: 2,
  deviceTypeName: "Keyboard",
  connected: 1,
  genericDevicePropertiesStatus: ["batteryLevels"],
};

const unsupportedMouse: SteelSeriesDevice = {
  id: 44,
  name: "rival_wired",
  display_name: "Rival Wired",
  type: 1,
  deviceTypeName: "Mouse",
  connected: 1,
  genericDevicePropertiesStatus: ["batteryLevelsLegacy"],
};

const unsupportedHeadset: SteelSeriesDevice = {
  id: 88,
  name: "arctis_unsupported",
  display_name: "Arctis Unsupported",
  type: 3,
  deviceTypeName: "Headset",
  connected: 1,
  genericDevicePropertiesStatus: [],
};

interface MutableClock {
  value: number;
}

interface FakeBatteryCache extends SteelSeriesBatteryCacheStore {
  readonly entries: Map<string, SteelSeriesBatteryCacheEntry>;
  readonly upserts: SteelSeriesBatteryCacheEntry[];
  readonly removals: string[];
  loadCalls: number;
}

function fakeBatteryCache(
  initialEntries: readonly SteelSeriesBatteryCacheEntry[] = []
): FakeBatteryCache {
  const entries = new Map(
    initialEntries.map((entry) => [entry.nativeId, { ...entry }])
  );
  const upserts: SteelSeriesBatteryCacheEntry[] = [];
  const removals: string[] = [];
  return {
    entries,
    upserts,
    removals,
    loadCalls: 0,
    async load() {
      this.loadCalls += 1;
      return [...entries.values()].map((entry) => ({ ...entry }));
    },
    async upsert(entry) {
      upserts.push({ ...entry });
      entries.set(entry.nativeId, { ...entry });
    },
    async remove(nativeId) {
      removals.push(nativeId);
      entries.delete(nativeId);
    },
  };
}

interface SetupOptions {
  clock?: MutableClock;
  inventory?: readonly SteelSeriesDevice[];
  cacheEntries?: readonly SteelSeriesBatteryCacheEntry[];
  batteryCache?: SteelSeriesBatteryCacheStore;
  diagnosticSink?: { warn(message: string): void };
}

function setup(options: SetupOptions = {}) {
  const clock = options.clock ?? { value: 25_000 };
  const inventory = options.inventory ?? [
    batteryMouse,
    batteryHeadset,
    arenaSpeaker,
    unsupportedHeadset,
    unsupportedMouse,
  ];
  const batteryCache =
    options.batteryCache ?? fakeBatteryCache(options.cacheEntries);
  const requests: SteelSeriesHttpRequest[] = [];
  const sockets: FakeSocket[] = [];
  const readTextFile = vi.fn(async () =>
    JSON.stringify({ encryptedAddress: "127.0.0.1:57192" })
  );
  const httpGet = vi.fn(async (request: SteelSeriesHttpRequest) => {
    requests.push(request);
    return {
      devices: inventory,
    };
  });
  const createSocket = vi.fn(() => {
    const socket = new FakeSocket();
    sockets.push(socket);
    queueMicrotask(() => socket.emit("open"));
    return socket;
  });
  const clientOptions = {
    corePropsPaths: ["C:\\coreProps.json"],
    readTextFile,
    httpGet,
    createSocket,
    now: () => clock.value,
    batteryCache,
    diagnosticSink: options.diagnosticSink,
  };
  const client = new SteelSeriesClient(clientOptions);
  return {
    batteryCache,
    client,
    clock,
    createSocket,
    httpGet,
    readTextFile,
    requests,
    sockets,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("passive SteelSeries GG client", () => {
  it.each([
    {
      label: "Apex keyboard",
      device: batteryKeyboard,
      eventData: {
        id: 45,
        connection_status: { status: 1 },
        battery_status: { charging: 0, level: 85 },
      },
    },
    {
      label: "Arctis headset",
      device: batteryHeadset,
      eventData: {
        id: 43,
        connectionEvent: { connectionStatus: "CONNECTED" },
        batteryEvent: { batteryPercent: 85 },
      },
    },
  ])("transitions fresh $label data to last-known after 15 minutes", async ({
    device,
    eventData,
  }) => {
    const clock = { value: 1_000_000 };
    const { batteryCache, client, sockets } = setup({ clock, inventory: [device] });
    const [selected] = await client.discover();
    expect((batteryCache as FakeBatteryCache).loadCalls).toBe(1);
    sockets[0].emit(
      "message",
      Buffer.from(JSON.stringify({ event: "device_event", data: eventData }))
    );

    clock.value += 15 * 60 * 1_000;
    await expect(client.readStatus(selected)).resolves.toMatchObject({
      state: "connected",
      level: { kind: "percentage", value: 85 },
      charging: device.id === batteryKeyboard.id ? false : null,
    });

    clock.value += 1;
    await expect(client.readStatus(selected)).resolves.toMatchObject({
      state: "connected",
      level: { kind: "percentage", value: 85 },
      charging: null,
      freshness: "last-known",
    });
  });

  it("initializes a receive-only socket without making an HTTP request", async () => {
    const { client, createSocket, requests, sockets } = setup();

    await expect(client.initialize()).resolves.toBe(true);

    expect(createSocket).toHaveBeenCalledWith(
      "wss://127.0.0.1:57192/sock",
      expect.objectContaining({ rejectUnauthorized: false })
    );
    expect(requests).toEqual([]);
    expect(sockets[0].sent).toEqual([]);
  });

  it("enumerates with GET only and excludes Arena and unsupported devices", async () => {
    const { client, requests } = setup();

    const devices = await client.discover();

    expect(devices.map((device) => device.key)).toEqual([
      "steelseries:42",
      "steelseries:43",
    ]);
    expect(devices[0]).toMatchObject({
      providerLabel: "SteelSeries GG",
      name: "Aerox 5 Wireless",
      nativeId: "42",
    });
    expect(requests).toEqual([
      expect.objectContaining({
        address: "127.0.0.1:57192",
        method: "GET",
        path: "/devices",
      }),
    ]);
  });

  it("uses only passive socket events for repeated status reads and switching", async () => {
    const { client, requests, sockets } = setup();
    const [mouse] = await client.discover();
    sockets[0].emit(
      "message",
      Buffer.from(
        JSON.stringify({
          event: "device_event",
          data: {
            id: 42,
            connection_status: { status: 1 },
            battery_status: { charging: 0, level: 63 },
          },
        })
      )
    );

    await expect(client.readStatus(mouse)).resolves.toMatchObject({
      state: "connected",
      level: { kind: "percentage", value: 63 },
      charging: false,
      providerLabel: "SteelSeries GG",
      observedAt: 25_000,
    });
    await client.readStatus(mouse);
    await client.readStatus({ ...mouse, nativeId: "999", key: "steelseries:999" });

    expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "GET", path: "/devices" },
    ]);
    expect(sockets[0].sent).toEqual([]);
  });

  it("reports unavailable instead of stimulating GG when no event has supplied battery", async () => {
    const { client, requests } = setup();
    const [mouse] = await client.discover();

    await expect(client.readStatus(mouse)).resolves.toMatchObject({
      state: "unavailable",
      level: { kind: "unavailable" },
      detail: "Waiting for passive SteelSeries battery data",
    });
    expect(requests).toHaveLength(1);
  });

  it("lets a newer passive inventory refresh replace an older disconnect event", async () => {
    const { client, sockets } = setup();
    const [mouse] = await client.discover();
    sockets[0].emit("message", Buffer.from(JSON.stringify({
      event: "device_event",
      data: { id: 42, connection_status: { status: 0 } },
    })));
    await expect(client.readStatus(mouse)).resolves.toMatchObject({
      state: "disconnected",
    });

    await client.discover();

    await expect(client.readStatus(mouse)).resolves.toMatchObject({
      state: "unavailable",
      detail: "Waiting for passive SteelSeries battery data",
    });
  });

  it("preserves a disconnect event received during an inventory refresh", async () => {
    const nextInventory = deferred<unknown>();
    const { client, httpGet, sockets } = setup();
    const [mouse] = await client.discover();
    httpGet.mockImplementationOnce(() => nextInventory.promise);

    const refresh = client.discover();
    await vi.waitFor(() => expect(httpGet).toHaveBeenCalledTimes(2));
    sockets[0].emit("message", Buffer.from(JSON.stringify({
      event: "device_event",
      data: { id: 42, connection_status: { status: 0 } },
    })));
    nextInventory.resolve({ devices: [batteryMouse] });
    await refresh;

    await expect(client.readStatus(mouse)).resolves.toMatchObject({
      state: "disconnected",
      detail: "Disconnected",
    });
  });

  it("does not reuse battery data after inventory confirms a disconnect", async () => {
    const { client, httpGet, sockets } = setup();
    const [mouse] = await client.discover();
    sockets[0].emit("message", Buffer.from(JSON.stringify({
      event: "device_event",
      data: { id: 42, battery_status: { charging: 0, level: 63 } },
    })));
    await expect(client.readStatus(mouse)).resolves.toMatchObject({
      state: "connected",
      level: { kind: "percentage", value: 63 },
    });

    httpGet.mockResolvedValueOnce({
      devices: [{ ...batteryMouse, connected: 0 }],
    });
    await client.discover();
    await expect(client.readStatus(mouse)).resolves.toMatchObject({
      state: "disconnected",
    });

    httpGet.mockResolvedValueOnce({ devices: [batteryMouse] });
    await client.discover();
    await expect(client.readStatus(mouse)).resolves.toMatchObject({
      state: "unavailable",
      detail: "Waiting for passive SteelSeries battery data",
    });
  });

  it("accepts an exact legacy ID and saved name until canonical type metadata is persisted", async () => {
    const { client, sockets } = setup();
    const [legacyMouse] = parseBatterySettings({
      deviceBrand: "steelseries",
      deviceId: 42,
      deviceName: "[SS] Aerox 5 Wireless",
    }).settings.selectedDevices;
    await client.discover();
    sockets[0].emit("message", Buffer.from(JSON.stringify({
      event: "device_event",
      data: { id: 42, battery_status: { charging: 0, level: 63 } },
    })));

    await expect(client.readStatus(legacyMouse)).resolves.toMatchObject({
      state: "connected",
      level: { kind: "percentage", value: 63 },
    });
  });

  it("reconnects into a fresh event generation without HTTP or application sends", async () => {
    vi.useFakeTimers();
    const { client, readTextFile, requests, sockets } = setup();
    await client.initialize();

    sockets[0].emit("close");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(readTextFile).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);
    expect(sockets[1].sent).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("recovers an exact identity after a transient same-endpoint socket loss", async () => {
    vi.useFakeTimers();
    const { client, requests, sockets } = setup();
    const [mouse] = await client.discover();
    sockets[0].emit("message", Buffer.from(JSON.stringify({
      event: "device_event",
      data: { id: 42, battery_status: { charging: 0, level: 63 } },
    })));
    await expect(client.readStatus(mouse)).resolves.toMatchObject({
      level: { kind: "percentage", value: 63 },
    });

    sockets[0].emit("close");
    await expect(client.readStatus(mouse)).resolves.toMatchObject({
      state: "unavailable",
      detail: "SteelSeries device not found",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    sockets[1].emit("message", Buffer.from(JSON.stringify({
      event: "device_event",
      data: { id: 42, battery_status: { charging: 0, level: 47 } },
    })));

    await expect(client.readStatus(mouse)).resolves.toMatchObject({
      state: "connected",
      level: { kind: "percentage", value: 47 },
    });
    expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "GET", path: "/devices" },
      { method: "GET", path: "/devices" },
    ]);
    expect(sockets.flatMap((socket) => socket.sent)).toEqual([]);
  });

  it("never displays a recycled numeric ID when its inventory metadata changed", async () => {
    vi.useFakeTimers();
    const { client, httpGet, readTextFile, requests, sockets } = setup();
    const [oldMouse] = await client.discover();
    const replacement = {
      ...batteryMouse,
      name: "replacement_wireless",
      display_name: "Replacement Wireless",
    };
    readTextFile.mockResolvedValue(
      JSON.stringify({ encryptedAddress: "127.0.0.1:57193" })
    );
    httpGet.mockResolvedValue({ devices: [replacement] });

    sockets[0].emit("close");
    await vi.advanceTimersByTimeAsync(5_000);
    sockets[1].emit("message", Buffer.from(JSON.stringify({
      event: "device_event",
      data: { id: 42, battery_status: { charging: 0, level: 99 } },
    })));

    await expect(client.readStatus(oldMouse)).resolves.toMatchObject({
      state: "unavailable",
      level: { kind: "unavailable" },
      detail: "SteelSeries identity metadata changed",
    });
    const [newDevice] = await client.discover();
    expect(newDevice).toMatchObject({
      key: "steelseries:42",
      nativeId: "42",
      name: "Replacement Wireless",
    });
    expect(newDevice.key).toBe(oldMouse.key);
    expect(requests.every(({ method, path }) => method === "GET" && path === "/devices")).toBe(true);
  });

  it("ignores stale socket callbacks and destroy never schedules reconnect", async () => {
    vi.useFakeTimers();
    const { client, readTextFile, sockets } = setup();
    await client.initialize();
    const oldSocket = sockets[0];

    await client.reinitialize();
    expect(sockets).toHaveLength(2);
    oldSocket.emit("close");
    oldSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          event: "device_event",
          data: { id: 42, battery_status: { charging: 0, level: 99 } },
        })
      )
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(2);

    const [mouse] = await client.discover();
    await expect(client.readStatus(mouse)).resolves.toMatchObject({
      state: "unavailable",
    });

    client.destroy();
    sockets[1].emit("close");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(readTextFile).toHaveBeenCalledTimes(2);
  });

  it("can retry initialization after GG was absent", async () => {
    const { client, readTextFile } = setup();
    readTextFile.mockRejectedValueOnce(new Error("missing"));

    await expect(client.initialize()).resolves.toBe(false);
    await expect(client.initialize()).resolves.toBe(true);
    expect(readTextFile).toHaveBeenCalledTimes(2);
  });

  it("does not reopen a socket when destroy wins an initialization race", async () => {
    const coreProps = deferred<string>();
    const createSocket = vi.fn(() => new FakeSocket());
    const client = new SteelSeriesClient({
      corePropsPaths: ["coreProps.json"],
      readTextFile: vi.fn(() => coreProps.promise),
      httpGet: vi.fn(),
      createSocket,
    });

    const initialization = client.initialize();
    client.destroy();
    coreProps.resolve(JSON.stringify({ encryptedAddress: "127.0.0.1:57192" }));

    await expect(initialization).resolves.toBe(false);
    expect(createSocket).not.toHaveBeenCalled();
  });

  it("keeps retrying after a reconnect attempt finds GG temporarily unavailable", async () => {
    vi.useFakeTimers();
    const { client, readTextFile, sockets } = setup();
    await client.initialize();
    readTextFile
      .mockRejectedValueOnce(new Error("GG restarting"))
      .mockResolvedValue(JSON.stringify({ encryptedAddress: "127.0.0.1:57192" }));

    sockets[0].emit("close");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(readTextFile).toHaveBeenCalledTimes(3);
    expect(sockets).toHaveLength(2);
  });

  it("discards a device response from an older engine generation", async () => {
    const oldResponse = deferred<unknown>();
    const { client, httpGet } = setup();
    httpGet.mockImplementationOnce(() => oldResponse.promise);

    const discovery = client.discover();
    await vi.waitFor(() => expect(httpGet).toHaveBeenCalledTimes(1));
    await client.reinitialize();
    oldResponse.resolve({ devices: [batteryMouse] });

    await expect(discovery).rejects.toThrow("generation changed");
  });

  it("does not refresh an old battery level timestamp from charging-only events", async () => {
    let now = 0;
    const sockets: FakeSocket[] = [];
    const client = new SteelSeriesClient({
      corePropsPaths: ["coreProps.json"],
      readTextFile: vi.fn(async () => JSON.stringify({ encryptedAddress: "127.0.0.1:57192" })),
      httpGet: vi.fn(async () => ({ devices: [batteryMouse] })),
      createSocket: vi.fn(() => {
        const socket = new FakeSocket();
        sockets.push(socket);
        queueMicrotask(() => socket.emit("open"));
        return socket;
      }),
      now: () => now,
      liveDataMaxAgeMs: 100,
    });
    const [mouse] = await client.discover();
    sockets[0].emit("message", Buffer.from(JSON.stringify({
      event: "device_event",
      data: { id: 42, battery_status: { charging: 0, level: 50 } },
    })));
    now = 99;
    sockets[0].emit("message", Buffer.from(JSON.stringify({
      event: "device_event",
      data: { id: 42, chargingEvent: { chargingStatus: "PLUGGED_IN_CHARGING" } },
    })));
    now = 101;

    await expect(client.readStatus(mouse)).resolves.toMatchObject({
      state: "connected",
      level: { kind: "percentage", value: 50 },
      charging: null,
      observedAt: 0,
      freshness: "last-known",
    });
  });

  it("keeps unavailable passive data distinct from a disconnected device in the legacy wrapper", async () => {
    const { client } = setup();
    const [device] = await client.getDevices();

    await expect(client.getBatteryInfo(device)).resolves.toMatchObject({
      batteryLevel: -1,
      isConnected: true,
    });
  });

  it("does not reuse battery data observed before a disconnect", async () => {
    const { client, sockets } = setup();
    const [mouse] = await client.discover();
    sockets[0].emit("message", Buffer.from(JSON.stringify({
      event: "device_event",
      data: {
        id: 42,
        connection_status: { status: 1 },
        battery_status: { charging: 0, level: 63 },
      },
    })));
    await expect(client.readStatus(mouse)).resolves.toMatchObject({
      level: { kind: "percentage", value: 63 },
    });

    sockets[0].emit("message", Buffer.from(JSON.stringify({
      event: "device_event",
      data: { id: 42, connection_status: { status: 0 } },
    })));
    sockets[0].emit("message", Buffer.from(JSON.stringify({
      event: "device_event",
      data: { id: 42, connection_status: { status: 1 } },
    })));

    await expect(client.readStatus(mouse)).resolves.toMatchObject({
      state: "unavailable",
      detail: "Waiting for passive SteelSeries battery data",
    });
  });

  it("fails closed for an unknown headset connection state", async () => {
    const { client, sockets } = setup();
    const [, headset] = await client.discover();
    sockets[0].emit("message", Buffer.from(JSON.stringify({
      event: "device_event",
      data: {
        id: 43,
        connectionEvent: { connectionStatus: "SOMETHING_NEW" },
        batteryEvent: { batteryPercent: 80 },
      },
    })));

    await expect(client.readStatus(headset)).resolves.toMatchObject({
      state: "disconnected",
      level: { kind: "unavailable" },
    });
  });

  it("times out a WebSocket handshake that never opens and retries later", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const client = new SteelSeriesClient({
      corePropsPaths: ["coreProps.json"],
      readTextFile: vi.fn(async () => JSON.stringify({ encryptedAddress: "127.0.0.1:57192" })),
      httpGet: vi.fn(),
      createSocket: vi.fn(() => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      }),
      handshakeTimeoutMs: 100,
    });

    const initialization = client.initialize();
    await vi.advanceTimersByTimeAsync(100);

    await expect(initialization).resolves.toBe(false);
    expect(sockets[0].closeCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets).toHaveLength(2);
  });

  it("omits malformed and duplicate inventory identities", async () => {
    const { client, httpGet } = setup();
    httpGet.mockResolvedValueOnce({
      devices: [
        batteryMouse,
        { ...batteryMouse, display_name: "Duplicate identity" },
        { ...unsupportedMouse, id: 45, genericDevicePropertiesStatus: "batteryLevels" },
        null,
      ],
    });

    await expect(client.discover()).resolves.toEqual([]);
  });

  it("persists a validated passive event with exact inventory metadata", async () => {
    const clock = { value: 4_000_000_000 };
    const batteryCache = fakeBatteryCache();
    const { client, sockets } = setup({
      batteryCache,
      clock,
      inventory: [batteryKeyboard],
    });
    await client.discover();

    sockets[0].emit("message", Buffer.from(JSON.stringify({
      event: "device_event",
      data: {
        id: 45,
        connection_status: { status: 1 },
        battery_status: { charging: 0, level: 72 },
      },
    })));

    await vi.waitFor(() => expect(batteryCache.upserts).toEqual([{
      nativeId: "45",
      name: "Apex Pro Wireless",
      deviceType: "Keyboard",
      level: 72,
      charging: false,
      observedAt: 4_000_000_000,
    }]));
  });

  it("keeps a pre-inventory event memory-only until exact discovery", async () => {
    const clock = { value: 4_000_000_000 };
    const batteryCache = fakeBatteryCache();
    const { client, sockets } = setup({
      batteryCache,
      clock,
      inventory: [batteryKeyboard],
    });
    await client.initialize();
    sockets[0].emit("message", Buffer.from(JSON.stringify({
      event: "device_event",
      data: { id: 45, battery_status: { charging: 1, level: 68 } },
    })));
    expect(batteryCache.upserts).toEqual([]);

    const [keyboard] = await client.discover();

    await expect(client.readStatus(keyboard)).resolves.toMatchObject({
      level: { kind: "percentage", value: 68 },
      charging: true,
    });
    await vi.waitFor(() => expect(batteryCache.upserts).toEqual([{
      nativeId: "45",
      name: "Apex Pro Wireless",
      deviceType: "Keyboard",
      level: 68,
      charging: true,
      observedAt: 4_000_000_000,
    }]));
  });

  it("keeps unusual future display metadata memory-only", async () => {
    const unusualKeyboard = {
      ...batteryKeyboard,
      display_name: "Apex [Wireless]",
    };
    const batteryCache = fakeBatteryCache();
    const { client, sockets } = setup({
      batteryCache,
      inventory: [unusualKeyboard],
    });
    const [keyboard] = await client.discover();
    sockets[0].emit("message", Buffer.from(JSON.stringify({
      event: "device_event",
      data: { id: 45, battery_status: { charging: 0, level: 70 } },
    })));

    await expect(client.readStatus(keyboard)).resolves.toMatchObject({
      state: "connected",
      level: { kind: "percentage", value: 70 },
    });
    expect(batteryCache.upserts).toEqual([]);
  });

  it("hydrates Apex and Arctis history only after current exact inventory", async () => {
    const clock = { value: 4_000_000_000 };
    const batteryCache = fakeBatteryCache([
      {
        nativeId: "45",
        name: "Apex Pro Wireless",
        deviceType: "Keyboard",
        level: 61,
        charging: true,
        observedAt: clock.value - 15 * 60 * 1_000,
      },
      {
        nativeId: "43",
        name: "Arctis Nova Wireless",
        deviceType: "Headset",
        level: 37,
        charging: false,
        observedAt: clock.value - 15 * 60 * 1_000 - 1,
      },
    ]);
    const { client } = setup({
      batteryCache,
      clock,
      inventory: [batteryKeyboard, batteryHeadset],
    });
    const keyboardRef = {
      key: "steelseries:45" as const,
      provider: "steelseries" as const,
      providerLabel: "SteelSeries GG",
      nativeId: "45",
      name: "Apex Pro Wireless",
      deviceType: "Keyboard",
    };

    await expect(client.readStatus(keyboardRef)).resolves.toMatchObject({
      state: "unavailable",
      detail: "SteelSeries device not found",
    });
    const [keyboard, headset] = await client.discover();

    await expect(client.readStatus(keyboard)).resolves.toMatchObject({
      state: "connected",
      level: { kind: "percentage", value: 61 },
      charging: true,
      observedAt: clock.value - 15 * 60 * 1_000,
    });
    await expect(client.readStatus(headset)).resolves.toMatchObject({
      state: "connected",
      level: { kind: "percentage", value: 37 },
      charging: null,
      observedAt: clock.value - 15 * 60 * 1_000 - 1,
      freshness: "last-known",
    });
    expect(batteryCache.loadCalls).toBe(1);
  });

  it.each(["connection event", "disconnected inventory"])(
    "removes history after a confirmed %s",
    async (mode) => {
      const clock = { value: 4_000_000_000 };
      const batteryCache = fakeBatteryCache();
      const { client, httpGet, sockets } = setup({
        batteryCache,
        clock,
        inventory: [batteryKeyboard],
      });
      const [keyboard] = await client.discover();
      sockets[0].emit("message", Buffer.from(JSON.stringify({
        event: "device_event",
        data: { id: 45, battery_status: { charging: 0, level: 72 } },
      })));

      if (mode === "connection event") {
        sockets[0].emit("message", Buffer.from(JSON.stringify({
          event: "device_event",
          data: { id: 45, connection_status: { status: 0 } },
        })));
      } else {
        httpGet.mockResolvedValueOnce({
          devices: [{ ...batteryKeyboard, connected: 0 }],
        });
        await client.discover();
      }

      await vi.waitFor(() => expect(batteryCache.removals).toEqual(["45"]));
      await expect(client.readStatus(keyboard)).resolves.toMatchObject({
        state: "disconnected",
        level: { kind: "unavailable" },
      });
    }
  );

  it("does not discard history for an unknown numeric connection status", async () => {
    const batteryCache = fakeBatteryCache();
    const { client, sockets } = setup({
      batteryCache,
      inventory: [batteryKeyboard],
    });
    const [keyboard] = await client.discover();
    sockets[0].emit("message", Buffer.from(JSON.stringify({
      event: "device_event",
      data: { id: 45, battery_status: { charging: 0, level: 72 } },
    })));
    sockets[0].emit("message", Buffer.from(JSON.stringify({
      event: "device_event",
      data: { id: 45, connection_status: { status: 2 } },
    })));

    expect(batteryCache.removals).toEqual([]);
    await expect(client.readStatus(keyboard)).resolves.toMatchObject({
      state: "connected",
      level: { kind: "percentage", value: 72 },
    });
  });

  it("retains absent-device persistence without displaying it", async () => {
    const clock = { value: 4_000_000_000 };
    const batteryCache = fakeBatteryCache([{
      nativeId: "45",
      name: "Apex Pro Wireless",
      deviceType: "Keyboard",
      level: 61,
      charging: false,
      observedAt: clock.value - 1,
    }]);
    const { client } = setup({ batteryCache, clock, inventory: [] });
    await expect(client.discover()).resolves.toEqual([]);

    await expect(client.readStatus({
      key: "steelseries:45",
      provider: "steelseries",
      providerLabel: "SteelSeries GG",
      nativeId: "45",
      name: "Apex Pro Wireless",
      deviceType: "Keyboard",
    })).resolves.toMatchObject({
      state: "unavailable",
      level: { kind: "unavailable" },
    });
    expect(batteryCache.removals).toEqual([]);
    expect(batteryCache.entries.has("45")).toBe(true);
  });

  it.each([
    {
      label: "name mismatch",
      entry: { name: "Old Apex", deviceType: "Keyboard", level: 55 },
      inventory: [batteryKeyboard],
    },
    {
      label: "type mismatch",
      entry: { name: "Apex Pro Wireless", deviceType: "Mouse", level: 55 },
      inventory: [batteryKeyboard],
    },
    {
      label: "recycled ID",
      entry: { name: "Aerox Old", deviceType: "Mouse", level: 55 },
      inventory: [batteryKeyboard],
    },
    {
      label: "duplicate inventory ID",
      entry: { name: "Apex Pro Wireless", deviceType: "Keyboard", level: 55 },
      inventory: [batteryKeyboard, { ...batteryKeyboard, display_name: "Second Apex" }],
    },
    {
      label: "invalid cache entry",
      entry: { name: "Apex Pro Wireless", deviceType: "Keyboard", level: 101 },
      inventory: [batteryKeyboard],
    },
  ])("removes $label history instead of displaying it", async ({ entry, inventory }) => {
    const clock = { value: 4_000_000_000 };
    const batteryCache = fakeBatteryCache([{
      nativeId: "45",
      charging: false,
      observedAt: clock.value - 1,
      ...entry,
    } as SteelSeriesBatteryCacheEntry]);
    const { client } = setup({ batteryCache, clock, inventory });
    const devices = await client.discover();

    await vi.waitFor(() => expect(batteryCache.removals).toEqual(["45"]));
    if (devices[0]) {
      await expect(client.readStatus(devices[0])).resolves.toMatchObject({
        level: { kind: "unavailable" },
      });
    } else {
      expect(devices).toEqual([]);
    }
  });

  it("removes history older than 30 days", async () => {
    const clock = { value: 4_000_000_000 };
    const batteryCache = fakeBatteryCache([{
      nativeId: "45",
      name: "Apex Pro Wireless",
      deviceType: "Keyboard",
      level: 55,
      charging: false,
      observedAt: clock.value - 30 * 24 * 60 * 60 * 1_000 - 1,
    }]);
    const { client } = setup({ batteryCache, clock, inventory: [batteryKeyboard] });
    const [keyboard] = await client.discover();

    await vi.waitFor(() => expect(batteryCache.removals).toEqual(["45"]));
    await expect(client.readStatus(keyboard)).resolves.toMatchObject({
      level: { kind: "unavailable" },
    });
  });

  it("does not let late hydration override a newer passive event", async () => {
    const hydration = deferred<readonly SteelSeriesBatteryCacheEntry[]>();
    const upserts: SteelSeriesBatteryCacheEntry[] = [];
    const batteryCache: SteelSeriesBatteryCacheStore = {
      load: vi.fn(() => hydration.promise),
      upsert: vi.fn(async (entry) => { upserts.push({ ...entry }); }),
      remove: vi.fn(async () => undefined),
    };
    const clock = { value: 4_000_000_000 };
    const { client, sockets } = setup({
      batteryCache,
      clock,
      inventory: [batteryKeyboard],
    });
    await client.initialize();
    const discovery = client.discover();
    await vi.waitFor(() => expect(batteryCache.load).toHaveBeenCalledTimes(1));
    sockets[0].emit("message", Buffer.from(JSON.stringify({
      event: "device_event",
      data: { id: 45, battery_status: { charging: 0, level: 91 } },
    })));
    hydration.resolve([{
      nativeId: "45",
      name: "Apex Pro Wireless",
      deviceType: "Keyboard",
      level: 20,
      charging: true,
      observedAt: clock.value - 1,
    }]);
    const [keyboard] = await discovery;

    await expect(client.readStatus(keyboard)).resolves.toMatchObject({
      level: { kind: "percentage", value: 91 },
      charging: false,
      observedAt: clock.value,
    });
    await vi.waitFor(() => expect(upserts).toEqual([{
      nativeId: "45",
      name: "Apex Pro Wireless",
      deviceType: "Keyboard",
      level: 91,
      charging: false,
      observedAt: clock.value,
    }]));
  });

  it("does not let late hydration revive a disconnected identity", async () => {
    const hydration = deferred<readonly SteelSeriesBatteryCacheEntry[]>();
    const removals: string[] = [];
    const batteryCache: SteelSeriesBatteryCacheStore = {
      load: vi.fn(() => hydration.promise),
      upsert: vi.fn(async () => undefined),
      remove: vi.fn(async (nativeId) => { removals.push(nativeId); }),
    };
    const clock = { value: 4_000_000_000 };
    const { client, sockets } = setup({
      batteryCache,
      clock,
      inventory: [batteryKeyboard],
    });
    await client.initialize();
    const discovery = client.discover();
    await vi.waitFor(() => expect(batteryCache.load).toHaveBeenCalledTimes(1));
    sockets[0].emit("message", Buffer.from(JSON.stringify({
      event: "device_event",
      data: { id: 45, connection_status: { status: 0 } },
    })));
    hydration.resolve([{
      nativeId: "45",
      name: "Apex Pro Wireless",
      deviceType: "Keyboard",
      level: 80,
      charging: false,
      observedAt: clock.value - 1,
    }]);
    const [keyboard] = await discovery;

    expect(removals).toEqual(["45"]);
    await expect(client.readStatus(keyboard)).resolves.toMatchObject({
      level: { kind: "unavailable" },
    });
  });

  it("retains history across socket loss until a successful new inventory", async () => {
    vi.useFakeTimers();
    const clock = { value: 4_000_000_000 };
    const { client, requests, sockets } = setup({
      clock,
      inventory: [batteryKeyboard],
    });
    const [keyboard] = await client.discover();
    sockets[0].emit("message", Buffer.from(JSON.stringify({
      event: "device_event",
      data: { id: 45, battery_status: { charging: 0, level: 76 } },
    })));
    sockets[0].emit("close");

    await expect(client.readStatus(keyboard)).resolves.toMatchObject({
      state: "unavailable",
      detail: "SteelSeries device not found",
    });
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(client.readStatus(keyboard)).resolves.toMatchObject({
      state: "connected",
      level: { kind: "percentage", value: 76 },
    });
    expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "GET", path: "/devices" },
      { method: "GET", path: "/devices" },
    ]);
  });

  it("does not change observedAt when a charging-only event is persisted", async () => {
    const clock = { value: 4_000_000_000 };
    const batteryCache = fakeBatteryCache();
    const { client, sockets } = setup({
      batteryCache,
      clock,
      inventory: [batteryKeyboard],
    });
    await client.discover();
    sockets[0].emit("message", Buffer.from(JSON.stringify({
      event: "device_event",
      data: { id: 45, battery_status: { charging: 0, level: 64 } },
    })));
    clock.value += 5_000;
    sockets[0].emit("message", Buffer.from(JSON.stringify({
      event: "device_event",
      data: { id: 45, chargingEvent: { chargingStatus: "PLUGGED_IN_CHARGING" } },
    })));

    await vi.waitFor(() => expect(batteryCache.upserts.at(-1)).toEqual({
      nativeId: "45",
      name: "Apex Pro Wireless",
      deviceType: "Keyboard",
      level: 64,
      charging: true,
      observedAt: 4_000_000_000,
    }));
  });

  it("keeps cache failures generic and does not fail discovery", async () => {
    const warn = vi.fn();
    const batteryCache: SteelSeriesBatteryCacheStore = {
      load: vi.fn(async () => { throw new Error("secret device metadata"); }),
      upsert: vi.fn(async () => { throw new Error("secret device metadata"); }),
      remove: vi.fn(async () => { throw new Error("secret device metadata"); }),
    };
    const { client, sockets } = setup({
      batteryCache,
      diagnosticSink: { warn },
      inventory: [batteryKeyboard],
    });
    await expect(client.discover()).resolves.toHaveLength(1);
    expect(warn).toHaveBeenCalledWith("SteelSeries battery cache unavailable");

    sockets[0].emit("message", Buffer.from(JSON.stringify({
      event: "device_event",
      data: { id: 45, battery_status: { charging: 0, level: 50 } },
    })));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
    expect(warn.mock.calls.flat()).not.toContain("secret device metadata");
  });
});

describe("SteelSeries HTTPS transport", () => {
  it("uses a loopback-scoped GET with request-local TLS and never changes the TLS environment", async () => {
    const original = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    const optionsSeen: RequestOptions[] = [];
    const environmentSeen: Array<string | undefined> = [];
    const requestImpl = ((options: RequestOptions, callback: (response: EventEmitter & { statusCode: number }) => void) => {
      optionsSeen.push(options);
      environmentSeen.push(process.env.NODE_TLS_REJECT_UNAUTHORIZED);
      const request = new EventEmitter() as EventEmitter & {
        end(): void;
        destroy(error?: Error): void;
        setTimeout(ms: number, callback: () => void): void;
      };
      request.setTimeout = vi.fn();
      request.destroy = vi.fn();
      request.end = () => {
        const response = new EventEmitter() as EventEmitter & { statusCode: number };
        response.statusCode = 200;
        callback(response);
        response.emit("data", Buffer.from('{"devices":[]}'));
        response.emit("end");
      };
      return request;
    }) as never;
    const get = createSteelSeriesHttpsGetter(requestImpl);

    await expect(
      get({ address: "127.0.0.1:57192", method: "GET", path: "/devices" })
    ).resolves.toEqual({ devices: [] });

    expect(optionsSeen).toEqual([
      expect.objectContaining({
        hostname: "127.0.0.1",
        port: 57192,
        method: "GET",
        path: "/devices",
        rejectUnauthorized: false,
      }),
    ]);
    expect(environmentSeen).toEqual([original]);
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(original);
  });

  it("rejects non-loopback addresses before opening a request", async () => {
    const requestImpl = vi.fn();
    const get = createSteelSeriesHttpsGetter(requestImpl as never);

    await expect(
      get({ address: "steelseries.example:443", method: "GET", path: "/devices" })
    ).rejects.toThrow("loopback");
    expect(requestImpl).not.toHaveBeenCalled();
  });

  it("rejects path, query, and user-info suffixes in the GG authority", async () => {
    const requestImpl = vi.fn();
    const get = createSteelSeriesHttpsGetter(requestImpl as never);

    await expect(
      get({ address: "127.0.0.1:57192/sock", method: "GET", path: "/devices" })
    ).rejects.toThrow("address");
    await expect(
      get({ address: "user@127.0.0.1:57192", method: "GET", path: "/devices" })
    ).rejects.toThrow("address");
    expect(requestImpl).not.toHaveBeenCalled();
  });

  it("rejects when the HTTPS response stream aborts mid-body", async () => {
    const requestImpl = ((options: RequestOptions, callback: (response: EventEmitter & { statusCode: number }) => void) => {
      void options;
      const request = new EventEmitter() as EventEmitter & {
        end(): void;
        destroy(error?: Error): void;
        setTimeout(ms: number, callback: () => void): void;
      };
      request.setTimeout = vi.fn();
      request.destroy = vi.fn();
      request.end = () => {
        const response = new EventEmitter() as EventEmitter & { statusCode: number };
        response.statusCode = 200;
        callback(response);
        response.emit("data", Buffer.from('{"devices":'));
        queueMicrotask(() => response.emit("error", new Error("connection reset")));
      };
      return request;
    }) as never;
    const get = createSteelSeriesHttpsGetter(requestImpl);

    await expect(
      get({ address: "127.0.0.1:57192", method: "GET", path: "/devices" })
    ).rejects.toThrow("connection reset");
  });

  it("handles a response error after rejecting a non-success status", async () => {
    const requestImpl = ((options: RequestOptions, callback: (response: EventEmitter & { statusCode: number; resume(): void }) => void) => {
      void options;
      const request = new EventEmitter() as EventEmitter & {
        end(): void;
        destroy(error?: Error): void;
        setTimeout(ms: number, callback: () => void): void;
      };
      request.setTimeout = vi.fn();
      request.destroy = vi.fn();
      request.end = () => {
        const response = new EventEmitter() as EventEmitter & {
          statusCode: number;
          resume(): void;
        };
        response.statusCode = 503;
        response.resume = vi.fn();
        callback(response);
        queueMicrotask(() => response.emit("error", new Error("reset after status")));
      };
      return request;
    }) as never;
    const get = createSteelSeriesHttpsGetter(requestImpl);

    await expect(
      get({ address: "127.0.0.1:57192", method: "GET", path: "/devices" })
    ).rejects.toThrow("HTTP 503");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  });
});
