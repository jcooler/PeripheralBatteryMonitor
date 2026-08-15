# Stream Deck Plugin Repair Design

## Confirmed root cause

The clean implementation routes every selected SteelSeries status read through `SteelSeriesClient.getBatteryInfo()`, which unconditionally issues `POST /device/{id}/updateCachedProperties`. The only suppression is an in-memory device-ID set that is cleared on reinitialization and naturally disappears on plugin restart, so startup, restart, and reconnect paths intentionally stimulate SteelSeries GG again. Headsets also receive `POST /device/{id}/function/read_battery_status` on every poll. These are unsupported active operations and violate the passive-source requirement; the HTTPS helper also mutates the process-wide `NODE_TLS_REJECT_UNAUTHORIZED` variable while requests are in flight.

Automated tests can prove that these operations are absent after the repair. Whether their removal eliminates the Arena hardware warning must still be confirmed on the user's actual SteelSeries setup.

## Approaches considered

1. **Passive multi-provider architecture (selected).** Keep SteelSeries GG only for `GET /devices` inventory and receive-only `/sock` events; use exact Windows Bluetooth, Windows Gaming Input, Logitech G Hub, and supported HID reads where those sources provide honest stable identity. The final audit excludes XInput slots from active choices because they cannot identify physical controllers across reconnects. This retains useful coverage without invoking GG refresh/configuration operations or silently substituting hardware.
2. **Remove SteelSeries GG completely.** This is the smallest GG risk surface, but it discards useful passive inventory/events and makes many SteelSeries devices unavailable even when GG already publishes battery events.
3. **Keep GG active calls behind throttles or opt-ins.** Rejected because the requirement forbids intentionally invoking firmware checks or property refreshes at any cadence; throttling would preserve the root cause.

## Architecture

### Provider boundary

Each provider returns a `DeviceDescriptor` with a canonical provider-qualified string key, provider label, native stable identity, name, type, and optional reliable physical identity. Status results carry connection state, an exact percentage or qualitative level, charging state when known, observation time, and the provider label that supplied the value.

The provider contract separates `discover()` from `readStatus(ref)`. A central catalog owns a TTL cache and a shared in-flight discovery promise per provider. Display polling calls only `readStatus`; full Windows PnP and HID discovery is never launched by each action tick. Manual refresh explicitly invalidates discovery. Configured references remain in settings when a device is absent and render an honest unavailable/disconnected state.

SteelSeries GG is constrained in code to loopback, request-local self-signed-certificate handling, `GET /devices`, and a receive-only WebSocket. It has no generic POST-capable request API. Only devices advertising the exact `batteryLevels` capability are selectable. Missing passive battery data is unavailable, never synthesized. WebSocket data is generation- and timestamp-scoped so reconnects cannot reuse stale events.

Windows PnP reads connected battery-bearing Bluetooth device properties in one cached, read-only discovery snapshot. A separate Windows Gaming Input provider reads the exact `NonRoamableId` and direct capacity report from supported wireless Microsoft gamepad objects; it never correlates by display name or XInput slot, and normal display polls reuse the bounded snapshot. The XInput implementation preserves the API's real `Empty`, `Low`, `Medium`, and `Full` levels rather than inventing percentages, but the final safety audit excludes it from active choices because its reusable slots cannot identify physical controllers across reconnects. Legacy slot settings remain unavailable. The HID provider supports only positively identified DualSense/DualSense Edge input reports, never sends output or feature reports, uses serial identity when available, and does not fall back to another controller when an identity disappears. Logitech resolves a stable fingerprint only when unique and never silently selects a same-name device.

### Per-action state and polling

Settings contain one explicit ordered `selectedDevices` list. Its first entry is the initial device. Runtime state keeps the active key/index, settings revision, refresh generation, visibility, one in-flight refresh, one queued refresh, and one completion-scheduled timeout.

A key press advances synchronously when more than one device is selected; otherwise it requests a refresh. Device-list changes reconcile by canonical key and reset to the first entry only when the active key was removed. Display-only and polling-interval settings preserve the active key. Polling never modifies it.

Every switch, list replacement, and disappearance increments the refresh generation. A result may render only if the action is still visible and its captured generation and device key are current. An in-flight poll is never overlapped; one latest refresh is queued and coalesced. The next timer is scheduled only after completion, preventing `setInterval` accumulation and orphan timers.

### Property Inspector

The Property Inspector remains framework-free. A compact ordered list shows one row per discovered or configured device with an inclusion checkbox, order number, device name, human-readable provider badge, an “Initial” marker on row one, and accessible Up/Down controls. Saved unavailable rows stay visible. There is no separate primary selector and no native multi-select.

The refresh control reports loading, success, empty, and error text through an `aria-live` status. The UI keeps the existing dark Stream Deck/SteelSeries palette and display options. Its signature element is a narrow numbered orange order rail; everything else follows the existing native-looking controls. All settings messages include both `action` and `context`.

### Error and recovery behavior

Provider failures produce structured unavailable/disconnected results with provenance; they do not return stale data as connected. GG/G Hub reconnect handlers are socket-generation scoped. Discovery is deliberately invalidated after a provider reconnect/topology change, while repeated action polls continue using bounded snapshots. Sleep/wake, software restart, removal, or transport changes cannot remap a configured key to the first vaguely matching device.

### Testing

Vitest supplies fake HTTP/WebSocket/HID/PowerShell transports, fake timers, deferred status promises, and fake Stream Deck action handles. Regression coverage records every SteelSeries request during startup, enumeration, polling, reconnect, manual refresh, and switching and permits only passive GETs. Race tests prove stale results cannot render, polls do not overlap, cycle order is stable, unrelated settings preserve position, disappear cancels future work, and discovery caches coalesce expensive providers. Pure Property Inspector model tests cover inclusion, ordering, unavailable preservation, message shape, and all refresh states; Playwright performs final narrow-panel keyboard/layout QA.

## Design self-review

- No placeholder or unresolved product decision remains.
- The design uses one ordered list rather than the abandoned primary-plus-toggle model.
- No SteelSeries active endpoint, global TLS mutation, name fallback, or fabricated percentage is permitted.
- Native dependencies must be copied into the packaged `.sdPlugin` and validated from a clean build; otherwise HID support must fail closed as unavailable.
