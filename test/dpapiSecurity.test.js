'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSecretStore, MARKER2 } = require('../app/secretStore');
const { TokenStorage } = require('../src/auth/token-storage');

const root = path.join(__dirname, '..');
const dpapi = process.platform === 'win32' ? require('../app/dpapi') : null;
const windowsTest = process.platform === 'win32' ? test : test.skip;
const canary = 'OQ_SYNTHETIC_CANARY_9f2b7c';

function storeFor(backend, logs) {
  return createSecretStore({
    safeStorage: null,
    dpapi: backend,
    loadApps: () => [],
    log: message => logs && logs.push(message),
  });
}

function tokenConfig(accessToken, refreshToken) {
  return {
    grids: [],
    settings: { oauth: { providers: {}, tokens: { microsoft: { accessToken, refreshToken } } } },
  };
}

windowsTest('native DPAPI round trip handles ASCII and Unicode synthetic values', () => {
  assert.equal(dpapi.available(), true);
  for (const value of [canary, 'synthetic 秘密 🔐 café']) {
    const blob = dpapi.protectOne(value);
    assert.match(blob, /^[A-Za-z0-9+/]+={0,2}$/);
    assert.equal(dpapi.unprotectOne(blob), value);
  }
});

windowsTest('native DPAPI ciphertext survives a fresh process restart', () => {
  const encrypt = "const d=require('./app/dpapi');process.stdout.write(d.protectOne(process.argv[1])||'')";
  const decrypt = "const d=require('./app/dpapi');process.stdout.write(d.unprotectOne(process.argv[1])||'')";
  const first = childProcess.spawnSync(process.execPath, ['-e', encrypt, canary], { cwd: root, encoding: 'utf8' });
  assert.equal(first.status, 0);
  assert.notEqual(first.stdout, '');
  assert.doesNotMatch(first.stdout, new RegExp(canary));
  const second = childProcess.spawnSync(process.execPath, ['-e', decrypt, first.stdout], { cwd: root, encoding: 'utf8' });
  assert.equal(second.status, 0);
  assert.equal(second.stdout, canary);
  assert.doesNotMatch(first.stderr + second.stderr, new RegExp(canary));
});

windowsTest('existing oqenc:v2 raw DPAPI blobs decrypt without migration', () => {
  const existing = MARKER2 + dpapi.protectOne(canary);
  const store = storeFor(dpapi);
  assert.equal(store.decryptValue(existing), canary);
  assert.equal(store.needsRewrite({ grids: [], settings: { haAuth: { token: existing } } }), false);
});

windowsTest('malformed and corrupted ciphertext fail generically without logging secrets', () => {
  const logs = [];
  const store = storeFor(dpapi, logs);
  assert.equal(dpapi.unprotectOne('not base64!'), null);
  const blob = Buffer.from(dpapi.protectOne(canary), 'base64');
  blob[Math.floor(blob.length / 2)] ^= 0xff;
  assert.equal(dpapi.unprotectOne(blob.toString('base64')), null);
  const stored = MARKER2 + blob.toString('base64');
  assert.equal(store.decryptValue(stored), stored);
  assert.doesNotMatch(logs.join('\n'), new RegExp(canary));
});

test('encryption backend failure never downgrades a changed secret to plaintext', () => {
  const failing = { available: () => true, protectOne: () => null, unprotectOne: () => null };
  const store = storeFor(failing);
  assert.throws(() => store.encryptValue(canary), /Secret encryption failed/);
  assert.throws(() => store.encryptConfig(tokenConfig(canary, canary + '-refresh')), /Secret encryption failed/);
});

test('OAuth token mutations roll back when secure persistence fails', () => {
  let config = tokenConfig('old-access', 'old-refresh');
  const storage = new TokenStorage({ getConfig: () => config, saveConfig: () => false });
  assert.throws(() => storage.setTokens('microsoft', { accessToken: canary, refreshToken: canary + '-refresh' }), /stored securely/);
  assert.equal(config.settings.oauth.tokens.microsoft.accessToken, 'old-access');
  assert.equal(config.settings.oauth.tokens.microsoft.refreshToken, 'old-refresh');
  assert.throws(() => storage.deleteTokens('microsoft'), /deletion could not be stored/);
  assert.equal(config.settings.oauth.tokens.microsoft.refreshToken, 'old-refresh');
});

windowsTest('OAuth save, restart restore, refresh rotation, and logout stay encrypted at rest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-quake-dpapi-'));
  const file = path.join(dir, 'config.json');
  const store = storeFor(dpapi);
  let config = tokenConfig(canary + '-access', canary + '-refresh');
  const saveConfig = () => {
    fs.writeFileSync(file, JSON.stringify(store.encryptConfig(config)));
    return true;
  };
  const storage = new TokenStorage({ getConfig: () => config, saveConfig });
  try {
    assert.equal(saveConfig(), true);
    let persisted = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(persisted, new RegExp(canary));

    config = store.decryptConfig(JSON.parse(persisted));
    assert.equal(storage.getTokens('microsoft').refreshToken, canary + '-refresh');

    storage.setTokens('microsoft', { accessToken: canary + '-rotated-access', refreshToken: canary + '-rotated-refresh' });
    persisted = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(persisted, new RegExp(canary));
    config = store.decryptConfig(JSON.parse(persisted));
    assert.equal(storage.getTokens('microsoft').refreshToken, canary + '-rotated-refresh');

    storage.deleteTokens('microsoft');
    config = store.decryptConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
    assert.equal(storage.getTokens('microsoft'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DPAPI implementation has no shell or PowerShell process brokerage', () => {
  const source = fs.readFileSync(path.join(root, 'app', 'dpapi.js'), 'utf8');
  const nativeSource = fs.readFileSync(path.join(root, 'native', 'dpapi', 'dpapi.cc'), 'utf8');
  assert.doesNotMatch(source, /require\(['"]child_process|spawnSync\s*\(|execFile\s*\(|powershell\.exe/i);
  assert.match(nativeSource, /CRYPTPROTECT_UI_FORBIDDEN/);
  assert.doesNotMatch(nativeSource, /CRYPTPROTECT_LOCAL_MACHINE/);
  assert.match(nativeSource, /LocalFree/);
  assert.match(nativeSource, /SecureZeroMemory/);
});
