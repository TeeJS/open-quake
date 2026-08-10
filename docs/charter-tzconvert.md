# Charter — Time Zone Converter app (`tzconvert`)

**1. What is the one thing this must do?**
When someone says "can you meet at 4:30 my time," tap/type that time into their
zone's column and instantly read the equivalent in the other three. Four columns,
west→east: **PDT/PST | MDT/MST | CDT/CST | EDT/EST**, with the currently-active
abbreviation bold (per today's DST rules) and an editable time under each.

**2. What would be wrong if we shipped "working" software without it?**
- Editing one column must update the other three automatically — 250 ms after the
  last change, or instantly on Enter. No apply button required.
- Times are **sticky**: they hold whatever was last set, across page switches and
  app restarts. The app never snaps to the current time — the World Clock owns "now."
- The box being edited is never rewritten mid-keystroke; only the other three
  update. The edited box canonicalizes on Enter/blur.

**3. What is explicitly off-limits as a workaround?**
- No mandatory apply/convert button (Enter is optional muscle-memory, not required).
- No reset-to-now behavior of any kind — no button, no idle timeout.
- No dropping the DST-bold header: the bold half must reflect what each zone
  actually uses today.

**4. Deployment target and backup location?**
- Target: bundled static app `apps/tzconvert.html` + entry in `apps/apps.json`
  (id `tzconvert`, name "Time Zone Converter"), same pattern as the World Clock.
- Backup: this git repo — commits are the backup.

**5. How will we verify it is done?**
- Fresh install defaults to 1:00 PM / 2:00 PM / 3:00 PM / 4:00 PM.
- Tap MDT's box → stepper row `−1h −30m +30m +1h` appears; `+30m` from 2:00 gives
  2:30 and the other columns read 1:30 / 3:30 / 4:30 with no further interaction.
- Typing `4:30p` into EDT updates the rest 250 ms after the last keystroke; Enter
  commits immediately. Flexible parsing: `2`, `2p`, `230`, `14:30`, `2:30 pm`.
- Restart the app → the same times come back (localStorage, like the Flip Clock).
- 24-hour option (in the app's options in the editor) renders 13:00 etc.
- In July the DT halves are bold; in January the ST halves.

## Decisions (signed off 2026-07-23)

- **Touch UI, v1 (superseded)**: per-column steppers (`−1h −30m +30m +1h` buttons).
  Replaced 2026-07-24 — see below.
- **Touch UI, v2 (current)**: an Apple-style inline drum picker, shown under the
  active column in the space the steppers used (not an overlay — the other three
  columns stay visible and update live as a drum settles). Three wheels in
  12-hour mode (hour 1–12 / minute / AM·PM), two in 24-hour mode (hour 0–23 /
  minute). Minute wheel stops are **00/15/30/45** — a plain :00/:30 drum barely
  spins and can't reach quarter-hours. Native touch-drag scroll + CSS
  `scroll-snap`; a desktop mouse wheel over a drum spins it directly.
  - **Commit gating**: a drum only commits its column on a genuine user
    gesture (`pointerdown`, `wheel`, or a tap on a drum item) — never on the
    picker's own display sync. This mattered because the picker can only show
    quarter-hour stops, but stored state can hold an arbitrary typed minute
    (e.g. 4:37); after every commit the OTHER (unedited) columns' drums must
    re-sync their display to the *nearest* quarter-hour for that exact state,
    and that re-sync is a real `scrollTop` write that fires the same 'scroll'/
    'scrollend' events a user drag does. Gating strictly on gesture — not on a
    timing/rAF-based "was this programmatic" guess — is what prevents that
    display-only sync from silently rounding an exact typed time a moment
    later. Verified: typing `4:37` and leaving it alone keeps `4:37` forever;
    only an actual touch/drag/tap on that drum ever changes it.
  - Typed entry, Enter-to-commit, and the 250 ms debounce are unchanged.
  - **Drag is hand-rolled, not native scroll** (fixed 2026-07-24). The panel's
    physical touch never reaches the page as touch/pointer events — the host
    translates raw touch points into synthetic `mouseDown`/`mouseMove`/`mouseUp`
    on the webview (`index.js` `webTouch()`). A plain `overflow:auto` box does
    not scroll from a mouse drag (that's native-touch-only behavior), so the
    drums track the drag themselves and snap on release. Tap-to-jump likewise
    hit-tests the release point rather than relying on a `click` event, since a
    synthesized mouseDown/mouseUp pair isn't guaranteed to produce one.
  - **Layout rules the picker must obey** (fixed 2026-07-24, all three from
    on-device feedback):
    1. Inactive columns use `display:none` for the picker, never
       `visibility:hidden` — a hidden-but-laid-out picker still reserves its
       full height in every column, which pushed their label + time above
       centre. All four columns now sit at exact vertical centre when idle.
    2. The active column hides its own time text entirely; the drum *is* the
       readout, so a second copy of the same value is redundant (it had been
       shrunk to a tiny bar, which read as clutter).
    3. Three drum rows plus DONE must fit inside the 480 px cell
       (`--ih:22vh` → 66vh of drum, ~80vh total). Oversizing overflowed the
       cell, clipped the top/bottom rows, and knocked every column off centre.
    Selected-row digits are `min(17vh,4.2vw)` — deliberately equal to the plain
    time text that opens the picker, never smaller.
  - **Dismissal** (added 2026-07-24): changes apply live as each drum settles,
    so nothing needs saving — but the picker must be closeable, or the column
    is stuck in edit mode. Four ways out, all landing on the same `deactivate()`:
    a full-width **DONE** button under the drums (bound on `mousedown`, for the
    same synthetic-touch reason as above), a tap anywhere outside the open
    picker, **Escape**, and **Enter**.
  - **Typing still works while the picker is open**: a printable key closes the
    picker, focuses that column's text box, and seeds it with the keystroke, so
    the existing debounce + Enter path takes over. The drum never blocks typed
    entry.
- **Wheel over a column (not over a drum)**: still nudges that column ±30 m —
  covers desktop scroll wheels and the knob when its turn mode is "scroll".
- **Typed entry**: kept for desktop use; `inputmode="none"` suppresses any OS
  touch keyboard on the panel while hardware keyboards still work.
- Minutes stored to the exact minute (no seconds); the picker only ever
  *displays* the nearest quarter-hour for a value it can't represent, it never
  rewrites the stored value on its own. 12-hour default; 12/24 option for our
  European brothers (rendered in the app's normal options list — the editor's
  collapsible "Advanced" section is host-owned and not available to app options).
- Rejected alternatives: shared timeline scrubber, on-screen keypad, steppers (v1).

## Zone selection — World Clock parity (added 2026-07-24)

Same selector the World Clock offers: a **mode** option (US time zones / Cities) plus
**6 city slots** with per-city label overrides, using the identical city list (generated
from `tzclock`'s own `choices` so the two can't drift). **US is the default** and its
rendering is untouched — 4 columns, real `PDT/PST` pairs.

- **Cities show GMT offsets, not letter abbreviations.** `Intl` only returns real
  abbreviations for US zones; elsewhere it gives numeric forms (Paris → `GMT+1`/`GMT+2`,
  Tokyo → `GMT+9`) and it truncates half-hour zones (`GMT+5:3` for Kolkata). So the
  offsets are computed and formatted here instead. Inventing a curated abbreviation
  table (CET/CEST, BST, JST…) was considered and rejected — it needs an authoritative
  source and ongoing maintenance. A city cell therefore reads: city name over its
  offset pair (`GMT+1/GMT+2`, current half bold), or a single offset when the zone has
  no DST.
- **One row, always** — the only intentional divergence from the World Clock, which
  wraps to 2 rows at 4+ zones. A second row is 240 px tall and the drum picker needs
  ~340 px, so wrapping would break editing outright. Instead type scales with column
  width via `--colw`: at 4 columns it resolves to exactly the previous sizes, and 5-6
  columns shrink to fit rather than overflow (verified: picker 362/290/241 px against
  456/360/296 px usable).
- **Stored state moved to a UTC minute-of-day** (`umins`, migrating the old `pmins`),
  so changing the city list can't silently reinterpret the time the user set.
- **Auto-order** (added 2026-07-24, and added to the World Clock at the same time so the
  two keep matching): a cities-only checkbox that sorts the chosen zones **ascending by
  GMT offset — west → east** (GMT−7 before GMT+9). Direction confirmed with the user:
  it preserves the US layout specified up front (`PDT | MDT | CDT | EDT`), where a literal
  reading of "high to low" would have reversed it. US mode is already in this order, so
  the option is hidden there and would be a no-op anyway. Sort is stable, so zones sharing
  an offset keep the order they were picked in.
