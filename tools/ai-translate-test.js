'use strict';
// AI-translate VALIDATION HARNESS — proves the binding constraint (per-segment round-trip latency)
// and translation quality of an OpenAI-compatible chat endpoint BEFORE trusting it for live captions.
// Sends realistic utterance segments sequentially, each with the same rolling context the app uses,
// and prints per-segment latency + the translation. Includes the context-dependent pronoun case
// ("Ist er kalt?" -> should be "Is it cold?" because the context says the coffee is cold).
//
// Run (any OpenAI-compatible endpoint; DeepSeek shown):
//   set AI_API_KEY=sk-...        (PowerShell: $env:AI_API_KEY = "sk-...")
//   node tools/ai-translate-test.js https://api.deepseek.com deepseek-v4-flash en
//   arg1 = base URL (default https://api.deepseek.com)   arg2 = model (default deepseek-v4-flash)
//   arg3 = target language (default en)
// Judge: each segment under ~1.5s and the pronoun case correct = good enough for live captions.
const https = require('https');
const http = require('http');

const baseUrl = (process.argv[2] || 'https://api.deepseek.com').replace(/\/+$/, '');
const model = process.argv[3] || 'deepseek-v4-flash';
const target = process.argv[4] || 'en';
const apiKey = process.env.AI_API_KEY;
if (!apiKey) { console.error('Set AI_API_KEY=<your key> first.'); process.exit(1); }

// Real utterance-shaped segments (the panel gets one of these per speech pause).
const SEGMENTS = [
  'Der Kaffee ist kalt.',
  'Entschuldigung, ja bitte?',
  'Ich habe eine Frage.',
  'Ist er kalt?',                              // <- pronoun needs context: "Is it cold?" not "Is he cold?"
  'Ja, ich habe ihn gerade probiert und er schmeckt furchtbar.',
  'Können wir bitte eine neue Kanne bestellen, bevor das Meeting anfängt?',
];

const SYSTEM = 'You are a live interpreter. Translate everything the user says into ' + target +
  '. Output ONLY the translation — no quotes, no notes, no romanization. Keep names and numbers as spoken. ' +
  'Use the conversation so far to resolve pronouns and context.';

function chat(messages) {
  const payload = { model, messages, stream: false, max_tokens: 300 };
  // DeepSeek v4 defaults to thinking mode (effort high) — reasoning overhead per request and the
  // answer can land in reasoning_content, leaving content empty. Disable it; only for DeepSeek
  // models, since OpenAI rejects unknown request params.
  if (/deepseek/i.test(model)) payload.thinking = { type: 'disabled' };
  const body = JSON.stringify(payload);
  const u = new URL(baseUrl + '/chat/completions');
  const mod = u.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = mod.request(u, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 20000,
    }, res => {
      let data = ''; res.on('data', d => data += d); res.on('end', () => {
        let j = null; try { j = JSON.parse(data); } catch (e) {}
        if (res.statusCode >= 200 && res.statusCode < 300 && j && j.choices && j.choices[0])
          resolve(String(j.choices[0].message.content || '').trim());
        else reject(new Error('HTTP ' + res.statusCode + ': ' + data.slice(0, 300)));
      });
    });
    req.on('timeout', () => { req.destroy(new Error('request timed out (20s)')); });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

(async () => {
  console.log(`Endpoint: ${baseUrl}  model: ${model}  ->  ${target}\n`);
  const pairs = [];   // rolling context, exactly like the app: last 6 (src, tgt) pairs as prior turns
  const times = [];
  for (const src of SEGMENTS) {
    const messages = [{ role: 'system', content: SYSTEM }];
    for (const p of pairs.slice(-6)) { messages.push({ role: 'user', content: p.src }, { role: 'assistant', content: p.tgt }); }
    messages.push({ role: 'user', content: src });
    const t0 = Date.now();
    try {
      const tgt = await chat(messages);
      const ms = Date.now() - t0; times.push(ms);
      pairs.push({ src, tgt });
      console.log(`[${String(ms).padStart(5)} ms] "${src}"\n          -> "${tgt}"`);
    } catch (e) {
      console.error(`FAILED on "${src}": ${e.message}`);
      process.exit(1);
    }
  }
  times.sort((a, b) => a - b);
  console.log(`\nLatency: median ${times[Math.floor(times.length / 2)]} ms, worst ${times[times.length - 1]} ms`);
  console.log('Judge: median under ~1500 ms AND "Ist er kalt?" translated with "it" (not "he") = ship it.');
})();
