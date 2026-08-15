import { describe, expect, it } from "vitest";

import { createActiveProviders } from "../../src/actions/provider-set";

describe("active battery providers", () => {
  it("omits session-slot-only XInput identities from selectable devices", () => {
    const providers = createActiveProviders();

    expect(providers.map((provider) => provider.id)).toEqual([
      "hid",
      "windows",
      "windows-gamepad",
      "logitech",
      "steelseries",
    ]);
    expect(providers.some((provider) => provider.id === "xinput")).toBe(false);
  });
});
