// reserved-display.cs - per-user Win32 window placement helper for Open Quake.
// Reads replaceable configuration snapshots as JSON lines on stdin and emits concise JSON events.
// No elevation, display reconfiguration, injection, global sleep policy, or undocumented APIs.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// Keep the JSON-lines wire contract explicit and independent of the helper's private runtime state.
public sealed class Box {
    public int x { get; set; }
    public int y { get; set; }
    public int width { get; set; }
    public int height { get; set; }
}
public sealed class Display {
    public string id { get; set; }
    public bool primary { get; set; }
    public Box bounds { get; set; }
    public Box workArea { get; set; }
}
public sealed class Command {
    public string command { get; set; }
    public long sequence { get; set; }
    public bool enabled { get; set; }
    public bool suspended { get; set; }
    public int ownProcessId { get; set; }
    public Box reserved { get; set; }
    public Display[] displays { get; set; }
}

internal static class ReservedDisplayProgram
{
    private const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
    private const uint EVENT_SYSTEM_MOVESIZEEND = 0x000B;
    private const uint EVENT_OBJECT_SHOW = 0x8002;
    private const uint EVENT_OBJECT_LOCATIONCHANGE = 0x800B;
    private const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    private const uint WINEVENT_SKIPOWNPROCESS = 0x0002;
    private const int OBJID_WINDOW = 0;
    private const int GWL_STYLE = -16;
    private const int GWL_EXSTYLE = -20;
    private const long WS_CHILD = 0x40000000L;
    private const long WS_EX_TOOLWINDOW = 0x00000080L;
    private const uint GW_OWNER = 4;
    private const uint GA_ROOT = 2;
    private const int DWMWA_CLOAKED = 14;
    private const int SW_HIDE = 0;
    private const int SW_SHOWNORMAL = 1;
    private const int SW_SHOWMINIMIZED = 2;
    private const int SW_SHOWMAXIMIZED = 3;

    private sealed class CachedPlacement {
        public uint ProcessId;
        public string ClassName;
        public RECT Rect;
        public RECT NormalRect;
        public int ShowCmd;
        public string DisplayId;
        public bool HeldByUs;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    private struct WINDOWPLACEMENT {
        public int length;
        public int flags;
        public int showCmd;
        public POINT ptMinPosition;
        public POINT ptMaxPosition;
        public RECT rcNormalPosition;
    }

    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
    private delegate void WinEventDelegate(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr")] private static extern IntPtr GetWindowLongPtr64(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "GetWindowLong")] private static extern IntPtr GetWindowLongPtr32(IntPtr hwnd, int index);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder name, int count);
    [DllImport("user32.dll")] private static extern bool GetWindowPlacement(IntPtr hwnd, ref WINDOWPLACEMENT placement);
    [DllImport("user32.dll")] private static extern bool SetWindowPlacement(IntPtr hwnd, [In] ref WINDOWPLACEMENT placement);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool SetProp(IntPtr hwnd, string name, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetProp(IntPtr hwnd, string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr RemoveProp(IntPtr hwnd, string name);
    [DllImport("user32.dll")] private static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventDelegate callback, uint process, uint thread, uint flags);
    [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);

    private static readonly object Gate = new object();
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static readonly Dictionary<long, CachedPlacement> Cache = new Dictionary<long, CachedPlacement>();
    private static readonly HashSet<string> ShellClasses = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd",
        "Windows.UI.Core.CoreWindow", "XamlExplorerHostIslandWindow",
        "SearchPane", "SearchUI", "NotifyIconOverflowWindow", "MultitaskingViewFrame"
    };
    private const string HeldProperty = "OpenQuake.ReservedDisplay.Held";
    private static Command Current = new Command { displays = new Display[0] };
    private static int HelperProcessId = Process.GetCurrentProcess().Id;
    private static bool Running = true;
    private static Timer ScanTimer;
    private static Timer EventDebounce;
    private static WinEventDelegate HookCallback;
    private static readonly List<IntPtr> Hooks = new List<IntPtr>();

    public static int Main()
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        HookCallback = OnWinEvent; // root the delegate for the lifetime of every native hook
        Hooks.Add(SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, HookCallback, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS));
        Hooks.Add(SetWinEventHook(EVENT_SYSTEM_MOVESIZEEND, EVENT_SYSTEM_MOVESIZEEND, IntPtr.Zero, HookCallback, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS));
        Hooks.Add(SetWinEventHook(EVENT_OBJECT_SHOW, EVENT_OBJECT_SHOW, IntPtr.Zero, HookCallback, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS));
        Hooks.Add(SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, IntPtr.Zero, HookCallback, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS));
        ScanTimer = new Timer(_ => Scan(), null, 250, 700);
        EventDebounce = new Timer(_ => Scan(), null, Timeout.Infinite, Timeout.Infinite);

