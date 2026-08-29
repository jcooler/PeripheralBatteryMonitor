# SteelSeries Last-Known Battery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist validated passive SteelSeries battery readings and display them honestly as fresh or visibly last-known for exactly connected keyboards and headsets.

**Architecture:** Add a bounded Stream Deck global-settings cache behind a narrow injected interface, then reconcile its entries with current GG inventory inside `SteelSeriesClient`. Propagate only the explicit last-known marker and timestamp through the action boundary so the key and Property Inspector can render `~85%` and a trusted age label without restoring any GG mutation.

**Tech Stack:** TypeScript, Vitest 4, Rollup 4, Elgato Stream Deck SDK 2, vanilla Property Inspector JavaScript and CSS, Playwright Chromium

**Spec:** `docs/superpowers/specs/2026-08-28-steelseries-last-known-battery-design.md`

## Global Constraints

- Work only in `D:\DEV\SteelseriesBatteryMonitor-fix`; do not modify `D:\DEV\SteelseriesBatteryMonitor`.
- SteelSeries network access remains `GET /devices` plus receive-only WebSocket events.
- Never restore `updateCachedProperties`, `read_battery_status`, another GG device function, HTTP `POST`, WebSocket `send`, or a SteelSeries HID write.
- Freshness is at most 15 minutes inclusive; last-known is greater than 15 minutes and at most 30 days.
- A fresh or last-known percentage requires current-generation exact GG inventory with one matching connected battery device.
- Confirmed disconnect, metadata mismatch, duplicate identity, recycled ID, invalid cache data, and age over 30 days clear the reading.
- Device absence and transient GG or socket loss retain cache history but may not display a percentage without new connection evidence.
- Persist no more than 32 entries and never persist or log addresses, HID paths, USB identifiers, serials, URLs, packets, or raw GG payloads.
- Preserve all unrelated Stream Deck global settings during serialized cache mutations.
- Last-known never claims charging and must show a tilde even when status text is disabled.
- No Marketplace upload, submission, publication, or PR merge is authorized by this plan.

---

### Task 1: Bounded SteelSeries Battery Cache Store

**Files:**
- Create: `src/steelseries/battery-cache.ts`
- Create: `tests/steelseries/battery-cache.test.ts`

**Interfaces:**
- Consumes: `JsonObject` and `JsonValue` from `@elgato/utils`.
- Produces: `SteelSeriesBatteryCacheEntry`, `SteelSeriesBatteryCacheStore`, `SteelSeriesGlobalSettingsBackend`, and `createSteelSeriesBatteryCacheStore(backend, options?)`.
- Produces cache methods `load(): Promise<readonly SteelSeriesBatteryCacheEntry[]>`, `upsert(entry): Promise<void>`, and `remove(nativeId): Promise<void>`.

- [ ] **Step 1: Write failing validation and hydration tests**

Create a fake backend that clones values on every read and records complete writes. Test missing settings, one valid entry, malformed containers, noncanonical and unsafe IDs, duplicate IDs, blank or oversized metadata, levels outside `0..100`, invalid charging values, non-finite, future, and older-than-30-day timestamps, deterministic newest-first ordering, and the 32-entry cap.

```ts
const now = 40 * DAY_MS;
const backend = new FakeGlobalSettingsBackend({
  unrelated: { keep: true },
  steelseriesBatteryCacheV1: {
    schemaVersion: 1,
    entries: [{
      nativeId: "330",
      name: "Apex Pro TKL Wireless",
      deviceType: "Keyboard",
      level: 85,
      charging: false,
      observedAt: now - 20 * MINUTE_MS,
    }],
  },
});
const store = createSteelSeriesBatteryCacheStore(backend, { now: () => now });

await expect(store.load()).resolves.toEqual([
  expect.objectContaining({ nativeId: "330", level: 85 }),
]);
```

- [ ] **Step 2: Run the cache tests and verify RED**

Run: `npm test -- tests/steelseries/battery-cache.test.ts`

Expected: FAIL because `src/steelseries/battery-cache.ts` does not exist.

- [ ] **Step 3: Implement the narrow types and strict parser**

Implement these public contracts and keep parsing helpers module-private:

