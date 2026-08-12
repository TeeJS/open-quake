# Security Audit

**Audit date:** 2026-08-11  
**Repository:** open-quake  
**Audit type:** source, local Git history, dependency, Electron boundary, loopback service, packaging, and existing-artifact review; no live credentials or remote systems were tested

## Executive Summary

open-quake has a generally thoughtful desktop-security foundation: privileged work remains in the Electron main process; renderer Node integration is disabled; context isolation and CSP are present; IPC handlers normally check the owning window; the local HTTP service binds only to IPv4 loopback and rejects foreign Host and cross-site browser requests; app paths are contained; remote dashboard permissions are denied by default; OAuth uses the system browser, strong state, PKCE S256, and encrypted persistence; and no suspected real credential was found.

At the time of the original audit, the overall posture was **partially hardened but required remediation before the served-app platform could safely handle durable OAuth credentials**. The highest-priority issue was an authorization failure at the local HTTP boundary: any served app on the shared loopback origin or native local client able to discover the port and forge request headers could call a global endpoint returning access and refresh tokens. **SEC-001 was resolved on 2026-08-11** by removing the global token and connect routes, keeping Microsoft Graph calls and OAuth credentials in the main process, and requiring a rotating, expiring, memory-only Office session capability.

The next priorities are to revalidate outbound-proxy destinations after every redirect and after DNS resolution, make release signing fail closed, and reduce secret-bearing renderer and packaging surfaces. An existing local 0.3.8-beta.1 artifact was unsigned, consistent with the current signing hook's explicit fail-open behavior; that artifact predates the current 0.4.2 source and was not assumed to be a published release.

### Original findings

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| High | 1 |
| Medium | 4 |
| Low | 2 |
| Informational | 2 |

### Current remediation status

| Status | Critical | High | Medium | Low | Informational | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Open | 0 | 0 | 4 | 2 | 2 | 8 |
| Resolved | 0 | 1 | 0 | 0 | 0 | 1 |

**Suspected real secrets discovered:** No.  
**External baseline refreshed:** Yes, from current official/primary sources on 2026-08-11.

## Scope

The audit inspected the application entry point, both BrowserWindows and preload bridges, panel/editor renderers, dashboard webview/session, loopback HTTP service, served/drop-in app model, action execution, filesystem and archive handling, outbound proxy, OAuth and Home Assistant integrations, secret storage, native helpers, build/signing scripts, dependency manifests and installed dependency tree, documentation, generated architecture graph, local Git history, tracked community ZIPs, and existing ignored release artifacts.

Primary areas included:

- `app/main.js`, `app/sysserver.js`, `app/actionRunner.js`, `app/panel-preload.js`, and `app/config-preload.js`;
- `app/secretStore.js`, `app/dpapi.js`, `app/haClient.js`, and `app/haschedule.js`;
- `src/auth/providers.js`, `src/auth/oauth-handler.js`, and `src/auth/token-storage.js`;
- drop-in manifests, server modules, ZIPs, `docs/drop-in-spec.md`, and the app catalog;
- `package.json`, `package-lock.json`, `build-smtc.js`, `sign.js`, and `afterpack.js`;
- `.ua/knowledge-graph.json` as a map only, with conclusions verified against source;
- the existing `dist/` artifact set, without executing installers or applications.

Tools and checks used:

- targeted source-to-sink review and filename-only secret searches with `rg`;
- a redacted scan of credential-shaped JSON in the tree and tracked ZIPs;
- a filename-only high-confidence credential-pattern scan across 202 local commits;
- `npm audit --json --ignore-scripts` and `npm audit --omit=dev --json --ignore-scripts`;
- `npm ls --depth=0`;
- ASAR filename listing without extraction;
- Windows Authenticode status checks on existing executables;
- the repository's `npm test` command after report generation.

Limitations:

- No live OAuth, Home Assistant, dashboard, proxy, or third-party account was accessed.
- No credential was tested, transmitted, revoked, or rotated.
- Provider-side app registration, tenant policy, consent, token lifetime, refresh rotation, and revocation behavior were not verified.
- No malicious archive was expanded and no SSRF target was contacted.
- The existing artifact is older than the audited source. No new release was produced.
- Local Git coverage does not prove that remotes, release assets, other clones, reflogs, or unreachable objects are clean.
- Hardware, C# helper behavior, actual Electron windows, and installer execution were not dynamically exercised.
- This is a technical source audit, not a penetration test, ISO/IEC certification, or assessment of an organisation's ISMS.

## Security Baseline

