# Logitech Identity Recovery and Ordered Inspector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make serial-less Logitech gaming devices survive G Hub endpoint regeneration without unsafe fallback, migrate only provable legacy selections, and replace the inspector's arrow controls with the approved numbered drag-order UI.

**Architecture:** Logitech discovery will separate persistent hardware identity from the current G Hub session endpoint. A pure identity helper will produce serial or unique model fingerprints; the provider will atomically map those identities to generation-scoped endpoints and expose sanitized discovery notices. Settings migration will canonicalize old `session:` selections only after successful discovery, preserving order and active position. The existing vanilla-JavaScript inspector will persist index-based reordering and render additive runtime/discovery state safely.

**Tech Stack:** TypeScript ES2022, `ws`, `@elgato/streamdeck`, Vitest, vanilla HTML/CSS/JavaScript, Playwright, Stream Deck CLI.

**Spec:** `docs/superpowers/specs/2026-08-20-logitech-identity-recovery-design.md`

## Global constraints

- Work only in `D:\DEV\SteelseriesBatteryMonitor-fix`; preserve the original dirty checkout at `D:\DEV\SteelseriesBatteryMonitor` unchanged.
- Continue using Logitech G Hub for this release. Do not add direct HID++, output reports, firmware/configuration calls, or a fallback-to-first-device path.
- Never persist a G Hub `dev000000##` endpoint for a newly selected device.
- Match migrations by exact endpoint or exact normalized name and type only. Never use substring, fuzzy, type-only, or first-result matching.
- Omit ambiguous serial-less model fingerprints instead of choosing one.
- Do not expose serials, raw endpoint IDs, HID paths, request bodies, or stack traces in ordinary logs or Property Inspector messages.
- Do not install into the live Stream Deck plugin directory. Validation and packaging must remain non-installing.
- Preserve schema version 2 and the existing `DeviceDescriptor` shape.

---

### Task 1: Persistent Logitech identity primitives

**Files:**

- Create: `src/logitech/identity.ts`
- Create: `tests/logitech/identity.test.ts`
- Modify: `src/logitech/client.ts`
- Modify: `tests/logitech/client.test.ts`

**Interfaces:**

```ts
export interface LogitechIdentityCandidate {
  device: GHubDevice;
  nativeId: string;
  physicalId?: string;
  kind: "serial" | "model";
}

export interface LogitechIdentityResult {
  candidates: LogitechIdentityCandidate[];
  ambiguousModelFingerprints: string[];
}

export function normalizeIdentityText(value: string): string;
export function identifyLogitechDevices(devices: readonly GHubDevice[]): LogitechIdentityResult;
```

- [ ] Write normalization tests for trim, Unicode NFC normalization, collapsed whitespace, and locale-independent lowercase. Include `"  G502\u00a0X   PLUS  " -> "g502 x plus"` and canonically equivalent Unicode inputs.
- [ ] Write identity tests proving serial priority, `model:<normalized name>|<normalized mapped type>` for a unique serial-less G502 X Plus, and omission of two identical serial-less models.
- [ ] Add negative tests showing same-type devices, substring-similar names, and different complete model names never collapse to the same identity.
- [ ] Run `npm test -- tests/logitech/identity.test.ts tests/logitech/client.test.ts` and verify the new module/API assertions fail before production edits.
- [ ] Implement `normalizeIdentityText()` with `value.trim().normalize("NFC").replace(/\s+/gu, " ").toLowerCase()` and use the mapped public device type in the model fingerprint.
- [ ] Implement a two-pass identity builder: filter battery-capable valid endpoints, count serial-less model fingerprints, emit serial candidates and only unique model candidates, and return non-sensitive ambiguity markers separately.
- [ ] Replace `nativeIdentity()` use in `LogitechClient.fetchDevices()` with `identifyLogitechDevices()`. Build descriptors from persistent identities and map each persistent `nativeId` to its current `GHubDevice` endpoint.
- [ ] Ensure serial descriptors retain `physicalId: serial:<normalized serial>` and unique model descriptors receive a Logitech-scoped `physicalId` that cannot collide with another provider, for example `logitech-model:<fingerprint>`.
- [ ] Change the compatibility `getBatteryInfo()` wrapper to resolve through the current discovered identity candidate; if the passed endpoint cannot be uniquely identified, return honest unavailable battery data rather than creating a `session:` identity.
- [ ] Add client tests proving an MX Keys keeps the same `serial:` key and a G502 X Plus keeps the same `model:` key while its battery request changes from `/battery/dev00000006/state` to `/battery/dev00000001/state`.
- [ ] Run `npm test -- tests/logitech/identity.test.ts tests/logitech/client.test.ts`, then `npm run typecheck`.
- [ ] Commit the green identity primitive milestone with `git add src/logitech/identity.ts src/logitech/client.ts tests/logitech/identity.test.ts tests/logitech/client.test.ts && git commit -m "fix: persist stable Logitech identities"`.

