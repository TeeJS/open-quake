'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { DiscordRpcTransport, OPCODE, encodeFrame, ipcEndpoints } = require('../app/discordRpcTransport');

class MockSocket extends EventEmitter {
  constructor() { super(); this.writes = []; this.destroyed = false; }
  write(data) { this.writes.push(Buffer.from(data)); return true; }
  destroy() { this.destroyed = true; }
}

function decode(buffer) {
  return { opcode: buffer.readInt32LE(0), body: JSON.parse(buffer.subarray(8).toString('utf8')) };
}

function connectedTransport() {
  const socket = new MockSocket();
  const transport = new DiscordRpcTransport({ clientId: '123', endpoints: ['mock'], socketFactory: () => socket });
  const connecting = transport.connect();
  socket.emit('connect');
  setImmediate(() => socket.emit('data', encodeFrame(OPCODE.FRAME, { cmd: 'DISPATCH', evt: 'READY', data: { user: { id: 'u' } } })));
  return connecting.then(() => ({ transport, socket }));
}

test('endpoint discovery isolates Windows named pipes and Unix runtime sockets', () => {
  assert.equal(ipcEndpoints('win32', {})[0], '\\\\?\\pipe\\discord-ipc-0');
  assert.deepEqual(ipcEndpoints('linux', { XDG_RUNTIME_DIR: '/run/user/1' }).slice(0, 2), ['/run/user/1/discord-ipc-0', '/run/user/1/discord-ipc-1']);
});

test('unavailable Discord rejects as not-running after endpoint attempts', async () => {
  let attempts = 0;
  const transport = new DiscordRpcTransport({ clientId: '123', endpoints: ['a', 'b'], socketFactory: () => {
    attempts += 1;
    const socket = new MockSocket();
    process.nextTick(() => socket.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })));
    return socket;
  } });
  await assert.rejects(transport.connect(), error => error.code === 'DISCORD_NOT_RUNNING');
  assert.equal(attempts, 2);
});

test('handshake framing and command/response nonce correlation', async () => {
  const { transport, socket } = await connectedTransport();
  assert.deepEqual(decode(socket.writes[0]), { opcode: OPCODE.HANDSHAKE, body: { v: 1, client_id: '123' } });
  const first = transport.request('GET_GUILDS');
  const second = transport.request('GET_CHANNEL', { channel_id: 'c' });
  const firstFrame = decode(socket.writes[1]);
  const secondFrame = decode(socket.writes[2]);
  socket.emit('data', Buffer.concat([
    encodeFrame(OPCODE.FRAME, { cmd: 'GET_CHANNEL', nonce: secondFrame.body.nonce, data: { id: 'c' } }),
    encodeFrame(OPCODE.FRAME, { cmd: 'GET_GUILDS', nonce: firstFrame.body.nonce, data: { guilds: [] } }),
  ]));
  assert.deepEqual(await second, { id: 'c' });
  assert.deepEqual(await first, { guilds: [] });
  transport.disconnect();
});

test('subscription frames include the documented event and arguments', async () => {
  const { transport, socket } = await connectedTransport();
  const pending = transport.request('SUBSCRIBE', { channel_id: 'voice' }, 'SPEAKING_START');
  const frame = decode(socket.writes[1]);
  assert.deepEqual(frame.body, { cmd: 'SUBSCRIBE', args: { channel_id: 'voice' }, nonce: frame.body.nonce, evt: 'SPEAKING_START' });
  socket.emit('data', encodeFrame(OPCODE.FRAME, { cmd: 'SUBSCRIBE', nonce: frame.body.nonce, data: { evt: 'SPEAKING_START' } }));
  await pending;
  transport.disconnect();
});

test('malformed response is reported and disconnects cleanly', async () => {
  const { transport, socket } = await connectedTransport();
  const errors = [];
  transport.on('protocol-error', error => errors.push(error));
  const pending = transport.request('GET_GUILDS');
  const bad = Buffer.alloc(9); bad.writeInt32LE(OPCODE.FRAME, 0); bad.writeInt32LE(1, 4); bad[8] = 0x7b;
  socket.emit('data', bad);
  await assert.rejects(pending, error => error.code === 'DISCORD_MALFORMED_RESPONSE');
  assert.equal(errors.length, 1);
  assert.equal(socket.destroyed, true);
});

test('dispatch events are emitted and disconnect removes socket listeners', async () => {
  const { transport, socket } = await connectedTransport();
  const events = [];
  transport.on('event', event => events.push(event));
  socket.emit('data', encodeFrame(OPCODE.FRAME, { cmd: 'DISPATCH', evt: 'VOICE_SETTINGS_UPDATE', data: { mute: true } }));
  assert.deepEqual(events, [{ type: 'VOICE_SETTINGS_UPDATE', data: { mute: true } }]);
  transport.disconnect();
  assert.equal(socket.eventNames().length, 0);
});
