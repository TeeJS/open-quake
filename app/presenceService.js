'use strict';
// Ties the presence state machine to its outputs: the USB Busylight, a DIY WLED light, and Home
// Assistant over MQTT. Owns the off-delay timer that presence.js deliberately does not own.
//
// ISOLATION RULE, and it is the reason every call here is wrapped: an output failing must never take
// down another output, the meeting recorder, or the app. A broker that is down, a light that was
// unplugged, and a mistyped WLED address are all normal Tuesday conditions. Each one degrades to a
// status string that the settings page can show, and nothing else changes.

const { createPresence } = require('./presence');
const { createBusylightService, parseColor } = require('./busylightService');
const { createPresenceMqtt } = require('./presenceMqtt');
const busySchedule = require('./busySchedule');

const WLED_TIMEOUT_MS = 3000;

const DEFAULTS = {
  busyEnabled: false,
  busyOnRecording: true,
  busyOffDelaySec: 5,
  busyLightEnabled: false,
  busyLightBusyColor: '#ff0000',
  busyLightFreeColor: '#00ff00',
  busyLightBrightness: 100,
  busyManualColor: '#a020f0',
  busyLightFreeOff: false,
  busySchedEnabled: false,
  busySchedDays: '1,2,3,4,5',
  busySchedStart: '08:00',
  busySchedEnd: '17:00',
  busySchedPerDay: false,
  busySchedTimes: {},
  busyWledEnabled: false,
  busyWledHost: '',
  busyMqttEnabled: false,
  busyMqttUrl: '',
  busyMqttUser: '',
  busyMqttPassword: '',
  busyMqttBaseTopic: 'open-quake',
};

// 'http://1.2.3.4', '1.2.3.4', '1.2.3.4:8080' -> a usable origin. WLED is plain HTTP on the LAN and
// users will type a bare IP, so default the scheme rather than rejecting it.
function wledUrl(host, path) {
  const h = String(host || '').trim().replace(/\/+$/, '');
  if (!h) return null;
  const base = /^https?:\/\//i.test(h) ? h : 'http://' + h;
  return base + path;
}

// WLED gotcha: turning on from off and setting a colour in the same request can be ignored, so
// brightness is always sent explicitly alongside on and the colour.
function wledBody(color, on) {
  if (!on) return { on: false };
  return { on: true, bri: 255, seg: [{ col: [[color.r, color.g, color.b]] }] };
}

