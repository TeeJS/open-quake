'use strict';

const REDIRECT_URI = 'http://localhost:5173/oauth/callback';
const MICROSOFT_CLIENT_ID = '1b171d2e-040f-4e4c-b841-dbb1eb8023c7';

const providers = {
  microsoft: {
    id: 'microsoft',
    name: 'Microsoft 365',
    clientId: MICROSOFT_CLIENT_ID,
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    revokeUrl: '',
    scopes: ['User.Read', 'offline_access'],
    suggestedScopes: ['User.Read', 'Presence.Read', 'Calendars.Read', 'offline_access'],
    redirectUri: REDIRECT_URI,
    usesPkce: true,
    accessTokenExpiresSkewMs: 5 * 60 * 1000,
  },
  github: {
    id: 'github',
    name: 'GitHub',
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    revokeUrl: '',
    scopes: ['read:user'],
    redirectUri: REDIRECT_URI,
    usesPkce: true,
    accessTokenExpiresSkewMs: 5 * 60 * 1000,
  },
  google: {
    id: 'google',
    name: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    scopes: ['openid', 'email', 'profile'],
    redirectUri: REDIRECT_URI,
    usesPkce: true,
    accessTokenExpiresSkewMs: 5 * 60 * 1000,
  },
};

const aliases = {
  teams: 'microsoft',
  office: 'microsoft',
  graph: 'microsoft',
};

function providerFor(id) {
  const key = String(id || '').toLowerCase();
  return providers[aliases[key] || key] || null;
}

function canonicalProviderId(id) {
  const provider = providerFor(id);
  return provider ? provider.id : String(id || '').toLowerCase();
}

module.exports = { MICROSOFT_CLIENT_ID, REDIRECT_URI, providers, providerFor, canonicalProviderId };