---

### Task 2: Generation-safe reconnects, notices, and sanitized diagnostics

**Files:**

- Modify: `src/devices/types.ts`
- Modify: `src/devices/catalog.ts`
- Modify: `src/logitech/client.ts`
- Modify: `src/actions/provider-set.ts`
- Modify: `src/actions/battery-action.ts`
- Modify: `tests/devices/catalog.test.ts`
- Modify: `tests/logitech/client.test.ts`
- Modify: `tests/actions/battery-action-adapter.test.ts`

**Interfaces:**

```ts
export interface ProviderNotice {
  provider: ProviderId;
  kind: "ambiguous" | "recovered";
  message: string;
  deviceKey?: string;
}

export interface DeviceDescriptor extends DeviceRef {
  /** Runtime-only aliases used for exact migration; never persisted or sent to the inspector. */
  transientNativeIds?: readonly string[];
}

export interface DeviceProvider {
  // Existing members remain unchanged.
  discoveryNotices?(): readonly ProviderNotice[];
}

export interface LogitechDiagnosticSink {
  info(message: string): void;
  warn(message: string): void;
}
```

- [ ] Add failing provider tests for socket close clearing endpoints immediately, successful reconnect forcing a fresh `/devices/list`, stale-generation responses being ignored, failed reconnect discovery leaving no live endpoint, and a later reconnect/discovery recovering automatically.
- [ ] Add a remap test that records the prior endpoint only in memory, discovers the same persistent model on a new endpoint, and produces one recovery notice without putting either raw endpoint ID in the notice text.
- [ ] Add ambiguity and failed-read diagnostic tests. Assert normal messages contain the model display name or provider identity and sanitized reason, but do not contain serial values, `dev000000##`, HID paths, JSON request payloads, or stack traces.
- [ ] Run `npm test -- tests/logitech/client.test.ts tests/devices/catalog.test.ts` and confirm the notice/diagnostic assertions fail.
- [ ] Add optional `notices` to `DiscoveryResult`, defaulting to `[]` at the catalog boundary so all callers receive a stable array without changing persisted descriptors.
- [ ] Have `DeviceCatalog.discover()` capture each provider's notices immediately after its discovery promise resolves and merge them into the result. Keep existing provider error isolation and physical deduplication unchanged.
- [ ] Track the last successful endpoint ID per persistent identity only for remap detection. Add `session:<current endpoint>` to the descriptor's runtime-only `transientNativeIds` for exact migration. Atomically replace `endpoints` and the endpoint-history snapshot after a generation-valid discovery; on failure, keep `endpoints` empty.
- [ ] On socket loss, increment both socket and discovery generations, reject pending requests, clear the endpoint map, log a concise loss/reconnect event, and schedule bounded exponential reconnect as today.
- [ ] On a successful open after prior discovery, bypass any stale discovery promise and force one generation-scoped discovery. If that discovery fails while the socket remains open, schedule a bounded retry rather than waiting indefinitely for an external refresh.
- [ ] Inject a no-op diagnostic sink by default. In `createActiveProviders()`, pass a sink backed by `streamDeck.logger.info/warn` so tests can record messages without globally mocking Stream Deck.
- [ ] Return discovery notices from `LogitechClient.discoveryNotices()` as an immutable snapshot for the most recent completed discovery. Use human-readable messages such as `"G502 X Plus reconnected through G Hub"` and `"Two Logitech devices share the same model name; neither was selected automatically"`.
- [ ] Extend `discoveryMessage()` to serialize sanitized `notices` and distinguish partial success (`devices.length > 0 && errors.length > 0`) from full success, empty, and full error.
- [ ] Run `npm test -- tests/logitech/client.test.ts tests/devices/catalog.test.ts tests/actions/battery-action-adapter.test.ts`, then `npm run typecheck`.
- [ ] Commit with `git add src/devices src/logitech/client.ts src/actions/provider-set.ts src/actions/battery-action.ts tests/devices/catalog.test.ts tests/logitech/client.test.ts tests/actions/battery-action-adapter.test.ts && git commit -m "fix: recover Logitech endpoints after reconnect"`.

