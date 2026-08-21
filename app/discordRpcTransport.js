'use strict';

const { EventEmitter } = require('events');
const net = require('net');
const path = require('path');

const OPCODE = Object.freeze({ HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 });
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

function ipcEndpoints(platform, env) {
  const p = platform || process.platform;
  const e = env || process.env;
  if (p === 'win32') return Array.from({ length: 10 }, (_, i) => '\\\\?\\pipe\\discord-ipc-' + i);
  const roots = [e.XDG_RUNTIME_DIR, e.TMPDIR, e.TMP, e.TEMP, '/tmp'].filter(Boolean);
  return [...new Set(roots)].flatMap(root => Array.from({ length: 10 }, (_, i) => path.posix.join(root, 'discord-ipc-' + i)));
}

function encodeFrame(opcode, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const frame = Buffer.allocUnsafe(8 + payload.length);
  frame.writeInt32LE(opcode, 0);
  frame.writeInt32LE(payload.length, 4);
  payload.copy(frame, 8);
  return frame;
}

class DiscordRpcTransport extends EventEmitter {
  constructor(options) {
    super();
    const opts = options || {};
    this.clientId = String(opts.clientId || '');
    this.endpoints = opts.endpoints || ipcEndpoints(opts.platform, opts.env);
    this.socketFactory = opts.socketFactory || (endpoint => net.createConnection(endpoint));
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextNonce = 1;
    this.closed = true;
    this.ready = false;
  }

  async connect() {
    if (!this.clientId) throw Object.assign(new Error('Discord application/client ID is not configured'), { code: 'DISCORD_NOT_CONFIGURED' });
    this.disconnect();
    this.closed = false;
    let lastError = null;
    for (const endpoint of this.endpoints) {
      if (this.closed) throw Object.assign(new Error('Discord connection cancelled'), { code: 'DISCORD_DISCONNECTED' });
      try {
        const socket = await this._open(endpoint);
        return await this._handshake(socket);
      } catch (err) {
        lastError = err;
        this._discardSocket();
      }
    }
    const error = new Error('Discord desktop RPC is unavailable');
    error.code = 'DISCORD_NOT_RUNNING';
    error.cause = lastError;
    throw error;
  }

  _open(endpoint) {
    return new Promise((resolve, reject) => {
      let socket;
      try { socket = this.socketFactory(endpoint); } catch (err) { reject(err); return; }
      const onConnect = () => { cleanup(); this.socket = socket; resolve(socket); };
      const onError = err => { cleanup(); try { socket.destroy(); } catch (e) {} reject(err); };
      const cleanup = () => { socket.removeListener('connect', onConnect); socket.removeListener('error', onError); };
      socket.once('connect', onConnect);
      socket.once('error', onError);
    });
  }

  _handshake(socket) {
    return new Promise((resolve, reject) => {
      const onReady = data => { cleanup(); resolve(data); };
      const onFailure = err => { cleanup(); reject(err); };
      const cleanup = () => { this.removeListener('ready', onReady); this.removeListener('protocol-error', onFailure); this.removeListener('disconnect', onFailure); };
      this.once('ready', onReady);
      this.once('protocol-error', onFailure);
      this.once('disconnect', onFailure);
      socket.on('data', chunk => this._onData(chunk));
      socket.on('error', err => this._onDisconnect(err));
      socket.on('close', () => this._onDisconnect(new Error('Discord RPC connection closed')));
      try { socket.write(encodeFrame(OPCODE.HANDSHAKE, { v: 1, client_id: this.clientId })); }
      catch (err) { onFailure(err); }
    });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    while (this.buffer.length >= 8) {
      const opcode = this.buffer.readInt32LE(0);
      const length = this.buffer.readInt32LE(4);
      if (length < 0 || length > MAX_FRAME_BYTES) return this._protocolError('Discord RPC frame length is invalid');
      if (this.buffer.length < 8 + length) return;
      const raw = this.buffer.subarray(8, 8 + length);
      this.buffer = this.buffer.subarray(8 + length);
      let message;
      try { message = JSON.parse(raw.toString('utf8')); }
      catch (err) { return this._protocolError('Discord RPC returned malformed JSON'); }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return this._protocolError('Discord RPC returned an invalid message');
      if (opcode === OPCODE.PING) { try { this.socket.write(encodeFrame(OPCODE.PONG, message)); } catch (err) { this._onDisconnect(err); } continue; }
      if (opcode === OPCODE.CLOSE) { this._onDisconnect(Object.assign(new Error(message.message || 'Discord closed the RPC connection'), { code: message.code })); return; }
      if (opcode !== OPCODE.FRAME) return this._protocolError('Discord RPC returned an unsupported opcode');
      this._dispatch(message);
    }
  }

  _dispatch(message) {
    if (message.cmd === 'DISPATCH' && message.evt === 'READY') {
      this.ready = true;
      this.emit('ready', message.data || {});
      return;
    }
    if (message.nonce != null && this.pending.has(String(message.nonce))) {
      const pending = this.pending.get(String(message.nonce));
      this.pending.delete(String(message.nonce));
      if (message.evt === 'ERROR') {
        const err = new Error((message.data && message.data.message) || 'Discord command failed');
        err.code = message.data && message.data.code;
        err.command = pending.command;
        pending.reject(err);
      } else pending.resolve(message.data);
      return;
    }
    if (message.cmd === 'DISPATCH' && typeof message.evt === 'string') this.emit('event', { type: message.evt, data: message.data });
  }

  request(command, args, event) {
    if (!this.ready || !this.socket) return Promise.reject(Object.assign(new Error('Discord RPC is not connected'), { code: 'DISCORD_DISCONNECTED' }));
    const nonce = String(this.nextNonce++);
    return new Promise((resolve, reject) => {
      this.pending.set(nonce, { resolve, reject, command });
      const payload = { cmd: command, args: args || {}, nonce };
      if (event) payload.evt = String(event);
      try { this.socket.write(encodeFrame(OPCODE.FRAME, payload)); }
      catch (err) { this.pending.delete(nonce); reject(err); }
    });
  }

  _protocolError(message) {
    const err = Object.assign(new Error(message), { code: 'DISCORD_MALFORMED_RESPONSE' });
    this.emit('protocol-error', err);
    this._onDisconnect(err);
  }

  _onDisconnect(err) {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
    this._discardSocket();
    this.emit('disconnect', err);
  }

  _discardSocket() {
    const socket = this.socket;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    if (socket) {
      socket.removeAllListeners();
      try { socket.destroy(); } catch (e) {}
    }
  }

  disconnect() {
    const wasOpen = !this.closed;
    this.closed = true;
    this.ready = false;
    const err = Object.assign(new Error('Discord RPC disconnected'), { code: 'DISCORD_DISCONNECTED' });
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
    this._discardSocket();
    if (wasOpen) this.emit('disconnect', err);
  }
}

module.exports = { DiscordRpcTransport, OPCODE, encodeFrame, ipcEndpoints };
