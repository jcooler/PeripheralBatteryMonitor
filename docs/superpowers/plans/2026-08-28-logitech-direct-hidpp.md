# Direct Logitech HID++ Battery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read the allowlisted G502 X Plus battery directly through logically read-only HID++ requests while retaining G Hub as a lazy fallback for unsupported or inaccessible Logitech devices.

**Architecture:** Add a narrow HID++ protocol client and an allowlisted direct source, then compose that source with the existing G Hub client behind the existing `logitech` provider identity. Direct discovery and status win for the same normalized model identity; G Hub starts only when fallback coverage is needed.

**Tech Stack:** TypeScript, Vitest, node-hid 3.4.0, ws 8.21.3, Rollup, Elgato Stream Deck SDK 2

**Spec:** `docs/superpowers/specs/2026-08-28-logitech-direct-hidpp-design.md`

## Global Constraints

- Work only in `D:\DEV\SteelseriesBatteryMonitor-fix`; do not modify `D:\DEV\SteelseriesBatteryMonitor`.
- Direct HID++ is allowlisted initially to Logitech `0x046d:0xc547` and the vendor-defined `0xff00` collection required for HID++ reports.
- Permitted commands are `IRoot.GetProtocolVersion`, `IRoot.GetFeature`, and battery status function `0` for feature `0x1000`.
- Do not send keep-alive, wake, charging-control, DFU, profile, lighting, DPI, report-rate, pairing, configuration, or arbitrary caller-supplied requests.
- Never persist or log HID paths, raw packets, receiver indexes, or serial values.
- Preserve the existing `logitech:` identity namespace, ordered selections, and active position.
- A valid direct result wins; G Hub is only fallback and cannot overwrite a newer direct generation.
- Unknown hardware, unsupported protocol features, ambiguous endpoints, malformed responses, and timeouts fail closed.
- No Marketplace upload, submission, or publication is authorized.

---

### Task 1: HID++ packet and response protocol

**Files:**
- Create: `src/logitech/hidpp-protocol.ts`
- Create: `tests/logitech/hidpp-protocol.test.ts`

**Interfaces:**
- Produces: `HidppHandle`, `HidppRequest`, `HidppBatteryReading`, `HidppProtocolClient`.
- Produces: `getProtocolVersion(deviceIndex, signal)`, `getFeature(deviceIndex, 0x1000, signal)`, and `getBatteryStatus(deviceIndex, featureIndex, signal)`.
- Consumes: a handle with `write(Buffer)`, `read(timeoutMs)`, and `close()` methods supplied by the direct source.

- [ ] **Step 1: Write the failing packet tests**

Add literal fixtures proving the approved requests have exact bytes and 20-byte length:

```ts
expect(buildRootProtocolVersionRequest(1, 8)).toEqual(
  Buffer.from([0x11, 0x01, 0x00, 0x18, 0x00, 0x00, 0x5a, ...Array(13).fill(0)])
);
expect(buildRootFeatureRequest(1, 8, 0x1000)).toEqual(
  Buffer.from([0x11, 0x01, 0x00, 0x08, 0x10, 0x00, ...Array(14).fill(0)])
);
expect(buildBatteryStatusRequest(1, 8, 0x05)).toEqual(
  Buffer.from([0x11, 0x01, 0x05, 0x08, ...Array(16).fill(0)])
);
```

The test names must state that a wrong report ID, device index, feature index, function nibble, software ID, feature bytes, or length breaks response correlation or violates the request allowlist.

- [ ] **Step 2: Run the packet tests and verify RED**

Run: `npm test -- tests/logitech/hidpp-protocol.test.ts`

Expected: FAIL because `src/logitech/hidpp-protocol.ts` does not exist.

- [ ] **Step 3: Implement minimal packet builders**

Create private or narrowly exported builders that always use long report `0x11`, software ID `0x08`, and one of the three named operations. Do not expose a generic feature/function request builder outside this module.

