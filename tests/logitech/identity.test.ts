import { describe, expect, it } from "vitest";

import {
  identifyLogitechDevices,
  makeLogitechModelIdentity,
  normalizeIdentityText,
} from "../../src/logitech/identity";
import type { GHubDevice } from "../../src/logitech/ghub-client";

function device(overrides: Partial<GHubDevice> = {}): GHubDevice {
  return {
    id: "dev00000001",
    extendedDisplayName: "G502 X Plus",
    deviceType: "mouse",
    capabilities: { hasBatteryStatus: true },
    ...overrides,
  };
}

describe("Logitech persistent identities", () => {
  it("builds the direct G502 model identity with the same normalization as G Hub", () => {
    expect(
      makeLogitechModelIdentity(
        " G502 X PLUS Wireless   Gaming Mouse ",
        "mouse"
      )
    ).toEqual({
      nativeId: "model:g502 x plus wireless gaming mouse|mouse",
      physicalId:
        "logitech-model:model:g502 x plus wireless gaming mouse|mouse",
    });
  });

  it("normalizes identity text with trim, NFC, whitespace collapse, and locale-independent lowercase", () => {
    expect(normalizeIdentityText("  G502\u00a0X   PLUS  ")).toBe("g502 x plus");
    expect(normalizeIdentityText("  Cafe\u0301\tPRO  ")).toBe("caf\u00e9 pro");
    expect(normalizeIdentityText("CAF\u00c9\nPRO")).toBe("caf\u00e9 pro");
  });

  it("prefers a normalized serial over a model fingerprint", () => {
    const result = identifyLogitechDevices([
      device({ serialNumber: "  MX-KEYS\u00a0SERIAL  " }),
    ]);

    expect(result).toEqual({
      candidates: [
        expect.objectContaining({
          nativeId: "serial:mx-keys serial",
          physicalId: "serial:mx-keys serial",
          kind: "serial",
        }),
      ],
      ambiguousModelFingerprints: [],
    });
  });

  it("uses a mapped-type model fingerprint for one serial-less G502 X Plus", () => {
    const result = identifyLogitechDevices([
      device({ extendedDisplayName: "  G502 X   Plus ", deviceType: "GAMING-MOUSE" }),
    ]);

    expect(result).toEqual({
      candidates: [
        expect.objectContaining({
          nativeId: "model:g502 x plus|mouse",
          physicalId: "logitech-model:model:g502 x plus|mouse",
          kind: "model",
        }),
      ],
      ambiguousModelFingerprints: [],
    });
  });

  it("omits a serial-less endpoint without a usable display name", () => {
    const result = identifyLogitechDevices([
      device({ extendedDisplayName: "   ", deviceType: "mouse" }),
    ]);

    expect(result).toEqual({
      candidates: [],
      ambiguousModelFingerprints: [],
    });
  });

  it("omits two identical serial-less models and marks their fingerprint ambiguous", () => {
    const result = identifyLogitechDevices([
      device({ id: "dev00000001" }),
      device({ id: "dev00000006" }),
    ]);

    expect(result).toEqual({
      candidates: [],
      ambiguousModelFingerprints: ["model:g502 x plus|mouse"],
    });
  });

  it("never collapses same-type, substring-similar, or different complete model names", () => {
    const result = identifyLogitechDevices([
      device({ id: "dev-a", extendedDisplayName: "G502 X Plus" }),
      device({ id: "dev-b", extendedDisplayName: "G502 X Plus Lightspeed" }),
      device({ id: "dev-c", extendedDisplayName: "G Pro X Superlight" }),
    ]);

    expect(result.candidates.map((candidate) => candidate.nativeId)).toEqual([
      "model:g502 x plus|mouse",
      "model:g502 x plus lightspeed|mouse",
      "model:g pro x superlight|mouse",
    ]);
    expect(result.ambiguousModelFingerprints).toEqual([]);
  });

  it("filters invalid and non-battery endpoints before identifying devices", () => {
    const result = identifyLogitechDevices([
      device({ id: "", extendedDisplayName: "Invalid endpoint" }),
      device({
        id: "dev-speaker",
        extendedDisplayName: "Desktop Speakers",
        deviceType: "speaker",
        capabilities: { hasBatteryStatus: false },
      }),
      device({ id: "dev-valid", serial: "SERIAL-1" }),
    ]);

    expect(result.candidates.map((candidate) => candidate.nativeId)).toEqual([
      "serial:serial-1",
    ]);
  });
});
