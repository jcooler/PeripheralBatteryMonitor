import { describe, expect, it } from "vitest";

import { parseDualSenseInputReport } from "../../src/hid/report";

function usbReport(status: number): Buffer {
  const report = Buffer.alloc(64);
  report[0] = 0x01;
  report[53] = status;
  return report;
}

function bluetoothReport(status: number): Buffer {
  const report = Buffer.alloc(78);
  report[0] = 0x31;
  report[54] = status;
  const checksum = inputCrc32(report.subarray(0, 74));
  report.writeUInt32LE(checksum, 74);
  return report;
}

// Independent test fixture implementation of Linux hid-playstation's input CRC.
function inputCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  crc = updateCrc32(crc, Uint8Array.of(0xa1));
  crc = updateCrc32(crc, data);
  return (~crc) >>> 0;
}

function updateCrc32(initial: number, data: Uint8Array): number {
  let crc = initial >>> 0;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = ((crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)) >>> 0;
    }
  }
  return crc;
}

describe("parseDualSenseInputReport", () => {
  it.each([
    [0x00, 0, false],
    [0x05, 50, false],
    [0x0a, 100, false],
    [0x14, 40, true],
    [0x20, 100, false],
  ])("parses supported USB battery status %#x", (status, value, charging) => {
    expect(parseDualSenseInputReport(usbReport(status))).toEqual({
      ok: true,
      percentage: value,
      charging,
    });
  });

  it("parses a full Bluetooth report only when its input CRC is valid", () => {
    expect(parseDualSenseInputReport(bluetoothReport(0x17))).toEqual({
      ok: true,
      percentage: 70,
      charging: true,
    });
  });

  it.each([
    [Buffer.alloc(63), "Unsupported DualSense input report"],
    [Buffer.concat([Buffer.of(0x02), Buffer.alloc(63)]), "Unsupported DualSense input report"],
    [usbReport(0x0b), "Invalid DualSense battery capacity"],
    [usbReport(0xa5), "DualSense reports a charging fault"],
    [usbReport(0x35), "Unsupported DualSense charging state"],
  ])("rejects malformed or unreliable status without a value", (report, error) => {
    expect(parseDualSenseInputReport(report)).toEqual({ ok: false, error });
  });

  it("rejects a Bluetooth report whose CRC is corrupt", () => {
    const report = bluetoothReport(0x17);
    report[20] ^= 0xff;

    expect(parseDualSenseInputReport(report)).toEqual({
      ok: false,
      error: "Invalid DualSense Bluetooth input checksum",
    });
  });
});
