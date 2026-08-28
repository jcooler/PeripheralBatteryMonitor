# G502 X Plus direct HID++ live proof

## Result

PASS for one bounded live battery read on 2026-08-28 at 09:20 Eastern time.

The exact command was:

```powershell
node scripts/probe-logitech-hidpp.mjs
```

Sanitized output:

```json
{"model":"G502 X PLUS Wireless Gaming Mouse","protocol":{"major":4,"minor":2},"batteryFeature":"0x1004","statusKind":"percentage","percentage":47,"percentageInRange":true,"charging":false}
```

The process exited `0`. The probe accepted no hardware or protocol arguments, used the compiled-in `046d:c547`, `ff00:02` allowlist, and printed no path, serial, receiver index, feature index, or packet bytes.

## Conditions and observations

- The Stream Deck CLI stopped only `com.jcooler.peripheral-battery` before the probe. Stream Deck itself and Logitech G Hub remained running.
- The endpoint was the allowlisted G502 X Plus LIGHTSPEED receiver collection. No Bluetooth or wired-direct claim is made.
- The first live feature lookup proved `0x1000` absent. Current HID++ implementations that support this mouse identify `0x1004` as the alternate unified-battery feature, so the implementation added only its named status function `1` and repeated the probe.
- One intervening negotiation attempt timed out. A bounded second attempt of the identical read-only packet was added; the final proof then returned HID++ `4.2` and a valid `0x1004` percentage.
- G Hub port `9010` was reachable when checked at `2026-08-28T09:20:44-04:00`. This run therefore proves direct HID++ works while G Hub is present, not that final plugin behavior has been observed with G Hub stopped.
- The allowed traffic was limited to protocol negotiation, root lookups for battery features `0x1000` and `0x1004`, and the `0x1004` status read. No keep-alive, wake, charging-control, DFU, profile, lighting, DPI, report-rate, pairing, or configuration command was sent.

## Manual limits

This single proof does not establish sleep/wake recovery, Windows resume recovery, cable/LIGHTSPEED transitions, multi-day stability, or absence of duplicate rows over time. Those remain owner-controlled items in `docs/qa/2026-08-20-logitech-72-hour-soak.md`. Marketplace submission remains separately unauthorized.
