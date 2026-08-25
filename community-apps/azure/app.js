'use strict';

const params = new URLSearchParams(location.search);
const refreshMinutes = Math.max(2, Math.min(15, Number(params.get('refreshMinutes') || 5)));
const categories = [
  ['all', 'All'],
  ['app-services', 'App Services'],
  ['function-apps', 'Functions'],
  ['virtual-machines', 'VMs'],
  ['databases', 'Databases'],
  ['storage', 'Storage'],
  ['other', 'Other'],
];

const els = {
  content: document.getElementById('content'),
  subscriptionButton: document.getElementById('subscriptionButton'),
  subscriptionLabel: document.getElementById('subscriptionLabel'),
  tenantLabel: document.getElementById('tenantLabel'),
  refreshState: document.getElementById('refreshState'),
  refreshButton: document.getElementById('refreshButton'),
  openAzureButton: document.getElementById('openAzureButton'),
  toast: document.getElementById('toast'),
  subscriptionOverlay: document.getElementById('subscriptionOverlay'),
  subscriptionList: document.getElementById('subscriptionList'),
  subscriptionClose: document.getElementById('subscriptionClose'),
  confirmOverlay: document.getElementById('confirmOverlay'),
  confirmMessage: document.getElementById('confirmMessage'),
  confirmCancel: document.getElementById('confirmCancel'),
  confirmAccept: document.getElementById('confirmAccept'),
};

const state = {
  configured: false,
  connected: false,
  subscriptions: [],
  subscription: null,
  view: 'overview',
  category: 'all',
  data: null,
  detail: null,
  busy: false,
  generation: 0,
  updatedAt: null,
  stale: false,
  confirmAction: null,
  autoRefresh: null,
};

if (params.get('theme') === 'light') document.body.classList.add('light');

document.querySelectorAll('.bottom-nav [data-view]').forEach(button => {
  button.addEventListener('click', () => navigate(button.dataset.view));
});
els.refreshButton.addEventListener('click', () => loadView(true));
els.subscriptionButton.addEventListener('click', openSubscriptionPicker);
els.subscriptionClose.addEventListener('click', closeSubscriptionPicker);
els.subscriptionOverlay.addEventListener('click', event => { if (event.target === els.subscriptionOverlay) closeSubscriptionPicker(); });
els.openAzureButton.addEventListener('click', openCurrentInAzure);
els.confirmCancel.addEventListener('click', closeConfirm);
els.confirmAccept.addEventListener('click', acceptConfirm);
els.confirmOverlay.addEventListener('click', event => { if (event.target === els.confirmOverlay) closeConfirm(); });

initialize();

async function initialize() {
  renderMessage('Connecting to Azure Operations…', 'Checking the app configuration.');
  try {
    const auth = await api('auth-status');
    state.configured = auth.configured;
    state.connected = auth.connected;
    if (!state.configured) {
      renderConfigurationRequired();
      return;
    }
    if (!state.connected) {
      renderConnect();
      return;
    }
    await loadSubscriptions();
  } catch (error) {
    renderFailure(error, initialize);
  }
}

async function api(action, query, options) {
  const search = new URLSearchParams();
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  });
  const settings = options || {};
  const response = await fetch('/app-api/' + encodeURIComponent(action) + (search.size ? '?' + search.toString() : ''), {
    method: settings.method || 'GET',
    headers: settings.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: settings.body === undefined ? undefined : JSON.stringify(settings.body),
    cache: 'no-store',
  });
  let data;
  try { data = await response.json(); }
  catch (error) { throw makeError('Azure Operations returned an invalid response.', 'invalid_response'); }
  if (!response.ok || !data || data.ok === false) throw makeError(data && data.error || 'Azure request failed.', data && data.code, data && data.retryAfter);
  return data;
}

function makeError(message, code, retryAfter) {
  const error = new Error(message || 'Azure request failed.');
  error.code = code || 'azure_error';
  error.retryAfter = retryAfter;
  return error;
}

async function connect() {
  setBusy(true, 'Opening sign-in…');
  try {
    await api('connect');
    showToast('Complete Microsoft sign-in in your browser.');
    renderMessage('Waiting for Microsoft sign-in…', 'The panel will continue automatically when authorization completes.', '<button id="cancelWait" type="button">Cancel</button>');
    document.getElementById('cancelWait').addEventListener('click', renderConnect);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await delay(2000);
      const auth = await api('auth-status');
      if (auth.connected) {
        state.connected = true;
        await loadSubscriptions();
        return;
      }
    }
    throw makeError('Microsoft sign-in did not complete. Try Connect again.', 'sign_in_timeout');
  } catch (error) {
    renderFailure(error, renderConnect);
  } finally {
    setBusy(false);
  }
}

