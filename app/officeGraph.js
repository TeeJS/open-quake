'use strict';

const OFFICE_SCOPES = Object.freeze(['User.Read', 'Presence.Read', 'Calendars.Read', 'offline_access']);
const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const MEETING_SELECT = 'subject,start,end,organizer,attendees,responseStatus,location,body,categories,importance,type,isCancelled,isOrganizer,isAllDay,onlineMeeting';
const NAME_CORRECTIONS = Object.freeze({ 'TJ Schmitz': 'T.J. Schmitz' });
const GRAPH_TIMEOUT_MS = 15000;
const MAX_GRAPH_PAGES = 20;

function normalizeDateValue(value) {
  if (!value || typeof value !== 'object') return null;
  const raw = value.dateTime || value;
  if (!raw || typeof raw !== 'string') return null;
  const zone = value && typeof value.timeZone === 'string' ? value.timeZone : '';
  const candidate = /[zZ]$/.test(raw) || /[+-]\d{2}:?\d{2}$/.test(raw) ? raw : raw + (zone === 'UTC' ? 'Z' : '');
  const date = new Date(candidate);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeEvent(item) {
  if (!item || typeof item !== 'object') return null;
  const start = normalizeDateValue(item.start);
  const end = normalizeDateValue(item.end);
  const location = item.location && item.location.displayName
    ? item.location.displayName
    : Array.isArray(item.locations) && item.locations[0] && item.locations[0].displayName
      ? item.locations[0].displayName
      : '';
  const joinUrl = item.onlineMeeting && item.onlineMeeting.joinWebUrl
    ? item.onlineMeeting.joinWebUrl
    : item.onlineMeetingUrl || null;
  return {
    id: item.id || '',
    subject: item.subject || '(untitled)',
    start,
    end,
    startTimeZone: item.start && item.start.timeZone ? item.start.timeZone : null,
    endTimeZone: item.end && item.end.timeZone ? item.end.timeZone : null,
    location,
    isCancelled: !!item.isCancelled,
    isAllDay: !!item.isAllDay,
    showAs: item.showAs || 'busy',
    status: item.showAs || 'busy',
    isOnlineMeeting: !!item.isOnlineMeeting,
    joinUrl,
    webLink: item.webLink || null,
  };
}

function normalizeName(value) {
  let name = String(value || '').trim();
  const comma = name.indexOf(',');
  if (comma >= 0) name = (name.slice(comma + 1).trim() + ' ' + name.slice(0, comma).trim()).trim();
  return NAME_CORRECTIONS[name] || name;
}

function graphDate(value) {
  if (!value) return null;
  let raw = typeof value === 'object' ? value.dateTime : value;
  if (typeof raw !== 'string') return null;
  // Graph may return seven fractional digits, while JavaScript Date accepts at most three
  // consistently. The meeting sidecar intentionally stores whole UTC seconds.
  raw = raw.replace(/(\.\d{3})\d+/, '$1');
  if (!/[zZ]$/.test(raw) && !/[+-]\d{2}:?\d{2}$/.test(raw)) raw += 'Z';
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sidecarDate(value) {
  const date = graphDate(value);
  return date ? date.toISOString().replace(/\.\d{3}Z$/, '+00:00') : null;
}

function meetingMetadata(item) {
  const attendees = Array.isArray(item && item.attendees) ? item.attendees : [];
  const attendeeNames = type => attendees
    .filter(a => String(a && a.type || '').toLowerCase() === type)
    .map(a => normalizeName(a && a.emailAddress && a.emailAddress.name))
    .filter(Boolean);
  const response = item && item.responseStatus && item.responseStatus.response;
  const responses = {
    none: 'None', organizer: 'Organizer', tentativelyAccepted: 'Tentative', accepted: 'Accepted',
    declined: 'Declined', notResponded: 'NotResponded',
  };
  const importance = String(item && item.importance || '').toLowerCase();
  let meetingStatus = 'NonMeeting';
  if (item && item.isCancelled) meetingStatus = 'MeetingCanceled';
  else if (attendees.length) meetingStatus = item && item.isOrganizer ? 'Meeting' : 'MeetingReceived';
  return {
    subject: String(item && item.subject || 'Untitled Meeting').trim() || 'Untitled Meeting',
    start: sidecarDate(item && item.start),
    end: sidecarDate(item && item.end),
    organizer: normalizeName(item && item.organizer && item.organizer.emailAddress && item.organizer.emailAddress.name),
    required_attendees: attendeeNames('required'),
    optional_attendees: attendeeNames('optional'),
    response_status: responses[response] || 'Unknown',
    location: item && item.location ? item.location.displayName : null,
    body: item && item.body ? item.body.content : null,
    categories: Array.isArray(item && item.categories) ? item.categories.slice() : [],
    importance: importance === 'low' ? 'Low' : importance === 'high' ? 'High' : 'Normal',
    is_recurring: ['occurrence', 'exception', 'seriesMaster'].includes(item && item.type),
    meeting_status: meetingStatus,
    online_meeting_url: item && item.onlineMeeting ? (item.onlineMeeting.joinUrl || item.onlineMeeting.joinWebUrl || null) : null,
  };
}

function localDateKey(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function chooseCurrentMeeting(items, at, skipPrefixes) {
  const now = at instanceof Date ? at : new Date(at);
  const day = localDateKey(now);
  const prefixes = (skipPrefixes || []).map(p => String(p || '').trim().toLowerCase()).filter(Boolean);
  const candidates = (items || []).map(item => ({ item, start: graphDate(item && item.start), end: graphDate(item && item.end) }))
    .filter(c => c.start && c.end && localDateKey(c.start) === day && !(c.item && c.item.isAllDay))
    .filter(c => !prefixes.some(prefix => String(c.item.subject || 'Untitled Meeting').trim().toLowerCase().startsWith(prefix)))
    .sort((a, b) => a.start - b.start);
  const boundary = new Date(now);
  boundary.setSeconds(0, 0);
  if (boundary.getMinutes() < 30) boundary.setMinutes(30); else { boundary.setMinutes(0); boundary.setHours(boundary.getHours() + 1); }
  if ((boundary - now) / 60000 < 5) {
    const upcoming = candidates.find(c => Math.abs(c.start - boundary) <= 60000);
    if (upcoming) return upcoming.item;
  }
  let active = null;
  candidates.forEach(c => { if (c.start <= now && now < c.end) active = c.item; });
  return active;
}

function createOfficeGraph({ getAccessToken, connectOAuth, fetchImpl = global.fetch, now = () => new Date() }) {
  if (typeof getAccessToken !== 'function') throw new TypeError('getAccessToken is required');
  if (typeof connectOAuth !== 'function') throw new TypeError('connectOAuth is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');

  async function graph(path, accessToken, extraHeaders) {
    return graphUrl(GRAPH_ORIGIN + '/v1.0' + path, accessToken, extraHeaders);
  }

  async function graphUrl(url, accessToken, extraHeaders) {
    const parsed = new URL(url);
    if (parsed.origin !== GRAPH_ORIGIN) throw new Error('Microsoft Graph returned an invalid paging URL');
    const response = await fetchImpl(parsed.href, {
      cache: 'no-store',
      headers: Object.assign({ Authorization: 'Bearer ' + accessToken }, extraHeaders || {}),
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const err = new Error('Microsoft Graph request failed (HTTP ' + response.status + ')');
      err.code = 'graph_request_failed';
      throw err;
    }
    return response.json();
  }

  async function accessToken() {
    const token = await getAccessToken('microsoft', OFFICE_SCOPES);
    if (!(token && token.accessToken)) {
      const err = new Error('Microsoft 365 is not connected. Connect it on the Auth settings tab first.');
      err.code = 'not_connected';
      throw err;
    }
    return token.accessToken;
  }

  async function getData() {
    const token = await getAccessToken('microsoft', OFFICE_SCOPES);
    if (!(token && token.accessToken)) return { ok: false, error: 'not connected', code: 'not_connected' };

    const start = now();
    const end = new Date(start.getTime() + 36 * 60 * 60 * 1000);
    const calendarPath = '/me/calendarView?startDateTime=' + encodeURIComponent(start.toISOString())
      + '&endDateTime=' + encodeURIComponent(end.toISOString())
      + '&$select=id,subject,start,end,location,locations,isCancelled,isAllDay,isOnlineMeeting,onlineMeeting,onlineMeetingUrl,webLink,showAs'
      + '&$orderby=start/dateTime&$top=12';
    const results = await Promise.all([
      graph('/me?$select=displayName,userPrincipalName', token.accessToken),
      graph('/me/presence', token.accessToken).catch(() => null),
      graph(calendarPath, token.accessToken, { Prefer: 'outlook.timezone="UTC"' }),
    ]);
    const events = results[2] && Array.isArray(results[2].value)
      ? results[2].value.map(normalizeEvent).filter(Boolean)
      : [];
    return {
      ok: true,
      profile: results[0],
      presence: results[1],
      events,
    };
  }

  async function connect() {
    await connectOAuth('microsoft', OFFICE_SCOPES);
    return { ok: true };
  }

  async function checkConnection() {
    const token = await accessToken();
    const profile = await graph('/me?$select=displayName,userPrincipalName', token);
    return { ok: true, profile };
  }

  async function getMeetingInfo(options) {
    const opts = options || {};
    const at = opts.at instanceof Date ? opts.at : now();
    const token = await accessToken();
    const start = new Date(at.getFullYear(), at.getMonth(), at.getDate());
    const end = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1);
    const path = '/me/calendarView?startDateTime=' + encodeURIComponent(start.toISOString())
      + '&endDateTime=' + encodeURIComponent(end.toISOString())
      + '&$orderby=start/dateTime&$top=100&$select=' + encodeURIComponent(MEETING_SELECT);
    const headers = { Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"' };
    let page = await graph(path, token, headers);
    const items = [];
    for (let pageNumber = 1;; pageNumber++) {
      if (page && Array.isArray(page.value)) items.push(...page.value);
      if (!(page && page['@odata.nextLink'])) break;
      if (pageNumber >= MAX_GRAPH_PAGES) throw new Error('Microsoft Graph calendar response exceeded the paging limit');
      page = await graphUrl(page['@odata.nextLink'], token, headers);
    }
    const selected = chooseCurrentMeeting(items, at, String(opts.skipPrefixes || '').split(','));
    return selected ? meetingMetadata(selected) : null;
  }

  return { getData, connect, checkConnection, getMeetingInfo };
}

module.exports = { OFFICE_SCOPES, chooseCurrentMeeting, createOfficeGraph, meetingMetadata, normalizeName };