---

### Task 3: Exact legacy Logitech migration and active-position translation

**Files:**

- Modify: `src/actions/settings.ts`
- Modify: `src/actions/battery-action.ts`
- Modify: `tests/actions/settings.test.ts`
- Modify: `tests/actions/battery-action-adapter.test.ts`

**Interfaces:**

```ts
export interface PreparedSettingsMigration {
  selectedDevices: DeviceRef[];
  activeDeviceKey: string | null;
  safeToPersist: boolean;
  changed: boolean;
}

export function prepareMigratedDevices(
  selectedDevices: readonly DeviceRef[],
  discoveredDevices: readonly DeviceDescriptor[],
  activeDeviceKey?: string | null
): PreparedSettingsMigration;
```

- [ ] Extend settings tests so schema-v2 Logitech `session:` selections are marked as migration candidates even when `schemaVersion` is already 2.
- [ ] Add migration tests for: exact current session endpoint, unique exact normalized name plus type, generic saved type `Device` adopting an exact unique name match, stale `Pro Wireless Mouse` versus `G502 X Plus`, duplicate exact names, same type with different name, and substring-only names.
- [ ] Add an ordered-list test with devices before and after the Logitech selection. Assert only the Logitech descriptor changes, its list index remains fixed, and an old `activeDeviceKey` is translated to the canonical key.
- [ ] Add action adapter tests proving a unique migration calls `setSettings()` once, retains display options, updates runtime with the canonical settings, and does not create a refresh/settings loop on the next settings event.
- [ ] Add action tests proving failed or ambiguous Logitech migration persists nothing and leaves the saved row visible as unavailable. Retain the existing fail-closed SteelSeries migration behavior.
- [ ] Run `npm test -- tests/actions/settings.test.ts tests/actions/battery-action-adapter.test.ts` and verify the new migration cases fail.
- [ ] Add one shared normalized exact-match helper using the Logitech identity normalizer. For legacy resolution, first match the saved `session:` native ID against exactly one descriptor's runtime-only `transientNativeIds`; otherwise require exactly one discovered Logitech descriptor with equal normalized saved name and mapped type. Treat saved `Device` as a wildcard only for the type half after exact name equality.
- [ ] Keep `transientNativeIds` out of `toPersistedDevice()`, `toInspectorDevice()`, provider notices, and logs. It exists only on the in-process discovery descriptor and is discarded after canonicalization.
- [ ] Update `prepareMigratedDevices()` to return translated active key and `changed`. Preserve selection order, unrelated entries, all display options, and `schemaVersion: 2`.
- [ ] Update `onWillAppear()` to persist only when discovery succeeded enough to prove every pending migration, re-read the latest settings before writing, and use the translated `activeDeviceKey`. Log a concise unresolved-migration warning without raw session IDs.
- [ ] Run `npm test -- tests/actions/settings.test.ts tests/actions/battery-action-adapter.test.ts`, then `npm test -- tests/actions` and `npm run typecheck`.
- [ ] Commit with `git add src/actions/settings.ts src/actions/battery-action.ts tests/actions/settings.test.ts tests/actions/battery-action-adapter.test.ts && git commit -m "fix: migrate exact Logitech selections safely"`.

---

### Task 4: Numbered drag-order inspector model

**Files:**

- Modify: `com.jcooler.peripheral-battery.sdPlugin/ui/device-list.js`
- Modify: `tests/ui/device-list.test.ts`

**Interfaces:**

```js
export function reorderSelectedDevice(selectedDevices, key, targetIndex) {}

// Directional movement remains only as the keyboard adapter.
export function moveSelectedDevice(selectedDevices, key, direction) {
  const selected = uniqueDevices(selectedDevices);
  const currentIndex = selected.findIndex((device) => device.key === key);
  if (currentIndex < 0 || (direction !== "up" && direction !== "down")) {
    return selected;
  }
  const offset = direction === "up" ? -1 : 1;
  return reorderSelectedDevice(selected, key, currentIndex + offset);
}
```

