# Copilot — voice + text panel app

A bundled **Copilot** app puts a GitHub Copilot CLI session on the panel, the same way the
[Claude Code app](claude-voice.md) and [Codex app](codex-voice.md) do for their agents: type or
talk to it, watch replies stream in, copy commands out with real cursor selection, and approve or
deny actions from the touchscreen. Add it from the editor via **+ App → Copilot**. All three apps
share one page, one voice pipeline, and one design — only the agent behind them differs.

It drives the `copilot` CLI's `--acp` mode — the open [Agent Client
Protocol](https://agentclientprotocol.com) — using your GitHub Copilot sign-in (no API key, no
separate billing). The session lives entirely on the device.

## Setup

1. Install the Copilot CLI (`npm install -g @github/copilot`) and sign in **once** from any
   terminal: `copilot login`. The panel can't do the interactive login for you; until it's done,
   the page shows a session error telling you to sign in.
2. In the editor, open the **Copilot** app page. The fields match the Claude Code and Codex
   app pages (default folder, folders root, Wyoming STT/TTS host and ports) plus **Mode** — see
   below.

If the copilot CLI isn't installed, the editor shows a warning on the app page the moment you
select it.

## Permission modes

The panel offers four modes, built from the CLI's own **Mode** (`/mode`) and **Permissions**
(`/permissions`) settings:

- **Manual** *(default)* — Copilot asks before every action (touch approval on the panel).
- **Plan** — Copilot describes a multi-step plan without acting on it until approved.
- **Approve for me** — file changes and commands run automatically; the CLI's own approval
  prompts are skipped.
- **Full auto** — autopilot mode: Copilot runs autonomously until the task is done, no prompts
  at all. Same caution as the other apps' full-auto modes.

The editor's Mode is the default for new sessions; the panel's **Mode** button switches the
running session immediately.

### Approvals and "Always"

Approval requests appear as the same touch overlay the Claude Code and Codex apps use, with one
extra button: **✓ Always** — approve *and stop asking for similar requests for the rest of the
session* (ACP's `allow_always`). Deny and Approve behave as expected.

## Models

The Settings **Model** row lists the models your account actually offers (reported live by the
CLI when the session starts), with **Auto** — Copilot's own "let it pick" option — always
available. Switches apply immediately, mid-session.
