'use strict';
// lucidtypeAI.js — LucidType cleanup/rewrite text transform (MAIN PROCESS).
//
// Given a system prompt + the user's text, returns the transformed text. Default path is the same
// integrated agents the meeting analysis uses — Claude (`claude -p`), Codex (`codex exec`), Copilot
// (ACP one-shot), or Open WebUI (HTTP chat completion). The "Use Endpoint" override instead POSTs
// straight to an OpenAI-compatible `/chat/completions` endpoint (like the standalone LucidType).
// Deps are injected for tests (spawn, exe finders, owuiClient).

const path = require('path');
const os = require('os');
const fsp = require('fs').promises;
const { runCopilotBatchPrompt } = require('./copilotvoice-session');
const owuiClientMod = require('./owuiClient');

// Built-in prompts. Cleanup is a single editable system prompt (default below). Rewrite ships three
// preset styles (only "Custom" is user-edited — see the editor); each ends "output only the text".
const DEFAULT_CLEANUP_PROMPT =
  "Fix the grammar, spelling, and punctuation in the user's text. Preserve the author's original " +
  "wording, tone, and voice as much as possible. Remove filler words (uh, er, ah, um, mm, like when " +
  "unnecessary), combine fragmented or run-on sentences into clear ones, and drop false starts and " +
  "repeated words, while keeping the original meaning and voice. Output only the corrected text, with " +
  "no preamble, quotes, or explanation.";
const REWRITE_PRESETS = {
  professional:
    "Rewrite the user's text in a clear, professional tone suitable for workplace communication. Fix " +
    "grammar and punctuation, keep the original meaning, and avoid slang. Output only the rewritten text.",
  concise:
    "Rewrite the user's text to be as concise as possible without losing meaning. Cut redundancy and " +
    "filler; keep it clear and correct. Output only the rewritten text.",
  confident:
    "Rewrite the user's text in a confident, direct, assertive tone. Remove hedging and qualifiers, fix " +
    "grammar, and keep the original meaning. Output only the rewritten text.",
};
function rewritePromptFor(mode, customPrompt) {
  if (mode === 'custom') return String(customPrompt || '').trim() || REWRITE_PRESETS.professional;
  return REWRITE_PRESETS[mode] || REWRITE_PRESETS.professional;
}

