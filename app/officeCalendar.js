(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OfficeCalendar = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function validDate(value) {
    var date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function dateParts(value, timeZone) {
    var date = validDate(value);
    if (!date) return null;
    var options = { year: 'numeric', month: '2-digit', day: '2-digit' };
    if (timeZone) options.timeZone = timeZone;
    var parts = new Intl.DateTimeFormat('en-CA', options).formatToParts(date);
    var result = {};
    parts.forEach(function (part) {
      if (part.type === 'year' || part.type === 'month' || part.type === 'day') result[part.type] = part.value;
    });
    if (!result.year || !result.month || !result.day) return null;
    return { year: Number(result.year), month: Number(result.month), day: Number(result.day) };
  }

  function keyFromParts(parts) {
    if (!parts) return '';
    return String(parts.year).padStart(4, '0') + '-' + String(parts.month).padStart(2, '0') + '-' + String(parts.day).padStart(2, '0');
  }

  function localDateKey(value, timeZone) {
    return keyFromParts(dateParts(value, timeZone));
  }

  function nextDateKey(parts) {
    if (!parts) return '';
    var next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
    return keyFromParts({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() });
  }

  function dateLabel(value, now, timeZone) {
    var eventKey = localDateKey(value, timeZone);
    var nowParts = dateParts(now, timeZone);
    var todayKey = keyFromParts(nowParts);
    if (eventKey === todayKey) return 'TODAY';
    if (eventKey === nextDateKey(nowParts)) return 'TOMORROW';
    var date = validDate(value);
    if (!date) return 'UPCOMING';
    var options = { weekday: 'short', day: 'numeric', month: 'short' };
    if (timeZone) options.timeZone = timeZone;
    return new Intl.DateTimeFormat(undefined, options).format(date).toUpperCase();
  }

  function groupEvents(events, now, timeZone) {
    var sorted = (events || []).filter(function (event) {
      return event && !event.isCancelled && validDate(event.start);
    }).slice().sort(function (a, b) {
      return validDate(a.start).getTime() - validDate(b.start).getTime();
    });
    var groups = [];
    sorted.forEach(function (event) {
      var key = localDateKey(event.start, timeZone);
      var group = groups.length && groups[groups.length - 1].key === key ? groups[groups.length - 1] : null;
      if (!group) {
        group = { key: key, label: dateLabel(event.start, now, timeZone), events: [] };
        groups.push(group);
      }
      group.events.push(event);
    });
    return groups;
  }

  function durationLabel(start, end) {
    var startDate = validDate(start);
    var endDate = validDate(end);
    if (!startDate || !endDate) return '';
    var minutes = Math.max(0, Math.round((endDate.getTime() - startDate.getTime()) / 60000));
    if (!minutes) return '';
    if (minutes < 60) return minutes + ' min';
    var hours = Math.floor(minutes / 60);
    var remainder = minutes % 60;
    return hours + ' hr' + (hours === 1 ? '' : 's') + (remainder ? ' ' + remainder + ' min' : '');
  }

  return {
    dateLabel: dateLabel,
    durationLabel: durationLabel,
    groupEvents: groupEvents,
    localDateKey: localDateKey,
  };
});
