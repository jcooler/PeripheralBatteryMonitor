import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";

import {
  SteelSeriesClient,
  type SteelSeriesHttpRequest,
  type SteelSeriesSocket,
} from "../../src/steelseries/client";
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
  const device: SteelSeriesDevice = {
    id: 3,
    name: "rival_wireless",
    display_name: "Rival Wireless",
    type: 1,
    deviceTypeName: "Mouse",
    connected: 1,
    genericDevicePropertiesStatus: ["batteryLevels"],
  };
  const client = new SteelSeriesClient({
    corePropsPaths: ["coreProps.json"],
    readTextFile: vi.fn(async () => JSON.stringify({ encryptedAddress: "localhost:5000" })),
    httpGet: vi.fn(async (request: SteelSeriesHttpRequest) => {
      requests.push(request);
      return { devices: [device] };
    }),
    createSocket: vi.fn(() => {
      const socket = new RecordingSocket();
      sockets.push(socket);
      return socket;
    }),
    now: () => 1,
  });

  // Startup + enumeration.
  await client.initialize();
  let [selected] = await client.discover();
  let [legacySelected] = await client.getDevices();
  await client.getBatteryInfo(legacySelected);
  // Polling + switching to a missing exact identity.
  await client.readStatus(selected);
  await client.readStatus({ ...selected, key: "steelseries:4", nativeId: "4" });
  // Manual refresh.
  [selected] = await client.discover();
  await client.readStatus(selected);
  // Software restart/reconnect and enumeration afterward.
  await client.reinitialize();
  [selected] = await client.discover();
  await client.readStatus(selected);
  [legacySelected] = await client.getDevices();
  await client.getBatteryInfo(legacySelected);

  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    expect(request.method).toBe("GET");
    expect(request.path).toBe("/devices");
  }
  expect(requests.some((request) => /update|firmware|configure|function/i.test(request.path))).toBe(false);
  expect(sockets.flatMap((socket) => socket.sent)).toEqual([]);
});
