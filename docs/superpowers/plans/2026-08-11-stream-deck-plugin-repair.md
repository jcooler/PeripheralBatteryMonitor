# Stream Deck Plugin Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the Stream Deck plugin so SteelSeries GG is passive-only, device cycling and polling are deterministic and race-safe, expensive discovery is cached, and the Property Inspector presents one accessible ordered device list.

**Architecture:** Provider-qualified descriptors/statuses sit behind a cached catalog; a per-action session coordinator owns ordered selection, generation-guarded rendering, and completion-scheduled polling. The Property Inspector stores the same ordered list and uses a small testable vanilla-JavaScript model.

**Tech Stack:** TypeScript ES2022, `@elgato/streamdeck`, Node HTTPS/WebSocket/child-process APIs, `node-hid` async input reads, Vitest, vanilla HTML/CSS/JavaScript, Playwright for final QA, Stream Deck CLI validation.

## Global Constraints

- Never issue `updateCachedProperties`, SteelSeries device-function POSTs, firmware checks, configuration, or property-refresh operations.
- Never mutate process-wide TLS settings; localhost self-signed handling must be request-local and loopback-restricted.
- Never fabricate battery percentages or silently substitute another device.
- Persist one ordered `selectedDevices` list; first entry is initial, polling and unrelated settings preserve active position.
- At most one refresh runs per Stream Deck action, and stale generations cannot render.
- Cache discovery separately from status; explicit refresh invalidates it, display polls do not launch full CIM/HID/XInput discovery.
- Do not install/deploy into the live Stream Deck directory.
- Preserve the original dirty worktree at `D:\DEV\SteelseriesBatteryMonitor` unchanged.

---

### Task 1: Test harness and provider contracts

**Files:**
- Modify: `package.json`, `package-lock.json`, `tsconfig.json`
- Create: `src/devices/types.ts`, `src/devices/catalog.ts`
- Create: `tests/devices/catalog.test.ts`, `tests/helpers/deferred.ts`

**Interfaces:**
- Produces: `DeviceProvider`, `DeviceDescriptor`, `DeviceRef`, `BatteryStatus`, `DeviceCatalog.discover(force)`, and `DeviceCatalog.readStatus(ref, signal)`.

- [ ] Add pinned Vitest/CLI/HID dependencies and reproducible `test`, `typecheck`, `validate`, and build-before-pack scripts.
- [ ] Write catalog tests whose production-breaking mutations are repeated provider discovery, duplicate in-flight discovery, provider/hash collisions, and implicit fallback.
- [ ] Run the focused tests and verify the expected missing-module/API failure.
- [ ] Implement provider-qualified keys, structured provenance/status, TTL/single-flight discovery, exact dispatch, and explicit invalidation.
- [ ] Run focused tests, full tests, typecheck, and build; inspect the lockfile diff; commit the verified harness/catalog milestone.

### Task 2: Passive SteelSeries provider

**Files:**
- Modify: `src/steelseries/client.ts`, `src/steelseries/types.ts`
- Create: `tests/steelseries/client.test.ts`, `tests/steelseries/no-mutations.integration.test.ts`

**Interfaces:**
- Consumes: device/provider contracts from Task 1.
- Produces: passive `SteelSeriesClient.discover()` and `readStatus()` plus generation-scoped reconnect behavior.

- [ ] Write failing tests that exercise startup, discovery, status polling, socket reconnect, manual force refresh, and repeated reads while recording every HTTP method/path and WebSocket send.
- [ ] Verify failures demonstrate the current POST calls, global TLS mutation, permissive device filter, stale events, and sticky initialization.
- [ ] Replace generic fetch/POST behavior with loopback-validated request-local HTTPS GET `/devices`; make the WebSocket receive-only and epoch-scoped.
- [ ] Filter only exact battery-capable devices; return unavailable when no fresh passive event exists; clear stale maps on engine generation changes.
- [ ] Re-run focused/full tests, typecheck, build, and a repository-wide mutating-endpoint scan; commit the passive-SteelSeries milestone.

### Task 3: Windows Bluetooth, XInput, Logitech, and HID providers

**Files:**
- Modify: `src/xbox/client.ts`, `src/logitech/client.ts`, `rollup.config.mjs`
- Create: `src/windows/client.ts`, `src/hid/client.ts`
- Create: `tests/windows/client.test.ts`, `tests/xbox/client.test.ts`, `tests/logitech/client.test.ts`, `tests/hid/client.test.ts`

