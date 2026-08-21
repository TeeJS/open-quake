'use strict';
// meetingAnalyze: AI routing (claude vs codex vs copilot), one-at-a-time, markdown filed next to
// the transcript, and clear errors for missing CLIs / failed runs. Fake spawn, real fs in temp dirs.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMeetingAnalyzer, slimTranscript, highlightsBlock } = require('../app/meetingAnalyze');
const { normalizeOwuiUrl } = require('../app/owuiClient');

// Fake child process: capture stdin, emit stdout, exit with a code on the next tick.
function fakeSpawnFactory(spawns, behavior) {
  return (cmd, args, opts) => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.stdin = new PassThrough();
    proc.kill = () => {};
    let stdin = '';
    proc.stdin.on('data', d => { stdin += d; });
    const rec = { cmd, args, opts, get stdin() { return stdin; } };
    spawns.push(rec);
    setImmediate(() => {
      const b = behavior(rec);
      if (b.stdout) proc.stdout.write(b.stdout);
      if (b.stderr) proc.stderr.write(b.stderr);
      if (b.outFile !== undefined) {
        const of = rec.args[rec.args.indexOf('--output-last-message') + 1];
        fs.writeFileSync(of, b.outFile);
      }
      setImmediate(() => proc.emit('close', b.code || 0));   // let stream data events flush first
    });
    return proc;
  };
}

function setup(behavior, aiSetting, finders, extraDeps) {
  const processed = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-an-'));
  fs.writeFileSync(path.join(processed, 'm.json'), JSON.stringify({ segments: [] }));
  const spawns = [];
  const an = createMeetingAnalyzer(Object.assign({
    resolveFolders: () => ({ unprocessed: processed, processed }),
    resolveAi: () => aiSetting,
    spawn: fakeSpawnFactory(spawns, behavior),
    findClaudeExe: (finders && finders.claude) || (() => 'claude.exe'),
    findCodexExe: (finders && finders.codex) || (() => 'codex.cmd'),
  }, extraDeps || {}));
  return { processed, spawns, an };
}
function settle() { return new Promise(r => setTimeout(r, 50)); }
// Fake `copilot --acp`: a minimal ACP JSON-RPC responder over the same PassThrough-based fake
// process shape as fakeSpawnFactory, but request/response driven (copilot's session/prompt only
// resolves at end of turn -- see copilotvoice-session.js's runCopilotBatchPrompt) rather than a
// single canned stdout blob. Reads newline-delimited JSON-RPC off stdin as it arrives and replies
// to initialize / session/new / session/set_config_option / session/prompt in turn, emitting one
// agent_message_chunk session/update before the final session/prompt response.
function fakeCopilotAcpSpawnFactory(spawns, opts) {
  opts = opts || {};
  return (cmd, args, spawnOpts) => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.stdin = new PassThrough();
    proc.kill = () => {};
    const rec = { cmd, args, opts: spawnOpts, calls: [], responses: [] };
    spawns.push(rec);
    let buf = '';
    const write = obj => proc.stdout.write(JSON.stringify(obj) + '\n');
    proc.stdin.on('data', d => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch (e) { continue; }
        if (m.method == null && m.id != null) { rec.responses.push(m); continue; }   // client's reply to a server request
        rec.calls.push(m.method);
        if (m.method === 'initialize') { write({ jsonrpc: '2.0', id: m.id, result: {} }); continue; }
        if (m.method === 'session/new') { write({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'test-session' } }); continue; }
        if (m.method === 'session/set_config_option') { write({ jsonrpc: '2.0', id: m.id, result: {} }); continue; }
        if (m.method === 'session/prompt') {
          if (opts.requestPermission) {
            // Server-initiated permission request offering ONLY allow options — the batch client
            // must still fail closed (cancelled), never select an allow option.
            write({ jsonrpc: '2.0', id: 99, method: 'session/request_permission', params: { options: [{ kind: 'allow_once', optionId: 'a1' }, { kind: 'allow_always', optionId: 'a2' }] } });
          }
          write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'test-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: opts.text || '' } } } });
          write({ jsonrpc: '2.0', id: m.id, result: { stopReason: opts.stopReason || 'end_turn' } });
        }
      }
    });
    return proc;
  };
}
// Wait until the analyzer is fully idle (fixed delays are flaky when the suite runs files in parallel).
async function drained(an, timeoutMs = 3000) {
  const t0 = Date.now();
  for (;;) {
    const st = an.getState();
    if (!st.running && !(st.queue || []).length) return;
    if (Date.now() - t0 > timeoutMs) throw new Error('analyzer never drained');
    await new Promise(r => setTimeout(r, 20));
  }
}

