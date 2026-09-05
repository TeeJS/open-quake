# Home Assistant integration

Once you point open-quake at a Home Assistant server, three new things become possible:

1. **A Home Assistant Dashboard app** — pick any Lovelace dashboard from a dropdown and put it on a page, no hand-typed URLs.
2. **HA entity tiles** — tap a tile to call a service on an entity (toggle a light, play/pause a media player, trigger an automation, etc.) with a picker that filters by device type, room, label, and favorites.
3. **HA-resolved tile icons** — tiles render the actual MDI icon HA would show (or the entity's album art / camera snapshot when present).

Per-dashboard HA auth (set on a single web-dashboard page in the editor) still works independently and is unaffected.

## Setup

Open **Settings → Auth** and:

1. Fill in your **Home Assistant URL** (e.g. `https://ha.example.com` or `http://homeassistant.local:8123` — include the scheme).
2. Paste a **Long-Lived Access Token** (in HA: your profile → Security → bottom of the page → *Create token*).
3. Tick **Use Home Assistant**.
4. Click **Refresh Configuration**.

The status line shows what loaded — e.g. *"12 dashboards, 487 entities, 24 areas, 38 devices, 5 floors, 9 labels (3 s ago)"*. Click Refresh any time after changes to your HA setup (added an area, renamed an entity, etc.) to re-pull.

The token is encrypted at rest — on Windows via per-value DPAPI, no key file to lose
across restarts; macOS uses Keychain-backed Electron `safeStorage` (same place
per-dashboard HA tokens live either way). It never leaves the main process except for
requests to your HA URL.

## What gets cached

On Refresh, open-quake pulls — in one WebSocket session over HA's `/api/websocket` — these registries:

- **Dashboards** (`lovelace/dashboards/list`)
- **Areas** (`config/area_registry/list`)
- **Devices** (`config/device_registry/list`)
- **Entities** (`config/entity_registry/list`)
- **Floors** (`config/floor_registry/list`) — older HA returns "unknown command", carries on with empty
- **Labels** (`config/label_registry/list`) — same as floors

Plus a synthesized `entities[]` view per entity: `entityId`, `friendlyName`, `domain`, `area`, `floor`, `labels[]`.

Notably, **`/api/states` is NOT pulled in bulk**. State for a single entity is fetched on demand via `/api/states/<entity_id>` when the entity is wired into something (entity tile, picture-using icon). For a typical home this keeps the cache around 300–500 KB instead of ~5 MB; on a power-user install ~1.5 MB instead of ~20 MB.

Cache lives in memory only — no disk persistence. It rebuilds at app launch (when Use HA is on) and you can force a fresh pull from the Auth tab.

## The Home Assistant Dashboard app

Add a page → **+ App** → pick **Home Assistant Dashboard**. The Dashboard dropdown is populated from your cached dashboards plus "Overview (default)" prepended (HA's WS API doesn't include the default dashboard).

At runtime, open-quake translates the app to a synthetic web-dashboard page pointed at `<haUrl>/<dashboard_path>` with the HA token injected into `localStorage` (same trick the existing `auth: ha` web grid uses). Login persists across reloads. The page renders inside the panel webview just like any other dashboard — knob scrolls, tap clicks, HA's own tab bar at the top of the dashboard lets you switch between views.

Picking a different view (e.g. `/lovelace-second/2`) isn't supported yet; you land on the dashboard's first view and tap HA's tabs to move.

Three checkboxes on the app's options — **Kiosk mode**, **Hide header**, **Hide sidebar** —
append the matching URL flags (`?kiosk`, `hide_header`, `hide_sidebar`) that HA's
[kiosk-mode](https://github.com/NemesisRE/kiosk-mode) integration reads. **Kiosk mode**
hides both header and sidebar in one flag; the other two are for hiding just one. This
requires the kiosk-mode integration installed on your Home Assistant instance — the
checkboxes only set the URL flags it looks for, they don't install or configure anything
HA-side.

## HA entity tiles

In a tile, set **Type → HA entity**. Four filter rows narrow the entity list:

- **Device Type** — domain (light, switch, media_player, scene, …)
- **Room** — area from your HA setup
- **Label** — any label you've assigned in HA
- **Favorites** — show only entities you've starred

Star button next to the entity dropdown toggles favorites; they're stored as `settings.haAuth.favorites` (just an array of entity_ids, not secrets).

Once an entity is picked, the **Service** dropdown shows a curated per-domain list:

- light / switch / input_boolean / fan: toggle, turn_on, turn_off
- media_player: play_pause, play, pause, stop, next, previous, volume up/down/mute
- scene: activate (turn_on)
- script: run (turn_on)
- automation: trigger, toggle, enable/disable
- cover: toggle, open, close, stop
- lock: lock, unlock
- vacuum: start, stop, dock, pause
- climate: turn_on, turn_off
- input_button: press
- everything else: toggle/turn_on/turn_off as fallback

Tapping the tile fires `POST /api/services/<domain>/<action>` with `{ entity_id }`. Service data (brightness, volume level, temperature setpoint) and live state on the tile are explicit phase-2 work — not in this release.

## Icons

When the tile's **Icon** is set to **HA icon** (the default for new HA entity tiles), open-quake resolves in this order:

1. **`entity_picture`** — for media players with album art, cameras with snapshots, anything you've uploaded a photo for. Fetched once per entity through the existing URL-icon-cache pipeline. Stays cached across launches.
2. **The entity's MDI icon** — from state attributes if known, otherwise the registry override, otherwise HA's per-domain default (e.g. `light` → `mdi:lightbulb`). The SVG is downloaded from `https://cdn.jsdelivr.net/npm/@mdi/svg@7/svg/<name>.svg`, recolored white, cached in the icon-cache directory. Shared by all tiles that use the same icon name.
3. **Emoji fallback** — only if jsDelivr is unreachable (e.g. offline at the moment of first use).

The recolor is fixed white right now; theming the SVG to follow the panel accent is a future enhancement.

Pick **Emoji / Image / Image URL** in the icon pane to opt out — the user-picked icon always wins.

## Toggle Use HA off

Toggling **Use Home Assistant** off:

- Hides the **Home Assistant Dashboard** app from the **+ App** picker
- Stops trying to refresh the cache on app launch
- Existing pages built on HA stay in the editor (so you can edit or remove them) but don't render correctly on the panel until Use HA is back on

The in-memory cache from a previous Use-HA-on session sticks around until app restart.

## Publishing your busy status to HA (MQTT)

The HA connection above is **read-only** — it pulls dashboards, registries and entity states, and
calls services for entity tiles. Publishing *out* of open-quake goes over MQTT instead, configured
separately under **Settings → Meeting → Busy status → Home Assistant (MQTT)**.

MQTT rather than the REST API for one concrete reason: HA's WebSocket API has no equivalent of
`POST /api/states`, and a state created over REST does not survive an HA restart — it would need an
indefinite heartbeat to keep a phantom entity alive. MQTT discovery creates a real, persistent entity
with nothing to configure on the HA side.

What open-quake publishes (topics use `<prefix>/<hostname>/…`, prefix configurable, default
`open-quake`):

| Topic | Retained | Payload |
|---|---|---|
| `homeassistant/binary_sensor/<host>_open_quake_busy/config` | yes | discovery document; HA creates `binary_sensor.open_quake_busy` from it |
| `open-quake/<host>/busy` | yes | `ON` / `OFF` |
| `open-quake/<host>/attributes` | yes | `{reason, app, since, recording, override}` |
| `open-quake/<host>/availability` | yes | `online` / `offline` |

`reason` is `call`, `recording`, or `manual`, so an automation can distinguish "on a Teams call" from
"marked busy by hand".

The availability topic is registered as the MQTT **last will**, which is the part worth understanding:
if open-quake is killed, crashes, or the PC loses power, the *broker* publishes `offline` on its
behalf and the entity goes unavailable. A light driven from this entity therefore cannot get stuck
showing you as busy — and neither can the USB Busylight, which extinguishes itself when open-quake
stops sending its keep-alive. Both ends fail safe without anything having to run cleanup code.

The connection is held open for as long as the feature is enabled, not opened per update: the will is
registered at connect time, so a connect-publish-disconnect cycle would leave no will in force between
updates and defeat the whole arrangement. On reconnect, open-quake re-publishes the discovery document
and current state, because a broker restart drops retained messages.

The broker password is encrypted at rest with the same DPAPI mechanism as the HA token.

## Privacy

All HA traffic goes directly from open-quake's main process to your HA URL. No third party touches your tokens, dashboards, entity names, or registry data. The only external request the HA integration makes is to jsDelivr (`cdn.jsdelivr.net`) for individual MDI icon SVGs — those are public assets and the request carries no HA data.
