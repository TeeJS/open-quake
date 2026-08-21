# AI-generated panels

Describe a set of buttons out loud and the panel builds it. No macro programming, no editor.

## Using it

1. On an **AI Voice** page, tap **Profile** and pick **Panel Builder**.
2. Say what you want — *"make me a Photoshop masking panel"*, *"a page of OBS scene switches"*,
   *"shortcuts for editing in Premiere"*.
3. The screen shows the panel it wants to build, drawn as real tiles at their real size.
4. **Accept** adds it as a new page and takes you straight to it. **Try again** reopens the mic so you
   can correct it out loud. **Cancel** throws it away.

Refining is just talking: *"use the Windows shortcuts, not Mac"*, *"add a feather tool"*, *"make it two
rows of six"*. Each answer replaces the previous proposal.

If the request is too vague to build — no application or task named — the assistant asks one short
question instead of guessing.

## What it can put on a button

Keystrokes, typed text, websites, program launches, files and folders, other open-quake pages, the
system actions (lock / mic / monitor / config), counters, and multi-step macros. It writes real
shortcuts for the application you name.

## Panels that run commands

A panel may include a **shell command** or an **AutoHotkey** step. Those run code on your PC, so
Accept doesn't take them on trust: the review screen outlines the tile in amber, prints the exact
command it would run, and the button changes to **Run these — Accept**. Read the command before you
press it. Nothing runs while you are reviewing — the command only ever runs later, when you press
that tile.

## What gets checked before a panel can be saved

Every panel the AI returns is validated before it can reach your config
([`app/panelSchema.js`](../app/panelSchema.js)). The validator:

- keeps the grid within the panel's limits (up to 12 columns × 6 rows) and pads the tile list to fit
- drops any tile type or macro step it doesn't recognize, leaving an empty cell
- rejects key combos the keystroke engine couldn't actually send
- allows only `http`/`https` links
- requires go-to-page tiles to point at a page that exists
- forces icons to emoji, so a generated tile can never reference a file or a remote image
- reports every executable tile so the consent screen can show you its command

Anything it adjusted is summarized on the review screen. If nothing usable survives, it tells you
instead of saving an empty page.

## Backends

Works on all five AI Voice backends. **Claude** and **Codex** can look up an application's real
shortcuts as they work, so they tend to be the most accurate for niche software. **Copilot**, **Open
WebUI** and **API-key** pages answer from what the model already knows — fine for mainstream apps,
more likely to guess on obscure ones. Whichever you use, the review screen is the check: you see the
panel before it exists.

## Editing afterwards

An accepted panel is an ordinary grid page. Rename it, rearrange tiles, change a shortcut, merge
tiles, or delete it in the PC editor like any other page — see [editor.md](editor.md).

## The profile itself

**Panel Builder** is a normal entry in **Settings → AI Profiles**, and you can edit its wording to
change the house style of what it builds ("prefer two rows", "always include an undo button"). The
JSON format it must produce is enforced in code, not in that text, so editing the profile can't break
generation. Delete the profile and the feature disappears with it; it won't come back on its own.