test('claude route: -p, transcript on stdin, stdout filed as .md', async () => {
  const s = setup(() => ({ stdout: '# Meeting Analysis\nok', code: 0 }), 'claude');
  assert.equal(s.an.start('m.json').ok, true);
  await drained(s.an);
  assert.equal(s.spawns[0].cmd, 'claude.exe');
  assert.deepEqual(s.spawns[0].args, ['-p']);
  assert.match(s.spawns[0].stdin, /Meeting Analysis/);        // prompt text
  assert.match(s.spawns[0].stdin, /"segments"/);              // transcript JSON
  assert.equal(fs.readFileSync(path.join(s.processed, 'm-analysis.md'), 'utf8'), '# Meeting Analysis\nok');
  const st = s.an.getState();
  assert.equal(st.running, false);
  assert.equal(st.error, null);
  assert.equal(st.lastDone.name, 'm.json');
});

test('codex route: exec with stdin marker + output-last-message file', async () => {
  const s = setup(() => ({ outFile: 'codex analysis', code: 0 }), 'codex');
  s.an.start('m.json');
  await drained(s.an);
  assert.equal(s.spawns[0].cmd, '"codex.cmd"');   // resolved path, quoted for the shell
  assert.equal(s.spawns[0].args[0], 'exec');
  assert.equal(s.spawns[0].args[1], '-');
  assert.ok(s.spawns[0].args.includes('--skip-git-repo-check'));
  assert.equal(s.spawns[0].opts.shell, true);
  assert.equal(fs.readFileSync(path.join(s.processed, 'm-analysis.md'), 'utf8'), 'codex analysis');
});

test('copilot route: one-shot ACP session, agent_message_chunk filed as .md', async () => {
  const processed = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-an-cop-'));
  fs.writeFileSync(path.join(processed, 'm.json'), JSON.stringify({ segments: [] }));
  const spawns = [];
  const an = createMeetingAnalyzer({
    resolveFolders: () => ({ unprocessed: processed, processed }),
    resolveAi: () => 'copilot',
    spawn: fakeCopilotAcpSpawnFactory(spawns, { text: '# Meeting Analysis\ncopilot notes' }),
    findClaudeExe: () => null, findCodexExe: () => null, findCopilotExe: () => 'copilot.cmd',
  });
  assert.equal(an.start('m.json').ok, true);
  await drained(an);
  assert.equal(spawns[0].cmd, '"copilot.cmd"');   // resolved path, quoted for the shell
  assert.deepEqual(spawns[0].args, ['--acp']);
  assert.equal(spawns[0].opts.shell, true);
  // NO allow_all: batch analysis runs with tools denied (untrusted transcript input)
  assert.deepEqual(spawns[0].calls, ['initialize', 'session/new', 'session/prompt']);
  assert.equal(spawns[0].opts.cwd, os.tmpdir());   // neutral cwd, never the app's
  assert.equal(fs.readFileSync(path.join(processed, 'm-analysis.md'), 'utf8'), '# Meeting Analysis\ncopilot notes');
  const st = an.getState();
  assert.equal(st.running, false);
  assert.equal(st.error, null);
});

test('copilot batch rejects permission requests — even when only allow options are offered', async () => {
  const processed = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-an-cop3-'));
  fs.writeFileSync(path.join(processed, 'm.json'), JSON.stringify({ segments: [] }));
  const spawns = [];
  const an = createMeetingAnalyzer({
    resolveFolders: () => ({ unprocessed: processed, processed }),
    resolveAi: () => 'copilot',
    spawn: fakeCopilotAcpSpawnFactory(spawns, { text: 'notes', requestPermission: true }),
    findClaudeExe: () => null, findCodexExe: () => null, findCopilotExe: () => 'copilot.cmd',
  });
  an.start('m.json');
  await drained(an);
  const permReply = spawns[0].responses.find(r => r.id === 99);
  assert.ok(permReply, 'client must answer the permission request');
  assert.equal(permReply.result.outcome.outcome, 'cancelled');   // fail closed, never an allow option
  assert.equal(fs.readFileSync(path.join(processed, 'm-analysis.md'), 'utf8'), 'notes');   // turn still completes
});

