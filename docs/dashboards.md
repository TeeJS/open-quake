# Web dashboards

A page can be a web view instead of a tile grid (**+ Dashboard** in the editor —
give it a name + URL). It renders full-screen on the panel; the knob scrolls it
(inner scroll panels included), a tap is a click, and double-clicking the knob
returns to the page selector. Sessions persist across restarts. open-quake ships
with a public **[Windy](https://www.windy.com) weather map** as a ready-made
dashboard example.

**Reloading** — switching away to another page and back does **not** reload a
dashboard; the panel keeps one shared webview and only re-navigates when a page's
URL actually changes, so your session/scroll position survives page switches.
Quitting and restarting open-quake does give a fresh load. To force a reload without
restarting, set a global **Reload hotkey** in **Settings → Software → Dashboards** —
it reloads whatever dashboard is currently on screen, from anywhere.

**Auth** is set per page in the editor — needed because the panel has no keyboard:

| Type | For |
|---|---|
| **None** | public / anonymous pages (Flipboard, anonymous Grafana) |
| **Home Assistant token** | HA — paste a Long-Lived Access Token; the panel seeds it and loads signed-in |
| **HTTP Basic Auth** | sites behind a real `401` / `WWW-Authenticate: Basic` challenge (e.g. nginx `auth_basic`) |
| **Custom header(s)** | bearer tokens, Grafana service accounts, Cloudflare Access (`CF-Access-Client-Id` / `-Secret`) |

**Form-login apps** — which redirect to a `/login` *page* instead of issuing a
`401` — aren't covered by Basic Auth. Either have the app accept a **bearer token**
and use Custom header, or, since the panel runs on your PC, click the login form
with your PC mouse/keyboard once: the persistent session keeps you signed in.

## Adding a dashboard

Web **Dashboard** pages are added the same way as grids and apps — **+ Dashboard**
in the editor, then set the page's name, URL, and (if the site needs it) auth — see
the auth options above. Use **Delete page** to remove one.

![Adding and managing a dashboard page in the editor](shots/editor-dashboard.png)

## Button grid

A dashboard can also carry a strip of native macro tiles beside the web view. In the
dashboard editor, tick **Add a button grid beside the dashboard** to reveal a
**Buttons** tab: pick the **side** (left or right) and the **size** (2 rows tall,
1–3 columns wide), then edit the tiles like any grid. The web view fills the rest of
the screen — taps on the strip fire the tiles, taps on the web view go to the page.

## DRM-protected video (Netflix, Disney+, etc.)

Streaming services that use **Widevine DRM** — Netflix, Disney+, HBO Max, Amazon
Prime Video, Hulu, Spotify desktop, etc. — won't play in a dashboard page. The
classic symptom is Netflix's `M7701-1003` error, or the equivalent from another
service, often suggesting you enable "Allow protected content" in Chrome.

The reason: open-quake's panel webview runs on **Electron's Chromium**, which
doesn't ship with the Widevine Content Decryption Module (CDM) that Google bundles
into their official Chrome. Your PC Chrome has Widevine; the panel webview is a
separate browser binary that doesn't. Toggling "Allow protected content" doesn't
help — that setting just enables a CDM that isn't there.

This is *not* an HDCP issue. HDCP is the encrypted display-link layer (HDMI / DP);
CDM is the in-browser decryption layer. Without a CDM, the player never even
reaches the point of caring about HDCP.

**Workarounds:**

- **Use a `URL` tile instead of a Dashboard page.** A URL tile opens the link in
  your PC's default browser (typically Chrome), which has Widevine — playback
  works normally. You lose the on-panel render but gain working DRM.
- **On the Dashboard page, turn on "Open clicked links in my PC browser"** in its
  Advanced settings. Browsing the service's UI still happens on the panel; the
  actual *Play* click bounces to your PC browser. Works for sites that navigate to
  a separate player page on play; doesn't work for sites that play in-place via
  JavaScript (which is most of them, unfortunately).

Adding Widevine to open-quake itself would require switching to a forked Electron
build (Castlabs maintains one) plus VMP signing — not currently planned.