```ts
export interface SteelSeriesBatteryCacheEntry {
  nativeId: string;
  name: string;
  deviceType: string;
  level: number;
  charging: boolean | null;
  observedAt: number;
}

export interface SteelSeriesBatteryCacheStore {
  load(): Promise<readonly SteelSeriesBatteryCacheEntry[]>;
  upsert(entry: SteelSeriesBatteryCacheEntry): Promise<void>;
  remove(nativeId: string): Promise<void>;
}

export interface SteelSeriesGlobalSettingsBackend {
  getGlobalSettings(): Promise<JsonObject>;
  setGlobalSettings(settings: JsonObject): Promise<void>;
}
```

Use constants `CACHE_KEY = "steelseriesBatteryCacheV1"`, `SCHEMA_VERSION = 1`, `MAX_ENTRIES = 32`, `MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000`, `MAX_NAME_LENGTH = 160`, and `MAX_TYPE_LENGTH = 80`. Accept only trimmed metadata that already equals its stored value, integer levels, `true | false | null` charging, canonical decimal non-negative safe-integer IDs, and `0 <= observedAt <= now` whose age is at most 30 days. If one native ID appears more than once in loaded settings, drop every entry for that ambiguous ID rather than selecting a winner.

- [ ] **Step 4: Run validation tests and verify GREEN**

Run: `npm test -- tests/steelseries/battery-cache.test.ts`

Expected: PASS for loading and pruning cases.

- [ ] **Step 5: Write failing serialization, preservation, and retry tests**

Start concurrent mutations without awaiting the first one. Assert both entries survive, newest `observedAt` wins for the same ID, removal wins when queued after an upsert, and the complete unrelated settings object remains deeply equal. Make one `setGlobalSettings` call reject, then queue another mutation and assert the next successful write contains the desired state from both operations.

```ts
const first = store.upsert(apexEntry);
const second = store.upsert(arctisEntry);
await Promise.all([first, second]);

expect(backend.latest.unrelated).toEqual({ keep: true });
expect(cacheIds(backend.latest)).toEqual(["245", "330"]);
```

- [ ] **Step 6: Run mutation tests and verify RED**

Run: `npm test -- tests/steelseries/battery-cache.test.ts`

Expected: FAIL because mutations are not serialized and retry state is not implemented.

- [ ] **Step 7: Implement the serialized read-modify-write queue**

Maintain one desired `Map<string, SteelSeriesBatteryCacheEntry>` after first hydration and one promise tail. Every `load`, `upsert`, and `remove` appends an operation to the tail. Mutations read the latest global settings inside the queue, replace only `steelseriesBatteryCacheV1`, and write the merged object. Preserve desired state after a rejected write so the next mutation retries the complete snapshot. Return a rejected promise to the failed caller without poisoning the queue tail.

- [ ] **Step 8: Run cache tests and typecheck**

Run: `npm test -- tests/steelseries/battery-cache.test.ts && npm run typecheck`

Expected: all cache tests PASS and TypeScript exits 0.

- [ ] **Step 9: Commit the cache store**

```powershell
git add -- src/steelseries/battery-cache.ts tests/steelseries/battery-cache.test.ts
git commit -m "feat: persist bounded SteelSeries battery history"
```

---

### Task 2: SteelSeries Client Reconciliation and Restart Recovery

**Files:**
- Modify: `src/steelseries/client.ts`
- Modify: `src/devices/types.ts`
- Modify: `src/actions/provider-set.ts`
- Modify: `tests/steelseries/client.test.ts`
- Modify: `tests/steelseries/no-mutations.integration.test.ts`

**Interfaces:**
- Consumes: `SteelSeriesBatteryCacheEntry` and `SteelSeriesBatteryCacheStore` from Task 1.
- Extends: `SteelSeriesClientOptions` with `batteryCache?: SteelSeriesBatteryCacheStore` and `diagnosticSink?: { warn(message: string): void }`.
- Extends: `BatteryStatus` with `freshness?: "last-known"`.
- Produces: fresh percentage statuses without a marker and last-known percentage statuses with `freshness: "last-known"`.

- [ ] **Step 1: Add a deterministic fake cache and failing freshness-transition tests**

Extend the SteelSeries test setup to accept a mutable `now`, cache entries, and custom inventory. Test the Apex-shaped keyboard and Arctis-shaped headset separately. Emit a passive battery event, advance from exactly 15 minutes to 15 minutes plus 1 millisecond, and assert the value changes from fresh to last-known instead of unavailable.

```ts
await expect(client.readStatus(device)).resolves.toMatchObject({
  state: "connected",
  level: { kind: "percentage", value: 85 },
  charging: false,
});
now += 15 * 60 * 1_000 + 1;
await expect(client.readStatus(device)).resolves.toMatchObject({
  state: "connected",
  level: { kind: "percentage", value: 85 },
  charging: null,
  freshness: "last-known",
});
```

