'use strict';
// Main-process speech pipeline for the Claude Code voice app (task #26 -- the architecture the user
// proposed after the page-side per-sentence queue produced overlapping voices). The page no longer
// runs ANY speech logic: main.js feeds assistant text deltas in here, complete sentences are cut
// out, sanitized for speech, synthesized serially through wyoming-piper, and streamed as ONE
// continuous WAV per turn to the page's single <audio> element (GET /claude-voice/turn-audio).
//
// Overlap is impossible by construction: one active turn, one synth loop, one audio stream.
// beginTurn() aborts the previous turn, and the page dropping its stream socket (mute button,
// folder switch, page reload) aborts synthesis server-side -- that socket close IS the barge-in
// signal, no separate control channel needed. This also removes the audible inter-sentence gaps
// the old design had (each sentence was its own POST + GET + <audio> element).

const CODE_ANNOUNCE = "Code's on screen.";
const TABLE_ANNOUNCE = "Table's on screen.";

// Buffered-audio cap for a turn whose <audio> element never connects (page died between POSTing the
// turn and opening the stream). ~16MB is several minutes of 22kHz/16-bit PCM -- far beyond any real
// reply -- so hitting it means nobody is listening and the turn should be dropped, not grown forever.
const MAX_PENDING_BYTES = 16 * 1024 * 1024;

