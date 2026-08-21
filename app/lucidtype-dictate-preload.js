'use strict';
// Preload for the hidden LucidType dictation capture window. Bridges main <-> the VAD renderer:
// main sends {type:'start'|'stop', ...} on 'lucid-cmd'; the renderer streams each utterance's PCM
// bytes back on 'lucid-pcm'. Sandboxed — no fs/Node in the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lucidDictate', {
  onCommand(cb) { ipcRenderer.on('lucid-cmd', (_e, msg) => { try { cb(msg); } catch (e) {} }); },
  sendPcm(bytes) { ipcRenderer.send('lucid-pcm', bytes); },   // bytes: Uint8Array of Int16LE PCM
  log(msg) { ipcRenderer.send('lucid-log', String(msg)); },
});
