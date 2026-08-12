'use strict';
/*
 * dpapi.js — raw Windows DPAPI (CryptProtectData/CryptUnprotectData, CurrentUser scope) through
 * the first-party Node-API binding. The at-rest secret backend on Windows (secretStore.js
 * `oqenc:v2:` values), replacing Electron safeStorage.
 *
 * Why not safeStorage: its Chromium OSCrypt layer wraps one random AES key in DPAPI and keeps it
 * in the profile's Local State — and in this app that key proved session-local in practice (real
 * launches encrypted with a key no later launch could recover, silently orphaning every stored
 * secret; diagnosed 2026-07-03). Raw DPAPI has no key file at all: each value is independently
 * protected by the user's Windows credentials. Same security boundary (same-user DPAPI at the
 * bottom of both chains), none of the key-lifecycle fragility.
 *
 * The binding uses CRYPTPROTECT_UI_FORBIDDEN, current-user scope, and no optional entropy, exactly
 * matching the former PowerShell blobs. No plaintext cache is retained.
 */
let binding = null;
if (process.platform === 'win32') {
  try { binding = require('./native/open_quake_dpapi.node'); } catch (e) {}
}

function decodeBlob(blob) {
  if (typeof blob !== 'string' || blob === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob) || blob.length % 4 !== 0) return null;
  const bytes = Buffer.from(blob, 'base64');
  return bytes.length && bytes.toString('base64') === blob ? bytes : null;
}

/** Encrypt one utf8 string -> DPAPI blob (base64), or null on failure. */
function protectOne(plain) {
  if (!binding || typeof plain !== 'string') return null;
  try { return binding.protect(Buffer.from(plain, 'utf8')).toString('base64'); }
  catch (e) { return null; }
}

/** Decrypt one DPAPI blob (base64) -> utf8 string, or null on failure. */
function unprotectOne(blob) {
  const bytes = decodeBlob(blob);
  if (!binding || !bytes) return null;
  try { return binding.unprotect(bytes).toString('utf8'); }
  catch (e) { return null; }
}

/** The module is loaded only on Windows; real operation failures remain fail-closed per call. */
function available() { return !!binding; }

module.exports = { protectOne, unprotectOne, available };
