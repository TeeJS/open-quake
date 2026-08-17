// outlook-meeting.cs — pull the current meeting's details from classic Outlook Desktop over COM.
// [native helper, MIT]
//
// Attaches to the RUNNING Outlook instance only (Marshal.GetActiveObject — never launches one),
// using its already-authenticated MAPI profile: no tokens, no OAuth, no app registration. The
// mechanics mirror the operator's proven Python pipeline (win32com): find the account folder by
// display name, find its calendar folder (DefaultItemType == 1), then on Items set
// IncludeRecurrences, Sort("[Start]"), and Restrict to the day — that exact order is what makes
// recurring meetings expand correctly.
//
// Modes (single-line JSON on stdout; {"ok":false,"error":...} on any failure):
//   outlook-meeting.exe check
//       -> {"ok":true,"accounts":[{"name":"...","calendars":["Calendar",...]},...]}
//   outlook-meeting.exe meeting "<account>" "<calendarFolder>" "<skipPrefix1,skipPrefix2,...>"
//       -> the meeting-info JSON (subject/start/end/attendees/... — the meetings pipeline format),
//          or {"ok":false,"none":true} when nothing on the calendar matches "now".
//
// Which meeting is "now" (operator's rule): most meetings start on the hour or half hour — if the
// next :00/:30 boundary is less than 5 minutes away, the meeting starting at that boundary wins;
// otherwise the meeting whose window contains the current time (latest start wins on overlap).
// Ad-hoc calls with nothing scheduled -> none, no file gets written.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

static class OutlookMeeting {
    // ---- late-bound COM helpers (no Outlook PIA needed at build or run time) ----
    static object Get(object o, string name) {
        try { return o.GetType().InvokeMember(name, BindingFlags.GetProperty, null, o, null); }
        catch { return null; }
    }
    static object Call(object o, string name, params object[] args) {
        return o.GetType().InvokeMember(name, BindingFlags.InvokeMethod, null, o, args);
    }
    static void Set(object o, string name, object v) {
        o.GetType().InvokeMember(name, BindingFlags.SetProperty, null, o, new object[] { v });
    }
    static string S(object o) { return o == null ? null : o.ToString(); }

    // ---- minimal JSON writer ----
    static string J(string s) {
        if (s == null) return "null";
        var sb = new StringBuilder("\"");
        foreach (char c in s) {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c == '\r') sb.Append("\\r");
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\t') sb.Append("\\t");
            else if (c < ' ') sb.AppendFormat("\\u{0:x4}", (int)c);
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }
    static string JList(List<string> items) {
        var parts = new List<string>();
        foreach (var i in items) parts.Add(J(i));
        return "[" + string.Join(",", parts) + "]";
    }
    static void Fail(string msg) { Console.WriteLine("{\"ok\":false,\"error\":" + J(msg) + "}"); Environment.Exit(0); }

    static object Attach() {
        try { return Marshal.GetActiveObject("Outlook.Application"); }
        catch { Fail("Classic Outlook is not running (or not in this Windows session). Start OUTLOOK.EXE and try again."); return null; }
    }

    static string NormalizeName(string value) {
        string name = (value ?? "").Trim();
        int comma = name.IndexOf(',');
        if (comma >= 0) name = (name.Substring(comma + 1).Trim() + " " + name.Substring(0, comma).Trim()).Trim();
        return name == "TJ Schmitz" ? "T.J. Schmitz" : name;
    }

    // Split "a; b; c" attendee/category strings into trimmed values. Attendee names use the same
    // comma-order normalization as the Graph source; category labels remain untouched.
    static List<string> SplitValues(string s, char sep, bool normalizeNames) {
        var outp = new List<string>();
        if (string.IsNullOrEmpty(s)) return outp;
        foreach (var p in s.Split(sep)) {
            var t = normalizeNames ? NormalizeName(p) : p.Trim();
            if (t.Length > 0) outp.Add(t);
        }
        return outp;
    }

