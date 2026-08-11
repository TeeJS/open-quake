# AGENTS.md

## Project Overview

open-quake is a Windows-first Electron launcher and editor for the DK-QUAKE / ARIS-68
touchscreen-and-knob device and the open Bedrock RP2040 knob. It renders grids, dashboards,
and bundled or user-installed apps on a 1920x480 display, then maps touch, knob, desktop,
media, meeting, and Home Assistant events to actions.

The current architecture is mapped in `.ua/knowledge-graph.json`. Use that graph to find
related components, but verify conclusions against current source. The implementation and
`package.json` are authoritative when documentation differs.

## Technology Stack

- CommonJS JavaScript on Node.js and Electron 42; Node 24 is pinned by `.nvmrc`.
- Plain HTML, CSS, and renderer JavaScript; there is no frontend framework or transpilation.
- `node-hid` for hardware, `@jitsi/robotjs` for desktop input, `ws` for Home Assistant,
  and `systeminformation` for telemetry.
- C#/.NET Framework helpers provide Windows SMTC and reserved-display integration.
- `electron-builder` produces Windows portable and NSIS artifacts and invokes Azure
  Trusted Signing when the local signing setup is available.
- Tests use the built-in `node:test` runner. There is no configured lint or typecheck command.

## Repository Structure

- `app/main.js`: Electron main-process entry point and central orchestration layer.
- `app/index.html`, `app/index.js`, `app/panel-preload.js`: touchscreen panel renderer and
  its allowlisted IPC bridge.
- `app/config.html`, `app/config.js`, `app/config-preload.js`: desktop editor and its IPC
  bridge.
- `app/sysserver.js`: loopback HTTP service for built-in pages, served apps, live data,
  app APIs, and the restricted outbound proxy.
- `app/multiKnob.js`: stable hardware facade that selects `src/BedrockConnector.js` first
  and falls back to `src/Aris68Connector.js`.
- `app/*.js` and `app/*view.*`: Windows automation, integrations, collectors, and bundled
  served-page implementations.
- `src/auth/`: OAuth provider definitions, PKCE flow, and token persistence.
- `src/Aris68Connector.js`: reverse-engineered ARIS-68 HID driver.
- `src/BedrockConnector.js`: open Bedrock HID driver.
- `apps/`: bundled app assets and the declarative `apps/apps.json` catalog.
- `community-apps/`: distributable drop-in app sources and release ZIPs.
- `native/`: C# source for SMTC and reserved-display helper executables.
- `test/`: Node unit tests; coverage is currently concentrated on reserved-display control.
- `tools/`: standalone ARIS-68 HID diagnostics and icon tooling.
- `docs/`: user guides, the drop-in contract, device protocol, and panel design system.

## Architecture and Important Flows

### Startup and state

`package.json` points Electron at `app/main.js`. On `app.whenReady()`, the main process
decrypts configuration secrets in memory, creates the tray, starts `app/sysserver.js` on an
OS-assigned loopback port, ensures built-in pages, warms integrations, registers IPC, places
the panel window, and starts both device connectors through `MultiKnob`.

The mutable user configuration is stored beneath Electron's per-user data directory. The
checked-in `app/config.default.json` is only the first-run seed; `app/config.json` is a legacy
development/runtime location and is ignored by Git. `loadConfig()`, `migrateConfig()`, and
the `ensure*Page()` functions in `app/main.js` preserve existing user state while evolving
the schema.

### Main/renderer boundary

OS, filesystem, device, credential, and process access stays in the main process. Both
renderer windows use `nodeIntegration: false` and `contextIsolation: true`. Their preload
files expose narrow APIs; `app/main.js` validates the sending window before servicing IPC.
Do not expose raw `ipcRenderer`, Node modules, or filesystem access to renderer content.

Panel state flows from `app/main.js` through `panel-preload.js` into `app/index.js`. Editor
state flows through `config-preload.js` into `config.js`; saving returns the complete config
to the main process, which persists it and pushes the new state to the panel.

