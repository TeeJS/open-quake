'use strict';

const ARM_ORIGIN = 'https://management.azure.com';
const ARM_SCOPE = 'https://management.azure.com/user_impersonation';
const OAUTH_SCOPES = [ARM_SCOPE, 'offline_access'];
const API = Object.freeze({
  subscriptions: '2022-12-01',
  resources: '2021-04-01',
  resourceHealth: '2025-05-01',
  serviceHealth: '2025-05-01',
  alerts: '2019-03-01',
  cost: '2026-06-01',
  appService: '2025-05-01',
  compute: '2025-04-01',
  activity: '2015-04-01',
});

const TTL = Object.freeze({
  subscriptions: 10 * 60 * 1000,
  resources: 60 * 1000,
  health: 60 * 1000,
  webApps: 60 * 1000,
  deployments: 90 * 1000,
  alerts: 60 * 1000,
  cost: 15 * 60 * 1000,
  detail: 30 * 1000,
});

const DEFAULT_CARDS = ['health', 'resources', 'deployments', 'alerts'];
const cache = new Map();
const inFlight = new Map();
let fetchImpl = (...args) => fetch(...args);

class AzureError extends Error {
  constructor(message, code, status, retryAfter) {
    super(message);
    this.code = code || 'azure_error';
    this.status = Number(status || 0);
    this.retryAfter = Number(retryAfter || 0);
  }
}

function cleanText(value, fallback) {
  const text = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (text || fallback || '').slice(0, 300);
}

function publicError(error) {
  if (error instanceof AzureError) {
    return { error: error.message, code: error.code, retryAfter: error.retryAfter || undefined };
  }
  return { error: cleanText(error && error.message, 'Azure request failed'), code: 'azure_error' };
}

function readJsonBody(body) {
  if (!body || !body.length) return {};
  if (body.length > 32 * 1024) throw new AzureError('Request was too large', 'invalid_request', 400);
  try { return JSON.parse(body.toString('utf8')); }
  catch (error) { throw new AzureError('Request body was not valid JSON', 'invalid_request', 400); }
}

function uuid(value) {
  const id = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ? id : '';
}

function subscriptionResourceId(subscriptionId) {
  return '/subscriptions/' + subscriptionId;
}

function resourceGroupFromId(id) {
  const match = /^\/subscriptions\/[^/]+\/resourcegroups\/([^/]+)/i.exec(String(id || ''));
  return match ? decodeURIComponent(match[1]) : '';
}

function resourceBelongsTo(id, subscriptionId) {
  return String(id || '').toLowerCase().startsWith(('/subscriptions/' + subscriptionId + '/').toLowerCase());
}

function portalResourceUrl(resourceId) {
  return 'https://portal.azure.com/#resource' + String(resourceId || '');
}

function portalSubscriptionUrl(subscriptionId) {
  return portalResourceUrl(subscriptionResourceId(subscriptionId) + '/overview');
}

function portalViewUrl(view) {
  const routes = {
    alerts: 'https://portal.azure.com/#view/Microsoft_Azure_Monitoring/AzureMonitoringBrowseBlade/~/alertsV2',
    cost: 'https://portal.azure.com/#view/Microsoft_Azure_CostManagement/Menu/~/costanalysis',
    health: 'https://portal.azure.com/#view/Microsoft_Azure_Health/AzureHealthBrowseBlade/~/serviceIssues',
    deployments: 'https://portal.azure.com/#view/HubsExtension/DeploymentDetailsBlade',
  };
  return routes[view] || 'https://portal.azure.com/';
}

function safeNextLink(value) {
  try {
    const url = new URL(value);
    return url.origin === ARM_ORIGIN && url.protocol === 'https:' ? url.href : '';
  } catch (error) {
    return '';
  }
}

function retryAfterSeconds(headers) {
  const value = Number(headers.get('retry-after') || headers.get('x-ms-ratelimit-microsoft.consumption-retry-after') || 0);
  return Number.isFinite(value) ? Math.max(0, Math.min(3600, value)) : 0;
}

