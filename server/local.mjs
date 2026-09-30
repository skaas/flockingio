import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openDatabase } from './sqlite.mjs';
import { handleAPI, initializeDatabase } from './api.mjs';
import { AUDIO_FILES } from '../src/fleet-audio.mjs';
import { IMAGE_FILES } from '../src/sprites.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PORT || 4173), host = process.env.HOST || '127.0.0.1';
const databasePath = process.env.MURMUR_DB || resolve(root, '.data/ranking.sqlite');
await mkdir(resolve(databasePath, '..'), { recursive: true });
const db = openDatabase(databasePath);
const audioPaths = new Set(AUDIO_FILES), imagePaths = new Set(IMAGE_FILES);
await initializeDatabase(db);
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
    if (url.pathname.startsWith('/api/')) {
      const chunks = []; let bytes = 0;
      const limit = url.pathname === '/api/scores' ? 8 * 1024 * 1024 : 4096;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) { res.writeHead(413); res.end('Request too large'); return; } chunks.push(chunk); }
      const request = new Request(url, { method: req.method, headers: req.headers, ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: Buffer.concat(chunks) } : {}) });
      const response = await handleAPI(request, db);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    // Never expose database files, tokens, tests, or server source as static assets.
    const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!['GET', 'HEAD'].includes(req.method) || (!/^(index\.html|style\.css|src\/[a-z-]+\.mjs)$/.test(path) && !audioPaths.has(path) && !imagePaths.has(path))) { res.writeHead(404); res.end('Not found'); return; }
    const data = await readFile(resolve(root, path));
    res.writeHead(200, { 'Content-Type': imagePaths.has(path) ? 'image/png' : audioPaths.has(path) ? 'audio/ogg' : path.endsWith('.html') ? 'text/html; charset=utf-8' : path.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': audioPaths.has(path) || imagePaths.has(path) ? 'public, max-age=86400' : 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end('Request failed'); }
});
server.listen(port, host, () => console.log(`FALLEN HEROES: http://${host}:${port} (persistent rankings enabled)`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
