import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LogitechClient,
  type GHubDevice,
  type LogitechDiagnosticSink,
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

const activeClients = new Set<LogitechClient>();

function track(client: LogitechClient): LogitechClient {
  activeClients.add(client);
  return client;
}

function setup(
  reportedDevices: readonly GHubDevice[] = deviceList,
  diagnosticSink?: LogitechDiagnosticSink
) {
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
                payload: { deviceInfos: reportedDevices },
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
  const client = track(new LogitechClient({
    createSocket,
    now: () => 12_345,
    requestTimeoutMs: 100,
    connectTimeoutMs: 100,
    diagnosticSink,
  }));
  return { client, createSocket, sockets };
}

afterEach(() => {
  for (const client of activeClients) client.destroy();
  activeClients.clear();
  vi.useRealTimers();
});

describe("Logitech G Hub provider", () => {
  it("discovers battery devices with provider-qualified exact identities", async () => {
    const { client, sockets } = setup();

    const devices = await client.discover();

    expect(devices).toEqual([
      expect.objectContaining({
        key: "logitech:serial%3Amx-serial-1",
        nativeId: "serial:mx-serial-1",
        providerLabel: "Logitech G Hub",
        name: "G Pro Wireless",
        physicalId: "serial:mx-serial-1",
      }),
      expect.objectContaining({
        key: "logitech:model%3Ag915%7Ckeyboard",
        nativeId: "model:g915|keyboard",
        providerLabel: "Logitech G Hub",
        physicalId: "logitech-model:model:g915|keyboard",
      }),
    ]);
    expect(sockets[0].sent.map((message) => message.path)).toEqual([
      "/devices/list",
    ]);
  });

  it("does not surface an unnamed serial-less endpoint as a selectable Logitech device", async () => {
    const { client, sockets } = setup([
      {
        id: "dev-unnamed",
        extendedDisplayName: "   ",
        deviceType: "mouse",
        capabilities: { hasBatteryStatus: true },
      },
    ]);

    await expect(client.discover()).resolves.toEqual([]);
    expect(sockets[0].sent.map((message) => message.path)).toEqual([
      "/devices/list",
    ]);
  });

  it("keeps MX Keys and G502 X Plus identities while a refreshed G502 endpoint changes", async () => {
    let reportedDevices = [
      {
        id: "dev-mx-keys-06",
        serialNumber: " MX-KEYS-SERIAL ",
        extendedDisplayName: "MX Keys",
        deviceType: "keyboard",
        capabilities: { hasBatteryStatus: true },
      },
      {
        id: "dev00000006",
        extendedDisplayName: "G502 X Plus",
        deviceType: "mouse",
        capabilities: { hasBatteryStatus: true },
      },
    ];
    const sockets: FakeSocket[] = [];
    const client = new LogitechClient({
      createSocket: () => {
        const socket = new FakeSocket();
        socket.responder = (message) => {
          const payload =
            message.path === "/devices/list"
              ? { deviceInfos: reportedDevices }
              : { percentage: 65, charging: false };
          queueMicrotask(() =>
            socket.emit(
              "message",
              Buffer.from(JSON.stringify({ msgId: message.msgId, payload }))
            )
          );
        };
        sockets.push(socket);
        queueMicrotask(() => socket.emit("open"));
        return socket;
      },
      now: () => 12_345,
      requestTimeoutMs: 100,
      connectTimeoutMs: 100,
    });

    const initial = await client.discover();
    const initialMxKeys = initial.find((device) => device.name === "MX Keys");
    const initialG502 = initial.find((device) => device.name === "G502 X Plus");
    expect(initialMxKeys?.nativeId).toBe("serial:mx-keys-serial");
    expect(initialG502?.nativeId).toBe("model:g502 x plus|mouse");
    await client.readStatus(initialG502!);

    reportedDevices = [
      {
        ...reportedDevices[0],
      },
      {
        ...reportedDevices[1],
        id: "dev00000001",
      },
    ];
    client.invalidateDiscovery("G Hub refreshed its endpoint ids");
    const refreshed = await client.discover();
    const refreshedMxKeys = refreshed.find((device) => device.name === "MX Keys");
    const refreshedG502 = refreshed.find((device) => device.name === "G502 X Plus");

    expect(refreshedMxKeys?.nativeId).toBe(initialMxKeys?.nativeId);
    expect(refreshedG502?.nativeId).toBe(initialG502?.nativeId);
    expect(refreshedG502?.transientNativeIds).toEqual([
      "session:dev00000001",
    ]);
    expect(client.discoveryNotices()).toEqual([
      {
        provider: "logitech",
        kind: "recovered",
        message: "G502 X Plus reconnected through G Hub",
        deviceKey: refreshedG502?.key,
      },
    ]);
    expect(JSON.stringify(client.discoveryNotices())).not.toContain(
      "dev00000006"
    );
    expect(JSON.stringify(client.discoveryNotices())).not.toContain(
      "dev00000001"
    );
    await client.readStatus(refreshedG502!);
    expect(sockets[0].sent.map((message) => message.path)).toEqual([
      "/devices/list",
      "/battery/dev00000006/state",
      "/devices/list",
      "/battery/dev00000001/state",
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

  it("returns unavailable legacy data when the compatibility endpoint is not a current identity candidate", async () => {
    const { client, sockets } = setup();
    await client.discover();

    await expect(
      client.getBatteryInfo({
        id: "untracked-endpoint",
        extendedDisplayName: "G915",
        deviceType: "keyboard",
        capabilities: { hasBatteryStatus: true },
      })
    ).resolves.toMatchObject({
      deviceName: "G915",
      deviceType: "Keyboard",
      batteryLevel: -1,
      isCharging: false,
      isConnected: false,
    });
    expect(sockets[0].sent.map((message) => message.path)).toEqual([
      "/devices/list",
    ]);
  });

  it("reads battery data through a current compatibility identity candidate", async () => {
    const { client } = setup();
    const devices = await client.getDevices();
    const mouse = devices.find((device) => device.extendedDisplayName === "G Pro Wireless");

    await expect(client.getBatteryInfo(mouse!)).resolves.toMatchObject({
      deviceName: "G Pro Wireless",
      deviceType: "Mouse",
      batteryLevel: 72,
      isCharging: false,
      isConnected: true,
    });
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

    await expect(client.readStatus(mouse)).resolves.toMatchObject({
      state: "unavailable",
      detail: "Logitech device not found; refresh discovery",
    });
    expect(
      sockets.flatMap((socket) => socket.sent).filter(
        (message) => typeof message.path === "string" && message.path.startsWith("/battery/")
      )
    ).toHaveLength(2);
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

  it("ignores a stale discovery response from the socket generation that was lost", async () => {
    vi.useFakeTimers();
    const { client, sockets } = setup();
    await client.discover();
    const oldSocket = sockets[0];
    oldSocket.responder = null;
    const staleDiscovery = client.discover();
    await vi.waitFor(() =>
      expect(oldSocket.sent.filter((message) => message.path === "/devices/list")).toHaveLength(2)
    );
    const staleMessage = oldSocket.sent.at(-1)!;

    oldSocket.emit("close");
    await expect(staleDiscovery).rejects.toThrow("connection closed");
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    await vi.waitFor(() =>
      expect(sockets[1].sent.some((message) => message.path === "/devices/list")).toBe(true)
    );
    oldSocket.emit("message", Buffer.from(JSON.stringify({
      msgId: staleMessage.msgId,
      payload: {
        deviceInfos: [{
          id: "dev00000099",
          extendedDisplayName: "Stale Mouse",
          deviceType: "mouse",
          capabilities: { hasBatteryStatus: true },
        }],
      },
    })));

    const recovered = await client.discover();
    expect(recovered.map((device) => device.name)).toEqual([
      "G Pro Wireless",
      "G915",
    ]);
  });

  it("keeps endpoints empty after reconnect discovery fails and retries discovery while open", async () => {
    vi.useFakeTimers();
    let discoveryAttempt = 0;
    const sockets: FakeSocket[] = [];
    const currentDevices: GHubDevice[] = [{
      id: "dev00000041",
      extendedDisplayName: "G502 X Plus",
      deviceType: "mouse",
      capabilities: { hasBatteryStatus: true },
    }];
    const client = track(new LogitechClient({
      createSocket: () => {
        const socket = new FakeSocket();
        socket.responder = (message) => {
          if (message.path === "/devices/list") {
            discoveryAttempt += 1;
            const response = discoveryAttempt === 2
              ? { msgId: message.msgId, error: "temporary G Hub failure" }
              : { msgId: message.msgId, payload: { deviceInfos: currentDevices } };
            queueMicrotask(() =>
              socket.emit("message", Buffer.from(JSON.stringify(response)))
            );
          } else if (message.path === "/battery/dev00000042/state") {
            queueMicrotask(() => socket.emit("message", Buffer.from(JSON.stringify({
              msgId: message.msgId,
              payload: { percentage: 61, charging: false },
            }))));
          }
        };
        sockets.push(socket);
        queueMicrotask(() => socket.emit("open"));
        return socket;
      },
      requestTimeoutMs: 100,
      connectTimeoutMs: 100,
    }));
    const [persistent] = await client.discover();

    currentDevices[0] = { ...currentDevices[0], id: "dev00000042" };
    sockets[0].emit("close");
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(discoveryAttempt).toBe(2));
    await expect(client.readStatus(persistent)).resolves.toMatchObject({
      state: "unavailable",
      detail: "Logitech device not found; refresh discovery",
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(discoveryAttempt).toBe(3));
    await expect(client.readStatus(persistent)).resolves.toMatchObject({
      state: "connected",
      level: { kind: "percentage", value: 61 },
    });
    expect(sockets).toHaveLength(2);
  });

  it("reports ambiguous model discovery without exposing endpoint diagnostics", async () => {
    const messages: string[] = [];
    const diagnosticSink: LogitechDiagnosticSink = {
      info: (message) => messages.push(message),
      warn: (message) => messages.push(message),
    };
    const { client } = setup([
      {
        id: "dev00000051",
        extendedDisplayName: "G502 X Plus",
        deviceType: "mouse",
        capabilities: { hasBatteryStatus: true },
      },
      {
        id: "dev00000052",
        extendedDisplayName: "G502 X Plus",
        deviceType: "mouse",
        capabilities: { hasBatteryStatus: true },
      },
    ], diagnosticSink);

    await expect(client.discover()).resolves.toEqual([]);
    const notices = client.discoveryNotices();
    expect(Object.isFrozen(notices)).toBe(true);
    expect(notices).toEqual([{
      provider: "logitech",
      kind: "ambiguous",
      message: "Two Logitech devices share the same model name; neither was selected automatically",
    }]);
    expect(messages.join("\n")).toContain("Logitech G Hub");
    expect(messages.join("\n")).toContain("Two Logitech devices share the same model name");
    expect(messages.join("\n")).not.toMatch(/dev0000005[12]|serial|hid\\|deviceInfos|\{.*\}|\n\s+at /i);
  });

  it("logs a sanitized failed-read reason with the model name", async () => {
    const warnings: string[] = [];
    const { client, sockets } = setup([{
      id: "dev00000073",
      serialNumber: "SERIAL-SECRET-73",
      extendedDisplayName: "G502 X Plus",
      deviceType: "mouse",
      capabilities: { hasBatteryStatus: true },
    }], {
      info: () => undefined,
      warn: (message) => warnings.push(message),
    });
    const [mouse] = await client.discover();
    sockets[0].responder = (message) => queueMicrotask(() =>
      sockets[0].emit("message", Buffer.from(JSON.stringify({
        msgId: message.msgId,
        error: {
          endpoint: "dev00000073",
          serial: "SERIAL-SECRET-73",
          hidPath: "HID\\VID_046D&PID_C539",
          payload: { verb: "GET", path: "/battery/dev00000073/state" },
          stack: "Error: private\n    at secret.ts:1:1",
        },
      })))
    );

    await expect(client.readStatus(mouse)).resolves.toMatchObject({
      state: "unavailable",
      detail: "Logitech G Hub request failed",
    });
    expect(warnings.join("\n")).toContain("G502 X Plus");
    expect(warnings.join("\n")).toContain("request failed");
    expect(warnings.join("\n")).not.toMatch(
      /SERIAL-SECRET-73|dev00000073|HID\\|battery\/|\{.*\}|\n\s+at /i
    );
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
