# Direct Logitech HID++ Battery Design

## Goal

Read battery status for explicitly supported Logitech gaming devices without requiring Logitech G Hub. Begin with the user's G502 X Plus and retain the existing G Hub path only as a fallback while direct HID++ completes hardware validation.

## Confirmed evidence

Windows currently reports the G502 X Plus, its LIGHTSPEED receiver, and its mouse HID collection as present and healthy. That proves connection and identity, but Windows exposes no battery-level property for this device.

The receiver enumerates generic desktop, consumer-control, and vendor-defined HID collections. It does not expose the standard HID Power Device page `0x84` or Battery System page `0x85`. Its two vendor-defined collections use usage page `0xff00`, which is where Logitech HID++ traffic is carried.

The installed G Hub agent stopped listening on its local WebSocket at `localhost:9010` while its process remained alive. The current plugin therefore preserved the configured G502 identity but correctly reported its status as unavailable. This confirms that G Hub is an avoidable availability dependency rather than the only possible battery source.

## Scope

This change adds a direct, logically read-only HID++ transport for a tested allowlist. The initial hardware entry is Logitech vendor ID `0x046d`, product ID `0xc547`, displayed as `G502 X PLUS Wireless Gaming Mouse` with device type `Mouse`.

The transport may send only these HID++ requests:

- `IRoot.GetProtocolVersion` for protocol verification.
- `IRoot.GetFeature` for explicit battery feature discovery.
- Status reads from allowlisted battery feature `0x1000` function `0`, or `0x1004` function `1` when `0x1000` is absent. The live G502 X Plus receiver exposed `0x1004`.

No request may change firmware, profiles, lighting, report rate, DPI, charging policy, power state, pairing, or device configuration. Charging Control `0x1010`, DFU features, gaming configuration features, raw arbitrary requests, and undocumented writes are outside this design.

If the tested device exposes only voltage or qualitative levels, the provider reports only what the protocol returns with a documented conversion. It never estimates a percentage from voltage and never reuses a stale value as current.

## Architecture

### HID++ protocol module

A focused protocol module owns packet construction, response correlation, validation, timeout handling, and parsing. It accepts a narrow adapter interface so all request and error behavior can be tested without hardware.

Each request uses an assigned nonzero software ID and is matched by report ID, device index, feature index, function, and software ID. Unsolicited reports, responses for another application, malformed packets, HID++ errors, late responses, and responses from a stale endpoint generation are ignored or rejected without changing device state.

The protocol module exposes named operations for protocol negotiation, feature lookup, and battery status. It does not expose a general public `send` method to the provider.

### Direct endpoint discovery

Direct discovery enumerates only `node-hid` records that match an explicit allowlist entry and the Logitech vendor-defined usage page. It chooses the collection compatible with the required HID++ report length and rejects missing paths, unsupported products, duplicate endpoints, and ambiguous receiver matches.

Runtime endpoint paths and receiver device indexes are never persisted. The public Logitech identity remains the existing normalized model identity:

`model:g502 x plus wireless gaming mouse|mouse`

This preserves ordered settings and avoids creating a second row when the G Hub endpoint is also available. Full HID paths, raw report bytes, receiver indexes, and serial values are not logged or sent to the Property Inspector.

### Composite Logitech provider

The public provider remains `logitech`, but its trusted label becomes `Logitech` because G Hub is no longer the only source. The existing G Hub WebSocket client becomes an internal source behind the composite provider rather than an independent catalog provider.

Discovery proceeds in this order:

1. Enumerate allowlisted direct HID++ devices.
2. Use G Hub to discover other supported Logitech devices and as a fallback for an allowlisted device whose direct endpoint cannot be opened or negotiated.
3. Merge by the existing exact serial or unique normalized model identity, preferring direct HID++ when both sources describe the same identity.

A direct discovery success remains usable when G Hub is unavailable. A G Hub failure is not reported as a provider-wide failure when at least one direct device was discovered. The provider may expose a non-sensitive notice that only directly supported Logitech devices are currently available.

Status reads use the direct endpoint first for an allowlisted identity. G Hub is attempted only when direct HID++ returns a source-unavailable result, not when it returns a valid disconnected state or a valid battery reading. A late G Hub result cannot overwrite a newer direct result.

### Lifecycle and concurrency

Direct endpoint discovery is generation-scoped and cached by the existing catalog lifecycle. Manual refresh, resume, and maintenance refresh invalidate the endpoint generation. A status read opens the exact current endpoint, performs one bounded request sequence, and closes the handle in `finally`.