function createLucidAI(deps) {
  const d = deps || {};
  const spawnImpl = d.spawn || require('child_process').spawn;
  const owuiClient = d.owuiClient || owuiClientMod;
  const log = d.log || (() => {});
  const now = d.now || Date.now;

  // opts: { useEndpoint, endpoint, endpointKey, backend, model, timeoutMs, owui:{url,apiKey,model} }
  async function transform(systemPrompt, userText, opts) {
    opts = opts || {};
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 30000;
    const text = String(userText == null ? '' : userText);
    const sys = String(systemPrompt || '').trim();
    if (!text.trim()) throw new Error('nothing to transform');

    if (opts.useEndpoint) return runEndpoint(sys, text, opts, timeoutMs);
    const backend = opts.backend === 'codex' ? 'codex' : opts.backend === 'copilot' ? 'copilot' : opts.backend === 'owui' ? 'owui' : 'claude';
    if (backend === 'owui') return runOwui(sys, text, opts, timeoutMs);
    // CLI agents read one combined prompt (no system/user split).
    const combined = sys + '\n\nText:\n' + text;
    if (backend === 'codex') return (await runCodex(combined, timeoutMs)).trim();
    if (backend === 'copilot') {
      const exe = (d.findCopilotExe || require('./copilotvoice-session').findCopilotExe)();
      if (!exe) throw new Error('Copilot CLI not found on PATH');
      return String(await runCopilotBatchPrompt({ text: combined, timeoutMs, log, spawn: spawnImpl, exe })).trim();
    }
    return (await runClaude(combined, timeoutMs)).trim();
  }

  async function runEndpoint(sys, text, opts, timeoutMs) {
    const base = String(opts.endpoint || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('no endpoint URL set (LucidType → AI → Use Endpoint)');
    const model = String(opts.model || '').trim();
    if (!model) throw new Error('no model set — tick "Override model" and enter one for the endpoint');
    const body = { model, stream: false, temperature: 0.2, messages: [{ role: 'system', content: sys }, { role: 'user', content: text }] };
    let res;
    try { res = await owuiClient.postJson(base + '/chat/completions', body, String(opts.endpointKey || ''), timeoutMs); }
    catch (e) { throw new Error('endpoint request failed: ' + ((e && e.message) || e)); }
    return parseChat(res, 'The endpoint');
  }

  async function runOwui(sys, text, opts, timeoutMs) {
    const cfg = opts.owui || {};
    const ep = owuiClient.normalizeOwuiUrl(cfg.url);
    if (!ep) throw new Error("Open WebUI is not configured — set the URL on the editor's Auth tab");
    const model = String(opts.model || cfg.model || '').trim();
    if (!model) throw new Error("no Open WebUI model set — pick one on the Auth tab (or tick Override model)");
    const body = { model, stream: false, temperature: 0.2, messages: [{ role: 'system', content: sys }, { role: 'user', content: text }] };
    let res;
    try { res = await owuiClient.postJson(ep.chatUrl, body, String(cfg.apiKey || ''), timeoutMs); }
    catch (e) { throw new Error('could not reach Open WebUI: ' + ((e && e.message) || e)); }
    return parseChat(res, 'Open WebUI');
  }

  function parseChat(res, who) {
    if (res.status === 401 || res.status === 403) throw new Error(who + ' rejected the API key (HTTP ' + res.status + ')');
    if (res.status !== 200) throw new Error(who + ' error (HTTP ' + res.status + ')' + (res.text ? ': ' + String(res.text).slice(0, 300) : ''));
    let obj; try { obj = JSON.parse(res.text); } catch (e) { throw new Error(who + ' returned an unparseable response'); }
    if (obj && obj.error) throw new Error(who + ' error: ' + String((obj.error && obj.error.message) || obj.error).slice(0, 300));
    const choice = obj && Array.isArray(obj.choices) ? obj.choices[0] : null;
    const content = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content : '';
    if (!content.trim()) throw new Error(who + ' returned no output');
    return content.trim();
  }

  function runClaude(input, timeoutMs) {
    const exe = (d.findClaudeExe || require('./claudevoice-session').findClaudeExe)();
    if (!exe) return Promise.reject(new Error('Claude CLI not found on PATH'));
    return runProc(exe, ['-p'], input, false, timeoutMs).then(r => r.stdout);
  }
  async function runCodex(input, timeoutMs) {
    const exe = (d.findCodexExe || require('./codexvoice-session').findCodexExe)();
    if (!exe) throw new Error('Codex CLI not found on PATH');
    const outFile = path.join(os.tmpdir(), 'oqx-lucid-' + now() + '.txt');
    try {
      await runProc('"' + exe + '"', ['exec', '-', '--skip-git-repo-check', '--output-last-message', outFile], input, true, timeoutMs);
      return await fsp.readFile(outFile, 'utf8');
    } finally { try { await fsp.unlink(outFile); } catch (e) {} }
  }
  function runProc(cmd, args, stdinText, shell, timeoutMs) {
    return new Promise((resolve, reject) => {
      let proc;
      try { proc = spawnImpl(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: !!shell }); }
      catch (e) { return reject(new Error('spawn failed: ' + e.message)); }
      let out = '', err = '', settled = false;
      const timer = setTimeout(() => { if (settled) return; settled = true; try { proc.kill(); } catch (e) {} reject(new Error('AI timed out')); }, timeoutMs);
      const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
      proc.stdout.on('data', x => { out += x; });
      proc.stderr.on('data', x => { err += x; });
      proc.on('error', e => finish(reject, new Error('spawn failed: ' + e.message)));
      proc.on('close', code => {
        if (code === 0) return finish(resolve, { stdout: out });
        // Surface the CLI's real message — many CLIs print the error to stdout, not stderr.
        const detail = (err.trim() || out.trim() || '').replace(/\s+/g, ' ').trim();
        log('CLI "' + cmd + '" exited ' + code + (detail ? ' | ' + detail : ' (no output)'));
        finish(reject, new Error('AI exited ' + code + (detail ? ': ' + detail.slice(0, 400) : ' (no output — see the app log)')));
      });
      try { if (proc.stdin) { proc.stdin.write(stdinText); proc.stdin.end(); } } catch (e) {}
    });
  }

  return { transform };
}

module.exports = { createLucidAI, DEFAULT_CLEANUP_PROMPT, REWRITE_PRESETS, rewritePromptFor };
