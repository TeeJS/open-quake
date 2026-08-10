(function () {
  'use strict';

  const container = document.getElementById('app-container');
  const statusText = document.getElementById('status-text');
  const feed = document.getElementById('feed');
  const clearBtn = document.getElementById('clear-log');
  const orbTrigger = document.getElementById('orb-trigger');
  
  const pairingOverlay = document.getElementById('pairing-overlay');
  const pairingStatus = document.getElementById('pairing-status');
  const retryBtn = document.getElementById('retry-pairing');

  const tabLogBtn = document.getElementById('tab-log-btn');

  const tabSysBtn = document.getElementById('tab-sys-btn');
  const tabFilesBtn = document.getElementById('tab-files-btn');
  const tabRemoteBtn = document.getElementById('tab-remote-btn');
  
  const metricsView = document.getElementById('metrics-view');
  const filesView = document.getElementById('files-view');
  const remoteView = document.getElementById('remote-view');
  
  const chatInputContainer = document.getElementById('chat-input-container');
  const chatTextInput = document.getElementById('chat-text-input');
  const sendChatBtn = document.getElementById('send-chat-btn');
  
  const cpuVal = document.getElementById('metric-cpu-val');
  const cpuFill = document.getElementById('metric-cpu-fill');
  const memVal = document.getElementById('metric-mem-val');
  const memFill = document.getElementById('metric-mem-fill');
  const netVal = document.getElementById('metric-net-val');
  const netFill = document.getElementById('metric-net-fill');
  const gpuVal = document.getElementById('metric-gpu-val');
  const gpuFill = document.getElementById('metric-gpu-fill');
  const tmpVal = document.getElementById('metric-tmp-val');
  const tmpFill = document.getElementById('metric-tmp-fill');
  const uptimeVal = document.getElementById('metric-uptime');
  const procVal = document.getElementById('metric-proc');
  
  const uploadZone = document.getElementById('upload-zone');
  const fileUploader = document.getElementById('file-uploader');
  const selectedFileBar = document.getElementById('selected-file-bar');
  const selectedFileInfo = document.getElementById('selected-file-info');
  const uploadFileBtn = document.getElementById('upload-file-btn');
  const cancelFileBtn = document.getElementById('cancel-file-btn');
  const filesList = document.getElementById('files-list');
  
  const remoteQrImg = document.getElementById('remote-qr-img');
  const remoteUrlVal = document.getElementById('remote-url-val');
  const remotePinVal = document.getElementById('remote-pin-val');
  const refreshRemoteBtn = document.getElementById('refresh-remote-btn');

  let metricsInterval = null;
  let selectedFileToUpload = null;

  let config = { endpoint: 'http://127.0.0.1:8000', pin: '' };
  let authToken = '';
  let ws = null;
  let voiceWs = null;
  let audioCtx = null;
  let micStream = null;
  let mediaStreamSource = null;
  let scriptProcessor = null;
  let isRecording = false;
  let stopTimer = null;

  function consoleLog(...args) {
    const msg = args.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ');
    console.log('[JARVIS]', msg);
    if (authToken) {
      fetch(`${config.endpoint}/api/log`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({ msg })
      }).catch(() => {});
    }
  }

  // ── Setup & Auth ──

  async function loadConfig() {
    try {
      const r = await fetch('/app-config?app=jarvis', { cache: 'no-store' });
      if (r.ok) {
        const data = await r.json();
        if (data && data.options) {
          config.endpoint = data.options.endpoint || 'http://127.0.0.1:8000';
          let pin = data.options.pin || 'QUAKE';
          if (!pin || pin.startsWith('oqenc:v1:')) {
            pin = 'QUAKE';
          }
          config.pin = pin;
        }
      }
    } catch (e) {
      logSystemMessage('Failed to read open-quake configuration.');
    }
  }

  async function authenticate() {
    if (!config.pin) {
      showPairing('PIN not configured. Enter pairing PIN in editor.');
      return false;
    }

    pairingStatus.textContent = 'Authenticating...';

    const endpointsToTry = [config.endpoint];
    const isLocal = config.endpoint.includes('127.0.0.1') || config.endpoint.includes('localhost');
    if (config.endpoint.startsWith('http://') && !isLocal) {
      endpointsToTry.push(config.endpoint.replace(/^http:/, 'https:'));
    }

    for (let i = 0; i < endpointsToTry.length; i++) {
      const ep = endpointsToTry[i];
      try {
        const r = await fetch(`${ep}/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: config.pin.toUpperCase().trim() })
        });

        if (r.ok) {
          const res = await r.json();
          if (res && res.token) {
            authToken = res.token;
            config.endpoint = ep; // use the working endpoint
            pairingOverlay.classList.remove('open');
            return true;
          }
        }
        if (r.status === 401) {
          showPairing('Pairing failed. Invalid or expired PIN.');
          return false;
        }
      } catch (e) {
        console.warn(`Failed to connect to JARVIS endpoint ${ep}:`, e);
      }
    }

    showPairing('Cannot reach JARVIS server. Is it running?');
    return false;
  }

  function showPairing(message) {
    pairingStatus.textContent = message;
    pairingOverlay.classList.add('open');
  }

  // ── Log UI Helpers ──

  function logSystemMessage(text) {
    const m = document.createElement('div');
    m.className = 'msg sys';
    m.textContent = text;
    feed.appendChild(m);
    scrollFeed();
  }

  function logChatMessage(speaker, text) {
    const m = document.createElement('div');
    m.className = `msg ${speaker === 'user' ? 'user' : 'jarvis'}`;
    m.textContent = text;
    feed.appendChild(m);
    scrollFeed();
    
    // Limit to last 50 messages
    while (feed.children.length > 50) {
      feed.removeChild(feed.firstChild);
    }
  }

  function scrollFeed() {
    feed.scrollTop = feed.scrollHeight;
  }

  function updateStatus(state) {
    container.className = 'container';
    if (state === 'active' || state === 'listening' || state === 'speaking' || state === 'thinking' || state === 'muted') {
      container.classList.add(`state-${state}`);
      statusText.textContent = `Jarvis ${state.charAt(0).toUpperCase() + state.slice(1)}`;
    } else {
      container.classList.add('state-sleeping');
      statusText.textContent = 'Jarvis Sleeping';
    }
  }

  // ── WebSockets Connect ──

  function connectWebSocket() {
    if (ws) {
      try { ws.close(); } catch (e) {}
      ws = null;
    }

    const host = config.endpoint.startsWith('https:') ? config.endpoint.replace(/^https:/, 'wss:') : config.endpoint.replace(/^http:/, 'ws:');
    consoleLog('Connecting status feed: ' + host + '/ws');
    logSystemMessage('Connecting status feed...');
    
    try {
      ws = new WebSocket(`${host}/ws?token=${encodeURIComponent(authToken)}`);
    } catch (e) {
      consoleLog('Failed to create status WebSocket: ' + e.message);
      logSystemMessage('Failed to create status WebSocket.');
      return;
    }

    ws.onopen = () => {
      consoleLog('Status WebSocket connected');
      logSystemMessage('Connected to JARVIS.');
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'status') {
          updateStatus(msg.state);
        } else if (msg.type === 'log') {
          logChatMessage(msg.speaker, msg.text);
        } else if (msg.type === 'sys') {
          logSystemMessage(msg.text);
        } else if (msg.type === 'file_received') {
          logSystemMessage(`File received: ${msg.name} (${Math.round(msg.size / 1024)} KB)`);
        }
      } catch (err) {}
    };

    ws.onclose = (event) => {
      consoleLog('Status WebSocket closed. Code: ' + event.code + ' Reason: ' + (event.reason || 'None'));
      logSystemMessage('Connection lost. Retrying in 5 seconds...');
      updateStatus('sleeping');
      setTimeout(startSetup, 5000);
    };

    ws.onerror = (err) => {
      consoleLog('Status WebSocket error');
      logSystemMessage('WebSocket feed error.');
    };
  }

  // ── Voice Push-to-Talk (PTT) ──

  // Convert Float32 to resampled Int16 PCM
  function f32ToPcm16(f32, srcRate) {
    let s = f32;
    if (srcRate !== 16000) {
      const ratio = srcRate / 16000;
      const len = Math.round(f32.length / ratio);
      s = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        s[i] = f32[Math.min(Math.round(i * ratio), f32.length - 1)];
      }
    }
    const out = new Int16Array(s.length);
    for (let i = 0; i < s.length; i++) {
      out[i] = Math.max(-32768, Math.min(32767, Math.round(s[i] * 32768)));
    }
    return out.buffer;
  }

  async function getMic() {
    console.log('[JARVIS] getMic() requesting default mic...');
    let stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    console.log('[JARVIS] getMic() default stream acquired:', stream.id);
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      console.log('[JARVIS] Detected audio input devices:');
      devs.forEach(d => {
        if (d.kind === 'audioinput') {
          console.log(`  - label: "${d.label}" | deviceId: "${d.deviceId}"`);
        }
      });
      const isWin = navigator.platform.indexOf('Win') !== -1 || navigator.userAgent.indexOf('Windows') !== -1;
      const pnp = isWin ? null : devs.find(d => d.kind === 'audioinput' && /pnp|usb pnp|usb audio/i.test(d.label));
      if (pnp) {
        console.log('[JARVIS] getMic() found PnP mic:', pnp.label);
        if (stream.getAudioTracks()[0].getSettings().deviceId !== pnp.deviceId) {
          stream.getTracks().forEach(t => t.stop());
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: { exact: pnp.deviceId } }
          });
          console.log('[JARVIS] getMic() switched to PnP stream:', stream.id);
        }
      } else {
        console.log('[JARVIS] getMic() using default/preferred mic.');
      }
    } catch (e) {
      console.warn('[JARVIS] Failed to select PnP mic, falling back to default:', e);
    }
    return stream;
  }

  let audioBuffer = [];

  window.pttStart = async function () {
    console.log('[JARVIS] pttStart() triggered');
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = null;
      console.log('[JARVIS] pttStart() - cancelled pending stop, continuing stream.');
      return;
    }
    if (isRecording || voiceWs || !authToken) {
      console.warn('[JARVIS] pttStart() ignored. isRecording:', isRecording, 'voiceWs:', !!voiceWs, 'hasAuth:', !!authToken);
      return;
    }

    try {
      micStream = await getMic();
    } catch (e) {
      console.error('[JARVIS] Microphone access denied:', e);
      logSystemMessage('Microphone access denied or unavailable.');
      return;
    }

    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    } catch (e) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }

    audioBuffer = [];
    const rate = audioCtx.sampleRate;
    console.log('[JARVIS] AudioContext active at rate:', rate, 'state:', audioCtx.state);
    mediaStreamSource = audioCtx.createMediaStreamSource(micStream);
    
    let processCount = 0;
    scriptProcessor = audioCtx.createScriptProcessor(4096, 1, 1);
    scriptProcessor.onaudioprocess = (e) => {
      processCount++;
      if (processCount <= 5 || processCount % 20 === 0) {
        console.log(`[JARVIS] onaudioprocess fired. Count: ${processCount}, State: ${audioCtx.state}`);
      }
      const input = e.inputBuffer.getChannelData(0);
      const chunk = new Float32Array(input);
      
      if (voiceWs && voiceWs.readyState === WebSocket.OPEN) {
        if (audioBuffer.length > 0) {
          audioBuffer.forEach(bufChunk => {
            voiceWs.send(f32ToPcm16(bufChunk, rate));
          });
          audioBuffer = [];
        }
        voiceWs.send(f32ToPcm16(chunk, rate));
      } else {
        audioBuffer.push(chunk);
      }
    };
    
    mediaStreamSource.connect(scriptProcessor);
    scriptProcessor.connect(audioCtx.destination);

    updateStatus('listening');

    const host = config.endpoint.startsWith('https:') ? config.endpoint.replace(/^https:/, 'wss:') : config.endpoint.replace(/^http:/, 'ws:');
    try {
      consoleLog('Opening Voice WebSocket: ' + host + '/ws/phone-audio');
      const w = new WebSocket(`${host}/ws/phone-audio?token=${encodeURIComponent(authToken)}`);
      w.binaryType = 'arraybuffer';
      voiceWs = w;

      w.onopen = () => {
        consoleLog('Voice WebSocket connected');
        if (voiceWs !== w) {
          consoleLog('Voice WebSocket changed, closing socket.');
          try { w.close(); } catch (e) {}
          return;
        }
        isRecording = true;
        if (audioBuffer.length > 0) {
          consoleLog('Flushing ' + audioBuffer.length + ' buffered chunks.');
          audioBuffer.forEach(bufChunk => {
            w.send(f32ToPcm16(bufChunk, rate));
          });
          audioBuffer = [];
        }
      };

      w.onclose = (event) => {
        consoleLog('Voice WebSocket closed. Code: ' + event.code + ' Reason: ' + (event.reason || 'None'));
        if (voiceWs === w) stopVoice('onclose');
      };

      w.onerror = (err) => {
        consoleLog('Voice WebSocket error');
        if (voiceWs === w) {
          logSystemMessage('Audio streaming connection error.');
          stopVoice('onerror');
        }
      };
    } catch (e) {
      console.error('[JARVIS] WebSocket setup failed:', e);
      logSystemMessage('Failed to open audio stream.');
      stopVoice('setup_failed');
      return;
    }
  };

  window.pttStop = function () {
    console.log('[JARVIS] window.pttStop() called');
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = setTimeout(() => {
      stopVoice('pttStop');
      stopTimer = null;
    }, 800);
  };

  function stopVoice(reason) {
    console.log('[JARVIS] stopVoice() called. Reason:', reason);
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }
    isRecording = false;
    updateStatus('sleeping');
    
    if (scriptProcessor) {
      try { scriptProcessor.disconnect(); } catch (e) {}
      scriptProcessor = null;
    }
    if (mediaStreamSource) {
      try { mediaStreamSource.disconnect(); } catch (e) {}
      mediaStreamSource = null;
    }
    if (audioCtx) {
      try { audioCtx.close(); } catch (e) {}
      audioCtx = null;
    }
    if (micStream) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
    }
    if (voiceWs) {
      const w = voiceWs;
      voiceWs = null;
      if (w.readyState === WebSocket.CONNECTING || w.readyState === WebSocket.OPEN) {
        w.close();
      }
    }
  }

  // ── Initialize ──

  async function startSetup() {
    try {
      fetch('/app-api/start');
    } catch (e) {}
    await loadConfig();
    const ok = await authenticate();
    if (ok) {
      connectWebSocket();
    }
  }

  // Clear log button
  clearBtn.addEventListener('click', () => {
    feed.innerHTML = '';
    logSystemMessage('Conversation log cleared.');
  });

  // Re-pair checking button
  retryBtn.addEventListener('click', startSetup);

  // Click on Orb triggers manual toggle PTT (click to start, click to stop)
  orbTrigger.addEventListener('click', async () => {
    if (!authToken) {
      logSystemMessage('Not authenticated yet. Pair with JARVIS first.');
      return;
    }
    if (isRecording) {
      console.log('[JARVIS] Orb clicked while recording - stopping PTT');
      window.pttStop();
    } else {
      console.log('[JARVIS] Orb clicked while idle - starting PTT');
      await window.pttStart();
    }
  });

  // Toggle Desktop UI button
  const toggleDesktopUiBtn = document.getElementById('toggle-desktop-ui');
  if (toggleDesktopUiBtn) {
    toggleDesktopUiBtn.addEventListener('click', async () => {
      if (!authToken || !config.endpoint) return;
      try {
        const r = await fetch(`${config.endpoint}/api/show_ui`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (r.ok) {
          logSystemMessage('Sent desktop UI show command.');
        } else {
          logSystemMessage('Failed to show desktop UI. Server error.');
        }
      } catch (e) {
        logSystemMessage('Cannot connect to JARVIS desktop UI endpoint.');
      }
    });
  }
  // ── Tab Switching Helper ──

  function showView(activeTabId, activeViewElement, showClearBtn = false) {
    // Stop metrics polling if leaving sys tab
    if (activeTabId !== 'tab-sys-btn' && metricsInterval) {
      clearInterval(metricsInterval);
      metricsInterval = null;
    }

    // Hide all views
    feed.style.display = 'none';
    chatInputContainer.style.display = 'none';
    metricsView.style.display = 'none';
    filesView.style.display = 'none';
    remoteView.style.display = 'none';

    // Deactivate all tab buttons
    tabLogBtn.classList.remove('active');
    tabSysBtn.classList.remove('active');
    tabFilesBtn.classList.remove('active');
    tabRemoteBtn.classList.remove('active');

    // Activate current
    const activeTab = document.getElementById(activeTabId);
    if (activeTab) activeTab.classList.add('active');
    if (activeViewElement) activeViewElement.style.display = 'flex';

    // Handle chat input container visibility (only visible on Log tab)
    if (activeTabId === 'tab-log-btn') {
      chatInputContainer.style.display = 'flex';
      feed.style.display = 'flex';
    }

    // Handle clear button visibility
    clearBtn.style.display = showClearBtn ? 'block' : 'none';
  }

  // ── System Metrics Polling ──

  async function fetchMetrics() {
    if (!authToken || !config.endpoint) return;
    try {
      const r = await fetch(`${config.endpoint}/api/metrics`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      if (r.ok) {
        const data = await r.json();
        
        // CPU
        const cpu = data.cpu || 0;
        cpuVal.textContent = Math.round(cpu) + '%';
        cpuFill.style.width = cpu + '%';
        
        // MEM
        const mem = data.mem || 0;
        memVal.textContent = Math.round(mem) + '%';
        memFill.style.width = mem + '%';
        
        // NET
        const net = data.net || 0;
        let netStr = '';
        if (net < 1.0) {
          netStr = Math.round(net * 1024) + ' KB/s';
        } else {
          netStr = net.toFixed(1) + ' MB/s';
        }
        const netPct = Math.min(100, net * 10);
        netVal.textContent = netStr;
        netFill.style.width = netPct + '%';
        
        // GPU
        const gpu = data.gpu || 0;
        if (gpu >= 0) {
          gpuVal.textContent = Math.round(gpu) + '%';
          gpuFill.style.width = gpu + '%';
        } else {
          gpuVal.textContent = 'N/A';
          gpuFill.style.width = '0%';
        }
        
        // TEMP
        const tmp = data.tmp || 0;
        if (tmp >= 0) {
          tmpVal.textContent = Math.round(tmp) + '°C';
          const tmpPct = Math.min(100, tmp);
          tmpFill.style.width = tmpPct + '%';
        } else {
          tmpVal.textContent = 'N/A';
          tmpFill.style.width = '0%';
        }
        
        // Uptime & Processes
        uptimeVal.textContent = data.uptime || '--:--';
        procVal.textContent = data.proc_count || '--';
      }
    } catch (e) {
      console.warn('Failed to fetch system metrics:', e);
    }
  }

  function startMetricsPolling() {
    fetchMetrics();
    if (metricsInterval) clearInterval(metricsInterval);
    metricsInterval = setInterval(fetchMetrics, 2000);
  }

  // ── Chat Command sending ──

  async function sendChatCommand() {
    const text = chatTextInput.value.trim();
    if (!text || !authToken || !config.endpoint) return;
    
    // Append to local log display instantly
    logChatMessage('user', text);
    chatTextInput.value = '';
    
    try {
      const r = await fetch(`${config.endpoint}/api/command`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({ text: text })
      });
      if (!r.ok) {
        logSystemMessage('Failed to deliver command to JARVIS.');
      }
    } catch (e) {
      logSystemMessage('Cannot connect to JARVIS backend to send command.');
    }
  }

  // ── File upload / sharing handlers ──

  const FILE_ICONS = {
    'image': '🖼', 'video': '🎬', 'audio': '🎵', 'pdf': '📄',
    'word': '📝', 'excel': '📊', 'code': '💻', 'archive': '📦',
    'pptx': '📊', 'text': '📃', 'data': '🔧', 'unknown': '📎'
  };
  const EXT_TO_CAT = {
    'jpg': 'image', 'jpeg': 'image', 'png': 'image', 'gif': 'image', 'webp': 'image', 'bmp': 'image', 'svg': 'image', 'ico': 'image',
    'mp4': 'video', 'avi': 'video', 'mov': 'video', 'mkv': 'video', 'wmv': 'video', 'flv': 'video', 'webm': 'video',
    'mp3': 'audio', 'wav': 'audio', 'ogg': 'audio', 'm4a': 'audio', 'flac': 'audio',
    'pdf': 'pdf', 'doc': 'word', 'docx': 'word', 'xls': 'excel', 'xlsx': 'excel',
    'ppt': 'pptx', 'pptx': 'pptx',
    'py': 'code', 'js': 'code', 'ts': 'code', 'html': 'code', 'css': 'code', 'java': 'code', 'cpp': 'code',
    'zip': 'archive', 'rar': 'archive', 'tar': 'archive', 'gz': 'archive', '7z': 'archive',
    'txt': 'text', 'md': 'text', 'log': 'text',
    'csv': 'data', 'json': 'data', 'xml': 'data'
  };

  function getFileCategory(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    return EXT_TO_CAT[ext] || 'unknown';
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  async function loadFilesList() {
    if (!authToken || !config.endpoint) return;
    try {
      const r = await fetch(`${config.endpoint}/api/files`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      if (r.ok) {
        const data = await r.json();
        const list = data.files || [];
        filesList.innerHTML = '';
        
        if (list.length === 0) {
          filesList.innerHTML = '<div class="file-list-empty">No files uploaded yet.</div>';
          return;
        }
        
        list.forEach(f => {
          const row = document.createElement('a');
          row.className = 'file-row';
          row.href = `${config.endpoint}/uploads/${encodeURIComponent(f.name)}?token=${authToken}`;
          row.target = '_blank';
          
          const cat = getFileCategory(f.name);
          const emoji = FILE_ICONS[cat] || FILE_ICONS['unknown'];
          
          row.innerHTML = `
            <span class="file-icon">${emoji}</span>
            <span class="file-name">${f.name}</span>
            <span class="file-size">${formatBytes(f.size)}</span>
          `;
          filesList.appendChild(row);
        });
      }
    } catch (e) {
      console.warn('Failed to load files list:', e);
      filesList.innerHTML = '<div class="file-list-empty">Failed to load files list.</div>';
    }
  }

  function selectFile(file) {
    if (!file) return;
    selectedFileToUpload = file;
    selectedFileInfo.textContent = `${file.name} (${formatBytes(file.size)})`;
    selectedFileBar.style.display = 'flex';
  }

  function clearFileSelection() {
    selectedFileToUpload = null;
    selectedFileInfo.textContent = 'No file chosen';
    selectedFileBar.style.display = 'none';
    fileUploader.value = '';
  }

  async function uploadSelectedFile() {
    if (!selectedFileToUpload || !authToken || !config.endpoint) return;
    const formData = new FormData();
    formData.append('file', selectedFileToUpload);
    
    try {
      selectedFileInfo.textContent = 'Uploading file...';
      uploadFileBtn.disabled = true;
      cancelFileBtn.style.display = 'none';
      
      const r = await fetch(`${config.endpoint}/api/upload`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authToken}` },
        body: formData
      });
      
      if (r.ok) {
        logSystemMessage(`File successfully uploaded: ${selectedFileToUpload.name}`);
        clearFileSelection();
        loadFilesList();
      } else {
        const err = await r.json().catch(() => ({}));
        logSystemMessage(`Upload failed: ${err.error || r.statusText}`);
        clearFileSelection();
      }
    } catch (e) {
      logSystemMessage('Cannot connect to JARVIS backend to upload file.');
      clearFileSelection();
    } finally {
      uploadFileBtn.disabled = false;
      cancelFileBtn.style.display = 'block';
    }
  }

  // ── Remote pairing handlers ──

  async function loadRemotePairing() {
    if (!authToken || !config.endpoint) return;
    try {
      remotePinVal.textContent = 'PENDING';
      const r = await fetch(`${config.endpoint}/api/remote-pairing`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      if (r.ok) {
        const data = await r.json();
        remoteUrlVal.textContent = data.manual_url || data.url || '--';
        remotePinVal.textContent = data.key || '------';
        if (data.qr_code_b64) {
          remoteQrImg.src = data.qr_code_b64;
          remoteQrImg.style.display = 'block';
        } else {
          remoteQrImg.style.display = 'none';
        }
      } else {
        remotePinVal.textContent = 'ERROR';
      }
    } catch (e) {
      console.warn('Failed to load remote pairing data:', e);
      remotePinVal.textContent = 'CONN ERR';
    }
  }

  // ── Tab Event Listeners ──

  tabLogBtn.addEventListener('click', () => {
    showView('tab-log-btn', null, true);
  });

  tabSysBtn.addEventListener('click', () => {
    showView('tab-sys-btn', metricsView, false);
    startMetricsPolling();
  });

  tabFilesBtn.addEventListener('click', () => {
    showView('tab-files-btn', filesView, false);
    loadFilesList();
  });

  tabRemoteBtn.addEventListener('click', () => {
    showView('tab-remote-btn', remoteView, false);
    loadRemotePairing();
  });

  // Chat sending
  sendChatBtn.addEventListener('click', sendChatCommand);
  chatTextInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendChatCommand();
  });

  // Files tab events
  uploadZone.addEventListener('click', () => fileUploader.click());
  fileUploader.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      selectFile(e.target.files[0]);
    }
  });

  uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('dragover');
  });
  uploadZone.addEventListener('dragleave', () => {
    uploadZone.classList.remove('dragover');
  });
  uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      selectFile(e.dataTransfer.files[0]);
    }
  });

  cancelFileBtn.addEventListener('click', clearFileSelection);
  uploadFileBtn.addEventListener('click', uploadSelectedFile);

  // Remote refresh button
  refreshRemoteBtn.addEventListener('click', () => loadRemotePairing());

  // Start initialization
  startSetup();

})();
