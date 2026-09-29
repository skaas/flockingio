import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { AUDIO_FILES } from '../src/audio.mjs';
import { IMAGE_FILES } from '../src/sprites.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = resolve(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, 'server'), { recursive: true });
await mkdir(resolve(dist, 'client/src'), { recursive: true });
await mkdir(resolve(dist, '.openai'), { recursive: true });

// Bundle the explicit dependency graph into the Worker. Keep only its default export.
// Reject imports outside this explicit graph instead of producing an incomplete bundle.
const modules = [
  ['src/identity.mjs', []],
  ['src/rules.mjs', []],
  ['src/legacy.mjs', ["import { CONTRIBUTION_POINTS } from './rules.mjs';"]],
  ['src/replay.mjs', ["import { battleContribution } from './legacy.mjs';", "import { RULES_VERSION, SIMULATION_STEP, FLEET } from './rules.mjs';"]],
  ['server/schema.mjs', []],
  ['server/api.mjs', [
    "import { schema } from './schema.mjs';",
    "import { normalizeNickname, validNickname, validId, validToken, modeNames } from '../src/identity.mjs';",
    "import { contributionScore } from '../src/legacy.mjs';",
    "import { validReplay, REPLAY_VERSION } from '../src/replay.mjs';",
  ]],
  ['server/worker.mjs', ["import { handleAPI } from './api.mjs';"]],
];
const output = [];
for (const [path, imports] of modules) {
  let source = await readFile(resolve(root, path), 'utf8');
  for (const declaration of imports) {
    if (!source.includes(declaration)) throw new Error(`Update the Sites dependency list for ${path}`);
    source = source.replace(declaration, '');
  }
  if (/^\s*import\s/m.test(source)) throw new Error(`Unsupported import in ${path}`);
  source = source.replace(/^export (?=(?:async )?(?:function|const|let|class)\b)/gm, '');
  output.push(`// ${path}\n${source}`);
}
await writeFile(resolve(dist, 'server/index.js'), output.join('\n'));
for (const file of ['index.html', 'style.css']) {
  await copyFile(resolve(root, file), resolve(dist, 'client', file));
}
for (const file of await readdir(resolve(root, 'src'))) {
  if (file.endsWith('.mjs')) await copyFile(resolve(root, 'src', file), resolve(dist, 'client/src', file));
}
await copyFile(resolve(root, '.openai/hosting.json'), resolve(dist, '.openai/hosting.json'));
for (const path of [...AUDIO_FILES, ...IMAGE_FILES]) {
  const destination = resolve(dist, 'client', path);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(resolve(root, path), destination);
}
console.log('Sites build ready: dist/server/index.js and dist/client');