async function disconnect() {
  closeConfirm();
  setBusy(true, 'Disconnecting…');
  try {
    await api('disconnect');
    state.connected = false;
    state.subscription = null;
    state.subscriptions = [];
    renderConnect();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function loadSubscriptions() {
  const remembered = safeStorageGet('azure.subscription');
  renderMessage('Loading subscriptions…', 'Discovering subscriptions available to this Microsoft account.');
  const data = await api('subscriptions', { subscription: remembered });
  state.subscriptions = data.subscriptions || [];
  if (!state.subscriptions.length) {
    renderMessage('No subscriptions found', 'The signed-in account has no visible Azure subscriptions.', '<button id="disconnectEmpty" type="button">Disconnect</button>');
    document.getElementById('disconnectEmpty').addEventListener('click', confirmDisconnect);
    updateHeader();
    return;
  }
  selectSubscription(data.selected, false);
}

function selectSubscription(subscription, force) {
  if (!subscription) return;
  state.generation += 1;
  state.subscription = subscription;
  state.view = 'overview';
  state.category = 'all';
  state.data = null;
  state.detail = null;
  state.updatedAt = null;
  state.stale = false;
  safeStorageSet('azure.subscription', subscription.id);
  closeSubscriptionPicker();
  updateHeader();
  updateNavigation();
  renderLoading('Switching subscription…');
  loadView(Boolean(force));
  scheduleRefresh();
}

async function loadView(force) {
  if (!state.subscription || state.busy) return;
  const generation = ++state.generation;
  const view = state.view;
  state.busy = true;
  updateHeader(force ? 'Refreshing…' : 'Loading…');
  renderLoading(force ? 'Refreshing Azure data…' : 'Loading ' + view + '…');
  try {
    const query = { subscription: state.subscription.id, refresh: force ? '1' : '' };
    if (view === 'resources') query.category = state.category;
    const data = await api(view, query);
    if (generation !== state.generation || view !== state.view || data.subscription.id !== state.subscription.id) return;
    state.data = data;
    state.detail = null;
    state.updatedAt = data.updatedAt || Date.now();
    state.stale = Boolean(data.stale);
    updateHeader();
    renderView();
  } catch (error) {
    if (generation !== state.generation) return;
    if (error.code === 'unauthorized' || error.code === 'not_connected') {
      state.connected = false;
      renderConnect('Azure authorization expired or was revoked.');
    } else {
      renderFailure(error, () => loadView(true));
    }
  } finally {
    if (generation === state.generation) {
      state.busy = false;
      updateHeader();
    }
  }
}

function navigate(view, category) {
  if (!state.connected || !state.subscription) return;
  const next = ['overview', 'resources', 'deployments', 'alerts', 'health', 'cost'].includes(view) ? view : 'overview';
  state.view = next;
  if (next === 'resources') state.category = category || state.category || 'all';
  state.data = null;
  state.detail = null;
  updateNavigation();
  loadView(false);
}

function renderView() {
  if (!state.data) return;
  if (state.view === 'overview') renderOverview();
  else if (state.view === 'resources') renderResources();
  else if (state.view === 'deployments') renderDeployments();
  else if (state.view === 'alerts') renderAlerts();
  else if (state.view === 'health') renderHealth();
  else if (state.view === 'cost') renderCost();
}

function renderOverview() {
  const cards = Array.isArray(state.data.cards) ? state.data.cards.slice(0, 4) : [];
  while (cards.length < 4) cards.push({ title: 'Unavailable', primary: 'No data', status: 'Card did not load', tone: 'neutral', lines: [], view: 'overview', actionLabel: 'Retry' });
  els.content.innerHTML = '<section class="overview-grid">' + cards.map((card, index) => {
    const lines = (card.lines || []).slice(0, 2).map(line => '<span>' + h(line) + '</span>').join('');
    return '<button class="overview-card tone-' + tone(card.tone) + '" type="button" data-card="' + index + '">' +
      '<span class="card-title">' + h(card.title) + (card.stale ? '<em>Stale</em>' : '') + '</span>' +
      '<strong class="card-primary">' + h(card.primary) + '</strong>' +
      '<span class="card-status">' + statusDot(card.tone) + h(card.status) + '</span>' +
      '<span class="card-lines">' + lines + '</span>' +
      '<span class="card-action">' + h(card.actionLabel || 'View') + ' →</span>' +
    '</button>';
  }).join('') + '</section>';
  els.content.querySelectorAll('[data-card]').forEach(button => {
    button.addEventListener('click', () => {
      const card = cards[Number(button.dataset.card)];
      navigate(card.view || 'overview', card.category || undefined);
    });
  });
}

function renderResources() {
  const rows = state.data.resources || [];
  els.content.innerHTML = '<section class="resource-layout">' +
    '<div class="resource-browser panel"><div class="filter-strip">' + categories.map(([id, label]) => '<button type="button" data-category="' + id + '" class="' + (state.category === id ? 'selected' : '') + '">' + h(label) + '</button>').join('') + '</div>' +
    '<div class="resource-list">' + (rows.length ? rows.map(resourceRow).join('') : emptyInline('No resources in this category')) + '</div></div>' +
    '<aside id="resourceDetail" class="detail-panel panel">' + renderResourceDetail() + '</aside>' +
  '</section>';
  els.content.querySelectorAll('[data-category]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.category === state.category) return;
    state.category = button.dataset.category;
    loadView(false);
  }));
  els.content.querySelectorAll('[data-resource-id]').forEach(button => button.addEventListener('click', () => loadResourceDetail(button.dataset.resourceId)));
  bindDetailActions();
}

