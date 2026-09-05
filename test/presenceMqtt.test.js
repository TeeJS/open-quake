'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  createPresenceMqtt, buildTopics, buildDiscoveryConfig, buildPayloads, safeNodeId, OBJECT_ID,
} = require('../app/presenceMqtt');

test('safeNodeId makes a hostname safe for both MQTT topics and HA object ids', () => {
  assert.strictEqual(safeNodeId('TJ-Desktop'), 'tj-desktop');
  assert.strictEqual(safeNodeId('host.with.dots'), 'host-with-dots');
  // '+' and '#' are MQTT wildcards; '/' a level separator. None may survive into a topic.
  assert.strictEqual(safeNodeId('we+ird/name#1'), 'we-ird-name-1');
  assert.strictEqual(safeNodeId(''), 'open-quake');
  assert.strictEqual(safeNodeId(null), 'open-quake');
});

test('topics are built under the configured base and share one node id', () => {
  const t = buildTopics('open-quake', 'TJ-PC');
  assert.strictEqual(t.node, 'tj-pc');
  assert.strictEqual(t.state, 'open-quake/tj-pc/busy');
  assert.strictEqual(t.attributes, 'open-quake/tj-pc/attributes');
  assert.strictEqual(t.availability, 'open-quake/tj-pc/availability');
  assert.strictEqual(t.discovery, 'homeassistant/binary_sensor/tj-pc_open_quake_busy/config');
});

test('stray slashes in the base topic do not produce empty topic levels', () => {
  const t = buildTopics('/oq/', 'pc');
  assert.strictEqual(t.state, 'oq/pc/busy');
  assert.strictEqual(buildTopics('', 'pc').state, 'open-quake/pc/busy');
});

test('discovery config carries what HA needs to auto-create a persistent entity', () => {
  const t = buildTopics('open-quake', 'pc');
  const c = buildDiscoveryConfig(t, {});
  assert.strictEqual(c.state_topic, t.state);
  assert.strictEqual(c.availability_topic, t.availability);
  assert.strictEqual(c.json_attributes_topic, t.attributes);
  assert.strictEqual(c.payload_on, 'ON');
  assert.strictEqual(c.payload_off, 'OFF');
  assert.strictEqual(c.payload_available, 'online');
  assert.strictEqual(c.payload_not_available, 'offline');
  // unique_id is what makes the entity editable in the HA UI and stable across restarts.
  assert.strictEqual(c.unique_id, 'pc_' + OBJECT_ID);
  assert.ok(c.device && Array.isArray(c.device.identifiers), 'grouped under one device, not loose');
});

test('busy and free map to the documented payloads with attributes', () => {
  const busy = buildPayloads({ busy: true, reason: 'call', app: 'Teams.exe', since: 1700000000000, recording: false, override: 'auto' });
  assert.strictEqual(busy.state, 'ON');
  assert.strictEqual(busy.attributes.reason, 'call');
  assert.strictEqual(busy.attributes.app, 'Teams.exe');
  assert.strictEqual(busy.attributes.since, new Date(1700000000000).toISOString());

  const free = buildPayloads({ busy: false, reason: null, app: null, since: null });
  assert.strictEqual(free.state, 'OFF');
  assert.strictEqual(free.attributes.reason, null);
  assert.strictEqual(free.attributes.since, null);
});

// ---- client behaviour against a fake mqtt module ----

function fakeMqtt() {
  const published = [];
  const handlers = {};
  let opts = null;
  let ended = false;
  const client = {
    publish: (topic, payload, o) => published.push({ topic, payload, opts: o }),
    on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); },
    end: () => { ended = true; },
  };
  return {
    connect: (url, o) => { opts = Object.assign({ url }, o); return client; },
    _fire: (ev, arg) => (handlers[ev] || []).forEach(fn => fn(arg)),
    _published: published,
    _opts: () => opts,
    _ended: () => ended,
    _handlers: handlers,
  };
}

function svcWith(mqtt, over) {
  const s = createPresenceMqtt({ mqtt, hostname: 'tj-pc' });
  s.apply(Object.assign({ enabled: true, url: 'mqtt://broker:1883', baseTopic: 'open-quake' }, over || {}));
  return s;
}

test('THE WILL is registered at connect — the whole crash failsafe depends on it', () => {
  const mqtt = fakeMqtt();
  svcWith(mqtt);
  const will = mqtt._opts().will;
  assert.ok(will, 'a will must be registered');
  assert.strictEqual(will.topic, 'open-quake/tj-pc/availability');
  assert.strictEqual(will.payload, 'offline');
  assert.strictEqual(will.retain, true);
});

test('on connect it announces discovery, availability, then state', () => {
  const mqtt = fakeMqtt();
  const s = svcWith(mqtt);
  s.publishState({ busy: true, reason: 'call', app: 'Teams.exe', since: 1 });
  mqtt._published.length = 0;
  mqtt._fire('connect');
  const topics = mqtt._published.map(p => p.topic);
  assert.ok(topics.includes('homeassistant/binary_sensor/tj-pc_open_quake_busy/config'));
  assert.ok(topics.includes('open-quake/tj-pc/availability'));
  assert.ok(topics.includes('open-quake/tj-pc/busy'), 'current state replayed, not just discovery');
});

test('a reconnect re-announces, because a broker restart drops retained messages', () => {
  const mqtt = fakeMqtt();
  const s = svcWith(mqtt);
  mqtt._fire('connect');
  s.publishState({ busy: true, reason: 'call', app: 'Zoom.exe', since: 1 });
  mqtt._published.length = 0;
  mqtt._fire('connect');   // MQTT.js re-emits connect after an automatic reconnect
  const topics = mqtt._published.map(p => p.topic);
  assert.ok(topics.includes('homeassistant/binary_sensor/tj-pc_open_quake_busy/config'),
    'entity heals itself rather than sitting unavailable until the next transition');
  assert.strictEqual(mqtt._published.find(p => p.topic === 'open-quake/tj-pc/busy').payload, 'ON');
});

