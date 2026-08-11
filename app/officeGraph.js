'use strict';

const OFFICE_SCOPES = Object.freeze(['User.Read', 'Presence.Read', 'Calendars.Read', 'offline_access']);
const GRAPH_ORIGIN = 'https://graph.microsoft.com';

function createOfficeGraph({ getAccessToken, connectOAuth, fetchImpl = global.fetch, now = () => new Date() }) {
  if (typeof getAccessToken !== 'function') throw new TypeError('getAccessToken is required');
  if (typeof connectOAuth !== 'function') throw new TypeError('connectOAuth is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');

  async function graph(path, accessToken) {
    const response = await fetchImpl(GRAPH_ORIGIN + '/v1.0' + path, {
      cache: 'no-store',
      headers: { Authorization: 'Bearer ' + accessToken },
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
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const calendarPath = '/me/calendarView?startDateTime=' + encodeURIComponent(start.toISOString())
      + '&endDateTime=' + encodeURIComponent(end.toISOString())
      + '&$orderby=start/dateTime&$top=5';
    const results = await Promise.all([
      graph('/me?$select=displayName,userPrincipalName', token.accessToken),
      graph('/me/presence', token.accessToken).catch(() => null),
      graph(calendarPath, token.accessToken),
    ]);
    return {
      ok: true,
      profile: results[0],
      presence: results[1],
      events: results[2] && Array.isArray(results[2].value) ? results[2].value : [],
    };
  }

  async function connect() {
    await connectOAuth('microsoft', OFFICE_SCOPES);
    return { ok: true };
  }

  return { getData, connect };
}

module.exports = { OFFICE_SCOPES, createOfficeGraph };
