# Current State

Verified on 21 August 2026 against the current source, mocked Discord RPC/OAuth tests, the full
repository test suite, and a Windows portable/NSIS build. Live Discord-account verification still
requires the Developer Portal configuration and tester account described below.

## Settings and configuration ownership

Discord is listed with Microsoft 365 and GitHub under **Settings -> Auth -> OAuth 2.0**. Its provider
card shows authorization/runtime state, the granted or requested Discord scopes, a sanitized
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
with a constant-time comparison, and the `rpc identify rpc.voice.read rpc.voice.write messages.read
rpc.notifications.read` scopes. Code exchange and refresh are public
client requests containing the Application ID and PKCE verifier but no Client Secret. Access and
refresh tokens stay in the encrypted main-process OAuth store; refresh-token rotation is preserved,
and unusable tokens are removed so the next explicit Reconnect can authorize again.

The expanded scopes are the least-privilege set required by Discord's current RPC/OAuth
documentation for voice reads/events, voice writes, message reads in existing user channels, and
notifications. Existing grants that do not contain every required scope are not silently reused:
Settings -> Auth says that updated permissions require approval, automatic reconnect stops, and the
user must explicitly select Reconnect. The authorization URL uses `prompt=consent`. The
`relationships.read` scope is intentionally not requested because it is Social SDK access and is not
needed for the current UI.

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

After authentication, the service subscribes to `VOICE_CONNECTION_STATUS`,
`NOTIFICATION_CREATE`, and `CURRENT_USER_UPDATE`. Joining or discovering an active voice channel
subscribes to `VOICE_STATE_CREATE`, `VOICE_STATE_UPDATE`, `VOICE_STATE_DELETE`, `SPEAKING_START`,
and `SPEAKING_STOP` for that channel. Selecting a text channel subscribes to `MESSAGE_CREATE`,
`MESSAGE_UPDATE`, and `MESSAGE_DELETE`. Changing or leaving a channel sends the matching
`UNSUBSCRIBE` requests before installing the new channel subscriptions; disconnect clears all local
subscription ownership and transport listeners.

The additional capability states cover participants, speaking events, per-user voice control,
connection quality, message events, message history, notifications, and current-user updates.
Subscription success verifies event capabilities. `GET_CHANNEL` verifies participant/history data
only when the documented `voice_states`/`messages` field is actually present. The mutating
`SET_USER_VOICE_SETTINGS` capability remains unverified until a genuine user action succeeds.

Chat enables channel launch while selection is unverified or temporarily failed, allowing the
explicit user action to validate it, but disables it after an unsupported/auth failure. Rich
Presence follows the same rule and labels its initial state **Not yet verified**. Neither capability
is marked Available merely because IPC and authentication succeeded.

## Discord touchscreen app

The touchscreen navigation remains Voice, Chat, and Activity only; this is a functional extension,
not the planned visual redesign. Voice shows only real `GET_CHANNEL`/voice-event participants,
including names, avatars, mute/deaf state, local mute/volume, preserved pan, and speaking state.
Participant mute and 0-200 volume actions use `SET_USER_VOICE_SETTINGS` one modifier at a time. The
UI explains Discord's documented lock: once changed, participant settings belong to the controlling
RPC app until disconnect, when Discord restores the previous values.

Chat retains guild/channel discovery and Open in Discord. Where `GET_CHANNEL` includes `messages`,
it seeds a bounded recent-message list; otherwise the UI explicitly says that history was not
returned while live subscribed messages may still arrive. Create/update/delete events update the
selected channel only. There is no composer or invented send command. Activity shows the sanitized
voice connection state and ping figures plus bounded notifications and recent events. Hostname,
tokens, raw payloads, relationship data, and other unnecessary fields do not reach renderer state.
Messages are bounded to 20, notifications to 8, recent activity events to 8, and ping history to the
documented most recent 20 values.

## Verification

- `npm test`: 246 tests passed, 0 failed. Coverage includes subscription and
  unsubscription lifecycles, participant/speaking updates, per-user controls, connection quality,
  message create/update/delete and bounded history, notifications, scope reauthorization,
  sanitization, listener cleanup, the Auth provider card, PKCE, refresh rotation, and prior Discord
  behavior.
- `npm run dist`: passed. Electron 42.4.1 produced the Windows portable and NSIS artifacts. Artifacts
  are unsigned because this machine has no `.signing/` setup or SignTool credentials.
- Live OAuth/RPC verification was not performed because this environment has no configured Discord
  tester account or access to the application's Developer Portal settings.

## Required Discord Developer Portal settings

1. Confirm Application ID `1539959318974169088` is the open-quake-owned Discord application.
2. Under OAuth2, enable **Public Client**.
3. Register the exact redirect URI `http://127.0.0.1/callback`. If an unprivileged high port is
   preferred, register that exact URI first and change the source constant/listener together.
4. Obtain/permit the `rpc`, `rpc.voice.read`, `rpc.voice.write`, `messages.read`, and
   `rpc.notifications.read` approved-partner scopes; retain `identify`. Do not create or distribute
   a Client Secret for this desktop flow. Do not add `relationships.read` for this implementation.
5. While the application is unapproved for public RPC use, add each live-verification Discord
   account to the application's tester allowlist. Complete Discord's RPC approval process before
   distributing the integration to normal users.

## Manual live verification

1. Start the Discord desktop client and sign in with an allowed tester account.
2. Start open-quake, open **Settings -> Auth -> OAuth 2.0**, and confirm the Discord card shows scopes
   without any token, secret, or normal Application ID field.
3. Select **Connect**, approve the displayed Discord scopes, and confirm the callback page completes, the card shows
   Authenticated and the safe account identity, and restarting open-quake reuses/refreshes the stored
   authorization without opening a browser.
4. Exercise Voice and confirm real participants appear, join/update/leave without polling, speaking
   indicators toggle, participant mute/volume works, and Discord restores those locked settings after
   disconnect. Change/leave channels and confirm old-channel events no longer affect state.
5. Confirm voice connection state, last/average/recent pings appear without the voice hostname.
   Open Chat, select a guild/channel, verify returned history or the honest no-history label, then
   create/edit/delete messages and confirm live updates. Confirm Open in Discord still works.
6. Trigger an eligible Discord notification and confirm the bounded Activity list updates. Change
   the current Discord user's profile and confirm sanitized account state updates.
7. Open Activity, confirm Rich Presence initially says **Not yet verified**, then enable and disable
   it and confirm `SET_ACTIVITY` becomes available only after success.
8. Temporarily remove the tester/permission or invalidate the token and verify 4006 produces the Auth
   attention state, clears tokens, disables affected actions, and requires explicit Reconnect.
9. Select **Disconnect** and confirm the card becomes disconnected, identity disappears, a restart
   does not reconnect, and persisted/editor/panel data contains no access token, refresh token, or
   Client Secret.
