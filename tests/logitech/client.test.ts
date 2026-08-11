import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LogitechClient,
  type LogitechSocket,
} from "../../src/logitech/client";

class FakeSocket extends EventEmitter implements LogitechSocket {
  readonly sent: Array<Record<string, unknown>> = [];
  closeCalls = 0;
  responder: ((message: Record<string, unknown>, socket: FakeSocket) => void) | null = null;

  send(data: string): void {
    const message = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(message);
    this.responder?.(message, this);
  }

  close(): void {
    this.closeCalls += 1;
  }
}

const deviceList = [
  {
    id: "dev-mouse-current",
    serialNumber: " mx-serial-1 ",
    extendedDisplayName: "G Pro Wireless",
    deviceType: "mouse",
    capabilities: { hasBatteryStatus: true },
  },
  {
    id: "dev-session-only",
    extendedDisplayName: "G915",
    deviceType: "keyboard",
    capabilities: { hasBatteryStatus: true },
  },
  {
    id: "arena-lookalike",
    extendedDisplayName: "Desktop Speakers",
    deviceType: "speaker",
    capabilities: { hasBatteryStatus: false },
  },
];

function setup() {
  const sockets: FakeSocket[] = [];
  const createSocket = vi.fn(() => {
    const socket = new FakeSocket();
    socket.responder = (message) => {
      if (message.path === "/devices/list") {
        queueMicrotask(() =>
          socket.emit(
            "message",
            Buffer.from(
              JSON.stringify({
                msgId: message.msgId,
                payload: { deviceInfos: deviceList },
              })
            )
          )
        );
      } else if (message.path === "/battery/dev-mouse-current/state") {
        queueMicrotask(() =>
          socket.emit(
            "message",
            Buffer.from(
              JSON.stringify({
                msgId: message.msgId,
                payload: { percentage: 72, charging: false },
              })
            )
          )
        );
      } else if (message.path === "/battery/dev-session-only/state") {
        queueMicrotask(() =>
          socket.emit(
            "message",
            Buffer.from(
              JSON.stringify({
                msgId: message.msgId,
                payload: { percentage: 48, charging: true },
              })
            )
          )
        );
      }
    };
    sockets.push(socket);
    queueMicrotask(() => socket.emit("open"));
    return socket;
  });
  const client = new LogitechClient({
    createSocket,
    now: () => 12_345,
    requestTimeoutMs: 100,
    connectTimeoutMs: 100,
  });
  return { client, createSocket, sockets };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Logitech G Hub provider", () => {
  it("discovers battery devices with provider-qualified exact identities", async () => {
    const { client, sockets } = setup();

    const devices = await client.discover();

    expect(devices).toEqual([
      expect.objectContaining({
        key: "logitech:serial%3AMX-SERIAL-1",
        nativeId: "serial:MX-SERIAL-1",
        providerLabel: "Logitech G Hub",
        name: "G Pro Wireless",
        physicalId: "serial:MX-SERIAL-1",
      }),
      expect.objectContaining({
        key: "logitech:session%3Adev-session-only",
        nativeId: "session:dev-session-only",
        providerLabel: "Logitech G Hub",
      }),
    ]);
    expect(sockets[0].sent.map((message) => message.path)).toEqual([
      "/devices/list",
    ]);
  });

  it("reads live status for only the exact configured endpoint without rediscovery", async () => {
    const { client, sockets } = setup();
    const [mouse] = await client.discover();

    await expect(client.readStatus(mouse)).resolves.toEqual({
      state: "connected",
      level: { kind: "percentage", value: 72 },
      charging: false,
      provider: "logitech",
      providerLabel: "Logitech G Hub",
      observedAt: 12_345,
    });
    await client.readStatus(mouse);

    expect(sockets[0].sent.map((message) => message.path)).toEqual([
      "/devices/list",
      "/battery/dev-mouse-current/state",
      "/battery/dev-mouse-current/state",
    ]);
  });

  it("never falls back to a same-name or first Logitech device", async () => {
    const { client, sockets } = setup();
    const [mouse] = await client.discover();
    const missing = {
      ...mouse,
      key: "logitech:serial%3ADIFFERENT",
      nativeId: "serial:DIFFERENT",
      name: "G Pro Wireless",
    };

    await expect(client.readStatus(missing)).resolves.toMatchObject({
      state: "unavailable",
      detail: "Logitech device not found; refresh discovery",
    });
    expect(sockets[0].sent).toHaveLength(1);
  });

  it("rejects pending requests on close and never returns cached battery as live", async () => {
    const { client, sockets } = setup();
    const [mouse] = await client.discover();
    await client.readStatus(mouse);
    sockets[0].responder = null;

    const pending = client.readStatus(mouse);
    await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(3));
    sockets[0].emit("close");

    await expect(pending).resolves.toMatchObject({
      state: "unavailable",
      level: { kind: "unavailable" },
      detail: "Logitech G Hub connection closed",
    });
  });

  it("refreshes exact endpoint mappings once after a socket reconnect", async () => {
    vi.useFakeTimers();
    const { client, sockets } = setup();
    const [mouse] = await client.discover();

    sockets[0].emit("close");
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    await vi.waitFor(() =>
      expect(sockets[1].sent.some((message) => message.path === "/devices/list")).toBe(true)
    );

    await expect(client.readStatus(mouse)).resolves.toMatchObject({
      state: "connected",
      level: { kind: "percentage", value: 72 },
    });
    expect(
      sockets.flatMap((socket) => socket.sent).filter((message) => message.path === "/devices/list")
    ).toHaveLength(2);
  });

  it("ignores stale messages and stale close handlers from a replaced socket", async () => {
    vi.useFakeTimers();
    const { client, sockets } = setup();
    await client.discover();
    const oldSocket = sockets[0];
    oldSocket.emit("close");
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    oldSocket.emit("close");
    oldSocket.emit(
      "message",
      Buffer.from(JSON.stringify({ msgId: "rr-999", payload: { percentage: 100 } }))
    );
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sockets).toHaveLength(2);
  });

  it("closes and reconnects a socket whose request times out", async () => {
    vi.useFakeTimers();
    const { client, sockets } = setup();
    const [mouse] = await client.discover();
    sockets[0].responder = null;

    const pending = client.readStatus(mouse);
    await vi.advanceTimersByTimeAsync(100);

    await expect(pending).resolves.toMatchObject({
      state: "unavailable",
      detail: "Logitech G Hub request timed out",
    });
    expect(sockets[0].closeCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets).toHaveLength(2);
  });

  it("starts a fresh discovery after invalidating an in-flight response", async () => {
    const { client, sockets } = setup();
    await client.discover();
    const socket = sockets[0];
    socket.responder = null;
    const stale = client.discover();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));

    client.invalidateDiscovery("manual refresh");
    socket.responder = (message) => {
      if (message.path === "/devices/list") {
        queueMicrotask(() => socket.emit("message", Buffer.from(JSON.stringify({
          msgId: message.msgId,
          payload: { deviceInfos: deviceList },
        }))));
      }
    };
    const current = client.discover();

    await expect(current).resolves.toHaveLength(2);
    expect(socket.sent.filter((message) => message.path === "/devices/list")).toHaveLength(3);
    const staleMessage = socket.sent[1];
    socket.emit("message", Buffer.from(JSON.stringify({
      msgId: staleMessage.msgId,
      payload: { deviceInfos: deviceList },
    })));
    await expect(stale).rejects.toThrow("generation changed");
  });
});
