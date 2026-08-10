# Charter — Keyboard Shortcuts app (`keyshortcuts`)

**1. What is the one thing this must do?**
A single on-panel app page listing every keyboard shortcut relevant to the user in
one place: open-quake's own **System** hotkey (rotation toggle), every page's
**Page** jump-to hotkey, and a **Custom** cheat-sheet of free-text shortcut/
description pairs for other programs — one shared list, identical no matter which
page the app is dropped onto.

**2. What would be wrong if we shipped "working" software without it?**
- The System/Pages sections must reflect **live config**, not a snapshot frozen at
  editor-Save time — add a page hotkey, it shows up next time the app is viewed.
- The Custom list is genuinely global: editing it from any instance updates every
  instance. This rules out storing it as a normal per-page app "option" (those are
  always per-instance, e.g. World Clock's city picks) — it lives in
  `config.settings`, the same place `rotation`/`focusFollow` already live.
- Custom rows are hand-typed notes — the most curated content a user enters here.
  Add/remove is per-row (not one big textarea that risks mangling everything on
  one bad edit), and must survive restarts.
- Empty state (no hotkeys configured, zero custom rows) renders as a clean empty
  list, not something broken-looking.

**3. What is explicitly off-limits as a workaround?**
- No folding the custom list into per-app-instance options — that would silently
  make it per-page, which was explicitly decided against.
- No requiring a restart of the app/panel to see a Settings-side edit reflected.

**4. Deployment target and backup location?**
- Bundled **served** app (needs live host data, same category as Music/System
  Monitor, not a static file like Flip Clock): `app/keyshortcutsview.html` +
  `app/keyshortcutsview.js` + entry in `apps/apps.json` (id `keyshortcuts`).
- New read endpoint in `sysserver.js` (pattern: `/nowplaying`, `/metrics`):
  `/shortcuts`, returning the rotation hotkey (if set), every page's
  `{name, shortcut, shortcutStopsRotation}`, and the custom list.
- Custom list: `config.settings.customShortcuts` (array of
  `{shortcut, description}`), edited in **Settings → Software tab** (new section,
  near Screen Rotation/Desktop Focus) — since it's global, not tied to any one app
  instance, that's where it belongs, not in the app's own per-instance options
  panel in the editor.
- Backup: this git repo — commits are the backup.

**5. How will we verify it is done?**
- Set a rotation hotkey and two different pages' jump hotkeys → drop the Keyboard
  Shortcuts app on a third page → all three show up correctly labeled
  System/Pages.
- In Settings, add three custom rows, remove the middle one → app shows the
  remaining two, in order, on next view.
- Add the app to two different pages → edit the custom list from Settings → both
  instances show the identical updated list.
- Restart open-quake → custom rows persist.
- Zero hotkeys configured and zero custom rows → app shows an empty state, not a
  blank/broken page.

## Decisions (signed off 2026-08-05)

1. **Custom list scope**: global/shared across every instance of the app, not
   per-page-instance — a single cheat-sheet.
2. **Editing surface (superseded 2026-08-05)**: originally built as a Settings →
   Software section, reasoning "global data belongs with other global settings."
   Wrong — the actual request was for the rows to appear on the Keyboard
   Shortcuts app's own page-config screen, the same place World Clock's city
   picks are edited (the explicit reference point from the start of this
   conversation). **Current**: the row editor renders in the App tab's options
   area for any page running the `keyshortcuts` app (same slot Music/HA
   Dashboard use for their own custom boxes) — editing surface and data scope
   are separate concerns; rendering here doesn't require the data to be
   per-page. The underlying storage is unchanged (`config.settings
   .customShortcuts`, one shared list, decision 1 above) — only where the input
   fields are drawn moved.
3. **Custom row UI**: one row per custom shortcut, two free-text inputs
   (shortcut, description), starting with one blank row and a **+ Add another
   shortcut** button beneath; each row has its own remove button. Same
   add/remove interaction as the Focus-trigger-apps chip list.