function resourceRow(resource) {
  return '<button class="resource-row ' + (state.detail && state.detail.resource.id === resource.id ? 'selected' : '') + '" type="button" data-resource-id="' + attr(resource.id) + '">' +
    '<span class="resource-icon tone-' + tone(resource.tone) + '">' + resourceGlyph(resource.category) + '</span>' +
    '<span class="row-copy"><strong>' + h(resource.name) + '</strong><small>' + h(typeLabel(resource)) + ' · ' + h(resource.resourceGroup || 'Subscription') + '</small></span>' +
    '<span class="row-state tone-text-' + tone(resource.tone) + '">' + h(resource.state || resource.health) + '</span>' +
  '</button>';
}

async function loadResourceDetail(resourceId, force) {
  const generation = state.generation;
  state.detail = { loading: true, resource: { id: resourceId } };
  renderResources();
  try {
    const data = await api('resource-detail', { subscription: state.subscription.id, resourceId, refresh: force ? '1' : '' });
    if (generation !== state.generation || state.view !== 'resources' || data.subscription.id !== state.subscription.id) return;
    state.detail = data;
    renderResources();
  } catch (error) {
    if (generation !== state.generation) return;
    state.detail = { error: error.message, resource: { id: resourceId } };
    renderResources();
  }
}

function renderResourceDetail() {
  const detail = state.detail;
  if (!detail) return '<div class="detail-empty"><strong>Select a resource</strong><span>Tap an item to see status and valid actions.</span></div>';
  if (detail.loading) return '<div class="detail-empty"><span class="spinner"></span><strong>Loading resource…</strong></div>';
  if (detail.error) return '<div class="detail-empty error"><strong>Resource unavailable</strong><span>' + h(detail.error) + '</span></div>';
  const resource = detail.resource;
  const actions = (detail.actions || []).map(action => '<button type="button" data-resource-action="' + attr(action.id) + '" class="action-' + tone(action.tone) + '">' + h(action.label) + '</button>').join('');
  return '<div class="detail-heading"><div><span class="eyebrow">' + h(typeLabel(resource)) + '</span><h2>' + h(resource.name) + '</h2></div><span class="status-pill tone-' + tone(resource.tone) + '">' + h(resource.state) + '</span></div>' +
    '<div class="detail-grid"><span>Health<strong>' + h(resource.health) + '</strong></span><span>Resource group<strong>' + h(resource.resourceGroup || 'Subscription') + '</strong></span><span>Region<strong>' + h(resource.location || 'Global') + '</strong></span></div>' +
    '<p class="detail-summary">' + h(resource.healthSummary || 'No additional health detail is available.') + '</p>' +
    '<div class="detail-actions">' + actions + '<button type="button" data-open-url="' + attr(detail.openUrl) + '">Open in Azure</button></div>';
}

