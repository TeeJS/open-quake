'use strict';
// Busy-presence state machine: the single place that decides whether you are "busy", from three
// independent inputs. Pure and dependency-free so the precedence and debounce rules can be tested
// without a microphone, a light, or a broker — the outputs live in presenceService.js.
//
// Inputs, in order of precedence:
//   override    'busy' | 'free' pins the state and wins over everything; 'auto' hands control back
//   recording   open-quake is capturing a meeting
//   call        an allowlisted call app holds the microphone
//
// The off-delay exists because a call app's capture session is not continuous. Teams in particular
// drops and retakes the mic when the meeting window changes (joining, screen share starting), which
// without a delay reads as call-ended immediately followed by call-started, and the light visibly
// blinks in the middle of a meeting. Going busy is immediate; only going free waits.

const DEFAULT_OFF_DELAY_MS = 5000;

// deps.now and deps.setTimer exist so tests can drive time directly rather than sleeping.
function createPresence(options) {
  const opts = options || {};
  const now = opts.now || (() => Date.now());
  // Mutable, not captured once: the off-delay is a user setting and applySettings() must be able to
  // change it on a live instance. Capturing it in a const meant edits to it silently did nothing.
  let offDelayMs = Math.max(0, Number(opts.offDelayMs == null ? DEFAULT_OFF_DELAY_MS : opts.offDelayMs));
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};

  let callActive = false;
  let callApp = null;
  let recording = false;
  let recordingCounts = opts.busyOnRecording !== false;
  let override = 'auto';

  let busy = false;
  let reason = null;
  let since = null;
  let pendingOffAt = null;   // when the off-delay expires, or null when nothing is pending
  // The app as of the last emit. Comparing against the live callApp cannot detect a change, because
  // setCall() has already updated it by the time evaluate() runs — that made a Teams -> Zoom switch
  // silently skip its notification.
  let emittedApp = null;

  // What the inputs say right now, ignoring the off-delay. Override first, then recording, then call:
  // recording outranks call so a manually started recording still reads as busy after the call app
  // has let go of the mic.
  function target() {
    if (override === 'busy') return { busy: true, reason: 'manual', app: null };
    // 'custom' is busy with a user-picked colour — a distinct reason so the fan-out can tell it apart
    // from an ordinary manual busy and paint it differently.
    if (override === 'custom') return { busy: true, reason: 'custom', app: null };
    if (override === 'free') return { busy: false, reason: null, app: null };
    if (recording && recordingCounts) return { busy: true, reason: 'recording', app: callApp };
    if (callActive) return { busy: true, reason: 'call', app: callApp };
    return { busy: false, reason: null, app: null };
  }

  function emit() { try { onChange(getState()); } catch (e) {} }

  // Recompute after any input change. Returns true when the caller should re-check later, i.e. an
  // off-delay is pending — presenceService drives that with a timer it owns.
  function evaluate() {
    const t = target();
    const t0 = now();

    if (t.busy) {
      pendingOffAt = null;
      const changed = !busy || reason !== t.reason || emittedApp !== t.app;
      if (!busy) since = t0;
      busy = true; reason = t.reason; emittedApp = t.app;
      if (changed) emit();
      return false;
    }

    // The debounce exists for ONE failure: a call app releasing and retaking the microphone
    // mid-meeting, which is invisible to the user and would blink the light. Nothing else flaps.
    //   - an explicit 'free' override is a deliberate act
    //   - a recording stopping is a discrete event from our own recorder, not a flapping input
    // Both take effect at once; only a call going quiet waits.
    if (override === 'free' || offDelayMs === 0 || reason !== 'call') {
      pendingOffAt = null;
      if (busy) { busy = false; reason = null; emittedApp = null; since = t0; emit(); }
      return false;
    }

    if (!busy) { pendingOffAt = null; return false; }
    if (pendingOffAt == null) pendingOffAt = t0 + offDelayMs;
    if (t0 >= pendingOffAt) {
      pendingOffAt = null;
      busy = false; reason = null; emittedApp = null; since = t0;
      emit();
      return false;
    }
    return true;
  }

  function getState() {
    return {
      busy,
      reason,
      app: busy && (reason === 'call' || reason === 'recording') ? callApp : null,
      since,
      override,
      callActive,
      callApp,
      recording,
      pendingOff: pendingOffAt != null,
    };
  }

  return {
    // A call app took or released the mic. `app` is the matched process name, or null.
    setCall(active, app) {
      callActive = !!active;
      callApp = callActive ? (app || null) : null;
      return evaluate();
    },
    setRecording(on) { recording = !!on; return evaluate(); },
    setOverride(mode) {
      override = (mode === 'busy' || mode === 'free' || mode === 'custom') ? mode : 'auto';
      return evaluate();
    },
    // Settings changed under us (busyOnRecording toggled). Kept separate from construction so the
    // service can apply an edited config without losing the current call/recording inputs.
    setRecordingCounts(on) { recordingCounts = on !== false; return evaluate(); },
    setOffDelay(ms) { offDelayMs = Math.max(0, Number(ms) || 0); return evaluate(); },
    getOffDelayMs() { return offDelayMs; },
    // Called by the owner's timer while an off-delay is pending; returns true while still pending.
    tick() { return evaluate(); },
    getState,
  };
}

module.exports = { createPresence, DEFAULT_OFF_DELAY_MS };
