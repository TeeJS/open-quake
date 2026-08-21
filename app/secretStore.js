'use strict';
// Encrypt the secret-typed config fields at rest in config.json. Secrets stay PLAINTEXT in the
// in-memory config — they are only (de)serialized at the disk boundary. Dependency-injected so
// it unit-tests without Electron.
//
// Backends: on Windows, raw DPAPI per-value blobs via app/dpapi.js (`oqenc:v2:`) — Electron
// safeStorage's Chromium key layer proved to lose its key across real launches (2026-07-03),
// orphaning every stored secret; raw DPAPI has no key file to lose. Elsewhere, Electron
// `safeStorage` (`oqenc:v1:`, macOS Keychain-backed). v1 values still decrypt on Windows for
// migration; anything that decrypts is re-wrapped as v2 by the next save (see needsRewrite).
//
// Secret fields walked by encryptConfig/decryptConfig/hasPlaintextSecret:
//   web grids (g.kind === 'web' && g.auth):
//     auth.type === 'ha'     -> auth.token
//     auth.type === 'basic'  -> auth.pass            (NOT auth.user)
//     auth.type === 'header' -> auth.headers[i].value (NOT auth.headers[i].name)
//   app grids (g.kind === 'app'): each option key whose schema type is 'secret' (apps.json).
//   settings:
//     settings.spotify.refreshToken                   (NOT settings.spotify.clientId — clientId is public)
//     settings.haAuth.token                           (NOT settings.haAuth.url — the URL is not sensitive)
//     settings.owui.apiKey                            (NOT settings.owui.url/model — those are not secrets)
//     settings.meeting.joplinToken                    (NOT settings.meeting.joplinUrl/joplinNotebook)
//     settings.oauth.providers[*].clientSecret        (optional confidential OAuth clients)
//     settings.oauth.tokens[*].accessToken / refreshToken
const MARKER = 'oqenc:v1:';    // legacy: Electron safeStorage — still decrypted, never written on Windows
const MARKER2 = 'oqenc:v2:';   // Windows: raw DPAPI per-value blobs (app/dpapi.js), no key file