function bindDetailActions() {
  els.content.querySelectorAll('[data-resource-action]').forEach(button => button.addEventListener('click', () => {
    const operation = button.dataset.resourceAction;
    const label = button.textContent.trim();
    confirmDialog(label + ' ' + state.detail.resource.name + '? This changes the live Azure resource.', () => runResourceAction(operation));
  }));
  els.content.querySelectorAll('[data-open-url]').forEach(button => button.addEventListener('click', () => openUrl(button.dataset.openUrl)));
}

async function runResourceAction(operation) {
  const resource = state.detail.resource;
  closeConfirm();
  setBusy(true, 'Sending ' + operation + '…');
  try {
    const result = await api('resource-action', { subscription: state.subscription.id }, { method: 'POST', body: { resourceId: resource.id, operation } });
    showToast(result.operation + ' accepted for ' + result.resource + '.');
    state.busy = false;
    await loadView(true);
    await loadResourceDetail(resource.id, true);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(false);
  }
}

function renderDeployments() {
  const rows = state.data.deployments || [];
  els.content.innerHTML = '<section class="list-view panel"><div class="view-heading"><div><span class="eyebrow">Last 7 days</span><h2>ARM Deployments</h2></div><span>' + rows.length + ' recent operations</span></div><div class="tile-list">' +
    (rows.length ? rows.map(item => '<button type="button" class="operation-tile" data-open-url="' + attr(item.openUrl) + '"><span class="status-orb tone-' + tone(item.tone) + '"></span><span class="row-copy"><strong>' + h(item.name) + '</strong><small>' + h(item.resourceGroup || 'Subscription scope') + ' · ' + relativeTime(item.timestamp) + '</small></span><span class="status-pill tone-' + tone(item.tone) + '">' + h(item.status) + '</span></button>').join('') : emptyInline('No ARM deployment operations were found in the last 7 days.')) +
  '</div></section>';
  bindOpenButtons();
}

function renderAlerts() {
  const rows = state.data.alerts || [];
  els.content.innerHTML = '<section class="list-view panel"><div class="view-heading"><div><span class="eyebrow">Azure Monitor</span><h2>Active Alerts</h2></div><span>' + rows.length + ' fired</span></div><div class="tile-list two-column">' +
    (rows.length ? rows.map(item => '<button type="button" class="operation-tile" data-open-url="' + attr(item.openUrl) + '"><span class="severity-badge tone-' + tone(item.tone) + '">' + h(item.severity) + '</span><span class="row-copy"><strong>' + h(item.title) + '</strong><small>' + h(item.target || 'Subscription') + ' · ' + relativeTime(item.firedAt) + '</small></span><span class="status-pill tone-' + tone(item.tone) + '">' + h(item.state) + '</span></button>').join('') : emptyInline('No active Azure Monitor alerts.')) +
  '</div></section>';
  bindOpenButtons();
}

function renderHealth() {
  const events = state.data.events || [];
  const issues = (state.data.availability || []).filter(item => !/^available$/i.test(item.state));
  els.content.innerHTML = '<section class="health-layout"><div class="panel health-panel"><div class="view-heading"><div><span class="eyebrow">Service Health</span><h2>Active Events</h2></div><span>' + events.length + '</span></div><div class="compact-list">' +
    (events.length ? events.map(item => '<div class="health-row"><span class="status-orb tone-' + tone(healthToneFromLabel(item.level)) + '"></span><span class="row-copy"><strong>' + h(item.title) + '</strong><small>' + h(item.type) + ' · ' + relativeTime(item.updatedAt) + '</small></span><span class="status-pill tone-' + tone(healthToneFromLabel(item.level)) + '">' + h(item.level) + '</span></div>').join('') : emptyInline('No active service health events.')) +
    '</div></div><div class="panel health-panel"><div class="view-heading"><div><span class="eyebrow">Resource Health</span><h2>Needs Attention</h2></div><span>' + issues.length + '</span></div><div class="compact-list">' +
    (issues.length ? issues.map(item => '<div class="health-row"><span class="status-orb tone-' + tone(healthToneFromLabel(item.state)) + '"></span><span class="row-copy"><strong>' + h(item.resourceId.split('/').pop()) + '</strong><small>' + h(item.summary || item.reason || 'No detail') + '</small></span><span class="status-pill tone-' + tone(healthToneFromLabel(item.state)) + '">' + h(item.state) + '</span></div>').join('') : emptyInline('All reported resources are available.')) +
    '</div></div></section>';
}

