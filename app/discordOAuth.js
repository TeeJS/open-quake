'use strict';

const crypto = require('crypto');
const http = require('http');

const DISCORD_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const DISCORD_REDIRECT_URI = 'http://127.0.0.1/callback';
const DISCORD_CALLBACK_HOST = '127.0.0.1';
const DISCORD_CALLBACK_PORT = 80;
const DISCORD_CALLBACK_PATH = '/callback';
const DISCORD_SCOPES = Object.freeze([
  'rpc', 'identify', 'rpc.voice.read', 'rpc.voice.write', 'messages.read', 'rpc.notifications.read',
]);

function grantedScopes(tokens) {
  return new Set(String(tokens && tokens.scope || '').split(/\s+/).filter(Boolean));
}

function hasRequiredScopes(tokens) {
  const granted = grantedScopes(tokens);
  return DISCORD_SCOPES.every(scope => granted.has(scope));
}

function base64Url(value) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function createPkce(randomBytes) {
  const bytes = (randomBytes || crypto.randomBytes)(32);
  const verifier = base64Url(bytes);
  return { verifier, challenge: base64Url(crypto.createHash('sha256').update(verifier).digest()) };
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function formBody(value) {
  const body = new URLSearchParams();
  for (const [key, item] of Object.entries(value || {})) if (item != null && item !== '') body.set(key, String(item));
  return body;
}

class DiscordOAuth {
  constructor(options) {
    const opts = options || {};
    this.getClientId = opts.getClientId || (() => '');
    this.getTokens = opts.getTokens || (() => null);
    this.setTokens = opts.setTokens || (() => {});
    this.deleteTokens = opts.deleteTokens || (() => {});
    this.fetch = opts.fetch || globalThis.fetch;
    this.openExternal = opts.openExternal || (() => Promise.reject(new Error('External browser is unavailable')));
    this.createServer = opts.createServer || (handler => http.createServer(handler));
    this.randomBytes = opts.randomBytes || crypto.randomBytes;
    this.now = opts.now || Date.now;
    this.callbackTimeoutMs = opts.callbackTimeoutMs || 120000;
    this.pendingAuthorization = null;
  }

  async accessToken() {
    const tokens = this.getTokens();
    if (!tokens || !tokens.accessToken) return null;
    if (!hasRequiredScopes(tokens)) return null;
    if (!tokens.expiresAt || this.now() < Number(tokens.expiresAt) - 60000) return tokens.accessToken;
    if (!tokens.refreshToken) { this.deleteTokens(); return null; }
    try { return (await this._token({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken })).accessToken; }
    catch (error) { this.deleteTokens(); return null; }
  }

  requiresReauthorization() {
    const tokens = this.getTokens();
    return !!(tokens && tokens.accessToken && !hasRequiredScopes(tokens));
  }

  authorize() {
    if (this.pendingAuthorization) return this.pendingAuthorization;
    const pending = this._authorize();
    this.pendingAuthorization = pending.finally(() => { this.pendingAuthorization = null; });
    return this.pendingAuthorization;
  }

  async _authorize() {
    const clientId = String(this.getClientId() || '');
    if (!clientId) throw Object.assign(new Error('Discord Application ID is not configured'), { code: 'DISCORD_AUTH_CONFIGURATION' });
    const state = base64Url(this.randomBytes(32));
    const pkce = createPkce(this.randomBytes);
    const code = await this._waitForCallback(state, async () => {
      const url = new URL(DISCORD_AUTHORIZE_URL);
      url.search = new URLSearchParams({
        response_type: 'code', client_id: clientId, scope: DISCORD_SCOPES.join(' '),
        redirect_uri: DISCORD_REDIRECT_URI, state, prompt: 'consent', code_challenge: pkce.challenge, code_challenge_method: 'S256',
      }).toString();
      await this.openExternal(url.toString());
    });
    return (await this._token({ grant_type: 'authorization_code', code, redirect_uri: DISCORD_REDIRECT_URI, code_verifier: pkce.verifier })).accessToken;
  }

  _waitForCallback(expectedState, started) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { server.close(); } catch (closeError) {}
        if (error) reject(error); else resolve(code);
      };
      const server = this.createServer((req, res) => {
        if (req.method && req.method !== 'GET') { res.writeHead(405); res.end(); return; }
        let url;
        try { url = new URL(req.url, DISCORD_REDIRECT_URI); } catch (error) { res.writeHead(400); res.end('Invalid callback.'); return; }
        if (url.pathname !== DISCORD_CALLBACK_PATH) { res.writeHead(404); res.end(); return; }
        const state = url.searchParams.get('state');
        const code = url.searchParams.get('code');
        const oauthError = url.searchParams.get('error');
        if (!secureEqual(state, expectedState)) { res.writeHead(400); res.end('Authorization state did not match.'); finish(Object.assign(new Error('Discord OAuth state validation failed'), { code: 'DISCORD_AUTH_STATE' })); return; }
        if (oauthError || !code) { res.writeHead(400); res.end('Discord authorization was not completed.'); finish(Object.assign(new Error('Discord authorization was not completed'), { code: 'DISCORD_AUTH_FAILED' })); return; }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Discord authorization complete. You can close this window.');
        finish(null, code);
      });
      const timer = setTimeout(() => finish(Object.assign(new Error('Discord authorization timed out'), { code: 'DISCORD_AUTH_TIMEOUT' })), this.callbackTimeoutMs);
      server.once('error', error => finish(Object.assign(new Error('Discord callback listener could not start'), { code: 'DISCORD_AUTH_CALLBACK', cause: error })));
      // Discord requires an exact registered redirect URI. The currently registered
      // http://127.0.0.1/callback URI therefore means port 80; changing to an ephemeral
      // or high port also requires changing the Developer Portal redirect first.
      server.listen(DISCORD_CALLBACK_PORT, DISCORD_CALLBACK_HOST, async () => {
        try { await started(); } catch (error) { finish(Object.assign(new Error('Discord authorization page could not be opened'), { code: 'DISCORD_AUTH_BROWSER', cause: error })); }
      });
    });
  }

  async _token(grant) {
    const clientId = String(this.getClientId() || '');
    if (!clientId) throw Object.assign(new Error('Discord Application ID is not configured'), { code: 'DISCORD_AUTH_CONFIGURATION' });
    const response = await this.fetch(DISCORD_TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: formBody(Object.assign({ client_id: clientId }, grant)),
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch (error) { data = {}; }
    if (!response.ok || !data.access_token) throw Object.assign(new Error(data.error_description || 'Discord token exchange failed'), { code: 'DISCORD_AUTH_FAILED' });
    const previous = this.getTokens() || {};
    const tokens = {
      accessToken: data.access_token, refreshToken: data.refresh_token || previous.refreshToken || '',
      expiresAt: this.now() + Math.max(0, Number(data.expires_in || 3600)) * 1000,
      scope: data.scope || DISCORD_SCOPES.join(' '), tokenType: data.token_type || 'Bearer',
    };
    this.setTokens(tokens);
    return tokens;
  }
}

module.exports = { DiscordOAuth, DISCORD_AUTHORIZE_URL, DISCORD_CALLBACK_HOST, DISCORD_CALLBACK_PATH, DISCORD_CALLBACK_PORT, DISCORD_SCOPES, DISCORD_TOKEN_URL, DISCORD_REDIRECT_URI, createPkce, grantedScopes, hasRequiredScopes, secureEqual };