test('state and attributes are published retained so HA survives a restart', () => {
  const mqtt = fakeMqtt();
  const s = svcWith(mqtt);
  mqtt._fire('connect');
  mqtt._published.length = 0;
  s.publishState({ busy: true, reason: 'recording', app: null, since: 1700000000000, recording: true });
  const state = mqtt._published.find(p => p.topic === 'open-quake/tj-pc/busy');
  const attrs = mqtt._published.find(p => p.topic === 'open-quake/tj-pc/attributes');
  assert.strictEqual(state.payload, 'ON');
  assert.strictEqual(state.opts.retain, true);
  assert.strictEqual(JSON.parse(attrs.payload).reason, 'recording');
});

test('a broker error never throws — a bad address must not kill the app', () => {
  const mqtt = fakeMqtt();
  const s = svcWith(mqtt);
  assert.ok(mqtt._handlers.error && mqtt._handlers.error.length, 'an error handler must be attached');
  assert.doesNotThrow(() => mqtt._fire('error', new Error('ECONNREFUSED')));
  assert.strictEqual(s.status().connected, false);
  assert.match(s.status().error, /ECONNREFUSED/);
});

test('a clean stop says offline immediately rather than waiting for the will', () => {
  const mqtt = fakeMqtt();
  const s = svcWith(mqtt);
  mqtt._fire('connect');
  mqtt._published.length = 0;
  s.stop();
  const bye = mqtt._published.find(p => p.topic === 'open-quake/tj-pc/availability');
  assert.strictEqual(bye.payload, 'offline');
  assert.strictEqual(mqtt._ended(), true);
});

test('re-applying identical settings does NOT reconnect', () => {
  // Reconnecting drops and re-registers the will. Editing an unrelated setting must not disturb it.
  const mqtt = fakeMqtt();
  const s = svcWith(mqtt);
  mqtt._fire('connect');
  mqtt._published.length = 0;
  s.apply({ enabled: true, url: 'mqtt://broker:1883', baseTopic: 'open-quake' });
  assert.strictEqual(mqtt._ended(), false, 'connection kept');
  assert.strictEqual(mqtt._published.length, 0, 'nothing re-announced');
});

test('changing the broker URL disconnects A and connects to B', () => {
  // The realistic path: type the wrong broker, save, notice, fix it. Without an explicit disconnect
  // the user stays bound to the first (failed) client and the fix appears to do nothing.
  const mqtt = fakeMqtt();
  const s = svcWith(mqtt, { url: 'mqtt://wrong-host:1883' });
  mqtt._fire('connect');
  assert.strictEqual(mqtt._opts().url, 'mqtt://wrong-host:1883');

  s.apply({ enabled: true, url: 'mqtt://right-host:1883', baseTopic: 'open-quake' });
  assert.strictEqual(mqtt._ended(), true, 'the old client must be ended');
  assert.strictEqual(mqtt._opts().url, 'mqtt://right-host:1883', 'reconnected to the new broker');
  // The new connection must carry its own will; a reconnect that lost it would silently drop the
  // crash failsafe.
  assert.strictEqual(mqtt._opts().will.topic, 'open-quake/tj-pc/availability');
});

test('changing only the credentials also reconnects', () => {
  const mqtt = fakeMqtt();
  const s = svcWith(mqtt, { username: 'old' });
  mqtt._fire('connect');
  s.apply({ enabled: true, url: 'mqtt://broker:1883', baseTopic: 'open-quake', username: 'new', password: 'pw' });
  assert.strictEqual(mqtt._opts().username, 'new');
  assert.strictEqual(mqtt._opts().password, 'pw');
});

test('changing the base topic re-homes every topic', () => {
  const mqtt = fakeMqtt();
  const s = svcWith(mqtt);
  mqtt._fire('connect');
  s.apply({ enabled: true, url: 'mqtt://broker:1883', baseTopic: 'presence' });
  mqtt._published.length = 0;
  mqtt._fire('connect');
  assert.ok(mqtt._published.some(p => p.topic === 'presence/tj-pc/busy'));
  assert.strictEqual(mqtt._opts().will.topic, 'presence/tj-pc/availability');
});

test('disabling stops the client and reports disabled', () => {
  const mqtt = fakeMqtt();
  const s = svcWith(mqtt);
  mqtt._fire('connect');
  s.apply({ enabled: false });
  assert.strictEqual(mqtt._ended(), true);
  assert.strictEqual(s.status().enabled, false);
});

test('enabled with no broker URL reports the reason instead of connecting', () => {
  const mqtt = fakeMqtt();
  const s = createPresenceMqtt({ mqtt, hostname: 'tj-pc' });
  s.apply({ enabled: true, url: '' });
  assert.strictEqual(mqtt._opts(), null, 'no connection attempted');
  assert.match(s.status().error, /broker URL required/);
});

test('publishState before a connection is a no-op, and replays on connect', () => {
  const mqtt = fakeMqtt();
  const s = createPresenceMqtt({ mqtt, hostname: 'tj-pc' });
  assert.strictEqual(s.publishState({ busy: true, reason: 'call' }), false);
  s.apply({ enabled: true, url: 'mqtt://broker:1883', baseTopic: 'open-quake' });
  mqtt._fire('connect');
  assert.ok(mqtt._published.some(p => p.topic === 'open-quake/tj-pc/busy'),
    'the state held before connecting is announced once connected');
});