Requests for the same physical endpoint are serialized so two Stream Deck actions cannot interleave HID++ packets or consume one another's responses. Cancellation closes the request cleanly. Timeouts and endpoint loss return an honest unavailable or disconnected result and allow a later discovery to recover.

G Hub reconnect behavior remains bounded, but the composite provider initializes it lazily when fallback discovery or status is required. This prevents a permanently unavailable G Hub socket from producing repeated warnings when every configured Logitech device is supported directly.

## User interface

Existing Logitech selections keep their current order and active position. The provider badge changes from `Logitech G Hub` to `Logitech` after trusted settings parsing.

Runtime secondary text may identify `Direct HID++` or `G Hub fallback` without exposing protocol IDs or paths. The top status banner does not say that Logitech failed when direct HID++ is serving the configured mouse successfully.

No new configuration control is added. Source selection is automatic and deterministic.

## Failure behavior

- Unsupported Logitech hardware is not opened by direct HID++ and may continue through G Hub.
- An allowlisted endpoint that cannot be opened remains eligible for G Hub fallback.
- An invalid, ambiguous, or mismatched response is unavailable and is never treated as zero percent.
- A sleeping mouse may return disconnected or unavailable until a later poll. The provider does not send keep-alive or wake commands.
- If G Hub and direct HID++ both fail, the configured row remains visible as unavailable.
- Unknown VID/PID pairs fail closed and are not probed.

## Automated tests

### Protocol

- Packet builders emit only the approved root and battery-read requests.
- Protocol negotiation accepts HID++ 2.0 and rejects unrelated or malformed replies.
- Feature lookup resolves the battery feature index and rejects unsupported features.
- Battery parsing accepts documented percentages and charging states only.
- Software ID, device index, function, generation, and report length must all match.
- Timeouts, cancellation, HID++ errors, and late responses close handles and leave no pending request.
- A static safety scan rejects forbidden feature IDs and configuration request APIs.

### Direct source

- Discovery offers one G502 X Plus for the exact `0x046d:0xc547` allowlist entry.
- Generic mouse, keyboard, consumer, standard power, unknown vendor-defined, duplicate, and unknown-product collections are ignored.
- Runtime HID paths are not persisted or logged.
- Status reads return exact battery percentage, charging state, disconnected, and unavailable results.
- Concurrent reads for one endpoint are serialized.
- Endpoint invalidation rejects stale results.

### Composite provider and settings

- Direct HID++ wins when direct and G Hub return the same normalized identity.
- G Hub supplies an unsupported Logitech device without creating duplicates.
- G Hub is not initialized for a configured direct-supported device whose direct discovery and status succeed.
- G Hub fallback serves the G502 when the direct endpoint cannot be opened.
- Existing `logitech:` selections retain order and active position while the trusted provider label changes to `Logitech`.
- A G Hub outage does not produce a provider-wide failure when direct discovery succeeds.

## Live validation

Implementation cannot claim success until a bounded live probe confirms the G502 X Plus supports the chosen battery feature without changing any device setting. The probe records only protocol version, supported battery feature ID, sanitized status kind, and percentage range validation.

After the automated gate, reload the linked Stream Deck plugin and verify:

1. G Hub is stopped or its WebSocket remains unavailable.
2. The G502 row changes from unavailable to a current direct HID++ percentage.
3. The mouse sleeps and wakes without reopening the Property Inspector.
4. Cable and LIGHTSPEED transitions do not create a second selected device.
5. Multiple Stream Deck actions show the same current value without request collisions.
6. G Hub restart does not replace the direct identity or reorder devices.
7. No SteelSeries firmware prompt, Logitech configuration change, or device wake is observed.

The existing 72-hour checklist is extended to record direct source status and whether any G Hub process or endpoint was available during each observation.

## Marketplace boundary

Marketplace copy may remove the G Hub requirement only for models that pass the direct HID++ compatibility matrix. Other Logitech gaming devices remain documented as G Hub-dependent until explicitly allowlisted and tested.

No Marketplace upload, submission, or publication is part of this change.

## Design self-review

- The design replaces an avoidable G Hub dependency without pretending ordinary HID enumeration contains battery percentage.
- Direct access is limited to an exact tested allowlist and named battery-read operations.
- The existing Logitech identity and ordered settings remain compatible.
- G Hub fallback cannot override a valid direct result.
- Unknown hardware, ambiguous endpoints, malformed responses, and stale generations fail closed.
- Hardware proof and long-duration validation remain distinct from automated tests.