test('missing copilot CLI is a clear error; nothing spawned', async () => {
  const processed = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-an-cop2-'));
  fs.writeFileSync(path.join(processed, 'm.json'), '{}');
  const spawns = [];
  const an = createMeetingAnalyzer({
    resolveFolders: () => ({ unprocessed: processed, processed }),
    resolveAi: () => 'copilot',
    spawn: fakeCopilotAcpSpawnFactory(spawns, {}),
    findClaudeExe: () => null, findCodexExe: () => null, findCopilotExe: () => null,
  });
  an.start('m.json');
  await drained(an);
  assert.equal(spawns.length, 0);
  assert.match(an.getState().error.error, /Copilot CLI not found/);
  assert.equal(fs.existsSync(path.join(processed, 'm-analysis.md')), false);
});

test('missing CLI is a clear error; nothing spawned', async () => {
  const s = setup(() => ({ code: 0 }), 'claude', { claude: () => null });
  s.an.start('m.json');
  await drained(s.an);
  assert.equal(s.spawns.length, 0);
  assert.match(s.an.getState().error.error, /Claude CLI not found/);
  assert.equal(fs.existsSync(path.join(s.processed, 'm-analysis.md')), false);
});

test('nonzero exit surfaces stderr; no .md written', async () => {
  const s = setup(() => ({ stderr: 'boom', code: 2 }), 'claude');
  s.an.start('m.json');
  await drained(s.an);
  assert.match(s.an.getState().error.error, /exited 2: boom/);
  assert.equal(fs.existsSync(path.join(s.processed, 'm-analysis.md')), false);
});

test('queue: second transcript waits its turn; rel-path names work', async () => {
  const processed = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-anq-'));
  fs.mkdirSync(path.join(processed, '2026', '08'), { recursive: true });
  fs.writeFileSync(path.join(processed, 'a.json'), '{}');
  fs.writeFileSync(path.join(processed, '2026', '08', 'b.json'), '{}');
  const spawns = [];
  const an = createMeetingAnalyzer({
    resolveFolders: () => ({ unprocessed: processed, processed }),
    resolveAi: () => 'claude',
    findClaudeExe: () => 'claude.exe', findCodexExe: () => null,
    spawn: fakeSpawnFactory(spawns, () => ({ stdout: 'notes', code: 0 })),
  });
  assert.equal(an.start('a.json').ok, true);
  const second = an.start('2026/08/b.json');
  assert.equal(second.ok, true);                       // queued, not rejected
  assert.deepEqual(second.queue, ['2026/08/b.json']);
  assert.equal(an.start('2026/08/b.json').ok, false);  // dedupe
  await drained(an);
  assert.equal(an.getState().running, false);
  assert.deepEqual(an.getState().queue, []);
  assert.equal(fs.existsSync(path.join(processed, 'a-analysis.md')), true);
  assert.equal(fs.existsSync(path.join(processed, '2026', '08', 'b-analysis.md')), true);
  assert.deepEqual(an.result('2026/08/b.json'), { ok: true, markdown: 'notes' });
});

test('suffixed transcript names produce clean .md names', async () => {
  const processed = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-ansuf-'));
  fs.writeFileSync(path.join(processed, 'meeting-diarizer-response.json'), '{}');
  const an = createMeetingAnalyzer({
    resolveFolders: () => ({ unprocessed: processed, processed }),
    resolveAi: () => 'claude',
    findClaudeExe: () => 'claude.exe', findCodexExe: () => null,
    spawn: fakeSpawnFactory([], () => ({ stdout: 'notes', code: 0 })),
  });
  an.start('meeting-diarizer-response.json');
  await drained(an);
  assert.equal(fs.existsSync(path.join(processed, 'meeting-analysis.md')), true);   // suffix stripped
  assert.deepEqual(an.result('meeting-diarizer-response.json'), { ok: true, markdown: 'notes' });
});