function createSecretStore({ safeStorage, dpapi, loadApps, log = () => {} }) {
  const dp = dpapi || null;   // injected on win32 only; null elsewhere keeps the safeStorage path

  // safeStorage is only usable after the Electron app is ready; treat any throw as "unavailable".
  function available() {
    if (dp) return dp.available();
    try { return !!(safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()); }
    catch { return false; }
  }

  // Encrypt one value for at-rest storage. Idempotent (already-marked values pass through), and a
  // no-op for non-strings / empty strings. Encryption failure aborts the enclosing save.
  function encryptValue(plain) {
    if (typeof plain !== 'string' || plain === '') return plain;
    if (plain.startsWith(MARKER) || plain.startsWith(MARKER2)) return plain;   // already encrypted — don't double-wrap
    if (dp) {
      const blob = dp.protectOne(plain);
      if (blob) return MARKER2 + blob;
      throw new Error('Secret encryption failed');
    }
    if (!available()) throw new Error('Secret encryption is unavailable');
    try { return MARKER + safeStorage.encryptString(plain).toString('base64'); }
    catch (e) { throw new Error('Secret encryption failed'); }
  }

  // Decrypt one stored value. Plaintext (unmarked) values pass through unchanged — this is also the
  // migration path: a pre-encryption config decrypts to itself. A decrypt failure logs and preserves
  // the marked ciphertext, so a later save does not erase the user's secret.
  function decryptValue(stored) {
    if (typeof stored !== 'string') return stored;
    if (stored.startsWith(MARKER2)) {
      if (!dp) return stored;                                // v2 blob on a non-Windows box: preserve as-is
      const plain = dp.unprotectOne(stored.slice(MARKER2.length));
      if (plain === null) { log('secret decrypt failed (DPAPI could not unprotect a v2 blob) — re-enter the secret in the editor'); return stored; }
      return plain;
    }
    if (!stored.startsWith(MARKER)) return stored;
    try { return safeStorage.decryptString(Buffer.from(stored.slice(MARKER.length), 'base64')); }
    catch (e) { log('skipping a legacy (v1) secret whose safeStorage key was rotated away — re-enter it in the editor to re-save it securely'); return stored; }
  }

  // The option keys an app declares as type:'secret' in apps.json (e.g. Open WebUI api_key).
  function secretKeysForApp(appId) {
    const def = (loadApps() || []).find(a => a && a.id === appId);
    if (!def || !Array.isArray(def.options)) return [];
    return def.options.filter(o => o && o.type === 'secret').map(o => o.key);
  }

  // Apply `fn` to exactly the secret fields of `g`, in place (g is a clone supplied by the callers).
  function transformGridSecrets(g, fn) {
    if (!g || typeof g !== 'object') return;
    if (g.kind === 'web' && g.auth && typeof g.auth === 'object') {
      const a = g.auth;
      if (a.type === 'ha') a.token = fn(a.token);
      else if (a.type === 'basic') a.pass = fn(a.pass);     // user stays plaintext
      else if (a.type === 'header' && Array.isArray(a.headers)) {
        a.headers.forEach(h => { if (h && typeof h === 'object') h.value = fn(h.value); });   // name stays plaintext
      }
    } else if (g.kind === 'app') {
      const opts = g.options;
      if (opts && typeof opts === 'object') {
        secretKeysForApp(g.app).forEach(key => {
          if (key in opts) opts[key] = fn(opts[key]);
        });
      }
    }
  }

  // Apply `fn` to exactly the secret fields under config.settings, in place (config is a clone supplied
  // by the callers). See the header comment for the full field list (URL/clientId/model fields
  // stay plaintext — they aren't secrets).
  function transformSettingsSecrets(config, fn) {
    const sp = config && config.settings && config.settings.spotify;
    if (sp && typeof sp === 'object' && typeof sp.refreshToken === 'string' && sp.refreshToken !== '') {
      sp.refreshToken = fn(sp.refreshToken);
    }
    const ha = config && config.settings && config.settings.haAuth;
    if (ha && typeof ha === 'object' && typeof ha.token === 'string' && ha.token !== '') {
      ha.token = fn(ha.token);
    }
    const ow = config && config.settings && config.settings.owui;
    if (ow && typeof ow === 'object' && typeof ow.apiKey === 'string' && ow.apiKey !== '') {
      ow.apiKey = fn(ow.apiKey);
    }
    const me = config && config.settings && config.settings.meeting;
    if (me && typeof me === 'object' && typeof me.joplinToken === 'string' && me.joplinToken !== '') {
      me.joplinToken = fn(me.joplinToken);
    }
    const oauth = config && config.settings && config.settings.oauth;
    if (oauth && typeof oauth === 'object') {
      const providers = oauth.providers && typeof oauth.providers === 'object' ? oauth.providers : {};
      Object.keys(providers).forEach(id => {
        const p = providers[id];
        if (p && typeof p === 'object' && typeof p.clientSecret === 'string' && p.clientSecret !== '') {
          p.clientSecret = fn(p.clientSecret);
        }
      });
      const tokens = oauth.tokens && typeof oauth.tokens === 'object' ? oauth.tokens : {};
      Object.keys(tokens).forEach(id => {
        const t = tokens[id];
        if (!t || typeof t !== 'object') return;
        if (typeof t.accessToken === 'string' && t.accessToken !== '') t.accessToken = fn(t.accessToken);
        if (typeof t.refreshToken === 'string' && t.refreshToken !== '') t.refreshToken = fn(t.refreshToken);
      });
    }
  }

  function isEncrypted(v) { return typeof v === 'string' && (v.startsWith(MARKER) || v.startsWith(MARKER2)); }

  // Walk every secret field of `g`; true if any holds a non-empty, not-yet-encrypted string.
  function gridHasPlaintextSecret(g) {
    let found = false;
    transformGridSecrets(g, v => {
      if (typeof v === 'string' && v !== '' && !isEncrypted(v)) found = true;
      return v;
    });
    return found;
  }

  // Both operate on a structuredClone — the input config is never mutated.
  function encryptConfig(config) {
    const clone = structuredClone(config);
    (clone && Array.isArray(clone.grids) ? clone.grids : []).forEach(g => transformGridSecrets(g, encryptValue));
    transformSettingsSecrets(clone, encryptValue);
    return clone;
  }
  function decryptConfig(config) {
    const clone = structuredClone(config);
    (clone && Array.isArray(clone.grids) ? clone.grids : []).forEach(g => transformGridSecrets(g, decryptValue));
    transformSettingsSecrets(clone, decryptValue);
    return clone;
  }
  function hasPlaintextSecret(config) {
    if ((config && Array.isArray(config.grids) ? config.grids : []).some(gridHasPlaintextSecret)) return true;
    let found = false;
    transformSettingsSecrets(structuredClone(config || {}), v => {
      if (typeof v === 'string' && v !== '' && !isEncrypted(v)) found = true;
      return v;
    });
    return found;
  }

  // True when a save would change the at-rest form of the AS-LOADED config: plaintext secrets that
  // need encrypting, or (on the DPAPI backend) legacy v1 values that still decrypt and should be
  // re-wrapped as v2. Dead v1 ciphertexts (decrypt fails) do NOT trigger a rewrite — they are
  // preserved as-is until the user re-enters them.
  function needsRewrite(config) {
    if (hasPlaintextSecret(config)) return true;
    if (!dp) return false;
    let found = false;
    const probe = v => {
      // Silent v1 decrypt attempt (no decryptValue, whose failure log would double up with
      // decryptConfig's own pass right after this): dead v1 values just don't trigger a rewrite.
      if (typeof v === 'string' && v.startsWith(MARKER)) {
        try { safeStorage.decryptString(Buffer.from(v.slice(MARKER.length), 'base64')); found = true; }
        catch (e) {}
      }
      return v;
    };
    (config && Array.isArray(config.grids) ? config.grids : []).forEach(g => transformGridSecrets(g, probe));
    transformSettingsSecrets(structuredClone(config || {}), probe);
    return found;
  }

  return {
    MARKER,
    MARKER2,
    available,
    encryptValue,
    decryptValue,
    secretKeysForApp,
    encryptConfig,
    decryptConfig,
    hasPlaintextSecret,
    needsRewrite,
  };
}

module.exports = { createSecretStore, MARKER, MARKER2 };
