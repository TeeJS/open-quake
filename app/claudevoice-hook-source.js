'use strict';
// Source for the global PreToolUse hook. Written out to a real on-disk file in userData at install
// time (see claudevoice-approvals.js) rather than shipped from tools/ or app/: tools/** is explicitly
// excluded from packaged builds (package.json's build.files has "!tools/**"), and app/ ships inside
// app.asar, which a plain external `node` process (spawned by Claude Code's own hook runner, not
// Electron) cannot read into. Embedding the source as a string and writing a real file sidesteps both
// problems the same way in dev and in a packaged build.
//
// Safe for normal terminal Claude Code usage everywhere on this machine, in any project: it is a
// complete no-op unless OQX_VOICE_SESSION=1 is present in its OWN environment, which only
// claudevoice-session.js's spawn() call ever sets. It also steps aside for every permission mode
// except 'manual' -- Claude Code's own built-in handling governs acceptEdits/plan/bypassPermissions/
// etc, this hook never tries to reimplement any of that.
module.exports = `'use strict';
const http = require('http');

function readStdin() {
  return new Promise(function (resolve) {
    var data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function (c) { data += c; });
    process.stdin.on('end', function () { resolve(data); });
  });
}

(async function () {
  if (process.env.OQX_VOICE_SESSION !== '1') { process.exit(0); return; }
  var input;
  try { input = JSON.parse(await readStdin()); } catch (e) { process.exit(0); return; }
  // The CLI normalizes the 'manual' launch alias to 'default' in hook input (verified empirically
  // 2026-08-13 against 2.1.228 -- checking only 'manual' made the hook stand aside every time, so
  // Manual mode headless-denied everything and the agent begged for permission in text instead).
  // Both names mean "ask before acting": prompt the panel.
  if (input.permission_mode !== 'manual' && input.permission_mode !== 'default') { process.exit(0); return; }
  var port = process.env.OQX_VOICE_PORT, token = process.env.OQX_VOICE_TOKEN;
  if (!port || !token) { process.exit(0); return; }   // orphaned/misconfigured env -- fail open to Claude Code's own default rather than hang

  var body = JSON.stringify({
    toolName: input.tool_name,
    toolInput: input.tool_input,
    sessionId: input.session_id,
    requestId: (input.session_id || 's') + ':' + Date.now() + ':' + Math.random().toString(36).slice(2),
  });

  var result = await new Promise(function (resolve) {
    var req = http.request({
      host: '127.0.0.1', port: Number(port), path: '/ai-voice/claude/approval-request', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-oqx-voice-token': token },
      timeout: 590000,
    }, function (res) {
      var data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () { try { resolve(JSON.parse(data)); } catch (e) { resolve(null); } });
    });
    req.on('error', function () { resolve(null); });
    req.on('timeout', function () { req.destroy(); resolve(null); });
    req.end(body);
  });

  if (result && result.hookSpecificOutput) {
    process.stdout.write(JSON.stringify(result));
    process.exit(0);
    return;
  }
  // Panel unreachable, or it timed out -- fail CLOSED (deny), not an unattended auto-allow. The whole
  // point of Manual mode is that nothing proceeds unasked.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'open-quake panel did not respond to the approval request in time.',
    },
  }));
  process.exit(0);
})();
`;