- [ ] **Step 4: Run packet tests and verify GREEN**

Run: `npm test -- tests/logitech/hidpp-protocol.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing response-correlation tests**

Use a deterministic fake handle with complete `write`, `read`, and `close` behavior. Add literal reply fixtures covering:

```ts
const protocolReply = Buffer.from([
  0x11, 0x01, 0x00, 0x18, 0x04, 0x02, 0x5a, ...Array(13).fill(0),
]);
const featureReply = Buffer.from([
  0x11, 0x01, 0x00, 0x08, 0x05, 0x00, 0x00, ...Array(13).fill(0),
]);
const batteryReply = Buffer.from([
  0x11, 0x01, 0x05, 0x08, 73, 70, 0, ...Array(13).fill(0),
]);
```

Assert HID++ 2.0 version parsing, feature index `0x05`, battery `73`, next level `70`, and discharging state. Add independent cases for charging states `1` through `4`, invalid percentage, unsupported feature index `0`, HID++ error report `0xff`, mismatched software ID, device index, feature/function, short report, malformed length, unrelated unsolicited report followed by a valid response, timeout, and aborted signal.

- [ ] **Step 6: Run response tests and verify RED**

Run: `npm test -- tests/logitech/hidpp-protocol.test.ts`

Expected: FAIL because `HidppProtocolClient` operations are missing.

- [ ] **Step 7: Implement minimal correlated request flow**

Implement one bounded request at a time. Write the request, read until the matching response or deadline, reject matching HID++ errors, ignore unrelated reports, and map battery status byte `0` to not charging and bytes `1` through `4` to charging/full semantics. Reject status bytes `5` through `8` as unavailable rather than inventing a healthy state.

- [ ] **Step 8: Run protocol tests and typecheck**

Run: `npm test -- tests/logitech/hidpp-protocol.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 9: Commit the protocol unit**

```powershell
git add -- src/logitech/hidpp-protocol.ts tests/logitech/hidpp-protocol.test.ts
git commit -m "feat: add read-only Logitech HID++ battery protocol"
```

### Task 2: Allowlisted direct G502 source

**Files:**
- Create: `src/logitech/hidpp-source.ts`
- Create: `tests/logitech/hidpp-source.test.ts`
- Modify: `src/logitech/identity.ts`
- Modify: `tests/logitech/identity.test.ts`

**Interfaces:**
- Consumes: `HidppProtocolClient` from Task 1.
- Produces: `DirectLogitechSource` with `discover(signal)`, `readStatus(ref, signal)`, and `invalidateDiscovery()`.
- Produces: the existing persistent native identity `model:g502 x plus wireless gaming mouse|mouse` and provider ID `logitech`.

- [ ] **Step 1: Write failing allowlist discovery tests**

Create complete node-hid-shaped fixtures with vendor ID, product ID, path, product, release, interface, usage page, and usage. Prove that one exact `0x046d:0xc547` vendor-defined long-report endpoint becomes one G502 descriptor. Prove that generic mouse `0x01:0x02`, keyboard, consumer, usage `0xff00:0x01` when it lacks the required report collection, duplicate long-report endpoints, missing paths, and unknown VID/PID records are omitted.

- [ ] **Step 2: Run discovery tests and verify RED**

Run: `npm test -- tests/logitech/hidpp-source.test.ts`

Expected: FAIL because `DirectLogitechSource` does not exist.

- [ ] **Step 3: Implement exact endpoint selection**

Wrap `devicesAsync()` and `HIDAsync.open(path, { nonExclusive: true })` behind an injected adapter. Store paths and device indexes only in a generation-scoped runtime endpoint map. Reuse the existing Logitech name/type normalization helper instead of duplicating identity rules.

- [ ] **Step 4: Run discovery tests and verify GREEN**

