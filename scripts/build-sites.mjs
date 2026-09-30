import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, posix } from 'node:path';
import { AUDIO_FILES } from '../src/audio.mjs';
import { IMAGE_FILES } from '../src/sprites.mjs';
import { writeClientVendor } from './build-multiplayer.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = resolve(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, 'server'), { recursive: true });
await mkdir(resolve(dist, 'client/src'), { recursive: true });
await mkdir(resolve(dist, '.openai'), { recursive: true });

// Bundle only the validation dependency graph into the Worker. A closure per
// module preserves lexical scope, including private names shared by modules.
const modules = [
  'src/identity.mjs',
  'src/rules.mjs',
  'src/simulation-rng.mjs',
  'src/fleet-state.mjs',
  'src/legacy.mjs',
  'src/replay.mjs',
  'server/schema.mjs',
  'server/api.mjs',
  'server/worker.mjs',
];
const output = [];
for (const [index, path] of modules.entries()) {
  let source = await readFile(resolve(root, path), 'utf8');
  const original = source;
  const bindings = [];
  source = source.replace(/^\s*import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?\s*$/gm, (_, names, relative) => {
    const dependency = posix.normalize(posix.join(posix.dirname(path), relative));
    const dependencyIndex = modules.indexOf(dependency);
    if (dependencyIndex < 0 || dependencyIndex >= index) throw new Error(`Unsupported Sites import ${relative} in ${path}`);
    const members = names.split(',').map(name => name.trim()).filter(Boolean).map(name => {
      const match = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(name);
      if (!match) throw new Error(`Unsupported Sites import binding ${name} in ${path}`);
      return match[2] ? `${match[1]}: ${match[2]}` : match[1];
    });
    bindings.push(`const { ${members.join(', ')} } = __module${dependencyIndex};`);
    return '';
  });
  if (/^\s*import\b/m.test(source)) throw new Error(`Unsupported import in ${path}`);
  const exports = [];
  source = source.replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|class)\s+\w+)/gm, '');
  for (const match of original.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)/gm)) exports.push(match[1]);
  source = source.replace(/^export\s*\{([^}]+)\};?\s*$/gm, (_, list) => {
    for (const part of list.split(',')) {
      const match = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(part.trim());
      if (!match) throw new Error(`Unsupported Sites export in ${path}`);
      exports.push(match[2] ? `${match[2]}: ${match[1]}` : match[1]);
    }
    return '';
  });
  if (/^export\s+default\b/m.test(source)) {
    source = source.replace(/^export\s+default\b/m, 'const __default =');
    exports.push('default: __default');
  }
  if (/^\s*export\b/m.test(source)) throw new Error(`Unsupported export in ${path}`);
  output.push(`// ${path}\nconst __module${index} = (() => {\n${bindings.join('\n')}\n${source}\nreturn { ${exports.join(', ')} };\n})();`);
}
await writeFile(resolve(dist, 'server/index.js'), `${output.join('\n')}\nexport default __module${modules.length - 1}.default;\n`);
await writeFile(resolve(dist, 'server/package.json'), '{"type":"module"}\n');
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
await writeClientVendor(resolve(dist, 'client'));
console.log('Sites build ready: dist/server/index.js and dist/client');
