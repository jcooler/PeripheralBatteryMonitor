export interface LinkedAbortController {
  controller: AbortController;
  unlink(): void;
}

/** Creates an owned controller that mirrors, but never mutates, a caller signal. */
export function createLinkedAbortController(
  signal?: AbortSignal
): LinkedAbortController {
  const controller = new AbortController();
  if (!signal) return { controller, unlink: () => undefined };

  const forward = (): void => controller.abort(signal.reason);
  if (signal.aborted) forward();
  else signal.addEventListener("abort", forward, { once: true });

  return {
    controller,
    unlink: () => signal.removeEventListener("abort", forward),
  };
}
