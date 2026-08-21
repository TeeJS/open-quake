'use strict';
// routines.js — saved AI routines (MAIN PROCESS; pure, no electron)
//
// A routine is a saved prompt plus where to run it:
//   { id, name, prompt, appPageId, profileId, folder, mode }
// They live in config.settings.routines and are referenced BY ID from a `routine` tile, so one
// routine can sit on several pages and stay editable in one place (Settings window -> Routines tab).
//
// The library exists rather than a prompt-per-tile because the panel's "+ Routine" button has to
// save a routine without picking a page and a grid slot — there's no touch UI for that, and no
// on-screen keyboard to name one either (hence autoName below).
//
// Pure and electron-free so it unit-tests in isolation — same reason as panelSchema.js.

const AI_VOICE_APP = 'ai-voice';
// Backends that run an agent in a working directory. Open WebUI and the API backend are plain chat
// — they have no folder, which is why the AI Chat page hides its Folder row for them (hasProject
// false in main.js's branding). A routine only carries a folder for the other three.
const FOLDER_BACKENDS = ['claude', 'codex', 'copilot'];
function backendOf(page) { return ((page && page.options && page.options.backend) || 'claude'); }
function allowsFolder(page) { return FOLDER_BACKENDS.indexOf(backendOf(page)) !== -1; }
const NAME_WORDS = 6;     // enough to recognize a routine in a list, short enough to fit a row
const NAME_MAX = 48;

function str(v) { return typeof v === 'string' ? v : ''; }

// Every AI Chat page, in config order. A routine has to name one of these to have somewhere to run.
function aiVoicePages(grids) {
  return (Array.isArray(grids) ? grids : []).filter(g => g && g.kind === 'app' && g.app === AI_VOICE_APP);
}

// Auto-name from the prompt's opening words. The panel has no on-screen keyboard, so "+ Routine"
// can't ask for a name — it names the routine here and the user renames it later on the PC.
function autoName(prompt) {
  const words = str(prompt).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  let name = words.slice(0, NAME_WORDS).join(' ');
  if (name.length > NAME_MAX) name = name.slice(0, NAME_MAX).trimEnd();
  if (words.length > NAME_WORDS || name.length < str(prompt).trim().length) name += '…';
  return name;
}

function newRoutineId() { return 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); }

// Shape a routine for storage. Returns null for anything unusable — an empty prompt is rejected
// HERE, at save time, so a tile can never be wired to a routine that would do nothing.
function normalizeRoutine(raw, makeId) {
  if (!raw || typeof raw !== 'object') return null;
  const prompt = str(raw.prompt).trim();
  if (!prompt) return null;
  const name = str(raw.name).trim() || autoName(prompt);
  return {
    id: str(raw.id).trim() || (makeId || newRoutineId)(),
    name: name,
    prompt: prompt,
    appPageId: str(raw.appPageId).trim(),
    profileId: str(raw.profileId).trim(),
    folder: str(raw.folder).trim(),
    mode: str(raw.mode).trim(),        // permission mode; '' = leave the page on whatever it's set to
  };
}

// Drop unusable entries from a stored list (hand-edited config, a half-saved row) rather than
// letting a nameless/promptless routine reach the panel's picker.
function normalizeList(list, makeId) {
  const out = [];
  const seen = new Set();
  for (const r of (Array.isArray(list) ? list : [])) {
    const n = normalizeRoutine(r, makeId);
    if (!n || seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  return out;
}

/**
 * Resolve a tile's routine id into something runnable.
 *   { ok:true, routine, pageId, warning? }   warning = the target page is gone, we picked another
 *   { ok:false, error }                      shown on the panel — never a silent no-op
 */
function resolveRoutine(id, ctx) {
  const routines = Array.isArray(ctx && ctx.routines) ? ctx.routines : [];
  const routine = routines.find(r => r && r.id === str(id));
  if (!routine) return { ok: false, error: 'Routine not found — it may have been deleted.' };
  const prompt = str(routine.prompt).trim();
  if (!prompt) return { ok: false, error: 'That routine has no prompt.' };

  const pages = aiVoicePages(ctx && ctx.grids);
  if (!pages.length) return { ok: false, error: 'No AI Chat page to run this on — add one first.' };

  const target = pages.find(g => g.id === str(routine.appPageId));
  // A folder is only meaningful on a backend that has a working directory, and only worth acting on
  // when it differs from where that page already is — switching folders restarts the session, which
  // ends the conversation showing on the page.
  const folderFor = page => {
    const want = str(routine.folder).trim();
    if (!want || !allowsFolder(page)) return '';
    return want === str(page.options && page.options.projectDir).trim() ? '' : want;
  };
  if (target) return { ok: true, routine: routine, pageId: target.id, folder: folderFor(target) };
  // The page it was saved against is gone. Running it somewhere is better than doing nothing, but
  // say so — a routine silently switching backends would be a nasty surprise.
  return {
    ok: true, routine: routine, pageId: pages[0].id, folder: folderFor(pages[0]),
    warning: 'That routine\'s AI Chat page is gone — running it on "' + str(pages[0].name) + '" instead.',
  };
}

// Decide how to run a routine against the page it landed on, given what that page's session is
// currently doing. Pure so it can be unit-tested away from Electron -- and because getting it wrong
// crashed claude: applying a profile/mode via the live mid-session switches restarts the CLI with
// `--resume`, which fails ("No conversation found with session ID") before the first turn persists.
// The plan instead writes the routine's context onto the page OPTIONS (a fresh/lazy start reads
// them) and asks for a FRESH restart only when a live session must change.
//   input:  { routine, folder, running, curProfile, curMode }   (folder = resolveRoutine's diff-only folder)
//   -> { options:{profilePick?,permissionMode?,projectDir?}, persist:bool, restart:bool }
function planRoutineRun(input) {
  input = input || {};
  const routine = input.routine || {};
  const folder = str(input.folder);
  const profileId = str(routine.profileId);
  const mode = str(routine.mode);
  const options = {};
  if (profileId) options.profilePick = profileId;
  if (mode) options.permissionMode = mode;
  if (folder) options.projectDir = folder;   // so even a cold page's lazy start lands in it
  const wantsChange = !!folder
    || (!!profileId && profileId !== str(input.curProfile))
    || (!!mode && mode !== str(input.curMode));
  return { options: options, persist: !!(profileId || mode || folder), restart: !!input.running && wantsChange };
}

module.exports = { AI_VOICE_APP, FOLDER_BACKENDS, aiVoicePages, allowsFolder, backendOf, autoName, newRoutineId, normalizeRoutine, normalizeList, resolveRoutine, planRoutineRun };
