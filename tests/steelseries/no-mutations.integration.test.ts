import { EventEmitter } from "node:events";
import type { JsonObject } from "@elgato/utils";
import { expect, it, vi } from "vitest";

import {
  SteelSeriesClient,
  type SteelSeriesHttpRequest,
  type SteelSeriesSocket,
} from "../../src/steelseries/client";
import { createSteelSeriesBatteryCacheStore } from "../../src/steelseries/battery-cache";
import type { SteelSeriesDevice } from "../../src/steelseries/types";

class RecordingSocket extends EventEmitter implements SteelSeriesSocket {
  sent: unknown[] = [];
  close(): void {}
  send(data: unknown): void {
    this.sent.push(data);
  }
}

it("never invokes a mutating SteelSeries operation across the full safe lifecycle", async () => {
  const requests: SteelSeriesHttpRequest[] = [];
  const sockets: RecordingSocket[] = [];
  let now = 4_000_000_000;
  let settings: JsonObject = { unrelated: { keep: true } };
  const backend = {
    async getGlobalSettings(): Promise<JsonObject> {
      return structuredClone(settings);
    },
    async setGlobalSettings(next: JsonObject): Promise<void> {
      settings = structuredClone(next);
    },
  };
  const keyboard: SteelSeriesDevice = {
    id: 330,
    name: "apex_pro_tkl_wireless",
    display_name: "Apex Pro TKL Wireless",
    type: 2,
    deviceTypeName: "Keyboard",
    connected: 1,
    genericDevicePropertiesStatus: ["batteryLevels"],
  };
  const headset: SteelSeriesDevice = {
    id: 245,
    name: "arctis_nova_7",
    display_name: "Arctis Nova 7",
    type: 3,
    deviceTypeName: "Headset",
    connected: 1,
    genericDevicePropertiesStatus: ["batteryLevels"],
  };
  const createClient = (): SteelSeriesClient =>
    new SteelSeriesClient({
      batteryCache: createSteelSeriesBatteryCacheStore(backend, { now: () => now }),
      corePropsPaths: ["coreProps.json"],
      readTextFile: vi.fn(async () => JSON.stringify({ encryptedAddress: "localhost:5000" })),
      httpGet: vi.fn(async (request: SteelSeriesHttpRequest) => {
        requests.push(request);
        return { devices: [keyboard, headset] };
      }),
      createSocket: vi.fn(() => {
        const socket = new RecordingSocket();
        sockets.push(socket);
        queueMicrotask(() => socket.emit("open"));
        return socket;
      }),
      now: () => now,
    });

  const client = createClient();

  // Startup + enumeration.
  await client.initialize();
  const [keyboardRef, headsetRef] = await client.discover();
  sockets[0].emit("message", Buffer.from(JSON.stringify({
    event: "device_event",
    data: {
      id: 330,
      connection_status: { status: 1 },
      battery_status: { charging: 0, level: 85 },
    },
  })));
  await expect(client.readStatus(keyboardRef)).resolves.toMatchObject({
    level: { kind: "percentage", value: 85 },
    charging: false,
  });
  now += 15 * 60 * 1_000 + 1;
  await expect(client.readStatus(keyboardRef)).resolves.toMatchObject({
    level: { kind: "percentage", value: 85 },
    charging: null,
    freshness: "last-known",
  });
  sockets[0].emit("message", Buffer.from(JSON.stringify({
    event: "device_event",
    data: {
      id: 245,
      connectionEvent: { connectionStatus: "CONNECTED" },
      batteryEvent: { batteryPercent: 62 },
    },
  })));
  await client.readStatus(headsetRef);
  await client.readStatus(keyboardRef);
  sockets[0].emit("message", Buffer.from(JSON.stringify({
    event: "device_event",
    data: { id: 330, connection_status: { status: 0 } },
  })));

  await vi.waitFor(() => {
    const cache = settings.steelseriesBatteryCacheV1 as JsonObject | undefined;
    expect(cache?.entries).toEqual([{
      nativeId: "245",
      name: "Arctis Nova 7",
      deviceType: "Headset",
      level: 62,
      charging: null,
      observedAt: now,
    }]);
  });

  // A new client instance hydrates the persisted headset after exact inventory.
  client.destroy();
  const restarted = createClient();
  const [, restartedHeadset] = await restarted.discover();
  await expect(restarted.readStatus(restartedHeadset)).resolves.toMatchObject({
    state: "connected",
    level: { kind: "percentage", value: 62 },
  });
  await restarted.readStatus(restartedHeadset);

  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    expect(request.method).toBe("GET");
    expect(request.path).toBe("/devices");
  }
  expect(requests.some((request) => /update|firmware|configure|function/i.test(request.path))).toBe(false);
  expect(sockets.flatMap((socket) => socket.sent)).toEqual([]);
  expect(settings.unrelated).toEqual({ keep: true });
  const cache = settings.steelseriesBatteryCacheV1 as JsonObject;
  const entries = cache.entries as JsonObject[];
  expect(entries).toHaveLength(1);
  expect(Object.keys(entries[0]).sort()).toEqual([
    "charging",
    "deviceType",
    "level",
    "name",
    "nativeId",
    "observedAt",
  ]);
});
