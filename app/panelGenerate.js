'use strict';
// panelGenerate.js
//
// Turns a Panel Builder conversation turn into a reviewable panel.
//
// The trigger is an AI Profile, not a new UI: the user picks "Panel Builder" on an AI Voice page and
// just talks. The profile makes the model answer with JSON instead of prose; this module catches that
// answer, validates it (panelSchema), and holds it as a pending review until the user Accepts.
//
// Refinement is simply the next conversation turn ("no, Windows shortcuts") — the session already has
// the context, so there is no separate refine call here.
//
// Pure and electron-free so the whole accept/cancel state machine unit-tests in isolation, the same
// way lucidtypeDictation's review does.

const { validatePanel } = require('./panelSchema');

// The schema contract lives in CODE, not in the profile text. The profile a user can edit only says
// what the assistant is for; if someone rewrites it, generation degrades in wording, never in
// validity. This block is appended to whatever the profile says.
const PANEL_SYSTEM_PROMPT = [
  'When the user asks for a control panel, shortcut set, or button page, reply with ONE JSON object',
  'and nothing else — no prose, no markdown fences, no explanation.',
  '',
  'Shape:',
  '{"name":"Photoshop Masking","cols":8,"rows":2,"tiles":[ ... ]}',
  '',
  '- cols: 1-12, rows: 1-6. Prefer 8x2 = 16 tiles. Use 8x3 = 24 only if they want more buttons.',
  '- tiles: EXACTLY cols x rows entries, filling the grid left to right, top to bottom.',
  '  Count them before you answer — 8x2 is 16, 8x3 is 24, 6x2 is 12. A wrong count shifts everything.',
  '- Every tile: {"label":"Short Name","icon":"<one emoji>","type":"<type>","value":"<value>"}',
  '- Use an empty tile {"label":"","icon":"","type":"","value":""} for blank cells.',
  '',
  'Tile types and their value:',
  '  key        a keystroke, e.g. "control+shift+n", "alt+F4", "q", "f5"',
  '             modifiers: control, shift, alt, win. Combine with +.',
  '             For punctuation write the character, not its name: "control+," not "control+comma".',
  '  paste_text literal text to type',
  '  url        an http/https link',
  '  app        a program name, e.g. "photoshop"',
  '  open       a file or folder path',
  '  cmd        a shell command',
  '  system     one of: lock, mic, monitor, config',
  '  counter    a starting number',
  '  macro      omit value; add "steps":[{"kind":"key","value":"control+s"},{"kind":"delay","value":"500"}]',
  '             step kinds: key, text, delay, app, open, url, cmd, page, system, ahk',
  '',
  'Rules:',
  '- Labels must be 24 characters or fewer. One emoji per tile.',
  '- Icons: pick the emoji that depicts THAT action. Never use the same emoji twice on a panel, and',
  '  never use a lookalike for a different tool (a paintbrush is a brush, an eraser is 🧽 — not',
  '  another brush). If nothing depicts it well, use a neutral ▫️ rather than something misleading.',
  '  Useful ones: 💾 save · ↩️ undo · ↪️ redo · 🗑️ delete · 🔍 find · 📋 copy · ✂️ cut · ➕ new',
  '  ✖️ close · ⚙️ settings · 🖌️ brush · 🧽 eraser · 🎨 color · 🔒 lock · ▶️ play · ⏸️ pause',
  '- Use the real, correct shortcuts for the application named, on Windows unless told otherwise.',
  '- Prefer keystroke tiles. Only use cmd or ahk steps when the user explicitly asks for one.',
  '- If the request is too vague to build (no application or task named), do NOT return JSON —',
  '  ask one short clarifying question instead.',
].join('\n');

// The user-facing half, seeded as an editable profile.
const PANEL_PROFILE = {
  id: 'panel',
  name: 'Panel Builder',
  prompt: 'You build touchscreen control panels for the user\'s macro pad. When they describe what they want, design a practical set of buttons for it — the shortcuts an experienced user of that application actually reaches for, arranged so related actions sit together.',
};

