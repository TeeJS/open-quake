'use strict';

// voiceConfig: global TTS/STT endpoint resolution + per-page override + one-time migration of the
// legacy single-host per-page keys. Pure (no electron), so it locks in the migration-safe behavior:
// existing setups keep their exact endpoints, and inactive apps never dial out.

const test = require('node:test');
const assert = require('node:assert/strict');
const { VOICE_DEFAULTS, voiceSettings, resolveVoiceEndpoints, migrateVoiceConfig } = require('../app/voiceConfig');

test('voiceSettings fills defaults and trims', () => {
  assert.deepEqual(voiceSettings(undefined), VOICE_DEFAULTS);
  assert.deepEqual(voiceSettings({ voice: { sttHost: ' 10.0.0.5 ', sttPort: ' 1 ' } }),
    { sttHost: '10.0.0.5', sttPort: '1', ttsHost: '', ttsPort: '10200' });
});

test('resolveVoiceEndpoints returns blanks when no page is active', () => {
  assert.deepEqual(resolveVoiceEndpoints({ voice: { sttHost: 'x', ttsHost: 'y' } }, null),
    { sttHost: '', sttPort: '', ttsHost: '', ttsPort: '' });
});

test('resolveVoiceEndpoints uses the global default when the page does not override', () => {
  const settings = { voice: { sttHost: 'stt.lan', sttPort: '10300', ttsHost: 'tts.lan', ttsPort: '10200' } };
  assert.deepEqual(resolveVoiceEndpoints(settings, {}),
    { sttHost: 'stt.lan', sttPort: '10300', ttsHost: 'tts.lan', ttsPort: '10200' });
});

test('resolveVoiceEndpoints honors a per-page override', () => {
  const settings = { voice: { sttHost: 'global', sttPort: '1', ttsHost: 'global', ttsPort: '2' } };
  const page = { voiceOverride: true, voiceSttHost: 'pi', voiceSttPort: '10300', voiceTtsHost: 'pi2', voiceTtsPort: '10200' };
  assert.deepEqual(resolveVoiceEndpoints(settings, page),
    { sttHost: 'pi', sttPort: '10300', ttsHost: 'pi2', ttsPort: '10200' });
});

test('migration seeds the global from the first legacy voice page (host -> both services)', () => {
  const cfg = { grids: [{ app: 'claude-voice', options: { wyomingHost: '192.168.1.9', wyomingSttPort: '10300', wyomingTtsPort: '10200', projectDir: 'C:/x' } }] };
  migrateVoiceConfig(cfg);
  assert.deepEqual(cfg.settings.voice, { sttHost: '192.168.1.9', sttPort: '10300', ttsHost: '192.168.1.9', ttsPort: '10200' });
  // legacy keys removed, unrelated options preserved
  const o = cfg.grids[0].options;
  assert.equal('wyomingHost' in o, false);
  assert.equal('wyomingSttPort' in o, false);
  assert.equal('wyomingTtsPort' in o, false);
  assert.equal(o.projectDir, 'C:/x');
  assert.equal(o.voiceOverride, undefined);   // matches the seeded global -> inherits, no override
});

test('migration keeps a divergent second page as an explicit override', () => {
  const cfg = { grids: [
    { app: 'claude-voice', options: { wyomingHost: 'hostA', wyomingSttPort: '10300', wyomingTtsPort: '10200' } },
    { app: 'codex-voice', options: { wyomingHost: 'hostB', wyomingSttPort: '9', wyomingTtsPort: '8' } },
  ] };
  migrateVoiceConfig(cfg);
  assert.equal(cfg.settings.voice.sttHost, 'hostA');           // first page seeds the global
  const b = cfg.grids[1].options;
  assert.equal(b.voiceOverride, true);
  assert.deepEqual({ h: b.voiceSttHost, sp: b.voiceSttPort, th: b.voiceTtsHost, tp: b.voiceTtsPort },
    { h: 'hostB', sp: '9', th: 'hostB', tp: '8' });
  assert.equal('wyomingHost' in b, false);
});