### Pages, apps, and local HTTP

Pages in config are tile grids, external web dashboards, or app pages. `apps/apps.json`
describes bundled apps and their option schemas. Static apps load by `file://` with options
in the hash; served apps load from `/apps/<id>/...` with non-secret options in the query.

`app/sysserver.js` binds only to `127.0.0.1`. Its live-data, secret, proxy, and app-API routes
enforce host and same-origin checks. Drop-in paths are contained within the app root, proxy
destinations are manifest-allowlisted, and host-side executable content requires import
confirmation. Preserve all invariants in `docs/drop-in-spec.md` when changing this area.

### Hardware and native helpers

`MultiKnob` owns both connectors and forwards their common event shape. Bedrock wins if both
devices are present; ARIS-68 additionally supplies panel touch/control features. Callers in
the rest of the app should depend on `MultiKnob`, not instantiate a connector directly.

`build-smtc.js` compiles `native/smtc-art.cs`, `native/smtc-control.cs`, and
`native/reserved-display.cs` into ignored `app/native/*.exe` files. Compilation is
best-effort during development, so missing helpers disable features without blocking startup.
`afterpack.js` signs bundled helpers after packaging; `sign.js` handles builder artifacts.

### Secrets and external integrations

`app/secretStore.js` identifies secret fields from config structure and app option schemas.
Windows uses per-value DPAPI through `app/dpapi.js`; other platforms use Electron
`safeStorage`. Secrets are plaintext only in the in-memory config and must never be added to
URLs, logs, snapshots, fixtures, or documentation.

Home Assistant logic is split between `app/haClient.js`, `app/haschedule.js`, editor state,
and main-process cache/IPC. OAuth provider metadata lives in `src/auth/providers.js`, tokens
are managed by `src/auth/token-storage.js`, and the authorization flow is in
`src/auth/oauth-handler.js`.

## Development Commands

Use Windows and an LTS Node release supported by `package.json`; Node 24 is the verified and
pinned version. Node 25+ is unsupported by the native rebuild toolchain.

```powershell
npm install --ignore-scripts
node node_modules/electron/install.js
npm run rebuild
npm start
```

- `npm run rebuild`: rebuild `node-hid` for Electron 42.4.1 rather than the host Node ABI.
- `npm run build:smtc`: compile stale C# helpers when the Windows SDK/.NET toolchain exists.
- `npm test`: run `node --test test/*.test.js`.
- `npm run dist`: build Windows portable and NSIS packages under `dist/`.

`npm start` and `npm run dist` run `build-smtc.js` first. A native rebuild also requires the
Visual Studio 2022 C++ build tools and a working Python/node-gyp setup. See
`docs/building.md` for the exact machine prerequisites and hardware setup.

## Coding Conventions

- Match the surrounding CommonJS style: `'use strict'`, `require`, `module.exports`,
  semicolons, and two-space indentation.
- Keep privileged behavior in focused main-process modules and expose only the smallest
  required preload operation.
- Treat configured IDs as stable. App IDs follow `^[a-z0-9][a-z0-9_-]*$`; page and manifest
  references depend on them.
- Preserve graceful degradation around optional hardware, Windows helpers, and integrations.
  Existing startup paths intentionally catch failures so the launcher remains usable.
- Panel layouts target a physical 1920x480 surface. Read `docs/design-system.md` before
  creating or restyling panel UI, and test both light/dark themes and landscape behavior.
- Keep user-visible docs synchronized with behavior. Do not copy stale path claims from docs;
  for example, both connector implementations currently live under `src/`.

## Change Guidelines

- When adding or changing IPC, update the owning renderer, its preload allowlist, and the
  matching guarded handler in `app/main.js`. Keep channel names and argument shapes aligned.
