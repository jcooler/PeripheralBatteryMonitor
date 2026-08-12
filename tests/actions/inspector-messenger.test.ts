import { describe, expect, it, vi } from "vitest";

import { InspectorMessenger } from "../../src/actions/inspector-messenger";

describe("InspectorMessenger", () => {
  it("sends only while the requesting action still owns the visible inspector", async () => {
    let activeContextId: string | undefined = "action-a";
    const send = vi.fn(async () => undefined);
    const messenger = new InspectorMessenger({
      activeContextId: () => activeContextId,
      send,
    });

    expect(await messenger.send("action-a", { state: "loading" })).toBe(true);
    activeContextId = "action-b";
    expect(await messenger.send("action-a", { state: "success" })).toBe(false);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ state: "loading" });
  });

  it("reports a closed inspector without leaking the transport error", async () => {
    const messenger = new InspectorMessenger({
      activeContextId: () => "action-a",
      send: vi.fn(async () => {
        throw new Error("inspector closed");
      }),
    });

    await expect(
      messenger.send("action-a", { state: "loading" })
    ).resolves.toBe(false);
  });
});