test('migration is idempotent and a no-op without legacy keys', () => {
  const cfg = { settings: { voice: { sttHost: 'keep', sttPort: '10300', ttsHost: 'keep', ttsPort: '10200' } },
    grids: [{ app: 'ai-voice', options: { backend: 'claude', projectDir: 'C:/x' } }] };
  const before = JSON.stringify(cfg);
  migrateVoiceConfig(cfg);
  assert.equal(JSON.stringify(cfg), before);
});

// ---- app-id consolidation (the four voice apps -> ai-voice + per-page backend) ----

test('old voice app ids migrate to ai-voice with the matching backend', () => {
  const cfg = { grids: [
    { kind: 'app', app: 'claude-voice', options: { projectDir: 'C:/x', permissionMode: 'manual' } },
    { kind: 'app', app: 'codex-voice', options: {} },
    { kind: 'app', app: 'copilot-voice' },
    { kind: 'app', app: 'owui-voice', options: { modelPick: 'llama3' } },
    { kind: 'app', app: 'music', options: {} },
  ] };
  migrateVoiceConfig(cfg);
  assert.deepEqual(cfg.grids.map(g => g.app), ['ai-voice', 'ai-voice', 'ai-voice', 'ai-voice', 'music']);
  assert.deepEqual(cfg.grids.slice(0, 4).map(g => g.options.backend), ['claude', 'codex', 'copilot', 'owui']);
  assert.equal(cfg.grids[0].options.projectDir, 'C:/x');       // everything else carries over
  assert.equal(cfg.grids[0].options.permissionMode, 'manual');
  assert.equal(cfg.grids[3].options.modelPick, 'llama3');
});

test('ensureAiProfiles seeds once and never touches user edits', () => {
  const { ensureAiProfiles, DEFAULT_AI_PROFILES } = require('../app/voiceConfig');
  const cfg = {};
  ensureAiProfiles(cfg);
  assert.equal(cfg.settings.aiProfiles.length, DEFAULT_AI_PROFILES.length);
  assert.equal(cfg.settings.aiProfiles[0].id, 'chat');
  assert.equal(cfg.settings.aiProfiles[0].prompt, '');   // General Chat = plain behavior
  // User edits and deletions survive re-runs.
  cfg.settings.aiProfiles = [{ id: 'mine', name: 'Mine', prompt: 'be mine' }];
  ensureAiProfiles(cfg);
  assert.deepEqual(cfg.settings.aiProfiles, [{ id: 'mine', name: 'Mine', prompt: 'be mine' }]);
  // Even an emptied list stays empty (a deliberate delete-all is respected).
  cfg.settings.aiProfiles = [];
  ensureAiProfiles(cfg);
  assert.deepEqual(cfg.settings.aiProfiles, []);
});

test('resolveAiProfile falls back to the first profile for blank or deleted ids', () => {
  const { resolveAiProfile } = require('../app/voiceConfig');
  const settings = { aiProfiles: [{ id: 'a', name: 'A', prompt: 'pa' }, { id: 'b', name: 'B', prompt: 'pb' }] };
  assert.equal(resolveAiProfile(settings, 'b').prompt, 'pb');
  assert.equal(resolveAiProfile(settings, '').id, 'a');
  assert.equal(resolveAiProfile(settings, 'gone').id, 'a');
  assert.equal(resolveAiProfile({ aiProfiles: [] }, 'x').prompt, '');   // emptied library = plain chat
});

test('id migration never overwrites an existing backend and is idempotent', () => {
  const cfg = { grids: [{ kind: 'app', app: 'claude-voice', options: { backend: 'codex' } }] };
  migrateVoiceConfig(cfg);
  assert.equal(cfg.grids[0].app, 'ai-voice');
  assert.equal(cfg.grids[0].options.backend, 'codex');   // pre-set backend wins
  const before = JSON.stringify(cfg);
  migrateVoiceConfig(cfg);
  assert.equal(JSON.stringify(cfg), before);
});