- [ ] **Step 2: Run focused client tests and verify RED**

Run: `npm test -- tests/steelseries/client.test.ts`

Expected: FAIL because an event older than `liveDataMaxAgeMs` still returns unavailable.

- [ ] **Step 3: Implement hydration and fresh versus last-known selection**

Add `freshness?: "last-known"` to `BatteryStatus`. Add separate `liveBatteryData` and `cachedBatteryData` maps, one shared hydration promise, and a tombstone set for disconnects that occur before hydration finishes. Call hydration before the first discovery or status read, catch failures without failing discovery, and log only `SteelSeries battery cache unavailable`.

Choose the newest validated live or hydrated entry. Require current cached inventory, exact metadata, one unique ID, and connected state before returning either freshness. Return charging only when age is at most `liveDataMaxAgeMs`; otherwise return `charging: null` with `freshness: "last-known"`. Delete entries older than 30 days.

- [ ] **Step 4: Run freshness tests and verify GREEN**

Run: `npm test -- tests/steelseries/client.test.ts -t "fresh|last-known"`

Expected: keyboard and headset transition tests PASS.

- [ ] **Step 5: Write failing persistence, restart, and identity tests**

Cover these independent cases:

- a validated passive battery event upserts exact inventory metadata;
- an event received before inventory remains memory-only, then persists after exact discovery;
- a new client instance hydrates Apex and Arctis entries and shows them only after current exact connected inventory;
- a cache entry within 15 minutes remains fresh after restart;
- a cache entry older than 15 minutes is last-known after restart;
- confirmed connection event `status: 0` and inventory `connected: 0` delete memory and persistence;
- absence retains persistence but reports unavailable;
- name or type mismatch, recycled ID, duplicate inventory ID, invalid entry, and age over 30 days remove persistence and never display;
- a late hydration result cannot override a newer event or disconnect;
- socket loss retains history but clears connection evidence until a successful new inventory generation;
- charging-only events do not refresh `observedAt`.

Use deferred promises for hydration and inventory races. Assert cache calls by exact sanitized entry rather than raw event payload.

- [ ] **Step 6: Run reconciliation tests and verify RED**

Run: `npm test -- tests/steelseries/client.test.ts`

Expected: the new restart, removal, and race cases FAIL before reconciliation is complete.

- [ ] **Step 7: Implement validated upsert and immediate removal flows**

Create focused private methods equivalent to these responsibilities:

```ts
private newestBattery(nativeId: string): SteelSeriesBatteryCacheEntry | undefined;
private persistValidatedLiveBattery(device: SteelSeriesDevice): void;
private discardBattery(nativeId: string): void;
private ensureBatteryCacheHydrated(): Promise<void>;
```

`persistValidatedLiveBattery` may upsert only when the current inventory record is unique, battery-capable, metadata-valid, and connected. `discardBattery` must delete both maps and add a tombstone synchronously before queueing `store.remove`. A later valid battery event removes that ID's tombstone. Store failures log a generic warning and never expose metadata.

Keep persistent history across `handleSocketLoss`, `resetEngineGeneration`, and manual invalidation, while clearing inventory and current connection evidence. Keep the existing connection event sequence so a newer device event still wins over an older in-flight inventory response.

- [ ] **Step 8: Wire the production Stream Deck global-settings adapter**

In `createActiveProviders`, create the store with this narrow backend and inject it only into `SteelSeriesClient`:

```ts
const steelSeriesBatteryCache = createSteelSeriesBatteryCacheStore({
  getGlobalSettings: () => streamDeck.settings.getGlobalSettings(),
  setGlobalSettings: (settings) => streamDeck.settings.setGlobalSettings(settings),
});

new SteelSeriesClient({
  batteryCache: steelSeriesBatteryCache,
  diagnosticSink: {
    warn: (message) => streamDeck.logger.warn(message),
  },
});
```

Do not make global-settings calls during module construction. The store stays lazy until discovery or status reading after Stream Deck connects.

- [ ] **Step 9: Strengthen the passive-only integration test**

Run discovery, battery events, transition to last-known, cache upsert/remove, restart hydration, keyboard/headset switching, and repeated status reads. Assert every HTTP request is `{ method: "GET", path: "/devices" }`, every fake socket's sent list is empty, and the backend contains only the six allowlisted cache fields.

