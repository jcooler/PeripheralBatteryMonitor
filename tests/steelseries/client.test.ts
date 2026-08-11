import { EventEmitter } from "node:events";
import type { RequestOptions } from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SteelSeriesClient,
  createSteelSeriesHttpsGetter,
  type SteelSeriesHttpRequest,
  type SteelSeriesSocket,
} from "../../src/steelseries/client";
import type { SteelSeriesDevice } from "../../src/steelseries/types";
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

function setup() {
  const requests: SteelSeriesHttpRequest[] = [];
  const sockets: FakeSocket[] = [];
  const readTextFile = vi.fn(async () =>
    JSON.stringify({ encryptedAddress: "127.0.0.1:57192" })
  );
  const httpGet = vi.fn(async (request: SteelSeriesHttpRequest) => {
    requests.push(request);
    return {
      devices: [
        batteryMouse,
        batteryHeadset,
        arenaSpeaker,
        unsupportedHeadset,
        unsupportedMouse,
      ],
    };
  });
  const createSocket = vi.fn(() => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });
  const client = new SteelSeriesClient({
    corePropsPaths: ["C:\\coreProps.json"],
    readTextFile,
    httpGet,
    createSocket,
    now: () => 25_000,
  });
  return { client, createSocket, httpGet, readTextFile, requests, sockets };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("passive SteelSeries GG client", () => {
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
      state: "unavailable",
      detail: "Waiting for passive SteelSeries battery data",
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
});
