# Battery status providers

Every catalog entry and status carries a provider-qualified identity and a human-readable provider label. The Property Inspector always shows the provider badge. When **Show status text** is enabled, an available battery icon also names the provider that supplied that displayed status.

| Provider label | Discovery source | Displayed status source | Stable identity and limitations |
| --- | --- | --- | --- |
| **SteelSeries GG** | Loopback `GET /devices`, filtered to the exact `batteryLevels` capability | Fresh, receive-only GG WebSocket battery and connection events | Exact GG numeric device ID. After a reconnect, the re-enumerated ID must also retain the saved display name and type before fresh events are accepted. There is no name-based fallback. GG exposes no hardware serial through this inventory shape, so a same-ID, same-name, same-type replacement cannot be distinguished without hardware confirmation. Missing or expired passive data is **Unavailable**. Arena speakers and all devices without the exact battery capability are excluded. |
| **Windows Bluetooth** | One bounded, read-only Windows PnP/CIM snapshot | The latest validated 0–100 battery and connection properties from that snapshot | Canonical Bluetooth PnP Device ID; a reliable Container ID is retained for deduplication. Unknown connection state is **Unavailable**. Windows only. |
| **XInput** *(legacy unavailable only)* | Not included in the active catalog | No displayed battery status | XInput exposes only one of four reusable session slots, not stable physical identity. A different controller can occupy the same slot after reconnect, so the plugin deliberately does not offer XInput choices. Existing v1 slot settings remain visible and report **Unavailable** rather than being remapped. |
| **Logitech G Hub** | G Hub WebSocket `GET /devices/list` | G Hub WebSocket `GET /battery/{exact endpoint}/state` | Explicit hardware serial when G Hub supplies one; otherwise the exact G Hub session ID. A changed session-only ID requires catalog refresh/reselection. No display-name fallback and no stale value is reported as connected. |
| **HID** | Cached `node-hid` enumeration of exact Sony DualSense/DualSense Edge gamepad collections | One input report read from the endpoint already matched to the configured serial | Normalized controller serial. Only complete supported USB/Bluetooth input reports are parsed; Bluetooth checksums are validated. The provider never writes output or uses feature reports. Devices without serial/usage metadata are hidden. |

## Discovery and live polling

Discovery is shared across all actions, coalesced, and maintained separately from display polling. It runs at startup, on explicit Property Inspector refresh, after a detected sleep/resume, and on a five-minute maintenance interval. SteelSeries performs one additional passive inventory GET after its receive-only socket reconnects, but only when inventory had previously been requested. A normal display poll calls only the selected provider’s `readStatus`; it does not launch PnP, HID, XInput, or GG inventory enumeration.

An explicit refresh invalidates provider discovery generations. An older scan cannot overwrite the new catalog. Configured references survive catalog removal and render an honest disconnected or unavailable state until the same exact identity returns.

Legacy single-device settings are migrated only from their exact provider-native ID. Before a legacy SteelSeries selection is persisted in the ordered schema, its saved name and exact ID must resolve to the same current inventory entry so the canonical type metadata can be stored. If that verification is unavailable, the old setting is left intact and the action remains unavailable rather than selecting another device.

## Duplicate handling

Devices are merged only when providers expose the same reliable physical identity. Provider names, display names, numeric hashes, and brand matches are never used for correlation. When the same exact physical identity is available from multiple sources, direct HID is preferred, followed by Windows, Logitech G Hub, and passive SteelSeries GG.