test('post-analysis task list: one dated checklist per batch, pointing at -analysis.md files', async () => {
  const processed = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-antl-'));
  const dir = path.join(processed, '2026', '08');
  fs.mkdirSync(dir, { recursive: true });
  // one meeting with calendar metadata (recurring), one without
  fs.writeFileSync(path.join(dir, 'a-diarizer-response.json'), '{"segments":[]}');
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ subject: 'Weekly Sync', is_recurring: true, organizer: 'David Mastalski' }));
  fs.writeFileSync(path.join(dir, 'b-diarizer-response.json'), '{"segments":[]}');
  const taskDir = path.join(processed, 'lists');
  const an = createMeetingAnalyzer({
    resolveFolders: () => ({ unprocessed: processed, processed }),
    resolveAi: () => 'claude',
    findClaudeExe: () => 'claude.exe', findCodexExe: () => null,
    resolveTaskList: () => ({ enabled: true, folder: taskDir }),
    now: () => new Date(2026, 7, 17, 10, 42, 13).getTime(),
    spawn: fakeSpawnFactory([], () => ({ stdout: 'notes', code: 0 })),
  });
  an.start('2026/08/a-diarizer-response.json');
  an.start('2026/08/b-diarizer-response.json');
  await drained(an);
  await settle();
  const listPath = path.join(taskDir, '2026-08-17_10-42-13.md');
  const body = fs.readFileSync(listPath, 'utf8');
  assert.match(body, /^# Analysis batch — 2026-08-17 10:42:13/);
  assert.match(body, /2 meeting\(s\) analyzed\./);
  assert.match(body, /- \[ \] \*\*Weekly Sync\*\* \(recurring\) — David Mastalski/);
  assert.match(body, /    - Analysis: `2026\/08\/a-analysis\.md`/);
  assert.match(body, /    - Meeting metadata: `2026\/08\/a\.json`/);
  assert.match(body, /- \[ \] \*\*b\*\*\n    - Analysis: `2026\/08\/b-analysis\.md`/);   // no metadata line without a sidecar
  // a second batch writes a SECOND list (collision-suffixed under the frozen clock), not an overwrite
  fs.writeFileSync(path.join(dir, 'c-diarizer-response.json'), '{"segments":[]}');
  an.start('2026/08/c-diarizer-response.json');
  await drained(an);
  await settle();
  assert.equal(fs.existsSync(path.join(taskDir, '2026-08-17_10-42-13_1.md')), true);
});

test('task list disabled: nothing written', async () => {
  const s = setup(() => ({ stdout: 'notes', code: 0 }), 'claude');
  s.an.start('m.json');
  await drained(s.an);
  await settle();
  const files = fs.readdirSync(s.processed).filter(n => /^\d{4}-\d{2}-\d{2}_/.test(n));
  assert.deepEqual(files, []);
});

test('one at a time; bad names and missing transcripts rejected up front', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const processed = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-an2-'));
  fs.writeFileSync(path.join(processed, 'm.json'), '{}');
  const an = createMeetingAnalyzer({
    resolveFolders: () => ({ unprocessed: processed, processed }),
    resolveAi: () => 'claude',
    findClaudeExe: () => 'claude.exe',
    findCodexExe: () => null,
    spawn: () => {
      const proc = new EventEmitter();
      proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.stdin = new PassThrough();
      proc.kill = () => {};
      gate.then(() => { proc.stdout.write('done'); setImmediate(() => proc.emit('close', 0)); });
      return proc;
    },
  });
  assert.equal(an.start('..\\m.json').ok, false);
  assert.equal(an.start('m.wav').ok, false);
  assert.equal(an.start('missing.json').ok, false);
  assert.equal(an.start('m.json').ok, true);
  assert.equal(an.start('m.json').ok, false);       // busy
  release();
  await drained(an);
  assert.equal(an.getState().running, false);
});

const COMBINED_MD = '# Meeting Analysis\n\n## Summary\nStuff happened.\n\n## Transcript\n**T.J.:** hello\n\n**A:** hi\n';

function filingSetup(opts, meta, baseName) {
  const processed = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-anfile-'));
  const dir = path.join(processed, '2026', '08');
  fs.mkdirSync(dir, { recursive: true });
  const base = baseName || '2026-08-15_10-00-00-Weekly Sync';
  fs.writeFileSync(path.join(dir, base + '-diarizer-response.json'), '{"segments":[]}');
  fs.writeFileSync(path.join(dir, base + '.wav'), 'WAV');
  if (meta) fs.writeFileSync(path.join(dir, base + '.json'), JSON.stringify(meta));
  const an = createMeetingAnalyzer({
    resolveFolders: () => ({ unprocessed: processed, processed }),
    resolveAi: () => 'claude',
    findClaudeExe: () => 'claude.exe', findCodexExe: () => null,
    filingOptions: () => opts,
    spawn: fakeSpawnFactory([], () => ({ stdout: COMBINED_MD, code: 0 })),
  });
  return { processed, dir, base, an, rel: '2026/08/' + base + '-diarizer-response.json' };
}

