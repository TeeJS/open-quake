# Reserved Display (Windows)

Reserved Display keeps ordinary application windows off the Quake while open-quake is
using it as the panel. Enable it under **Settings → Monitor → Reserved Display**. It is
off by default and does not change the USB HID screen-on/keepalive behavior.

Electron identifies the reserved display from the panel window's current bounds and
sends replaceable topology snapshots to a persistent, per-user C# helper. The helper
uses documented Win32 event hooks plus a low-frequency reconciliation scan. It filters
for visible, non-minimized, unowned top-level application windows, excluding child/tool
windows, cloaked UWP surfaces, shell classes, Open Quake's process, and the helper.

A window counts as occupying the Quake when its center is inside the display or more
than half its rectangle overlaps it. After a drag finishes, the helper preserves the
normal rectangle and maximized state and moves the window to its cached prior display,
the nearest non-Quake display, or the primary display. A few pixels of shadow overlap
do not trigger a move.

If no other display exists, eligible windows relocated to the Quake are minimized and
marked on their HWND for deferred restoration. When a non-Quake display returns, they are validated
by HWND, process id, and window class before being restored. Closed or handle-reused
windows are discarded. The marker also lets a restarted helper distinguish these from
windows the user minimized. **Monitor Mode suspends all enforcement** until it exits.

## Build and automated checks

```powershell
npm run build:smtc
npm test
```

`build:smtc` compiles `native/reserved-display.cs` to
`app/native/reserved-display.exe`. Electron Builder already unpacks and signs every
executable in that directory.

## Repeatable manual checks

Use a build with console logging visible; reserved-display messages use the
`[reserved-display]` prefix.

1. Enable Reserved Display and save. Drag Notepad onto the Quake and release it.
   Confirm Notepad moves back and the panel does not move.
2. Enter Monitor Mode. Drag Notepad onto the Quake and confirm it stays. Exit Monitor
   Mode and repeat; it must move away again.
3. Arrange normal and maximized windows across both primary displays. Power both
   displays off while leaving the Quake connected. Confirm no ordinary window remains
   visible on the Quake.
4. Restore the displays. Confirm deferred windows return to sensible work-area
   positions and maximized windows remain maximized.
5. Repeat with dialogs, multiple windows from one process, UWP apps, minimized apps,
   DevTools, the Start menu, notifications, and the taskbar. Shell surfaces, Open Quake
   windows, minimized windows, and owned dialogs should not be independently moved.
6. Repeat after changing the Quake orientation, reconnecting HDMI, restarting Open
   Quake, and terminating `reserved-display.exe` in Task Manager (it should restart
   while protection remains enabled).