| Source | Status | Version/RFC | Date | Applicability |
| ------ | ------ | ----------- | ---- | ------------- |
| [OAuth 2.0 Security Best Current Practice](https://www.rfc-editor.org/rfc/rfc9700.html) | IETF Best Current Practice | RFC 9700 / BCP 240 | 2025-01 | Redirect-flow, token leakage, scope, and refresh-token protection. |
| [OAuth 2.0 for Native Apps](https://www.rfc-editor.org/info/rfc8252/) | IETF Best Current Practice | RFC 8252 / BCP 212 | 2017-10 | Electron is an end-user-distributed native/public client; applies to external browsers, PKCE, and loopback redirects. |
| [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security) | Official platform guidance | Current online guidance | Refreshed 2026-08-11 | Sandboxing, webviews, navigation, IPC sender validation, CSP, permissions, and external URLs. |
| [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/) | Published verification standard | 5.0.0 | 2025-05-30 | Concrete verification requirements for local web/API, OAuth, secrets, files, and architecture. |
| [OWASP WSTG](https://owasp.org/www-project-web-security-testing-guide/) | Stable testing guidance | 4.2 | 2020-12-03 | Source review and web/API test methodology; version 5.0 remains in development. |
| [OWASP Top 10](https://owasp.org/Top10/2025/0x00_2025-Introduction/) | Published awareness/risk communication | 2025 | 2025 | Risk communication only; ASVS is used for detailed requirements. |
| [OWASP API Security Top 10](https://owasp.org/API-Security/editions/2023/en/0x03-introduction/) | Published API awareness guidance | 2023 | 2023-07 | Local API authorization, SSRF, and function-level access. |
| [ISO/IEC 27001](https://www.iso.org/standard/27001?browse=tc) | Published International Standard | ISO/IEC 27001:2022, Amd 1:2024 noted | 2022-10 | ISMS and risk-management context; organisational evidence is out of scope. |
| [ISO/IEC 27002](https://www.iso.org/standard/75652.html) | Published International Standard | ISO/IEC 27002:2022 | 2022-02 | Broad access-control, cryptography, secure-development, supplier, and configuration control areas. |
| [ISO/IEC 27034-1](https://www.iso.org/standard/44378.html) | Published and confirmed current | ISO/IEC 27034-1:2011 | Published 2011-11; confirmed 2022 | Application-security concepts and integration into application lifecycle processes. |
| [ISO/IEC 27034-5](https://www.iso.org/standard/55585.html) | Published and confirmed current | ISO/IEC 27034-5:2017 | Published 2017-10; confirmed 2023 | Application security controls and lifecycle reference model. |
| [Electron advisory GHSA-r4w5-6pfg-jxp5](https://github.com/electron/electron/security/advisories/GHSA-r4w5-6pfg-jxp5) | Maintainer security advisory | CVE-2026-70606 | 2026-07-27 | Installed Electron 42.4.1 is in the affected range, but the vulnerable `ProtocolResponse.url` API is not used here. |
| npm registry advisory service | Current ecosystem tooling | npm audit report v2 | Queried 2026-08-11 | Known vulnerabilities in the locked/installed dependency graph. |

## Emerging Guidance

- [OAuth 2.1 draft-15](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-15) is an active Standards Track Internet-Draft dated 2026-03-02 and expiring 2026-09-03. It is work in progress, not an established requirement. Its direction reinforces authorization code plus PKCE, strict redirect handling, and removal of legacy grants; open-quake already avoids implicit and password grants.
- OWASP WSTG 5.0 remains under development. Stable WSTG 4.2 was used for testing-methodology status.
- Electron supports the latest three stable major lines. The project should continue applying the newest patched release within its selected supported major rather than treating a major pin as sufficient.

## Architecture and Attack Surface

### Runtime components

1. **Electron main process (`app/main.js`)** owns configuration, secrets, filesystem operations, process execution, OS input automation, OAuth, hardware, native helpers, tray, and IPC.
2. **Panel renderer (`app/index.html`, `app/index.js`, `app/panel-preload.js`)** renders the physical 1920x480 interface and receives a high-impact but allowlisted preload API, including action launch and OAuth-token retrieval.
3. **Editor renderer (`app/config.html`, `app/config.js`, `app/config-preload.js`)** edits complete configuration and can request filesystem pickers, imports, local file-to-data conversion, OAuth operations, HA data, and device setup.
4. **Dashboard webview** uses `persist:dashboards`, displays arbitrary configured web dashboards, and has a permission handler that allows only approved audio capture origins.
5. **Loopback HTTP service (`app/sysserver.js`)** binds an OS-assigned port on `127.0.0.1`, serves built-in and third-party apps, exposes live data and side effects, releases OAuth tokens, loads optional app server modules, and proxies allowed outbound GET requests.
6. **Drop-in apps** may be static web content, same-origin served web content, full-privilege Node server modules, or packages containing native/script executables. Import warns for host code, but not for client-side JavaScript.
7. **External integrations** include Microsoft OAuth/Graph, Home Assistant REST/WebSocket, dashboard hosts with optional injected credentials, RSS/lyrics services, Open WebUI, and user-configured app proxy targets.
8. **Build/release components** compile C# helpers, package Electron/Node/native resources, and optionally use Azure Trusted Signing.

### Significant entry points

- Electron IPC handlers in `app/main.js:1582-1727`;
- preload APIs in both preload files;
- the `<webview partition="persist:dashboards">` in `app/index.html:89`;
- loopback GET routes in `app/sysserver.js:309-394`;
- imported ZIPs and manifests in `app/main.js:371-401`;
- app server `require()` in `app/sysserver.js:256-271`;
- arbitrary user-authored command, AutoHotkey, application, file, URL, keyboard, and text actions in `app/main.js:913-974`;
- configured HTTP(S)/WS(S) URLs for dashboards, Home Assistant, icons, app proxying, and app APIs;
- existing native executables and C# helper build/signing hooks.

### Trust boundaries

| Boundary | Data/capability crossing | Principal controls | Assessment |
| --- | --- | --- | --- |
| Internet/dashboard → webview | Remote HTML, script, cookies, auth headers | Separate webview, Node off, web security default, permission handler, external URL scheme filter | Partially mitigated; central attach/navigation/window controls are incomplete. |
| Panel renderer → main | Actions, grid state, token requests, OS input | Context isolation, preload allowlist, sender `webContents` equality | Partially mitigated; action and token capabilities are very broad if the host renderer is compromised. |
| Editor renderer → main | Full config, secret edits, file reads/imports/device setup | Context isolation, preload allowlist, sender equality | Partially mitigated; the renderer receives all plaintext secrets and sender origin/frame is not checked. |
| Served/drop-in app → loopback host | Tokens, config, proxy, live data, media/launch/meeting actions | Host header, `Sec-Fetch-Site`/Origin, same-origin CSP | Not adequately authorized for global tokens; multiple apps share one origin and native clients can forge headers. |
| Loopback proxy → network | Configured URL and redirects | HTTP(S) allow rules, response cap, timeout, initial private-host check | Partially mitigated; redirect/DNS destinations are not revalidated. |
| Imported ZIP → app data → host | HTML/JS, optional Node/native code | ID/entry validation, confirmation for host executable content, temp directory | Partially mitigated; no archive expansion limits. |
| Config on disk → main memory | OAuth, HA, dashboard and app secrets | DPAPI/safeStorage transforms | Partially mitigated; explicit plaintext fallback and long-lived in-memory copies exist. |
| Build machine → release artifact | Source, ignored local files, native helpers, signatures | File exclusions, optional Trusted Signing | Partially mitigated; broad inclusion and fail-open signing. |

## Threat Model

| Threat | Status | Evidence | Related Findings |
| ------ | ------ | -------- | ---------------- |
| Unauthenticated remote network attacker reaches local service | Mitigated | Service binds `127.0.0.1`; no LAN bind was found. | — |
| Malicious Internet page uses browser requests or DNS rebinding against loopback | Mitigated for ordinary cross-site browser requests | Exact loopback Host and fail-closed `Sec-Fetch-Site`/Origin checks. | — |
| Malicious local native process accesses loopback secrets | Not mitigated | Request headers are forgeable outside a browser and no unguessable process/session capability is required. | SEC-001 |
| Malicious or compromised served drop-in app steals OAuth credentials | Not mitigated | Shared origin can call global token route; response includes refresh token; CSP allows outbound connections. | SEC-001 |
| Compromised editor renderer steals all integration secrets | Partially mitigated | CSP/isolation help, but full decrypted config and high-impact preload operations are available. | SEC-002 |
| Compromised panel host renderer executes OS commands | Partially mitigated | CSP/local code reduce entry paths; preload `launch()` can reach configured command execution. | SEC-002 |
| Compromised remote dashboard pivots directly to Node/main | Partially mitigated | Remote content is in a Node-disabled webview and has no preload; missing central attach/navigation controls reduce assurance. | SEC-002 |
| Attacker-controlled proxy endpoint pivots to localhost/LAN/link-local service | Not mitigated across redirects/DNS | Only initial textual hostname is checked; redirects recurse directly. | SEC-003 |
| Release consumer cannot verify publisher/integrity | Not mitigated when signing setup is absent | Signing hook returns success after warning; inspected artifact is unsigned. | SEC-004 |
| Developer local secret enters artifact | Partially mitigated | Runtime config/signing dir excluded, but broad `**/*` includes `.env` and other ignored files unless explicitly excluded. | SEC-005 |
| Malicious ZIP exhausts disk/CPU during import | Not mitigated | Full archive expands before any count/expanded-size policy. | SEC-006 |
| Offline config copy exposes secrets | Mitigated when backend works; not mitigated on fallback | Current-user DPAPI/safeStorage normally protects selected fields; fallback stores plaintext. | SEC-007 |
| Developer commits a secret | Partially mitigated | `.env`, runtime config, signing assets, and logs are ignored; no automated secret gate was found. | SEC-005, SEC-009 |
| Previously committed secret remains in local history | Unable to verify completely | High-confidence local history scan found none; remotes/unreachable objects not covered. | — |
| Malicious dependency/build environment compromises artifact | Partially mitigated | Lockfile and audit tooling exist; no CI, provenance, SBOM, or enforced signed-release gate was found. | SEC-004, SEC-008, SEC-009 |
| Stolen OAuth access token | Not mitigated after exfiltration | Bearer access token is deliberately released to JavaScript; sender constraint was not verified. | SEC-001 |
| Stolen OAuth refresh token | Not mitigated at app boundary | Refresh token is unnecessarily returned to page/renderer callers. | SEC-001 |

## Findings

### SEC-001 — Global loopback token route exposes OAuth access and refresh tokens without app/process authorization

**Severity:** High  
**Status:** Resolved  
**Confidence:** High

**Affected components:** `app/sysserver.js:300-354`; `src/auth/oauth-handler.js:182-193`; `app/main.js:522-528`; `app/panel-preload.js:22`; `app/config-preload.js:14`; local served/drop-in apps.

**Repository evidence:** `sameOrigin()` accepts `Sec-Fetch-Site: same-origin` as sufficient (`app/sysserver.js:300-307`). `/api/oauth-tokens.json` has no requester app identity, per-app provider/scope allowlist, authentication secret, or process/user binding (`app/sysserver.js:340-347`). `getValidTokens()` returns both `accessToken` and `refreshToken` (`src/auth/oauth-handler.js:182-193`). All served apps share the same origin and the CSP permits outbound HTTP(S)/WS(S) connections (`app/sysserver.js:31-40`). Client-side JavaScript is explicitly not treated as host code during import (`docs/drop-in-spec.md:278-290`). A non-browser local process can forge both Host and Fetch Metadata headers once it discovers the listening port.

**Attack scenario:** A user imports a visually plausible client-only served app, or a served app is compromised by malicious content. Its JavaScript requests the Microsoft token route and exfiltrates the returned bearer and refresh tokens. Separately, a local process under another desktop session/account can scan loopback ports and make the same request with forged headers.

**Prerequisites:** The app must be running and have a connected provider with a refresh token. The served-app path requires its code to execute while loaded; the local-process path requires local code execution and discovery of the ephemeral port.

**Impact:** Immediate access to resources covered by the issued access token and potentially durable ability to mint further access tokens using the refresh token. The current suggested Microsoft scopes can include profile, presence, and calendar data. A copied token is usable outside open-quake; local disconnect cannot recover a token already exfiltrated.

**Existing mitigations:** Loopback-only bind prevents LAN access. Host and Fetch Metadata checks meaningfully block ordinary hostile web pages and DNS rebinding. OAuth tokens are encrypted on disk when secure storage works. Requested scopes are checked against the stored grant before refresh. These controls do not authorize one served app or native local process.

**Authoritative references:** [RFC 9700 refresh-token protection](https://www.rfc-editor.org/rfc/rfc9700.html#name-refresh-token-protection); [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security); [OWASP ASVS 5.0.0 requirements CSV](https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/docs_en/OWASP_Application_Security_Verification_Standard_5.0.0_en.csv).

**OWASP mapping:** ASVS v5.0.0 V8.2.1, V8.3.1, V10.1.1, V14.2.6, and V3.5.4; OWASP Top 10 A01:2025 Broken Access Control; API5:2023 Broken Function Level Authorization.

**ISO/IEC relevance:** Access control, least privilege, protection of authentication information, secure architecture, and application security control design.

**Recommended remediation:** Keep refresh tokens exclusively in the main process. Prefer narrow main-process Graph operations over releasing bearer tokens. If access tokens must reach an app, issue only a minimal access-token DTO and derive the requester identity from an isolated origin/session that the app cannot choose. Maintain a host-controlled allowlist of app → provider → resource → scopes. Replace header-only loopback trust with an unguessable per-process/per-session capability and ensure it cannot be read by unrelated apps; consider isolated origins/partitions or a user-scoped IPC mechanism. Remove unused token getters from preload bridges. Add negative tests proving unrelated apps and unauthenticated local HTTP clients cannot obtain credentials.

**Remediation outcome (2026-08-11):** Resolved. The global `/api/oauth-tokens.json` and `/api/oauth-connect` routes, both preload token getters, and the matching IPC token handler were removed. The editor configuration DTO now redacts OAuth token records and client secrets. The built-in Office page calls fixed `/api/office/data` and `/api/office/connect` operations through a random memory-only capability delivered in the URL fragment, rotated after every authorized request, expired after bounded inactivity, and cleared on page exit, disconnect, and shutdown. Provider, scopes, and the three supported Microsoft Graph reads are fixed in the main process; neither access nor refresh tokens reach served or renderer JavaScript. Focused tests cover forged native headers, unrelated served apps, legacy routes, capability absence/malformation/replay/expiry/replacement, Host and cross-site rejection, fixed scopes, internal refresh rotation, renderer DTO redaction, and the positive Office data path. Remaining broader renderer-origin and secret-minimisation work is tracked separately by SEC-002.

### SEC-002 — Secret-bearing renderer capabilities lack navigation/origin confinement

**Severity:** Medium  
**Confidence:** High for exposure, Medium for exploitability

**Affected components:** `app/main.js:125`, `app/main.js:1098-1110`, `app/main.js:1199-1208`, `app/main.js:1582-1708`; both preload files; editor/panel host renderers.

**Repository evidence:** `getConfig` returns the live decrypted configuration to the editor, including OAuth tokens, Home Assistant token, dashboard passwords/headers, and app secrets. The editor also exposes OAuth token retrieval and arbitrary local image reads; the panel exposes action launch and token retrieval. `isFrom()` compares only `e.sender` with the expected `webContents` (`app/main.js:125`), not `senderFrame.url`. No main-process `will-navigate`, `setWindowOpenHandler`, or `will-attach-webview` enforcement was found. The BrowserWindows correctly set `nodeIntegration: false` and `contextIsolation: true`.

**Attack scenario:** An XSS, compromised packaged renderer asset, unintended host-window navigation, or future unsafe webview attachment executes in the editor or panel host page. The script calls the existing preload API to retrieve every decrypted secret, read files, or submit a `cmd` action that reaches `child_process.exec`.

**Prerequisites:** Compromise or unexpected navigation of a trusted host renderer. No direct current DOM-XSS path was confirmed, so this is not reported as immediate remote code execution.

**Impact:** Cross-integration credential theft, arbitrary local file disclosure through the editor bridge, or OS command execution through the panel action bridge.

**Existing mitigations:** Local packaged host HTML, restrictive `script-src 'self'`, context isolation, Node integration disabled, narrow channel names, and owning-window sender checks substantially reduce likelihood. The remote dashboard webview has no preload.

**Authoritative references:** [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security), especially navigation, window creation, webview option validation, API exposure, and IPC sender guidance.

**OWASP mapping:** ASVS v5.0.0 V8.3.1, V10.1.1, V14.2.6, and V15.2.5; OWASP Top 10 A01:2025 and A06:2025 Insecure Design.

**ISO/IEC relevance:** Least privilege, secure coding, application isolation, and protection of authentication information.

**Recommended remediation:** Return renderer-specific redacted DTOs and use focused secret setter operations with “configured” sentinels. Remove OAuth getters where no consumer requires them. Validate `senderFrame.url` against the exact packaged origin for every privileged IPC call. Explicitly deny unexpected host-window navigation and window creation. Enforce webview preferences and allowed initial URL in a main-process `will-attach-webview` handler. Set `sandbox: true` explicitly and review Electron fuses for the packaged application.

### SEC-003 — Outbound proxy can follow an allowed URL to a disallowed private destination

**Severity:** Medium  
**Confidence:** High

**Affected components:** `app/sysserver.js:147-223`; served apps with proxy manifests; `community-apps/news-spotlight/app.json:8-20`.

**Repository evidence:** `proxyAllowed()` validates only the initial parsed target. `proxyFetch()` follows up to three redirects by recursively fetching `next` without calling `proxyAllowed()` or `privateHost()` again (`app/sysserver.js:202-209`). The textual private-host filter omits link-local ranges such as `169.254.0.0/16`, IPv6 private/link-local ranges, and resolved DNS addresses. The News Spotlight app permits user-configured arbitrary public HTTP(S) feed URLs.

**Attack scenario:** An attacker controls or compromises an allowed RSS/feed endpoint and returns a redirect to a loopback, LAN, link-local, Home Assistant, router, or other local administration endpoint. The main process follows it and returns up to 5 MiB of the response to the app. A hostname that resolves/rebinds to a private address can bypass textual hostname checks without a redirect.

**Prerequisites:** A served app with a broad proxy rule must be installed/active, and an attacker must influence an allowed URL or its DNS/redirect response. Requests are GET-only and no application credentials are automatically attached.

**Impact:** Read-oriented SSRF into local services, internal network discovery, possible access to unauthenticated administrative data, and resource abuse. Desktop rather than cloud deployment lowers the likelihood of cloud-metadata impact but does not remove LAN/link-local risk.

**Existing mitigations:** HTTP(S) only, explicit manifest allow rules, GET only, initial private IPv4/localhost checks, timeout, three-redirect cap, 5 MiB response cap, and same-origin caller gate.

**Authoritative references:** [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html); ASVS v5.0.0 V1.3.6, V13.2.4, V13.2.5, and V15.3.2.

**OWASP mapping:** OWASP Top 10 A01:2025 (which includes SSRF); OWASP API7:2023 Server Side Request Forgery.

**ISO/IEC relevance:** Network security, allowlisting, secure system architecture, and least functionality.

**Recommended remediation:** Validate every redirect target with the originating app's exact allow policy before following. Resolve all A/AAAA records, reject loopback/private/link-local/reserved/multicast destinations for every resolved address, connect to a vetted address while preserving correct TLS SNI/Host semantics, and repeat after each redirect. Reject HTTPS-to-HTTP downgrade unless explicitly required. Prefer exact scheme/host/port/path allowlists over manifest-supplied regexes. Add redirect and DNS-rebinding tests using local fakes.

### SEC-004 — Release signing is fail-open and existing artifacts are unsigned

**Severity:** Medium  
**Confidence:** High

**Affected components:** `sign.js:52-73`; `afterpack.js`; `package.json:59-75`; release process.

**Repository evidence:** If SignTool, the Trusted Signing dlib, or metadata is missing, `sign.js` logs that the file is being left unsigned and returns success (`sign.js:54-58`). `build-smtc.js` also treats missing toolchains as non-fatal. Authenticode inspection found `NotSigned` for the existing 0.3.8-beta.1 portable executable, setup executable, unpacked app executable, and both bundled helper executables. The artifact is older than current source and was not assumed to be a published release.

**Attack scenario:** A release is produced on a workstation with incomplete signing setup. The build succeeds and an unsigned installer/portable package is distributed. Recipients cannot authenticate its publisher or distinguish an official artifact from a modified replacement using Authenticode.

**Prerequisites:** Missing or broken signing setup plus failure to detect the warning before distribution.

**Impact:** Reduced release integrity and provenance, easier substitution/social engineering, and loss of a key Windows trust signal. This does not itself prove that an official distribution channel has served a tampered artifact.

**Existing mitigations:** When provisioned, the hook uses SHA-256, RFC 3161-style timestamping, Azure Trusted Signing, retries, and after-pack helper coverage. Signing assets are excluded from packages.

**Authoritative references:** [OWASP Top 10 A03:2025 Software Supply Chain Failures](https://owasp.org/Top10/2025/A03_2025-Software_Supply_Chain_Failures/); [A08:2025 Software or Data Integrity Failures](https://owasp.org/Top10/2025/A08_2025-Software_or_Data_Integrity_Failures/).

**OWASP mapping:** ASVS v5.0.0 V15.1.2 and V15.2.4; OWASP Top 10 A03:2025 and A08:2025.

**ISO/IEC relevance:** Secure development lifecycle, supply-chain assurance, change management, and integrity/authenticity of released software.

**Recommended remediation:** Make release builds fail if every expected executable lacks a valid, timestamped signature from the intended publisher. Separate permissive development packaging from an explicit release command/profile. Add a post-build gate that verifies the installer, portable app, unpacked app executable, uninstaller/elevate binaries where present, and all bundled helpers. Record hashes, immutable provenance, and an SBOM alongside promoted artifacts.

### SEC-005 — Broad packaging can include ignored development secrets and unrelated files

**Severity:** Medium  
**Confidence:** High for configuration, Medium for exposure

**Affected components:** `package.json:46-56`; `.gitignore`; release workstations.

**Repository evidence:** Packaging begins with `"**/*"` and excludes selected paths, but not `.env`, `.env.*`, `.ua/**`, `.agents/**`, `AGENTS.md`, community source ZIPs/logs, or common key/certificate extensions. The installed electron-builder matcher treats dotfiles as matchable and its built-in excluded-name list does not include `.env`. The existing ASAR includes `.agents`, `AGENTS.md`, the JARVIS credential-shaped JSON, and stdout/stderr files. No root `.env` or runtime `app/config.json` was present during this audit, and the current credential-shaped JSON/ZIP values were empty or placeholder-like.

**Attack scenario:** A release is built on a developer machine with a populated ignored `.env`, diagnostic log, generated analysis containing sensitive paths/content, or another local credential file. The broad matcher copies it into extractable ASAR/package resources.

**Prerequisites:** A sensitive local file must exist under the project root when the release is built and not match an explicit or electron-builder built-in exclusion.

**Impact:** Conditional disclosure of API keys, service credentials, internal source analysis, or developer information to every artifact recipient.

**Existing mitigations:** `app/config.json`, `.signing/**`, docs, tools, native source, and several build files are explicitly excluded. No suspect real secret was found in the current included credential-shaped files.

**Authoritative references:** ASVS v5.0.0 V13.3.1 and V15.2.3; [OWASP Top 10 A03:2025](https://owasp.org/Top10/2025/A03_2025-Software_Supply_Chain_Failures/).

**OWASP mapping:** OWASP Top 10 A02:2025 Security Misconfiguration and A03:2025 Software Supply Chain Failures.

**ISO/IEC relevance:** Configuration management, data leakage prevention, secure development environment, and release control.

**Recommended remediation:** Replace the broad include with an allowlist of runtime files and production dependencies. Explicitly exclude `.env`, `.env.*` except a deliberately named non-secret example, key/certificate/credential extensions, logs, `.ua/**`, `.agents/**`, community release sources not used at runtime, and local metadata. Add a build gate that lists/extracts ASAR in a clean environment and fails on forbidden paths or high-confidence secret patterns.

### SEC-006 — Drop-in ZIP import has no expansion quotas

**Severity:** Low  
**Confidence:** High

**Affected components:** `app/main.js:326-401`; drop-in manager.

**Repository evidence:** `importDropInApp()` sends a user-selected archive directly to PowerShell `Expand-Archive` and only validates the extracted manifest and content afterward (`app/main.js:371-390`). No compressed-size, total expanded-size, entry-count, per-entry-size, nesting, free-space, or time/resource policy is enforced by the application.

**Attack scenario:** A downloaded app archive is a ZIP bomb or contains an extreme entry count. Import consumes excessive disk, CPU, or time under the user's profile before validation and cleanup can complete.

**Prerequisites:** The user must select/import the malicious archive. No automatic remote upload path exists.

**Impact:** Local denial of service, disk exhaustion, and potentially incomplete cleanup after process or system failure.

**Existing mitigations:** Explicit user action, 60-second PowerShell process timeout, a dedicated temporary directory, final cleanup attempt, strict app ID/entry validation, and host-code confirmation after extraction.

**Authoritative references:** ASVS v5.0.0 V5.2.1, V5.2.3, V5.2.4, and V5.2.5.

**OWASP mapping:** OWASP Top 10 A06:2025 Insecure Design and A10:2025 Mishandling of Exceptional Conditions (risk communication only).

**ISO/IEC relevance:** Availability, capacity management, secure file handling, and application security controls.

**Recommended remediation:** Inspect the central directory before extraction; cap archive size, entries, per-entry size, total uncompressed size, compression ratio, path depth, and nested archives; reject links/reparse metadata; verify available disk space; extract entry-by-entry under a contained root; and abort/cleanly remove partial output on any limit violation.

### SEC-007 — Secret persistence deliberately falls back to plaintext and retains extra in-memory copies

**Severity:** Low  
**Confidence:** High

**Affected components:** `app/secretStore.js:30-60`; `app/dpapi.js:48-66`; `app/main.js:1514-1519`.

**Repository evidence:** If DPAPI protection fails or `safeStorage` is unavailable, secret values pass through unchanged and are persisted in plaintext. Startup reports this only to the console. DPAPI memoization keys plaintext secrets and retains decrypted plaintext values for process lifetime; refresh rotation/disconnect does not clear those maps.

**Attack scenario:** Secure storage is unavailable or fails and the user continues configuring OAuth, HA, dashboard, or app secrets. A disk copy or other local account can read them. Separately, a later process dump can recover superseded/deleted secret values retained by caches.

**Prerequisites:** Secure-storage failure for disk exposure; local memory-read capability for cache exposure.

**Impact:** Weakened at-rest protection and longer-than-needed lifetime of high-value credentials. Same-user malware may already have broad capability, which limits severity.

**Existing mitigations:** Current-user DPAPI on Windows, `safeStorage` elsewhere, per-field transformation, no command-line secret transport, encrypted-form markers, and migration from plaintext/legacy values when storage becomes available.

**Authoritative references:** RFC 9700 section 4.14; ASVS v5.0.0 V11.2.1, V13.3.1, V13.3.2, and V14.2.4.

**OWASP mapping:** OWASP Top 10 A04:2025 Cryptographic Failures.

**ISO/IEC relevance:** Cryptography, secret management, information lifecycle, and secure disposal.

**Recommended remediation:** Refuse durable secret/OAuth configuration when secure persistence is unavailable, or require an explicit prominent user decision with clear consequences and an in-memory-only option. Avoid plaintext-as-key memoization for refresh tokens, bound caches, and clear entries on rotation, disconnect, and shutdown.

### SEC-008 — Locked toolchain contains current advisories, but audited runtime reachability is limited

**Severity:** Informational  
**Confidence:** High

**Affected components:** `package-lock.json`, installed `node_modules`, Electron/build toolchain.

**Repository evidence:** Full `npm audit` reported 6 vulnerable package entries: 1 critical (`tar`), 4 high (`brace-expansion`, `fast-uri`, `js-yaml`, `undici`), and 1 moderate (`electron`). `npm audit --omit=dev` reported zero production-package advisories, but Electron is declared as a dev dependency while its binary is the shipped runtime. Installed Electron 42.4.1 is affected by CVE-2026-70606 and fixed in 42.5.1. The advisory applies only to apps using `ProtocolResponse.url` without an explicit session while relying on session isolation; no `protocol` or `ProtocolResponse` use was found. The other reported vulnerable packages are in install/build tooling, and no repository path passing remote attacker-controlled data into their affected operations was established. `npm ls --depth=0` also reported local `win-ca` as missing, indicating this working installation is incomplete even though the lockfile records dependencies.

**Attack scenario:** A future code/build change begins using an affected API with untrusted input, or vulnerable build tooling processes malicious project/archive data in a compromised development pipeline.

**Prerequisites:** Use of the affected operation and attacker control over its input; not currently established for the listed advisories.

**Impact:** Advisory-dependent. No current exploitable runtime finding was confirmed from these dependency reports.

**Existing mitigations:** Lockfile, narrow direct dependency set, current supported Electron major, production-only audit clean, and no vulnerable protocol API usage.

**Authoritative references:** [Electron CVE-2026-70606 advisory](https://github.com/electron/electron/security/advisories/GHSA-r4w5-6pfg-jxp5); [brace-expansion maintainer advisory](https://github.com/juliangruber/brace-expansion/security/advisories/GHSA-rgw5-rvv9-x895); npm registry advisory output captured during this audit.

**OWASP mapping:** OWASP Top 10 A03:2025; ASVS v5.0.0 V15.1.1, V15.1.2, and V15.2.1.

**ISO/IEC relevance:** Vulnerability management, supplier relationships, software acquisition, and secure development lifecycle.

**Recommended remediation:** Regenerate the lockfile with patched compatible versions, at minimum Electron 42.5.1 or later supported 42.x, and rerun rebuild/tests/packaging. Review toolchain advisory reachability before prioritising purely by npm severity. Add automated production and full-toolchain audits with risk-based triage and an SBOM.

### SEC-009 — Security-critical boundaries lack focused regression tests and an enforced release pipeline

**Severity:** Informational  
**Confidence:** High

**Affected components:** `test/`, loopback service, OAuth, secret store, proxy, import, IPC, packaging/signing process.

**Repository evidence:** The current unit suite is concentrated on reserved-display behavior. No focused tests verify loopback app authorization, token redaction, forged-header rejection, proxy redirect/DNS handling, archive quotas, renderer DTO redaction, navigation/window policy, secure-storage failure behavior, package contents, or signature enforcement. No CI workflow was present.

**Attack scenario:** A subtle boundary regresses or a release is built in an insecure environment without a failing test/gate, allowing credential exposure or unsigned/secret-bearing artifacts to ship unnoticed.

**Prerequisites:** A future change or release-process error.

**Impact:** Increased likelihood and detection time for security regressions; this is an assurance gap, not a standalone exploit.

**Existing mitigations:** Clear repository guidance, a lockfile, existing tests for one native boundary, explicit security comments, graceful-failure patterns, and manual signing/package hooks.

**Authoritative references:** ASVS v5.0.0 V15.1.1, V15.1.2, V15.2.1, and relevant control-specific requirements; [OWASP Top 10 A03:2025](https://owasp.org/Top10/2025/A03_2025-Software_Supply_Chain_Failures/).

**OWASP mapping:** OWASP Top 10 A03:2025 and A09:2025 Security Logging and Alerting Failures only at the assurance/process level.

**ISO/IEC relevance:** Secure development lifecycle, testing, change control, vulnerability management, and release management.

**Recommended remediation:** Add injected-fake `node:test` coverage for security boundaries and negative cases. Establish a clean, reproducible release job that runs tests/audits, generates an SBOM, inspects ASAR forbidden paths/secrets, signs all executables, verifies signatures, records hashes/provenance, and refuses promotion on any failed gate.

## Secrets and Credential Exposure

| Surface | Assessment |
| --- | --- |
| Current source | No suspected real credential found. The credential-shaped JARVIS JSON has no populated key; tenant/client identifiers are not treated as secrets. |
| Tracked ZIPs | Redacted in-memory inspection of the credential-shaped JARVIS ZIP entry found no suspected non-placeholder long value. No archive content was executed. |
| Local Git history | A filename-only high-confidence scan across 202 commits for common provider tokens/private keys found no hits. Credential-related path history was reviewed without printing values. This is not a forensic proof for remotes or unreachable objects. |
| Runtime config | `app/config.json` is ignored and excluded from packaging; it was absent. User-data config is outside the repository and was not accessed. |
| At-rest storage | Dashboard, HA, app, and OAuth secret fields are encrypted with current-user DPAPI on Windows or `safeStorage` elsewhere when available. Explicit plaintext fallback remains (SEC-007). |
| Renderer/IPC | Editor receives complete decrypted config; token DTOs contain refresh tokens (SEC-001/SEC-002). |
| URLs | App schema secrets are excluded from app page URLs. OAuth code/state appear in the loopback callback URL as defined by the flow; tokens are not placed in app URLs. |
| Logs | No token/body logging path was found. Action/counter and provider error messages may expose user data or service detail, but no confirmed credential logging was traced. |
| Build/package | Runtime config and `.signing` are excluded; ignored `.env` and unrelated local files are not comprehensively excluded (SEC-005). |
| Existing artifact | Filename listing showed development metadata and credential-shaped empty/currently benign files. The older ASAR was not fully content-scanned. |
| CI/CD | No repository CI or external CI secret store was available to inspect. |

**Suspected real secrets discovered:** No.

## Authentication Assessment

open-quake does not implement local user accounts, passwords, sessions, or roles. It relies on the logged-in operating-system user, explicit editor/tray interaction, third-party dashboard sessions, Home Assistant bearer tokens, and OAuth grants. The loopback service's `sameOrigin()` check is a browser request-origin control, not authentication of a local native process or authorization of one served app; treating it as such causes SEC-001.

Dashboard HTTP Basic and custom-header credentials are host-scoped before injection: `hostMatches()` compares parsed URL hosts, and headers are applied only to the active configured dashboard host. This is a positive control. Preemptive Basic transmission still means credentials are sent on the first request to the configured host; the editor should strongly prefer HTTPS and make any HTTP choice explicit.

## OAuth / OpenID Connect Assessment

Positive controls:

- authorization code flow in the external system browser;
- 192-bit random state and 384-bit random verifier from Node cryptography;
- PKCE S256 and one verifier per transaction;
- state lookup and deletion before token exchange;
- hardcoded HTTPS authorization/token endpoints;
- expiry skew, refresh before expiry, and preservation of provider-issued refresh rotation;
- tokens persisted through the central secret transform;
- no implicit or resource-owner password grant;
- Google ID tokens are not used for an authentication decision, so missing OIDC validation is not currently an auth bypass.

Gaps:

- refresh tokens cross into page/renderer JavaScript (SEC-001);
- the callback uses fixed `localhost:5173`, one shared path, and no pending-state TTL/cap;
- lower-level APIs accept placeholder providers even though only Microsoft is enabled in the editor;
- optional client secrets in a distributed desktop app must not be treated as confidential;
- Microsoft/GitHub remote revocation is not implemented; local deletion cannot revoke copied tokens;
- provider-side redirect registration, tenant restrictions, audience, rotation/replay detection, and revocation were unable to be verified.

## Authorization Assessment

IPC authorization is consistently attempted using the owning BrowserWindow, and app config resolution normally checks that the requested served app is the active app. Static app file access is path-contained. Drop-in deletion is restricted to the managed app-data root. These are positive controls.

The principal failure is confusing browser same-origin evidence with caller authorization for global token and host-action routes. Apps sharing one origin are distinct trust principals, while native local processes can forge HTTP headers. Global OAuth tokens therefore require explicit consumer authorization independent of origin (SEC-001). The local route set also exposes media, launch, meeting, and OAuth-connect operations to every same-origin app; their privilege should be reviewed and scoped per app even when they do not expose credentials.

## Input and Injection Assessment

No SQL/database layer, LDAP, template engine, or generic deserializer is present. Process execution normally uses argument arrays for fixed helpers and pickers. `cmd` and AutoHotkey actions intentionally execute user-authored code; they are product features and should remain reachable only from trusted configuration/panel interaction. PowerShell ZIP commands use single-quote doubling plus `-LiteralPath`, which is materially safer than direct interpolation into an unquoted command.

DOM review found extensive `innerHTML` construction in the editor, but dynamic values generally pass through the local `esc()` helper and local CSP disallows inline/external non-self script. No confirmed DOM-XSS source-to-sink path was established. The large capability impact of any future renderer injection is addressed in SEC-002.

File/app IDs and entries use allowlists and resolved-root containment. Static serving rejects encoded traversal and absolute/scheme paths. Drop-in server module resolution is contained under the app root. Archive resource quotas are missing (SEC-006).

## Web / API Security Assessment

Positive controls:

- GET-only local HTTP service and unsupported methods return 405;
- exact loopback Host validation resists browser DNS rebinding;
- side-effect/live/secret routes fail closed without same-origin Fetch Metadata or Origin;
- no permissive CORS response is emitted;
- `Cache-Control: no-store` is applied universally;
- CSP blocks non-self scripts, objects, base changes, forms, and framing;
- static app paths are contained;
- proxy response size and time are bounded.

Gaps:

- global routes lack app/process authorization (SEC-001);
- sensitive and side-effecting operations use GET; Fetch Metadata checks only `site`, not method semantics, `mode`, or `dest`;
- all served apps share one origin, so browser same-origin policy cannot isolate app principals;
- proxy redirects/DNS break the intended SSRF allowlist (SEC-003);
- CSP allows connections and images to arbitrary HTTP(S), making exfiltration straightforward after same-origin token access;
- local responses omit `X-Content-Type-Options: nosniff` and a restrictive `Referrer-Policy`. No direct exploit was established from those header omissions.

## Application Trust Boundaries

The main/preload/renderer split is structurally correct. Both host BrowserWindows disable Node integration and enable context isolation. Electron 42 defaults sandboxing on, and no `sandbox: false` was found, but explicit `sandbox: true` would make the invariant auditable. Preloads expose named operations rather than raw `ipcRenderer`.

The dashboard webview is riskier than a normal browser because it lives inside a privileged desktop application, but it has no Node/preload API and its session permissions are denied except configured audio origins. The app does not centrally validate `will-attach-webview`, host-window navigation, or new windows as official Electron guidance recommends. IPC validates the `webContents` object but not the frame URL. These gaps become consequential because panel/editor preload capabilities include command execution, file reads, complete config, OAuth, and device operations (SEC-002).

## Data Protection and Cryptography

The application uses established platform cryptography rather than a custom cipher: Windows current-user DPAPI per value and Electron `safeStorage` elsewhere. Secrets cross the PowerShell DPAPI helper over stdin, not argv. OAuth state and verifier use `crypto.randomBytes`; SHA-256 is correctly used for PKCE S256. No hardcoded encryption key was found.

DPAPI provides protection against offline copying by another OS user, not against malware running as the same user or main-process compromise. That makes strict main/renderer/app boundaries essential. Plaintext fallback and indefinite memoization reduce lifecycle assurance (SEC-007). Sensitive snapshots and HA data use no-store responses, but OAuth token minimization fails because the refresh token is returned unnecessarily (SEC-001).

## Dependency and Supply-Chain Assessment

`package-lock.json` pins resolution and direct runtime dependencies are few. `npm audit --omit=dev` was clean. The full graph reported six affected package entries, primarily in build/install tooling. Electron 42.4.1 has one current moderate advisory, but its affected protocol API is unused; this is informational rather than a confirmed vulnerability (SEC-008). The local installation also lacks `win-ca`, so test/build results on this workstation do not represent a clean install.

No SBOM, automated advisory gate, dependency-update policy, or CI workflow was found. The repository's documented Node ceiling and Electron rebuild process reduce accidental ABI/toolchain drift, but current patch releases still need timely uptake.

## Build, CI/CD and Packaging Assessment

Positive controls include explicit exclusion of runtime config and signing assets, SHA-256 Trusted Signing when provisioned, timestamping, and a dedicated after-pack hook for helpers. Signing credentials are obtained from the developer's local Azure session rather than stored in source.

Release integrity is not enforced: signing can silently degrade to unsigned output and inspected artifacts are unsigned (SEC-004). The file matcher is broad enough to include ignored local secrets and development metadata (SEC-005). There is no CI or clean release job, no SBOM/provenance, and no artifact inspection gate (SEC-009). No updater is configured in current source, so automatic-update signature/downgrade behavior is not applicable.

## Network and Deployment Assessment

The application is a desktop process, not a cloud/container/LAN service. No Docker, Kubernetes, hosted database, public listener, or deployment manifest was found. The local service binds only `127.0.0.1` on an OS-assigned port. Home Assistant and dashboard URLs are user-configured and may intentionally target LAN services. HTTPS/WSS is used when the configured HA URL is HTTPS, but HTTP/WS remains possible for local HA installations.

The key network risks are local HTTP authorization (SEC-001) and outbound-proxy SSRF (SEC-003). TLS verification can be disabled by a News Spotlight option; because this is an explicit user choice it is not a standalone finding, but the UI should warn that it permits network interception and should default to enabled, as it currently does.

## OWASP ASVS Assessment

This is a focused technical mapping, not formal ASVS verification or certification.

| Requirement | Version | Status | Repository Evidence | Finding |
| ----------- | ------- | ------ | ------------------- | ------- |
| V1.2.2 | 5.0.0 | Satisfied | External URL opener permits only parsed HTTP(S); app path components are encoded. | — |
| V1.2.5 | 5.0.0 | Partially satisfied | Fixed helper operations use argument arrays; arbitrary shell/AutoHotkey is an intentional trusted-user feature whose authorization boundary must hold. | SEC-002 |
| V1.3.6 | 5.0.0 | Partially satisfied | Proxy has initial allow rules, timeout, and cap, but redirects/DNS can reach private destinations. | SEC-003 |
| V2.2.2 | 5.0.0 | Partially satisfied | Many validations are in main/server; token caller authorization is not. | SEC-001 |
| V3.4.3 | 5.0.0 | Partially satisfied | CSP contains `object-src 'none'`, `base-uri 'none'`, and self-only script; network/resource directives are broad. | SEC-001 |
| V3.4.4 | 5.0.0 | Not satisfied | Local responses do not set `X-Content-Type-Options: nosniff`. | — |
| V3.4.5 | 5.0.0 | Not satisfied | No explicit restrictive Referrer Policy was found for served apps. | — |
| V3.5.1 | 5.0.0 | Satisfied for cross-site browsers | Host plus Fetch Metadata/Origin checks fail closed for ordinary hostile browser origins. | — |
| V3.5.3 | 5.0.0 | Partially satisfied | Sensitive/side-effect routes use GET and validate only same-site metadata, not an authenticated caller. | SEC-001 |
| V3.5.4 | 5.0.0 | Not satisfied | Distinct third-party served apps share one loopback origin. | SEC-001 |
| V5.2.1 | 5.0.0 | Not satisfied | Import applies no archive-size policy before expansion. | SEC-006 |
| V5.2.3 | 5.0.0 | Not satisfied | No expanded-size or entry-count limit. | SEC-006 |
| V5.3.2 | 5.0.0 | Satisfied | App IDs/entries and static/server paths are validated and resolved under roots. | — |
| V8.2.1 | 5.0.0 | Not satisfied | Global token function is reachable without explicit app/process permission. | SEC-001 |
| V8.3.1 | 5.0.0 | Not satisfied | Browser-controlled/forgeable request metadata substitutes for trusted-service authorization. | SEC-001 |
| V10.1.1 | 5.0.0 | Not satisfied | Access and refresh tokens are returned to JavaScript components that do not strictly need refresh tokens. | SEC-001, SEC-002 |
| V10.1.2 | 5.0.0 | Satisfied | Strong transaction-specific state/verifier and state binding are present. | — |
| V10.2.1 | 5.0.0 | Satisfied | Authorization code flow uses both state and PKCE S256. | — |
| V11.2.1 | 5.0.0 | Satisfied when available | Platform DPAPI/safeStorage implementations are used. | SEC-007 |
| V11.5.1 | 5.0.0 | Satisfied | State/verifier use high-entropy CSPRNG output. | — |
| V13.2.4 | 5.0.0 | Partially satisfied | Outbound proxy uses app allow rules but does not validate resolved/redirect destinations fully. | SEC-003 |
| V13.3.1 | 5.0.0 | Partially satisfied | Secrets excluded from source and normally encrypted, but plaintext fallback and broad package inclusion remain. | SEC-005, SEC-007 |
| V14.2.1 | 5.0.0 | Satisfied for tokens | Tokens are sent in form bodies/Authorization headers, not app URLs. | — |
| V14.2.6 | 5.0.0 | Not satisfied | OAuth token DTO returns an unnecessary refresh token; editor gets all secrets. | SEC-001, SEC-002 |
| V14.3.2 | 5.0.0 | Satisfied | Loopback responses use `Cache-Control: no-store`. | — |
| V15.1.2 | 5.0.0 | Not satisfied | No maintained SBOM was found. | SEC-009 |
| V15.2.1 | 5.0.0 | Partially satisfied | Supported major is used, but current locked advisories exist and no remediation SLA is documented. | SEC-008 |
| V15.2.3 | 5.0.0 | Partially satisfied | Artifact includes development/unneeded files due broad matcher. | SEC-005 |
| V15.2.5 | 5.0.0 | Partially satisfied | Some sandbox/isolation controls exist; high-impact host capabilities remain broad. | SEC-002 |

## OWASP Risk Mapping

| Finding | OWASP Top 10:2025 | OWASP API Security Top 10:2023 |
| --- | --- | --- |
| SEC-001 | A01 Broken Access Control; A06 Insecure Design | API5 Broken Function Level Authorization; API8 Security Misconfiguration |
| SEC-002 | A01 Broken Access Control; A06 Insecure Design | Not forced |
| SEC-003 | A01 Broken Access Control (includes SSRF) | API7 Server Side Request Forgery |
| SEC-004 | A03 Software Supply Chain Failures; A08 Software or Data Integrity Failures | Not applicable |
| SEC-005 | A02 Security Misconfiguration; A03 Software Supply Chain Failures | Not applicable |
| SEC-006 | A06 Insecure Design; A10 Mishandling of Exceptional Conditions | API4 Unrestricted Resource Consumption (local/import context) |
| SEC-007 | A04 Cryptographic Failures | Not applicable |
| SEC-008 | A03 Software Supply Chain Failures | Not applicable |
| SEC-009 | A03 Software Supply Chain Failures; A09 Security Logging and Alerting Failures (assurance context) | Not applicable |

## ISO/IEC Technical Alignment

This section represents technical alignment observations only. It does not constitute ISO/IEC certification or proof of organisational compliance.

| Standard / Control Area | Technical Alignment | Repository Evidence | Related Findings | Limitations |
| ----------------------- | ------------------- | ------------------- | ---------------- | ----------- |
| ISO/IEC 27001:2022 — information-security risk management | Partial | Security-sensitive design comments and repository guidance exist; no organisational risk register, treatment plan, ownership, or ISMS evidence was in scope. | All | Source alone cannot establish ISMS conformity. |
| ISO/IEC 27002:2022 — access control and least privilege | Partial/gap | Narrow IPC channels and root containment are positive; global tokens and full renderer config exceed least privilege. | SEC-001, SEC-002 | No OS ACL, user-role, or operational policy review. |
| ISO/IEC 27002:2022 — identity and authentication information | Partial/gap | DPAPI/safeStorage and PKCE are positive; refresh token release and plaintext fallback weaken protection. | SEC-001, SEC-007 | Provider controls and organisational credential lifecycle unavailable. |
| ISO/IEC 27002:2022 — cryptography | Technically aligned with gaps | Established platform cryptography and CSPRNG are used; failure behavior and memory lifecycle need improvement. | SEC-007 | No formal crypto inventory/key policy evidence. |
| ISO/IEC 27002:2022 — secure development and testing | Partial | Architecture guidance and some tests exist; critical boundaries lack automated negative tests. | SEC-006, SEC-009 | Developer process/training/review evidence not assessed. |
| ISO/IEC 27002:2022 — configuration/change management | Gap | Broad package selection, missing CI, optional signing, and no artifact gate. | SEC-004, SEC-005, SEC-009 | External release procedures not available. |
| ISO/IEC 27002:2022 — supplier/software supply chain | Partial/gap | Lockfile and current audit were available; SBOM, provenance, automated triage, and signed promotion are absent. | SEC-004, SEC-008, SEC-009 | Repository-host protections and supplier contracts unavailable. |
| ISO/IEC 27002:2022 — network security | Partial | Loopback bind and Host checks are strong; SSRF and local caller authentication remain. | SEC-001, SEC-003 | Firewall/endpoint protection not inspected. |
| ISO/IEC 27034-1:2011 — application-security lifecycle | Partial | Threat-boundary knowledge exists in code/docs, but verification requirements are not consistently automated. | All | Organisational application-security process unavailable. |
| ISO/IEC 27034-5:2017 — application security controls | Partial | CSP, IPC checks, secret transforms, path containment, import consent, and proxy rules are identifiable controls; several are incomplete at trust boundaries. | SEC-001 to SEC-007 | No formal ASC catalogue or lifecycle evidence was provided. |

## Positive Security Findings

- Main process owns filesystem, process, OS, hardware, credentials, and network integration capabilities.
- Both host BrowserWindows disable Node integration and enable context isolation.
- Preloads expose named operations rather than raw `ipcRenderer` or Node modules.
- IPC handlers consistently attempt owning-window sender validation.
- Remote dashboards run in a separate Node-disabled persistent webview.
- Dashboard permissions are denied by default and audio permission is origin-scoped.
- External URL opening parses URLs and permits only HTTP(S).
- Host header and Fetch Metadata/Origin checks materially resist hostile web pages and DNS rebinding.
- Local service binds only to `127.0.0.1` on an OS-assigned port.
- Static drop-in paths and server modules are resolved beneath trusted roots.
- App IDs and entries use positive validation.
- Proxy uses explicit app manifest rules, GET only, timeout, redirect count, and response-size cap.
- Imported apps containing host server/native/script code require explicit confirmation.
- OAuth uses external-browser authorization code flow, strong state, PKCE S256, one-time state deletion, HTTPS endpoints, expiry skew, and refresh replacement.
- Dashboard/app/OAuth/HA secrets are centrally discovered and encrypted at the persistence boundary when secure storage is available.
- Windows DPAPI secret values cross PowerShell through stdin, not command-line arguments.
- App schema secrets and server-only options are excluded from page URLs.
- Dashboard auth headers are restricted to the configured host.
- Runtime config and signing assets are ignored and explicitly excluded from packages.
- CSP uses self-only scripts and blocks objects, base changes, forms, and framing.
- Loopback responses use `Cache-Control: no-store`.
- No suspected real credential was found in current source, tracked ZIP credential entries, or the high-confidence local Git-history scan.

## Recommended Remediation

SEC-001 immediate items 1 and 2 were completed and verified on 2026-08-11. The numbered list is retained as the original remediation plan.

### Immediate

1. Keep refresh tokens in main only; replace the global token route with app/process-authenticated, least-privilege access-token or main-process Graph operations.
2. Scope every privileged loopback route to a host-derived app identity and add a non-forgeable per-process/session authorization mechanism; do not treat `Sec-Fetch-Site` as native-client authentication.
3. Revalidate proxy scheme/host/port/path and resolved IP after every redirect; block all private, loopback, link-local, and reserved destinations unless an exact intentional private target is separately configured.

### Short Term

1. Make release signing and post-build signature verification fail closed; do not promote unsigned artifacts.
2. Replace broad package inclusion with a runtime allowlist and inspect final ASAR/resources for forbidden paths and secrets.
3. Redact renderer config DTOs, remove unused token getters, validate sender frame URLs, and centrally deny unexpected navigation/window/webview attachment.
4. Add archive count/expanded-size/compression-ratio limits before and during extraction.
5. Update the locked Electron patch release and triage/refresh build-tool dependencies.

### Defence in Depth

1. Explicitly set renderer sandboxing and review Electron fuses.
2. Fail or offer memory-only mode when secure secret persistence is unavailable; clear plaintext caches on rotation/disconnect.
3. Add focused negative tests for OAuth release, local HTTP authorization, proxy SSRF, ZIP limits, IPC origin, and package/signature policies.
4. Establish a clean release pipeline with dependency audit, SBOM, artifact secret/path scan, Authenticode verification, hashes, provenance, and immutable promotion.
5. Add `X-Content-Type-Options: nosniff` and a restrictive `Referrer-Policy`; consider per-app CSP and origin isolation.

## Remediation History

| Date | Finding | Previous status | New status | Implementation and verification |
| --- | --- | --- | --- | --- |
| 2026-08-11 | SEC-001 | Open | Resolved | Removed global OAuth token/connect HTTP routes and token IPC/preload APIs; redacted OAuth credentials from the editor DTO; moved fixed-scope Office Graph reads into the main process; added rotating, expiring, memory-only Office authorization. `node --test test/oauthSecurity.test.js` passed 9 focused cases; `npm test` passed all 14 tests; pre-fix fake-token reproduction returned credentials from both attack paths, while the post-fix reproduction returned 404/403 with zero privileged calls and no credential fields. Electron startup remained healthy during a bounded smoke check; no live provider or hardware interaction was used. |

## Uncertainties and Further Verification

- Dynamically test the loopback service with fake tokens/apps after remediation, including forged native headers, unrelated served apps, iframes, Fetch Metadata combinations, and port discovery assumptions.
- Test proxy redirect chains, IPv4/IPv6 encodings, DNS rebinding, multiple A/AAAA answers, link-local/ULA ranges, TLS SNI, and downgrade behavior with local fake servers only.
- Exercise ZIP central-directory inspection and extraction limits with safe synthetic archives in a disposable test directory.
- Run `npm ci`, native rebuild, `npm test`, and current Electron flows on a clean Node 24/Windows builder; the present install is missing `win-ca`.
- Build a current release in an isolated environment, inspect every ASAR/unpacked path, secret-scan content, and verify all signatures/timestamps without publishing it.
- Dynamically verify Electron host-window navigation, webview new-window behavior, permissions, renderer sandbox status, and fuses.
- Verify OAuth provider registrations, redirect URI constraints, public-client classification, tenant policy, granted scopes, token audience, refresh rotation/replay detection, lifetime, and revocation through provider administration—not with discovered credentials.
- Verify filesystem ACLs on user-data configuration and drop-in directories under standard multi-user Windows installations.
- Review remote repository protections, CI/CD settings/secrets, official release assets, distribution channels, incident response, vulnerability SLA, and organisational ISO/IEC evidence separately.
- Reassess community app server modules and compiled executables as independently versioned/distributed code; this audit did not reverse engineer binaries.

No implementation fixes were applied as part of this audit.