test('Separate Clean Transcript splits the output at ## Transcript', async () => {
  const s = filingSetup({ separateTranscript: true }, null);
  s.an.start(s.rel);
  await drained(s.an);
  const md = fs.readFileSync(path.join(s.dir, s.base + '-analysis.md'), 'utf8');
  assert.ok(!/## Transcript/.test(md), 'md keeps the notes only');
  assert.match(md, /## Summary/);
  const txt = fs.readFileSync(path.join(s.dir, s.base + '-clean_transcript.txt'), 'utf8');
  assert.match(txt, /\*\*T\.J\.\*\*: hello|\*\*T\.J\.:\*\* hello/);
});

test('recurring meetings move to YYYY/<Meeting-Name>/ after analysis', async () => {
  const s = filingSetup({ separateRecurring: true }, { subject: 'Weekly Sync / Team', is_recurring: true });
  s.an.start(s.rel);
  await drained(s.an);
  const home = path.join(s.processed, '2026', 'Weekly-Sync-Team');   // OpenHiNotes sanitization
  assert.equal(fs.existsSync(path.join(home, s.base + '-analysis.md')), true);
  assert.equal(fs.existsSync(path.join(home, s.base + '.wav')), true);
  assert.equal(fs.existsSync(path.join(home, s.base + '-diarizer-response.json')), true);
  assert.equal(fs.existsSync(path.join(home, s.base + '.json')), true);
  assert.equal(fs.existsSync(path.join(s.dir, s.base + '.wav')), false);   // left the date folder
});

test('non-recurring (or no sidecar) stays in the date folder even with the option on', async () => {
  const s = filingSetup({ separateRecurring: true }, { subject: 'One-off', is_recurring: false });
  s.an.start(s.rel);
  await drained(s.an);
  assert.equal(fs.existsSync(path.join(s.dir, s.base + '-analysis.md')), true);
  assert.equal(fs.existsSync(path.join(s.dir, s.base + '.wav')), true);
});

test('Use Details Folder tucks everything but the .md into details/', async () => {
  const s = filingSetup({ useDetailsFolder: true, separateTranscript: true }, { subject: 'X', is_recurring: false });
  s.an.start(s.rel);
  await drained(s.an);
  assert.equal(fs.existsSync(path.join(s.dir, s.base + '-analysis.md')), true);                       // md at folder level
  const det = path.join(s.dir, 'details');
  assert.equal(fs.existsSync(path.join(det, s.base + '.wav')), true);
  assert.equal(fs.existsSync(path.join(det, s.base + '-diarizer-response.json')), true);
  assert.equal(fs.existsSync(path.join(det, s.base + '.json')), true);
  assert.equal(fs.existsSync(path.join(det, s.base + '-clean_transcript.txt')), true);
  // re-analysis from the details location writes the .md back at the folder level and stays put
  const an2rel = '2026/08/details/' + s.base + '-diarizer-response.json';
  const r = s.an.start(an2rel);
  assert.equal(r.ok, true);
  await drained(s.an);
  assert.equal(fs.existsSync(path.join(s.dir, s.base + '-analysis.md')), true);
  assert.equal(fs.existsSync(path.join(det, s.base + '-diarizer-response.json')), true);
  // and View resolves the parent-level md from the details-relative name
  assert.equal(s.an.result(an2rel).ok, true);
});

test('recurring + details compose: YYYY/<Name>/details with md at the folder level', async () => {
  const s = filingSetup({ separateRecurring: true, useDetailsFolder: true }, { subject: 'Weekly Sync', is_recurring: true });
  s.an.start(s.rel);
  await drained(s.an);
  const home = path.join(s.processed, '2026', 'Weekly-Sync');
  assert.equal(fs.existsSync(path.join(home, s.base + '-analysis.md')), true);
  assert.equal(fs.existsSync(path.join(home, 'details', s.base + '.wav')), true);
  assert.equal(fs.existsSync(path.join(home, 'details', s.base + '-diarizer-response.json')), true);
});

// ---- Open WebUI backend: HTTP chat completion against the Auth-tab connection, slimmed input ----

const OWUI_SEGMENTS = { speaker_report: { speaker_count: 2 }, segments: [
  { speaker: 'T.J. Schmitz', start: 1, end: 2, text: 'hello there' },
  { speaker: 'T.J. Schmitz', start: 2, end: 3, text: 'still me' },      // consecutive — merges
  { speaker: 'Speaker A', start: 3, end: 4, text: 'hi back' },
  { speaker: '', start: 4, end: 5, text: 'who said this' },             // blank speaker -> UNKNOWN
] };

function owuiSetup(owuiCfg, postJsonImpl) {
  const processed = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-anow-'));
  fs.writeFileSync(path.join(processed, 'm-diarizer-response.json'), JSON.stringify(OWUI_SEGMENTS));
  const calls = [];
  const spawns = [];
  const an = createMeetingAnalyzer({
    resolveFolders: () => ({ unprocessed: processed, processed }),
    resolveAi: () => 'owui',
    resolveOwui: () => owuiCfg,
    owuiClient: {
      normalizeOwuiUrl,
      postJson: (url, body, apiKey, timeoutMs) => { calls.push({ url, body, apiKey, timeoutMs }); return postJsonImpl(); },
    },
    findClaudeExe: () => 'claude.exe', findCodexExe: () => null, findCopilotExe: () => null,
    spawn: fakeSpawnFactory(spawns, () => ({ stdout: 'claude notes', code: 0 })),
  });
  return { processed, an, calls, spawns };
}
const owuiOk = content => () => Promise.resolve({ status: 200, text: JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }) });

