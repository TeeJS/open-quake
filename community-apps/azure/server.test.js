'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const server = require('./server');

const SUB_A = '11111111-1111-1111-1111-111111111111';
const SUB_B = '22222222-2222-2222-2222-222222222222';
const TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TOKEN = 'synthetic-access-token-must-not-leak';
const SECRET = 'synthetic-client-secret-must-not-leak';

function response(status, data, headers) {
  const values = Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: key => values[String(key).toLowerCase()] || null },
    text: async () => data === undefined || data === null ? '' : JSON.stringify(data),
  };
}

function oauth(overrides) {
  return Object.assign({
    status: () => ({ connected: true, configured: true, scopes: server._test.OAUTH_SCOPES }),
    connect: async () => ({ ok: true }),
    disconnect: async () => ({ ok: true }),
    getAccessToken: async () => ({ accessToken: TOKEN, scopes: server._test.OAUTH_SCOPES }),
  }, overrides || {});
}

function context(options, extra) {
  return Object.assign({
    query: {},
    options: Object.assign({ oauthClientId: 'client-id', oauthClientSecret: SECRET }, options || {}),
    body: null,
    oauth: oauth(),
  }, extra || {});
}

function subscriptionPayload() {
  return { value: [
    { subscriptionId: SUB_A, displayName: 'Alpha', tenantId: TENANT, state: 'Enabled' },
    { subscriptionId: SUB_B, displayName: 'Beta', tenantId: TENANT, state: 'Enabled' },
  ] };
}

function resource(subscriptionId, suffix, type, kind) {
  return {
    id: `/subscriptions/${subscriptionId}/resourceGroups/ops/providers/${type}/${suffix}`,
    name: suffix,
    type,
    kind: kind || '',
    location: 'uksouth',
  };
}

function standardFetch(calls, controls) {
  const settings = controls || {};
  return async (url, options) => {
    calls.push({ url, options: options || {} });
    const parsed = new URL(url);
    if (parsed.pathname === '/subscriptions') return response(200, subscriptionPayload());
    const sub = parsed.pathname.toLowerCase().includes(SUB_B) ? SUB_B : SUB_A;
    if (/\/resources$/i.test(parsed.pathname)) {
      if (settings.failResources) return response(503, { error: { code: 'ServiceUnavailable', message: 'synthetic outage' } });
      return response(200, { value: [resource(sub, sub === SUB_A ? 'alpha-vm' : 'beta-store', sub === SUB_A ? 'Microsoft.Compute/virtualMachines' : 'Microsoft.Storage/storageAccounts')] });
    }
    if (/Microsoft\.ResourceHealth\/availabilityStatuses$/i.test(parsed.pathname)) return response(200, { value: [] });
    if (/Microsoft\.ResourceHealth\/events$/i.test(parsed.pathname)) return response(200, { value: [] });
    if (/Microsoft\.Web\/sites$/i.test(parsed.pathname)) return response(200, { value: [] });
    if (/Microsoft\.Insights\/eventtypes\/management\/values$/i.test(parsed.pathname)) return response(200, { value: [] });
    if (/Microsoft\.AlertsManagement\/alerts$/i.test(parsed.pathname)) return response(200, { value: [] });
    if (/Microsoft\.CostManagement\/query$/i.test(parsed.pathname)) return response(200, { properties: { columns: [{ name: 'PreTaxCost' }, { name: 'Currency' }], rows: [[42.5, 'GBP']] } });
    if (/availabilityStatuses\/current$/i.test(parsed.pathname)) return response(200, { id: parsed.pathname, properties: { availabilityState: 'Available' } });
    if (/instanceView$/i.test(parsed.pathname)) return response(200, { statuses: [{ code: 'PowerState/deallocated', displayStatus: 'VM deallocated' }] });
    if ((options && options.method) === 'POST') return response(202, {});
    return response(404, { error: { code: 'NotFound', message: 'No test route for ' + parsed.pathname } });
  };
}

test.beforeEach(() => server._test.reset());
test.after(() => server._test.reset());

test('manifest is a served, app-local OAuth integration with four dashboard slots', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'app.json'), 'utf8'));
  assert.equal(manifest.id, 'azure');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(typeof manifest.description, 'string');
  assert.ok(manifest.description.length > 0);
  assert.equal(manifest.served, true);
  assert.equal(manifest.server, 'server.js');
  assert.match(manifest.oauth.authUrl, /^https:\/\/login\.microsoftonline\.com\/organizations\/oauth2\/v2\.0\/authorize$/);
  assert.deepEqual(manifest.oauth.scopes, server._test.OAUTH_SCOPES);
  const slots = manifest.options.filter(option => /^card[1-4]$/.test(option.key));
  assert.equal(slots.length, 4);
  const supported = Object.keys(server._test.CARD_DEFINITIONS).sort();
  slots.forEach(slot => assert.deepEqual(slot.choices.map(choice => choice[0]).sort(), supported));
  assert.equal(manifest.options.find(option => option.key === 'oauthClientSecret').serverOnly, true);
  assert.equal(manifest.options.find(option => option.key === 'oauthClientSecret').type, 'secret');
});

test('overview markup fixes the panel to four equal card columns at 1920 by 480', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
  assert.match(html, /data-view="overview"/);
  assert.match(html, /data-view="resources"/);
  assert.match(html, /data-view="deployments"/);
  assert.match(html, /data-view="alerts"/);
  assert.match(css, /height:480px; display:grid; grid-template-rows:80px 328px 72px/);
  assert.match(css, /\.overview-grid \{[^}]*grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/s);
  assert.doesNotMatch(css, /\.overview-grid[^}]*overflow-x\s*:\s*(auto|scroll)/s);
});

