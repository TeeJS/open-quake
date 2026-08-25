# Community drop-in apps — catalog

Install these straight from the panel: **Settings → Drop-In Apps → Browse…** lists every app in
this folder and installs (and later updates) it in one tap. This folder is the default app
repository; point the repository field at your own GitHub fork to install from there instead.

> **Maintainers:** each app declares a `version` in its `app.json`. When you add an app or bump a
> version, rebuild that app's `<id>.zip` **and** regenerate the catalog the panel reads:
> `node tools/build-community-index.js` (writes `index.json`), then commit both. The in-panel
> **Check for updates** button compares `index.json` against the installed version.

For how to install or submit an app — and a safety note — see the docs:
**[docs/community-apps.md](../docs/community-apps.md)**.

## Available apps

- **[arr-dash](arr-dash)** — *arr media-stack dashboard: **Sonarr, Radarr, Lidarr,
  SABnzbd, Youtarr, LidaTube** in one glance — merged download queue with progress,
  health warnings, disk space, and the next 24 hours of releases. Tap a service to
  focus on it (its queue + recent history) or open its web UI on the PC. Read-only;
  API keys stay server-side.
- **[duplicati-dash](duplicati-dash)** — backup status board for a **Duplicati** server:
  every job with a green/red result dot, last run, sizes, versions, and next run;
  live progress while a backup runs; failed jobs surface their error inline; one tap
  opens the Duplicati web UI on the PC. Read-only.
- **[azure](azure)** — touch-first Azure operations dashboard with configurable overview cards,
  subscription health, resources, deployments, alerts, costs, and contextual App Service / VM
  controls. Uses Microsoft Entra OAuth and an app-local server module.
- **[if-player](if-player)** — play Inform / Z-machine text adventures (Z-code and Glulx),
  with the story **read aloud** through your TTS voice and **spoken commands** transcribed by
  your STT — both picked up automatically from Settings → TTS/STT. Keyboard play works
  normally; drop story files into the app's `stories/` folder. Bundles the
  [Parchment](https://github.com/curiousdannii/parchment) interpreter (MIT).
- **[jarvis](jarvis)** — JARVIS voice-assistant client: pairs with a JARVIS server over a
  PIN, and talks to Gemini Live, Ollama, or an OpenAI-compatible endpoint.
- **[kitten-cannon](kitten-cannon)** — a remake of the classic Kitten Cannon flash game,
  ported for the panel with touch controls: drag or hold the arrow buttons to aim, tap
  FIRE to launch, bounce off trampolines and TNT for distance. Optional shared
  high-score server (configurable Server URL; works fully offline too) and a
  persistent mute button.
- **[music-assistant](music-assistant)** — full **Music Assistant** controller: now playing
  with album art, transport and scrubbing, live queue (reorder, play-from-here, transfer),
  player selection and grouping with per-member volume, and a library browser with search
  on an on-screen keyboard. Talks to MA's WebSocket API directly for real-time updates;
  the API token is stored encrypted. Knob = volume, press = play/pause.
- **[news-spotlight](news-spotlight)** — full-screen rotating RSS feed reader. Defaults
  to BBC / Sky / The Verge / Ars Technica; configurable feeds, story duration, Ken
  Burns motion, breaking-news mode, and an SSRF-safe proxy.
- **[pihole-dash](pihole-dash)** — multi-server **Pi-hole** dashboard: up to four
  Pi-holes as tabs on one pane — live stats, 24-hour query chart with blocked share,
  top blocked/clients, pause/disable/enable blocking, and one-tap open of the web UI
  on the PC. Pi-hole v6; passwords stay server-side.
- **[quake-bird](quake-bird)** — a flappy-style arcade game: tap to flap, thread the pipe
  gaps, chase your best score. Original canvas artwork; pipes follow your accent color and
  the page theme. Optional shared high scores on the same score server as kitten-cannon
  (player initials + configurable Server URL; fully playable offline).
- **[deck-host](deck-host)** — run **Elgato Stream Deck plugins** on the panel: point it at a
  folder of `*.sdPlugin` packages and it launches them against Elgato's documented plugin
  protocol; the on-screen key grid shows each plugin's live images/titles, taps press keys,
  and the knob cycles profiles. Keypad actions from native/Node plugins (no property
  inspectors or dials yet). Plugins are real programs — only use ones you trust.
- **[spotify-volume](spotify-volume)** — per-app Windows volume control for the knob (Spotify
  by default, configurable to any process). Uses a bundled native helper against the Core
  Audio session APIs — no admin, no Spotify login/Premium, no Web API. By **J Last**.
- **[vlc-remote](vlc-remote)** — control a local or network VLC player: transport, seek,
  volume, status, and playlist, via VLC's built-in web interface (enable it in VLC
  Preferences → Main interfaces → Lua). By **Mark Hollingworth**.

To add one, open a pull request — see
[docs/community-apps.md](../docs/community-apps.md#submitting-one).

## Shared high scores for your game

Want online leaderboards in your community game? A free hosted score server is available
to all community apps — kitten-cannon and quake-bird already use it, and you're welcome
to as well. See **[SCORE-API.md](SCORE-API.md)** for the URL (use of it in community
games is explicitly permitted), the game-slug and 3-letter-initials conventions, and the
endpoint reference. Self-hosting instructions are linked there too.

## For developers

Building your own drop-in app? The [`skills/`](skills) folder holds
Claude Code skills you can drop into your `.claude/skills/` to get
AI-assisted scaffolding and authoring help. Today:

- [`open-quake-drop-in-app`](skills/open-quake-drop-in-app) — guides
  Claude through the manifest schema, served vs. file modes, options,
  `/app-proxy`, `/app-api`, and the host/runtime boundary so it stays
  inside `apps/<app-id>/` and doesn't touch platform code.