test('owui route: one POST to /api/chat/completions with the slimmed transcript, filed as .md', async () => {
  const s = owuiSetup({ url: 'http://box:3000/', apiKey: 'sk-test', model: 'llama3.2' }, owuiOk('# OWUI notes'));
  assert.equal(s.an.start('m-diarizer-response.json').ok, true);
  await drained(s.an);
  assert.equal(s.spawns.length, 0);                          // no CLI fallthrough on the owui path
  assert.equal(s.calls.length, 1);
  const c = s.calls[0];
  assert.equal(c.url, 'http://box:3000/api/chat/completions');
  assert.equal(c.apiKey, 'sk-test');
  assert.equal(c.body.model, 'llama3.2');
  assert.equal(c.body.stream, false);
  assert.equal(c.body.messages[0].role, 'system');
  assert.match(c.body.messages[0].content, /Meeting Analysis/);          // the shared prompt file
  const user = c.body.messages[1];
  assert.equal(user.role, 'user');
  assert.match(user.content, /^Transcript follows:\n\n/);
  assert.match(user.content, /T\.J\. Schmitz: hello there still me/);    // consecutive merged
  assert.match(user.content, /Speaker A: hi back/);
  assert.match(user.content, /UNKNOWN: who said this/);
  assert.ok(!user.content.includes('"segments"'), 'raw JSON keys must not reach the model');
  assert.ok(!user.content.includes('{'), 'no JSON braces in the slimmed transcript');
  assert.equal(fs.readFileSync(path.join(s.processed, 'm-analysis.md'), 'utf8'), '# OWUI notes');
  assert.equal(s.an.getState().error, null);
});

test('owui not configured: clear error, no request, no claude fallthrough', async () => {
  const s = owuiSetup({ url: '', apiKey: '', model: 'llama3' }, owuiOk('x'));
  s.an.start('m-diarizer-response.json');
  await drained(s.an);
  assert.equal(s.calls.length, 0);
  assert.equal(s.spawns.length, 0);
  assert.match(s.an.getState().error.error, /not configured.*Auth tab/);
  assert.equal(fs.existsSync(path.join(s.processed, 'm-analysis.md')), false);
});

test('owui 401 names the API key and the Auth tab', async () => {
  const s = owuiSetup({ url: 'http://box:3000', apiKey: 'bad', model: 'llama3' },
    () => Promise.resolve({ status: 401, text: '{"detail":"unauthorized"}' }));
  s.an.start('m-diarizer-response.json');
  await drained(s.an);
  assert.match(s.an.getState().error.error, /rejected the API key.*check the key on the Auth tab/);
  assert.equal(fs.existsSync(path.join(s.processed, 'm-analysis.md')), false);
});

test('owui finish_reason length fails loudly — never a silently truncated analysis', async () => {
  const s = owuiSetup({ url: 'http://box:3000', apiKey: 'k', model: 'small' },
    () => Promise.resolve({ status: 200, text: JSON.stringify({ choices: [{ message: { content: 'half an analy' }, finish_reason: 'length' }] }) }));
  s.an.start('m-diarizer-response.json');
  await drained(s.an);
  assert.match(s.an.getState().error.error, /context window is too small/);
  assert.equal(fs.existsSync(path.join(s.processed, 'm-analysis.md')), false);
});

test('owui connection failure asks whether the server is running', async () => {
  const s = owuiSetup({ url: 'http://box:3000', apiKey: 'k', model: 'llama3' },
    () => Promise.reject(new Error('connect ECONNREFUSED 1.2.3.4:3000')));
  s.an.start('m-diarizer-response.json');
  await drained(s.an);
  assert.match(s.an.getState().error.error, /is Open WebUI running\?/);
});

