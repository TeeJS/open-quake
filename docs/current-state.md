# Current State

Verified on 20 August 2026 against the current source, mocked Discord RPC/OAuth tests, the full
repository test suite, and a Windows portable/NSIS build. Live Discord-account verification still
requires the Developer Portal configuration and tester account described below.

## Settings and configuration ownership

Discord is listed with Microsoft 365 and GitHub under **Settings -> Auth -> OAuth 2.0**. Its provider
card shows authorization/runtime state, the granted or requested `rpc identify` scopes, a sanitized
account name returned by RPC `AUTHENTICATE` when available, and Connect/Reconnect and Disconnect
actions. Tokens and raw RPC responses never enter the settings renderer.

Connect/Reconnect is the only operation that starts browser authorization. Merely starting
open-quake with no Discord token does not open a browser. Disconnect closes RPC, deletes the stored
Discord tokens, clears the connected identity, and returns the provider to authorization-required.

Discord behavioral settings remain in the Discord app configuration: enablement, automatic
reconnect, Rich Presence, default Voice/Chat/Activity view, and unavailable-control visibility.
The Application ID is no longer a normal setting. A development/testing-only Application ID
override is inside an **Advanced / developer overrides** disclosure. Legacy `clientId` and
`applicationId` settings migrate to that override; unknown values and legacy secrets are discarded.
Changing the effective Application ID invalidates Discord tokens issued to the previous client.

`DEFAULT_DISCORD_APPLICATION_ID` in `app/discordSettings.js` is the single built-in public client
identifier (`1539959318974169088`). It is intentionally not a secret. No Client Secret is accepted,
rendered, persisted, or sent.

## OAuth and loopback callback

Discord uses Authorization Code with PKCE (`S256`), a cryptographically random state value checked
with a constant-time comparison, and the `rpc identify` scopes. Code exchange and refresh are public
client requests containing the Application ID and PKCE verifier but no Client Secret. Access and
refresh tokens stay in the encrypted main-process OAuth store; refresh-token rotation is preserved,
and unusable tokens are removed so the next explicit Reconnect can authorize again.

The registered redirect remains exactly `http://127.0.0.1/callback`. The listener binds only
`127.0.0.1`, accepts only `GET /callback`, rejects other methods/paths, validates state before code
exchange, and stops after completion or timeout. Because that URI omits a port, it requires port 80.
Discord requires an exact registered redirect URI and its current desktop guidance uses this exact
value, so changing to a high or ephemeral port is not a code-only change: the Developer Portal
redirect must first be changed to the exact new URI. Dynamic loopback ports are therefore not
compatible with the currently registered redirect. Port 80 conflicts are reported as callback
listener failures rather than silently falling back to a mismatched URI.

## Runtime authentication and capability state

With stored authorization and a running Discord desktop client, RPC follows `READY` ->
`AUTHENTICATE`. The sanitized `user` identity in a successful response is retained only for status
display. `GET_GUILDS` is still the authenticated probe. RPC 4006 clears authorization and classifies
every capability as an authentication/permission failure; it does not trigger an authorization
browser loop.

Capability state is tracked separately from the compatibility booleans and distinguishes:

- `available`: a real command succeeded;
- `unsupported`: Discord rejected the command as unsupported;
- `auth-failure`: authorization/permission failed, including RPC 4006;
- `temporary-error`: the command failed without proving it unsupported;
- `unverified`: no safe command has yet validated it.

Startup performs only read-only probes: `GET_VOICE_SETTINGS`, `GET_SELECTED_VOICE_CHANNEL`, and
`GET_GUILDS`, followed by `GET_CHANNELS` for the first returned guild when one exists. An empty guild
list leaves channel discovery unverified rather than falsely available. `SELECT_TEXT_CHANNEL` and
`SET_ACTIVITY` have no read-only equivalent in the legacy RPC contract, so they remain unverified
until the user explicitly opens a text channel or changes Rich Presence. A successful action marks
the capability available; unsupported, auth, and temporary failures retain their distinct states.

Chat enables channel launch while selection is unverified or temporarily failed, allowing the
explicit user action to validate it, but disables it after an unsupported/auth failure. Rich
Presence follows the same rule and labels its initial state **Not yet verified**. Neither capability
is marked Available merely because IPC and authentication succeeded.

## Discord touchscreen app

The touchscreen navigation remains Voice, Chat, and Activity only. Voice, Chat, and Rich Presence
layout/behavior have not been redesigned. Chat remains a channel launcher: it discovers guilds and
channels, filters to text/announcement channels, and asks Discord to open a selected channel. It has
no message list, composer, bot integration, Social SDK, fake data, or renderer-side low-level RPC.

## Verification

- `npm test`: 236 tests passed, 0 failed. Coverage includes the Auth provider card, lifecycle
  handlers, explicit authorization, no Client Secret dependency, advanced Application ID migration,
  capability probing/classification, Chat and Rich Presence states, 4006 handling, identity/token
  redaction, callback method/path/state validation, PKCE, refresh rotation, and disconnect cleanup.
- `npm run dist`: passed. Electron 42.4.1 produced the Windows portable and NSIS artifacts. Native
  helpers were up to date. Artifacts are unsigned because this machine has no `.signing/` setup or
  SignTool credentials; this is the expected best-effort local build behavior.
- Live OAuth/RPC verification was not performed because this environment has no configured Discord
  tester account or access to the application's Developer Portal settings.

## Required Discord Developer Portal settings

1. Confirm Application ID `1539959318974169088` is the open-quake-owned Discord application.
2. Under OAuth2, enable **Public Client**.
3. Register the exact redirect URI `http://127.0.0.1/callback`. If an unprivileged high port is
   preferred, register that exact URI first and change the source constant/listener together.
4. Permit the `rpc` and `identify` scopes. Do not create or distribute a Client Secret for this
   desktop flow.
5. While the application is unapproved for public RPC use, add each live-verification Discord
   account to the application's tester allowlist. Complete Discord's RPC approval process before
   distributing the integration to normal users.

## Manual live verification

1. Start the Discord desktop client and sign in with an allowed tester account.
2. Start open-quake, open **Settings -> Auth -> OAuth 2.0**, and confirm the Discord card shows scopes
   without any token, secret, or normal Application ID field.
3. Select **Connect**, approve `rpc identify`, and confirm the callback page completes, the card shows
   Authenticated and the safe account identity, and restarting open-quake reuses/refreshes the stored
   authorization without opening a browser.
4. Exercise Voice and confirm its two read probes become available. Open Chat, select a guild, and
   confirm channel discovery becomes available; open a text channel and confirm text selection moves
   from unverified to available.
5. Open Activity, confirm Rich Presence initially says **Not yet verified**, then enable and disable
   it and confirm `SET_ACTIVITY` becomes available only after success.
6. Temporarily remove the tester/permission or invalidate the token and verify 4006 produces the Auth
   attention state, clears tokens, disables affected actions, and requires explicit Reconnect.
7. Select **Disconnect** and confirm the card becomes disconnected, identity disappears, a restart
   does not reconnect, and persisted/editor/panel data contains no access token, refresh token, or
   Client Secret.
