# SteelSeries Last-Known Battery Design

## Goal

Keep an honest, useful battery reading for supported SteelSeries keyboards and headsets when SteelSeries GG stops emitting passive battery events. A reading may survive the current 15-minute freshness window and a plugin restart, but the UI must make its age clear and must never present a stale reading for a disconnected, missing, ambiguous, or identity-mismatched device.

The Apex Pro TKL Wireless and Arctis Nova Pro Wireless are the live validation devices. The behavior applies to every SteelSeries device that GG exposes with a unique native ID, exact metadata, and battery capability.

## Confirmed behavior

GG `GET /devices` reliably supplies device identity, battery capability, and current connection state for both reported devices, but it does not include battery percentage. GG emits battery percentage through its WebSocket when its own device page refreshes. The plugin currently accepts those passive events for 15 minutes and then changes the device to unavailable even while inventory still confirms it is connected.

The previous mutating GG refresh call made readings appear more often, but it was associated with an unwanted Arena device update warning. This design does not restore that call or replace it with another write.

## Safety boundary

SteelSeries access remains passive:

- HTTPS may perform only `GET /devices` against GG's validated loopback address.
- The WebSocket may receive events but may not send messages.
- The plugin may not call `updateCachedProperties`, `read_battery_status`, or any other GG device function or mutation route.
- The plugin may not probe undocumented SteelSeries HID reports as part of this change.

Automated source and built-bundle checks continue to reject GG `POST` requests, WebSocket sends, mutation route strings, and direct SteelSeries HID writes.

## Status model

A percentage status has one of two freshness states:

- **Fresh:** a validated passive battery event was observed no more than 15 minutes ago.
- **Last-known:** the validated event is more than 15 minutes old but no more than 30 days old, and a current successful GG inventory refresh confirms the exact saved device is still connected.

The 15-minute boundary is inclusive: an age of exactly 15 minutes remains fresh. A reading becomes last-known only when its age is greater than 15 minutes. A reading older than 30 days is deleted and reported as unavailable. A recently persisted reading may still be fresh after a plugin or GG restart when its timestamp is within the freshness window and new exact inventory confirms the device is connected.

`BatteryStatus` gains an optional `freshness: "last-known"` marker. Absence of the marker means the provider is reporting its normal current result. This opt-in contract leaves other providers unchanged while making the one non-current state explicit.

Fresh status preserves the latest validated charging value. Last-known status always sets charging to `null`; the UI must not show a charging bolt or claim that an old charging state is current.

Fresh and last-known percentages both require connection evidence. They may be returned only after the current GG engine generation has completed a successful `GET /devices` and the result contains one battery-capable record whose native ID, display name, and device type match the configured device and whose connection state is connected. If GG is unavailable, inventory has not refreshed in the current generation, the device is absent, or identity is ambiguous, status remains unavailable.

## Persistent cache

A focused `SteelSeriesBatteryCacheStore` owns persistence behind a narrow load, upsert, and remove interface. `SteelSeriesClient` receives the interface through constructor injection. Production supplies a Stream Deck global-settings adapter; tests use deterministic fakes.

The adapter owns one namespaced top-level key named `steelseriesBatteryCacheV1`. Its value has schema version `1` and a bounded list of at most 32 entries. Each entry contains only:

- the GG native device ID as a canonical decimal string;
- the exact GG display name and device type used for identity validation;
- an integer battery percentage from 0 through 100;
- charging as `true`, `false`, or `null` at the time of observation;
- a finite millisecond `observedAt` timestamp.

The cache never stores a GG address, HID path, USB identifier, serial number, capability URL, raw GG payload, WebSocket message, or packet bytes.

Loading validates the container and every field independently. A native ID must be the canonical decimal spelling of a non-negative safe integer. A name must contain 1 through 160 trimmed characters, and a device type must contain 1 through 80 trimmed characters. Entries with duplicate IDs, invalid IDs, invalid metadata, invalid levels, invalid charging values, non-finite timestamps, future timestamps, or timestamps older than 30 days are dropped. Valid entries are sorted newest first and truncated to 32. Unknown top-level global settings are preserved.

All adapter mutations run through one serialized read-modify-write queue. Each mutation reads the latest global settings inside that queue, changes only `steelseriesBatteryCacheV1`, and writes the merged object. This prevents two passive battery events from losing one another and prevents the cache from overwriting unrelated plugin-global settings.

Persistence failure does not invalidate a live, validated in-memory reading. The client keeps the desired in-memory cache state, emits only a generic warning without device metadata, and retries persistence on the next cache mutation. It never logs stored entries or raw settings.

## Data flow

The SteelSeries client keeps current-generation live events separate from hydrated last-known entries.

1. Before its first SteelSeries discovery or status read, the client hydrates the cache once. Concurrent callers share the same hydration promise.
2. `GET /devices` establishes the current engine generation's identity and connection evidence.
3. A valid passive battery event updates the live reading immediately. If current inventory contains one exact battery-capable device for that native ID, the client also upserts the validated cache entry. If inventory is not ready, the reading remains memory-only until a later successful discovery can validate and persist it.
4. A status read chooses the newest exact validated live or hydrated entry. It reports that entry as fresh when it is no more than 15 minutes old, otherwise as last-known, provided current inventory confirms the exact device is connected.
5. A validated device-disconnect event received over the WebSocket, or an inventory record with `connected: 0`, deletes the device from live memory and persistent cache immediately.
6. A reused native ID, metadata mismatch, duplicate identity, invalid cache entry, or entry older than 30 days is rejected and removed. It is never shown as a replacement device.

