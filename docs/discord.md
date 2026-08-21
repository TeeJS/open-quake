# Connecting Discord to open-quake

open-quake's Discord panel controls your Discord voice/mic (mute, voice state) through Discord's
**RPC**. Discord only grants those controls to an application's **owner** — so each person registers
their **own** free Discord application and points open-quake at it. It's a one-time, ~5-minute setup,
the same "bring your own app" pattern used for Home Assistant and similar integrations.

## 1. Create your Discord application
1. Go to <https://discord.com/developers/applications> and sign in.
2. Click **New Application**, give it a name (e.g. "My open-quake"), accept the terms, and **Create**.

## 2. Copy your Application ID
On the app's **General Information** page, copy the **Application ID** (a long number).

## 3. Register the redirect URI
1. In the left sidebar, open **OAuth2**.
2. Under **Redirects**, click **Add Redirect** and paste this **exactly**:
   ```
   http://127.0.0.1:51120/callback
   ```
3. Click **Save Changes**. **It must match exactly** — a wrong port or a missing `/callback` makes Connect silently hang, because Discord errors in the browser and never returns to open-quake.

## 4. Paste the ID into open-quake
1. In open-quake, open the editor and select your **Discord** app page.
2. In the **Discord integration** section, paste your Application ID into **Your Discord Application ID**.
3. Click **Save**.

## 5. Connect
Click **Connect to Discord** (in the Discord integration box, or under **Settings → Auth**). Your
browser opens Discord's authorize page — click **Authorize**. Because you own the app, Discord grants
the controls and open-quake shows **Connected**.

---

## Notes

- **Why your own app?** Discord's RPC voice scopes (`rpc`, `rpc.voice.read`, `rpc.voice.write`, …)
  are restricted to an application's **owner and whitelisted testers** unless Discord approves the app
  for general access. Owning your own app makes you the owner, so it works with no approval and no
  tester list.
- **The redirect URI must match exactly** — including `:51120` and `/callback`. Discord compares it
  character-for-character; a mismatch is the most common cause of a failed connect.
- **Nothing sensitive is shared.** open-quake uses PKCE (no client secret). Your access token is
  stored **encrypted** on your PC and never leaves the app's main process.
- **Rich Presence** (showing "using open-quake" as your Discord status) needs only the Application ID
  — no authorize step — so it works even without the voice-control connect above.
- The Activity view reports capabilities as **ready**, **awaiting use**, or **unavailable**. Some
  features are verified only when they become relevant, such as participant controls after joining
  a voice channel. Tap the capability summary for the full breakdown.
- A saved Rich Presence setting is applied automatically whenever Discord reconnects. The panel
  distinguishes the saved setting from whether Discord has confirmed it in the current session.

## Troubleshooting

| Symptom | Most likely cause / fix |
|---|---|
| **Connect does nothing, or fails right away** | **Did you click Save after entering your Application ID?** Connect uses the *saved* setting — an unsaved ID isn't used. Save, then Connect. |
| `invalid_scope` on the Discord page | The app whose ID is set isn't yours — you're not its owner/tester. Use **your own** app's Application ID (step 2). |
| Connect hangs / nothing after you click **Authorize** | Your redirect URI isn't an **exact** match for `http://127.0.0.1:51120/callback` — Discord errors in the browser and never returns. Re-check step 3 (re-creating the app with the right redirect is the quickest fix); if it still hangs, port `51120` may be in use or blocked locally. |
| Connect button greyed out | Discord integration is disabled, or no Application ID is saved yet. |
