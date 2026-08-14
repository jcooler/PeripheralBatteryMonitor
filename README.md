# Peripheral Battery Monitor

A Stream Deck plugin that displays battery status for an explicit ordered list of peripherals. Pressing the key advances to the next selected device. The first selected row is used when an action has no saved position; after cycling, each action remembers its own last selected device across profile/page returns and plugin or action restarts. When multiple devices are selected, a row of small dots at the bottom of the key highlights the active position.

## SteelSeries safety boundary

SteelSeries GG is treated as a passive source. The plugin permits only loopback `GET /devices` inventory and receive-only WebSocket events. It does not call `updateCachedProperties`, device-function endpoints, firmware/update checks, configuration endpoints, or WebSocket `send`, and it does not change process-wide TLS settings.

If GG has not passively emitted a fresh battery event, the key shows **Unavailable**. It does not synthesize a value or stimulate the device to obtain one. Removing the mutating operations is covered by automated lifecycle tests; confirming that this eliminates the Arena warning still requires a real-hardware run.

GG inventory supplies an exact numeric device ID but no hardware serial in the response used here. Reconnect recovery re-enumerates once, requires the saved name and type to remain consistent, clears old live values, and waits for a fresh event. Hardware must still confirm GG's ID behavior for an otherwise identical replacement device.

## Configure an action

1. Add **Battery Monitor** to a Stream Deck key.
2. Open the Property Inspector and refresh the device catalog.
3. Check each device to include it.
4. Use the arrow buttons to set cycle order. Row 1 is marked **Default** and is the fallback if a saved device is removed.
5. Choose the existing polling and display options.

Configured devices remain in the list when disconnected. They are never silently replaced by a same-name, same-brand, or first available device.

See [provider sources](docs/provider-sources.md) for the exact source, identity, status precision, and limitations of every provider.

## Development

```powershell
npm ci
npm test
npm run typecheck
npm run build
npm run validate
npm run pack:dry
```

`npm run build` bundles the plugin and copies the pinned `node-hid` runtime into the `.sdPlugin`; it does not install the plugin into Stream Deck. `npm run pack` creates a package in `dist` without deploying it.

## Hardware checks before release

- Run the built plugin with the affected SteelSeries and Arena hardware, keep GG open, and confirm no firmware/update warning appears during startup, refresh, polling, switching, GG restart, sleep/wake, or device reconnect.
- Confirm a supported SteelSeries battery device receives passive events and that absent events show **Unavailable**.
- Exercise Windows Bluetooth disconnect/reconnect, a G Hub restart, and DualSense USB/Bluetooth transitions.
- Verify device ordering, missing-device retention, per-action cycle-position persistence, the active-position dots, and narrow Property Inspector keyboard navigation on a real Stream Deck installation.

Legacy XInput slot selections remain visible as unavailable. XInput is not offered for new selections because its four reusable session slots cannot identify a physical controller safely after reconnect; use a stable Windows or HID entry when one is available.
