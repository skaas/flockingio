import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
const network = readFileSync(new URL('../src/fleet-network.mjs', import.meta.url), 'utf8');

test('the playable entry uses the continuous server room', () => {
  assert.match(app, /new FleetNetworkSession\(/);
  assert.match(app, /network\.update\(dt\)/);
  assert.match(app, /network\.sendInput\(getInput\(\), dt\)/);
  assert.match(network, /\.joinById\(ROOM_ID,/);
  assert.doesNotMatch(network, /joinOrCreate|reconnect\(/);
  assert.doesNotMatch(app, /FleetSession|saveReplay|game\.pause\(|game\.resume\(/);
  assert.match(html, /id="connection-status"/);
  assert.match(html, /id="room-counts"/);
  assert.match(html, /id="end-error"/);
  assert.doesNotMatch(html, /일시정지|고르는 동안은 시간이 멈춰요/);
});

test('the app presents server results and fresh respawn', () => {
  assert.match(app, /onResult: result =>/);
  assert.match(app, /renderFleetResult\(result\)/);
  assert.match(app, /network\?\.respawn\(\)/);
  assert.match(app, /network\?\.sendNeutral\(\)/);
  assert.match(app, /network\?\.setHidden\(document\.hidden\)/);
  assert.match(html, /새 편대로 출격/);
});

test('the fleet entry keeps live presentation without inactive ground or feed paths', () => {
  assert.match(app, /import \{ FleetAudio \} from '\.\/fleet-audio\.mjs'/);
  assert.match(app, /new FleetBattleGame\(\)/);
  assert.match(app, /scenery\.draw\(/);
  assert.match(app, /drawEdgeIndicators\(\)/);
  assert.match(app, /drawMinimap\(\)/);
  assert.match(app, /game\.rings/);
  assert.match(app, /game\.particles/);
  assert.match(app, /sound\.update\(game\)/);
  assert.doesNotMatch(app, /sound\.play\('boost'\)|sound\.play\('gather'\)|wasBoosting|wasGathering/);
  assert.doesNotMatch(app, /battlefield-view|bombardment\.mjs|FIRE_SUPPORT|nearestRequest/);
  assert.doesNotMatch(app, /drawGroundWar|drawBombs|drawAirDefense|game\.food|game\.bombardment/);
  assert.doesNotMatch(app, /headScaleForLevel|HEAD_GROWTH|game\.practice|훈련 편대/);
  assert.doesNotMatch(app, /signalLoss|linkFeed|cancelSignal|updateEffects|skipFeed|feed-lost|sound\.handle/);
  assert.doesNotMatch(app, /onEvent:|new FleetBattleGame\(\{/);
});

test('nickname storage migrates the name without constructing legacy ranking state', () => {
  assert.doesNotMatch(app, /RankingClient|ranking\.mjs|rankings\./);
  assert.match(app, /readStorage\('flocking-nickname', null\) \?\? readStorage\('murmur-player-v1', \{\}\)\?\.nickname/);
  assert.match(app, /saveStorage\('flocking-nickname', nickname\)/);
  assert.match(app, /validNickname\(nickname\)/);
  assert.match(app, /setNickname\(suggestNickname\(/);
});