- [ ] **Step 10: Run SteelSeries tests and typecheck**

Run: `npm test -- tests/steelseries/battery-cache.test.ts tests/steelseries/client.test.ts tests/steelseries/no-mutations.integration.test.ts && npm run typecheck`

Expected: all focused SteelSeries tests PASS and TypeScript exits 0.

- [ ] **Step 11: Commit client reconciliation**

```powershell
git add -- src/steelseries/client.ts src/devices/types.ts src/actions/provider-set.ts tests/steelseries/client.test.ts tests/steelseries/no-mutations.integration.test.ts
git commit -m "fix: retain honest SteelSeries battery history"
```

---

### Task 3: Last-Known Key and Runtime Presentation

**Files:**
- Modify: `src/types.ts`
- Modify: `src/actions/battery-action.ts`
- Modify: `src/utils/icon-generator.ts`
- Modify: `tests/actions/battery-action-adapter.test.ts`
- Modify: `tests/utils/icon-generator.test.ts`

**Interfaces:**
- Consumes: `BatteryStatus.freshness` from Task 2.
- Extends: `BatteryInfo` with `isLastKnown?: boolean` for presentation only.
- Extends: runtime summaries with optional `freshness?: "last-known"` and `observedAt?: number`.

- [ ] **Step 1: Write failing icon tests for visibly last-known status**

Add a percentage icon case with `batteryLevel: 85`, `isCharging: true`, `isLastKnown: true`, and status text enabled. Assert the decoded SVG contains `~85%` and `Last known`, omits `SteelSeries GG`, and contains no charging bolt polygon. Assert a fresh icon still contains `85%`, its provider label, and a bolt when charging.

```ts
expect(lastKnownSvg).toContain("~85%");
expect(lastKnownSvg).toContain("Last known");
expect(lastKnownSvg).not.toContain("SteelSeries GG");
expect(lastKnownSvg).not.toContain("<polygon");
```

- [ ] **Step 2: Run icon tests and verify RED**

Run: `npm test -- tests/utils/icon-generator.test.ts`

Expected: FAIL because `isLastKnown` and tilde rendering are not implemented.

- [ ] **Step 3: Implement the explicit icon flag**

Add `isLastKnown?: boolean` to `BatteryInfo`. In `generateBatteryIcon`, suppress the bolt when true, prefix the percentage with `~`, and make status parts exactly `["Last known"]`. Do not infer freshness from `providerLabel`, `detail`, age, or device type. Preserve the existing color, device labels, background, and cycle indicator.

- [ ] **Step 4: Run icon tests and verify GREEN**

Run: `npm test -- tests/utils/icon-generator.test.ts`

Expected: fresh and last-known icon tests PASS.

- [ ] **Step 5: Write failing action sanitization tests**

Pass a last-known SteelSeries percentage through action rendering and assert:

```ts
expect(generateBatteryIcon).toHaveBeenCalledWith(
  expect.objectContaining({ batteryLevel: 85, isCharging: false, isLastKnown: true }),
  expect.anything(),
  expect.anything(),
);
expect(inspectorMessage.statuses).toContainEqual({
  deviceKey: "steelseries:330",
  state: "connected",
  batteryText: "~85%",
  freshness: "last-known",
  observedAt,
});
```

Add negative cases showing freshness and timestamp are omitted for fresh, unavailable, disconnected, qualitative, future, negative, and non-finite timestamps.

- [ ] **Step 6: Run action tests and verify RED**

Run: `npm test -- tests/actions/battery-action-adapter.test.ts`

Expected: FAIL because the action currently sends `85%` with no freshness metadata.

- [ ] **Step 7: Implement safe runtime propagation**

Pass `isLastKnown: status.freshness === "last-known"` into `BatteryInfo`, and force displayed charging false for that presentation. In `sanitizeRuntimeStatus`, emit `~${percentage}%`, freshness, and `observedAt` only when state is connected, level is percentage, freshness is exactly `last-known`, and timestamp is finite, non-negative, and no later than the sanitization time. All other providers and statuses retain existing messages.

- [ ] **Step 8: Run action, icon, and type tests**

Run: `npm test -- tests/actions/battery-action-adapter.test.ts tests/utils/icon-generator.test.ts && npm run typecheck`

Expected: both suites PASS and TypeScript exits 0.

- [ ] **Step 9: Commit key and action presentation**

