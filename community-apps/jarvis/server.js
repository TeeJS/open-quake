const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const https = require('https');

let starting = false;

// Check if port 8000 is listening
function checkPort(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1', timeout: 300 }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      resolve(false);
    });
  });
}

// Download helper function supporting redirects
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(dest);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlink(dest, () => {});
        return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }
      
      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`Failed to download: ${response.statusCode}`));
      }
      
      response.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          resolve();
        });
      });
    }).on('error', (err) => {
      file.close();
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function handle(action, ctx) {
  if (action === 'start') {
    const isRunning = await checkPort(8000);
    if (isRunning) {
      return { ok: true, msg: 'Already running' };
    }
    
    if (starting) {
      return { ok: true, msg: 'Start in progress...' };
    }
    
    starting = true;
    const appDir = __dirname;
    const vbsPath = path.join(appDir, 'start_jarvis.vbs');
    const backendDir = path.join(appDir, 'Mark-XLVI');
    const exePath = path.join(backendDir, 'jarvis_backend.exe');
    
    const mainPyPath = path.join(backendDir, 'main.py');
    console.log('[JARVIS server.js] start: appDir=%s backendDir=%s exeExists=%s mainPyExists=%s', appDir, backendDir, fs.existsSync(exePath), fs.existsSync(mainPyPath));
    if (!fs.existsSync(exePath) && !fs.existsSync(mainPyPath)) {
      starting = false;
      return { ok: false, error: 'JARVIS backend not found. Re-import the drop-in app.' };
    }
    
    if (!fs.existsSync(vbsPath)) {
      starting = false;
      return { ok: false, error: 'start_jarvis.vbs not found' };
    }
    
    // Write options to api_keys.json
    const configPath = path.join(backendDir, 'config', 'api_keys.json');
    try {
      const parentDir = path.dirname(configPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      
      let configData = {};
      if (fs.existsSync(configPath)) {
        try {
          configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (e) {}
      }
      
      // Update with values from open-quake options
      if (ctx.options.gemini_api_key !== undefined && !ctx.options.gemini_api_key.startsWith('oqenc:v1:')) {
        configData.gemini_api_key = ctx.options.gemini_api_key;
      }
      if (ctx.options.llm_provider !== undefined) {
        configData.llm_provider = ctx.options.llm_provider;
      }
      if (ctx.options.llm_url !== undefined) {
        configData.llm_url = ctx.options.llm_url;
      }
      if (ctx.options.llm_model !== undefined) {
        configData.llm_model = ctx.options.llm_model;
      }
      if (ctx.options.os_system !== undefined) {
        configData.os_system = ctx.options.os_system;
      }
      // Mark-XLIX added assistant identity + morning-brief config keys
      if (ctx.options.assistant_name !== undefined) {
        configData.assistant_name = ctx.options.assistant_name;
      }
      if (ctx.options.user_name !== undefined) {
        configData.user_name = ctx.options.user_name;
      }
      if (ctx.options.morning_brief_enabled !== undefined) {
        // app.json sends "true"/"false" (select); Python expects a real bool.
        configData.morning_brief_enabled = (String(ctx.options.morning_brief_enabled).toLowerCase() === 'true');
      }
      // UI accent color (hex string, optional)
      if (ctx.options.ui_color !== undefined) {
        configData.ui_color = ctx.options.ui_color;
      }
      // Pairing PIN — the panel sends this at /login; XLIX accepts it as a static key.
      // 'secret' options arrive encrypted (oqenc:v1:...) when set by the user; a plain
      // default value ("QUAKE") is written as-is so the panel can pair out of the box.
      if (ctx.options.pin !== undefined) {
        const pinVal = String(ctx.options.pin);
        configData.panel_pin = pinVal.startsWith('oqenc:v1:') ? 'QUAKE' : pinVal.toUpperCase();
      }

      // Fallback defaults for missing keys
      if (configData.gemini_api_key === undefined) configData.gemini_api_key = '';
      if (configData.llm_provider === undefined) configData.llm_provider = 'gemini-live';
      if (configData.llm_url === undefined) configData.llm_url = '';
      if (configData.llm_model === undefined) configData.llm_model = '';
      if (configData.os_system === undefined) configData.os_system = 'windows';
      if (configData.assistant_name === undefined) configData.assistant_name = 'JARVIS';
      if (configData.user_name === undefined) configData.user_name = '';
      if (configData.morning_brief_enabled === undefined) configData.morning_brief_enabled = true;
      if (configData.panel_pin === undefined) configData.panel_pin = 'QUAKE';
      
      fs.writeFileSync(configPath, JSON.stringify(configData, null, 2), 'utf8');
      console.log('[JARVIS server.js] Synchronized engine settings to api_keys.json');
    } catch (e) {
      console.error('[JARVIS server.js] Failed to write api_keys.json:', e);
    }
    
    starting = true;
    setTimeout(() => {
      starting = false;
    }, 10000);

    // Spawn backend. Prefer running from source with python main.py if main.py exists,
    // otherwise fallback to the precompiled jarvis_backend.exe.
    if (fs.existsSync(mainPyPath)) {
      try {
        let pythonCmd = 'python';
        if (process.platform === 'win32') {
          const condaPy = 'C:\\Users\\darkn\\miniconda3\\python.exe';
          if (fs.existsSync(condaPy)) {
            pythonCmd = condaPy;
          }
        }
        const logFile = fs.openSync(path.join(backendDir, 'backend_logs.txt'), 'w');
        const child = spawn(pythonCmd, ['main.py'], { cwd: backendDir, windowsHide: false, detached: true, stdio: ['ignore', logFile, logFile] });
        child.on('error', (e) => {
          console.error('[JARVIS server.js] Spawn error (python):', e.message);
          try { fs.writeFileSync(path.join(backendDir, 'spawn_error.txt'), `Spawn error: ${e.message}`, 'utf8'); } catch (_) {}
        });
        child.unref();
        console.log('[JARVIS server.js] Spawned python main.py (pid %s)', child.pid);
      } catch (e) {
        console.error('[JARVIS server.js] Spawn threw (python):', e.message);
        try { fs.writeFileSync(path.join(backendDir, 'spawn_error.txt'), `Spawn threw: ${e.message}`, 'utf8'); } catch (_) {}
      }
      starting = false;
    } else if (fs.existsSync(exePath)) {
      try {
        const child = spawn(exePath, [], { cwd: backendDir, windowsHide: false, detached: true, stdio: 'ignore' });
        child.on('error', (e) => {
          console.error('[JARVIS server.js] Spawn error:', e.message);
          try { fs.writeFileSync(path.join(backendDir, 'spawn_error.txt'), `Spawn error: ${e.message}`, 'utf8'); } catch (_) {}
        });
        child.unref();
        console.log('[JARVIS server.js] Spawned jarvis_backend.exe (pid %s)', child.pid);
      } catch (e) {
        console.error('[JARVIS server.js] Spawn threw:', e.message);
        try { fs.writeFileSync(path.join(backendDir, 'spawn_error.txt'), `Spawn threw: ${e.message}`, 'utf8'); } catch (_) {}
      }
      starting = false;
    } else {
      // Fallback: spawn via VBScript if developer running from source
      execFile('wscript.exe', [vbsPath], { windowsHide: true }, (err, stdout, stderr) => {
        starting = false;
        if (err) {
          console.error('[JARVIS server.js] VBS spawn failed:', err);
        }
      });
    }
    
    return { ok: true, msg: 'Spawning JARVIS backend' };
  }
  
  if (action === 'status') {
    const isRunning = await checkPort(8000);
    return { ok: true, running: isRunning };
  }
  
  return { ok: false, error: 'unknown action' };
}

module.exports = { handle };
