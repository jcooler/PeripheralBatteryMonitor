import { describe, expect, it, vi } from "vitest";

import {
  HidppProtocolClient,
  buildBatteryStatusRequest,
  buildUnifiedBatteryStatusRequest,
  buildRootFeatureRequest,
  buildRootProtocolVersionRequest,
  type HidppHandle,
} from "../../src/logitech/hidpp-protocol";

const protocolReply = Buffer.from([
  0x11, 0x01, 0x00, 0x18, 0x04, 0x02, 0x5a, ...Array(13).fill(0),
]);
const featureReply = Buffer.from([
  0x11, 0x01, 0x00, 0x08, 0x05, 0x00, 0x00, ...Array(13).fill(0),
]);
const batteryReply = Buffer.from([
  0x11, 0x01, 0x05, 0x08, 73, 70, 0, ...Array(13).fill(0),
]);

function fakeHandle(replies: Array<Buffer | undefined>): HidppHandle {
  return {
    write: vi.fn(async (data: Buffer) => data.length),
    read: vi.fn(async () => replies.shift()),
    close: vi.fn(async () => undefined),
  };
}

describe("HID++ allowlisted request packets", () => {
  it("pins the report ID, device index, function nibble, software ID, ping byte, and length needed for protocol-version correlation", () => {
    expect(buildRootProtocolVersionRequest(1, 8)).toEqual(
      Buffer.from([
        0x11, 0x01, 0x00, 0x18, 0x00, 0x00, 0x5a,
        ...Array(13).fill(0),
      ])
    );
  });

  it("pins the root feature index, function nibble, software ID, feature bytes, and length required by the battery-feature allowlist", () => {
    expect(buildRootFeatureRequest(1, 8, 0x1000)).toEqual(
      Buffer.from([
        0x11, 0x01, 0x00, 0x08, 0x10, 0x00, ...Array(14).fill(0),
      ])
    );
  });

  it("pins the resolved feature index, status function, software ID, and length so no other HID++ operation can be sent", () => {
    expect(buildBatteryStatusRequest(1, 8, 0x05)).toEqual(
      Buffer.from([0x11, 0x01, 0x05, 0x08, ...Array(16).fill(0)])
    );
  });

  it("pins feature 0x1004 lookup and its status function 1 so the additional battery-only fallback cannot become a generic request", () => {
    expect(buildRootFeatureRequest(1, 8, 0x1004)).toEqual(
      Buffer.from([
        0x11, 0x01, 0x00, 0x08, 0x10, 0x04, ...Array(14).fill(0),
      ])
    );
    expect(buildUnifiedBatteryStatusRequest(1, 8, 0x06)).toEqual(
      Buffer.from([0x11, 0x01, 0x06, 0x18, ...Array(16).fill(0)])
    );
  });
});

