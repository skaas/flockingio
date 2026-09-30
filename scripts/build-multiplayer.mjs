import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { AUDIO_FILES } from '../src/fleet-audio.mjs';
import { IMAGE_FILES } from '../src/sprites.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

export async function writeClientVendor(clientDirectory, endpoint = process.env.COLYSEUS_ENDPOINT || '') {
  if (endpoint !== '') {
    const parsed = new URL(endpoint);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('COLYSEUS_ENDPOINT must be an HTTP(S) or WS(S) server URL without credentials');
    }
  }
  const vendor = resolve(clientDirectory, 'vendor');
  await mkdir(vendor, { recursive: true });
  await build({
    stdin: {
      contents: 'export * from "@colyseus/sdk";',
      resolveDir: root,
      sourcefile: 'colyseus-sdk-entry.mjs',
      loader: 'js',
    },
    outfile: resolve(vendor, 'colyseus-sdk.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    logLevel: 'warning',
  });
  await writeFile(resolve(clientDirectory, 'multiplayer-config.json'), `${JSON.stringify({ endpoint })}\n`);
}

export async function buildMultiplayer() {
  const client = resolve(root, 'dist/multiplayer/client');
  await rm(resolve(root, 'dist/multiplayer'), { recursive: true, force: true });
  await mkdir(resolve(client, 'src'), { recursive: true });
  for (const file of ['index.html', 'style.css']) {
    await copyFile(resolve(root, file), resolve(client, file));
  }
  for (const file of await readdir(resolve(root, 'src'))) {
    if (/^[a-z-]+\.mjs$/.test(file)) {
      await copyFile(resolve(root, 'src', file), resolve(client, 'src', file));
    }
  }
  for (const path of [...AUDIO_FILES, ...IMAGE_FILES]) {
    const target = resolve(client, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(resolve(root, path), target);
  }
  await writeClientVendor(client);
  return client;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildMultiplayer();
  console.log('Multiplayer client ready: dist/multiplayer/client');
}
