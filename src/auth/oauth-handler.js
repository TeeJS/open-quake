'use strict';

const http = require('http');
const crypto = require('crypto');
const { providerFor } = require('./providers');

function base64Url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function formBody(obj) {
  const params = new URLSearchParams();
  Object.entries(obj || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  });
  return params;
}

function scopeList(scopes) {
  if (Array.isArray(scopes)) return scopes.map(s => String(s || '').trim()).filter(Boolean);
  if (typeof scopes === 'string') return scopes.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  return [];
}

function uniqueScopes(scopes) {
  return Array.from(new Set(scopeList(scopes)));
}

function scopesFor(provider, requested) {
  return uniqueScopes([].concat(provider.scopes || [], scopeList(requested)));
}

function tokenScopes(tokens) {
  return uniqueScopes(tokens && tokens.scope || []);
}

function comparableScope(scope) {
  const s = String(scope || '').toLowerCase();
  return s && s !== 'offline_access' && s !== 'openid' && s !== 'profile';
}

function hasScopes(tokens, requested) {
  const have = new Set(tokenScopes(tokens).map(s => s.toLowerCase()));
  return scopeList(requested).filter(comparableScope).every(s => have.has(s.toLowerCase()));
}

class OAuthHandler {
  constructor({ storage, openExternal, log = () => {} }) {
    this.storage = storage;
    this.openExternal = openExternal;
    this.log = log;
    this.pending = new Map();
    this.callbackServer = null;
    this.refreshTimers = new Map();
  }

  provider(id) {
    const provider = providerFor(id);
    if (!provider) throw new Error('Unknown OAuth provider: ' + id);
    return provider;
  }

  async generateAuthUrl(providerId, requestedScopes) {
    const provider = this.provider(providerId);
    const settings = this.storage.getProviderSettings(provider.id);
    const clientId = provider.clientId || settings.clientId;
    if (!clientId) throw new Error(provider.name + ' client ID is required');
    const requested = scopesFor(provider, requestedScopes);
    const state = base64Url(crypto.randomBytes(24));
    const verifier = base64Url(crypto.randomBytes(48));
    const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
    this.pending.set(state, { providerId: provider.id, verifier, scopes: requested, createdAt: Date.now() });

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: provider.redirectUri,
      response_mode: 'query',
      scope: requested.join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    if (provider.id === 'google') params.set('access_type', 'offline');
    if (provider.id === 'google') params.set('prompt', 'consent');
    return provider.authUrl + '?' + params.toString();
  }

  async connect(providerId, requestedScopes) {
    await this.ensureCallbackServer();
    const url = await this.generateAuthUrl(providerId, requestedScopes);
    if (!this.openExternal(url)) throw new Error('Could not open OAuth sign-in URL');
    return { ok: true };
  }

  async handleCallback(urlObj) {
    const state = urlObj.searchParams.get('state') || '';
    const code = urlObj.searchParams.get('code') || '';
    const err = urlObj.searchParams.get('error') || '';
    const pending = this.pending.get(state);
    if (!pending) throw new Error('OAuth state was not recognized');
    this.pending.delete(state);
    if (err) throw new Error(urlObj.searchParams.get('error_description') || err);
    if (!code) throw new Error('OAuth callback did not include an authorization code');

    const provider = this.provider(pending.providerId);
    const settings = this.storage.getProviderSettings(provider.id);
    const token = await this.fetchToken(provider, {
      grant_type: 'authorization_code',
      client_id: provider.clientId || settings.clientId,
      client_secret: settings.clientSecret,
      code,
      redirect_uri: provider.redirectUri,
      code_verifier: pending.verifier,
    });
    this.storage.setTokens(provider.id, this.normalizeToken(provider.id, token, pending.scopes));
    this.scheduleRefresh(provider.id);
    return { ok: true, provider: provider.id };
  }

