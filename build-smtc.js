'use strict';
/*
 * build-smtc.js — compile the bundled C# helpers into app/native with the .NET-Framework C#
 * compiler, referencing the Windows union metadata + the GAC facade contracts. [build tooling, MIT]
 *
 * Build/dev machine only (needs the Windows SDK winmd + .NET Framework, both already present for signing).
 * End users just run the prebuilt, bundled, signed exe — .NET Framework ships in Windows. Idempotent:
 * skips when the exe is already newer than the source. Wired into `npm start` and `npm run dist`.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const NATIVE = path.join(ROOT, 'native');
const OUT_DIR = path.join(ROOT, 'app', 'native');
// Helpers to (re)compile. They share the same compiler and framework references.
const TARGETS = [
  { src: path.join(NATIVE, 'smtc-art.cs'), out: path.join(OUT_DIR, 'smtc-art.exe') },
  { src: path.join(NATIVE, 'smtc-control.cs'), out: path.join(OUT_DIR, 'smtc-control.exe') },
  { src: path.join(NATIVE, 'reserved-display.cs'), out: path.join(OUT_DIR, 'reserved-display.exe') },
];
const log = m => console.log('[build:smtc] ' + m);
// Non-fatal for development: if the native toolchain is absent, JS/Electron still starts and each
// feature logs that its helper is unavailable. Release builds verify the helpers on-device.
const bail = m => { console.warn('[build:smtc] ' + m + ' — skipping native helper compilation.'); process.exit(0); };

// Only (re)build the targets whose source is newer than its exe (or whose exe is missing).
const stale = TARGETS.filter(t => {
  if (!fs.existsSync(t.src)) return false;   // no source -> nothing to build for this target
  try { return !(fs.existsSync(t.out) && fs.statSync(t.out).mtimeMs >= fs.statSync(t.src).mtimeMs); } catch (e) { return true; }
});
if (!stale.length) { log('up to date'); process.exit(0); }

const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
if (!fs.existsSync(csc)) bail('.NET-Framework csc not found: ' + csc);

function newestWinmd() {
  const base = 'C:\\Program Files (x86)\\Windows Kits\\10\\UnionMetadata';
  let dirs = [];
  try { dirs = fs.readdirSync(base).filter(d => /^\d+\./.test(d)).sort().reverse(); } catch (e) {}
  for (const d of dirs) { const p = path.join(base, d, 'Windows.winmd'); if (fs.existsSync(p)) return p; }
  return null;
}
function gacDll(name) {            // GAC_MSIL\<name>\<ver>__<token>\<name>.dll
  const base = path.join('C:\\Windows\\Microsoft.NET\\assembly\\GAC_MSIL', name);
  let subs = [];
  try { subs = fs.readdirSync(base); } catch (e) {}
  for (const s of subs) { const p = path.join(base, s, name + '.dll'); if (fs.existsSync(p)) return p; }
  return null;
}

const winmd = newestWinmd();
if (!winmd) bail('Windows.winmd not found — install the Windows 10/11 SDK.');
const refs = [winmd];
for (const c of ['System.Runtime.WindowsRuntime', 'System.Runtime', 'System.Runtime.InteropServices.WindowsRuntime', 'System.ObjectModel', 'System.Threading.Tasks']) {
  const p = gacDll(c);
  if (!p) bail('GAC facade not found: ' + c);
  refs.push(p);
}
const webExtensions = path.join('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319', 'System.Web.Extensions.dll');
if (!fs.existsSync(webExtensions)) bail('.NET Framework System.Web.Extensions.dll not found.');
refs.push(webExtensions);

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const t of stale) {
  const args = ['/nologo', '/target:exe', '/platform:anycpu', '/out:' + t.out];
  for (const r of refs) args.push('/reference:' + r);
  args.push(t.src);
  log('compiling -> ' + t.out);
  try { execFileSync(csc, args, { stdio: 'inherit' }); } catch (e) { bail('compile failed: ' + path.basename(t.src)); }
  log('built ' + path.basename(t.out) + ' ' + (fs.existsSync(t.out) ? '(' + fs.statSync(t.out).size + ' bytes)' : '— but no exe?!'));
}
