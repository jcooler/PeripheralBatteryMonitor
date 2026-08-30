import { spawn as nodeSpawn } from "node:child_process";

export interface SpawnedProcess {
  readonly stdout: {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  };
  readonly stderr: {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  };
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(): boolean;
}

export type SpawnProcess = (
  command: string,
  args: string[],
  options: { windowsHide: boolean }
) => SpawnedProcess;

export interface PowerShellRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  spawn?: SpawnProcess;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/** Runs a caller-owned read-only PowerShell script with bounded lifetime/output. */
export function runPowerShell(
  script: string,
  options: PowerShellRunOptions = {}
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const signal = options.signal;
  const spawn = options.spawn ?? (nodeSpawn as unknown as SpawnProcess);

  if (signal?.aborted) return Promise.reject(createAbortError());

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let killed = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
      ],
      { windowsHide: true }
    );

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(Buffer.concat(stdout).toString("utf8"));
    };

    const killAndReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (!killed) {
        killed = true;
        try {
          child.kill();
        } catch {
          // The requested termination is still considered complete.
        }
      }
      reject(error);
    };

    const onAbort = (): void => killAndReject(createAbortError());
    const capture = (target: "stdout" | "stderr", chunk: Buffer | string): void => {
      if (settled) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += value.byteLength;
      if (outputBytes > maxOutputBytes) {
        killAndReject(
          new Error(`PowerShell output exceeded ${maxOutputBytes} bytes`)
        );
        return;
      }
      if (target === "stdout") stdout.push(value);
      else stderr.push(value);
    };

    timer = setTimeout(
      () =>
        killAndReject(new Error(`PowerShell timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    child.stdout.on("data", (chunk) => capture("stdout", chunk));
    child.stderr.on("data", (chunk) => capture("stderr", chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code, closeSignal) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      finish(
        new Error(
          `PowerShell exited with ${code ?? closeSignal ?? "unknown status"}${
            detail ? `: ${detail}` : ""
          }`
        )
      );
    });

  });
}

function createAbortError(): Error {
  const error = new Error("PowerShell operation aborted");
  error.name = "AbortError";
  return error;
}