```powershell
git add -- src/types.ts src/actions/battery-action.ts src/utils/icon-generator.ts tests/actions/battery-action-adapter.test.ts tests/utils/icon-generator.test.ts
git commit -m "feat: mark last-known battery readings"
```

---

### Task 4: Property Inspector Freshness and Responsive QA

**Files:**
- Modify: `com.jcooler.peripheral-battery.sdPlugin/ui/device-list.js`
- Modify: `com.jcooler.peripheral-battery.sdPlugin/ui/battery.html`
- Modify: `tests/ui/device-list.test.ts`
- Modify: `tests/ui/property-inspector.browser.test.ts`

**Interfaces:**
- Consumes: runtime `freshness: "last-known"`, `observedAt`, and `batteryText: "~N%"` from Task 3.
- Produces: exported `formatLastSeenAge(observedAt, now)` for deterministic unit coverage.

- [ ] **Step 1: Write failing runtime validation and age-format tests**

Use `buildDeviceRows` and `formatLastSeenAge` to cover `Last seen 15m ago`, `Last seen 59m ago`, `Last seen 1h ago`, `Last seen 23h ago`, `Last seen 1d ago`, and `Last seen 30d ago`. Accept last-known only when state is connected, battery text matches `^~(?:100|[1-9]?\d)%$`, and `observedAt` is finite, non-negative, not future, and at most 30 days old. Reject the entire malformed runtime status when any of those fields disagree.

```ts
expect(formatLastSeenAge(now - 23 * 60 * 1_000, now)).toBe("Last seen 23m ago");
expect(row.runtimeStatus).toMatchObject({
  batteryText: "~85%",
  freshness: "last-known",
  observedAt,
});
```

- [ ] **Step 2: Run device-list tests and verify RED**

Run: `npm test -- tests/ui/device-list.test.ts`

Expected: FAIL because last-known fields and age formatting do not exist.

- [ ] **Step 3: Implement strict runtime normalization and text-only rendering**

Export `formatLastSeenAge(observedAt, now = Date.now())`. Round down to minutes below 1 hour, hours below 1 day, and days thereafter. Extend normalized last-known status only after all field checks pass. In `renderDeviceList`, append a `span.freshness-label` with the formatted age after the battery value. Assign all strings through `textContent`; do not use `innerHTML`.

Add compact wrapping styles to `battery.html` that use the existing metadata typography and do not increase control widths:

```css
.freshness-label {
  color: #d6a84b;
  white-space: nowrap;
}
```

- [ ] **Step 4: Run device-list tests and verify GREEN**

Run: `npm test -- tests/ui/device-list.test.ts`

Expected: formatting, rejection, and rendering tests PASS.

- [ ] **Step 5: Write a failing real Chromium width matrix**

Render a selected Apex row with `~85%` and `Last seen 23m ago`, plus a selected Arctis row with `~72%` and `Last seen 3d ago`. At 250, 280, 360, and 1280 CSS pixels assert:

- no horizontal document overflow;
- position, identity, Remove, and drag grip remain separated and inside the viewport;
- both freshness labels are visible and use exact trusted text;
- no duplicated IDs, injected elements, console errors, or page errors;
- mouse, keyboard, and touch removal and reorder controls still work.

- [ ] **Step 6: Run Chromium tests and verify RED**

Run: `npm test -- tests/ui/property-inspector.browser.test.ts`

Expected: FAIL because the freshness labels are not in the rendered browser fixture yet.

- [ ] **Step 7: Complete the responsive CSS and fixture flow**

Send runtime timestamps computed from the browser's current `Date.now()` so the test is deterministic. Adjust only `.device-metadata` and `.freshness-label` wrapping, gap, and min-width behavior needed to pass the matrix. Preserve the approved number, identity, Remove, and drag-grip layout.

- [ ] **Step 8: Run unit and browser UI tests**

Run: `npm test -- tests/ui/device-list.test.ts tests/ui/property-inspector.browser.test.ts`

Expected: unit tests and the 250/280/360/1280 Chromium matrix PASS with no browser errors.

- [ ] **Step 9: Commit Property Inspector freshness UI**

```powershell
git add -- com.jcooler.peripheral-battery.sdPlugin/ui/device-list.js com.jcooler.peripheral-battery.sdPlugin/ui/battery.html tests/ui/device-list.test.ts tests/ui/property-inspector.browser.test.ts
git commit -m "feat: show SteelSeries battery freshness"
```

---

