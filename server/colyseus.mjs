import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineRoom, defineServer, matchMaker } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import {
  FleetColyseusRoom,
  ROOM_NAME,
  ROOM_ID,
  getActiveColyseusRoom,
  roomBootstrapOptions,
} from './colyseus-room.mjs';
import { AUDIO_FILES } from '../src/audio.mjs';
import { IMAGE_FILES } from '../src/sprites.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const clientDirectory = resolve(root, 'dist/multiplayer/client');
const audioPaths = new Set(AUDIO_FILES);
const imagePaths = new Set(IMAGE_FILES);
const staticPaths = new Set([
  'index.html', 'style.css', 'multiplayer-config.json', 'vendor/colyseus-sdk.mjs',
  ...audioPaths, ...imagePaths,
]);
let bootPromise;

// Only direct joinById reservations are exposed over HTTP. Room creation is
// server-only, and onCreate also requires the process-private boot token.
matchMaker.controller.exposedMethods = ['joinById'];

export const server = defineServer({
  rooms: { [ROOM_NAME]: defineRoom(FleetColyseusRoom) },
  transport: new WebSocketTransport({
    pingInterval: 5000,
    pingMaxRetries: 2,
    maxPayload: 2048,
  }),
  beforeListen: async () => {
    // Cloud's listen path may invoke prepareServices twice; a failed boot stays
    // failed instead of risking a second independently simulated room.
    bootPromise ??= (async () => {
      await matchMaker.onReady;
      const listing = await matchMaker.createRoom(ROOM_NAME, roomBootstrapOptions());
      if (listing.roomId !== ROOM_ID || !getActiveColyseusRoom()) {
        throw new Error('The single fleet room did not initialize');
      }
    })();
    await bootPromise;
  },
  express: app => {
    app.get('/health', (_req, res) => {
      const active = getActiveColyseusRoom();
      res.status(active && !active.disposed ? 200 : 503).json({
        ok: Boolean(active && !active.disposed),
        roomId: ROOM_ID,
        tick: active?.coordinator?.tick ?? null,
      });
    });
    app.use(async (req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      const url = new URL(req.originalUrl || req.url, 'http://localhost');
      const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const isModule = /^src\/[a-z-]+\.mjs$/.test(path);
      if (!isModule && !staticPaths.has(path)) return next();
      try {
        const body = await readFile(resolve(clientDirectory, path));
        const type = path.endsWith('.html') ? 'text/html; charset=utf-8'
          : path.endsWith('.css') ? 'text/css; charset=utf-8'
            : path.endsWith('.json') ? 'application/json; charset=utf-8'
              : path.endsWith('.mjs') ? 'text/javascript; charset=utf-8'
                : audioPaths.has(path) ? 'audio/ogg' : 'image/png';
        res.setHeader('Content-Type', type);
        res.setHeader('Cache-Control', audioPaths.has(path) || imagePaths.has(path)
          ? 'public, max-age=86400' : 'no-cache');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.status(200).end(req.method === 'HEAD' ? undefined : body);
      } catch (error) {
        if (error?.code === 'ENOENT') res.status(404).end('Not found');
        else next(error);
      }
    });
  },
});

export async function startColyseusServer({
  port = Number(process.env.PORT || 2567),
  host = process.env.HOST || '0.0.0.0',
} = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
  await server.listen(port, host);
  // Colyseus Cloud also sends ready through its own listen adapter.
  if (typeof process.send === 'function' && !process.env.COLYSEUS_CLOUD) process.send('ready');
  return server;
}

async function isMainEntry() {
  const entry = await realpath(fileURLToPath(import.meta.url));
  // PM2 fork mode loads ESM through ProcessContainerFork.js, so argv[1] is
  // its loader while pm_exec_path identifies the application entry.
  for (const path of [process.argv[1], process.env.pm_exec_path]) {
    if (!path) continue;
    try {
      if (await realpath(resolve(path)) === entry) return true;
    } catch {
      // A missing or inaccessible launcher path cannot identify this module.
    }
  }
  return false;
}

if (await isMainEntry()) {
  await startColyseusServer();
  console.log(`Flocking Colyseus room ready: ${ROOM_ID}`);
}
