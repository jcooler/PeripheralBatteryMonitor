# Logitech Identity Recovery and Ordered Inspector Design

## Goal

Make serial-less Logitech gaming devices, beginning with the G502 X Plus, survive G Hub restarts, sleep/wake cycles, and regenerated `dev000000##` endpoint IDs without silently switching to different hardware. Refine the existing ordered Property Inspector so cycle order and recovery state are immediately understandable in Stream Deck's narrow panel.

This release continues to use Logitech G Hub as the Logitech status source. Direct HID++ is a later, separately tested provider and is not part of this patch.

## Confirmed failure

The live G Hub device list reported the user's G502 X Plus as `dev00000001`, with no `serialNumber`, `serial`, or `deviceSerialNumber`. The active Stream Deck profile retained an earlier Logitech reference with `nativeId: session:dev00000006` and a saved name of `Pro Wireless Mouse`.

The current Logitech provider promotes the G Hub endpoint ID into persisted identity whenever no serial is present. On socket loss it correctly clears its endpoint map and rediscovers, but the rediscovered device is keyed by the new session ID. `readStatus()` then cannot find the old persisted key and returns unavailable indefinitely. Reopening the Property Inspector and selecting the device creates a new setting, which explains the apparent temporary recovery.

The existing Marketplace GHub Battery plugin uses the same session-ID strategy and has an unresolved sleep/wake selection-reset report. We will not copy its fallback-to-first-device behavior.

## Identity model

### Persistent identities

Logitech discovery assigns identity in this order:

1. `serial:<normalized serial>` when one of G Hub's serial fields is present.
2. `model:<normalized display name>|<normalized device type>` when no serial is present and exactly one current battery-capable Logitech device has that model fingerprint.
3. No selectable descriptor when a serial-less model fingerprint is duplicated. Discovery reports an ambiguity diagnostic rather than choosing an endpoint.

Normalization trims, Unicode-normalizes, collapses internal whitespace, and lowercases using a locale-independent rule. It does not apply fuzzy matching, substring matching, or broad device-type matching. Marketing-name aliases such as `Pro Wireless Mouse` versus `G502 X Plus` are not assumed to be the same model.

The G Hub `dev000000##` ID remains runtime-only. The provider stores a map from persistent native identity to the current G Hub endpoint record. Battery requests always use the endpoint record's current `device.id`.

### Physical identity and deduplication

Serial-backed descriptors use the serial as `physicalId`. Model-backed descriptors use a Logitech-scoped model fingerprint as `physicalId` only while unique. This prevents duplicate Logitech rows within one discovery result without claiming that a same-name device from another provider is physically identical unless that provider exposes a genuinely correlatable hardware identity.

### Legacy migration

Settings migration handles both v1 fields (`logiDeviceId`, `deviceName`) and schema-v2 selections whose Logitech `nativeId` starts with `session:`.

Migration occurs only after successful Logitech discovery:

- If the old session endpoint still exists, its current descriptor replaces the saved reference.
- Otherwise, the saved normalized name and device type may match exactly one discovered Logitech descriptor.
- A saved generic type of `Device` may adopt the exact unique name match's current type.
- Zero or multiple exact matches remain unavailable and are not persisted as a new identity.
- Migration never uses the first device, a substring, or type alone.

When migration is unique, the action persists the canonical descriptor once while preserving its position in `selectedDevices` and preserving `activeDeviceKey` by translating the old key to the new key. Other display settings remain unchanged.

The user's saved `Pro Wireless Mouse` cannot safely be inferred to be the currently attached `G502 X Plus`; it remains unavailable until the user explicitly selects G502 X Plus. Once selected, the model identity will survive later G Hub endpoint changes.

## Reconnect and recovery flow

The Logitech socket continues to use generation-scoped requests and bounded exponential reconnects. On socket loss it clears runtime endpoints. On the next successful connection it forces Logitech discovery when the provider had previously discovered devices.

Successful discovery atomically replaces the persistent-identity-to-endpoint map. A failed discovery leaves no endpoints advertised as live and schedules later recovery through the existing connection/discovery path. It never serves a newly connected state using an endpoint from an older socket generation.

Diagnostic logging records:

- G Hub connection opened, lost, and reconnect scheduled, without noisy stack traces for normal sleep transitions.
- Discovery counts and whether identities are serial-backed or unique-model-backed.
- Persistent identity remapped from one G Hub session endpoint to another.
- Ambiguous serial-less model fingerprints.
- Failed status reads with provider identity and a sanitized reason.

No serial numbers, full HID paths, request payloads, or other sensitive identifiers are emitted at normal log level.

## Property Inspector

The existing framework-free inspector keeps one ordered device list and all current display controls. Selected rows appear first; discovered but unselected devices follow with inclusion controls. Missing configured devices remain visible as unavailable.

For selected rows:

