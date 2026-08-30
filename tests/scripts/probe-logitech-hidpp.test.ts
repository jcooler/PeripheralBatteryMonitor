import { describe, expect, it, vi } from "vitest";

import type { HidppHandle } from "../../src/logitech/hidpp-protocol";
import {
  runDirectLogitechProbe,
  type LogitechHidAdapter,
  type LogitechHidDeviceInfo,
} from "../../src/logitech/hidpp-source";

function allowlistedDevice(
  overrides: Partial<LogitechHidDeviceInfo> = {}
): LogitechHidDeviceInfo {
  return {
    vendorId: 0x046d,
    productId: 0xc547,
    path: "\\\\?\\hid#private-receiver-path",
    serialNumber: "PRIVATE-SERIAL" as never,
    product: "G502 X PLUS Wireless Gaming Mouse",
    usagePage: 0xff00,
    usage: 0x02,
    ...overrides,
  };
}

function workingHandle(): HidppHandle {
  const replies = [
    Buffer.from([
      0x11, 0x01, 0x00, 0x18, 0x04, 0x02, 0x5a, ...Array(13).fill(0),
    ]),
    Buffer.from([
      0x11, 0x01, 0x00, 0x08, 0x05, 0x00, 0x00, ...Array(13).fill(0),
    ]),
    Buffer.from([
      0x11, 0x01, 0x05, 0x08, 73, 70, 0, ...Array(13).fill(0),
    ]),
  ];
  return {
    write: vi.fn(async (data: Buffer) => data.length),
    read: vi.fn(async () => replies.shift()),
    close: vi.fn(async () => undefined),
  };
}

describe("bounded direct Logitech probe", () => {
  it("reports only sanitized protocol, feature, and battery facts", async () => {
    const openedHandle = workingHandle();
    const adapter: LogitechHidAdapter = {
      devicesAsync: vi.fn(async () => [allowlistedDevice()]),
      open: vi.fn(async () => openedHandle),
    };

    const result = await runDirectLogitechProbe({ adapter });

    expect(result).toEqual({
      model: "G502 X PLUS Wireless Gaming Mouse",
      protocol: { major: 4, minor: 2 },
      batteryFeature: "0x1000",
      statusKind: "percentage",
      percentage: 73,
      percentageInRange: true,
      charging: false,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(
      /private|serial|hid#|receiver|deviceIndex|featureIndex|raw|\\\\\?\\/i
    );
    expect(openedHandle.close).toHaveBeenCalledTimes(1);
  });

  it("does not open unknown hardware and returns a fixed unavailable boundary", async () => {
    const adapter: LogitechHidAdapter = {
      devicesAsync: vi.fn(async () => [
        allowlistedDevice({ productId: 0xc548, path: "secret-unknown-path" }),
      ]),
      open: vi.fn(async () => workingHandle()),
    };

    await expect(runDirectLogitechProbe({ adapter })).resolves.toEqual({
      model: "G502 X PLUS Wireless Gaming Mouse",
      statusKind: "no-supported-endpoint",
    });
    expect(adapter.open).not.toHaveBeenCalled();
  });

  it("reports feature 0x1004 when the tested G502 battery fallback answers", async () => {
    const fallbackReplies = [
      Buffer.from([
        0x11, 0x01, 0x00, 0x18, 0x04, 0x02, 0x5a,
        ...Array(13).fill(0),
      ]),
      Buffer.from([
        0x11, 0x01, 0x00, 0x08, 0x00, 0x00, 0x00,
        ...Array(13).fill(0),
      ]),
      Buffer.from([
        0x11, 0x01, 0x00, 0x08, 0x06, 0x00, 0x00,
        ...Array(13).fill(0),
      ]),
      Buffer.from([
        0x11, 0x01, 0x06, 0x18, 68, 60, 0, ...Array(13).fill(0),
      ]),
    ];
    const openedHandle: HidppHandle = {
      write: vi.fn(async (data: Buffer) => data.length),
      read: vi.fn(async () => fallbackReplies.shift()),
      close: vi.fn(async () => undefined),
    };
    const adapter: LogitechHidAdapter = {
      devicesAsync: vi.fn(async () => [allowlistedDevice()]),
      open: vi.fn(async () => openedHandle),
    };

    await expect(runDirectLogitechProbe({ adapter })).resolves.toMatchObject({
      protocol: { major: 4, minor: 2 },
      batteryFeature: "0x1004",
      statusKind: "percentage",
      percentage: 68,
      charging: false,
    });
  });

  it("replaces arbitrary open failures with a fixed sanitized boundary", async () => {
    const adapter: LogitechHidAdapter = {
      devicesAsync: vi.fn(async () => [allowlistedDevice()]),
      open: vi.fn(async () => {
        throw new Error("private path \\?\\hid#secret and serial ABC");
      }),
    };

    const result = await runDirectLogitechProbe({ adapter });

    expect(result).toEqual({
      model: "G502 X PLUS Wireless Gaming Mouse",
      statusKind: "endpoint-unavailable",
    });
    expect(JSON.stringify(result)).not.toMatch(/private|secret|serial|hid#/i);
  });
});
