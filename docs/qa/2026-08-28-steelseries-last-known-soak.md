# SteelSeries last-known battery 72-hour soak checklist

This checklist is the remaining owner-controlled hardware gate for the Apex Pro TKL Wireless and Arctis Nova Pro Wireless last-known battery behavior. Automated tests and one bounded local plugin reload do not prove 72-hour hardware behavior, including GG restarts, sleep/wake, connection transitions, device switching, or the continued absence of firmware prompts.

## Run record

- Plugin commit: ____________________
- Plugin version: ____________________
- Stream Deck version: ____________________
- SteelSeries GG version: ____________________
- Windows version: ____________________
- Soak start timestamp with time zone: ____________________
- Soak end timestamp with time zone: ____________________
- Overall result, `PASS`, `FAIL`, or `BLOCKED`: ____________________
- Owner initials: ____________________

Keep the Property Inspector available for display checks, but open each GG device page only when the applicable row instructs you to. Record a timestamp and result for every row. Use `PASS`, `FAIL`, or `BLOCKED`, and attach exact observations for any result other than `PASS`. A `~percentage` is a last-known value; a percentage without `~` is fresh.

Do not accept firmware/update prompts or change GG device settings while running this checklist. If GG presents a prompt, record it and close or defer it without accepting it.

## Required observations

| Device | Checkpoint | Expected result | Timestamp and observed value/state | Result | Notes or evidence |
| --- | --- | --- | --- | --- | --- |
| Apex Pro TKL Wireless | Open the Apex GG device page once and observe the Stream Deck key and Property Inspector. | Both show the same fresh connected percentage without `~`; record the time and value. |  |  |  |
| Arctis Nova Pro Wireless | Open the Arctis GG device page once and observe the Stream Deck key and Property Inspector. | Both show the same fresh connected percentage without `~`; record the time and value. |  |  |  |
| Apex Pro TKL Wireless | Close the GG device page after a fresh event and leave it closed until the reading ages to last-known. | Without reopening GG, the key changes to `~percentage`, while the Property Inspector remains `Connected`, shows the same `~percentage`, and shows a `Last seen` age that matches elapsed time from the recorded fresh event under the minute/hour/day rounding rules. Record the transition time, key value, Property Inspector value, and age. |  |  |  |
| Arctis Nova Pro Wireless | Close the GG device page after a fresh event and leave it closed until the reading ages to last-known. | Without reopening GG, the key changes to `~percentage`, while the Property Inspector remains `Connected`, shows the same `~percentage`, and shows a `Last seen` age that matches elapsed time from the recorded fresh event under the minute/hour/day rounding rules. Record the transition time, key value, Property Inspector value, and age. |  |  |  |
| Apex Pro TKL Wireless | Restart only the plugin worker while the saved device remains configured. | After current GG inventory succeeds, the same device reconnects and its persisted reading returns; record the connection confirmation. |  |  |  |
| Arctis Nova Pro Wireless | Restart only the plugin worker while the saved device remains configured. | After current GG inventory succeeds, the same device reconnects and its persisted reading returns; record the connection confirmation. |  |  |  |
| Apex Pro TKL Wireless | Turn the device off, wait for a confirmed disconnect, then turn it on without opening its GG page. After confirming the unavailable state, open the Apex GG page once to trigger a passive battery event. | The confirmed disconnect clears the cached reading. After power-on, the display remains unavailable before the new event. The event then restores the same exact device's fresh percentage without `~` on both the Stream Deck key and Property Inspector; record its timestamp and value. |  |  |  |
| Arctis Nova Pro Wireless | Turn the device off, wait for a confirmed disconnect, then turn it on without opening its GG page. After confirming the unavailable state, open the Arctis GG page once to trigger a passive battery event. | The confirmed disconnect clears the cached reading. After power-on, the display remains unavailable before the new event. The event then restores the same exact device's fresh percentage without `~` on both the Stream Deck key and Property Inspector; record its timestamp and value. |  |  |  |
| Apex Pro TKL Wireless | Restart GG without changing device settings. | The configured identity is retained and the display recovers after current inventory and a new battery event. |  |  |  |
| Arctis Nova Pro Wireless | Restart GG without changing device settings. | The configured identity is retained and the display recovers after current inventory and a new battery event. |  |  |  |
| Apex Pro TKL Wireless | Let the device sleep, then wake it. | Sleep/unavailable state is honest; wake returns the same device identity and a fresh value only after a new battery event. |  |  |  |
| Arctis Nova Pro Wireless | Let the device sleep, then wake it. | Sleep/unavailable state is honest; wake returns the same device identity and a fresh value only after a new battery event. |  |  |  |
| Apex Pro TKL Wireless | Transition USB to wireless, then wireless to USB. | The configured device identity is retained in both directions; record recovery time and values. |  |  |  |
| Arctis Nova Pro Wireless | Transition USB to wireless, then wireless to USB. | The configured device identity is retained in both directions; record recovery time and values. |  |  |  |
| Apex Pro TKL Wireless | Switch to the other configured device and back using the Stream Deck key. | Order and active position remain stable; the plugin does not substitute a different device. |  |  |  |
| Arctis Nova Pro Wireless | Switch to the other configured device and back using the Stream Deck key. | Order and active position remain stable; the plugin does not substitute a different device. |  |  |  |
| Apex Pro TKL Wireless | Observe GG and Arena throughout startup, polling, reconnect, restart, sleep/wake, and transport changes. | Arena or firmware prompt observed: `NO`. |  |  |  |
| Arctis Nova Pro Wireless | Observe GG and Arena throughout startup, polling, reconnect, restart, sleep/wake, and transport changes. | Arena or firmware prompt observed: `NO`. |  |  |  |
| Apex Pro TKL Wireless | Observe the device and GG throughout the 72-hour window. | Raw GG mutation, unsolicited GG UI open, or device wake observed: `NO`. |  |  |  |
| Arctis Nova Pro Wireless | Observe the device and GG throughout the 72-hour window. | Raw GG mutation, unsolicited GG UI open, or device wake observed: `NO`. |  |  |  |

## Final owner decision

- All required rows have timestamped results: `YES` / `NO`
- Both fresh readings and both `~percentage` transitions were observed: `YES` / `NO`
- Any `FAIL` or unresolved `BLOCKED` result remains: `YES` / `NO`
- Any Arena or firmware prompt was observed: `YES` / `NO`
- Any raw GG mutation, unsolicited UI open, or device wake was observed: `YES` / `NO`
- Owner accepts the 72-hour soak: `YES` / `NO`
- Defect may be marked closed: `YES` / `NO`
- Decision timestamp with time zone: ____________________
- Owner initials: ____________________