Run: `npm test -- tests/logitech/hidpp-source.test.ts tests/logitech/identity.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing status and lifecycle tests**

Add cases proving that one open handle negotiates HID++ 2.0, resolves `0x1000`, reads battery, closes in `finally`, and returns a `BatteryStatus` with provider `logitech`, percentage, charging, and `Direct HID++` detail. Add cases for sleeping/unknown device, unsupported protocol, missing battery feature, open failure, timeout, cancellation, invalidated generation, and late results. Start two reads concurrently and prove request operations for one endpoint never overlap.

- [ ] **Step 6: Run status tests and verify RED**

Run: `npm test -- tests/logitech/hidpp-source.test.ts`

Expected: FAIL on missing status and serialization behavior.

- [ ] **Step 7: Implement bounded open-query-close and endpoint queue**

Use a per-endpoint promise tail that revalidates the endpoint generation immediately before opening. Return unavailable for protocol/feature failures and disconnected when the exact endpoint vanished from the latest discovery. Never cache battery values across reads.

- [ ] **Step 8: Run source tests and typecheck**

Run: `npm test -- tests/logitech/hidpp-source.test.ts tests/logitech/identity.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 9: Commit the direct source**

```powershell
git add -- src/logitech/hidpp-source.ts src/logitech/identity.ts tests/logitech/hidpp-source.test.ts tests/logitech/identity.test.ts
git commit -m "feat: read G502 battery through direct HID++"
```

### Task 3: Composite Logitech provider and lazy G Hub fallback

**Files:**
- Rename: `src/logitech/client.ts` to `src/logitech/ghub-client.ts`
- Create: `src/logitech/client.ts`
- Modify: `tests/logitech/client.test.ts`
- Create: `tests/logitech/provider.test.ts`
- Modify: `src/actions/settings.ts`
- Modify: `tests/actions/settings.test.ts`
- Modify: `src/devices/types.ts`
- Modify: `tests/devices/catalog.test.ts`
- Modify: `src/actions/provider-set.ts`
- Modify: `tests/actions/provider-set.test.ts`

**Interfaces:**
- Consumes: `DirectLogitechSource` and the renamed `GHubClient`.
- Produces: `LogitechClient` as the sole `DeviceProvider` registered for provider ID `logitech`.
- Preserves: existing constructor injection for tests and the current device identity shape.

- [ ] **Step 1: Write failing provider precedence tests**

Add tests showing direct and G Hub descriptors with the same native identity yield one direct-backed row; unique G Hub devices remain; direct discovery succeeds when G Hub fails; and G Hub is not initialized when direct discovery plus the configured direct status succeed. When optional G Hub discovery fails while direct devices remain usable, assert that no reconnect timer or repeated warning loop is left running.

- [ ] **Step 2: Run provider tests and verify RED**

Run: `npm test -- tests/logitech/provider.test.ts`

Expected: FAIL because no composite provider exists.

- [ ] **Step 3: Split G Hub transport without changing behavior**

Move the current class to `ghub-client.ts`, rename it `GHubClient`, and preserve its existing unit tests before composing it. Run the current Logitech client suite after the mechanical move.

- [ ] **Step 4: Implement minimal composite discovery and direct-first status**

Merge by exact `nativeId`; store a generation-scoped source map. A valid direct reading returns immediately. Only source-unavailable direct outcomes may call G Hub fallback. Disconnected direct status remains authoritative. If direct discovery returns at least one device, a G Hub outage does not reject the provider discovery. Add a composite-managed G Hub mode that performs bounded on-demand attempts without leaving the standalone client's reconnect loop active when direct coverage is healthy.

- [ ] **Step 5: Run provider tests and verify GREEN**

Run: `npm test -- tests/logitech/provider.test.ts tests/logitech/client.test.ts`

Expected: PASS.

- [ ] **Step 6: Write failing trusted-label and settings tests**

Assert that parsed and migrated Logitech references use provider label `Logitech`, preserve `nativeId`, order, and `activeDeviceKey`, and never persist runtime source labels. Assert the catalog still contains only one provider with ID `logitech`.

- [ ] **Step 7: Run label tests and verify RED**

