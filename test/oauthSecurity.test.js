'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const sysserver = require('../app/sysserver');
const { OAuthHandler } = require('../src/auth/oauth-handler');
const { MICROSOFT_CLIENT_ID, providerFor } = require('../src/auth/providers');
const { TokenStorage } = require('../src/auth/token-storage');
const { OFFICE_SCOPES, createOfficeGraph } = require('../app/officeGraph');
const { configForRenderer } = require('../app/oauthConfigBoundary');

function request(port, route, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: route,
      headers: Object.assign({ Host: '127.0.0.1:' + port }, headers || {}),
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
  });
}

test.afterEach(() => sysserver.stop());

test('forged native and unrelated served-app requests cannot obtain OAuth credentials', async () => {
  const port = await sysserver.start({ appFolders: { unrelated: { root: process.cwd() } } });
  const forged = await request(port, '/api/oauth-tokens.json?provider=google&scopes=read:user', {
    'Sec-Fetch-Site': 'same-origin',
    Origin: 'http://127.0.0.1:' + port,
  });
  const servedApp = await request(port, '/api/oauth-tokens.json?provider=microsoft&scopes=Calendars.Read', {
    'Sec-Fetch-Site': 'same-origin',
    Referer: 'http://127.0.0.1:' + port + '/apps/unrelated/index.html',
  });
  const oldConnect = await request(port, '/api/oauth-connect?provider=microsoft&scopes=Calendars.Read', {
    'Sec-Fetch-Site': 'same-origin',
  });
  assert.equal(forged.status, 404);
  assert.equal(servedApp.status, 404);
  assert.equal(oldConnect.status, 404);
  assert.doesNotMatch(JSON.stringify([forged.body, servedApp.body, oldConnect.body]), /accessToken|refreshToken/);
});