describe("HidppProtocolClient correlated responses", () => {
  it("parses a correlated HID++ 2.0 protocol-version reply", async () => {
    const handle = fakeHandle([protocolReply]);
    const client = new HidppProtocolClient(handle);

    await expect(client.getProtocolVersion(1)).resolves.toEqual({
      major: 4,
      minor: 2,
    });
  });

  it("resolves the Battery Unified Level Status feature index", async () => {
    const client = new HidppProtocolClient(fakeHandle([featureReply]));

    await expect(client.getFeature(1, 0x1000)).resolves.toEqual({
      index: 0x05,
      type: 0,
      version: 0,
    });
  });

  it("maps a valid discharging battery reply without inventing precision", async () => {
    const client = new HidppProtocolClient(fakeHandle([batteryReply]));

    await expect(client.getBatteryStatus(1, 0x05)).resolves.toEqual({
      percentage: 73,
      nextLevel: 70,
      charging: false,
      status: 0,
    });
  });

  it("parses feature 0x1004 function 1 with the same validated percentage and charging semantics", async () => {
    const reply = Buffer.from([
      0x11, 0x01, 0x06, 0x18, 68, 60, 1, ...Array(13).fill(0),
    ]);
    const client = new HidppProtocolClient(fakeHandle([reply]));

    await expect(client.getUnifiedBatteryStatus(1, 0x06)).resolves.toEqual({
      percentage: 68,
      nextLevel: 60,
      charging: true,
      status: 1,
    });
  });

  it.each([1, 2, 4])("maps charging status %i to charging", async (status) => {
    const reply = Buffer.from(batteryReply);
    reply[6] = status;
    const client = new HidppProtocolClient(fakeHandle([reply]));

    await expect(client.getBatteryStatus(1, 0x05)).resolves.toMatchObject({
      charging: true,
      status,
    });
  });

  it("maps complete status 3 to not actively charging", async () => {
    const reply = Buffer.from(batteryReply);
    reply[6] = 3;
    const client = new HidppProtocolClient(fakeHandle([reply]));

    await expect(client.getBatteryStatus(1, 0x05)).resolves.toMatchObject({
      charging: false,
      status: 3,
    });
  });

  it.each([5, 6, 7, 8])("rejects unavailable battery status %i", async (status) => {
    const reply = Buffer.from(batteryReply);
    reply[6] = status;
    const client = new HidppProtocolClient(fakeHandle([reply]));

    await expect(client.getBatteryStatus(1, 0x05)).rejects.toThrow(
      "HID++ battery status is unavailable"
    );
  });

  it.each([-1, 101])("rejects invalid battery percentage %i", async (value) => {
    const reply = Buffer.from(batteryReply);
    reply[4] = value < 0 ? 0xff : value;
    const client = new HidppProtocolClient(fakeHandle([reply]));

    await expect(client.getBatteryStatus(1, 0x05)).rejects.toThrow(
      "HID++ battery percentage is invalid"
    );
  });

  it("rejects a missing battery feature instead of sending feature index zero", async () => {
    const missing = Buffer.from(featureReply);
    missing[4] = 0;
    const client = new HidppProtocolClient(fakeHandle([missing]));

    await expect(client.getFeature(1, 0x1000)).rejects.toThrow(
      "HID++ battery feature is unsupported"
    );
  });

  it("surfaces a correlated HID++ error report", async () => {
    const errorReply = Buffer.from([
      0x11, 0x01, 0xff, 0x05, 0x08, 0x09, ...Array(14).fill(0),
    ]);
    const client = new HidppProtocolClient(fakeHandle([errorReply]));

    await expect(client.getBatteryStatus(1, 0x05)).rejects.toThrow(
      "HID++ request failed with error 9"
    );
  });

  it.each([
    ["software ID", 3, 0x09],
    ["device index", 1, 0x02],
    ["feature index", 2, 0x06],
    ["function", 3, 0x18],
  ])("ignores a reply with mismatched %s", async (_name, offset, value) => {
    const unrelated = Buffer.from(batteryReply);
    unrelated[offset as number] = value as number;
    const client = new HidppProtocolClient(
      fakeHandle([unrelated, batteryReply])
    );

    await expect(client.getBatteryStatus(1, 0x05)).resolves.toMatchObject({
      percentage: 73,
    });
  });

  it.each([
    ["short", Buffer.from([0x11, 0x01, 0x05, 0x08, 73])],
    ["wrong report ID", Buffer.from([0x10, ...batteryReply.subarray(1)])],
    ["oversized", Buffer.concat([batteryReply, Buffer.from([0])])],
  ])("ignores a %s report before the correlated reply", async (_name, report) => {
    const client = new HidppProtocolClient(fakeHandle([report, batteryReply]));

    await expect(client.getBatteryStatus(1, 0x05)).resolves.toMatchObject({
      percentage: 73,
    });
  });

  it("fails on read timeout after unrelated reports", async () => {
    const unrelated = Buffer.from(batteryReply);
    unrelated[1] = 2;
    const client = new HidppProtocolClient(fakeHandle([unrelated, undefined]));

    await expect(client.getBatteryStatus(1, 0x05)).rejects.toThrow(
      "HID++ request timed out"
    );
  });

  it("retries the same allowlisted read-only packet once after timeout", async () => {
    const handle = fakeHandle([undefined, batteryReply]);
    const client = new HidppProtocolClient(handle);

    await expect(client.getBatteryStatus(1, 0x05)).resolves.toMatchObject({
      percentage: 73,
    });
    expect(handle.write).toHaveBeenCalledTimes(2);
    expect(vi.mocked(handle.write).mock.calls[1][0]).toEqual(
      buildBatteryStatusRequest(1, 8, 0x05)
    );
  });

  it("aborts before writing when the signal is already cancelled", async () => {
    const handle = fakeHandle([batteryReply]);
    const client = new HidppProtocolClient(handle);
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.getBatteryStatus(1, 0x05, controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(handle.write).not.toHaveBeenCalled();
  });

  it("aborts a read that never settles", async () => {
    const handle = fakeHandle([]);
    vi.mocked(handle.read).mockImplementationOnce(() => new Promise(() => {}));
    const client = new HidppProtocolClient(handle, { requestTimeoutMs: 1_000 });
    const controller = new AbortController();
    const pending = client.getBatteryStatus(1, 0x05, controller.signal);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
