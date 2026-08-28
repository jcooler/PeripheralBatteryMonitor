# Logitech 72-hour beta soak checklist

This checklist is the remaining owner-controlled hardware gate for Logitech beta readiness. Automated tests, a bounded direct-HID++ probe, and browser QA do not close an intermittent multi-day hardware defect. A development plugin may be reloaded for this manual test, but do not mark the defect closed or submit to Marketplace until the owner completes and accepts this soak.

## Run record

- Plugin commit: ____________________
- Plugin version: ____________________
- Stream Deck version: ____________________
- G Hub version: ____________________
- Direct HID++ probe commit/result: ____________________
- Windows version: ____________________
- G502 X Plus connection mode at start: ____________________
- MX Keys connection mode at start: ____________________
- Soak start timestamp with time zone: ____________________
- Soak end timestamp with time zone: ____________________
- Overall result, `PASS`, `FAIL`, or `BLOCKED`: ____________________
- Owner initials: ____________________

Record a timestamp and result for every scenario. Use `PASS`, `FAIL`, or `BLOCKED`; attach exact observations for any result other than `PASS`. A passing observation must confirm that the configured device identity did not silently switch to another device.

## Required scenarios

For every G502 observation, record the source shown in the Property Inspector. `Direct HID++` is expected when the allowlisted endpoint answers; `G Hub fallback` is expected only when direct status is unavailable and G Hub can answer.

| Timestamp with time zone | Connection mode | G Hub endpoint available, YES/NO | Displayed source | Percentage or unavailable state | Sleep/wake result | Duplicate row, YES/NO | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |

### 1. G502 X Plus plus MX Keys order retention

Configure G502 X Plus first and MX Keys second, close the Property Inspector, reopen it, cycle both devices, and repeat after at least one ordinary Stream Deck restart. Confirm consecutive order numbers and the same initial active device.

- Timestamp with time zone: ____________________
- Result: ____________________
- Observed order and active device: ____________________
- Notes or evidence: ____________________

### 2. G Hub restart and fallback boundary

With the Property Inspector closed and the plugin displaying the configured G502 X Plus, exit and restart G Hub. Do not reopen the Property Inspector. Confirm direct HID++ remains usable when available. If direct access is unavailable, confirm G Hub fallback regenerates its current endpoint and resumes the same configured identity without creating a duplicate row.

- Timestamp with time zone: ____________________
- Result: ____________________
- Time until recovery: ____________________
- Displayed device before and after: ____________________
- Notes or evidence: ____________________

### 3. Independent device sleep and wake

Allow the G502 X Plus and MX Keys to sleep independently, then wake each one independently. Confirm sleeping or unavailable state is honest, the other device remains usable, and each device returns to its own saved position and identity.

- G502 X Plus sleep timestamp and result: ____________________
- G502 X Plus wake timestamp and result: ____________________
- MX Keys sleep timestamp and result: ____________________
- MX Keys wake timestamp and result: ____________________
- Notes or evidence: ____________________

### 4. Windows sleep and resume

Put Windows to sleep while both devices are configured, then resume. Confirm discovery and battery display recover without reopening the Property Inspector and without changing selection or order.

- Sleep timestamp with time zone: ____________________
- Resume timestamp with time zone: ____________________
- Result: ____________________
- Time until recovery: ____________________
- Notes or evidence: ____________________

### 5. G502 X Plus cable to LIGHTSPEED transition

Begin with the configured G502 X Plus connected by cable, then disconnect the cable and continue over LIGHTSPEED. Repeat in the reverse direction. Confirm the saved identity is retained, the current endpoint is refreshed as needed, and the plugin never selects a different matching device.

- Cable to LIGHTSPEED timestamp and result: ____________________
- LIGHTSPEED to cable timestamp and result: ____________________
- Displayed device before and after: ____________________
- Notes or evidence: ____________________

### 6. Stream Deck before G Hub startup

Start Stream Deck while G Hub is not running. Confirm the G502 X Plus uses `Direct HID++` when its receiver answers; otherwise observe an honest unavailable state. Then start G Hub without reopening the Property Inspector. Confirm any fallback-only Logitech devices recover in their saved order and the G502 row is not duplicated.

- Stream Deck startup timestamp with time zone: ____________________
- G Hub startup timestamp with time zone: ____________________
- Result: ____________________
- Time until recovery: ____________________
- Notes or evidence: ____________________

### 7. No silent device switch

Throughout the 72-hour window, compare the displayed device, configured order, and physical device being used after every reconnect, refresh, sleep, resume, and transport transition. If an identical serial-less model is present, confirm it is omitted as ambiguous rather than selected by guesswork.

- First verification timestamp and result: ____________________
- Midpoint verification timestamp and result: ____________________
- Final verification timestamp and result: ____________________
- Any identity or order mismatch: ____________________
- Notes or evidence: ____________________

### 8. No SteelSeries firmware prompt

Keep any configured SteelSeries device and GG available during the soak. Confirm the plugin never causes a firmware prompt, device-property refresh, or other mutating SteelSeries operation during startup, polling, refresh, reconnect, sleep, or resume.

- First verification timestamp and result: ____________________
- Final verification timestamp and result: ____________________
- Firmware prompt observed, `YES` or `NO`: ____________________
- Notes or evidence: ____________________

## Final owner decision

- All eight scenarios have timestamped results: `YES` / `NO`
- Any `FAIL` or unresolved `BLOCKED` result remains: `YES` / `NO`
- Owner accepts the 72-hour soak: `YES` / `NO`
- Defect may be marked closed: `YES` / `NO`
- Live installation authorized separately: `YES` / `NO`
- Marketplace submission authorized separately: `YES` / `NO`
- Decision timestamp with time zone: ____________________
- Owner initials: ____________________