**Interfaces:**
- Consumes: provider contracts from Task 1.
- Produces: exact-identity provider implementations with cached discovery and honest status values.

- [ ] Write failing passive PowerShell/HID/WebSocket tests, including timeout/abort cleanup, qualitative XInput states, unique Logitech remapping, HID serial/path transitions, and no output writes.
- [ ] Verify each test fails for the intended missing/incorrect behavior.
- [ ] Implement one read-only PnP snapshot, bounded XInput snapshots with qualitative labels, reconnect-safe Logitech requests, and DualSense input-only HID parsing.
- [ ] Copy the external native HID runtime and required transitive modules into the plugin during build; fail closed when unavailable.
- [ ] Run provider/full tests, typecheck, build, and inspect package contents; commit the verified provider milestone.

### Task 4: Ordered action session and race-safe polling

**Files:**
- Rewrite: `src/actions/battery-action.ts`
- Create: `src/actions/action-session.ts`, `src/actions/settings.ts`
- Modify: `src/types.ts`, `src/utils/icon-generator.ts`, `src/plugin.ts`
- Create: `tests/actions/settings.test.ts`, `tests/actions/action-session.test.ts`, `tests/actions/battery-action.integration.test.ts`, `tests/utils/icon-generator.test.ts`

**Interfaces:**
- Consumes: `DeviceCatalog`, `DeviceRef`, `BatteryStatus`.
- Produces: `ActionSession.appear/updateSettings/keyDown/disappear/requestRefresh`, legacy-settings migration, and renderer provenance/qualitative-state support.

- [ ] Write deferred-promise/fake-timer failures for exact cycle order, first initial entry, unrelated-settings preservation, list-change reconciliation, old-result suppression, no overlapping polls, disappear-during-startup, and discovery-not-called-by-status.
- [ ] Verify red failures individually.
- [ ] Implement the per-context state machine, one queued refresh, generation/key render gate, completion-scheduled timeout, and exact provider lookup.
- [ ] Migrate legacy single-device settings once without inventing identity; configured missing entries remain visible and unavailable.
- [ ] Render provider source and qualitative/unavailable states without changing existing percentage display options.
- [ ] Run focused/full tests, typecheck, and build; commit the action/session milestone.

### Task 5: Ordered Property Inspector

**Files:**
- Rewrite: `com.jcooler.peripheral-battery.sdPlugin/ui/battery.html`
- Create: `com.jcooler.peripheral-battery.sdPlugin/ui/device-list.js`
- Create: `tests/ui/device-list.test.ts`, `tests/ui/property-inspector.test.ts`

**Interfaces:**
- Consumes/produces: `selectedDevices: DeviceRef[]`; sends `{ event: "setSettings", action, context, payload }`; receives structured discovery success/empty/error payloads.

- [ ] Write failing model/message tests for checkbox inclusion, explicit order, Up/Down, first-row initial marker, unavailable preservation, provider labels, refresh states, and required `action`/`context` fields.
- [ ] Verify red failures before replacing the UI.
- [ ] Build the compact numbered order rail with accessible labels, buttons, visible focus, `aria-live` refresh feedback, and all existing display controls.
- [ ] Run UI/full tests, typecheck, build, and headless Playwright at narrow and desktop widths; fix reported layout/keyboard/console failures.
- [ ] Commit the verified Property Inspector milestone.

### Task 6: Documentation, packaging, and final audit

**Files:**
- Modify: `package.json`, `com.jcooler.peripheral-battery.sdPlugin/manifest.json`, `.gitignore`
- Create: `README.md`, `docs/provider-sources.md`, `.sdignore` if package inspection requires it

**Interfaces:**
- Documents the exact provider/status provenance, unsupported/unavailable cases, migration behavior, limitations, and manual hardware checks.

- [ ] Update product copy and document each provider's source and confidence/limitations.
- [ ] Run `npm ci`, full tests, typecheck, build, Stream Deck validate, dry-run pack, and non-installing package creation.
- [ ] Run `npm audit --audit-level=high`, review lockfile hosts/scripts, scan for secrets/generated files and all GG methods/paths, and inspect the final diff.
- [ ] Run a read-only whole-branch code review; fix all critical/important findings with focused tests and re-verify.
- [ ] Commit final documentation/packaging fixes and record all commit hashes and hardware-only verification steps.