test('owui 200-with-error body and empty output are both errors', async () => {
  const s = owuiSetup({ url: 'http://box:3000', apiKey: 'k', model: 'llama3' },
    () => Promise.resolve({ status: 200, text: JSON.stringify({ error: { message: 'model not found' } }) }));
  s.an.start('m-diarizer-response.json');
  await drained(s.an);
  assert.match(s.an.getState().error.error, /model not found/);
});

test('slimTranscript: merges, defaults, and loud failures', () => {
  assert.equal(slimTranscript(JSON.stringify(OWUI_SEGMENTS)),
    'T.J. Schmitz: hello there still me\nSpeaker A: hi back\nUNKNOWN: who said this');
  assert.throws(() => slimTranscript('not json'), /not valid JSON/);
  assert.throws(() => slimTranscript('{"no":"segments"}'), /no segments array/);
  assert.throws(() => slimTranscript('{"segments":[]}'), /no spoken segments/);
  assert.throws(() => slimTranscript(JSON.stringify({ segments: [{ speaker: 'A', text: '   ' }] })), /no spoken segments/);
});

test('result() reads the filed markdown or reports not analyzed', async () => {
  const s = setup(() => ({ stdout: 'notes', code: 0 }), 'claude');
  assert.deepEqual(s.an.result('m.json'), { ok: false, error: 'not analyzed' });
  s.an.start('m.json');
  await drained(s.an);
  assert.deepEqual(s.an.result('m.json'), { ok: true, markdown: 'notes' });
  assert.equal(s.an.result('..\\m.json').ok, false);
});

test('joplin: note created after a successful analysis with the analysis markdown', async () => {
  const notes = [];
  const s = setup(() => ({ stdout: '# Meeting Analysis\nnotes\n## Transcript\ndialogue', code: 0 }), 'claude', null, {
    resolveJoplin: () => ({ enabled: true, url: 'box:41184', token: 'tok', notebook: 'NW Pipe' }),
    joplinNotes: { createAnalysisNote: async args => { notes.push(args); return { id: 'n1', applied: ['meeting notes'], skipped: [] }; } },
    filingOptions: () => ({ separateTranscript: true }),
  });
  s.an.start('m.json');
  await drained(s.an);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, 'm');
  assert.equal(notes[0].notebook, 'NW Pipe');
  assert.match(notes[0].body, /# Meeting Analysis/);
  assert.doesNotMatch(notes[0].body, /dialogue/);   // separate-transcript: note body is notes only
  assert.equal(s.an.getState().joplin.ok, true);
});

test('joplin: disabled -> never called; failure -> analysis still succeeds, surfaced in state', async () => {
  let calls = 0;
  const off = setup(() => ({ stdout: 'notes', code: 0 }), 'claude', null, {
    resolveJoplin: () => ({ enabled: false }),
    joplinNotes: { createAnalysisNote: async () => { calls++; return { id: 'n', applied: [], skipped: [] }; } },
  });
  off.an.start('m.json');
  await drained(off.an);
  assert.equal(calls, 0);
  assert.equal(off.an.getState().joplin, null);

  const fail = setup(() => ({ stdout: 'notes', code: 0 }), 'claude', null, {
    resolveJoplin: () => ({ enabled: true, url: 'box:41184', token: 'tok', notebook: 'NW Pipe' }),
    joplinNotes: { createAnalysisNote: async () => { throw new Error('could not reach Joplin'); } },
  });
  fail.an.start('m.json');
  await drained(fail.an);
  const st = fail.an.getState();
  assert.equal(st.error, null);                     // the analysis itself is fine
  assert.equal(st.lastDone.name, 'm.json');
  assert.equal(st.joplin.ok, false);
  assert.match(st.joplin.error, /could not reach Joplin/);
  assert.equal(fs.readFileSync(path.join(fail.processed, 'm-analysis.md'), 'utf8'), 'notes');
});

