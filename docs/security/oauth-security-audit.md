# OAuth Security Audit

**Audit date:** 2026-08-11  
**Repository:** open-quake  
**Audit type:** source, local Git history, Electron boundary, and packaging review; no live authentication was performed

## Executive Summary

The OAuth authorization-code implementation has a sound cryptographic core: it uses the system browser, transaction-specific high-entropy state and PKCE values, S256 challenges, HTTPS token endpoints, encrypted token persistence, expiry-aware refresh, and sender checks on IPC. The loopback services bind to IPv4 loopback, and the general local HTTP service has strong Host and same-origin checks.

The overall assessment is **needs remediation before OAuth is exposed as a general app platform capability**. The highest-priority issue is that any served page on the shared loopback origin can request the complete OAuth token record, including the refresh token. The same response is also available through both privileged renderer bridges. Served drop-in apps are explicitly third-party code and share that origin. A malicious or compromised served app can therefore obtain a reusable refresh token and all scopes already granted to the client. The only observed consumer, `app/office.js`, needs an access token but never uses the refresh token.

Two additional meaningful weaknesses are present: the editor renderer receives the complete plaintext in-memory configuration, including OAuth tokens and other secrets, and the broad packaging include pattern does not exclude the repository's ignored `.env` development-secret file. No `.env` was present during this audit, and no suspected real credential was discovered in the current tree or the locally inspectable Git diffs.

Finding counts:

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| High | 1 |
| Medium | 2 |
| Low | 3 |
| Informational | 1 |

## Scope

The audit inspected:

- `src/auth/providers.js`, `src/auth/oauth-handler.js`, and `src/auth/token-storage.js`;
- `app/main.js`, both preload bridges, the editor and panel renderers, `app/sysserver.js`, and the Microsoft Office served app;
- `app/secretStore.js` and `app/dpapi.js`;
- default configuration, app schemas, drop-in documentation and implementation, CSP and loopback controls;
- `package.json`, `.gitignore`, signing hooks, tracked community app ZIPs and credential-named files;
- tracked files and locally available Git diffs using a redacted high-confidence secret scan.

The generated `.ua/knowledge-graph.json` was used to locate related components, but every reported conclusion was checked against current source.

Limitations:

- No provider account, app registration, tenant policy, consent screen, token lifetime, refresh-token rotation behavior, or server-side redirect registration was inspected.
- No live authorization, token exchange, refresh, revocation, or credential validity check was performed.
- No release artifact was built or unpacked. Packaging conclusions are based on the authoritative `package.json` file set and current electron-builder documentation.
- The local Git review covered tracked paths, relevant path history, and high-confidence secret patterns in available diffs. It was not a forensic scan of remotes, reflogs, deleted local objects, release assets, or other clones.
- DPAPI and Electron `safeStorage` behavior was reviewed from source but not exercised against a real user-data configuration.

## Security Baseline

