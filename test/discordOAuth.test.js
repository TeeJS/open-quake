'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { DiscordOAuth, DISCORD_CALLBACK_HOST, DISCORD_CALLBACK_PATH, DISCORD_CALLBACK_PORT, DISCORD_REDIRECT_URI, DISCORD_SCOPES, createPkce, secureEqual } = require('../app/discordOAuth');

class MockServer extends EventEmitter {
  constructor(handler) { super(); this.handler = handler; this.closed = false; }
  listen(port, host, callback) { this.port = port; this.host = host; callback(); }
  close() { this.closed = true; }
  callback(url, method = 'GET') {
    const response = { status: 0, body: '', writeHead: status => { response.status = status; }, end: body => { response.body = body || ''; } };
    this.handler({ url, method }, response);
    return response;
  }
}

test('PKCE verifier and S256 challenge use cryptographically supplied bytes', () => {
  const pkce = createPkce(size => Buffer.alloc(size, 7));
  assert.equal(pkce.verifier.length, 43);
  assert.equal(pkce.challenge.length, 43);
  assert.notEqual(pkce.verifier, pkce.challenge);
  assert.match(pkce.verifier + pkce.challenge, /^[A-Za-z0-9_-]+$/);
  assert.equal(secureEqual('state', 'state'), true);
  assert.equal(secureEqual('state', 'other'), false);
});

test('public-client browser callback validates state and exchanges code with PKCE and no secret', async () => {
  let server, opened, request, stored;
  const oauth = new DiscordOAuth({
    getClientId: () => 'client', getTokens: () => null, setTokens: value => { stored = value; }, now: () => 1000,
    randomBytes: size => Buffer.alloc(size, 3), createServer: handler => (server = new MockServer(handler)),
    openExternal: async url => { opened = new URL(url); },
    fetch: async (url, options) => { request = { url, options }; return { ok: true, text: async () => JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 60, scope: DISCORD_SCOPES.join(' ') }) }; },
  });
  const pending = oauth.authorize();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(server.port, DISCORD_CALLBACK_PORT);
  assert.equal(server.host, DISCORD_CALLBACK_HOST);
  assert.equal(opened.searchParams.get('redirect_uri'), DISCORD_REDIRECT_URI);
  assert.equal(opened.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(opened.searchParams.get('scope'), DISCORD_SCOPES.join(' '));
  assert.equal(opened.searchParams.get('prompt'), 'consent');
  const response = server.callback('/callback?code=auth-code&state=' + encodeURIComponent(opened.searchParams.get('state')));
  assert.equal(response.status, 200);
  assert.equal(await pending, 'access');
  const body = String(request.options.body);
  assert.match(body, /client_id=client/);
  assert.match(body, /code_verifier=/);
  assert.match(body, /redirect_uri=http%3A%2F%2F127\.0\.0\.1%2Fcallback/);
  assert.doesNotMatch(body, /client_secret|secret/);
  assert.equal(stored.refreshToken, 'refresh');
});

test('callback listener accepts only GET on the exact registered path', async () => {
  let server, opened;
  const oauth = new DiscordOAuth({
    getClientId: () => 'client', randomBytes: size => Buffer.alloc(size, 8),
    createServer: handler => (server = new MockServer(handler)), openExternal: async url => { opened = new URL(url); },
    fetch: async () => ({ ok: true, text: async () => JSON.stringify({ access_token: 'access', refresh_token: 'refresh' }) }),
  });
  const pending = oauth.authorize();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(server.callback('/wrong').status, 404);
  assert.equal(server.callback(DISCORD_CALLBACK_PATH, 'POST').status, 405);
  const state = opened.searchParams.get('state');
  assert.equal(server.callback(DISCORD_CALLBACK_PATH + '?code=ok&state=' + encodeURIComponent(state)).status, 200);
  assert.equal(await pending, 'access');
  assert.equal(DISCORD_REDIRECT_URI, 'http://127.0.0.1/callback');
});

test('callback rejects a mismatched OAuth state before token exchange', async () => {
  let server, fetches = 0;
  const oauth = new DiscordOAuth({
    getClientId: () => 'client', randomBytes: size => Buffer.alloc(size, 4),
    createServer: handler => (server = new MockServer(handler)), openExternal: async () => {},
    fetch: async () => { fetches += 1; },
  });
  const pending = oauth.authorize();
  await new Promise(resolve => setImmediate(resolve));
  const response = server.callback('/callback?code=auth-code&state=attacker');
  assert.equal(response.status, 400);
  await assert.rejects(pending, error => error.code === 'DISCORD_AUTH_STATE');
  assert.equal(fetches, 0);
});

test('expired tokens refresh as a public client and rotate refresh tokens', async () => {
  let stored, deleted = 0, request;
  const tokens = { accessToken: 'old', refreshToken: 'refresh-old', expiresAt: 1, scope: DISCORD_SCOPES.join(' ') };
  const oauth = new DiscordOAuth({
    getClientId: () => 'client', getTokens: () => tokens, setTokens: value => { stored = value; }, deleteTokens: () => { deleted += 1; }, now: () => 100000,
    fetch: async (url, options) => { request = options; return { ok: true, text: async () => JSON.stringify({ access_token: 'new', refresh_token: 'refresh-new', expires_in: 3600 }) }; },
  });
  assert.equal(await oauth.accessToken(), 'new');
  assert.equal(stored.refreshToken, 'refresh-new');
  assert.match(String(request.body), /grant_type=refresh_token/);
  assert.doesNotMatch(String(request.body), /client_secret/);
  assert.equal(deleted, 0);
});

test('refresh failure deletes stored tokens so reconnect re-authorizes', async () => {
  let deleted = 0;
  const oauth = new DiscordOAuth({ getClientId: () => 'client', getTokens: () => ({ accessToken: 'old', refreshToken: 'refresh', expiresAt: 1, scope: DISCORD_SCOPES.join(' ') }), deleteTokens: () => { deleted += 1; }, now: () => 100000, fetch: async () => ({ ok: false, text: async () => '{}' }) });
  assert.equal(await oauth.accessToken(), null);
  assert.equal(deleted, 1);
});

test('legacy Discord grants require explicit reauthorization when required scopes change', async () => {
  const oauth = new DiscordOAuth({ getTokens: () => ({ accessToken: 'old', refreshToken: 'refresh', scope: 'rpc identify' }) });
  assert.equal(oauth.requiresReauthorization(), true);
  assert.equal(await oauth.accessToken(), null);
  assert.deepEqual(DISCORD_SCOPES, ['rpc', 'identify', 'rpc.voice.read', 'rpc.voice.write', 'messages.read', 'rpc.notifications.read']);
});
