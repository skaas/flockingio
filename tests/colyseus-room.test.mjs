import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@colyseus/sdk';
import {
  FrameBatcher,
  FleetColyseusRoom,
  isLiveOwnedEntity,
  neutralizeExpiredInputs,
} from '../server/colyseus-room.mjs';

const require = createRequire(import.meta.url);

test('Cloud PM2 configuration starts precisely one forked ESM server', () => {
  const config = require('../ecosystem.config.js');
  assert.equal(config.apps.length, 1);
  assert.equal(config.apps[0].instances, 1);
  assert.equal(config.apps[0].exec_mode, 'fork');
  assert.equal(config.apps[0].script, 'server/colyseus.mjs');
});

test('frame batch cannot grow beyond three ticks', () => {
  const batch = new FrameBatcher();
  batch.push({ tick: 1 });
  batch.push({ tick: 2 });
  batch.push({ tick: 3 });
  assert.throws(() => batch.push({ tick: 4 }), /drained/);
  assert.deepEqual(batch.drain().map(frame => frame.tick), [1, 2, 3]);
  assert.equal(batch.size, 0);
});

test('death then held-input timeout keeps the connection; a fresh sortie accepts neutral input', () => {
  const applied = [];
  const coordinator = {
    entity: id => id === 8 ? { boids: [{}, {}, {}, {}] } : undefined,
    setInput: (...args) => applied.push(args),
  };
  const state = { entityId: 7, neutralized: false, lastInputAt: 0, serverSequence: 4 };
  const connections = new Map([['socket-1', state]]);
  assert.equal(isLiveOwnedEntity(coordinator, 7), false);
  assert.doesNotThrow(() => neutralizeExpiredInputs(coordinator, connections, 500));
  assert.equal(state.neutralized, true);
  assert.equal(connections.size, 1);
  assert.deepEqual(applied, []);

  state.entityId = 8; // The same connection received a new 4-drone sortie.
  state.neutralized = false;
  assert.equal(isLiveOwnedEntity(coordinator, 8), true);
  assert.doesNotThrow(() => neutralizeExpiredInputs(coordinator, connections, 501));
  assert.deepEqual(applied, [['socket-1', {}, 5]]);
  assert.equal(connections.size, 1);
});

test('join authentication rejects wrong protocol and authority fields', () => {
  const onAuth = FleetColyseusRoom.prototype.onAuth;
  assert.equal(onAuth(null, { nickname: '새벽 매', protocol: 1 }), true);
  assert.throws(() => onAuth(null, { nickname: '새벽 매', version: 1 }));
  assert.throws(() => onAuth(null, { nickname: '새벽 매', protocol: 1, seed: 7 }));
  assert.throws(() => onAuth(null, { nickname: ' ', protocol: 1 }));
});

async function freePort() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

function nextMessage(room, type, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unbind(); reject(new Error(`Timed out waiting for ${type}`)); }, timeoutMs);
    const unbind = room.onMessage(type, payload => { clearTimeout(timer); unbind(); resolve(payload); });
  });
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.json()).roomId === 'flocking-main') return;
    } catch { /* Server is still booting. */ }
    await delay(100);
  }
  throw new Error('Server did not become healthy');
}

test('actual SDK joins the eager room, receives resync, and re-entry gets fresh authority',
  { timeout: 25000 }, async () => {
    const port = await freePort();
    const child = spawn(process.execPath, ['server/colyseus.mjs'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
      stdio: 'ignore',
    });
    const joined = [];
    try {
      await waitForHealth(port, child);
      const client = new Client(`http://127.0.0.1:${port}`);
      const first = await client.joinById('flocking-main', { nickname: '새벽 매', protocol: 1 });
      joined.push(first);
      first.onMessage('*', () => {});
      const welcome = nextMessage(first, 'welcome');
      const snapshot = nextMessage(first, 'snapshot');
      first.send('resync', {});
      const firstWelcome = await welcome;
      assert.equal(firstWelcome.version, 1);
      assert.equal(typeof firstWelcome.entityId, 'number');
      assert.ok(await snapshot);
      const rejected = nextMessage(first, 'room-error');
      first.send('input', { sequence: 1, input: null });
      assert.equal((await rejected).code, 'INVALID_INPUT');
      assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
      await first.leave();
      joined.splice(joined.indexOf(first), 1);

      const second = await client.joinById('flocking-main', { nickname: '새벽 매', protocol: 1 });
      joined.push(second);
      second.onMessage('*', () => {});
      const secondWelcome = nextMessage(second, 'welcome');
      second.send('resync', {});
      assert.notEqual((await secondWelcome).entityId, firstWelcome.entityId);
      const unavailable = nextMessage(second, 'room-error');
      second.send('respawn', {});
      assert.equal((await unavailable).code, 'RESPAWN_UNAVAILABLE');
      assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    } finally {
      try {
        await Promise.race([
          Promise.allSettled(joined.map(room => Promise.resolve().then(() => room.leave()))),
          delay(500),
        ]);
      } finally {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM');
        await Promise.race([exited, delay(2000)]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }
  });