// Speech-ONLY text cleanup -- the display path never touches this; the screen always shows the raw
// text. Piper reads markdown source miserably, so for the speaker: links become their label, URLs
// become the bare hostname, file paths become the filename, UUIDs/hex become a word, and markdown
// markers / arrows / bullets / emoji vanish. (Moved verbatim from claudevoiceview.js when the
// pipeline moved into the main process.)
function speechSanitize(text) {
  let s = String(text || '');
  s = s.replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, '$1');                               // [label](url) -> label
  s = s.replace(/\bhttps?:\/\/([^\s/)\]>]+)[^\s)\]>]*/gi, (m, host) =>             // bare URL -> "host dot com"
    host.replace(/^www\./i, '').replace(/:\d+$/, '').replace(/\./g, ' dot '));
  s = s.replace(/(?:[A-Za-z]:)?(?:\\[\w.\-~]+)+\\?/g, m => {                       // windows path -> filename
    const parts = m.split('\\').filter(Boolean);
    return parts.length ? parts[parts.length - 1].replace(/^[A-Za-z]:$/, '') : '';
  });
  s = s.replace(/(^|\s)(~?\/[\w.\-/]+|[\w.\-]+(?:\/[\w.\-]+){2,})/g, (m, pre, p) => {   // unix-ish path -> filename
    const parts = p.split('/').filter(Boolean);
    return pre + (parts.length ? parts[parts.length - 1] : '');
  });
  s = s.replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, 'an ID');
  s = s.replace(/\b(?=[0-9a-fA-F]*\d)(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{7,40}\b/g, 'a hash');   // hex runs (needs a digit AND a letter -- plain numbers survive)
  s = s.replace(/[←-⇿⌀-➿⬀-⯿■-◿★☆•·\u{1F000}-\u{1FAFF}]/gu, ' ');  // arrows, checks, bullets, emoji
  s = s.replace(/^[ \t]*#{1,6}[ \t]*/gm, '');                                       // heading markers
  s = s.replace(/^[ \t]*>+[ \t]*/gm, '');                                           // blockquote markers
  s = s.replace(/(\*\*|__|[*`])/g, ' ');                                            // emphasis/backtick markers
  return s.replace(/\s+/g, ' ').trim();
}

// Whole-text variant of the same cleanup, for text that arrives complete rather than streamed:
// result-only turns (slash commands never stream deltas) and the Test speech button's replay.
// Fences and tables become their one-line announcements inline.
function prepWholeSpeech(raw) {
  const out = [];
  let inFence = false, inTable = false;
  String(raw || '').split('\n').forEach(ln => {
    if (/^\s*```/.test(ln)) { if (!inFence) out.push(CODE_ANNOUNCE); inFence = !inFence; return; }
    if (inFence) return;
    if (/^\s*\|/.test(ln)) { if (!inTable) out.push(TABLE_ANNOUNCE); inTable = true; return; }
    inTable = false;
    out.push(ln);
  });
  return speechSanitize(out.join(' '));
}

// createSpeechPipeline({synthesize, wavHeader, getTts, log, onSpeechError}) -> the one pipeline
// instance the host owns. `synthesize`/`wavHeader` come from claudevoice-wyoming.js; `getTts()`
// returns the live {host, port} for wyoming-piper (read per sentence so option edits apply
// without a restart). `onSpeechError(message)` fires ONCE per turn on its first synthesis failure
// -- a dead TTS service fails every sentence, and without this the turn ended as a silent empty
// stream indistinguishable from "nothing to say" (per-sentence skips are still right for
// transient hiccups; total silence with no error was not).
function createSpeechPipeline({ synthesize, wavHeader, getTts, log, onSpeechError }) {
  const say = log || (() => {});
  const tellError = onSpeechError || (() => {});
  let seq = 0;
  let turn = null;   // the single active turn's state, or null

  function abortActive(reason) {
    if (!turn) return;
    const t = turn;
    turn = null;
    t.aborted = true;
    if (t.cancelSynth) { try { t.cancelSynth(); } catch (e) {} }
    if (t.res) { try { t.res.end(); } catch (e) {} }
    say('speech turn ' + t.id + ' aborted (' + (reason || 'no reason given') + ')');
  }

  // Starts the speech stream for a new voice turn and returns its id (the page's turn-audio URL
  // carries it back). Any previous turn's speech is superseded -- new input always wins.
  function beginTurn() {
    abortActive('superseded by a new turn');
    const id = String(++seq);
    turn = {
      id,
      buf: '', inFence: false, inTable: false, sawDelta: false,   // sentence-cutter state
      sentences: [],                 // sanitized sentences waiting for synthesis, in speaking order
      synthesizing: false,           // exactly one wyoming request in flight at a time
      finished: false,               // no more text will be fed (result event arrived)
      done: false,                   // all audio synthesized but no listener attached yet -- held for a late attach
      res: null, resStarted: false,  // the page's GET /claude-voice/turn-audio response, once connected
      headerWritten: false, format: null,
      pending: [], pendingBytes: 0,  // PCM synthesized before the listener attached
      cancelSynth: null, aborted: false,
      errorNotified: false,          // onSpeechError fires at most once per turn
    };
    return id;
  }

  // Feeds streamed assistant text in. No-op unless a speaking turn is active.
  function feed(text) {
    if (!turn || turn.finished) return;
    turn.sawDelta = true;
    turn.buf += text;
    drain(turn, false);
  }

  // The turn's text is complete. Flush the remainder -- or, for a turn that never streamed any
  // deltas (slash commands arrive only in the final result event), speak the whole reply at once.
  function finish(finalText) {
    const t = turn;
    if (!t || t.finished) return;
    if (!t.sawDelta) {
      const whole = prepWholeSpeech(finalText);
      if (whole) t.sentences.push(whole);
    } else {
      drain(t, true);
    }
    t.finished = true;
    pump();
  }

  // ---- sentence cutting (ported intact from the page-side pipeline; behavior is user-tuned) ----
  function enqueueSentence(t, text) {
    const raw = String(text || '');
    // Markdown tables: rows are dropped from speech; each table announces itself exactly once
    // (consecutive table-row chunks share one announcement; any prose in between resets it).
    const kept = [];
    let sawTable = false;
    raw.split('\n').forEach(ln => {
      if (/^\s*\|/.test(ln)) sawTable = true;
      else if (ln.trim()) kept.push(ln);
    });
    const announceTable = sawTable && !t.inTable;
    t.inTable = sawTable;
    let s = speechSanitize(kept.join(' '));
    if (announceTable) s = (s ? s + ' ' : '') + TABLE_ANNOUNCE;
    if (!s) return;
    t.sentences.push(s);
    pump();
  }
  // Cuts complete sentences (through the LAST . ! ? or newline) out of `text`, enqueues them, and
  // returns the incomplete remainder.
  function cutSentences(t, text) {
    const m = text.match(/[\s\S]*(?:[.!?](?=\s|$)|\n)/);
    if (!m) return text;
    enqueueSentence(t, m[0]);
    return text.slice(m[0].length);
  }
  function drain(t, final) {
    for (;;) {
      const idx = t.buf.indexOf('```');
      if (idx < 0) break;
      if (!t.inFence) {
        const before = t.buf.slice(0, idx);
        if (before.trim()) enqueueSentence(t, before);
        enqueueSentence(t, CODE_ANNOUNCE);
      }
      t.buf = t.buf.slice(idx + 3);
      t.inFence = !t.inFence;
    }
    if (t.inFence) {
      // Inside a block: drop the content, keeping only a tail that could be a split ``` marker.
      if (t.buf.length > 2) t.buf = t.buf.slice(-2);
      return;
    }
    if (final) { if (t.buf.trim()) enqueueSentence(t, t.buf); t.buf = ''; }
    else t.buf = cutSentences(t, t.buf);
  }

  // ---- serial synthesis -> one WAV stream ----
  function pump() {
    const t = turn;
    if (!t || t.synthesizing) return;
    if (!t.sentences.length) { maybeEnd(t); return; }
    const tts = getTts();
    if (!tts) {   // piper not configured: silently drop the speech, the text is on screen regardless
      t.sentences.length = 0;
      maybeEnd(t);
      return;
    }
    t.synthesizing = true;
    const text = t.sentences.shift();
    Promise.resolve(synthesize({
      host: tts.host, port: tts.port, text, log: say,
      registerCancel: cancel => { t.cancelSynth = cancel; },
      onFormat: fmt => { if (turn === t) onTurnFormat(t, fmt); },
      onChunk: buf => { if (turn === t) onTurnChunk(t, buf); },
    })).catch(e => {
      if (t.aborted) return;
      say('speech sentence synth failed (skipped): ' + e.message);
      if (!t.errorNotified) {
        t.errorNotified = true;
        tellError(e.message);
      }
    })
      .then(() => {
        t.cancelSynth = null;
        t.synthesizing = false;
        if (turn === t) pump();
      });
  }
  function onTurnFormat(t, fmt) {
    if (t.headerWritten) return;   // one header per turn -- piper's format is stable per voice model
    t.headerWritten = true;
    t.format = fmt;
    if (t.res && !t.resStarted) startRes(t);
  }
  function onTurnChunk(t, buf) {
    if (t.resStarted) { try { t.res.write(buf); } catch (e) {} }
    else {
      t.pending.push(buf);
      t.pendingBytes += buf.length;
      if (t.pendingBytes > MAX_PENDING_BYTES) abortActive('no listener attached and the buffered-audio cap was hit');
    }
  }
  function startRes(t) {
    t.resStarted = true;
    try {
      // Streaming WAV: 0xFFFFFFFF-sentinel sizes, no Content-Length, no ranges -- playback simply
      // ends when the HTTP response does (same contract synthesizeClaudeVoiceSpeech already uses).
      t.res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store', 'Accept-Ranges': 'none' });
      t.res.write(wavHeader(t.format));
      for (const chunk of t.pending) t.res.write(chunk);
    } catch (e) {}
    t.pending = [];
    t.pendingBytes = 0;
  }
  function maybeEnd(t) {
    if (!t.finished || t.sentences.length || t.synthesizing) return;
    if (!t.res) {
      // Fully synthesized but no <audio> has connected yet. With real audio buffered, hold it for
      // a late attach (t.done flushes-and-ends on arrival); with nothing to play, drop the turn --
      // a late attach then 404s and the page just carries on.
      if (t.headerWritten) t.done = true;
      else turn = null;
      return;
    }
    endRes(t);
  }
  function endRes(t) {
    turn = null;   // cleared FIRST: our own end() fires the req 'close' handler, which must not read it as barge-in
    try {
      if (!t.resStarted) t.res.writeHead(204, { 'Cache-Control': 'no-store' });   // silent turn: nothing was ever spoken
      t.res.end();
    } catch (e) {}
    say('speech turn ' + t.id + ' stream ended');
  }

  // GET /claude-voice/turn-audio?turn=<id> lands here: attach the page's <audio> request to the
  // live turn stream. A stale/unknown id 404s (the page treats that as "nothing to play").
  function attach(turnId, req, res) {
    if (!turn || turn.id !== String(turnId)) {
      try { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end(); } catch (e) {}
      return;
    }
    const t = turn;
    if (t.res && t.res !== res) {
      // Chromium occasionally re-requests a media URL; the newest request wins. Already-streamed
      // audio can't be replayed (it was never buffered) -- the new stream resumes from "now".
      try { t.res.end(); } catch (e) {}
      t.resStarted = false;
    }
    t.res = res;
    req.on('close', () => {
      // The page hung up: mute, folder switch, or reload. That IS the barge-in signal.
      if (turn === t && t.res === res && !t.done) abortActive('listener closed the stream');
    });
    if (t.headerWritten && !t.resStarted) startRes(t);
    if (t.done) endRes(t);        // audio was fully buffered before the page connected: flush and finish
    else if (t.finished) maybeEnd(t);
  }

  return { beginTurn, feed, finish, abortActive, attach };
}

module.exports = { createSpeechPipeline, prepWholeSpeech };
