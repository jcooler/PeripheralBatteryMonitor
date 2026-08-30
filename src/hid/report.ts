export type DualSenseReportResult =
  | { ok: true; percentage: number; charging: boolean }
  | { ok: false; error: string };

const USB_REPORT_ID = 0x01;
const USB_REPORT_SIZE = 64;
const USB_STATUS_OFFSET = 53;
const BLUETOOTH_REPORT_ID = 0x31;
const BLUETOOTH_REPORT_SIZE = 78;
const BLUETOOTH_STATUS_OFFSET = 54;
const BLUETOOTH_CHECKSUM_OFFSET = 74;
const INPUT_CRC_SEED = 0xa1;

/**
 * Parses only the complete input report layouts shared by DualSense and
 * DualSense Edge. Short compatibility reports and reports with a bad checksum
 * are intentionally rejected rather than treated as battery data.
 */
export function parseDualSenseInputReport(
  report: Uint8Array
): DualSenseReportResult {
  let status: number;

  if (report.length === USB_REPORT_SIZE && report[0] === USB_REPORT_ID) {
    status = report[USB_STATUS_OFFSET] ?? 0xff;
  } else if (
    report.length === BLUETOOTH_REPORT_SIZE &&
    report[0] === BLUETOOTH_REPORT_ID
  ) {
    const expected = readUInt32LE(report, BLUETOOTH_CHECKSUM_OFFSET);
    const actual = inputCrc32(report.subarray(0, BLUETOOTH_CHECKSUM_OFFSET));
    if (expected !== actual) {
      return {
        ok: false,
        error: "Invalid DualSense Bluetooth input checksum",
      };
    }
    status = report[BLUETOOTH_STATUS_OFFSET] ?? 0xff;
  } else {
    return { ok: false, error: "Unsupported DualSense input report" };
  }

  const capacity = status & 0x0f;
  const chargingState = (status >>> 4) & 0x0f;
  if (capacity > 10) {
    return { ok: false, error: "Invalid DualSense battery capacity" };
  }

  if (chargingState === 0x0 || chargingState === 0x1) {
    return {
      ok: true,
      // The device reports a decile. Do not add an invented midpoint.
      percentage: capacity * 10,
      charging: chargingState === 0x1,
    };
  }

  if (chargingState === 0x2) {
    return { ok: true, percentage: 100, charging: false };
  }

  if (
    chargingState === 0x0a ||
    chargingState === 0x0b ||
    chargingState === 0x0f
  ) {
    return { ok: false, error: "DualSense reports a charging fault" };
  }

  return { ok: false, error: "Unsupported DualSense charging state" };
}

function inputCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  crc = updateCrc32(crc, Uint8Array.of(INPUT_CRC_SEED));
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

function readUInt32LE(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] ?? 0) |
      ((data[offset + 1] ?? 0) << 8) |
      ((data[offset + 2] ?? 0) << 16) |
      ((data[offset + 3] ?? 0) << 24)) >>>
    0
  );
}
