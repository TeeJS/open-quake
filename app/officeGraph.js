'use strict';

const OFFICE_SCOPES = Object.freeze(['User.Read', 'Presence.Read', 'Calendars.Read', 'offline_access']);
const GRAPH_ORIGIN = 'https://graph.microsoft.com';

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

function createOfficeGraph({ getAccessToken, connectOAuth, fetchImpl = global.fetch, now = () => new Date() }) {
  if (typeof getAccessToken !== 'function') throw new TypeError('getAccessToken is required');
  if (typeof connectOAuth !== 'function') throw new TypeError('connectOAuth is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');

  async function graph(path, accessToken, extraHeaders) {
    const response = await fetchImpl(GRAPH_ORIGIN + '/v1.0' + path, {
      cache: 'no-store',
      headers: Object.assign({ Authorization: 'Bearer ' + accessToken }, extraHeaders || {}),
    });
    if (!response.ok) {
      const err = new Error('Microsoft Graph request failed (HTTP ' + response.status + ')');
      err.code = 'graph_request_failed';
      throw err;
    }
    return response.json();
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

  return { getData, connect };
}

module.exports = { OFFICE_SCOPES, createOfficeGraph };
