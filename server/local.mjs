import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openDatabase } from './sqlite.mjs';
import { handleAPI, initializeDatabase } from './api.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PORT || 4173), host = process.env.HOST || '127.0.0.1';
const databasePath = process.env.MURMUR_DB || resolve(root, '.data/ranking.sqlite');
await mkdir(resolve(databasePath, '..'), { recursive: true });
const db = openDatabase(databasePath);
await initializeDatabase(db);
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
    if (url.pathname.startsWith('/api/')) {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 4096) { res.writeHead(413); res.end('Request too large'); return; } chunks.push(chunk); }
      const request = new Request(url, { method: req.method, headers: req.headers, ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: Buffer.concat(chunks) } : {}) });
      const response = await handleAPI(request, db);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    // Never expose database files, tokens, tests, or server source as static assets.
    const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!['GET', 'HEAD'].includes(req.method) || !/^(index\.html|style\.css|src\/[a-z-]+\.mjs)$/.test(path)) { res.writeHead(404); res.end('Not found'); return; }
    const data = await readFile(resolve(root, path));
    res.writeHead(200, { 'Content-Type': path.endsWith('.html') ? 'text/html; charset=utf-8' : path.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end('Request failed'); }
});
server.listen(port, host, () => console.log(`MURMUR: http://${host}:${port} (persistent rankings enabled)`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