Run: `npm test -- tests/actions/settings.test.ts tests/devices/catalog.test.ts tests/actions/provider-set.test.ts`

Expected: FAIL because the trusted label is still `Logitech G Hub` and provider construction is not composite.

- [ ] **Step 8: Update trusted labels and provider construction**

Change only trusted user-facing provider labels to `Logitech`. Keep G Hub-specific diagnostic strings inside `GHubClient`. Wire one composite `LogitechClient` into `createActiveProviders()`.

- [ ] **Step 9: Run the complete Logitech and action-focused suite**

Run: `npm test -- tests/logitech tests/actions/settings.test.ts tests/actions/provider-set.test.ts tests/actions/battery-action-adapter.test.ts tests/devices/catalog.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 10: Commit composite integration**

```powershell
git add -- src/logitech src/actions/settings.ts src/actions/provider-set.ts src/devices/types.ts tests/logitech tests/actions/settings.test.ts tests/actions/provider-set.test.ts tests/devices/catalog.test.ts
git commit -m "feat: prefer direct Logitech battery status"
```

### Task 4: Inspector source status and provider documentation

**Files:**
- Modify: `com.jcooler.peripheral-battery.sdPlugin/ui/device-list.js`
- Modify: `tests/ui/device-list.test.ts`
- Modify: `tests/ui/property-inspector.browser.test.ts`
- Modify: `docs/provider-sources.md`
- Modify: `docs/qa/2026-08-20-logitech-72-hour-soak.md`

**Interfaces:**
- Consumes: sanitized `BatteryStatus.detail` values from the composite provider.
- Produces: compact trusted secondary text naming `Direct HID++` or `G Hub fallback` without protocol identifiers.

- [ ] **Step 1: Write failing UI source-label tests**

Add real controller/model tests proving a current direct Logitech row renders `Logitech`, `Direct HID++`, and its battery percentage without raw paths or packets. Add a fallback case that renders `G Hub fallback`. Keep the existing unavailable, keyboard, drag, touch, and narrow-width behavior.

- [ ] **Step 2: Run UI tests and verify RED**

Run: `npm test -- tests/ui/device-list.test.ts tests/ui/property-inspector.browser.test.ts`

Expected: FAIL because runtime source detail is not yet represented as trusted UI text.

- [ ] **Step 3: Implement the smallest trusted source display**

Map only exact internal detail values to fixed UI copy. Continue using `textContent`; never render arbitrary detail or provider input.

- [ ] **Step 4: Run UI tests and verify GREEN**

Run: `npm test -- tests/ui/device-list.test.ts tests/ui/property-inspector.browser.test.ts`

Expected: PASS.

- [ ] **Step 5: Update provider and soak documentation**

Document the tested G502 direct source, exact allowlist, G Hub fallback boundary, and logically read-only request list. Extend the soak table with timestamp, connection mode, G Hub endpoint available yes/no, displayed source, percentage, sleep/wake result, and duplicate-row result.

- [ ] **Step 6: Commit UI and documentation**

```powershell
git add -- com.jcooler.peripheral-battery.sdPlugin/ui/device-list.js tests/ui/device-list.test.ts tests/ui/property-inspector.browser.test.ts docs/provider-sources.md docs/qa/2026-08-20-logitech-72-hour-soak.md
git commit -m "docs: expose direct Logitech battery source"
```

### Task 5: Live G502 proof, plugin reload, and final gate

**Files:**
- Create: `scripts/probe-logitech-hidpp.mjs`
- Create: `tests/scripts/probe-logitech-hidpp.test.ts`
- Create: `docs/qa/2026-08-28-g502-direct-hidpp-live.md`
- Modify only if evidence requires: files from Tasks 1 through 4

**Interfaces:**
- Consumes: the production HID++ protocol and allowlist through an exported bounded probe entry point.
- Produces: sanitized console JSON with model, protocol major/minor, supported battery feature ID, status kind, percentage-range validity, and charging state.

- [ ] **Step 1: Write a failing probe-boundary test**

Run the probe entry point against a fake adapter and assert its output omits paths, serials, raw packets, endpoint indexes, and arbitrary errors. Assert unknown hardware exits without opening a handle.

- [ ] **Step 2: Run probe test and verify RED**

Run: `npm test -- tests/scripts/probe-logitech-hidpp.test.ts`

Expected: FAIL because the bounded probe does not exist.

- [ ] **Step 3: Implement the bounded production-backed probe**

Accept no arbitrary VID, PID, feature, or function arguments. The script probes only the compiled-in G502 allowlist and prints sanitized results.

- [ ] **Step 4: Run probe test and verify GREEN**

Run: `npm test -- tests/scripts/probe-logitech-hidpp.test.ts`

Expected: PASS.

- [ ] **Step 5: Stop only the running plugin worker before the live probe**

Run: `npx streamdeck stop com.jcooler.peripheral-battery`

Verify the exact plugin Node worker exits while Stream Deck remains running. Do not stop G Hub for the first probe because its currently unavailable port is already the failure condition under test.

- [ ] **Step 6: Run one live read-only G502 probe**

Run: `node scripts/probe-logitech-hidpp.mjs`

Expected: HID++ 2.0, battery feature `0x1000`, status kind `percentage`, value in `0..100`, no device configuration change, and no raw identifiers in output. If negotiation fails, record the exact sanitized boundary and stop implementation claims; do not add speculative feature calls.

- [ ] **Step 7: Record live evidence**

Write `docs/qa/2026-08-28-g502-direct-hidpp-live.md` with the command, sanitized output, observed mouse connection mode, G Hub port state, and explicit manual limits. Do not claim sleep/wake or 72-hour behavior from one probe.

- [ ] **Step 8: Run focused and full automated verification**

Run:

```powershell
npm test -- tests/logitech tests/scripts/probe-logitech-hidpp.test.ts tests/actions/settings.test.ts tests/actions/provider-set.test.ts tests/actions/battery-action-adapter.test.ts tests/devices/catalog.test.ts tests/ui/device-list.test.ts tests/ui/property-inspector.browser.test.ts
npm test
npm run typecheck
npm run build
npm run validate
npm run pack:dry
npm audit --audit-level=high
```

Expected: every command exits `0`; validation may retain only the three pre-existing duplicate-icon warnings.

- [ ] **Step 9: Run safety and privacy scans**

Scan source, tests, scripts, docs, and bundle for forbidden HID++ feature IDs, generic request APIs, `updateCachedProperties`, firmware/configuration calls, raw HID-path logging, credentials, and capability URLs. Inspect every match rather than relying on match counts.

- [ ] **Step 10: Build unlocked and reload the linked plugin**

If Stream Deck has locked the native runtime, stop only the exact plugin worker with the Stream Deck CLI, run `npm run build`, then run `npx streamdeck restart com.jcooler.peripheral-battery`. Verify the new worker command line resolves through the installed junction to this worktree.

- [ ] **Step 11: Confirm live Stream Deck status**

With G Hub port `9010` still unavailable, select the existing G502 action and confirm the row reports `Logitech`, `Direct HID++`, and a current percentage. Confirm logs contain no repeated G Hub connection warnings, no raw identifiers, and no SteelSeries mutation or firmware warning.

- [ ] **Step 12: Commit the live proof and final implementation state**

```powershell
git add -- scripts/probe-logitech-hidpp.mjs tests/scripts/probe-logitech-hidpp.test.ts docs/qa/2026-08-28-g502-direct-hidpp-live.md
git add -u
git commit -m "test: verify direct G502 battery status"
```

- [ ] **Step 13: Verify final branch state**

Run: `git status --short && git rev-list --left-right --count master...HEAD && git log --oneline --decorate -8`

Expected: clean worktree, `0` behind `master`, and all direct HID++ commits visible ahead of `master`.