    static readonly Dictionary<int, string> RESPONSE = new Dictionary<int, string> {
        { 0, "None" }, { 1, "Organizer" }, { 2, "Tentative" }, { 3, "Accepted" }, { 4, "Declined" }, { 5, "NotResponded" } };
    static readonly Dictionary<int, string> IMPORTANCE = new Dictionary<int, string> {
        { 0, "Low" }, { 1, "Normal" }, { 2, "High" } };
    static readonly Dictionary<int, string> MEETING_STATUS = new Dictionary<int, string> {
        { 0, "NonMeeting" }, { 1, "Meeting" }, { 3, "MeetingReceived" }, { 5, "MeetingCanceled" }, { 7, "MeetingCanceled" } };
    static string MapEnum(Dictionary<int, string> map, object v, string fallback) {
        try { int i = Convert.ToInt32(v); return map.ContainsKey(i) ? map[i] : fallback; } catch { return fallback; }
    }

    static object FindCalendar(object ns, string account, string calFolder) {
        object folders = Get(ns, "Folders");
        int n = Convert.ToInt32(Get(folders, "Count"));
        for (int i = 1; i <= n; i++) {
            object acct = Call(folders, "Item", i);
            string name = S(Get(acct, "Name"));
            if (name == null || !name.Equals(account, StringComparison.OrdinalIgnoreCase)) continue;
            object subs = Get(acct, "Folders");
            int m = Convert.ToInt32(Get(subs, "Count"));
            for (int k = 1; k <= m; k++) {
                object f = Call(subs, "Item", k);
                object dit = Get(f, "DefaultItemType");
                if (S(Get(f, "Name")) == calFolder && dit != null && Convert.ToInt32(dit) == 1) return f;
            }
        }
        return null;
    }

    static void CheckMode(object app) {
        object ns = Call(app, "GetNamespace", "MAPI");
        object folders = Get(ns, "Folders");
        int n = Convert.ToInt32(Get(folders, "Count"));
        var accounts = new List<string>();
        for (int i = 1; i <= n; i++) {
            object acct = Call(folders, "Item", i);
            string name = S(Get(acct, "Name"));
            if (name == null) continue;
            var cals = new List<string>();
            object subs = Get(acct, "Folders");
            int m = 0;
            try { m = Convert.ToInt32(Get(subs, "Count")); } catch { }
            for (int k = 1; k <= m; k++) {
                object f = Call(subs, "Item", k);
                object dit = Get(f, "DefaultItemType");
                if (dit != null && Convert.ToInt32(dit) == 1) cals.Add(S(Get(f, "Name")));
            }
            accounts.Add("{\"name\":" + J(name) + ",\"calendars\":" + JList(cals) + "}");
        }
        Console.WriteLine("{\"ok\":true,\"accounts\":[" + string.Join(",", accounts) + "]}");
    }