async function azureRequest(token, pathOrUrl, options) {
  const settings = options || {};
  const target = /^https:\/\//i.test(pathOrUrl) ? safeNextLink(pathOrUrl) : ARM_ORIGIN + pathOrUrl;
  if (!target) throw new AzureError('Azure returned an unsafe continuation link', 'invalid_response', 502);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  let response;
  try {
    response = await fetchImpl(target, {
      method: settings.method || 'GET',
      headers: Object.assign({
        Accept: 'application/json',
        Authorization: 'Bearer ' + token,
      }, settings.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      body: settings.body === undefined ? undefined : JSON.stringify(settings.body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error && error.name === 'AbortError') throw new AzureError('Azure did not respond in time', 'timeout', 504);
    throw new AzureError('Azure could not be reached', 'network', 503);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); }
    catch (error) { data = {}; }
  }
  if (!response.ok) {
    const status = response.status;
    const azureCode = cleanText(data && data.error && data.error.code, '');
    if (status === 401) throw new AzureError('Azure sign-in expired. Reconnect this app.', 'unauthorized', status);
    if (status === 403) throw new AzureError('The signed-in account lacks permission for this Azure data.', 'forbidden', status);
    if (status === 429) throw new AzureError('Azure is throttling requests. Cached data is shown where available.', 'throttled', status, retryAfterSeconds(response.headers));
    if (status >= 500) throw new AzureError('Azure is temporarily unavailable.', 'service_unavailable', status, retryAfterSeconds(response.headers));
    const message = cleanText(data && data.error && data.error.message, 'Azure request failed (HTTP ' + status + ')');
    throw new AzureError(message, azureCode || 'azure_error', status);
  }
  return data;
}

async function azurePages(token, path, maxItems) {
  const items = [];
  let next = path;
  let pages = 0;
  const limit = Math.max(1, Number(maxItems || 1000));
  while (next && pages < 8 && items.length < limit) {
    const data = await azureRequest(token, next);
    if (Array.isArray(data.value)) items.push(...data.value.slice(0, limit - items.length));
    next = data.nextLink ? safeNextLink(data.nextLink) : '';
    pages += 1;
  }
  return { value: items, truncated: Boolean(next) };
}

function cacheKey(subscriptionId, name, suffix) {
  return [subscriptionId || 'global', name, suffix || ''].join(':');
}

async function cachedDataset(key, ttl, loader, force) {
  const prior = cache.get(key);
  if (!force && prior && Date.now() - prior.updatedAt < ttl) {
    return { value: prior.value, updatedAt: prior.updatedAt, stale: false, error: null };
  }
  if (inFlight.has(key)) return inFlight.get(key);
  const pending = (async () => {
    try {
      const value = await loader();
      const entry = { value, updatedAt: Date.now() };
      cache.set(key, entry);
      return { value, updatedAt: entry.updatedAt, stale: false, error: null };
    } catch (error) {
      if (prior) return { value: prior.value, updatedAt: prior.updatedAt, stale: true, error: publicError(error) };
      throw error;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, pending);
  return pending;
}

function invalidateSubscription(subscriptionId) {
  const prefix = subscriptionId + ':';
  for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
}

async function accessToken(context) {
  if (!context.oauth) throw new AzureError('This open-quake host does not provide app OAuth.', 'oauth_unavailable', 500);
  const token = await context.oauth.getAccessToken(OAUTH_SCOPES);
  if (!token || !token.accessToken) throw new AzureError('Connect Azure before loading operations data.', 'not_connected', 401);
  return token.accessToken;
}

async function subscriptionsData(token, force) {
  return cachedDataset(cacheKey('', 'subscriptions'), TTL.subscriptions, async () => {
    const data = await azurePages(token, '/subscriptions?api-version=' + API.subscriptions, 250);
    return {
      subscriptions: data.value.map(item => ({
        id: uuid(item.subscriptionId),
        name: cleanText(item.displayName, 'Unnamed subscription'),
        tenantId: uuid(item.tenantId),
        state: cleanText(item.state, 'Unknown'),
      })).filter(item => item.id),
      truncated: data.truncated,
    };
  }, force);
}

async function selectedSubscription(context, token, requestedId, forceSubscriptions) {
  const dataset = await subscriptionsData(token, forceSubscriptions);
  const subscriptions = dataset.value.subscriptions;
  if (!subscriptions.length) throw new AzureError('No Azure subscriptions are available to this account.', 'no_subscriptions', 404);
  const requested = uuid(requestedId);
  const configured = uuid(context.options && context.options.defaultSubscriptionId);
  const chosen = subscriptions.find(item => item.id === requested)
    || subscriptions.find(item => item.id === configured)
    || subscriptions.find(item => item.state.toLowerCase() === 'enabled')
    || subscriptions[0];
  return { subscription: chosen, subscriptions, subscriptionsStale: dataset.stale };
}

function healthResourceId(item) {
  return String(item && item.id || '').replace(/\/providers\/Microsoft\.ResourceHealth\/availabilityStatuses\/current$/i, '');
}

function normalizeHealth(item) {
  const properties = item && item.properties || {};
  return {
    resourceId: healthResourceId(item),
    state: cleanText(properties.availabilityState, 'Unknown'),
    summary: cleanText(properties.summary || properties.detailedStatus, ''),
    reason: cleanText(properties.reasonType, ''),
    occurredAt: properties.occuredTime || properties.occurredTime || null,
  };
}

function eventIsActive(item) {
  const properties = item && item.properties || {};
  const status = cleanText(properties.status, '').toLowerCase();
  if (status) return !['resolved', 'closed', 'inactive'].includes(status);
  const regions = Array.isArray(properties.impact) ? properties.impact : [];
  return regions.some(region => cleanText(region && region.status, '').toLowerCase() !== 'resolved');
}

function normalizeHealthEvent(item) {
  const properties = item && item.properties || {};
  return {
    id: cleanText(item && (item.name || item.id), ''),
    title: cleanText(properties.title || properties.summary || properties.eventType, 'Service health event'),
    type: cleanText(properties.eventType, 'ServiceHealth'),
    level: cleanText(properties.eventLevel || properties.level, 'Informational'),
    status: cleanText(properties.status, eventIsActive(item) ? 'Active' : 'Resolved'),
    updatedAt: properties.lastUpdateTime || properties.impactStartTime || null,
  };
}

async function healthData(token, subscriptionId, force) {
  return cachedDataset(cacheKey(subscriptionId, 'health'), TTL.health, async () => {
    const availabilityPath = subscriptionResourceId(subscriptionId) + '/providers/Microsoft.ResourceHealth/availabilityStatuses?api-version=' + API.resourceHealth;
    const eventsPath = subscriptionResourceId(subscriptionId) + '/providers/Microsoft.ResourceHealth/events?api-version=' + API.serviceHealth;
    const results = await Promise.allSettled([
      azurePages(token, availabilityPath, 1500),
      azurePages(token, eventsPath, 250),
    ]);
    if (results.every(result => result.status === 'rejected')) throw results[0].reason;
    return {
      availability: results[0].status === 'fulfilled' ? results[0].value.value.map(normalizeHealth) : [],
      events: results[1].status === 'fulfilled' ? results[1].value.value.map(normalizeHealthEvent).filter(event => event.status.toLowerCase() !== 'resolved') : [],
      partial: results.flatMap((result, index) => result.status === 'rejected' ? [{ source: index ? 'serviceHealth' : 'resourceHealth', ...publicError(result.reason) }] : []),
    };
  }, force);
}

async function resourcesData(token, subscriptionId, force) {
  return cachedDataset(cacheKey(subscriptionId, 'resources'), TTL.resources, async () => {
    const data = await azurePages(token, subscriptionResourceId(subscriptionId) + '/resources?api-version=' + API.resources, 1500);
    return { resources: data.value, truncated: data.truncated };
  }, force);
}

async function webAppsData(token, subscriptionId, force) {
  return cachedDataset(cacheKey(subscriptionId, 'webApps'), TTL.webApps, async () => {
    const data = await azurePages(token, subscriptionResourceId(subscriptionId) + '/providers/Microsoft.Web/sites?api-version=' + API.appService, 500);
    return { webApps: data.value, truncated: data.truncated };
  }, force);
}

function healthTone(state) {
  const value = String(state || '').toLowerCase();
  if (['available', 'healthy', 'normal', 'running', 'succeeded', 'resolved'].includes(value)) return 'good';
  if (['degraded', 'warning', 'warned', 'unknown', 'informational'].includes(value)) return 'warn';
  if (['unavailable', 'critical', 'error', 'failed', 'stopped', 'fired'].includes(value)) return 'bad';
  return 'neutral';
}

function resourceCategory(resource) {
  const type = String(resource && resource.type || '').toLowerCase();
  const kind = String(resource && resource.kind || '').toLowerCase();
  if (type === 'microsoft.web/sites' && kind.includes('functionapp')) return 'function-apps';
  if (type === 'microsoft.web/sites') return 'app-services';
  if (type === 'microsoft.compute/virtualmachines') return 'virtual-machines';
  if (/^microsoft\.(sql|dbfor|documentdb|cache)\//.test(type) || type.includes('/databases')) return 'databases';
  if (type === 'microsoft.storage/storageaccounts') return 'storage';
  return 'other';
}

function normalizeResources(rawResources, health, webApps) {
  const healthById = new Map((health || []).map(item => [item.resourceId.toLowerCase(), item]));
  const webById = new Map((webApps || []).map(item => [String(item.id || '').toLowerCase(), item]));
  return (rawResources || []).map(item => {
    const id = String(item.id || '');
    const web = webById.get(id.toLowerCase());
    const available = healthById.get(id.toLowerCase());
    const state = cleanText(web && web.properties && web.properties.state, available && available.state || 'Unknown');
    return {
      id,
      name: cleanText(item.name, 'Unnamed resource'),
      type: cleanText(item.type, 'Unknown'),
      kind: cleanText(item.kind || web && web.kind, ''),
      category: resourceCategory(Object.assign({}, item, web || {})),
      resourceGroup: resourceGroupFromId(id),
      location: cleanText(item.location, ''),
      state,
      health: available ? available.state : 'Unknown',
      healthSummary: available ? available.summary : '',
      tone: healthTone(available ? available.state : state),
    };
  });
}

async function combinedResources(token, subscriptionId, force) {
  const results = await Promise.allSettled([
    resourcesData(token, subscriptionId, force),
    healthData(token, subscriptionId, force),
    webAppsData(token, subscriptionId, force),
  ]);
  if (results[0].status === 'rejected') throw results[0].reason;
  const raw = results[0].value;
  const health = results[1].status === 'fulfilled' ? results[1].value : null;
  const web = results[2].status === 'fulfilled' ? results[2].value : null;
  return {
    resources: normalizeResources(raw.value.resources, health && health.value.availability, web && web.value.webApps),
    truncated: raw.value.truncated,
    stale: results.some(result => result.status === 'fulfilled' && result.value.stale),
    updatedAt: Math.min(...results.filter(result => result.status === 'fulfilled').map(result => result.value.updatedAt)),
    partial: results.flatMap((result, index) => result.status === 'rejected' ? [{ source: ['resources', 'health', 'webApps'][index], ...publicError(result.reason) }] : []),
  };
}

function deploymentStatus(item) {
  return cleanText(item && item.status && (item.status.value || item.status.localizedValue), 'Unknown');
}

function normalizeDeployment(item) {
  const resourceId = String(item.resourceId || '');
  const name = resourceId.split('/').filter(Boolean).pop() || cleanText(item.operationName && item.operationName.localizedValue, 'Deployment');
  const status = deploymentStatus(item);
  return {
    id: cleanText(item.eventDataId || item.id || item.operationId, ''),
    operationId: cleanText(item.operationId || item.correlationId, ''),
    resourceId,
    name: cleanText(name, 'Deployment'),
    resourceGroup: cleanText(item.resourceGroupName, resourceGroupFromId(resourceId)),
    status,
    tone: healthTone(status),
    timestamp: item.eventTimestamp || item.submissionTimestamp || null,
    description: cleanText(item.description, ''),
    openUrl: resourceId ? portalResourceUrl(resourceId) : portalViewUrl('deployments'),
  };
}

async function deploymentsData(token, subscriptionId, force) {
  return cachedDataset(cacheKey(subscriptionId, 'deployments'), TTL.deployments, async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
    const filter = "eventTimestamp ge '" + start.toISOString() + "' and eventTimestamp le '" + end.toISOString() + "' and resourceProvider eq 'Microsoft.Resources'";
    const params = new URLSearchParams({
      'api-version': API.activity,
      '$filter': filter,
      '$select': 'correlationId,eventDataId,eventTimestamp,operationId,operationName,resourceGroupName,resourceId,status,submissionTimestamp,description',
    });
    const data = await azurePages(token, subscriptionResourceId(subscriptionId) + '/providers/Microsoft.Insights/eventtypes/management/values?' + params.toString(), 1000);
    const rows = data.value.filter(item => {
      const operation = String(item.operationName && item.operationName.value || '').toLowerCase();
      return operation === 'microsoft.resources/deployments/write' || operation.endsWith('/deployments/write');
    }).sort((a, b) => new Date(b.eventTimestamp || 0) - new Date(a.eventTimestamp || 0));
    const seen = new Set();
    const deployments = [];
    rows.forEach(item => {
      const key = String(item.operationId || item.correlationId || item.resourceId || item.eventDataId || '').toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      deployments.push(normalizeDeployment(item));
    });
    return { deployments: deployments.slice(0, 100), truncated: data.truncated || deployments.length > 100 };
  }, force);
}

function normalizeAlert(item) {
  const properties = item && item.properties || {};
  const essentials = properties.essentials || {};
  const severity = cleanText(essentials.severity || properties.severity, 'Unknown');
  const condition = cleanText(essentials.monitorCondition || properties.monitorCondition, 'Fired');
  const targetId = Array.isArray(essentials.alertTargetIDs) ? essentials.alertTargetIDs[0] : '';
  return {
    id: cleanText(item && (item.id || item.name), ''),
    title: cleanText(essentials.alertRule || item && item.name, 'Azure alert'),
    severity,
    condition,
    state: cleanText(properties.alertState, 'New'),
    firedAt: essentials.startDateTime || essentials.lastModifiedDateTime || null,
    targetId: String(targetId || ''),
    target: cleanText(essentials.targetResource || essentials.targetResourceName, ''),
    tone: /^sev[01]$/i.test(severity) ? 'bad' : /^sev2$/i.test(severity) ? 'warn' : 'neutral',
    openUrl: targetId ? portalResourceUrl(targetId) : portalViewUrl('alerts'),
  };
}

async function alertsData(token, subscriptionId, force) {
  return cachedDataset(cacheKey(subscriptionId, 'alerts'), TTL.alerts, async () => {
    const params = new URLSearchParams({
      'api-version': API.alerts,
      monitorCondition: 'Fired',
      timeRange: '30d',
      pageCount: '100',
      sortBy: 'lastModifiedDateTime',
      sortOrder: 'desc',
    });
    const data = await azurePages(token, subscriptionResourceId(subscriptionId) + '/providers/Microsoft.AlertsManagement/alerts?' + params.toString(), 250);
    return { alerts: data.value.map(normalizeAlert), truncated: data.truncated };
  }, force);
}

function parseCost(data) {
  const properties = data && data.properties || {};
  const columns = Array.isArray(properties.columns) ? properties.columns.map(column => String(column.name || '')) : [];
  const rows = Array.isArray(properties.rows) ? properties.rows : [];
  const costIndex = columns.findIndex(name => /^(PreTaxCost|Cost|totalCost)$/i.test(name));
  const currencyIndex = columns.findIndex(name => /^Currency$/i.test(name));
  const byCurrency = new Map();
  rows.forEach(row => {
    const currency = cleanText(row[currencyIndex], 'USD');
    const amount = Number(row[costIndex]);
    if (Number.isFinite(amount)) byCurrency.set(currency, (byCurrency.get(currency) || 0) + amount);
  });
  return {
    totals: Array.from(byCurrency, ([currency, amount]) => ({ currency, amount })),
    supported: costIndex >= 0,
  };
}

async function costData(token, subscriptionId, force) {
  return cachedDataset(cacheKey(subscriptionId, 'cost'), TTL.cost, async () => {
    const body = {
      type: 'Usage',
      timeframe: 'MonthToDate',
      dataset: {
        granularity: 'None',
        aggregation: { totalCost: { name: 'PreTaxCost', function: 'Sum' } },
        grouping: [{ type: 'Dimension', name: 'Currency' }],
      },
    };
    const data = await azureRequest(token, subscriptionResourceId(subscriptionId) + '/providers/Microsoft.CostManagement/query?api-version=' + API.cost, { method: 'POST', body });
    return parseCost(data);
  }, force);
}

function countStates(resources) {
  const result = { total: resources.length, healthy: 0, degraded: 0, unavailable: 0, stopped: 0, unknown: 0 };
  resources.forEach(resource => {
    const state = String(resource.health || resource.state || '').toLowerCase();
    if (state === 'available' || state === 'healthy' || state === 'normal' || state === 'running') result.healthy += 1;
    else if (state === 'degraded' || state === 'warning') result.degraded += 1;
    else if (state === 'unavailable' || state === 'critical' || state === 'error') result.unavailable += 1;
    else result.unknown += 1;
    if (String(resource.state || '').toLowerCase() === 'stopped') result.stopped += 1;
  });
  return result;
}

function resourceCard(type, title, emptyLabel) {
  return {
    title,
    view: 'resources',
    category: type,
    load: env => combinedResources(env.token, env.subscriptionId, env.force),
    format(dataset) {
      const resources = dataset.resources.filter(resource => resource.category === type);
      const counts = countStates(resources);
      const attention = counts.degraded + counts.unavailable;
      return {
        primary: counts.total + ' ' + (counts.total === 1 ? 'resource' : 'resources'),
        status: counts.total === 0 ? emptyLabel : attention ? 'Attention required' : 'Ready',
        tone: attention ? (counts.unavailable ? 'bad' : 'warn') : counts.total ? 'good' : 'neutral',
        lines: [counts.healthy + ' healthy', counts.stopped ? counts.stopped + ' stopped' : attention + ' degraded/unavailable'],
        actionLabel: 'Browse',
      };
    },
  };
}

const CARD_DEFINITIONS = {
  health: {
    title: 'Health', view: 'health',
    load: env => healthData(env.token, env.subscriptionId, env.force),
    format(dataset) {
      const states = dataset.value.availability.map(item => item.state.toLowerCase());
      const unavailable = states.filter(state => state === 'unavailable').length;
      const degraded = states.filter(state => state === 'degraded').length;
      const incidents = dataset.value.events.length;
      const tone = unavailable || incidents ? 'bad' : degraded ? 'warn' : 'good';
      return {
        primary: tone === 'good' ? 'Healthy' : tone === 'warn' ? 'Degraded' : 'Incident',
        status: incidents ? incidents + ' active service ' + (incidents === 1 ? 'event' : 'events') : 'No active incidents',
        tone,
        lines: [degraded + ' degraded resources', unavailable + ' unavailable resources'],
        actionLabel: 'Details',
      };
    },
  },
  resources: {
    title: 'Resources', view: 'resources',
    load: env => combinedResources(env.token, env.subscriptionId, env.force),
    format(dataset) {
      const counts = countStates(dataset.resources);
      return {
        primary: counts.total + ' total',
        status: counts.unavailable ? counts.unavailable + ' unavailable' : counts.degraded ? counts.degraded + ' degraded' : 'Inventory ready',
        tone: counts.unavailable ? 'bad' : counts.degraded ? 'warn' : 'good',
        lines: [counts.healthy + ' healthy', counts.stopped ? counts.stopped + ' stopped' : counts.unknown + ' without health data'],
        actionLabel: 'Browse',
      };
    },
  },
  deployments: {
    title: 'Deployments', view: 'deployments',
    load: env => deploymentsData(env.token, env.subscriptionId, env.force),
    format(dataset) {
      const rows = dataset.value.deployments;
      const running = rows.filter(item => /started|progress|accepted/i.test(item.status)).length;
      const failed = rows.filter(item => /fail|error|cancel/i.test(item.status)).length;
      const successful = rows.filter(item => /succeed|success/i.test(item.status)).length;
      return {
        primary: running ? running + ' running' : failed ? failed + ' failed' : successful + ' successful',
        status: rows[0] ? rows[0].name : 'No recent ARM deployments',
        tone: failed ? 'bad' : running ? 'info' : successful ? 'good' : 'neutral',
        lines: [successful + ' successful', failed + ' failed in 7 days'],
        actionLabel: 'View',
      };
    },
  },
  alerts: {
    title: 'Alerts', view: 'alerts',
    load: env => alertsData(env.token, env.subscriptionId, env.force),
    format(dataset) {
      const rows = dataset.value.alerts;
      const severe = rows.filter(item => /^sev[01]$/i.test(item.severity)).length;
      return {
        primary: rows.length + ' active',
        status: severe ? severe + ' high severity' : rows.length ? 'Review active alerts' : 'No active alerts',
        tone: severe ? 'bad' : rows.length ? 'warn' : 'good',
        lines: [rows.filter(item => /^sev0$/i.test(item.severity)).length + ' critical', rows.filter(item => /^sev1$/i.test(item.severity)).length + ' error'],
        actionLabel: 'View',
      };
    },
  },
  cost: {
    title: 'Cost', view: 'cost',
    load: env => costData(env.token, env.subscriptionId, env.force),
    format(dataset) {
      const totals = dataset.value.totals;
      const first = totals[0];
      const value = first ? new Intl.NumberFormat('en', { style: 'currency', currency: first.currency, maximumFractionDigits: 0 }).format(first.amount) : 'No cost data';
      return {
        primary: value,
        status: first ? 'Month to date' : 'Unavailable for this subscription',
        tone: 'info',
        lines: [totals.length > 1 ? totals.length + ' billing currencies' : (first ? first.currency : 'Permission may be required'), 'Actual cost, not forecast'],
        actionLabel: 'Details',
      };
    },
  },
  'app-services': resourceCard('app-services', 'App Services', 'No App Services'),
  'function-apps': resourceCard('function-apps', 'Function Apps', 'No Function Apps'),
  'virtual-machines': resourceCard('virtual-machines', 'Virtual Machines', 'No virtual machines'),
  databases: resourceCard('databases', 'Databases', 'No databases'),
  storage: resourceCard('storage', 'Storage', 'No storage accounts'),
};

function configuredCards(options) {
  return DEFAULT_CARDS.map((fallback, index) => {
    const value = String(options && options['card' + (index + 1)] || fallback);
    return CARD_DEFINITIONS[value] ? value : fallback;
  });
}

async function overview(context, token, subscription, force) {
  const types = configuredCards(context.options);
  const env = { token, subscriptionId: subscription.id, force };
  const loaded = new Map();
  await Promise.all(Array.from(new Set(types)).map(async type => {
    try { loaded.set(type, { dataset: await CARD_DEFINITIONS[type].load(env) }); }
    catch (error) { loaded.set(type, { error: publicError(error) }); }
  }));
  const cards = types.map(type => {
    const definition = CARD_DEFINITIONS[type];
    const result = loaded.get(type);
    if (result.error) {
      return { type, title: definition.title, view: definition.view, category: definition.category || '', primary: 'Unavailable', status: result.error.error, tone: 'bad', lines: ['Tap to retry', result.error.code], actionLabel: 'View', stale: false, error: result.error };
    }
    const summary = definition.format(result.dataset);
    return Object.assign({ type, title: definition.title, view: definition.view, category: definition.category || '', stale: Boolean(result.dataset.stale), error: result.dataset.error || null }, summary);
  });
  const timestamps = Array.from(loaded.values()).flatMap(result => result.dataset && result.dataset.updatedAt ? [result.dataset.updatedAt] : []);
  return {
    cards,
    updatedAt: timestamps.length ? Math.min(...timestamps) : Date.now(),
    stale: cards.some(card => card.stale),
    partial: cards.flatMap(card => card.error ? [{ source: card.type, ...card.error }] : []),
  };
}

function actionDefinition(resource, powerState) {
  const type = String(resource.type || '').toLowerCase();
  const state = String(powerState || resource.state || '').toLowerCase();
  if (type === 'microsoft.web/sites') {
    if (state === 'stopped') return [{ id: 'start', label: 'Start', tone: 'good', confirm: true }];
    if (state === 'running') return [
      { id: 'restart', label: 'Restart', tone: 'warn', confirm: true },
      { id: 'stop', label: 'Stop', tone: 'bad', confirm: true },
    ];
  }
  if (type === 'microsoft.compute/virtualmachines') {
    if (/deallocated|stopped/.test(state)) return [{ id: 'start', label: 'Start', tone: 'good', confirm: true }];
    if (/running/.test(state)) return [
      { id: 'restart', label: 'Restart', tone: 'warn', confirm: true },
      { id: 'deallocate', label: 'Deallocate', tone: 'bad', confirm: true },
    ];
  }
  return [];
}

function vmPowerState(data) {
  const statuses = Array.isArray(data && data.statuses) ? data.statuses : [];
  const power = statuses.find(status => /^PowerState\//i.test(status && status.code || ''));
  return power ? cleanText(power.displayStatus || String(power.code).split('/').pop(), 'Unknown') : 'Unknown';
}

async function resourceDetailData(token, subscriptionId, resource, force) {
  return cachedDataset(cacheKey(subscriptionId, 'detail', resource.id.toLowerCase()), TTL.detail, async () => {
    const type = resource.type.toLowerCase();
    const results = await Promise.allSettled([
      azureRequest(token, resource.id + '/providers/Microsoft.ResourceHealth/availabilityStatuses/current?api-version=' + API.resourceHealth),
      type === 'microsoft.compute/virtualmachines'
        ? azureRequest(token, resource.id + '/instanceView?api-version=' + API.compute)
        : type === 'microsoft.web/sites'
          ? azureRequest(token, resource.id + '?api-version=' + API.appService)
          : Promise.resolve(null),
    ]);
    const health = results[0].status === 'fulfilled' ? normalizeHealth(results[0].value) : null;
    const specific = results[1].status === 'fulfilled' ? results[1].value : null;
    const state = type === 'microsoft.compute/virtualmachines'
      ? vmPowerState(specific)
      : cleanText(specific && specific.properties && specific.properties.state, resource.state);
    return {
      resource: Object.assign({}, resource, { state, health: health ? health.state : resource.health, healthSummary: health ? health.summary : resource.healthSummary }),
      actions: actionDefinition(resource, state),
      partial: results.flatMap((result, index) => result.status === 'rejected' ? [{ source: index ? 'resourceStatus' : 'resourceHealth', ...publicError(result.reason) }] : []),
    };
  }, force);
}

async function getResource(context, token, subscription, resourceId, force) {
  if (!resourceBelongsTo(resourceId, subscription.id)) throw new AzureError('Resource does not belong to the selected subscription.', 'invalid_resource', 400);
  const inventory = await combinedResources(token, subscription.id, force);
  const resource = inventory.resources.find(item => item.id.toLowerCase() === String(resourceId).toLowerCase());
  if (!resource) throw new AzureError('Resource was not found in the selected subscription.', 'not_found', 404);
  return resource;
}

async function performResourceAction(context, token, subscription, body) {
  const resourceId = String(body.resourceId || '');
  const operation = String(body.operation || '').toLowerCase();
  const resource = await getResource(context, token, subscription, resourceId, true);
  const detail = await resourceDetailData(token, subscription.id, resource, true);
  const allowed = detail.value.actions.some(action => action.id === operation);
  if (!allowed) throw new AzureError('That action is not valid for the resource in its current state.', 'invalid_action', 409);
  const type = resource.type.toLowerCase();
  let version;
  if (type === 'microsoft.web/sites') version = API.appService;
  else if (type === 'microsoft.compute/virtualmachines') version = API.compute;
  else throw new AzureError('This resource type has no supported actions.', 'unsupported_action', 400);
  await azureRequest(token, resource.id + '/' + operation + '?api-version=' + version, { method: 'POST' });
  invalidateSubscription(subscription.id);
  return { ok: true, accepted: true, operation, resource: resource.name };
}

async function openTrustedAzure(url) {
  let target;
  try { target = new URL(String(url || '')); }
  catch (error) { throw new AzureError('Open in Azure received an invalid URL.', 'invalid_url', 400); }
  if (target.protocol !== 'https:' || target.hostname !== 'portal.azure.com') throw new AzureError('Only trusted Azure Portal links can be opened.', 'invalid_url', 400);
  const { shell } = require('electron');
  await shell.openExternal(target.href);
  return { ok: true };
}

async function handleAction(action, context) {
  const query = context.query || {};
  if (action === 'auth-status') {
    const status = context.oauth ? context.oauth.status() : { configured: false, connected: false, scopes: [] };
    return {
      ok: true,
      configured: Boolean(context.options && context.options.oauthClientId),
      connected: Boolean(status.connected),
      scopes: Array.isArray(status.scopes) ? status.scopes.filter(scope => scope !== 'offline_access') : [],
    };
  }
  if (action === 'connect') {
    if (!context.oauth) throw new AzureError('This open-quake host does not provide app OAuth.', 'oauth_unavailable', 500);
    const clientId = cleanText(context.options && context.options.oauthClientId, '');
    if (!clientId) throw new AzureError('Set the Microsoft Entra application client ID in app settings first.', 'not_configured', 400);
    const result = await context.oauth.connect(OAUTH_SCOPES, {
      clientId,
      clientSecret: String(context.options && context.options.oauthClientSecret || ''),
    });
    return { ok: Boolean(result && result.ok), pending: true };
  }
  if (action === 'disconnect') {
    if (!context.oauth) throw new AzureError('This open-quake host does not provide app OAuth.', 'oauth_unavailable', 500);
    cache.clear();
    await context.oauth.disconnect();
    return { ok: true };
  }
  if (action === 'open') return openTrustedAzure(query.url);

  const token = await accessToken(context);
  if (action === 'subscriptions') {
    const resolved = await selectedSubscription(context, token, query.subscription, query.refresh === '1');
    return { ok: true, subscriptions: resolved.subscriptions, selected: resolved.subscription, stale: resolved.subscriptionsStale };
  }
  const resolved = await selectedSubscription(context, token, query.subscription, false);
  const subscription = resolved.subscription;
  const force = query.refresh === '1';
  const base = { ok: true, subscription };

  if (action === 'overview') return Object.assign(base, await overview(context, token, subscription, force));
  if (action === 'resources') {
    const data = await combinedResources(token, subscription.id, force);
    const category = String(query.category || 'all');
    const rows = category === 'all' ? data.resources : data.resources.filter(resource => resource.category === category);
    return Object.assign(base, { resources: rows, category, truncated: data.truncated, stale: data.stale, updatedAt: data.updatedAt, partial: data.partial });
  }
  if (action === 'resource-detail') {
    const resource = await getResource(context, token, subscription, query.resourceId, false);
    const detail = await resourceDetailData(token, subscription.id, resource, force);
    return Object.assign(base, detail.value, { stale: detail.stale, updatedAt: detail.updatedAt, openUrl: portalResourceUrl(resource.id) });
  }
  if (action === 'resource-action') return performResourceAction(context, token, subscription, readJsonBody(context.body));
  if (action === 'deployments') {
    const data = await deploymentsData(token, subscription.id, force);
    return Object.assign(base, data.value, { stale: data.stale, updatedAt: data.updatedAt, openUrl: portalViewUrl('deployments') });
  }
  if (action === 'alerts') {
    const data = await alertsData(token, subscription.id, force);
    return Object.assign(base, data.value, { stale: data.stale, updatedAt: data.updatedAt, openUrl: portalViewUrl('alerts') });
  }
  if (action === 'health') {
    const data = await healthData(token, subscription.id, force);
    return Object.assign(base, data.value, { stale: data.stale, updatedAt: data.updatedAt, openUrl: portalViewUrl('health') });
  }
  if (action === 'cost') {
    const data = await costData(token, subscription.id, force);
    return Object.assign(base, data.value, { stale: data.stale, updatedAt: data.updatedAt, openUrl: portalViewUrl('cost') });
  }
  if (action === 'portal-link') return Object.assign(base, { url: portalSubscriptionUrl(subscription.id) });
  return { ok: false, error: 'unknown action' };
}

async function handle(action, context) {
  try { return await handleAction(String(action || ''), context || {}); }
  catch (error) { return Object.assign({ ok: false }, publicError(error)); }
}

module.exports = {
  handle,
  _test: {
    API,
    ARM_SCOPE,
    OAUTH_SCOPES,
    CARD_DEFINITIONS,
    cache,
    inFlight,
    configuredCards,
    normalizeResources,
    parseCost,
    setFetchImpl(value) { fetchImpl = value; },
    reset() { cache.clear(); inFlight.clear(); fetchImpl = (...args) => fetch(...args); },
  },
};