test('Office operations require and rotate a bounded session capability', async () => {
  let now = 1000;
  let calls = 0;
  const port = await sysserver.start({
    now: () => now,
    officeCapabilityTtlMs: 100,
    getOfficeData: async () => { calls++; return { ok: true, profile: { displayName: 'Example' }, presence: null, events: [] }; },
    connectOffice: async () => ({ ok: true }),
  });
  const first = sysserver.issueOfficeCapability();
  const missing = await request(port, '/api/office/data', { 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(missing.status, 403);
  assert.equal(calls, 0);

  const allowed = await request(port, '/api/office/data?provider=google&scopes=admin', {
    'Sec-Fetch-Site': 'same-origin',
    Authorization: 'Bearer ' + first,
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.ok, true);
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(allowed.body), /accessToken|refreshToken/);
  const second = allowed.headers['x-open-quake-capability'];
  assert.match(second, /^[A-Za-z0-9_-]{43}$/);

  const replay = await request(port, '/api/office/data', {
    'Sec-Fetch-Site': 'same-origin',
    Authorization: 'Bearer ' + first,
  });
  assert.equal(replay.status, 403);
  assert.equal(calls, 1);

  now += 101;
  const expired = await request(port, '/api/office/data', {
    'Sec-Fetch-Site': 'same-origin',
    Authorization: 'Bearer ' + second,
  });
  assert.equal(expired.status, 403);
  assert.equal(calls, 1);
});

test('Office external actions use the host launcher without racing the calendar capability', async () => {
  const opened = [];
  const port = await sysserver.start({
    onOpenExternal: value => { opened.push(value); return true; },
    getOfficeData: async () => ({ ok: true, events: [] }),
  });
  const first = sysserver.issueOfficeCapability();
  const missing = await request(port, '/api/office/open?url=' + encodeURIComponent('https://teams.microsoft.com/v2/'), {
    'Sec-Fetch-Site': 'cross-site',
  });
  assert.equal(missing.status, 403);

  const [allowed, calendar] = await Promise.all([
    request(port, '/api/office/open?url=' + encodeURIComponent('https://teams.microsoft.com/v2/'), {
      'Sec-Fetch-Site': 'same-origin',
    }),
    request(port, '/api/office/data', {
      'Sec-Fetch-Site': 'same-origin',
      Authorization: 'Bearer ' + first,
    }),
  ]);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.ok, true);
  assert.equal(calendar.status, 200);
  assert.equal(calendar.body.ok, true);
  assert.deepEqual(opened, ['https://teams.microsoft.com/v2/']);

  const rejectedScheme = await request(port, '/api/office/open?url=' + encodeURIComponent('file:///C:/Windows/System32/calc.exe'), {
    'Sec-Fetch-Site': 'same-origin',
  });
  assert.equal(rejectedScheme.status, 200);
  assert.equal(rejectedScheme.body.ok, false);
  assert.equal(opened.length, 1);

  const rejectedHost = await request(port, '/api/office/open?url=' + encodeURIComponent('https://example.com/'), {
    'Sec-Fetch-Site': 'same-origin',
  });
  assert.equal(rejectedHost.status, 200);
  assert.equal(rejectedHost.body.ok, false);
  assert.equal(opened.length, 1);
});

test('Office app and keypress actions are fixed host callbacks protected by same-origin checks', async () => {
  const calls = [];
  const port = await sysserver.start({
    onOfficeAction: async (kind, index, shortcutIndex) => { calls.push({ kind, index, shortcutIndex }); return { ok: true }; },
  });
  const crossSite = await request(port, '/api/office/action/app/2', { 'Sec-Fetch-Site': 'cross-site' });
  const appAction = await request(port, '/api/office/action/app/2', { 'Sec-Fetch-Site': 'same-origin' });
  const shortcut = await request(port, '/api/office/action/shortcut/3/1', { 'Sec-Fetch-Site': 'same-origin' });
  const arbitrary = await request(port, '/api/office/action/app/99', { 'Sec-Fetch-Site': 'same-origin' });

  assert.equal(crossSite.status, 403);
  assert.equal(appAction.status, 200);
  assert.equal(appAction.body.ok, true);
  assert.equal(shortcut.body.ok, true);
  assert.equal(arbitrary.body.ok, false);
  assert.deepEqual(calls, [
    { kind: 'app', index: 2, shortcutIndex: undefined },
    { kind: 'shortcut', index: 3, shortcutIndex: 1 },
  ]);
});

test('leaving Office or replacing its session invalidates the previous capability', async () => {
  const port = await sysserver.start({ getOfficeData: async () => ({ ok: true }) });
  const oldCapability = sysserver.issueOfficeCapability();
  sysserver.setActivePage(null);
  const replacement = sysserver.issueOfficeCapability();
  assert.notEqual(replacement, oldCapability);
  const wrongSession = await request(port, '/api/office/data', {
    'Sec-Fetch-Site': 'same-origin',
    Authorization: 'Bearer ' + oldCapability,
  });
  assert.equal(wrongSession.status, 403);
});

test('Host and cross-site rejection remain fail-closed without consuming a valid capability', async () => {
  let calls = 0;
  const port = await sysserver.start({ getOfficeData: async () => { calls++; return { ok: true }; } });
  const capability = sysserver.issueOfficeCapability();
  const foreignHost = await request(port, '/api/office/data', {
    Host: 'attacker.example',
    'Sec-Fetch-Site': 'same-origin',
    Authorization: 'Bearer ' + capability,
  });
  const crossSite = await request(port, '/api/office/data', {
    'Sec-Fetch-Site': 'cross-site',
    Authorization: 'Bearer ' + capability,
  });
  const allowed = await request(port, '/api/office/data', {
    'Sec-Fetch-Site': 'same-origin',
    Authorization: 'Bearer ' + capability,
  });
  assert.equal(foreignHost.status, 403);
  assert.equal(crossSite.status, 403);
  assert.equal(allowed.status, 200);
  assert.equal(calls, 1);
});

test('OAuth access DTO never includes the refresh token', async () => {
  const stored = {
    provider: 'microsoft',
    tokenType: 'Bearer',
    accessToken: 'synthetic-access-value',
    refreshToken: 'synthetic-refresh-value',
    expiresAt: Date.now() + 3600000,
    scope: OFFICE_SCOPES.join(' '),
  };
  const handler = new OAuthHandler({
    storage: {
      getTokens: () => Object.assign({}, stored),
      getProviderSettings: () => ({ clientId: 'public-client' }),
    },
    openExternal: () => false,
  });
  const dto = await handler.getValidAccessToken('microsoft', OFFICE_SCOPES);
  assert.equal(dto.accessToken, stored.accessToken);
  assert.equal(Object.hasOwn(dto, 'refreshToken'), false);
  handler.stop();
});

test('Microsoft OAuth uses the fixed Open-Quake public client ID', async () => {
  const handler = new OAuthHandler({
    storage: { getProviderSettings: () => ({ clientId: 'ignored-user-override' }) },
    openExternal: () => false,
  });
  const url = new URL(await handler.generateAuthUrl('microsoft', OFFICE_SCOPES));

  assert.equal(MICROSOFT_CLIENT_ID, '1b171d2e-040f-4e4c-b841-dbb1eb8023c7');
  assert.equal(providerFor('microsoft').clientId, MICROSOFT_CLIENT_ID);
  assert.equal(url.searchParams.get('client_id'), MICROSOFT_CLIENT_ID);
  handler.stop();
});

test('Microsoft client settings are immutable and legacy overrides are removed', () => {
  let saves = 0;
  const config = {
    settings: { oauth: { providers: { microsoft: { clientId: 'legacy', clientSecret: 'legacy-secret' } }, tokens: {} } },
  };
  const storage = new TokenStorage({ getConfig: () => config, saveConfig: () => { saves += 1; return true; } });

  assert.equal(storage.getProviderSettings('microsoft').clientId, MICROSOFT_CLIENT_ID);
  assert.equal(config.settings.oauth.providers.microsoft, undefined);
  assert.equal(saves, 1);
  assert.throws(() => storage.setProviderSettings('microsoft', { clientId: 'replacement' }), /built into Open-Quake/);
});

test('OAuth refresh rotation remains internal while the access DTO stays minimal', async () => {
  let stored = {
    provider: 'microsoft',
    accessToken: 'expired-synthetic-access',
    refreshToken: 'old-synthetic-refresh',
    expiresAt: 1,
    scope: OFFICE_SCOPES.join(' '),
  };
  const handler = new OAuthHandler({
    storage: {
      getTokens: () => Object.assign({}, stored),
      getProviderSettings: () => ({ clientId: 'public-client' }),
      setTokens: (_provider, next) => { stored = Object.assign({}, next); },
    },
    openExternal: () => false,
  });
  handler.fetchToken = async () => ({
    access_token: 'rotated-synthetic-access',
    refresh_token: 'rotated-synthetic-refresh',
    expires_in: 3600,
    scope: OFFICE_SCOPES.join(' '),
  });
  const dto = await handler.getValidAccessToken('microsoft', OFFICE_SCOPES);
  assert.equal(dto.accessToken, 'rotated-synthetic-access');
  assert.equal(Object.hasOwn(dto, 'refreshToken'), false);
  assert.equal(stored.refreshToken, 'rotated-synthetic-refresh');
  handler.stop();
});

test('Office Graph service fixes provider, scopes, and operations in the main process', async () => {
  const tokenCalls = [];
  const connectCalls = [];
  const graphCalls = [];
  const service = createOfficeGraph({
    getAccessToken: async (provider, scopes) => {
      tokenCalls.push({ provider, scopes: Array.from(scopes) });
      return { accessToken: 'synthetic-access-value' };
    },
    connectOAuth: async (provider, scopes) => connectCalls.push({ provider, scopes: Array.from(scopes) }),
    now: () => new Date('2026-08-11T12:00:00.000Z'),
    fetchImpl: async (url, options) => {
      graphCalls.push({ url, authorization: options.headers.Authorization });
      if (url.endsWith('/me/presence')) return { ok: true, json: async () => ({ availability: 'Available' }) };
      if (url.includes('/calendarView?')) return { ok: true, json: async () => ({ value: [{ subject: 'Example' }] }) };
      return { ok: true, json: async () => ({ displayName: 'Example' }) };
    },
  });
  const result = await service.getData();
  await service.connect();
  assert.deepEqual(tokenCalls, [{ provider: 'microsoft', scopes: Array.from(OFFICE_SCOPES) }]);
  assert.deepEqual(connectCalls, [{ provider: 'microsoft', scopes: Array.from(OFFICE_SCOPES) }]);
  assert.equal(graphCalls.length, 3);
  assert.ok(graphCalls.every(call => call.url.startsWith('https://graph.microsoft.com/v1.0/')));
  assert.ok(graphCalls.every(call => call.authorization === 'Bearer synthetic-access-value'));
  assert.deepEqual(result, {
    ok: true,
    profile: { displayName: 'Example' },
    presence: { availability: 'Available' },
    events: [{
      id: '',
      subject: 'Example',
      start: null,
      end: null,
      startTimeZone: null,
      endTimeZone: null,
      location: '',
      isCancelled: false,
      isAllDay: false,
      showAs: 'busy',
      status: 'busy',
      isOnlineMeeting: false,
      joinUrl: null,
      webLink: null,
    }],
  });
  assert.doesNotMatch(JSON.stringify(result), /accessToken|refreshToken/);
});

test('Office Graph service normalizes meeting metadata needed for reactive calendar states', async () => {
  const service = createOfficeGraph({
    getAccessToken: async () => ({ accessToken: 'synthetic-access-value' }),
    connectOAuth: async () => undefined,
    now: () => new Date('2026-08-11T12:00:00.000Z'),
    fetchImpl: async (url) => {
      if (url.endsWith('/me/presence')) return { ok: true, json: async () => ({ availability: 'inAMeeting', activity: 'inACall' }) };
      if (url.includes('/calendarView?')) return { ok: true, json: async () => ({ value: [{
        id: 'evt-1',
        subject: 'Daily Standup',
        start: { dateTime: '2026-08-11T12:15:00', timeZone: 'UTC' },
        end: { dateTime: '2026-08-11T12:45:00', timeZone: 'UTC' },
        location: { displayName: 'Room 1' },
        isCancelled: false,
        isOnlineMeeting: true,
        onlineMeeting: { joinWebUrl: 'https://teams.microsoft.com/l/meetup-join/abc' },
        webLink: 'https://outlook.office.com/calendar/item/abc',
        showAs: 'busy',
      }] }) };
      return { ok: true, json: async () => ({ displayName: 'Example User', userPrincipalName: 'example@contoso.com' }) };
    },
  });

  const result = await service.getData();
  assert.equal(result.events[0].start, '2026-08-11T12:15:00.000Z');
  assert.equal(result.events[0].end, '2026-08-11T12:45:00.000Z');
  assert.equal(result.events[0].joinUrl, 'https://teams.microsoft.com/l/meetup-join/abc');
  assert.equal(result.events[0].location, 'Room 1');
  assert.equal(result.events[0].status, 'busy');
});

test('preload and Office renderer sources expose no OAuth token getter', () => {
  const root = path.join(__dirname, '..');
  const preload = fs.readFileSync(path.join(root, 'app', 'panel-preload.js'), 'utf8')
    + fs.readFileSync(path.join(root, 'app', 'config-preload.js'), 'utf8');
  const office = fs.readFileSync(path.join(root, 'app', 'office.js'), 'utf8');
  assert.doesNotMatch(preload, /getOAuthTokens|get-oauth-tokens/);
  assert.doesNotMatch(office, /accessToken|refreshToken|graph\.microsoft\.com|oauth-tokens/);
});

test('editor configuration DTO removes OAuth credentials without mutating stored configuration', () => {
  const stored = {
    settings: {
      oauth: {
        providers: { microsoft: { clientId: 'public-client', clientSecret: 'synthetic-client-secret' } },
        tokens: { microsoft: { accessToken: 'synthetic-access-value', refreshToken: 'synthetic-refresh-value' } },
      },
    },
    grids: [],
  };
  const dto = configForRenderer(stored);
  assert.deepEqual(dto.settings.oauth.tokens, {});
  assert.equal(Object.hasOwn(dto.settings.oauth.providers.microsoft, 'clientId'), false);
  assert.equal(Object.hasOwn(dto.settings.oauth.providers.microsoft, 'clientSecret'), false);
  assert.equal(stored.settings.oauth.tokens.microsoft.refreshToken, 'synthetic-refresh-value');
  assert.equal(stored.settings.oauth.providers.microsoft.clientSecret, 'synthetic-client-secret');
});