    static void MeetingMode(object app, string account, string calFolder, string[] skipPrefixes) {
        object ns = Call(app, "GetNamespace", "MAPI");
        object cal = FindCalendar(ns, account, calFolder);
        if (cal == null) Fail("Calendar folder \"" + calFolder + "\" not found under account \"" + account + "\".");

        DateTime now = DateTime.Now;
        // The exact recipe: restrict to local midnight..23:59, IncludeRecurrences BEFORE Sort BEFORE Restrict.
        string day = now.ToString("MM/dd/yyyy", CultureInfo.InvariantCulture);
        string restriction = "[Start] >= '" + day + " 00:00' AND [Start] <= '" + day + " 23:59'";
        object items = Get(cal, "Items");
        Set(items, "IncludeRecurrences", true);
        Call(items, "Sort", "[Start]");
        object todays = Call(items, "Restrict", restriction);

        // Collect today's candidates (recurrence-expanded collections must be walked GetFirst/GetNext).
        var starts = new List<DateTime>();
        var ends = new List<DateTime>();
        var appts = new List<object>();
        object it = Call(todays, "GetFirst");
        while (it != null) {
            try {
                object allDay = Get(it, "AllDayEvent");
                string subject = S(Get(it, "Subject")) ?? "";
                bool skip = allDay != null && Convert.ToBoolean(allDay);
                foreach (var p in skipPrefixes) {
                    if (p.Length > 0 && subject.StartsWith(p, StringComparison.OrdinalIgnoreCase)) { skip = true; break; }
                }
                if (!skip) {
                    DateTime st = Convert.ToDateTime(Get(it, "Start"));
                    DateTime en = Convert.ToDateTime(Get(it, "End"));
                    if (st.Date == now.Date) { starts.Add(st); ends.Add(en); appts.Add(it); }
                }
            } catch { }
            it = Call(todays, "GetNext");
        }

        // Selection: <5 min before the next :00/:30 boundary -> the meeting starting at that boundary;
        // otherwise the meeting containing now (latest start wins). Nothing matching -> none.
        int chosen = -1;
        DateTime boundary = now.Minute < 30
            ? now.Date.AddHours(now.Hour).AddMinutes(30)
            : now.Date.AddHours(now.Hour + 1);
        if ((boundary - now).TotalMinutes < 5) {
            for (int i = 0; i < appts.Count; i++) {
                if (Math.Abs((starts[i] - boundary).TotalMinutes) <= 1) { chosen = i; break; }   // sorted by start: first match
            }
        }
        if (chosen < 0) {
            for (int i = 0; i < appts.Count; i++) {
                if (starts[i] <= now && now < ends[i]) chosen = i;   // sorted ascending: keep the latest start
            }
        }
        if (chosen < 0) { Console.WriteLine("{\"ok\":false,\"none\":true}"); return; }

        object a = appts[chosen];
        string fmt = "yyyy-MM-ddTHH:mm:ss+00:00";
        var sb = new StringBuilder("{");
        string selectedSubject = S(Get(a, "Subject"));
        selectedSubject = string.IsNullOrEmpty(selectedSubject) ? "Untitled Meeting" : selectedSubject.Trim();
        sb.Append("\"subject\":").Append(J(selectedSubject));
        sb.Append(",\"start\":").Append(J(starts[chosen].ToUniversalTime().ToString(fmt, CultureInfo.InvariantCulture)));
        sb.Append(",\"end\":").Append(J(ends[chosen].ToUniversalTime().ToString(fmt, CultureInfo.InvariantCulture)));
        sb.Append(",\"organizer\":").Append(J(NormalizeName(S(Get(a, "Organizer")))));
        sb.Append(",\"required_attendees\":").Append(JList(SplitValues(S(Get(a, "RequiredAttendees")), ';', true)));
        sb.Append(",\"optional_attendees\":").Append(JList(SplitValues(S(Get(a, "OptionalAttendees")), ';', true)));
        sb.Append(",\"response_status\":").Append(J(MapEnum(RESPONSE, Get(a, "ResponseStatus"), "Unknown")));
        sb.Append(",\"location\":").Append(J(S(Get(a, "Location"))));
        sb.Append(",\"body\":").Append(J(S(Get(a, "Body"))));
        sb.Append(",\"categories\":").Append(JList(SplitValues(S(Get(a, "Categories")), ',', false)));
        sb.Append(",\"importance\":").Append(J(MapEnum(IMPORTANCE, Get(a, "Importance"), "Normal")));
        object rec = Get(a, "IsRecurring");
        sb.Append(",\"is_recurring\":").Append(rec != null && Convert.ToBoolean(rec) ? "true" : "false");
        sb.Append(",\"meeting_status\":").Append(J(MapEnum(MEETING_STATUS, Get(a, "MeetingStatus"), "Appointment")));
        sb.Append(",\"online_meeting_url\":").Append(J(S(Get(a, "OnlineMeetingURL"))));   // null-safe: not on all Outlook builds
        sb.Append("}");
        Console.WriteLine(sb.ToString());
    }

    [STAThread]
    static int Main(string[] args) {
        Console.OutputEncoding = Encoding.UTF8;
        try {
            string mode = args.Length > 0 ? args[0] : "";
            object app = Attach();
            if (mode == "check") { CheckMode(app); return 0; }
            if (mode == "meeting") {
                if (args.Length < 3) { Fail("usage: outlook-meeting.exe meeting <account> <calendar> [skipPrefixes]"); }
                var prefixes = new List<string>();
                if (args.Length > 3) foreach (var p in args[3].Split(',')) { var t = p.Trim(); if (t.Length > 0) prefixes.Add(t); }
                MeetingMode(app, args[1], args[2], prefixes.ToArray());
                return 0;
            }
            Fail("unknown mode: " + mode);
        } catch (Exception e) {
            Fail(e.Message);
        }
        return 0;
    }
}