function renderCost() {
  const totals = state.data.totals || [];
  els.content.innerHTML = '<section class="cost-view panel"><div class="cost-copy"><span class="eyebrow">Cost Management · Month to date</span><h2>' + (totals.length ? h(formatMoney(totals[0])) : 'No cost data') + '</h2><p>' + (totals.length ? 'Actual Azure usage cost. Forecast and budget thresholds remain in Azure Cost Management.' : 'Cost data can require Cost Management Reader access or may be unavailable for this subscription type.') + '</p></div><div class="cost-actions">' +
    totals.slice(1).map(total => '<span><small>Additional currency</small><strong>' + h(formatMoney(total)) + '</strong></span>').join('') +
    '<button type="button" data-open-url="' + attr(state.data.openUrl) + '">Open Cost Analysis</button></div></section>';
  bindOpenButtons();
}

function renderConfigurationRequired() {
  updateHeader('Not configured');
  renderMessage('Azure app registration required', 'Add the Microsoft Entra application client ID in this app’s settings. The setup file in the Azure app folder lists the redirect URI and permission.', '<button id="retryConfiguration" type="button">Check again</button>');
  document.getElementById('retryConfiguration').addEventListener('click', initialize);
}

function renderConnect(reason) {
  updateHeader('Not connected');
  renderMessage('Connect Microsoft Azure', reason || 'Sign in with a work or school account. Tokens stay in open-quake’s encrypted app-scoped OAuth store.', '<button id="connectButton" class="primary-button" type="button">Connect Azure</button>');
  document.getElementById('connectButton').addEventListener('click', connect);
}

function renderFailure(error, retry) {
  const hint = error.retryAfter ? ' Try again in about ' + error.retryAfter + ' seconds.' : '';
  renderMessage('Azure data unavailable', error.message + hint, '<button id="retryButton" type="button">Retry</button>' + (state.connected ? '<button id="disconnectButton" type="button">Disconnect</button>' : ''));
  document.getElementById('retryButton').addEventListener('click', retry);
  const disconnectButton = document.getElementById('disconnectButton');
  if (disconnectButton) disconnectButton.addEventListener('click', confirmDisconnect);
  updateHeader('Update failed', true);
}

function renderLoading(label) {
  els.content.innerHTML = '<div class="loading-state"><span class="spinner"></span><strong>' + h(label) + '</strong><span>Keeping this subscription isolated while data loads.</span></div>';
}

function renderMessage(title, message, actions) {
  els.content.innerHTML = '<div class="message-state"><div><span class="azure-symbol">A</span><span><strong>' + h(title) + '</strong><small>' + h(message) + '</small></span></div><div class="message-actions">' + (actions || '') + '</div></div>';
}

function updateHeader(override, failed) {
  const subscription = state.subscription;
  els.subscriptionLabel.textContent = subscription ? subscription.name : 'Choose subscription';
  els.tenantLabel.textContent = subscription && subscription.tenantId ? shortId(subscription.tenantId) : '—';
  els.subscriptionButton.disabled = !state.subscriptions.length || state.busy;
  els.refreshButton.disabled = !subscription || !state.connected || state.busy;
  const label = override || (state.stale ? 'Stale · ' + updatedLabel() : state.updatedAt ? 'Updated ' + updatedLabel() : state.connected ? 'Connected' : 'Not connected');
  els.refreshState.innerHTML = '<span class="dot"></span>' + h(label);
  els.refreshState.className = 'connection ' + (failed ? 'error' : state.stale ? 'stale' : state.connected ? 'connected' : 'muted');
}

function updateNavigation() {
  document.querySelectorAll('.bottom-nav [data-view]').forEach(button => button.classList.toggle('selected', button.dataset.view === state.view || (state.view === 'health' || state.view === 'cost') && button.dataset.view === 'overview'));
}

function openSubscriptionPicker() {
  if (!state.subscriptions.length) return;
  els.subscriptionList.innerHTML = state.subscriptions.map(subscription => '<button type="button" class="subscription-row ' + (state.subscription && subscription.id === state.subscription.id ? 'selected' : '') + '" data-subscription="' + attr(subscription.id) + '"><span><strong>' + h(subscription.name) + '</strong><small>' + h(subscription.id) + '</small></span><span><small>Directory</small><strong>' + h(shortId(subscription.tenantId)) + '</strong></span><em>' + h(subscription.state) + '</em></button>').join('');
  els.subscriptionList.querySelectorAll('[data-subscription]').forEach(button => button.addEventListener('click', () => {
    const subscription = state.subscriptions.find(item => item.id === button.dataset.subscription);
    if (subscription && (!state.subscription || subscription.id !== state.subscription.id)) selectSubscription(subscription, false);
    else closeSubscriptionPicker();
  }));
  els.subscriptionOverlay.hidden = false;
}