### Task 5: Safety Gate, Packaging, Reload, and Soak Handoff

**Files:**
- Create: `docs/qa/2026-08-28-steelseries-last-known-soak.md`
- Modify only if a defect is proven: files and tests owned by Tasks 1 through 4

**Interfaces:**
- Consumes: the completed cache, client, key, and Property Inspector behavior.
- Produces: exact build/package evidence, a reloaded local plugin worker, and a manual 72-hour keyboard/headset checklist.

- [ ] **Step 1: Run focused SteelSeries and UI verification**

Run:

```powershell
npm test -- tests/steelseries/battery-cache.test.ts tests/steelseries/client.test.ts tests/steelseries/no-mutations.integration.test.ts tests/actions/battery-action-adapter.test.ts tests/utils/icon-generator.test.ts tests/ui/device-list.test.ts tests/ui/property-inspector.browser.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 2: Run source and built-bundle mutation scans**

Run source scans before build, then repeat against the built plugin JavaScript:

```powershell
rg -n 'updateCachedProperties|read_battery_status|/device/.*/function|method:\s*["'']POST|\.send\(' src/steelseries tests/steelseries
npm run build
rg -n 'updateCachedProperties|read_battery_status|/device/.*/function|method:\s*["'']POST' com.jcooler.peripheral-battery.sdPlugin/bin
```

Expected: source matches occur only in explicit forbidden-string assertions or documentation; built plugin JavaScript has no forbidden mutation route or `POST` match. Inspect every source match rather than treating `rg` exit 1 as a failure.

- [ ] **Step 3: Run the clean-staging full gate**

Stage only intended files, inspect the index, then run:

```powershell
git diff --cached --check
npm test
npm run typecheck
npm run build
npm run validate
npm run pack:dry
npm audit --audit-level=high
```

Expected: full Vitest suite PASS, TypeScript PASS, build PASS, Stream Deck validation PASS, dry package PASS, and no high-severity audit finding on this branch.

- [ ] **Step 4: Write the manual soak checklist**

Create `docs/qa/2026-08-28-steelseries-last-known-soak.md` with separate Apex Pro TKL Wireless and Arctis Nova Pro Wireless rows for:

- fresh percentage time and value after opening each GG page once;
- transition time to `~percentage` with GG page closed;
- plugin restart recovery and connection confirmation;
- device off, confirmed disconnect, cache clearing, and device-on unavailable state until a new event;
- GG restart, sleep/wake, USB/wireless transition, and device switching;
- Arena or firmware prompt observed, expected `No`;
- raw GG mutation, unsolicited UI open, or device wake observed, expected `No`.

State clearly that automated tests and one local reload do not prove 72-hour hardware behavior.

- [ ] **Step 5: Build and reload the exact local plugin worker**

Record the exact pre-reload worker command line and PID with `Get-CimInstance Win32_Process`, build the reviewed commit, and use the Stream Deck CLI restart command. Re-query the exact plugin command line and verify a new PID and start time. If the CLI reports success without replacing the worker, stop only the previously recorded exact plugin PID and let Stream Deck respawn it. Do not stop Stream Deck, GG, G Hub, or any broad Node process set.

- [ ] **Step 6: Perform bounded live confirmation**

Open the Apex and Arctis device pages in GG once. Confirm both keys receive fresh percentages and the Property Inspector shows exact connected values. Reload the plugin worker again and confirm the persisted readings return only after current inventory succeeds. Do not wait 15 minutes inside a blocking command; record the transition-to-last-known check in the soak document for user observation.

- [ ] **Step 7: Commit the QA handoff and any proven fixes**

```powershell
git add -- docs/qa/2026-08-28-steelseries-last-known-soak.md
git diff --cached --check
git commit -m "docs: add SteelSeries battery soak checklist"
```

If live confirmation proves a defect, first add a focused failing automated test, implement the smallest fix, rerun the affected focused tests and full gate, then include only those proven fix files in this commit or a separate accurately named fix commit.

- [ ] **Step 8: Verify history, cleanliness, and push**

Run:

```powershell
git status --short --branch
git log -6 --oneline --decorate
git rev-list --left-right --count origin/codex/fix-stream-deck-plugin...HEAD
git push origin codex/fix-stream-deck-plugin
git rev-list --left-right --count origin/codex/fix-stream-deck-plugin...HEAD
```

Expected: only intentional commits are present, the tracked worktree is clean, and the final ahead/behind count is `0 0`.