test('companion metadata + VTT ride along in the CLI input; legacy name never self-includes', async () => {
  const s = setup(() => ({ stdout: 'notes', code: 0 }), 'claude');
  fs.writeFileSync(path.join(s.processed, 'x-diarizer-response.json'), JSON.stringify({ segments: [] }));
  fs.writeFileSync(path.join(s.processed, 'x.json'), JSON.stringify({ subject: 'Weekly sync', organizer: 'T.J.' }));
  // separator drift in the stamp prefix: JSON uses "-", the Teams VTT "_" — still matched
  fs.writeFileSync(path.join(s.processed, '2026-08-19-09-57-16-Sync-diarizer-response.json'), JSON.stringify({ segments: [] }));
  fs.writeFileSync(path.join(s.processed, '2026-08-19_09-57-16-Sync.vtt'), 'WEBVTT\n<v T.J. Schmitz>hi</v>');

  s.an.start('x-diarizer-response.json');
  await drained(s.an);
  assert.match(s.spawns[0].stdin, /Meeting metadata JSON follows/);
  assert.match(s.spawns[0].stdin, /Weekly sync/);
  assert.doesNotMatch(s.spawns[0].stdin, /VTT transcript follows/);   // no .vtt for this one

  s.an.start('2026-08-19-09-57-16-Sync-diarizer-response.json');
  await drained(s.an);
  assert.match(s.spawns[1].stdin, /VTT transcript follows/);
  assert.match(s.spawns[1].stdin, /WEBVTT/);

  s.an.start('m.json');   // legacy plain name: <base>.json IS the transcript — no fake metadata
  await drained(s.an);
  assert.doesNotMatch(s.spawns[2].stdin, /Meeting metadata JSON follows/);
});

// ---- mid-meeting highlights ----

test('highlightsBlock converts ms spans to seconds + mm:ss, and asks for the section', () => {
  const block = highlightsBlock(JSON.stringify({
    subject: 'Weekly sync',
    highlights: [{ startMs: 30000, endMs: 75000 }, { startMs: 605000, endMs: 640500 }],
  }));
  assert.match(block, /0:30–1:15/);
  assert.match(block, /seconds 30\.0–75\.0/);
  assert.match(block, /10:05–10:41/);   // 640.5s rounds to 641 = 10:41
  assert.match(block, /seconds 605\.0–640\.5/);
  assert.match(block, /"## Highlights" section/);
  assert.match(block, /immediately after ## Summary/);
});

test('highlightsBlock returns null for absent, empty, or malformed spans', () => {
  assert.equal(highlightsBlock(null), null);
  assert.equal(highlightsBlock('{ not json'), null);
  assert.equal(highlightsBlock(JSON.stringify({ subject: 'x' })), null);
  assert.equal(highlightsBlock(JSON.stringify({ highlights: [] })), null);
  // a reversed or non-numeric span is dropped; a block of nothing is no block at all
  assert.equal(highlightsBlock(JSON.stringify({ highlights: [{ startMs: 900, endMs: 100 }] })), null);
  assert.equal(highlightsBlock(JSON.stringify({ highlights: [{ startMs: 'a', endMs: 'b' }] })), null);
});

test('highlights ride along in the CLI input when the sidecar carries them', async () => {
  const s = setup(() => ({ stdout: 'notes', code: 0 }), 'claude');
  fs.writeFileSync(path.join(s.processed, 'h-diarizer-response.json'), JSON.stringify({ segments: [] }));
  fs.writeFileSync(path.join(s.processed, 'h.json'), JSON.stringify({
    subject: 'Weekly sync', highlights: [{ startMs: 12000, endMs: 48000 }],
  }));
  s.an.start('h-diarizer-response.json');
  await drained(s.an);
  assert.match(s.spawns[0].stdin, /Highlighted moments follow/);
  assert.match(s.spawns[0].stdin, /0:12–0:48/);
});

test('a sidecar without highlights adds no highlight block', async () => {
  const s = setup(() => ({ stdout: 'notes', code: 0 }), 'claude');
  fs.writeFileSync(path.join(s.processed, 'p-diarizer-response.json'), JSON.stringify({ segments: [] }));
  fs.writeFileSync(path.join(s.processed, 'p.json'), JSON.stringify({ subject: 'Weekly sync' }));
  s.an.start('p-diarizer-response.json');
  await drained(s.an);
  assert.match(s.spawns[0].stdin, /Meeting metadata JSON follows/);
  assert.doesNotMatch(s.spawns[0].stdin, /Highlighted moments follow/);
});

test('slimTranscript stamps turns only when asked', () => {
  const json = JSON.stringify({ segments: [
    { speaker: 'T.J. Schmitz', start: 65.4, end: 70, text: 'first' },
    { speaker: 'T.J. Schmitz', start: 70, end: 72, text: 'still me' },
    { speaker: 'Speaker A', start: 130.9, end: 134, text: 'their turn' },
  ] });
  assert.equal(slimTranscript(json), 'T.J. Schmitz: first still me\nSpeaker A: their turn');
  // stamped form keeps the FIRST segment's start for a merged run
  assert.equal(slimTranscript(json, true), '[1:05] T.J. Schmitz: first still me\n[2:11] Speaker A: their turn');
});
