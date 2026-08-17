# Meeting

One-tap call control for **Zoom** and **Teams** from the panel — mute, video, accept,
decline, leave — without touching the keyboard or mouse. It doesn't launch or manage a
call; it sends the same global keystroke Zoom/Teams themselves already bind, so it only
does anything useful while a call is actually active in that app.

Add a page → **+ App** → pick **Meeting**.

## Options

- **Default platform** — which tab (Zoom or Teams) the page opens to. You can still
  switch tabs on the panel for a one-off call on the other platform; this only sets
  what shows by default.
- **Use Zoom's default keymappings** — on by default. Zoom ships these combos already
  bound (Alt+A mute, Alt+V video, Ctrl+Shift+A/D phone accept/decline, Alt+Q leave); if
  you haven't remapped them yourself in Zoom, leave this on and there's nothing else to
  configure. Turn it off to enter your own combos, matching whatever you've customized
  in Zoom → Settings → Keyboard Shortcuts.

| Action | Zoom default |
|---|---|
| Mute/unmute | `Alt+A` |
| Start/stop video | `Alt+V` |
| Accept inbound call | `Ctrl+Shift+A` |
| Decline inbound call | `Ctrl+Shift+D` |
| Leave meeting | `Alt+Q` |

Whichever combo is active — default or custom — must have **"Enable Global Shortcut"**
ticked for that action in Zoom's own Keyboard Shortcuts settings, or Zoom won't respond
to it unless its window already has focus.

## Teams

Teams' combos are fixed and not configurable — they're Microsoft Teams' own built-in
global shortcuts (`Ctrl+Shift+M` mute, `+A` accept with video, `+S` accept audio-only,
`+D` decline, `+H` hang up, `+O` toggle video). Unlike Zoom, Teams needs its window
force-focused immediately before each keystroke to respond reliably — open-quake does
this automatically, so it works even when Teams isn't the visible foreground app.

## Recording & transcription

The panel records meetings (one stereo WAV: your mic = left, everyone else = right) and
can send them to a diarizing transcription server, then to an AI for meeting notes.

- Recordings land in the **Unprocessed Recordings** folder (Settings → Meeting; default
  `Documents\OpenQuake Meetings\unprocessed`).
- The top row reads **Analysis | Unprocessed | Record**; both screens open as their own
  full page with per-row select boxes, **Select all**, and act-on-selected buttons in
  the header.
- **Unprocessed** — list, play, transcribe, and delete recordings in one screen. Each
  row has **Transcribe / Play / Delete**; the header adds **Transcribe selected** and
  **Delete selected** (deletes are two-tap: `Delete` → `Confirm?`). Transcription sends
  the WAV to the transcription server (tts-sst or meeting-diarizer, Settings → Meeting →
  Transcription Server; protocol in [meetings-api.md](meetings-api.md)); jobs queue and
  run one at a time (roughly ⅓ of the recording's length each), with the running job,
  elapsed time, and server health shown in the strip under the header. On success the
  WAV moves to the **Processed Recordings** folder with its transcript
  (`<name>-diarizer-response.json`) beside it; on failure the WAV stays put and the
  error shows on the row (tap **Retry**). A running or queued file can't be deleted.
- **Analysis** (top row) — browses the Processed folder one directory at a time (tap a
  folder to enter it, **⬆ Up** to go back; no recursive sweep), and runs the chosen
  **Analysis AI** (Settings → Meeting: Claude, ChatGPT Codex, or GitHub Copilot — the locally
  installed CLI, using its own login) over a transcript, filing the result as
  `<name>-analysis.md` next to it. **View** renders it on the panel.
- **Settings** (utility rail, replaces the old Full screen row) — picks the recording
  microphone. It must be the same mic Teams is using; if you switch mics in Teams,
  switch here too.
- **Calendar meeting info** (optional, Settings → Meeting → Advanced) — choose classic
  Outlook on this PC or the signed-in Microsoft 365 calendar. When a recording starts,
  the matching appointment's details are saved as `<recording>.json` beside the WAV and
  move with it through transcription. The attendee names are sent to the diarizer to
  improve speaker identification. See [settings.md](settings.md).

## Honest limits

open-quake has no way to know whether a call is actually active — a tap just sends the
configured keystroke. If nothing's on the call, nothing visibly happens. There's no
on-panel call timer or participant list; this is a remote control, not a client.
Transcription progress is elapsed time only — the diarizer reports no percentage, so
none is shown.
