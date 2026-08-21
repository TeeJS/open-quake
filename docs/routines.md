# AI Routines

A **routine** is a saved request plus which **AI Chat** page — and, for the agent backends, which
**folder** and **permission mode** — runs it. Put one on a tile and tapping it switches the panel to that page and sends the
request — answered by the real agent, with its normal tools and approvals, not a canned reply.

## Saving one

**From the panel.** On any AI Chat page, the **`+ Routine`** button sits beside `Send`. Tap it and
it keeps whatever is in the message box — or, if that's empty, the last thing you asked for. So the
usual flow is: say the thing, watch it work, tap `+ Routine`.

It also records the page's **current folder** and **permission mode**, so re-running the routine
lands in the same repo, under the same permission level, you had when you saved it.

It names itself from the first few words of the request and confirms under the transcript
("Saved routine: Summarize my unread email and…"). There's no naming dialog because the panel has no
on-screen keyboard; rename it later on the PC.

**From the PC.** Settings window → **Routines** tab → **+ Add routine**, for ones you'd rather
compose than speak.

## Managing them

Settings window (tray icon) → **Routines** tab, next to AI Profiles. It's a two-pane view: a
searchable list on the left, the selected routine's fields on the right — so a library of twenty
routines stays scannable instead of twenty open forms.

- **The list** shows each routine's name, its target AI Chat page, and a one-line prompt preview.
  The header counts them ("12 routines", or "4 of 12 routines" while searching).
- **Search** filters by name, prompt, target page, and folder as you type. Searching only filters
  the view — it never changes what's stored or the order. If your current pick is filtered out, the
  first visible result is selected; if nothing matches you get a plain empty state.
- **Click a routine** to edit it on the right. Fields:

| | |
|---|---|
| **Name** | What the tile shows in its picker. Rename freely. |
| **AI Chat page** | Which page — and therefore which backend — runs it. Changing it refreshes the Folder and Mode controls below. |
| **Profile** | Optional. Blank means whatever profile that page is currently on. |
| **Folder** | The working directory the agent runs in. Blank means leave the page wherever it already is. Only shown for the **Claude / Codex / Copilot** backends — Open WebUI and API pages are plain chat with no working directory, and say so instead. |
| **Mode** | The permission level the routine runs under (e.g. Claude's Manual / Accept edits / Plan / Full auto — each backend has its own set). Blank means leave the page on whatever mode it's set to. Only shown for the backends that have modes (same three). |
| **Prompt** | The request itself. |

- **+ Add routine** (by the list header) makes a new one, selects it, and focuses its name.
- **Run routine** (green, in the detail pane) runs it right now on the panel — handy for testing one
  as you write it. If you have unsaved edits it saves first, so it always runs what's on screen.
- **Delete routine** (in the detail pane) removes it after a confirmation that names it. Deleting a
  routine does not touch tiles that referenced it — those simply report "routine not found" until
  you point them elsewhere.

Edits apply to the in-memory config as you make them; the window's **Save** button is what writes
them to disk, exactly as before. Unsaved edits survive selecting a different routine or searching.

Routines are global, not per page: one routine can sit on as many tiles and pages as you like, and
editing it here changes every tile at once.

## Putting one on a tile

In the tile editor, set the tile's **Type** to **AI Routine**, then pick the routine from the
dropdown — same as choosing a destination for a "Go to page" tile. Give it a label and icon as usual.

**Macros too.** `AI Routine` is also a macro step kind, so a macro can do "launch Teams → wait 2s →
run the standup routine".

## What happens on a tap

1. The panel switches to the routine's AI Chat page.
2. Its saved profile, permission mode, and folder are set on that page, and the agent session
   starts (or restarts) with them. A routine that names a different folder or a different mode than
   the page is currently on starts a **fresh** session — **which ends whatever conversation was on
   that page**, the same as switching folders on the panel. A routine that matches the page's
   current context just adds its turn to the ongoing conversation.
3. Its saved prompt arrives as if you'd just spoken it.
4. The agent answers normally — streaming reply, tool calls, touch approvals, spoken reply if that
   page's speaker is on.

Because it's an ordinary turn, everything else still works: you can talk back to it, approve a tool
call, or leave the page and come back — the session keeps running and the page replays the
transcript when you return.

## When it can't run

Nothing fails silently; the panel shows a short notice over the grid.

- **The routine's AI Chat page was deleted** → it runs on your first AI Chat page instead and says
  so, naming the page it used.
- **No AI Chat page at all** → it says so rather than doing nothing.
- **The routine itself was deleted** but a tile still points at it → the tile reports that.
- **Tapped while the agent is mid-turn** → it queues behind the current one, same as typing would.

## Honest limits

Saving from the panel puts the routine in your library; **placing it on a tile is still a trip to
the PC**, because picking a page and a grid slot has no good touch UI yet.

AI-generated panels (the Panel Builder profile) deliberately cannot create AI Routine tiles — a
model would invent routine ids that point at nothing, producing tiles that look right and do
nothing.
