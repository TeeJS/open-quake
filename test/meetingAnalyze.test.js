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
const { createMeetingAnalyzer } = require('../app/meetingAnalyze');

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

function setup(behavior, aiSetting, finders) {
  const processed = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-an-'));
  fs.writeFileSync(path.join(processed, 'm.json'), JSON.stringify({ segments: [] }));
  const spawns = [];
  const an = createMeetingAnalyzer({
    resolveFolders: () => ({ unprocessed: processed, processed }),
    resolveAi: () => aiSetting,
    spawn: fakeSpawnFactory(spawns, behavior),
    findClaudeExe: (finders && finders.claude) || (() => 'claude.exe'),
    findCodexExe: (finders && finders.codex) || (() => 'codex.cmd'),
  });
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
    const rec = { cmd, args, opts: spawnOpts, calls: [] };
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
        rec.calls.push(m.method);
        if (m.method === 'initialize') { write({ jsonrpc: '2.0', id: m.id, result: {} }); continue; }
        if (m.method === 'session/new') { write({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'test-session' } }); continue; }
        if (m.method === 'session/set_config_option') { write({ jsonrpc: '2.0', id: m.id, result: {} }); continue; }
        if (m.method === 'session/prompt') {
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
  assert.equal(s.spawns[0].cmd, 'codex');
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
  assert.equal(spawns[0].cmd, 'copilot');
  assert.deepEqual(spawns[0].args, ['--acp']);
  assert.equal(spawns[0].opts.shell, true);
  // allow_all is set (awaited) before the prompt turn, so a batch job never waits on an approval overlay
  assert.deepEqual(spawns[0].calls, ['initialize', 'session/new', 'session/set_config_option', 'session/prompt']);
  assert.equal(fs.readFileSync(path.join(processed, 'm-analysis.md'), 'utf8'), '# Meeting Analysis\ncopilot notes');
  const st = an.getState();
  assert.equal(st.running, false);
  assert.equal(st.error, null);
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

test('result() reads the filed markdown or reports not analyzed', async () => {
  const s = setup(() => ({ stdout: 'notes', code: 0 }), 'claude');
  assert.deepEqual(s.an.result('m.json'), { ok: false, error: 'not analyzed' });
  s.an.start('m.json');
  await drained(s.an);
  assert.deepEqual(s.an.result('m.json'), { ok: true, markdown: 'notes' });
  assert.equal(s.an.result('..\\m.json').ok, false);
});