- A numbered circle at the left displays cycle position `1`, `2`, and so on.
- Row one is the initial device and the current runtime device is identified separately when runtime state is available.
- A single drag grip at the right reorders selected rows using HTML drag-and-drop and pointer-friendly behavior.
- Up/down arrow buttons are removed.
- Keyboard accessibility is preserved through a focused row plus `Alt+ArrowUp` and `Alt+ArrowDown` reorder commands, announced through an `aria-live` region. Dragging is never the only accessible mechanism.
- Device name, trusted provider label, availability/connection state, and latest battery value are shown in compact secondary text.

Unselected devices use an explicit inclusion checkbox and do not show a cycle number or drag grip. The refresh button exposes loading, success, empty, partial-provider-error, and full-error states. A concise recovery message such as “G502 X Plus reconnected through G Hub” appears only after an actual identity remap and clears on the next ordinary interaction or refresh.

The UI does not expose raw `dev000000##` IDs, serial values, or provider implementation jargon. It uses the approved ordered-status-list layout and remains usable at the Stream Deck Property Inspector's narrow width.

## State and message changes

`DeviceDescriptor` remains the persisted public shape. Logitech model identities fit its existing `nativeId` field, avoiding a schema-version bump solely for this repair.

Discovery responses gain optional non-sensitive provider notices for ambiguity and recovery. Runtime action state may send an optional current-device key and latest status summaries to the open Property Inspector. These messages are additive; older settings remain parseable.

The pure UI model replaces `moveSelectedDevice(key, direction)` as the primary interaction with `reorderSelectedDevice(key, targetIndex)`. The directional helper may remain as a keyboard adapter. Reordering persists the same `selectedDevices` array contract.

## Tests

### Logitech provider

- A serial-backed MX Keys retains `serial:` identity when its G Hub endpoint changes.
- A serial-less G502 X Plus retains `model:` identity across `dev00000006` to `dev00000001` and reads battery from the new endpoint.
- Socket loss clears stale endpoints and rediscovery restores status without manual selection.
- Two identical serial-less devices are omitted as ambiguous and are never silently paired.
- Same-type or substring-similar Logitech devices do not match.
- Unicode, case, and whitespace normalization is deterministic.
- Failed reconnect discovery retries and later recovers.
- Logs identify remapping and ambiguity without serials or raw sensitive paths.

### Settings and action migration

- A unique exact legacy name migrates in place and preserves ordering, active position, and display options.
- A generic legacy type may adopt the exact name match's type.
- A stale name that no longer matches, including `Pro Wireless Mouse` versus `G502 X Plus`, remains unavailable.
- Ambiguous names are not persisted.
- Migration writes settings once and does not cause a refresh loop.

### Property Inspector

- Selected rows show consecutive cycle numbers and one drag grip each.
- Pointer/drag reorder writes the expected ordered list.
- Keyboard reorder produces the same list and an accessible announcement.
- Arrow buttons are absent.
- Unselected rows retain inclusion checkboxes.
- Current, sleeping, unavailable, recovered, partial-error, and loading states render safely.
- Names and notices are inserted as text, never HTML.
- Narrow-width browser QA finds no clipping, horizontal scrolling, console errors, or inaccessible controls.

## Long-duration manual QA

Automated tests simulate endpoint regeneration and sleep/reconnect races, but release confidence requires soak testing because the reported defect may take hours or days.

The beta checklist is:

1. Configure G502 X Plus and MX Keys, note their order, and leave Stream Deck running for at least 72 hours.
2. Restart G Hub while both devices are awake; confirm both return without reopening settings.
3. Let each device sleep and wake independently.
4. Sleep and resume Windows several times, including an overnight sleep.
5. Connect the mouse by cable, return to LIGHTSPEED, and confirm the configured logical device remains selected.
6. Restart Stream Deck before G Hub, then launch G Hub later.
7. Confirm no action silently changes to another Logitech device and no SteelSeries firmware prompt occurs.
8. Export plugin logs if a tile remains unavailable; the logs must reveal connection, discovery, remap, ambiguity, and status transitions without sensitive identifiers.

## Marketplace boundary

This patch improves the G Hub-backed provider and UI but does not claim universal Logitech support. Marketplace copy will state that Logitech gaming support requires G Hub and that support depends on devices exposing battery state through its local service. Direct HID++ will be released later behind a tested-device matrix.

The plugin will be validated and packaged without installing into the live Stream Deck directory. Marketplace submission remains gated on automated verification, 72-hour hardware soak results, icon/metadata review, dependency/license audit, and Stream Deck CLI validation.

## Design self-review

- The design does not persist or fall back to G Hub session IDs.
- It never selects the first device or matches by type alone.
- It distinguishes the user's stale `Pro Wireless Mouse` setting from the G502 X Plus instead of guessing.
- Drag reordering has an explicit keyboard equivalent.
- The UI mockup's redundant arrow buttons are removed and replaced with meaningful cycle numbers.
- Direct HID++ is intentionally out of scope for this patch.
- Automated and multi-day hardware verification responsibilities are explicit.