  async fetchToken(provider, payload) {
    const res = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: formBody(payload),
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { error: text || res.statusText }; }
    if (!res.ok || data.error) {
      throw new Error(data.error_description || data.error || ('Token request failed: HTTP ' + res.status));
    }
    return data;
  }

  normalizeToken(provider, token, requestedScopes) {
    const now = Date.now();
    const expiresIn = Number(token.expires_in || 3600);
    return {
      provider,
      tokenType: token.token_type || 'Bearer',
      accessToken: token.access_token || '',
      refreshToken: token.refresh_token || '',
      expiresAt: now + Math.max(0, expiresIn) * 1000,
      scope: token.scope || scopeList(requestedScopes).join(' '),
    };
  }

  async refreshTokenIfNeeded(providerId, force, requestedScopes) {
    const provider = this.provider(providerId);
    const requested = scopesFor(provider, requestedScopes);
    const tokens = this.storage.getTokens(provider.id);
    if (!tokens || !tokens.refreshToken) return null;
    if (!hasScopes(tokens, requested)) {
      const err = new Error('Additional Microsoft consent is required for: ' + requested.filter(s => !hasScopes(tokens, [s])).join(' '));
      err.code = 'consent_required';
      err.provider = provider.id;
      err.scopes = requested;
      throw err;
    }
    const skew = provider.accessTokenExpiresSkewMs || 300000;
    if (!force && tokens.accessToken && tokens.expiresAt && Date.now() < Number(tokens.expiresAt) - skew) {
      return tokens;
    }
    const settings = this.storage.getProviderSettings(provider.id);
    const next = await this.fetchToken(provider, {
      grant_type: 'refresh_token',
      client_id: provider.clientId || settings.clientId,
      client_secret: settings.clientSecret,
      refresh_token: tokens.refreshToken,
      redirect_uri: provider.redirectUri,
      scope: requested.join(' '),
    });
    const merged = this.normalizeToken(provider.id, Object.assign({}, next, {
      refresh_token: next.refresh_token || tokens.refreshToken,
      scope: next.scope || tokens.scope || '',
    }), requested);
    this.storage.setTokens(provider.id, merged);
    this.scheduleRefresh(provider.id);
    return merged;
  }

  async getValidAccessToken(providerId, requestedScopes) {
    const tokens = await this.refreshTokenIfNeeded(providerId, false, requestedScopes);
    if (!tokens) return null;
    return {
      provider: tokens.provider,
      tokenType: tokens.tokenType || 'Bearer',
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope || '',
      scopes: tokenScopes(tokens),
    };
  }

  async revokeToken(providerId) {
    const provider = this.provider(providerId);
    const tokens = this.storage.getTokens(provider.id);
    if (provider.revokeUrl && tokens && (tokens.refreshToken || tokens.accessToken)) {
      try {
        await fetch(provider.revokeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formBody({ token: tokens.refreshToken || tokens.accessToken }),
        });
      } catch (e) {
        this.log('[oauth] revoke failed: ' + (e.message || e));
      }
    }
    this.clearRefresh(provider.id);
    this.storage.deleteTokens(provider.id);
    return { ok: true };
  }

  status(providerId) {
    return this.storage.status(providerId);
  }

  listStatus() {
    return ['microsoft', 'github', 'google'].map(id => this.status(id));
  }

  scheduleAll() {
    this.listStatus().forEach(s => { if (s.connected) this.scheduleRefresh(s.provider); });
  }

  scheduleRefresh(providerId) {
    this.clearRefresh(providerId);
    const provider = this.provider(providerId);
    const tokens = this.storage.getTokens(provider.id);
    if (!tokens || !tokens.refreshToken || !tokens.expiresAt) return;
    const delay = Math.max(30000, Number(tokens.expiresAt) - Date.now() - (provider.accessTokenExpiresSkewMs || 300000));
    this.refreshTimers.set(provider.id, setTimeout(() => {
      this.refreshTokenIfNeeded(provider.id, true).catch(e => this.log('[oauth] refresh failed for ' + provider.id + ': ' + (e.message || e)));
    }, delay));
  }

  clearRefresh(providerId) {
    const t = this.refreshTimers.get(providerId);
    if (t) clearTimeout(t);
    this.refreshTimers.delete(providerId);
  }

  stop() {
    for (const t of this.refreshTimers.values()) clearTimeout(t);
    this.refreshTimers.clear();
    if (this.callbackServer) {
      try { this.callbackServer.close(); } catch (e) {}
      this.callbackServer = null;
    }
  }

  ensureCallbackServer() {
    if (this.callbackServer) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://localhost:5173');
        if (req.method !== 'GET' || url.pathname !== '/oauth/callback') {
          res.writeHead(404); res.end(); return;
        }
        this.handleCallback(url).then(result => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><meta charset="utf-8"><title>open-quake OAuth</title><body style="font:16px Segoe UI,sans-serif;background:#101820;color:#e8f1fb">Connected. You can close this window.</body>');
          this.log('[oauth] connected ' + result.provider);
        }).catch(e => {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><meta charset="utf-8"><title>open-quake OAuth</title><body style="font:16px Segoe UI,sans-serif;background:#101820;color:#f3b4a5">OAuth failed: ' + String(e.message || e).replace(/[<>&"]/g, '') + '</body>');
          this.log('[oauth] callback failed: ' + (e.message || e));
        });
      });
      server.once('error', err => {
        this.callbackServer = null;
        reject(new Error('Could not listen on localhost:5173 for OAuth callback: ' + (err.message || err)));
      });
      server.listen(5173, '127.0.0.1', () => {
        this.callbackServer = server;
        resolve();
      });
    });
  }
}

module.exports = { OAuthHandler };