function closeSubscriptionPicker() {
  els.subscriptionOverlay.hidden = true;
}

function confirmDisconnect() {
  confirmDialog('Disconnect Microsoft Azure and remove this app’s stored OAuth tokens?', disconnect);
}

function confirmDialog(message, action) {
  state.confirmAction = action;
  els.confirmMessage.textContent = message;
  els.confirmOverlay.hidden = false;
}

function closeConfirm() {
  state.confirmAction = null;
  els.confirmOverlay.hidden = true;
}

function acceptConfirm() {
  const action = state.confirmAction;
  if (typeof action === 'function') action();
  else closeConfirm();
}

async function openCurrentInAzure() {
  try {
    const link = state.data && state.data.openUrl ? state.data.openUrl : (await api('portal-link', { subscription: state.subscription && state.subscription.id })).url;
    await openUrl(link);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function openUrl(url) {
  if (!url) return;
  await api('open', { url });
}

function bindOpenButtons() {
  els.content.querySelectorAll('[data-open-url]').forEach(button => button.addEventListener('click', () => openUrl(button.dataset.openUrl).catch(error => showToast(error.message, true))));
}

function setBusy(busy, label) {
  state.busy = busy;
  updateHeader(label);
}

function scheduleRefresh() {
  clearInterval(state.autoRefresh);
  state.autoRefresh = setInterval(() => {
    if (!document.hidden && state.subscription && !state.busy) loadView(true);
  }, refreshMinutes * 60 * 1000);
}

function showToast(message, error) {
  clearTimeout(showToast.timer);
  els.toast.textContent = message;
  els.toast.className = 'toast show' + (error ? ' error' : '');
  showToast.timer = setTimeout(() => { els.toast.className = 'toast'; }, 4200);
}

function emptyInline(message) {
  return '<div class="inline-empty"><strong>' + h(message) + '</strong><span>Pull down or tap refresh to check again.</span></div>';
}

function statusDot(value) {
  return '<i class="status-orb tone-' + tone(value) + '"></i>';
}

function tone(value) {
  return ['good', 'warn', 'bad', 'info', 'neutral'].includes(value) ? value : 'neutral';
}

function healthToneFromLabel(value) {
  const label = String(value || '').toLowerCase();
  if (/available|healthy|normal|success|resolved/.test(label)) return 'good';
  if (/critical|error|unavailable|failed/.test(label)) return 'bad';
  if (/warn|degraded/.test(label)) return 'warn';
  return 'neutral';
}

function resourceGlyph(category) {
  const glyphs = { 'app-services': 'APP', 'function-apps': 'ƒ', 'virtual-machines': 'VM', databases: 'DB', storage: 'ST', other: 'AZ' };
  return glyphs[category] || 'AZ';
}

function typeLabel(resource) {
  const labels = { 'app-services': 'App Service', 'function-apps': 'Function App', 'virtual-machines': 'Virtual Machine', databases: 'Database', storage: 'Storage', other: String(resource.type || '').split('/').pop() || 'Azure resource' };
  return labels[resource.category] || labels.other;
}

function formatMoney(total) {
  try { return new Intl.NumberFormat('en', { style: 'currency', currency: total.currency, maximumFractionDigits: 2 }).format(total.amount); }
  catch (error) { return Number(total.amount || 0).toFixed(2) + ' ' + total.currency; }
}

function updatedLabel() {
  return relativeTime(state.updatedAt).replace(/^just now$/, 'just now');
}

function relativeTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return 'unknown time';
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}

function shortId(value) {
  const text = String(value || '');
  return text.length > 13 ? text.slice(0, 8) + '…' + text.slice(-4) : text || '—';
}

function safeStorageGet(key) {
  try { return localStorage.getItem(key) || ''; }
  catch (error) { return ''; }
}

function safeStorageSet(key, value) {
  try { localStorage.setItem(key, value); }
  catch (error) {}
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function h(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function attr(value) {
  return h(value).replace(/`/g, '&#96;');
}
