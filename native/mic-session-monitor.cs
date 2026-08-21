// mic-session-monitor.exe — app-scoped microphone-in-use monitor for the meeting recorder. [MIT]
//
// Polls the Windows Core Audio (WASAPI) capture endpoints for ACTIVE audio sessions and reports,
// on stdout, whether any process from a caller-supplied allowlist (e.g. Zoom.exe, Teams.exe,
// ms-teams.exe) currently holds an active capture session — i.e. "a call is in progress". This is
// what lets open-quake auto-start recording ONLY for real meetings and never for Claude-voice or
// other mic use, which a sound/VAD trigger can't distinguish.
//
// It does NOT open the mic itself; it inspects other apps' sessions. open-quake still records using
// its own selected mic + system loopback once this fires.
//
// Protocol: one JSON line per state transition, flushed immediately. Nothing is emitted until a
// real transition is observed — there is deliberately no initial baseline line (see Main).
//   {"active":true,"app":"Zoom.exe"}
//   {"active":false}
// Args: allowlist exe names, comma- or space-separated (one or many args). Defaults to
//   Zoom.exe,Teams.exe,ms-teams.exe when none are given.
//
// Build: csc against System.dll (see build-smtc.js). Dependency-free raw COM interop — the vtable
// order of each interface below is load-bearing; unused slots are stubbed to hold their position.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

class MicSessionMonitor {
    // ---- Core Audio COM interop ----
    enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
    const int DEVICE_STATE_ACTIVE = 0x00000001;
    const int CLSCTX_ALL = 0x17;
    const int AudioSessionStateActive = 1;

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumerator { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator {
        void EnumAudioEndpoints(EDataFlow dataFlow, int stateMask, out IMMDeviceCollection devices);
        void GetDefaultAudioEndpoint();   // unused slots below — order matters, signatures don't
        void GetDevice();
        void RegisterEndpointNotificationCallback();
        void UnregisterEndpointNotificationCallback();
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection {
        void GetCount(out int count);
        void Item(int index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice {
        void Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
            [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        void OpenPropertyStore();
        void GetId();
        void GetState();
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2 {
        void GetAudioSessionControl();   // IAudioSessionManager slot 1
        void GetSimpleAudioVolume();     // IAudioSessionManager slot 2
        void GetSessionEnumerator(out IAudioSessionEnumerator enumerator);   // slot 3
        void RegisterSessionNotification();
        void UnregisterSessionNotification();
        void RegisterDuckNotification();
        void UnregisterDuckNotification();
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionEnumerator {
        void GetCount(out int count);
        void GetSession(int index, out IAudioSessionControl session);
    }

    [ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl {
        void GetState(out int state);    // only slot we call on the base interface
    }

    // QI target of a session control — adds GetProcessId. Full vtable declared so the inherited
    // IAudioSessionControl slots keep their positions ahead of GetProcessId (slot 12).
    [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2 {
        void GetState(out int state);                   // 1
        void GetDisplayName();                          // 2
        void SetDisplayName();                          // 3
        void GetIconPath();                             // 4
        void SetIconPath();                             // 5
        void GetGroupingParam();                        // 6
        void SetGroupingParam();                        // 7
        void RegisterAudioSessionNotification();        // 8
        void UnregisterAudioSessionNotification();      // 9
        void GetSessionIdentifier();                    // 10
        void GetSessionInstanceIdentifier();            // 11
        void GetProcessId(out int pid);                 // 12
        void IsSystemSoundsSession();                   // 13
        void SetDuckingPreference();                    // 14
    }

    static Guid IID_IAudioSessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");

    // Is any allowlisted process currently holding an active capture session? Returns the matched
    // exe name (e.g. "Zoom.exe") or null. Releases every COM object it touches — this runs forever.
    static string ActiveAllowlistedApp(HashSet<string> allow) {
        IMMDeviceEnumerator devEnum = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDeviceCollection coll = null;
        try {
            devEnum.EnumAudioEndpoints(EDataFlow.eCapture, DEVICE_STATE_ACTIVE, out coll);
            int count; coll.GetCount(out count);
            for (int i = 0; i < count; i++) {
                IMMDevice dev = null; object mgrObj = null;
                IAudioSessionManager2 mgr = null; IAudioSessionEnumerator sessEnum = null;
                try {
                    coll.Item(i, out dev);
                    dev.Activate(ref IID_IAudioSessionManager2, CLSCTX_ALL, IntPtr.Zero, out mgrObj);
                    mgr = (IAudioSessionManager2)mgrObj;
                    mgr.GetSessionEnumerator(out sessEnum);
                    int sc; sessEnum.GetCount(out sc);
                    for (int j = 0; j < sc; j++) {
                        IAudioSessionControl ctl = null;
                        try {
                            sessEnum.GetSession(j, out ctl);
                            int state; ctl.GetState(out state);
                            if (state != AudioSessionStateActive) continue;
                            IAudioSessionControl2 ctl2 = (IAudioSessionControl2)ctl;   // QI
                            int pid; ctl2.GetProcessId(out pid);
                            if (pid <= 0) continue;
                            string name = ProcessExeName(pid);
                            if (name != null && allow.Contains(name.ToLowerInvariant())) return name;
                        } catch { /* system-sounds session etc. — skip */ }
                        finally { if (ctl != null) Marshal.ReleaseComObject(ctl); }
                    }
                } catch { /* endpoint we can't inspect — skip */ }
                finally {
                    if (sessEnum != null) Marshal.ReleaseComObject(sessEnum);
                    if (mgr != null) Marshal.ReleaseComObject(mgr);
                    if (dev != null) Marshal.ReleaseComObject(dev);
                }
            }
        } finally {
            if (coll != null) Marshal.ReleaseComObject(coll);
            if (devEnum != null) Marshal.ReleaseComObject(devEnum);
        }
        return null;
    }

    static string ProcessExeName(int pid) {
        try { return Process.GetProcessById(pid).ProcessName + ".exe"; }
        catch { return null; }
    }

    static int Main(string[] args) {
        var allow = new HashSet<string>();
        foreach (var a in args)
            foreach (var part in a.Split(',', ' ', ';'))
                if (part.Trim().Length > 0) allow.Add(part.Trim().ToLowerInvariant());
        if (allow.Count == 0) {
            allow.Add("zoom.exe"); allow.Add("teams.exe"); allow.Add("ms-teams.exe");
        }

        // No synthetic idle baseline: the parent starts from a known-idle recorder, and emitting
        // {"active":false} here read as a call-ended transition — respawning the monitor during a
        // meeting stopped the recording in progress and split it into a new file. The first poll
        // below reports an already-active call within one second anyway.
        bool lastActive = false; string lastApp = null;
        while (true) {
            string app = null;
            try { app = ActiveAllowlistedApp(allow); } catch { app = null; }
            bool active = app != null;
            if (active != lastActive || (active && app != lastApp)) {
                if (!Emit(active, app)) return 0;   // parent pipe gone -> exit quietly
                lastActive = active; lastApp = app;
            }
            Thread.Sleep(1000);
        }
    }

    // Returns false if the stdout pipe is broken (parent process exited) so the caller can stop.
    static bool Emit(bool active, string app) {
        try {
            string line = active
                ? "{\"active\":true,\"app\":\"" + JsonEscape(app) + "\"}"
                : "{\"active\":false}";
            Console.Out.WriteLine(line);
            Console.Out.Flush();
            return true;
        } catch { return false; }
    }

    static string JsonEscape(string s) {
        if (s == null) return "";
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }
}