// Pull a JSON object out of a conversational reply. CLI agents in particular like to wrap answers in
// ```json fences or add a sentence before them, so this is deliberately forgiving about the wrapper
// while staying strict about the content (JSON.parse does the real work).
function parsePanelJson(text) {
  let s = String(text == null ? '' : text).trim();
  if (!s) return null;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  const body = s.slice(start, end + 1);
  try {
    const obj = JSON.parse(body);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    // A panel is recognizable by its tiles; anything else is just a JSON-shaped chat reply.
    if (!Array.isArray(obj.tiles)) return null;
    return obj;
  } catch (e) { return null; }
}

function emptyReview() {
  return { active: false, status: '', page: null, warnings: [], risky: [], error: '' };
}

// deps: { existingIds() -> string[], makeId() -> string, validate?, log? }
function createPanelReview(deps) {
  const d = deps || {};
  const validate = d.validate || validatePanel;
  const log = d.log || (() => {});
  let review = emptyReview();
  // The page most recently accepted in this conversation. Saying "the second button doesn't work"
  // regenerates the whole panel, and the user means FIX that page — not collect a second copy of it —
  // so the next proposal can replace it in place, keeping its id (and anything pointing at it).
  let lastAccepted = null;

  function state() {
    return {
      active: review.active,
      status: review.status,
      error: review.error,
      warnings: review.warnings.slice(),
      risky: review.risky.map(r => Object.assign({}, r)),
      page: review.page ? JSON.parse(JSON.stringify(review.page)) : null,
      replaces: lastAccepted ? Object.assign({}, lastAccepted) : null,
    };
  }
  // Called by the host when a page it thought it could replace is gone (deleted in the editor).
  function forgetAccepted() { lastAccepted = null; }

  // Feed a finished assistant turn in. Returns true if it was a panel (and is now pending review),
  // false if it was ordinary conversation that should be shown/spoken as usual.
  function offer(replyText) {
    const raw = parsePanelJson(replyText);
    if (!raw) return false;
    const existingIds = (d.existingIds ? d.existingIds() : []) || [];
    const id = d.makeId ? d.makeId() : '';
    const r = validate(raw, { id, existingIds });
    if (!r.ok) {
      review = { active: true, status: 'error', page: null, warnings: r.warnings || [], risky: [], error: r.error || 'that panel could not be used' };
      log('panel rejected: ' + review.error);
      return true;                       // still a panel attempt — show the user why it failed
    }
    review = { active: true, status: 'ready', page: r.page, warnings: r.warnings || [], risky: r.risky || [], error: '' };
    log('panel ready: ' + r.page.name + ' (' + r.page.cols + '×' + r.page.rows + ', ' +
        r.page.tiles.filter(t => t.type).length + ' tiles, ' + review.risky.length + ' risky)');
    return true;
  }

  // Accept the pending panel. `confirmRisky` must be true when risky[] is non-empty — the caller
  // shows the actual commands first, so consent is informed rather than a generic warning.
  // `replace` = overwrite the page accepted earlier in this conversation instead of adding another.
  function accept(confirmRisky, replace) {
    if (!review.active || review.status !== 'ready' || !review.page) return { ok: false, error: 'no panel to accept' };
    if (review.risky.length && !confirmRisky) return { ok: false, needsConfirm: true, risky: state().risky };
    const page = review.page;
    const replaceId = (replace && lastAccepted) ? lastAccepted.id : null;
    if (replaceId) page.id = replaceId;          // keep the id so page-tiles and rotation still point at it
    review = emptyReview();
    lastAccepted = { id: page.id, name: page.name };
    return { ok: true, page, replaceId };
  }

  function cancel() { review = emptyReview(); return { ok: true }; }
  function isActive() { return review.active; }

  return { offer, accept, cancel, state, isActive, forgetAccepted };
}

module.exports = { createPanelReview, parsePanelJson, PANEL_SYSTEM_PROMPT, PANEL_PROFILE };