- [ ] Add pure-model tests for moving first/middle/last selected devices to a target index, ignoring invalid keys/indexes, preserving unselected discovery rows, and persisting exactly the resulting `selectedDevices` order.
- [ ] Replace renderer expectations so selected rows have consecutive `.cycle-position` text, exactly one `.drag-grip`, and no `.order-button` elements; unselected rows keep a checkbox and have neither position nor grip.
- [ ] Add drag tests using the existing fake DOM: `dragstart` records the selected key, `dragover` exposes a valid target, and `drop` calls `onReorder(key, targetIndex)`. Assert dragging cannot include an unselected row.
- [ ] Add keyboard tests proving a focused selected row handles `Alt+ArrowUp` and `Alt+ArrowDown`, prevents default only for valid reorder commands, and calls the same index-based reorder path.
- [ ] Add accessibility tests for `tabindex`, grip/row labels, `aria-grabbed` during dragging, and an announcement string such as `"Moved MX Keys to position 1 of 2"`.
- [ ] Keep the existing hostile-name/text-content test and add hostile notice/status strings so no provider-derived value becomes HTML.
- [ ] Run `npm test -- tests/ui/device-list.test.ts` and verify the old arrow renderer fails the new assertions.
- [ ] Implement `reorderSelectedDevice()` as a pure remove-and-insert operation over `uniqueDevices(selectedDevices)`, clamping only valid selected target indexes and returning unchanged data for invalid input.
- [ ] Update `createInspectorController()` with `reorder(key, targetIndex)` and a one-shot `announce(text)` view call. Clear a recovery message on include, reorder, display-setting change, or explicit refresh.
- [ ] Rebuild `renderDeviceList()` so selected rows use a left number, compact identity/status content, and a right drag grip. Give the selected row one focusable keyboard surface; do not make drag the only reorder mechanism.
- [ ] Keep all names, provider labels, battery text, and notices assigned through `textContent`.
- [ ] Run `npm test -- tests/ui/device-list.test.ts`, then `npm run typecheck` and `npm run build`.
- [ ] Commit with `git add com.jcooler.peripheral-battery.sdPlugin/ui/device-list.js tests/ui/device-list.test.ts && git commit -m "feat: add accessible drag device ordering"`.

---

### Task 5: Inspector visual states and runtime battery summaries

**Files:**

- Modify: `src/actions/battery-action.ts`
- Modify: `com.jcooler.peripheral-battery.sdPlugin/ui/device-list.js`
- Modify: `com.jcooler.peripheral-battery.sdPlugin/ui/battery.html`
- Modify: `tests/actions/battery-action-adapter.test.ts`
- Modify: `tests/ui/device-list.test.ts`

**Message shapes:**

```ts
// Additive sendToPropertyInspector payloads.
{
  event: "deviceRuntimeStatus",
  currentDeviceKey: string | null,
  statuses: Array<{
    deviceKey: string;
    state: "connected" | "disconnected" | "unavailable";
    batteryText: string;
  }>;
}
```

- [ ] Add action adapter tests showing `render()` sends a sanitized summary for the current device, percentages use `"72%"`, qualitative levels use trusted fixed labels, and unavailable details are reduced to a safe connection-state label.
- [ ] Add controller/render tests for current, sleeping/disconnected, unavailable, recovered, loading, empty, partial-provider-error, and full-error states. Ensure the recovery banner appears only for a `recovered` provider notice and clears on the next ordinary interaction or refresh.
- [ ] Add CSS/DOM assertions for selected layout order: number, identity block, grip. Assert narrow rows do not require arrow-control space and long names retain ellipsis behavior.
- [ ] Run `npm test -- tests/actions/battery-action-adapter.test.ts tests/ui/device-list.test.ts` and verify the additive runtime-state assertions fail.
- [ ] Cache the latest sanitized status summary per action context in `BatteryAction`; after a successful render, send an additive `deviceRuntimeStatus` message through the existing `InspectorMessenger`. Remove a context's summary on `onWillDisappear()`.
- [ ] Extend the inspector controller with `receiveRuntimeStatus(payload)` and merge summaries by exact device key only. Render provider, availability/connection state, and latest battery value in compact secondary text without persisting runtime state.
- [ ] Update WebSocket message routing to accept `deviceRuntimeStatus` alongside `deviceList`. Older messages and saved settings must continue to work.
- [ ] Restyle `battery.html` to match the approved compact status-list direction: numbered circle on the left, text in the center, grip on the right, selected/unselected states, visible focus, dashed unavailable state, touch-sized grip, and no horizontal scrollbar at 250- to 360-pixel widths.
- [ ] Add a visually hidden `aria-live="polite"` reorder announcement region separate from the discovery status bar. Update help copy to mention drag and `Alt+Arrow` ordering.
- [ ] Run `npm test -- tests/actions/battery-action-adapter.test.ts tests/ui/device-list.test.ts`, `npm test -- tests/ui`, `npm run typecheck`, and `npm run build`.
- [ ] Commit with `git add src/actions/battery-action.ts com.jcooler.peripheral-battery.sdPlugin/ui/device-list.js com.jcooler.peripheral-battery.sdPlugin/ui/battery.html tests/actions/battery-action-adapter.test.ts tests/ui/device-list.test.ts && git commit -m "feat: refine device status inspector"`.