| Source | Status and date | Applicability |
| --- | --- | --- |
| [RFC 9700, OAuth 2.0 Security Best Current Practice](https://www.rfc-editor.org/rfc/rfc9700.html) | IETF Best Current Practice, January 2025 | Current baseline for redirect-based flows, PKCE, mix-up defenses, token leakage, and refresh-token protection. |
| [RFC 8252, OAuth 2.0 for Native Apps](https://www.rfc-editor.org/info/rfc8252/) | IETF Best Current Practice, October 2017 | Electron is an end-user-distributed native desktop client. Applies to external-browser authorization, public-client classification, PKCE, and loopback redirects. |
| [RFC 7636, Proof Key for Code Exchange](https://www.rfc-editor.org/info/rfc7636/) | IETF Proposed Standard, September 2015 | Defines the PKCE verifier/challenge controls implemented by the client. |
| [RFC 6749, OAuth 2.0 Authorization Framework](https://www.rfc-editor.org/info/rfc6749/) | IETF Proposed Standard, October 2012; updated in part by later RFCs including RFC 9700 | Core authorization-code, access-token, and refresh-token semantics. Later BCP guidance takes precedence where it tightens this RFC. |
| [RFC 9449, Demonstrating Proof of Possession](https://www.rfc-editor.org/info/rfc9449/) | IETF Proposed Standard, September 2023 | Standard sender-constraining mechanism. Provider support was not verified; absence is not treated as a client defect here. |
| [OpenID Connect Core 1.0, errata set 2](https://openid.net/specs/openid-connect-core-1_0.html) | OpenID Foundation final specification, December 2023 publication of errata set 2 | Google requests `openid`, but the application does not consume an ID token or use it for authentication. OIDC validation is therefore not currently part of an identity decision. |
| [Electron Security Checklist](https://www.electronjs.org/docs/latest/tutorial/security) | Current official Electron guidance, refreshed 2026-08-11 | Applies to renderer sandboxing, preload capability, IPC sender validation, navigation, window creation, permissions, CSP, and remote content. |
| [Microsoft desktop-app configuration](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-configuration) | Current Microsoft identity platform guidance, refreshed 2026-08-11 | The enabled Microsoft desktop integration should be registered as a public client. |
| [Google OAuth for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app) | Current provider guidance, refreshed 2026-08-11 | Confirms PKCE and random loopback IP/port guidance for desktop apps. Google is a framework placeholder in the current editor. |
| [GitHub OAuth authorization](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) | Current provider guidance, refreshed 2026-08-11 | Confirms GitHub PKCE parameters and the OAuth App client-secret requirement. GitHub is a framework placeholder in the current editor. |
| [electron-builder application contents](https://www.electron.build/docs/contents/) | Current official packaging documentation, refreshed 2026-08-11 | Confirms that custom `files: ["**/*", ...]` includes project files except explicit and built-in exclusions; hidden files are not generally excluded. |

## Emerging Guidance

- [draft-ietf-oauth-v2-1-15](https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/) is an active Standards Track Internet-Draft dated March 2026 and expiring 3 September 2026. It consolidates PKCE, strict redirect matching, and removal of insecure legacy grants. It is work in progress, not an established compliance requirement. The current flow already avoids implicit and password grants and uses PKCE.
- [draft-ietf-oauth-browser-based-apps-26](https://datatracker.ietf.org/doc/draft-ietf-oauth-browser-based-apps/26/) is in the RFC Editor queue with intended BCP status but remains an Internet-Draft in the source consulted. Its browser token-isolation analysis is relevant because open-quake deliberately delivers tokens to served JavaScript. It supports, but is not required to establish, the recommendation to keep refresh tokens out of page JavaScript.

## Architecture Observed

The application is a native/public Electron client. The currently enabled provider is Microsoft 365; GitHub and Google metadata exists as disabled framework placeholders in the editor, although the lower-level handler accepts all three provider IDs.

1. The editor stores a user-supplied client ID in the in-memory configuration (`app/main.js:1609-1615`).
2. `OAuthHandler.connect()` starts an IPv4 loopback callback server on port 5173, constructs an authorization-code request, and opens it in the operating-system browser (`src/auth/oauth-handler.js:64-92`, `src/auth/oauth-handler.js:247-278`).
3. Each request gets a 192-bit state value and a 384-bit PKCE verifier; S256 is used (`src/auth/oauth-handler.js:68-81`).
4. The callback validates state, removes it before exchange, and sends the code, redirect URI, and verifier to a hardcoded HTTPS token endpoint (`src/auth/oauth-handler.js:94-130`).
5. Access and refresh tokens are held in the main-process configuration and persisted through `saveConfig()`. OAuth token fields are transformed by `secretStore` and use current-user DPAPI on Windows or Electron `safeStorage` elsewhere (`app/secretStore.js:97-123`, `app/main.js:423-430`, `app/main.js:476-480`).
6. The main process refreshes tokens before expiry and replaces a rotated refresh token when the provider returns one (`src/auth/oauth-handler.js:148-179`, `src/auth/oauth-handler.js:227-235`).
7. Tokens are delivered to renderers through `get-oauth-tokens` and to served pages through `/api/oauth-tokens.json` (`app/main.js:1627-1630`, `app/sysserver.js:340-347`).
8. The Office page uses only `accessToken` to call Microsoft Graph (`app/office.js:18-30`, `app/office.js:88-103`).

## Authentication and Secret Flows

| Value | Origin → processing → storage → transmission → consumer → cleanup |
| --- | --- |
| Client ID | User input in editor → allowlisted IPC patch → plaintext in main config and on disk because it is public → authorization and token request form fields → provider. It is retained until changed. |
| Optional client secret | IPC/config input → plaintext main config → encrypted at disk boundary → token request form body over HTTPS → provider. It can also enter the editor renderer through the full `getConfig` response. No UI currently presents this field. |
| State | `crypto.randomBytes(24)` → base64url → authorization URL and in-memory `pending` map → exact lookup at callback → deleted before token exchange. No timeout cleanup exists. |
| PKCE verifier | `crypto.randomBytes(48)` → in-memory `pending` map; S256 challenge enters authorization URL → verifier enters HTTPS token request body → state deletion drops the pending reference. |
| Authorization code | Provider → loopback callback query → HTTPS token request body → not persisted or explicitly logged; pending state is deleted before exchange. |
| Access token | HTTPS token response → normalized main-process token record → encrypted config on disk, plaintext main memory and DPAPI cache → IPC and loopback JSON → Office JavaScript → Microsoft Graph `Authorization` header. Removed from the active config on disconnect, but cache copies survive to process exit. |
| Refresh token | HTTPS token response → normalized main-process token record → encrypted config on disk, plaintext main memory and DPAPI cache → **unnecessarily included in IPC and loopback JSON** → not used by the Office consumer → token endpoint during refresh. Removed from active config on disconnect; Microsoft remote revocation is not implemented and cache copies survive to process exit. |

## Findings

### OAUTH-001 — Served apps and renderer bridges can retrieve refresh tokens

**Severity:** High

**Affected components:** `src/auth/oauth-handler.js:182-193`; `app/main.js:522-528`, `app/main.js:1627-1630`; `app/sysserver.js:340-354`; `app/panel-preload.js:22`; `app/config-preload.js:14`; `app/office.js:18-27`.

**Evidence:** `getValidTokens()` returns `accessToken` and `refreshToken`. The loopback `/api/oauth-tokens.json` route returns that object to any request passing the server-wide same-origin gate. All served built-in and drop-in pages execute on the same origin, so this gate distinguishes external web origins but not one served app from another. Both privileged preload bridges also expose the same retrieval operation. The only repository consumer uses `token.accessToken`; no consumer uses `refreshToken`.

**Security baseline/reference:** RFC 9700 sections 2.2.2 and 4.14 require refresh-token confidentiality and emphasize that a replayed refresh token can mint new access tokens for the full grant. RFC 6749 defines refresh tokens for use between the client and authorization server, not resource pages. Electron guidance recommends exposing the least privileged operation to renderer code.

**Attack or exposure scenario:** A malicious community app is imported as a served app, or a served app is compromised. Its JavaScript fetches `/api/oauth-tokens.json?provider=microsoft`. Because it is same-origin, it receives the full Microsoft access and refresh tokens. It can exfiltrate them through an allowed network path or a host-side server module. No app identity or per-app provider/scope grant is checked. Asking for fewer scopes does not down-scope the already-issued bearer token.

**Impact:** Immediate access to Microsoft Graph data permitted by the token (currently including profile, presence, and calendar when Office consent has been granted) and potentially durable account access by replaying the refresh token. A copied refresh token remains useful outside open-quake and local disconnect cannot invalidate Microsoft tokens already copied.

**Recommended remediation:** Keep refresh tokens exclusively in the main process. Return a minimal access-token DTO only to an explicitly authorized consumer, or preferably proxy the narrowly required Graph calls in the main process. Bind authorization to an app identity derived by the server, not a query parameter, and maintain an allowlist of provider, resource, and scopes per bundled/app manifest. Remove unused token methods from both preload bridges. Treat third-party served code as untrusted even when it is same-origin.

### OAUTH-002 — The editor renderer receives the complete plaintext secret-bearing configuration

**Severity:** Medium

**Affected components:** `app/config-preload.js:7-14`; `app/main.js:1196-1209`, `app/main.js:1607-1630`; `app/secretStore.js:97-123`.

**Evidence:** `getConfig` returns the live `config` object to `configWin`. That object is decrypted at startup and contains OAuth access/refresh tokens, optional client secrets, Home Assistant tokens, app API keys, and other password/header values. The same editor preload additionally exposes direct token retrieval. IPC checks compare `e.sender` with the window's `webContents`, but the BrowserWindow has no explicit navigation or new-window denial and the handlers do not validate `senderFrame.url`.

**Security baseline/reference:** Electron's security checklist recommends validating IPC senders, limiting navigation and new windows, and exposing narrow operations rather than generic secret retrieval. Context isolation reduces risk but does not make a broad preload API safe after renderer compromise.

**Attack or exposure scenario:** An XSS, dependency compromise, DevTools-assisted injection, or unintended navigation in the editor renderer executes in the page context and calls `getConfig()` or `getOAuthTokens()`. It receives all decrypted secrets, despite only needing editable display values and OAuth status for normal UI operation.

**Impact:** Compromise of multiple integrations and durable OAuth credentials from a single renderer flaw. Exploitation requires compromise of the local editor renderer; no direct injection path was confirmed during this audit, which limits severity.

**Recommended remediation:** Return a renderer-specific redacted configuration DTO. Represent stored secrets as “configured” sentinels and update them through focused setter operations without reading the existing value back. Remove `getOAuthTokens` from the editor preload. Deny unexpected navigation/window creation and validate both the expected `webContents` and `senderFrame.url` for privileged IPC.

### OAUTH-003 — A local `.env` development-secret file would be included in release artifacts

**Severity:** Medium

**Affected components:** `package.json:46-55`; `.gitignore:34-35`.

**Evidence:** `.gitignore` labels `.env` as a development-secret file, but electron-builder uses the explicit include `"**/*"` and does not exclude `.env`. Current electron-builder documentation states that hidden files are not ignored by default and `.env` is not in the built-in exclusion list. The audit machine did not have a root `.env`, so no current credential was exposed.

**Security baseline/reference:** Electron/electron-builder packaging guidance requires controlling the application file set; ASAR is packaging, not secrecy. Repository secret-management requirements prohibit credentials in release artifacts.

**Attack or exposure scenario:** A release is built on a developer machine with a populated `.env`. The file enters `app.asar`, from which an installer recipient can extract it.

**Impact:** Conditional disclosure of every credential stored in that development file. Actual impact depends on its contents and whether such a file exists on the release machine.

**Recommended remediation:** Add explicit exclusions for `.env`, `.env.*` with a deliberate exception only for non-secret templates, credential/key extensions, runtime logs, and other local secret-bearing paths. Prefer an allowlist of runtime source/assets. Add a CI artifact-content check that fails if secret-named files or high-confidence credentials appear in `app.asar` or `app.asar.unpacked`.

### OAUTH-004 — Loopback callback configuration does not follow native-app hardening guidance

**Severity:** Low

**Affected components:** `src/auth/providers.js:3-36`; `src/auth/oauth-handler.js:71`, `src/auth/oauth-handler.js:247-278`.

**Evidence:** All providers use `http://localhost:5173/oauth/callback`, while the listener binds only `127.0.0.1`. The port is fixed, all issuers share one path, and pending transactions have a `createdAt` value but no expiry or bounded cleanup.

**Security baseline/reference:** RFC 8252 recommends an IP literal, an OS-assigned loopback port, and binding appropriate loopback interfaces; it does not recommend `localhost`. RFC 9700 requires an issuer mix-up defense, commonly distinct redirect URIs per issuer, when a client interacts with multiple authorization servers.

**Attack or exposure scenario:** Hostname resolution or firewall behavior can break the callback, and another local process can occupy the fixed port to deny sign-in before the flow starts. If multiple placeholder providers are enabled later, a shared redirect URI provides weaker issuer separation. A stale state remains acceptable until used or process exit, although guessing it is infeasible and provider codes are short-lived/one-time.

**Impact:** Primarily reliability, denial of service, and reduced defense in depth; no practical authorization-code theft was demonstrated because PKCE and strong state are present.

**Recommended remediation:** Use `127.0.0.1` and an OS-assigned port when provider registration supports native loopback wildcards; use a distinct callback path per provider and enforce the expected path/provider; expire pending transactions after a short interval and cap concurrent attempts. If a provider forces a fixed redirect, document that constraint and preserve PKCE/state.

### OAUTH-005 — DPAPI memoization retains plaintext and superseded tokens until exit

**Severity:** Low

**Affected components:** `app/dpapi.js:48-66`; `src/auth/token-storage.js:53-65`; `src/auth/oauth-handler.js:173-178`, `src/auth/oauth-handler.js:196-212`.

**Evidence:** `encCache` keys are plaintext secrets and `decCache` values are plaintext secrets. Neither map has eviction or a clear operation. Refresh rotation adds new token values while retaining older ones, and disconnect removes tokens from active config but not these caches.

**Security baseline/reference:** RFC 9700 requires refresh-token confidentiality in storage. General sensitive-value lifecycle guidance favors deleting unneeded copies; this is defense in depth because a process-memory attacker may already have broad access.

**Attack or exposure scenario:** A memory dump or main-process compromise after token rotation or disconnect recovers token strings that the application considers replaced or removed.

**Impact:** Extends the in-memory lifetime of sensitive values and weakens logout/cleanup semantics. Exploitation requires local memory access or main-process compromise.

**Recommended remediation:** Avoid plaintext-as-key memoization for OAuth tokens, implement bounded caches with explicit clearing, and clear entries when tokens rotate or are deleted. Consider bypassing the cache for high-value refresh tokens; keep plaintext lifetime as short as practical.

### OAUTH-006 — OAuth security controls lack focused automated tests

**Severity:** Low

**Affected components:** `src/auth/*.js`; `test/`.

**Evidence:** The repository's current tests cover reserved-display behavior only. No tests exercise state rejection, one-time callback behavior, PKCE parameters, malformed provider responses, refresh rotation, scope checks, token redaction, OAuth IPC authorization, or loopback token-route isolation.

**Security baseline/reference:** This is a software-assurance finding rather than a protocol violation. The controls are subtle and regressions could expose durable credentials.

**Attack or exposure scenario:** A future refactor accidentally returns refresh tokens to a new consumer, weakens sender/origin checks, reuses PKCE data, or breaks encryption transforms without a failing test.

**Impact:** Increased probability and detection time for security regressions.

**Recommended remediation:** Add injected-fake `node:test` coverage for OAuthHandler, TokenStorage, SecretStore, IPC DTOs, and sysserver authorization. Include negative and redaction assertions and avoid live providers or real credentials.

### OAUTH-007 — Placeholder provider/client-model behavior is broader than the editor indicates

**Severity:** Informational

**Affected components:** `src/auth/providers.js:5-38`; `app/main.js:508-528`; `app/main.js:1609-1629`; `app/config.js:1968-2005`.

**Evidence:** The editor enables only Microsoft and labels GitHub/Google as placeholders, but the lower-level connect and token functions accept all defined providers. Optional `clientSecret` input is accepted by IPC/storage even though the Microsoft desktop client should be public and no client-secret field is shown in the UI. GitHub OAuth Apps require a client secret at exchange and therefore need a backend or an explicit acknowledgement that a distributed secret is not confidential. Google requests OIDC scopes but the returned ID token is not consumed.

**Security baseline/reference:** RFC 8252 classifies ordinary distributed native apps as public clients and says embedded shared secrets are not confidential. OIDC validation applies only if the ID token is used for an authentication decision, which it currently is not.

**Attack or exposure scenario:** A future feature enables a placeholder provider under the assumption that its metadata alone constitutes a secure client integration, or relies on an embedded client secret for client authentication.

**Impact:** No current exploit in the enabled Microsoft UI. This is an architectural guardrail for future provider enablement.

**Recommended remediation:** Enforce enabled providers in main-process APIs, explicitly model provider/client type and required token-exchange architecture, remove unused OIDC scopes unless identity is needed, and add full issuer/audience/signature/nonce validation before ever using an ID token.

## Secrets Exposure Assessment

| Surface | Assessment |
| --- | --- |
| Current source | No suspected real credential found by redacted high-confidence scan. Client IDs/default config contain no credential. The signing tenant ID is public metadata. |
| Local Git history | Relevant credential-named path history and high-confidence patterns in available diffs were inspected without printing values. No suspected real credential was found. This does not prove other clones/remotes are clean. |
| Configuration | Runtime `app/config.json` is ignored and explicitly excluded from packaging. User-data OAuth tokens are encrypted at the disk boundary when the selected backend works. The code intentionally falls back to plaintext if encryption is unavailable (`app/secretStore.js:43-47`, `app/main.js:1515-1519`). |
| Renderer/client | High-risk refresh-token exposure exists through OAuth token DTOs. The editor also receives the complete decrypted config. Dashboard guest content remains in a separate webview without Node integration. |
| Preload/IPC | Narrow channel names and main-window sender equality checks are positive. Token retrieval and full config retrieval are over-broad; sender-frame URL validation is absent. |
| Packaged output | `.signing/**` and `app/config.json` are excluded. `.env` is not excluded. `community-apps/jarvis/Mark-XLVI/config/api_keys.json` and its ZIP copy are packaged, but their credential field was empty during the audit. No built artifact was inspected. |
| Logs | OAuth logs contain provider IDs and error messages, not token request/response bodies or callback URLs. Generic provider `error_description` values may reach logs/browser text, but no token logging path was found. Tracked JARVIS stdout/stderr files were empty. |
| Tests/fixtures | No credential-bearing fixture was found. OAuth security behavior is untested. |
| Build/signing/CI | Local signing metadata is excluded and signing uses the developer's existing Azure session rather than embedding a token. No CI configuration was present in the repository inventory. |

**Suspected real secrets discovered:** No.

## OAuth Controls Assessment

| Control | Status | Evidence/notes |
| --- | --- | --- |
| Authorization Code flow | Present | `response_type=code`; no implicit or password grant. |
| External system browser | Present | `shell.openExternal` through a scheme-filtered helper. |
| Transaction-specific PKCE | Present | Random verifier per state. |
| S256 challenge | Present | SHA-256 and `code_challenge_method=S256`. |
| Cryptographically secure state | Present | 24 random bytes, base64url. |
| State validation and one-time use | Present | Exact map lookup and deletion before exchange. |
| Pending transaction expiry/cap | Absent | `createdAt` is stored but never checked; map is unbounded for process lifetime. |
| Redirect callback | Partially implemented | Loopback-only bind is good; `localhost`, fixed port, shared provider path, and IPv4-only assumptions weaken hardening. |
| Authorization-server identification/mix-up defense | Partially implemented | Pending state binds a provider and endpoints are hardcoded, but providers share a redirect URI. Only Microsoft is enabled in the UI. |
| HTTPS authorization/token endpoints | Present | All remote OAuth endpoints are HTTPS; HTTP is limited to loopback redirect. |
| Exact token endpoint selection | Present | Provider metadata is static source, not request-controlled. |
| Token expiry handling | Present | Expiry and five-minute skew are applied. |
| Refresh token replacement | Present | A newly returned refresh token replaces the old value; provider rotation behavior is unable to verify. |
| Refresh-token confinement | Incorrect | Refresh tokens are returned to pages/renderers. |
| Scope minimization | Partially implemented | Default Office scopes are reasonable, but any served app can obtain the existing broad bearer token and connect endpoint accepts caller-supplied scopes. |
| Secure token persistence | Partially implemented | DPAPI/safeStorage transforms are sound in design; explicit plaintext fallback and indefinite plaintext caches remain. |
| Token revocation/logout | Partially implemented | Google revoke URL is used; Microsoft/GitHub remote revocation is absent. Local deletion occurs. |
| Replay resistance | Present/partial | PKCE and one-time state protect code replay; stale pending state has no local TTL. Refresh-token replay protection depends on provider behavior. |
| OIDC ID-token validation | Not applicable currently | ID tokens are not used. Required before treating Google OIDC output as authentication. |
| Sender-constrained tokens | Unable to verify/provider-dependent | The client does not request DPoP; not automatically a defect when providers/resources do not support it. |

## Electron / Application Boundary Assessment

Main-process ownership of filesystem, OS, token exchange, and persistence is architecturally correct. Both BrowserWindows set `nodeIntegration: false` and `contextIsolation: true`; Electron 42 defaults renderer sandboxing on, and no `sandbox: false` was found. Local documents have a CSP with `script-src 'self'`, object blocking, base blocking, and frame-ancestor blocking. IPC handlers generally validate the owning `webContents`.

Remote dashboards execute in a separate persistent webview with no Node integration. The dashboard session has a permission-request handler, and external URLs are limited to HTTP(S). The sysserver binds to `127.0.0.1`, validates Host to resist DNS rebinding, and applies a fail-closed same-origin check to secrets/live data.

The principal boundary failure is capability design: same-origin is treated as sufficient authorization for a global OAuth-token endpoint even though multiple third-party served apps share that origin. The editor renderer also receives far more secret material than it needs. Main-process navigation/window controls and `senderFrame.url` validation would add useful defense in depth.

## Token Storage Assessment

OAuth tokens originate at the main-process token endpoint exchange and are stored under `config.settings.oauth.tokens`. Persistence uses a cloned config: OAuth access and refresh token fields are individually transformed before JSON is written. Windows uses current-user DPAPI blobs sent to PowerShell over stdin, not argv; other platforms use Electron `safeStorage`. This is appropriate protection against offline copying by a different OS user and avoids a repository-held encryption key.

It does not protect against the same logged-in user, main-process compromise, malicious renderer capabilities, or a packaged app that deliberately invokes the decrypt path. The application keeps the full decrypted config in main memory, deliberately sends copies to renderer/page JavaScript, and caches plaintext DPAPI inputs indefinitely. If DPAPI/safeStorage is unavailable, the application intentionally persists plaintext after logging a warning. That availability choice should be explicit to the user when OAuth refresh tokens are present.

## Packaging Assessment

Positive controls include explicit exclusions for runtime `app/config.json`, `docs`, tools, native source, signing hooks/assets, and generated CA material. `.signing/**` is excluded, and signing authenticates through the local Azure session rather than a stored repository token. ASAR does not provide confidentiality but no code comments claim that it does.

The broad `"**/*"` include leaves local `.env` files packageable. Community app sources, ZIPs, and their credential-shaped empty config/log files are also included; current copies contain no secret. A build-and-inspect gate is needed because source reasoning alone cannot account for local ignored files on a release machine.

## Threat Model Results

| Threat | Status | Rationale |
| --- | --- | --- |
| Attacker obtains packaged application/resources | Partially mitigated | No embedded current client credential found; ASAR is extractable and local `.env` is not excluded. |
| Attacker inspects JavaScript | Mitigated for shared app secrets | Microsoft uses a user-supplied public client ID; no embedded secret was found. Optional client secrets must not be assumed confidential. |
| Malicious/compromised served renderer executes | Not mitigated | It can retrieve access and refresh tokens through the global same-origin route. |
| XSS in panel host renderer | Partially mitigated | CSP/isolation help, but the panel preload exposes token retrieval. |
| XSS in editor renderer | Partially mitigated | CSP/isolation help, but full decrypted config and token retrieval are exposed. |
| Local config is copied | Mitigated when encryption is available | DPAPI/safeStorage protects configured fields; explicit plaintext fallback exists. |
| OAuth callback spoofed/manipulated | Mitigated | Strong state, PKCE, and loopback-only bind; callback hardening gaps are low severity. |
| Authorization code intercepted | Mitigated | Transaction-specific S256 PKCE prevents redemption without verifier. |
| Access token stolen | Not mitigated at application boundary | Bearer token is deliberately given to page JavaScript; provider sender-constraint support was not verified. |
| Refresh token stolen | Not mitigated at application boundary | Refresh token is deliberately given to page JavaScript and persists in caches. |
| Malicious external URL/deep link | Partially mitigated | External open helper accepts only HTTP(S); navigation/window restrictions are incomplete. No custom deep-link callback is used. |
| Developer commits a credential | Partially mitigated | Runtime config, `.env`, signing directory, and logs are ignored; no automated pre-commit/CI secret scanner was found. |
| Historical secret remains in Git | Unable to verify completely | Local high-confidence scan found none; remote and deleted-object coverage was out of scope. |
| Packaged build contains development credentials | Partially mitigated | Important paths are excluded, but `.env` is not and no artifact-content check exists. |
| Previous OAuth response replayed | Mitigated/partial | State is one-time and code is PKCE-bound; pending entries do not expire locally. |
| IPC trust boundary manipulated | Partially mitigated | Owning-window checks are consistent; payload capability and sender-frame validation need tightening. |

## Recommended Remediation

### Immediate

1. Stop returning refresh tokens from `getValidTokens()`, IPC, and `/api/oauth-tokens.json`. Keep them main-process-only.
2. Restrict access-token use to the Office integration: preferably proxy the specific Microsoft Graph operations in main, or enforce an app identity plus provider/resource/scope allowlist.
3. Explicitly exclude `.env`, `.env.*` secret variants, credential/key files, and local logs from packaging; inspect the final ASAR in CI.

### Short Term

1. Replace editor `getConfig()` with a redacted renderer DTO and focused secret setter operations; remove both preload token getters unless a proven consumer needs one.
2. Add OAuth unit/integration tests using fake storage, fetch, browser-open, IPC, and HTTP requests. Assert refresh tokens never cross the main boundary.
3. Harden callback lifecycle with loopback IP literals, ephemeral ports where supported, provider-specific paths, pending TTL/cap, and enabled-provider enforcement.
4. Define disconnect semantics and provider-specific revocation limitations in the UI; clear sensitive caches when tokens rotate or are deleted.

### Defence in Depth

1. Validate `senderFrame.url`, deny unexpected BrowserWindow navigation/window creation, and verify webview attach options centrally.
2. Move from broad packaging inclusion to a runtime allowlist and scan release artifacts for secret patterns and sensitive filenames.
3. If providers support it, evaluate DPoP/sender-constrained tokens; do not claim this control without verifying both authorization and resource-server support.
4. Surface a warning or refuse durable OAuth connection when secure persistence is unavailable instead of silently accepting plaintext storage after a console warning.

## Positive Findings

- Correct authorization-code flow with external system browser; no implicit or resource-owner password grant.
- Strong, transaction-specific state and PKCE verifier generation using Node cryptography.
- Correct S256 challenge construction and verifier exchange.
- State is removed before token exchange, limiting callback replay.
- Authorization and token endpoints are hardcoded HTTPS URLs, not renderer-supplied destinations.
- Tokens are sent in form bodies or Authorization headers, not application URLs or logs.
- Token responses and secret loopback routes use `Cache-Control: no-store`.
- Token refresh applies expiry skew and preserves provider-issued refresh-token rotation.
- Windows at-rest encryption uses current-user DPAPI; secrets cross PowerShell via stdin, not command-line arguments.
- Runtime config, signing assets, logs, and build outputs are ignored; runtime config and `.signing/**` are also explicitly excluded from packaging.
- Context isolation and disabled Node integration are set on both app BrowserWindows; remote dashboards live in a separate webview.
- IPC handlers consistently compare senders with the owning window.
- Local HTTP services bind to `127.0.0.1`; the app server validates Host and same-origin metadata and fails closed.
- CSP blocks inline/external script injection beyond self-hosted scripts and disables objects/base/form/frame ancestry.
- URL option delivery excludes app schema fields marked secret.
- No suspected real credentials were found; tracked credential-shaped JARVIS config/log files and ZIP entries were empty of credential values.

## Uncertainties

- Provider-side public-client registration, redirect URI exactness, token audience, tenant restrictions, consent configuration, refresh-token replay detection/rotation, and revocation behavior were not verifiable without live administrative access and were not tested.
- The Microsoft endpoint uses the `common` tenant. Whether single-tenant restriction is intended is a product decision not inferable from source.
- Electron 42 renderer sandbox defaults were relied upon because no `sandbox: false` exists; an explicit `sandbox: true` and fuse review would make intent verifiable.
- No packaged artifact was available, so actual artifact contents and signatures remain unverified.
- No remote repository, release artifacts, CI secret store, or other developer machines were inspected.
- The external security baseline was successfully refreshed on 2026-08-11 from current primary/official sources. Emerging Internet-Drafts were kept separate from established requirements.