function createPresenceService(deps) {
  const d = deps || {};
  const log = d.log || (() => {});
  const fetchImpl = d.fetch || (typeof fetch === 'function' ? fetch : null);

  let settings = Object.assign({}, DEFAULTS);
  let offTimer = null;
  let lastApplied = null;

  const busylight = d.busylight || createBusylightService({ log, hid: d.hid });
  const mqtt = d.mqtt || createPresenceMqtt({ log, mqtt: d.mqttLib, hostname: d.hostname });
  const outputStatus = { light: null, wled: null };

  const presence = createPresence({
    offDelayMs: (Number(settings.busyOffDelaySec) || 0) * 1000,
    busyOnRecording: settings.busyOnRecording,
    onChange: state => applyOutputs(state),
  });

  // presence.js reports "an off-delay is pending" rather than owning a timer, so the schedule lives
  // here. One shot per pending window; re-armed by whichever input changes next.
  function armOffTimer(pending) {
    if (offTimer) { clearTimeout(offTimer); offTimer = null; }
    if (!pending) return;
    offTimer = setTimeout(() => {
      offTimer = null;
      if (presence.tick()) armOffTimer(true);
    }, Math.max(50, presence.getOffDelayMs()));
    if (offTimer.unref) offTimer.unref();
  }

  // A manual override shows its own colour so "busy because I said so" is distinguishable at a glance
  // from "busy because Teams has the mic" — that is the whole point of setting it by hand.
  function busyColorFor(state) {
    return state && state.reason === 'custom' && settings.busyManualColor
      ? settings.busyManualColor
      : settings.busyLightBusyColor;
  }

  function scheduleView() {
    return {
      enabled: !!settings.busySchedEnabled, days: settings.busySchedDays,
      start: settings.busySchedStart, end: settings.busySchedEnd,
      perDay: !!settings.busySchedPerDay, times: settings.busySchedTimes || {},
    };
  }
  // Scoped to the USB light only. WLED and the HA entity keep reporting outside the window — the
  // schedule is about not lighting up your desk after hours, not about withholding the state.
  function lightScheduled() { return busySchedule.isActive(new Date(), scheduleView()); }

  function applyLight(state) {
    if (!settings.busyEnabled || !settings.busyLightEnabled) { busylight.close(); outputStatus.light = 'disabled'; return; }
    if (!lightScheduled()) {
      // Off, not merely "don't update": crossing out of the window while busy must actively clear a
      // light that is currently red.
      try { busylight.off(); } catch (e) {}
      outputStatus.light = 'outside schedule';
      return;
    }
    try {
      if (state.busy) {
        const c = parseColor(busyColorFor(state), settings.busyLightBrightness);
        outputStatus.light = busylight.setColor(c) ? 'busy' : (busylight.status().error || 'write failed');
      } else if (settings.busyLightFreeOff) {
        busylight.off();
        outputStatus.light = 'free (off)';
      } else {
        const c = parseColor(settings.busyLightFreeColor, settings.busyLightBrightness);
        outputStatus.light = busylight.setColor(c) ? 'free' : (busylight.status().error || 'write failed');
      }
    } catch (e) { outputStatus.light = e.message; }
  }

  function applyWled(state) {
    if (!settings.busyEnabled || !settings.busyWledEnabled) { outputStatus.wled = 'disabled'; return Promise.resolve(); }
    const url = wledUrl(settings.busyWledHost, '/json/state');
    if (!url) { outputStatus.wled = 'host required'; return Promise.resolve(); }
    if (!fetchImpl) { outputStatus.wled = 'fetch unavailable'; return Promise.resolve(); }
    const color = parseColor(state.busy ? busyColorFor(state) : settings.busyLightFreeColor, settings.busyLightBrightness);
    const on = state.busy || !settings.busyLightFreeOff;
    // A slow or absent light must not stall the fan-out, so this is fire-and-forget with a timeout
    // and the outcome recorded for the settings page.
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), WLED_TIMEOUT_MS) : null;
    return Promise.resolve()
      .then(() => fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(wledBody(color, on)),
        signal: ac ? ac.signal : undefined,
      }))
      .then(r => { outputStatus.wled = r && r.ok ? 'ok' : 'HTTP ' + (r && r.status); })
      .catch(e => { outputStatus.wled = e && e.name === 'AbortError' ? 'timeout' : (e.message || String(e)); })
      .finally(() => { if (timer) clearTimeout(timer); });
  }

  function applyOutputs(state) {
    applyLight(state);
    applyWled(state);
    try { mqtt.publishState(state); } catch (e) {}
    try { if (d.onState) d.onState(getState()); } catch (e) {}
  }

  function getState() {
    const s = presence.getState();
    return {
      enabled: !!settings.busyEnabled,
      busy: s.busy,
      reason: s.reason,
      app: s.app,
      since: s.since,
      override: s.override,
      manualColor: settings.busyManualColor,
      busyColor: settings.busyLightBusyColor,
      recording: s.recording,
      callActive: s.callActive,
      outputs: {
        light: Object.assign({ status: outputStatus.light, scheduled: lightScheduled(),
          schedule: busySchedule.describe(scheduleView()) }, busylight.status()),
        wled: { enabled: !!settings.busyWledEnabled, status: outputStatus.wled },
        mqtt: mqtt.status(),
      },
    };
  }

  // Nothing about presence changes when the clock crosses 17:00, so without a tick the light would
  // stay red until the next call event. 30s is well inside a minute-granular schedule.
  let schedTimer = null;
  let lastScheduled = null;
  function startScheduleWatch() {
    if (schedTimer) return;
    schedTimer = setInterval(() => {
      const now = lightScheduled();
      if (now !== lastScheduled) { lastScheduled = now; applyOutputs(presence.getState()); }
    }, 30000);
    if (schedTimer.unref) schedTimer.unref();
  }
  function stopScheduleWatch() { if (schedTimer) { clearInterval(schedTimer); schedTimer = null; } }

  return {
    // Called at boot and whenever the editor saves. Re-applies everything that changed and leaves
    // the live inputs (call/recording/override) alone.
    applySettings(next) {
      const prev = settings;
      settings = Object.assign({}, DEFAULTS, next || {});
      presence.setRecordingCounts(settings.busyOnRecording);
      presence.setOffDelay((Number(settings.busyOffDelaySec) || 0) * 1000);
      mqtt.apply({
        enabled: !!(settings.busyEnabled && settings.busyMqttEnabled),
        url: settings.busyMqttUrl,
        username: settings.busyMqttUser,
        password: settings.busyMqttPassword,
        baseTopic: settings.busyMqttBaseTopic,
      });
      // Turning the feature (or the light) off must actively clear the light rather than leaving
      // whatever it last showed lit until the device's own timeout.
      if (prev.busyLightEnabled && !(settings.busyEnabled && settings.busyLightEnabled)) {
        try { busylight.close(); } catch (e) {}
      }
      lastApplied = Date.now();
      lastScheduled = lightScheduled();
      if (settings.busyEnabled && settings.busyLightEnabled && settings.busySchedEnabled) startScheduleWatch();
      else stopScheduleWatch();
      applyOutputs(presence.getState());
    },

    setCall(active, app) { armOffTimer(presence.setCall(active, app)); },
    setRecording(on) { armOffTimer(presence.setRecording(on)); },
    setOverride(mode) { armOffTimer(presence.setOverride(mode)); return getState(); },
    // Panel colour picker. Applied immediately so the light changes under your finger; main persists it.
    setManualColor(hex) {
      settings.busyManualColor = hex;
      applyOutputs(presence.getState());
      return getState();
    },

    getState,
    // Used by the editor's Test buttons. Drives one output directly without disturbing real state.
    test(target) {
      if (target === 'light') {
        const c = parseColor(settings.busyLightBusyColor, settings.busyLightBrightness);
        const ok = busylight.setColor(c);
        setTimeout(() => applyLight(presence.getState()), 2000);
        return Object.assign({ ok }, busylight.status());
      }
      if (target === 'wled') {
        return applyWled({ busy: true }).then(() => {
          setTimeout(() => applyWled(presence.getState()), 2000);
          return { ok: outputStatus.wled === 'ok', status: outputStatus.wled };
        });
      }
      if (target === 'mqtt') return mqtt.status();
      return { ok: false, error: 'unknown test target' };
    },

    // Quit path: clear the light now rather than relying on its 30s timeout, and tell HA we are gone
    // rather than making the broker notice a dead socket.
    stop() {
      if (offTimer) { clearTimeout(offTimer); offTimer = null; }
      stopScheduleWatch();
      try { busylight.close(); } catch (e) {}
      try { mqtt.stop(); } catch (e) {}
    },
  };
}

module.exports = { createPresenceService, wledUrl, wledBody, DEFAULTS };
