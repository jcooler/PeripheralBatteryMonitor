import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runPowerShell,
  type SpawnProcess,
  type SpawnedProcess,
} from "../../src/process/powershell";

class FakeProcess extends EventEmitter implements SpawnedProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runPowerShell", () => {
  it("returns stdout only after a successful process exit", async () => {
    const child = new FakeProcess();
    const spawn = vi.fn<SpawnProcess>(() => child);

    const result = runPowerShell("Get-CimInstance Win32_PnPEntity", {
      spawn,
      timeoutMs: 1_000,
    });

    child.stdout.write('[{"name":"Mouse"}]');
    child.emit("close", 0, null);

    await expect(result).resolves.toBe('[{"name":"Mouse"}]');
    expect(spawn).toHaveBeenCalledWith(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_PnPEntity",
      ],
      { windowsHide: true }
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("kills a timed-out process exactly once even when close arrives later", async () => {
    vi.useFakeTimers();
    const child = new FakeProcess();

    const result = runPowerShell("slow command", {
      spawn: () => child,
      timeoutMs: 50,
    });
    const rejection = expect(result).rejects.toThrow(
      "PowerShell timed out after 50ms"
    );

    await vi.advanceTimersByTimeAsync(50);
    child.emit("close", 1, null);
    await vi.advanceTimersByTimeAsync(500);

    await rejection;
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("kills an aborted process exactly once and rejects with AbortError", async () => {
    const child = new FakeProcess();
    const controller = new AbortController();

    const result = runPowerShell("long command", {
      spawn: () => child,
      signal: controller.signal,
      timeoutMs: 1_000,
    });
    const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" });

    controller.abort();
    controller.abort();
    child.emit("close", 1, null);

    await rejection;
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("does not spawn when the signal was already aborted", async () => {
    const spawn = vi.fn<SpawnProcess>();
    const controller = new AbortController();
    controller.abort();

    await expect(
      runPowerShell("never runs", { spawn, signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("observes an abort that happens while the process is being spawned", async () => {
    vi.useFakeTimers();
    const child = new FakeProcess();
    const controller = new AbortController();

    const result = runPowerShell("race", {
      signal: controller.signal,
      timeoutMs: 50,
      spawn: () => {
        controller.abort();
        return child;
      },
    });
    const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" });

    await vi.advanceTimersByTimeAsync(50);

    await rejection;
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("bounds captured output and kills an overflowing process exactly once", async () => {
    const child = new FakeProcess();

    const result = runPowerShell("noisy command", {
      spawn: () => child,
      maxOutputBytes: 4,
    });
    const rejection = expect(result).rejects.toThrow(
      "PowerShell output exceeded 4 bytes"
    );

    child.stdout.write("12345");
    child.stderr.write("another overflow");
    child.emit("close", 1, null);

    await rejection;
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("handles overflowing output delivered while listeners are registered", async () => {
    const child = new FakeProcess();
    Object.defineProperty(child, "stdout", {
      value: {
        on: (_event: "data", listener: (chunk: string) => void) => {
          listener("12345");
        },
      },
    });

    const result = runPowerShell("already noisy", {
      spawn: () => child,
      maxOutputBytes: 4,
    });

    await expect(result).rejects.toThrow("PowerShell output exceeded 4 bytes");
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("preserves UTF-8 text split across stdout chunks", async () => {
    const child = new FakeProcess();
    const encoded = Buffer.from("Mäuse");

    const result = runPowerShell("unicode", { spawn: () => child });
    child.stdout.write(encoded.subarray(0, 2));
    child.stdout.write(encoded.subarray(2));
    child.emit("close", 0, null);

    await expect(result).resolves.toBe("Mäuse");
  });
});
