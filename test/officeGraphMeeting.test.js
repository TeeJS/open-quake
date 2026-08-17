'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseCurrentMeeting, createOfficeGraph, meetingMetadata } = require('../app/officeGraph');

function event(subject, start, end, extra) {
  return Object.assign({
    subject,
    start: { dateTime: start, timeZone: 'UTC' },
    end: { dateTime: end, timeZone: 'UTC' },
    attendees: [],
  }, extra || {});
}

test('Graph meeting metadata matches the Outlook sidecar contract', () => {
  const result = meetingMetadata(event('  Vasion Print Meeting  ', '2026-03-26T15:00:00.1234567', '2026-03-26T15:30:00.9999999', {
    organizer: { emailAddress: { name: 'Schmitz, TJ' } },
    attendees: [
      { type: 'required', emailAddress: { name: 'Schmitz, TJ' } },
      { type: 'required', emailAddress: { name: 'Jane Doe' } },
      { type: 'optional', emailAddress: { name: 'Smith, Robert' } },
    ],
    responseStatus: { response: 'accepted' },
    location: { displayName: 'Microsoft Teams Meeting' },
    body: { content: 'Agenda' },
    categories: ['Vendor', 'Print'],
    importance: 'high',
    type: 'occurrence',
    isOrganizer: false,
    onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/example' },
  }));

  assert.deepEqual(result, {
    subject: 'Vasion Print Meeting',
    start: '2026-03-26T15:00:00+00:00',
    end: '2026-03-26T15:30:00+00:00',
    organizer: 'T.J. Schmitz',
    required_attendees: ['T.J. Schmitz', 'Jane Doe'],
    optional_attendees: ['Robert Smith'],
    response_status: 'Accepted',
    location: 'Microsoft Teams Meeting',
    body: 'Agenda',
    categories: ['Vendor', 'Print'],
    importance: 'High',
    is_recurring: true,
    meeting_status: 'MeetingReceived',
    online_meeting_url: 'https://teams.microsoft.com/l/meetup-join/example',
  });
});

test('current meeting selection honors skip prefixes and the under-five-minute boundary rule', () => {
  const active = event('Long workshop', '2026-08-16T12:00:00Z', '2026-08-16T13:00:00Z');
  const next = event('Daily standup', '2026-08-16T12:30:00Z', '2026-08-16T13:00:00Z');
  const skipped = event('Focus time', '2026-08-16T12:30:00Z', '2026-08-16T13:00:00Z');
  const at = new Date('2026-08-16T12:26:00Z');

  assert.equal(chooseCurrentMeeting([active, skipped, next], at, ['Focus time']), next);
  assert.equal(chooseCurrentMeeting([active], new Date('2026-08-16T12:10:00Z'), []), active);
});

test('meeting lookup uses delegated Graph auth, required Prefer headers, and all pages', async () => {
  const calls = [];
  const service = createOfficeGraph({
    getAccessToken: async (provider, scopes) => {
      assert.equal(provider, 'microsoft');
      assert.ok(scopes.includes('Calendars.Read'));
      return { accessToken: 'synthetic-access' };
    },
    connectOAuth: async () => undefined,
    now: () => new Date('2026-08-16T12:10:00Z'),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.includes('page=2')) return { ok: true, json: async () => ({ value: [event('Matched', '2026-08-16T12:00:00Z', '2026-08-16T12:30:00Z')] }) };
      return { ok: true, json: async () => ({ value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendarView?page=2' }) };
    },
  });

  const info = await service.getMeetingInfo({ skipPrefixes: 'Canceled:' });
  assert.equal(info.subject, 'Matched');
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.includes('/me/calendarView?'));
  assert.match(new URL(calls[0].url).searchParams.get('$select'), /organizer,attendees/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic-access');
  assert.match(calls[0].options.headers.Prefer, /outlook\.timezone="UTC"/);
  assert.match(calls[0].options.headers.Prefer, /outlook\.body-content-type="text"/);
});

test('meeting lookup does not send a token to a foreign paging URL', async () => {
  const service = createOfficeGraph({
    getAccessToken: async () => ({ accessToken: 'synthetic-access' }),
    connectOAuth: async () => undefined,
    now: () => new Date('2026-08-16T12:10:00Z'),
    fetchImpl: async () => ({ ok: true, json: async () => ({ value: [], '@odata.nextLink': 'https://example.com/steal' }) }),
  });
  await assert.rejects(() => service.getMeetingInfo(), /invalid paging URL/);
});
