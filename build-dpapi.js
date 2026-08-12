'use strict';

// Build the first-party Node-API DPAPI binding and copy it beside the app code so electron-builder
// includes it. Node-API keeps this binary compatible between the supported Node and Electron ABIs.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.platform !== 'win32') process.exit(0);

const root = __dirname;
const inputs = [
  path.join(root, 'native', 'dpapi', 'dpapi.cc'),
  path.join(root, 'native', 'dpapi', 'binding.gyp'),
  __filename,
];
const built = path.join(root, 'native', 'dpapi', 'build', 'Release', 'open_quake_dpapi.node');
const output = path.join(root, 'app', 'native', 'open_quake_dpapi.node');

let stale = true;
try {
  const outputTime = fs.statSync(output).mtimeMs;
  stale = !inputs.every(input => outputTime >= fs.statSync(input).mtimeMs);
} catch (e) {}
if (!stale) { console.log('[build:dpapi] up to date'); process.exit(0); }

const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js');
console.log('[build:dpapi] compiling in-process Windows DPAPI binding');
execFileSync(process.execPath, [nodeGyp, 'rebuild', '--directory', path.join(root, 'native', 'dpapi')], { stdio: 'inherit' });
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.copyFileSync(built, output);
console.log('[build:dpapi] built ' + output);