---

### Task 6: Real-browser QA, regression gate, and beta handoff

**Files:**

- Modify: `docs/provider-sources.md`
- Create: `docs/qa/2026-08-20-logitech-72-hour-soak.md`
- Modify only if evidence requires: `com.jcooler.peripheral-battery.sdPlugin/manifest.json`

- [ ] Add a small deterministic Property Inspector fixture or query-driven sample state to the test harness, excluded from the packaged plugin, covering two selected devices, one unselected device, one missing saved device, a recovery notice, and a partial provider error.
- [ ] Use Playwright with the built `battery.html` at 250, 280, and 360 CSS pixels wide. Capture screenshots and interact with checkbox inclusion, drag reorder, keyboard reorder, refresh, long names, and recovery dismissal.
- [ ] Verify no horizontal scrolling, clipped grip/number, overlapping text, inaccessible focus target, duplicate control ID, uncaught page error, or console error. Confirm all displayed provider/device strings remain text.
- [ ] Run the focused reconnect/migration/UI suite: `npm test -- tests/logitech tests/actions/settings.test.ts tests/actions/battery-action-adapter.test.ts tests/ui/device-list.test.ts`.
- [ ] Run the full automated gate once: `npm test && npm run typecheck && npm run build && npm run validate && npm run pack:dry`.
- [ ] Scan the built source and bundle with `rg -n "session:dev|updateCachedProperties|/device/.*/function|firmware" src com.jcooler.peripheral-battery.sdPlugin` and inspect each match. The only permitted `session:` use is legacy parsing/migration; no SteelSeries mutating endpoint may appear.
- [ ] Run `npm audit --audit-level=high`, inspect `git diff --check`, `git status --short`, and the package dry-run contents. Do not install or publish.
- [ ] Update `docs/provider-sources.md` to state that Logitech gaming support requires G Hub, uses exact serial or unique model identity, omits ambiguous identical models, and does not yet claim direct HID++ support.
- [ ] Create the 72-hour manual checklist with timestamp/result fields for G502 X Plus plus MX Keys order retention, G Hub restart, independent sleep/wake, Windows sleep/resume, cable-to-LIGHTSPEED transition, Stream Deck-before-G-Hub startup, no silent device switch, and no SteelSeries firmware prompt.
- [ ] Perform one read-only whole-change review. Fix only confirmed critical/important defects with focused regression tests, then rerun the affected focused checks and one stabilized full gate.
- [ ] Commit documentation and any evidence-backed fixes. Do not claim the intermittent hardware defect fully closed until the user completes the 72-hour soak; report automation coverage and the remaining manual ceiling separately.

## Completion criteria

- Newly selected serial-less Logitech devices persist a unique `model:` identity, never a `session:` endpoint.
- The configured G502 X Plus reads from a regenerated current endpoint after G Hub reconnect without reopening the Property Inspector.
- Ambiguous identical serial-less devices are omitted and reported, never guessed.
- Legacy migrations are exact, order-preserving, active-key-preserving, one-time, and fail closed.
- The inspector has consecutive order numbers, one drag grip per selected row, no arrow buttons, and a working `Alt+Arrow` equivalent.
- Discovery, current/sleeping/unavailable/recovered, partial-error, and battery summary states are safe and usable at Stream Deck widths.
- Full tests, typecheck, build, validation, and dry-run packaging pass; live installation, Marketplace submission, and 72-hour hardware sign-off remain separate user-controlled gates.
