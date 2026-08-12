import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";

import { BatteryRuntime } from "../../src/actions/battery-runtime";
import type { PersistedBatterySettings } from "../../src/actions/settings";
import { DeviceCatalog } from "../../src/devices/catalog";
import { makeDeviceKey, type DeviceRef } from "../../src/devices/types";
import {
  SteelSeriesClient,
  type SteelSeriesHttpRequest,
  type SteelSeriesSocket,
} from "../../src/steelseries/client";

class RecordingSocket extends EventEmitter implements SteelSeriesSocket {
  readonly sent: unknown[] = [];
  close(): void {}
  send(value: unknown): void {
    this.sent.push(value);
  }
}

function selected(nativeId: string, name: string): DeviceRef {
  return {
    key: makeDeviceKey("steelseries", nativeId),
    provider: "steelseries",
    providerLabel: "SteelSeries GG",
    nativeId,
    name,
    deviceType: "Mouse",
  };
}

afterEach(() => {
  vi.useRealTimers();
});

it("keeps SteelSeries passive through action startup, polling, refresh, reconnect, and switching", async () => {
  vi.useFakeTimers();
  const requests: SteelSeriesHttpRequest[] = [];
  const sockets: RecordingSocket[] = [];
  const client = new SteelSeriesClient({
    corePropsPaths: ["coreProps.json"],
    readTextFile: vi.fn(async () => JSON.stringify({ encryptedAddress: "127.0.0.1:5000" })),
    httpGet: vi.fn(async (request: SteelSeriesHttpRequest) => {
      requests.push(request);
      return {
        devices: [
          {
            id: 1,
            name: "mouse_one",
            display_name: "Mouse One",
            type: 1,
            deviceTypeName: "Mouse",
            connected: 1,
            genericDevicePropertiesStatus: ["batteryLevels"],
          },
          {
            id: 2,
            name: "mouse_two",
            display_name: "Mouse Two",
            type: 1,
            deviceTypeName: "Mouse",
            connected: 1,
            genericDevicePropertiesStatus: ["batteryLevels"],
          },
          {
            id: 77,
            name: "arena_7",
            display_name: "Arena 7",
            type: 8,
            deviceTypeName: "Speaker",
            connected: 1,
            genericDevicePropertiesStatus: ["firmwareVersion"],
          },
        ],
      };
    }),
    createSocket: vi.fn(() => {
      const socket = new RecordingSocket();
      sockets.push(socket);
      queueMicrotask(() => socket.emit("open"));
      return socket;
    }),
    now: () => 1_000,
  });
  const catalog = new DeviceCatalog([client]);
  const renders: unknown[] = [];
  const runtime = new BatteryRuntime(
    catalog,
    (_context, render) => renders.push(render),
    { discoveryRefreshMs: 60 * 60 * 1_000 }
  );
  const one = selected("1", "Mouse One");
  const two = selected("2", "Mouse Two");
  const settings: PersistedBatterySettings = {
    schemaVersion: 2,
    selectedDevices: [one, two],
    pollInterval: 10,
  };

  // Action startup and cached enumeration.
  runtime.appear("action", settings);
  await vi.advanceTimersByTimeAsync(0);
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  expect((await catalog.discover()).devices.map((device) => device.name)).toEqual([
    "Mouse One",
    "Mouse Two",
  ]);

  sockets[0].emit("message", Buffer.from(JSON.stringify({
    event: "device_event",
    data: { id: 1, battery_status: { charging: 0, level: 60 } },
  })));
  sockets[0].emit("message", Buffer.from(JSON.stringify({
    event: "device_event",
    data: { id: 2, battery_status: { charging: 0, level: 40 } },
  })));

  // Manual status refresh, device switch, and periodic status polling do not enumerate.
  runtime.manualRefresh("action");
  await vi.advanceTimersByTimeAsync(0);
  runtime.keyDown("action");
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(requests).toHaveLength(1);

  // Explicit PI refresh is passive GET-only.
  await runtime.refreshDevices(true);
  expect(requests).toHaveLength(2);

  // GG restart/reconnect and the next explicit discovery remain passive.
  sockets[0].emit("close");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(sockets).toHaveLength(2);
  await runtime.refreshDevices(true);
  expect(requests).toHaveLength(4);

  for (const request of requests) {
    expect(request).toMatchObject({ method: "GET", path: "/devices" });
    expect(request.path).not.toMatch(/update|firmware|configure|function/i);
  }
  expect(sockets.flatMap((socket) => socket.sent)).toEqual([]);
  expect(renders.length).toBeGreaterThan(0);
  runtime.destroy();
  client.destroy();
});