- When changing the config schema, update `app/config.default.json`, editor read/write logic,
  runtime consumers, and a migration/defaulting path for existing user configs.
- When adding a bundled app, register it in `apps/apps.json`, add its assets, and verify URL
  option delivery. If it is served or handles secrets, also inspect `app/sysserver.js` and
  `app/secretStore.js`.
- When changing a secret option or auth field, update secret discovery/transforms and verify
  the persisted form is encrypted while renderer-facing and URL data remain sanitized.
- When extending a device connector, keep the shared event/method contract in
  `app/multiKnob.js`; implement harmless unsupported-method behavior on the other connector.
- When changing an HTTP or drop-in route, preserve path containment, loopback binding,
  anti-DNS-rebinding checks, same-origin gating, proxy SSRF restrictions, response limits,
  and executable-import consent from `docs/drop-in-spec.md`.
- When changing a C# helper or adding one, update `build-smtc.js`, the JavaScript wrapper,
  packaging/unpack behavior, signing coverage, and focused tests where the JS process boundary
  can be exercised without hardware.
- When changing reserved-display behavior, update both `app/reservedDisplay.js` and
  `native/reserved-display.cs` as applicable, then extend `test/reservedDisplay.test.js`.
- When changing OAuth providers, inspect provider aliases, token migration/storage, OAuth flow,
  editor IPC, secret handling, and any served app that requests provider tokens.
- When changing public app behavior or schemas, update the corresponding guide under `docs/`;
  drop-in contract changes require updating `docs/drop-in-spec.md` and its template/examples.

## Generated and Managed Files

- Do not edit `app/native/*.exe`; regenerate them from `native/*.cs` with
  `npm run build:smtc`. These outputs are ignored and unpacked into release artifacts.
- Do not edit `dist/`, `node_modules/`, or other ignored build outputs.
- Treat `package-lock.json` as npm-managed and commit it when dependency resolution changes.
- Treat `.ua/` as generated Understand Anything analysis. Regenerate it from source rather
  than hand-editing graph or fingerprint data.
- Never commit runtime `app/config.json`, `.env`, `.signing/`, credentials, tokens, logs, or
  machine-specific configuration.

## Repository-Specific Pitfalls

- Never call `enterDfu()` during ordinary development or tests; it can place the ARIS-68 in
  firmware-flash mode and risk bricking the device.
- `src/Aris68Connector.js`, `docs/DEVICE_PROTOCOL.md`, `tools/probe.js`, and
  `tools/writetest.js` are PolyForm Noncommercial 1.0.0. The rest is generally MIT; consult
  `NOTICE` before moving or reusing protocol-bearing code.
- Do not run write-path HID diagnostics casually on attached hardware. Most unit work should
  use injected fakes like the reserved-display tests.
- Do not assume C# helper compilation succeeded merely because `npm start` exited the build
  step successfully; `build-smtc.js` intentionally treats unavailable toolchains as non-fatal.
- `PROJECT.md` is a feature charter, not a complete architecture document. Validate its claims
  against current code before using it as implementation guidance.
- Tests are sparse and do not cover real Electron windows, hardware, dashboards, or packaging.
  Passing `npm test` is necessary but not sufficient for changes in those areas.

## Definition of Done

- Run `npm test` for every change and add focused `node:test` coverage for testable logic.
- Exercise the relevant Electron flow with `npm start` when main/preload/renderer behavior
  changes; use actual hardware only when the change requires it.
- For panel UI changes, verify the 1920x480 layout, touch and knob navigation, both themes, and
  any grid-strip or webview mode affected.
- For integration or security changes, verify failure behavior, secret redaction, origin/path
  restrictions, and persistence across restart.
- For packaging/native changes, run the relevant helper build and `npm run dist` on a properly
  provisioned Windows machine, then verify the expected helpers and signatures in the artifact.
- Update affected documentation and confirm no secrets, generated files, or runtime config were
  introduced into the diff.