Temporary socket loss, GG restart, plugin restart, manual refresh, and provider reinitialization do not delete persistent battery history by themselves. They do clear current-generation connection evidence, so the cached percentage cannot reappear until a new exact connected inventory result succeeds.

An inventory response that omits the configured device is treated as unavailable rather than a confirmed disconnect. The cache is retained until it expires because a transient or partial GG inventory must not erase useful history.

## Key presentation

Fresh readings retain the existing percentage display, for example `85%`.

Last-known readings display `~85%`. The tilde is always present when the percentage is shown, including when the optional status-text setting is off. This ensures the key never presents an old value as exact current data.

When status text is enabled, the secondary status line uses `Last known` instead of a charging or provider claim. The fill color still represents the recorded percentage, but the charging bolt is suppressed. Existing device name, device type, cycle position, and background settings remain unchanged.

The icon generator receives an explicit optional last-known presentation flag rather than inferring freshness from provider names or detail strings.

## Property Inspector presentation

The runtime status message adds only validated fields:

- `freshness: "last-known"` when applicable;
- `observedAt` as a finite timestamp only for a last-known connected percentage.

The Property Inspector accepts those fields only with a connected status and a percentage-shaped battery label. Invalid combinations are discarded. It renders:

- connection: `Connected`;
- battery: `~85%`;
- age: a compact label such as `Last seen 23m ago`, `Last seen 4h ago`, or `Last seen 3d ago`.

Age text is calculated from the validated timestamp and never contains device-supplied markup. It rounds down to whole minutes below 1 hour, whole hours below 1 day, and whole days thereafter. Existing `textContent` rendering remains in place. The age label updates whenever the normal runtime summary refreshes; no new timer or background request is added to the Property Inspector.

Unavailable, disconnected, and fresh statuses do not carry last-known age fields. The UI remains usable at the supported narrow Property Inspector widths without hiding Remove, selection, or reorder controls.

## Error and race behavior

- A battery event received during an in-flight inventory refresh follows the existing event-sequence rule and cannot be overwritten by the older inventory snapshot.
- A disconnect event deletes battery state synchronously before its persistence operation is queued.
- A late cache load cannot overwrite a newer live event or a newer disconnect. Client generations and per-entry observation timestamps determine the winner.
- Concurrent cache writes are serialized and newest valid `observedAt` wins for one native ID.
- Clock values in the future fail closed instead of creating a reading that never becomes stale.
- Malformed GG events leave the last valid cache entry unchanged.
- A cache read or write error does not fail SteelSeries discovery and does not expose raw error data to the Property Inspector.
- A transport failure cannot turn last-known into disconnected. Disconnected is reserved for positive GG connection evidence.

## Automated verification

### Cache store

- Empty and missing global settings hydrate to an empty cache.
- Valid entries round-trip while unrelated global-settings values remain deeply unchanged.
- Malformed containers and entries, duplicates, future timestamps, expired entries, and more than 32 entries are rejected or pruned deterministically.
- Concurrent upserts and removals do not lose updates.
- A failed write leaves the desired in-memory state available and a later mutation retries it.
- Stored and logged data never contain forbidden addresses, paths, serials, URLs, payloads, or packet bytes.

### SteelSeries client

- A fresh event returns the exact percentage and charging state.
- The same connected keyboard and headset become `~percentage` last-known after 15 minutes instead of unavailable.
- A persisted keyboard or headset survives a new client instance and is shown only after exact connected inventory validation.
- Confirmed disconnect, inventory `connected: 0`, metadata mismatch, recycled ID, duplicate ID, and 30-day expiry remove the cached reading.
- Device absence, socket loss, and GG restart retain cache data but do not display it without current connection evidence.
- An event before inventory is not persisted until exact inventory validation succeeds.
- A newer event wins over hydration and in-flight inventory; a newer disconnect wins over both.
- Existing passive-only integration tests prove no HTTP mutation and no WebSocket send.

### Action and UI

- The key SVG contains `85%` for fresh and `~85%` for last-known, with no charging bolt in the latter.
- The runtime summary includes freshness and timestamp only for a valid last-known connected percentage.
- The Property Inspector renders the last-known battery and age through `textContent`, rejects malformed fields, and preserves all controls at supported widths.
- Real Chromium checks cover the device row at 250, 280, 360, and 1280 CSS pixels with minute, hour, and day age labels.

## Live validation and soak boundary

After the automated gate, build and reload the exact plugin worker. Open the Apex Pro TKL Wireless and Arctis Nova Pro Wireless pages in GG once to produce fresh passive events, then verify:

1. Both devices show fresh exact percentages.
2. Both remain connected and change to visibly last-known after the configured test freshness window without any GG page open.
3. Restarting the plugin restores last-known only after exact connected inventory validation.
4. Turning either device off clears its reading and reports disconnected.
5. After a confirmed off state clears the cache, turning the device back on remains unavailable until a new passive battery event supplies a value.
6. No Arena update warning, firmware prompt, configuration change, device wake, or unsolicited GG UI opens.

Tests and a short live run cannot prove multi-day sleep, wake, GG restart, or hardware behavior. Manual QA should therefore continue for at least 72 hours across both devices, with times and state transitions recorded separately from automated evidence.

## Marketplace boundary

Storefront copy may say that SteelSeries GG is required for identity, connection state, and passive battery events. It must not claim direct SteelSeries HID battery support or permanently current readings. The UI's tilde and age label are part of that honesty contract and must not be removed while passive GG events can stop.

No Marketplace upload, submission, or publication is included in this change.
