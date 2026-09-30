import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { AUDIO_FILES } from '../src/fleet-audio.mjs';
import { AUDIO_FILES as LEGACY_AUDIO_FILES } from '../src/audio.mjs';

test('the fleet manifest retains five existing sounds and excludes unused legacy audio', () => {
  assert.equal(AUDIO_FILES.length, 5);
  assert.equal(new Set(AUDIO_FILES).size, 5);
  const legacy = new Set(LEGACY_AUDIO_FILES);
  assert.ok(legacy.size > AUDIO_FILES.length);
  for (const path of AUDIO_FILES) {
    assert.ok(legacy.has(path), `Fleet sound ${path} should use an existing asset`);
    assert.match(path, /^(?!\/)(?!.*\.\.)[\w/-]+\.ogg$/);
    assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), `Missing fleet sound ${path}`);
  }
  assert.ok(LEGACY_AUDIO_FILES.some(path => !AUDIO_FILES.includes(path)));
});

test('both builds and both static servers use the fleet asset allowlist', () => {
  for (const path of [
    '../scripts/build-multiplayer.mjs',
    '../scripts/build-sites.mjs',
    '../server/colyseus.mjs',
    '../server/local.mjs',
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /import \{ AUDIO_FILES \} from '\.\.\/src\/fleet-audio\.mjs'/);
    assert.doesNotMatch(source, /import \{ AUDIO_FILES \} from '\.\.\/src\/audio\.mjs'/);
  }
});
