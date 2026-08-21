'use strict';

// Joplin note creation for finished meeting analyses, via the Joplin Data API (the Web Clipper
// service Joplin Desktop exposes, default port 41184 — Tools › Options › Web Clipper). Replaces
// the note step of the retired Cowork transcript-cleanup pipeline: one note per analysis, titled
// after the recording, filed to a configured notebook, tagged "meeting notes" + the year + any
// title-keyword tags. Tags are matched case-insensitively against tags that ALREADY exist in
// Joplin and are never created — a missing tag is reported back, not added (the same contract the
// old pipeline enforced so the tag vocabulary stays curated by hand).
//
// Requests are short and sequential, so plain fetch with a per-request timeout is fine here (the
// undici hidden header-timeout only bites long-running completions — see owuiClient.js). Every
// failure maps to a wording that names the fix; callers treat any throw as "note not created".

const TIMEOUT_MS = 15000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 50;

// Title-keyword tag table, ported verbatim from the old pipeline: case-insensitive substring
// match against the note title (the recording basename). Casing here is display-preference only —
// matching against Joplin's existing tags is case-insensitive anyway.
const KEYWORD_TAGS = [
  { match: 'g1', tags: ['audit'] },
  { match: 'infrastructure', tags: ['infrastructure'] },
  { match: 'sap', tags: ['SAP'] },
  { match: 's4 hana', tags: ['S4 Hana', 'SAP'] },
  { match: 'basis', tags: ['SAP'] },
  { match: 'titan', tags: ['Titan'] },
  { match: 'syntax', tags: ['S4 Hana', 'SAP'] },
  { match: 'muka', tags: ['Titan'] },
  { match: 'qliksense', tags: ['qliksense'] },
  { match: 'docuware', tags: ['Docuware'] },
  { match: 'helpdesk', tags: ['helpdesk'] },
];

// Every note gets "meeting notes" + the 4-digit year the basename starts with, then the keyword
// extras. Deduped case-insensitively, first casing wins.
function tagsFor(basename) {
  const name = String(basename || '');
  const lower = name.toLowerCase();
  const tags = ['meeting notes'];
  const y = /^(\d{4})/.exec(name);
  if (y) tags.push(y[1]);
  for (const k of KEYWORD_TAGS) if (lower.includes(k.match)) tags.push(...k.tags);
  const seen = new Set();
  return tags.filter(t => { const k = t.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

// Accept any pasted form — bare host, host:port, origin, trailing slash — and return the origin.
function normalizeJoplinUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s.replace(/^[/:]+/, '');
  try { const u = new URL(s); return u.hostname ? u.origin : null; } catch (e) { return null; }
}

// One Data API call. The token rides as a query parameter (Joplin's convention). Resolves the
// parsed JSON body; throws actionable wordings for transport failures and auth/HTTP errors.
async function api(origin, token, method, endpoint, { params, body, fetchImpl } = {}) {
  const f = fetchImpl || fetch;
  const q = new URLSearchParams(Object.assign({ token }, params || {}));
  const url = origin + '/' + endpoint + '?' + q.toString();
  let res;
  try {
    res = await f(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error('could not reach Joplin at ' + origin + ' (' + ((e && e.message) || 'request failed')
      + ') — is Joplin Desktop running with the Web Clipper service enabled?');
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('Joplin rejected the API token (HTTP ' + res.status + ') — check the token under Tools › Options › Web Clipper');
  }
  const text = await res.text();
  if (!res.ok) throw new Error('Joplin API error (HTTP ' + res.status + ')' + (text ? ': ' + text.slice(0, 200) : ''));
  try { return text ? JSON.parse(text) : {}; } catch (e) { throw new Error('Joplin returned an unparseable response'); }
}

// Collect every page of a list endpoint ({ items, has_more } envelope).
async function pagedGet(origin, token, endpoint, fetchImpl) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await api(origin, token, 'GET', endpoint, { params: { fields: 'id,title', limit: PAGE_LIMIT, page }, fetchImpl });
    const items = r && Array.isArray(r.items) ? r.items : [];
    out.push(...items);
    if (!r || !r.has_more) break;
  }
  return out;
}

// Create the analysis note and attach its tags. Returns { id, applied, skipped } — `skipped`
// names wanted tags that don't exist in Joplin (never created here). Throws on anything that
// prevented the NOTE itself; a tag attach failure after the note exists degrades to `skipped`
// rather than failing a note that was successfully created.
async function createAnalysisNote({ url, token, notebook, title, body, fetchImpl }) {
  const origin = normalizeJoplinUrl(url);
  if (!origin) throw new Error('Joplin API URL is not set — configure it in Settings › Meeting');
  if (!String(token || '').trim()) throw new Error('Joplin API token is not set — copy it from Tools › Options › Web Clipper');
  const nbWanted = String(notebook || '').trim();
  if (!nbWanted) throw new Error('Joplin notebook is not set');

  const folders = await pagedGet(origin, token, 'folders', fetchImpl);
  const nb = folders.find(x => x && String(x.title || '').trim().toLowerCase() === nbWanted.toLowerCase());
  if (!nb) throw new Error('notebook "' + nbWanted + '" not found in Joplin — create it there first');

  const note = await api(origin, token, 'POST', 'notes', { body: { title, body, parent_id: nb.id }, fetchImpl });
  if (!note || !note.id) throw new Error('Joplin did not return a note id');

  const wanted = tagsFor(title);
  const existing = await pagedGet(origin, token, 'tags', fetchImpl);
  const byLower = new Map(existing.map(t => [String(t.title || '').toLowerCase(), t]));
  const applied = [], skipped = [];
  for (const w of wanted) {
    const t = byLower.get(w.toLowerCase());
    if (!t) { skipped.push(w); continue; }
    try {
      await api(origin, token, 'POST', 'tags/' + encodeURIComponent(t.id) + '/notes', { body: { id: note.id }, fetchImpl });
      applied.push(t.title);
    } catch (e) { skipped.push(w); }
  }
  return { id: note.id, applied, skipped };
}

module.exports = { createAnalysisNote, tagsFor, normalizeJoplinUrl };
