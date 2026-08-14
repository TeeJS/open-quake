# Codex — voice + text panel app

A bundled **Codex** app puts an OpenAI Codex session on the panel, the same way the
[Claude Code app](claude-voice.md) does for Claude: type or talk to it, watch replies stream in,
copy commands out with real cursor selection, and approve or deny actions from the touchscreen.
Add it from the editor via **+ App → Codex**. Both apps share one page, one voice pipeline, and
one design — only the agent behind them differs.

It drives the `codex` CLI's app-server over its own local protocol, using your ChatGPT
subscription sign-in (no API key, no API billing). The session lives entirely on the device.

## Setup

1. Install the codex CLI (`npm install -g @openai/codex`) and sign in **once** from any terminal:
   `codex login`. The panel can't do the interactive login for you; until it's done, the page
   shows a session error.
2. In the editor, open the **Codex** app page. The fields match the Claude Code app (default
   folder, folders root, Wyoming STT/TTS host and ports) plus **Mode** — see below.

If the codex CLI isn't installed, the editor shows a warning on the app page the moment you
select it.

## Permission modes

The panel offers **exactly the same four modes as the codex CLI's own menu** (`/permissions` in a
terminal), with the same meanings:

- **Read Only** — Codex can read files in the workspace. Approval is required to edit files or
  access the internet.
- **Ask for approval** *(default, same as the CLI)* — Codex can read, edit, and run commands in
  the workspace. Approval is required for the internet or files outside it.
- **Approve for me** — an automated reviewer approves routine actions; only actions it judges
  potentially unsafe reach your panel for approval.
- **Full Access** — no sandbox, no prompts. Same caution as the CLI's own warning.

The editor's Mode is the default for new sessions; the panel's **Mode** button switches the
running session (from the next message).

### Approvals and "Always"

Approval requests appear as the same touch overlay the Claude app uses, with one extra button:
**✓ Always** — approve *and stop asking for similar requests for the rest of the session*
(codex's `acceptForSession`). Deny and Approve behave as expected. Approved commands run outside
the sandbox.

### A Windows note

Codex's own Windows sandbox currently fails on workspaces stored on drives other than `C:`
(an [open codex bug](https://github.com/openai/codex/issues/13378)) — so sandboxed shell commands
in **Read Only** mode may fail with "Access is denied" and Codex will ask to escalate instead.
Nothing to fix on your side: approve the escalation, or work in **Ask for approval** mode.

## Models

The Settings **Model** row lists the models your account actually offers (discovered live), with
the account default marked. Switches apply from the next message.

**Don't ask Codex which model it is** — OpenAI models don't know their own variant name and will
answer generically ("GPT-5") even while provably running as the one you picked. Trust the panel's
Model row, not the model's self-description.

## Everything else

Voice (tap-to-talk, sentence-streaming speech, mute, barge-in via mute or folder switch),
folder switching, transcript persistence, settings (text size, pause tolerance, mic/speaker
pickers), and the RGB ring all work identically to the [Claude Code app](claude-voice.md) — same
page, same controls, same behavior.

Not available on Codex (Claude-app features that have no codex equivalent): slash commands, the
user prompt file, and the external approval hook (codex approvals are built into its protocol —
nothing is ever written to your global CLI config).