test('connect requests only ARM delegated access and never returns credentials', async () => {
  let received;
  const ctx = context({}, { oauth: oauth({
    connect: async (scopes, credentials) => { received = { scopes, credentials }; return { ok: true, accessToken: TOKEN }; },
  }) });
  const result = await server.handle('connect', ctx);
  assert.deepEqual(received.scopes, server._test.OAUTH_SCOPES);
  assert.equal(received.credentials.clientSecret, SECRET);
  assert.deepEqual(result, { ok: true, pending: true });
  assert.doesNotMatch(JSON.stringify(result), /synthetic-access-token|synthetic-client-secret/);
});

test('configured cards always resolve to exactly four supported card definitions', () => {
  assert.deepEqual(server._test.configuredCards({}), ['health', 'resources', 'deployments', 'alerts']);
  assert.deepEqual(server._test.configuredCards({ card1: 'cost', card2: 'storage', card3: 'invalid', card4: 'function-apps' }), ['cost', 'storage', 'deployments', 'function-apps']);
});

test('every available card type produces a purpose-built summary', () => {
  const combined = { resources: [
    { category: 'resources', health: 'Available', state: 'Running' },
    { category: 'app-services', health: 'Available', state: 'Running' },
    { category: 'function-apps', health: 'Degraded', state: 'Running' },
    { category: 'virtual-machines', health: 'Available', state: 'Unknown' },
    { category: 'databases', health: 'Available', state: 'Unknown' },
    { category: 'storage', health: 'Unavailable', state: 'Unknown' },
  ] };
  const datasets = {
    health: { value: { availability: [{ state: 'Available' }], events: [] } },
    resources: combined,
    deployments: { value: { deployments: [{ name: 'ship', status: 'Succeeded' }] } },
    alerts: { value: { alerts: [{ severity: 'Sev1' }] } },
    cost: { value: { totals: [{ amount: 12.5, currency: 'GBP' }] } },
    'app-services': combined,
    'function-apps': combined,
    'virtual-machines': combined,
    databases: combined,
    storage: combined,
  };
  Object.entries(server._test.CARD_DEFINITIONS).forEach(([type, definition]) => {
    const summary = definition.format(datasets[type]);
    assert.equal(typeof summary.primary, 'string', type);
    assert.equal(typeof summary.status, 'string', type);
    assert.ok(Array.isArray(summary.lines), type);
    assert.equal(typeof definition.view, 'string', type);
  });
});

test('subscription switching isolates inventory and in-flight cache keys', async () => {
  const calls = [];
  server._test.setFetchImpl(standardFetch(calls));
  const alpha = await server.handle('resources', context({}, { query: { subscription: SUB_A } }));
  const beta = await server.handle('resources', context({}, { query: { subscription: SUB_B } }));
  assert.equal(alpha.subscription.id, SUB_A);
  assert.equal(alpha.resources[0].name, 'alpha-vm');
  assert.equal(beta.subscription.id, SUB_B);
  assert.equal(beta.resources[0].name, 'beta-store');
  assert.ok(calls.some(call => call.url.includes('/subscriptions/' + SUB_A + '/resources')));
  assert.ok(calls.some(call => call.url.includes('/subscriptions/' + SUB_B + '/resources')));
  assert.doesNotMatch(JSON.stringify({ alpha, beta }), /synthetic-access-token|synthetic-client-secret/);
});

test('concurrent resource requests deduplicate Azure calls', async () => {
  const calls = [];
  server._test.setFetchImpl(standardFetch(calls));
  const ctx = context({}, { query: { subscription: SUB_A } });
  const [first, second] = await Promise.all([server.handle('resources', ctx), server.handle('resources', ctx)]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(calls.filter(call => /\/subscriptions\/[^/]+\/resources\?/i.test(call.url)).length, 1);
});

test('transient Azure failures preserve cached resource data and mark it stale', async () => {
  const calls = [];
  const controls = { failResources: false };
  server._test.setFetchImpl(standardFetch(calls, controls));
  const first = await server.handle('resources', context({}, { query: { subscription: SUB_A } }));
  controls.failResources = true;
  const stale = await server.handle('resources', context({}, { query: { subscription: SUB_A, refresh: '1' } }));
  assert.equal(first.resources[0].name, 'alpha-vm');
  assert.equal(stale.resources[0].name, 'alpha-vm');
  assert.equal(stale.stale, true);
});

test('VM detail exposes only state-valid actions and action calls the documented endpoint', async () => {
  const calls = [];
  server._test.setFetchImpl(standardFetch(calls));
  const id = resource(SUB_A, 'alpha-vm', 'Microsoft.Compute/virtualMachines').id;
  const detail = await server.handle('resource-detail', context({}, { query: { subscription: SUB_A, resourceId: id } }));
  assert.deepEqual(detail.actions.map(action => action.id), ['start']);
  const result = await server.handle('resource-action', context({}, {
    query: { subscription: SUB_A },
    body: Buffer.from(JSON.stringify({ resourceId: id, operation: 'start' })),
  }));
  assert.equal(result.ok, true);
  const actionCall = calls.find(call => call.options.method === 'POST' && /\/start\?api-version=2025-04-01$/.test(call.url));
  assert.ok(actionCall);
  assert.equal(actionCall.options.headers.Authorization, 'Bearer ' + TOKEN);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-access-token|synthetic-client-secret/);
});

test('permission failures are renderer-safe and do not expose raw credentials', async () => {
  server._test.setFetchImpl(async url => {
    if (new URL(url).pathname === '/subscriptions') return response(403, { error: { code: 'AuthorizationFailed', message: 'secret=' + TOKEN } });
    return response(500, {});
  });
  const result = await server.handle('subscriptions', context());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'forbidden');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-access-token|synthetic-client-secret|secret=/);
});