        string line;
        while (Running && (line = Console.ReadLine()) != null) {
            try {
                Command cmd = Json.Deserialize<Command>(line);
                if (cmd == null) continue;
                if (String.Equals(cmd.command, "stop", StringComparison.OrdinalIgnoreCase)) {
                    RestoreHeldBeforeExit();
                    Running = false;
                    break;
                }
                if (String.Equals(cmd.command, "diagnose", StringComparison.OrdinalIgnoreCase)) {
                    Diagnose();
                    continue;
                }
                if (!String.Equals(cmd.command, "configure", StringComparison.OrdinalIgnoreCase)) continue;
                if (cmd.displays == null) cmd.displays = new Display[0];
                lock (Gate) Current = cmd;
                Emit("configured", null, null, cmd.reserved == null
                    ? "configured without a reserved display"
                    : String.Format("configured reserved={0},{1},{2},{3} fallbacks={4} enabled={5} suspended={6}",
                        cmd.reserved.x, cmd.reserved.y, cmd.reserved.width, cmd.reserved.height,
                        cmd.displays.Length, cmd.enabled, cmd.suspended));
                Scan();
            } catch (Exception e) { Emit("error", null, null, "native helper command error: " + e.Message); }
        }

        if (ScanTimer != null) ScanTimer.Dispose();
        if (EventDebounce != null) EventDebounce.Dispose();
        foreach (IntPtr hook in Hooks) if (hook != IntPtr.Zero) UnhookWinEvent(hook);
        return 0;
    }

    private static void OnWinEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time)
    {
        if (hwnd == IntPtr.Zero || (ev >= EVENT_OBJECT_SHOW && idObject != OBJID_WINDOW)) return;
        if (ev == EVENT_SYSTEM_MOVESIZEEND) {
            Inspect(hwnd);
        } else {
            EventDebounce.Change(120, Timeout.Infinite);
        }
    }

    private static void Scan()
    {
        Command cfg;
        lock (Gate) cfg = Current;
        if (!cfg.enabled || cfg.suspended) return;
        try {
            RecoverMarkedWindows(cfg);
            if (cfg.reserved == null) {
                RestoreDeferred(cfg);
                PruneCache();
                return;
            }
            EnumWindows((hwnd, _) => { Inspect(hwnd); return true; }, IntPtr.Zero);
            RestoreDeferred(cfg);
            PruneCache();
        } catch (Exception e) { Emit("error", null, null, "native helper scan error: " + e.Message); }
    }

    private static void Diagnose()
    {
        Command cfg;
        lock (Gate) cfg = Current;
        if (cfg.reserved == null) {
            Emit("diagnostic", null, null, "reserved display is unresolved");
            return;
        }
        EnumWindows((hwnd, _) => {
            RECT raw;
            if (!GetWindowRect(hwnd, out raw) || IntersectionArea(raw, cfg.reserved) == 0) return true;
            uint pid;
            string className;
            RECT eligibleRect;
            bool eligible = Eligible(hwnd, cfg, out pid, out eligibleRect, out className);
            bool occupies = eligible && Occupies(eligibleRect, cfg.reserved, cfg.displays);
            StringBuilder actualClass = new StringBuilder(256);
            GetClassName(hwnd, actualClass, actualClass.Capacity);
            uint actualPid;
            GetWindowThreadProcessId(hwnd, out actualPid);
            int cloaked = 0;
            DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out cloaked, sizeof(int));
            string message = String.Format(
                "diagnostic hwnd=0x{0:X} pid={1} class={2} rect={3},{4},{5},{6} visible={7} iconic={8} root={9} owner={10} style=0x{11:X} exstyle=0x{12:X} cloaked={13} eligible={14} occupies={15}",
                hwnd.ToInt64(), actualPid, actualClass, raw.Left, raw.Top, raw.Right, raw.Bottom,
                IsWindowVisible(hwnd), IsIconic(hwnd), GetAncestor(hwnd, GA_ROOT) == hwnd,
                GetWindow(hwnd, GW_OWNER) != IntPtr.Zero, GetLong(hwnd, GWL_STYLE),
                GetLong(hwnd, GWL_EXSTYLE), cloaked, eligible, occupies);
            Emit("diagnostic", hwnd, null, message);
            return true;
        }, IntPtr.Zero);
    }

    private static void Inspect(IntPtr hwnd)
    {
        Command cfg;
        lock (Gate) cfg = Current;
        if (!cfg.enabled || cfg.suspended || cfg.reserved == null) return;

        uint pid;
        RECT rect;
        string className;
        if (!Eligible(hwnd, cfg, out pid, out rect, out className)) return;
        long key = hwnd.ToInt64();
        Display ordinary = BestOverlapDisplay(rect, cfg.displays);

        if (!Occupies(rect, cfg.reserved, cfg.displays)) {
            if (ordinary != null) Remember(hwnd, pid, className, rect, ordinary);
            return;
        }

        CachedPlacement cached;
        lock (Gate) Cache.TryGetValue(key, out cached);
        Emit("detected", hwnd, null, "foreign window detected on reserved display");
        Display fallback = ChooseFallback(rect, cached, cfg.displays);
        if (fallback == null) {
            if (cached == null) cached = ReadPlacement(hwnd, pid, className, rect, null);
            if (!cached.HeldByUs) {
                cached.HeldByUs = true;
                lock (Gate) Cache[key] = cached;
                SetProp(hwnd, HeldProperty, new IntPtr(1));
                Emit("deferred", hwnd, null, "window restore deferred; no non-Quake display is available");
            }
            // Minimization is recoverable even if the helper is force-terminated. The HWND property
            // lets a restarted helper distinguish windows it held from windows the user minimized.
            ShowWindow(hwnd, SW_SHOWMINIMIZED);
            return;
        }

        if (cached == null) cached = ReadPlacement(hwnd, pid, className, rect, fallback.id);
        MoveTo(hwnd, cached, fallback);
    }

    private static bool Eligible(IntPtr hwnd, Command cfg, out uint pid, out RECT rect, out string className)
    {
        pid = 0; rect = new RECT(); className = "";
        if (!IsWindow(hwnd) || !IsWindowVisible(hwnd) || IsIconic(hwnd)) return false;
        if (GetAncestor(hwnd, GA_ROOT) != hwnd || GetWindow(hwnd, GW_OWNER) != IntPtr.Zero) return false;
        long style = GetLong(hwnd, GWL_STYLE);
        long exStyle = GetLong(hwnd, GWL_EXSTYLE);
        if ((style & WS_CHILD) != 0 || (exStyle & WS_EX_TOOLWINDOW) != 0) return false;
        GetWindowThreadProcessId(hwnd, out pid);
        if (pid == 0 || pid == cfg.ownProcessId || pid == HelperProcessId) return false;
        StringBuilder name = new StringBuilder(256);
        GetClassName(hwnd, name, name.Capacity);
        className = name.ToString();
        if (ShellClasses.Contains(className)) return false;
        int cloaked;
        if (DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out cloaked, sizeof(int)) == 0 && cloaked != 0) return false;
        if (!GetWindowRect(hwnd, out rect) || rect.Right - rect.Left < 40 || rect.Bottom - rect.Top < 40) return false;
        return true;
    }

    private static long GetLong(IntPtr hwnd, int index)
    {
        return IntPtr.Size == 8 ? GetWindowLongPtr64(hwnd, index).ToInt64() : GetWindowLongPtr32(hwnd, index).ToInt64();
    }

    private static bool Occupies(RECT r, Box reserved, Display[] displays)
    {
        long area = Math.Max(0, r.Right - r.Left) * (long)Math.Max(0, r.Bottom - r.Top);
        if (area == 0) return false;
        long overlap = IntersectionArea(r, reserved);
        // GetWindowRect includes the portion of an oversized window hanging outside the virtual
        // desktop. That area is not visible and must not dilute the overlap percentage. Sum the
        // parts intersecting connected displays, including the reserved display itself.
        long visibleArea = overlap;
        if (displays != null) foreach (Display d in displays)
            if (d != null && d.bounds != null) visibleArea += IntersectionArea(r, d.bounds);
        visibleArea = Math.Min(area, visibleArea); // tolerate mirrored/overlapping display bounds
        int centerX = r.Left + (r.Right - r.Left) / 2;
        int centerY = r.Top + (r.Bottom - r.Top) / 2;
        bool centerInside = centerX >= reserved.x && centerX < reserved.x + reserved.width &&
                            centerY >= reserved.y && centerY < reserved.y + reserved.height;
        return centerInside || (visibleArea > 0 && overlap * 2 > visibleArea);
    }

    private static long IntersectionArea(RECT r, Box b)
    {
        int left = Math.Max(r.Left, b.x), top = Math.Max(r.Top, b.y);
        int right = Math.Min(r.Right, b.x + b.width), bottom = Math.Min(r.Bottom, b.y + b.height);
        return Math.Max(0, right - left) * (long)Math.Max(0, bottom - top);
    }

    private static Display BestOverlapDisplay(RECT rect, Display[] displays)
    {
        Display best = null; long bestArea = 0;
        foreach (Display d in displays) {
            if (d == null || d.bounds == null) continue;
            long area = IntersectionArea(rect, d.bounds);
            if (area > bestArea) { bestArea = area; best = d; }
        }
        return best;
    }

    private static Display ChooseFallback(RECT rect, CachedPlacement cached, Display[] displays)
    {
        if (cached != null && cached.DisplayId != null)
            foreach (Display d in displays) if (d != null && d.id == cached.DisplayId) return d;
        Display overlap = BestOverlapDisplay(rect, displays);
        if (overlap != null) return overlap;
        Display nearest = null; long nearestDistance = long.MaxValue;
        int cx = rect.Left + (rect.Right - rect.Left) / 2, cy = rect.Top + (rect.Bottom - rect.Top) / 2;
        foreach (Display d in displays) {
            if (d == null || d.workArea == null) continue;
            int dx = cx < d.workArea.x ? d.workArea.x - cx : (cx > d.workArea.x + d.workArea.width ? cx - d.workArea.x - d.workArea.width : 0);
            int dy = cy < d.workArea.y ? d.workArea.y - cy : (cy > d.workArea.y + d.workArea.height ? cy - d.workArea.y - d.workArea.height : 0);
            long distance = (long)dx * dx + (long)dy * dy;
            if (distance < nearestDistance || (distance == nearestDistance && d.primary)) { nearest = d; nearestDistance = distance; }
        }
        return nearest;
    }

    private static CachedPlacement ReadPlacement(IntPtr hwnd, uint pid, string className, RECT rect, string displayId)
    {
        WINDOWPLACEMENT wp = NewPlacement();
        GetWindowPlacement(hwnd, ref wp);
        return new CachedPlacement {
            ProcessId = pid, ClassName = className, Rect = rect,
            NormalRect = wp.rcNormalPosition, ShowCmd = wp.showCmd, DisplayId = displayId
        };
    }

    private static void Remember(IntPtr hwnd, uint pid, string className, RECT rect, Display display)
    {
        CachedPlacement value = ReadPlacement(hwnd, pid, className, rect, display.id);
        lock (Gate) Cache[hwnd.ToInt64()] = value;
    }

    private static void MoveTo(IntPtr hwnd, CachedPlacement cached, Display destination)
    {
        if (destination.workArea == null) return;
        Display source = null;
        Command cfg;
        lock (Gate) cfg = Current;
        foreach (Display d in cfg.displays) if (d != null && d.id == cached.DisplayId) source = d;

        RECT basis = cached.NormalRect.Right > cached.NormalRect.Left ? cached.NormalRect : cached.Rect;
        int width = basis.Right - basis.Left, height = basis.Bottom - basis.Top;
        Box dest = destination.workArea;
        int x, y;
        if (source != null && source.workArea != null) {
            Box src = source.workArea;
            double rx = src.width > width ? (basis.Left - src.x) / (double)(src.width - width) : 0;
            double ry = src.height > height ? (basis.Top - src.y) / (double)(src.height - height) : 0;
            x = dest.x + (int)Math.Round(Math.Max(0, Math.Min(1, rx)) * Math.Max(0, dest.width - width));
            y = dest.y + (int)Math.Round(Math.Max(0, Math.Min(1, ry)) * Math.Max(0, dest.height - height));
        } else {
            x = dest.x + Math.Max(0, Math.Min(dest.width - Math.Min(width, dest.width), basis.Left - dest.x));
            y = dest.y + Math.Max(0, Math.Min(dest.height - Math.Min(height, dest.height), basis.Top - dest.y));
        }
        width = Math.Min(width, dest.width); height = Math.Min(height, dest.height);
        x = Math.Max(dest.x, Math.Min(x, dest.x + dest.width - width));
        y = Math.Max(dest.y, Math.Min(y, dest.y + dest.height - height));

        WINDOWPLACEMENT wp = NewPlacement();
        if (!GetWindowPlacement(hwnd, ref wp)) return;
        wp.rcNormalPosition = new RECT { Left = x, Top = y, Right = x + width, Bottom = y + height };
        if (cached.ShowCmd == SW_SHOWMAXIMIZED) wp.showCmd = SW_SHOWMAXIMIZED;
        else if (cached.ShowCmd == SW_SHOWMINIMIZED) wp.showCmd = SW_SHOWNORMAL;
        else wp.showCmd = cached.ShowCmd == 0 ? SW_SHOWNORMAL : cached.ShowCmd;
        if (SetWindowPlacement(hwnd, ref wp)) {
            cached.DisplayId = destination.id;
            cached.NormalRect = wp.rcNormalPosition;
            cached.HeldByUs = false;
            lock (Gate) Cache[hwnd.ToInt64()] = cached;
            RemoveProp(hwnd, HeldProperty);
            ShowWindow(hwnd, wp.showCmd);
            Emit("moved", hwnd, destination.id, "window moved; selected fallback monitor " + destination.id);
        }
    }

    private static void RestoreDeferred(Command cfg)
    {
        if (cfg.displays == null || cfg.displays.Length == 0) return;
        List<KeyValuePair<long, CachedPlacement>> deferred = new List<KeyValuePair<long, CachedPlacement>>();
        lock (Gate) foreach (KeyValuePair<long, CachedPlacement> pair in Cache) if (pair.Value.HeldByUs) deferred.Add(pair);
        foreach (KeyValuePair<long, CachedPlacement> pair in deferred) {
            IntPtr hwnd = new IntPtr(pair.Key);
            uint pid; GetWindowThreadProcessId(hwnd, out pid);
            if (!IsWindow(hwnd) || pid != pair.Value.ProcessId || ClassOf(hwnd) != pair.Value.ClassName) continue;
            Display fallback = ChooseFallback(pair.Value.Rect, pair.Value, cfg.displays);
            if (fallback == null) continue;
            MoveTo(hwnd, pair.Value, fallback);
            Emit("restored", hwnd, fallback.id, "window restored after monitor return");
        }
    }

    private static void RecoverMarkedWindows(Command cfg)
    {
        EnumWindows((hwnd, _) => {
            if (GetProp(hwnd, HeldProperty) == IntPtr.Zero) return true;
            uint pid; GetWindowThreadProcessId(hwnd, out pid);
            if (pid == 0 || pid == cfg.ownProcessId || pid == HelperProcessId) return true;
            long key = hwnd.ToInt64();
            lock (Gate) {
                if (!Cache.ContainsKey(key)) {
                    RECT rect; GetWindowRect(hwnd, out rect);
                    CachedPlacement value = ReadPlacement(hwnd, pid, ClassOf(hwnd), rect, null);
                    value.HeldByUs = true;
                    Cache[key] = value;
                }
            }
            return true;
        }, IntPtr.Zero);
    }

    private static void RestoreHeldBeforeExit()
    {
        Command cfg;
        lock (Gate) cfg = Current;
        RecoverMarkedWindows(cfg);
        List<KeyValuePair<long, CachedPlacement>> held = new List<KeyValuePair<long, CachedPlacement>>();
        lock (Gate) foreach (KeyValuePair<long, CachedPlacement> pair in Cache) if (pair.Value.HeldByUs) held.Add(pair);
        foreach (KeyValuePair<long, CachedPlacement> pair in held) {
            IntPtr hwnd = new IntPtr(pair.Key);
            if (!IsWindow(hwnd)) continue;
            Display fallback = ChooseFallback(pair.Value.Rect, pair.Value, cfg.displays);
            if (fallback != null) MoveTo(hwnd, pair.Value, fallback);
            else {
                RemoveProp(hwnd, HeldProperty);
                ShowWindow(hwnd, pair.Value.ShowCmd == SW_SHOWMAXIMIZED ? SW_SHOWMAXIMIZED : SW_SHOWNORMAL);
            }
        }
    }

    private static void PruneCache()
    {
        List<long> dead = new List<long>();
        lock (Gate) {
            foreach (KeyValuePair<long, CachedPlacement> pair in Cache) {
                IntPtr hwnd = new IntPtr(pair.Key);
                uint pid; GetWindowThreadProcessId(hwnd, out pid);
                if (!IsWindow(hwnd) || pid != pair.Value.ProcessId || ClassOf(hwnd) != pair.Value.ClassName) dead.Add(pair.Key);
            }
            foreach (long key in dead) Cache.Remove(key);
        }
    }

    private static string ClassOf(IntPtr hwnd)
    {
        StringBuilder value = new StringBuilder(256);
        GetClassName(hwnd, value, value.Capacity);
        return value.ToString();
    }

    private static WINDOWPLACEMENT NewPlacement()
    {
        WINDOWPLACEMENT value = new WINDOWPLACEMENT();
        value.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
        return value;
    }

    private static void Emit(string eventName, IntPtr? hwnd, string fallback, string message)
    {
        try {
            Dictionary<string, object> value = new Dictionary<string, object>();
            value["event"] = eventName;
            if (hwnd.HasValue) value["hwnd"] = "0x" + hwnd.Value.ToInt64().ToString("X");
            if (fallback != null) value["fallback"] = fallback;
            value["message"] = message;
            Console.WriteLine(Json.Serialize(value));
        } catch { }
    }
}
