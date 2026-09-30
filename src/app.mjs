import { Game, WORLD_RADIUS, HEAD_GROWTH, headScaleForLevel, angleDelta, clamp, lerp, timeLabel } from './engine.mjs';
import { FleetBattleGame } from './fleet-battle.mjs';
import { Scenery } from './scenery.mjs';
import { generateBattlefield, battlefieldSeed, MAP_HALF } from './battlefield-map.mjs';
import { FIRE_SUPPORT } from './bombardment.mjs';
import { drawGroundWar, drawBombs, drawAirDefense } from './battlefield-view.mjs';
import { RankingClient } from './ranking.mjs';
import { normalizeNickname, validNickname, suggestNickname } from './identity.mjs';
import { MouseFlightInput } from './mouse-input.mjs';
import { FleetNetworkSession } from './fleet-network.mjs';
import { GameAudio } from './audio.mjs';
import { loadSprites, sprite } from './sprites.mjs';
import { VIEWPORT, fitViewport, clientToLogical } from './viewport.mjs';
import { commanderCallsign } from './fleet-standings.mjs';

loadSprites();

const $ = id => document.getElementById(id);
const viewport = $('viewport-shell');
const canvas = $('world'), ctx = canvas.getContext('2d', { alpha: false });
const map = $('minimap').getContext('2d');
// Tactical colour semantics: friendly = cyan, hostile = red, objective = amber, warning = gold.
// Keys keep their historical names because the simulation emits them as effect ids.
const colors = { lime: '#78dcea', coral: '#ff6a5c', gold: '#e6c77f', aqua: '#80cec0', amber: '#efbb77' };
// A fleet battle ends when the commander collides.
const END_REASONS = Object.freeze({
  'head-on': '적 지휘기와 충돌',
  tail: '적 드론과 충돌',
});
// The battlefield is always framed at the same logical size; bigger displays only scale it.
const { width, height } = VIEWPORT;
let dpr = 1, last = 0, visualTime = 0, hudTime = 0;
let camera = { x: 0, y: 0, zoom: 1 };
let cameraMotion = { x: 0, y: 0 };
const scenery = new Scenery(WORLD_RADIUS + 650);
// Each sortie seed yields its own battlefield; the title screen previews a random one.
let battlefield = generateBattlefield(crypto.getRandomValues(new Uint32Array(1))[0]);
scenery.setBattlefield(battlefield);
const homeCamera = { x: 0, y: 0, zoom: .9 };
let toastTimer = 0, detachToastAt = -10;
const flightInput = new MouseFlightInput(canvas, { enabled: () => Boolean(network?.canControl && !activeModal), point: localPointer });
const leaderTrails = new WeakMap();
const renderOrder = [], renderFactions = new Map();
let activeModal = null, modalOrigin = null;
// Standings rows are rebuilt only when the field or a commander's drone count changes.
let standingsKey = '';
// Only the pilot name is used; stored records, tapes and queued scores stay untouched.
const rankings = new RankingClient();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
// Screen effects are presentation only: they never read or advance the seeded simulation.
const fxFlash = $('fx-flash'), fxSignal = $('fx-signal'), fxNoise = $('fx-noise').getContext('2d');
let shakeTime = 0, shakeAmp = 0, signalTimer = 0, signalDone = null;
const SHAKE_SECONDS = .28, SIGNAL_SECONDS = .5;
// Overlays are placed as a share of the logical frame so they track the fitted shell at any scale.
const framePercent = (value, size) => `${(value / size * 100).toFixed(3)}%`;
function blast(x, y, strength) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !game.player) return;
  const near = Math.max(0, 1 - Math.hypot(x - game.player.x, y - game.player.y) / 260) * strength;
  if (near < .05) return;
  if (!reducedMotion) { shakeAmp = Math.max(shakeTime > 0 ? shakeAmp : 0, 7 * near); shakeTime = SHAKE_SECONDS; }
  fxFlash.style.setProperty('--fx-x', framePercent((x - camera.x) * camera.zoom + width / 2, width));
  fxFlash.style.setProperty('--fx-y', framePercent((y - camera.y) * camera.zoom + height / 2, height));
  fxFlash.animate?.([{ opacity: (reducedMotion ? .2 : .55) * near }, { opacity: 0 }], { duration: 320, easing: 'ease-out' });
}
// A shoot-down plays as one scene: see the hit, watch the feed degrade, then read the
// debrief over the recovered last frame. Residual static stays until the next sortie.
const FEED_IMPACT = .35, FEED_DEGRADE = .55, FEED_LINK = .25;
const fxHit = $('fx-hit'), fxLabel = $('fx-signal').querySelector('span');
let feed = null, noiseClock = 0;
function signalLoss(then) {
  const p = game.player;
  blast(p.x, p.y, 1.3);
  fxHit.style.left = framePercent((p.x - camera.x) * camera.zoom + width / 2, width);
  fxHit.style.top = framePercent((p.y - camera.y) * camera.zoom + height / 2, height);
  fxHit.hidden = false; fxHit.getAnimations?.().forEach(animation => animation.cancel());
  fxHit.classList.remove('struck'); void fxHit.offsetWidth; fxHit.classList.add('struck');
  feed = { phase: 'impact', t: 0, done: then };
  if (reducedMotion) finishFeedLoss();
}
function showFeedPhase(phase, label) {
  fxSignal.dataset.phase = phase; fxSignal.hidden = false;
  if (label) fxLabel.textContent = label;
}
function finishFeedLoss() {
  if (!feed || feed.phase === 'residual') return;
  const done = feed.done;
  feed = { phase: 'residual', t: 0 };
  canvas.classList.add('feed-lost'); document.body.classList.add('feed-down'); showFeedPhase('residual');
  fxSignal.style.setProperty('--noise', 1);
  done?.();
}
function cancelSignal() {
  feed = null; fxSignal.hidden = true; fxHit.hidden = true; fxHit.classList.remove('struck');
  canvas.classList.remove('feed-lost'); document.body.classList.remove('feed-down'); fxSignal.style.setProperty('--noise', 0);
}
// Retrying reconnects the feed instead of cutting straight to a clean picture.
function linkFeed() {
  if (reducedMotion) return;
  feed = { phase: 'link', t: 0 }; fxSignal.style.setProperty('--noise', 1);
  showFeedPhase('link', '신호 연결'); sound.play('signalLink');
}
function skipFeed(event) {
  if (feed?.phase !== 'impact' && feed?.phase !== 'degrade') return;
  if (event.type === 'keydown' && !['Enter', ' ', 'Escape'].includes(event.key)) return;
  event.preventDefault(); event.stopPropagation(); finishFeedLoss();
}
addEventListener('pointerdown', skipFeed, true);
addEventListener('keydown', skipFeed, true);
function drawNoise(tear = true) {
  const image = fxNoise.createImageData(160, 90), data = image.data, band = Math.random() * 90;
  for (let i = 0; i < data.length; i += 4) {
    const row = (i >> 2) / 160 | 0, v = Math.random() * (tear && Math.abs(row - band) < 5 ? 255 : 150);
    data[i] = v * .85; data[i + 1] = v; data[i + 2] = v * .9; data[i + 3] = 255;
  }
  fxNoise.putImageData(image, 0, 0);
}
function updateEffects(dt) {
  if (shakeTime > 0) {
    shakeTime = Math.max(0, shakeTime - dt);
    const k = shakeAmp * shakeTime / SHAKE_SECONDS;
    canvas.style.transform = k > .15 ? `translate(${((Math.random() * 2 - 1) * k).toFixed(1)}px, ${((Math.random() * 2 - 1) * k).toFixed(1)}px)` : '';
  }
  if (!feed) return;
  feed.t += dt;
  if (feed.phase === 'impact' && feed.t >= FEED_IMPACT) {
    feed.phase = 'degrade'; feed.t = 0;
    canvas.classList.add('feed-lost'); document.body.classList.add('feed-down');
    showFeedPhase('degrade', '신호 두절'); sound.play('signalLost');
  }
  if (feed.phase === 'degrade') {
    fxSignal.style.setProperty('--noise', Math.min(1, feed.t / FEED_DEGRADE).toFixed(3));
    drawNoise();
    if (feed.t >= FEED_DEGRADE) finishFeedLoss();
  } else if (feed.phase === 'residual') {
    // A slow residual shimmer: enough to read as a lost feed, never enough to distract.
    noiseClock += dt;
    if (noiseClock > .09 && !reducedMotion) { noiseClock = 0; drawNoise(false); }
  } else if (feed.phase === 'link') {
    fxSignal.style.setProperty('--noise', Math.max(0, 1 - feed.t / FEED_LINK).toFixed(3));
    drawNoise();
    if (feed.t >= FEED_LINK) cancelSignal();
  }
}
const readStorage = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const saveStorage = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Private browsing can disable storage. */ } };
const sound = new GameAudio({ ...readStorage('murmur-audio', {}), enabled: readStorage('murmur-sound', true) });

// The logical frame never changes; only the fitted shell and backing density follow the display.
// Body padding carries the safe-area insets, so its content box is the space the shell may use.
let layoutKey = '';
function resize() {
  const body = document.body, style = getComputedStyle(body);
  const bodyWidth = body.clientWidth, bodyHeight = body.clientHeight;
  const padTop = parseFloat(style.paddingTop), padRight = parseFloat(style.paddingRight);
  const padBottom = parseFloat(style.paddingBottom), padLeft = parseFloat(style.paddingLeft);
  const fit = fitViewport(bodyWidth - padLeft - padRight, bodyHeight - padTop - padBottom);
  dpr = Math.min(devicePixelRatio || 1, 2);
  // The outer box and insets decide where the centred shell sits, so they must invalidate
  // held pointers even when the fitted size is unchanged.
  const key = `${fit.width}x${fit.height}@${dpr}|${bodyWidth}x${bodyHeight}|${padTop},${padRight},${padBottom},${padLeft}`;
  if (key === layoutKey) return;
  const relayout = layoutKey !== '';
  layoutKey = key;
  viewport.style.width = `${fit.width}px`; viewport.style.height = `${fit.height}px`;
  const backingWidth = Math.round(width * dpr), backingHeight = Math.round(height * dpr);
  if (canvas.width !== backingWidth || canvas.height !== backingHeight) { canvas.width = backingWidth; canvas.height = backingHeight; }
  // A held drag would otherwise jump to wherever the rescaled shell now puts the cursor.
  if (relayout) resetInput();
}
addEventListener('resize', resize);
// A 180° landscape turn can swap the side safe-area insets without resizing anything.
addEventListener('orientationchange', resize);
// The body keeps the real viewport size, so observing it cannot feed back into the shell.
if (typeof ResizeObserver === 'function') new ResizeObserver(resize).observe(document.body);
resize();

function updateSound() {
  const soundEnabled = sound.settings.enabled;
  $('sound').setAttribute('aria-label', soundEnabled ? '소리 끄기' : '소리 켜기');
  $('sound').title = soundEnabled ? '소리 끄기' : '소리 켜기';
  $('sound').setAttribute('aria-pressed', String(soundEnabled));
  $('sound').querySelector('.sound-slash').style.display = soundEnabled ? 'none' : '';
  for (const button of document.querySelectorAll('.sound-toggle')) {
    button.textContent = soundEnabled ? '소리 켜짐' : '소리 꺼짐';
    button.setAttribute('aria-pressed', String(soundEnabled));
  }
  for (const slider of document.querySelectorAll('[data-volume]')) {
    const value = Math.round(sound.settings[slider.dataset.volume] * 100);
    slider.value = value; slider.nextElementSibling.value = `${value}%`;
  }
}
function saveSound(patch) {
  sound.configure(patch);
  saveStorage('murmur-sound', sound.settings.enabled); saveStorage('murmur-audio', sound.settings);
  updateSound();
}
for (const button of [$('sound'), ...document.querySelectorAll('.sound-toggle')]) {
  button.addEventListener('click', () => { saveSound({ enabled: !sound.settings.enabled }); sound.play('ui'); });
}
for (const slider of document.querySelectorAll('[data-volume]')) {
  slider.addEventListener('input', () => saveSound({ [slider.dataset.volume]: Number(slider.value) / 100 }));
  slider.addEventListener('change', () => { if (slider.dataset.volume === 'effects') sound.play('ui'); });
}
// Unlock synchronously on a real gesture, before nickname registration awaits the server.
addEventListener('pointerdown', () => sound.unlock(), { capture: true });
document.addEventListener('click', event => {
  if (event.target.closest?.('button, summary') && !event.target.closest('#sound, .sound-toggle')) sound.play('ui');
});
updateSound();

// The game may emit events while it is still being constructed.
const missionClock = () => { try { return game.elapsed || 0; } catch { return 0; } };
// Messages arrive as radio traffic: mission clock, sender callsign, brevity text.
// The sender's colour follows the tactical semantics (friendly, hostile, objective).
function toast(message, duration = 3.4, from = '관제', tone = 'friendly') {
  const element = $('toast'), stamp = document.createElement('span'), sender = document.createElement('span');
  stamp.className = 'radio-stamp'; stamp.textContent = timeLabel(missionClock());
  sender.className = 'radio-from'; sender.textContent = `${from} ▸`;
  element.dataset.tone = tone; element.replaceChildren(stamp, sender, document.createTextNode(message));
  element.classList.add('visible'); toastTimer = duration;
}
function resetInput() { flightInput.reset(); }
function localPointer(event) {
  // Measure the steady shell, never the canvas that screen shake translates.
  return clientToLogical(event.clientX, event.clientY, viewport.getBoundingClientRect());
}
function showModal(id) {
  if (id && !activeModal) modalOrigin = document.activeElement;
  activeModal = id;
  for (const name of ['pause-modal', 'end-modal']) $(name).hidden = name !== id;
  for (const name of ['home', 'hud', 'topbar', 'world']) $(name).inert = Boolean(id);
  if (id) {
    $(id).scrollTop = 0;
    // A later transition may replace this dialog before the next animation frame.
    requestAnimationFrame(() => { if (activeModal === id) $(id).querySelector('button:not(:disabled), select, input')?.focus({ preventScroll: true }); });
  } else if (modalOrigin) {
    const target = viewingRoom && network?.canControl ? canvas : modalOrigin;
    if (target.getClientRects().length && !target.closest('[hidden], [inert]')) target.focus({ preventScroll: true });
    modalOrigin = null;
  }
}
function onEvent(event) {
  sound.handle(event, game);
  if (event.type === 'flak-impact') blast(event.x, event.y, 1);
  if (event.type === 'bomb-impact') blast(event.x ?? event.request?.x, event.y ?? event.request?.y, .45);
}
let game = new FleetBattleGame({ onEvent });
let network = null;
let viewingRoom = false;
let roomSeed = null;


if (!validNickname(rankings.profile.nickname)) rankings.setNickname(suggestNickname());
$('nickname').value = rankings.profile.nickname;
$('nickname').addEventListener('input', () => { $('nickname').setCustomValidity(''); $('nickname-error').hidden = true; });
$('shuffle-nickname').addEventListener('click', () => {
  rankings.setNickname(suggestNickname(normalizeNickname($('nickname').value)));
  $('nickname').value = rankings.profile.nickname;
  $('nickname').setCustomValidity(''); $('nickname-error').hidden = true;
  $('nickname').focus({ preventScroll: true });
});

function beginRun() {
  const nickname = normalizeNickname($('nickname').value);
  if (!validNickname(nickname)) {
    const message = '이름을 1~16자로 입력하세요.';
    $('nickname').setCustomValidity(message); $('nickname-error').textContent = message; $('nickname-error').hidden = false;
    $('nickname').reportValidity(); $('nickname').focus({ preventScroll: true }); return;
  }
  rankings.setNickname(nickname); $('nickname').value = nickname;
  connectToRoom(nickname);
}

function updateZone() {
  $('zone-name').textContent = battlefield.name;
  $('zone-code').textContent = battlefield.code;
}
function entryStatus(message) {
  $('connection-status').textContent = message;
  $('connection-status').hidden = !message;
}
function showRoom(replica) {
  if (!network?.view || (!network.ownEntity && !viewingRoom)) return;
  game = network.view;
  if (roomSeed !== replica.seed) {
    roomSeed = replica.seed;
    battlefield = generateBattlefield(battlefieldSeed(roomSeed));
    scenery.setBattlefield(battlefield);
    updateZone();
  }
  if (displayedEntityId !== network.entityId) {
    displayedEntityId = network.entityId;
    resetInput(); showModal(null); cancelSignal();
    camera = { x: 0, y: 0, zoom: 1.2 }; cameraMotion = { x: 0, y: 0 };
    standingsKey = ''; toastTimer = 0;
    $('end-error').textContent = '';
    $('toast').classList.remove('visible'); $('toast').textContent = '';
    frameFleetOpening();
    canvas.focus({ preventScroll: true });
  }
  viewingRoom = true;
  $('home').hidden = true; $('hud').hidden = false; $('pause').hidden = false; $('run-clock').hidden = false;
  document.body.classList.add('playing', 'fleet-battle');
  $('start').disabled = false;
  entryStatus('');
  updateHUD();
}
let displayedEntityId = null;
function connectToRoom(nickname) {
  if (network?.status === 'connecting' || network?.connected) return;
  network?.disconnect();
  const session = new FleetNetworkSession({
    onEvent: event => {
      // Ambient impacts are spatial. Reference-player kill/allegiance events do
      // not describe this connection's pilot and must never play as local ones.
      if (event.type === 'flak-impact' || event.type === 'bomb-impact') onEvent(event);
    },
    onState: (status, detail) => {
      if (network !== session) return;
      if (status === 'connecting') { $('start').disabled = true; entryStatus('서버에 연결하는 중…'); }
      if (status === 'connected' && detail) {
        if (activeModal === 'end-modal' && detail.respawn) {
          $('end-error').textContent = detail.message || '출격할 수 없습니다. 다시 시도해 주세요.';
          $('restart').disabled = false; $('restart').textContent = '새 편대로 출격';
        } else if (activeModal !== 'end-modal') toast(detail.message || '서버 요청을 처리할 수 없습니다.', 4, '관제', 'system');
      }
      if (status === 'error' || status === 'disconnected') {
        resetToHome();
        entryStatus(detail?.message || '연결이 끊겼습니다. 다시 입장하면 새 편대로 시작합니다.');
      }
    },
    onReplica: replica => { if (network === session) showRoom(replica); },
    onWelcome: () => { if (network === session && session.replica) showRoom(session.replica); },
    onResult: result => {
      if (network !== session) return;
      resetInput(); cancelSignal(); renderFleetResult(result);
      $('end-error').textContent = '';
      $('restart').disabled = false; $('restart').textContent = '새 편대로 출격';
      showModal('end-modal');
    },
    onCounts: counts => {
      if (network === session) $('room-counts').textContent = `접속 ${counts.connected}명 · 전장 ${counts.living}편대`;
    },
  });
  network = session;
  session.join(nickname);
  if (document.hidden) session.setHidden(true);
}
function resetToHome() {
  cancelSignal();
  sound.reset(); sound.setScene('home', 0, false);
  viewingRoom = false; roomSeed = null; displayedEntityId = null;
  game = new FleetBattleGame({ onEvent }); game.state = 'home';
  resetInput(); showModal(null); $('home').hidden = false; $('hud').hidden = true; $('pause').hidden = true; $('run-clock').hidden = true;
  document.body.classList.remove('playing', 'fleet-battle'); $('start').focus({ preventScroll: true });
  $('start').disabled = false;
}
function goHome() {
  const session = network; network = null;
  session?.disconnect();
  resetToHome(); entryStatus('');
}
// Results arrive from the room for this exact sortie.
function renderFleetResult(result) {
  $('end-flock').textContent = result.maxFlock;
  $('end-kills').textContent = result.kills;
  $('end-duration').textContent = timeLabel(result.elapsed);
  $('end-reason').textContent = END_REASONS[result.reason] || '지휘기 격추';
}
const FLEET_ZOOM_FLOOR = .5;
function fleetRival(range = 600) {
  const p = game.player;
  let rival = null, nearest = range * range;
  for (const e of game.entities) {
    if (!e.alive || e.player) continue;
    const d = (e.x - p.x) ** 2 + (e.y - p.y) ** 2;
    if (d < nearest) { rival = e; nearest = d; }
  }
  return rival;
}
// Open with both flocks in view, without zooming out so far that the drones shrink away.
function frameFleetOpening() {
  const p = game.player, rival = fleetRival();
  camera.x = rival ? (p.x + rival.x) / 2 : p.x; camera.y = rival ? (p.y + rival.y) / 2 : p.y;
  let extentX = 100, extentY = 100;
  for (const b of rival ? [p, ...p.boids, rival, ...rival.boids] : [p, ...p.boids]) {
    extentX = Math.max(extentX, Math.abs(b.x - camera.x) + 30); extentY = Math.max(extentY, Math.abs(b.y - camera.y) + 30);
  }
  camera.zoom = clamp(Math.min((width / 2 - 28) / extentX, (height / 2 - 110) / extentY), FLEET_ZOOM_FLOOR, 1.2);
}

$('start-form').addEventListener('submit', event => { event.preventDefault(); beginRun(); });
$('restart').addEventListener('click', () => {
  if (!network?.respawn()) return;
  $('restart').disabled = true; $('restart').textContent = '출격 준비 중…';
});
$('resume').addEventListener('click', () => { resetInput(); network?.sendNeutral(); showModal(null); });
$('pause').addEventListener('click', () => { resetInput(); network?.sendNeutral(); showModal('pause-modal'); });
$('quit').addEventListener('click', goHome); $('home-button').addEventListener('click', goHome);

addEventListener('keydown', event => {
  // Retain normal dialog focus navigation without gameplay keyboard shortcuts.
  if (event.key === 'Tab') {
    const dialog = document.querySelector('.modal:not([hidden])');
    if (dialog) {
      const buttons = [...dialog.querySelectorAll('button:not(:disabled), summary, select, input')].filter(el => el.getClientRects().length), first = buttons[0], end = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); end.focus(); }
      else if (!event.shiftKey && document.activeElement === end) { event.preventDefault(); first.focus(); }
    }
  }
});
addEventListener('blur', () => { resetInput(); network?.setFocused(false); });
addEventListener('focus', () => network?.setFocused(true));
document.addEventListener('visibilitychange', () => {
  sound.setHidden(document.hidden);
  if (document.hidden) resetInput();
  network?.setHidden(document.hidden);
});
function getInput() {
  const aim = flightInput.aim;
  return {
    targetX: aim ? (aim.x - width / 2) / camera.zoom + camera.x : undefined,
    targetY: aim ? (aim.y - height / 2) / camera.zoom + camera.y : undefined,
    boost: flightInput.boost,
    gather: flightInput.gather,
  };
}
function updateHUD() {
  const p = game.player;
  if (!p) return;
  $('clock').textContent = timeLabel(network?.survivalSeconds ?? 0);
  $('flock-count').textContent = p.alive ? p.boids.length : 0;
  const swaying = p.boids.filter(b => b.influence > .1).length;
  if ($('sway-count').textContent !== String(swaying)) $('sway-count').textContent = swaying;
  $('sway-signal').hidden = !swaying;
  const recruits = [...game.entities.filter(e => e.alive && !e.player).flatMap(e => e.boids), ...game.strays]
    .filter(b => b.influenceTarget === p.id && b.influence > .1);
  if ($('recruit-count').textContent !== String(recruits.length)) $('recruit-count').textContent = recruits.length;
  $('recruit-progress').textContent = `${Math.floor(Math.max(0, ...recruits.map(b => b.influence)) * 100)}%`;
  $('recruit-signal').hidden = !recruits.length;
  updateStandings();
  const energy = Number.isFinite(p.energy) ? p.energy : 100;
  $('boost-fill').style.width = `${clamp(energy, 0, 100)}%`;
  $('boost-fill').style.background = p.exhausted ? '#809382' : colors.lime;
  $('energy-label').textContent = p.exhausted ? '에너지 회복 중' : p.boosting ? '가속 중' : '가속';
  $('energy-meter').setAttribute('aria-valuenow', Math.round(energy));
}
// This match only: live commanders ranked by the drones they hold right now.
function updateStandings() {
  const rows = game.entities.filter(entity => entity.alive && !entity.neutral)
    .map(entity => ({
      id: entity.id, player: entity.id === network?.entityId,
      name: network?.controls.get(entity.id) || `${commanderCallsign(entity.id)} · AI`,
      drones: entity.boids.length,
    })).sort((a, b) => b.drones - a.drones || a.id - b.id);
  const key = rows.map(row => `${row.id}:${row.drones}:${row.name}:${row.player}`).join(' ');
  if (key === standingsKey) return;
  standingsKey = key;
  $('standings-list').replaceChildren(...rows.map((row, index) => {
    const item = document.createElement('li'), rank = document.createElement('span'), name = document.createElement('span');
    const label = document.createElement('span'), count = document.createElement('span');
    rank.className = 'standing-rank'; rank.textContent = index + 1;
    name.className = 'standing-name'; label.textContent = row.name; name.append(label);
    if (row.player) {
      const self = document.createElement('b'); self.className = 'standing-self'; self.textContent = '나';
      item.className = 'own'; name.append(self);
    }
    count.className = 'standing-drones'; count.textContent = row.drones;
    item.append(rank, name, count);
    return item;
  }));
}

function nearestRequest() {
  const requests = game.bombardment.requests.filter(r => r.state !== 'complete');
  return requests.find(r => r.id === game.bombardment.activeId) ?? requests.sort((a, b) =>
    Math.hypot(a.x - game.player.x, a.y - game.player.y) - Math.hypot(b.x - game.player.x, b.y - game.player.y))[0];
}

function drone(x, y, angle, size, color, alpha = 1, faction = 'hostile') {
  ctx.save(); ctx.translate(x, y); ctx.rotate(angle + Math.PI / 2); ctx.globalAlpha = alpha;
  if (faction === 'neutral') ctx.filter = 'grayscale(1)';
  if (sprite(ctx, faction === 'hostile' ? 'hostile' : 'drone', -size * 1.2, -size * 1.2, size * 2.4)) {
    ctx.fillStyle = color; ctx.fillRect(-size * .65, 0, 1.8, 1.8); ctx.fillRect(size * .65 - 1.8, 0, 1.8, 1.8);
    ctx.restore(); return;
  }
  ctx.restore();
  ctx.save(); ctx.translate(x, y); ctx.rotate(angle); ctx.globalAlpha = alpha; ctx.fillStyle = color;
  // Rigid swept wings and a central fuselage distinguish autonomous aircraft.
  ctx.beginPath(); ctx.moveTo(size, 0); ctx.lineTo(size * .12, -size * .23);
  ctx.lineTo(-size * .36, -size * .92); ctx.lineTo(-size * .7, -size * .82);
  ctx.lineTo(-size * .45, -size * .18); ctx.lineTo(-size * .78, -size * .14);
  ctx.lineTo(-size * .78, size * .14); ctx.lineTo(-size * .45, size * .18);
  ctx.lineTo(-size * .7, size * .82); ctx.lineTo(-size * .36, size * .92);
  ctx.lineTo(size * .12, size * .23); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#163e41'; ctx.lineWidth = Math.max(.7, size * .14);
  ctx.beginPath(); ctx.moveTo(size * .45, 0); ctx.lineTo(-size * .25, 0); ctx.stroke();
  ctx.strokeStyle = '#b9edf0'; ctx.globalAlpha = alpha * .75;
  ctx.beginPath(); ctx.moveTo(-size * .8, 0); ctx.lineTo(-size * 1.2, 0); ctx.stroke();
  ctx.restore();
}
function drawHoveringDrone(b, color) {
  // Cosmetic station-keeping only: the simulated position stays anchored, and game.elapsed freezes it on pause.
  const s = b.seed ?? 0, cadence = 2.2 + .25 * (1 + Math.sin(s * 3.7)), phase = game.elapsed * cadence + s;
  const ease = reducedMotion ? 1 : Math.min(1, (b.looseAge ?? 1) / .4), live = reducedMotion ? 0 : ease;
  const lift = ease * 1.5 + live * (3 * Math.sin(phase) + .6 * Math.sin(phase * 2.3 + s * 1.7));
  const sway = live * (1.2 * Math.sin(phase * .53 + s * 2.1) + .3 * Math.sin(phase * 1.7));
  const rock = live * (.075 * Math.sin(phase * .61 + s) + .018 * Math.sin(phase * 1.9 + s * .5));
  const r = b.radius, x = b.x + sway, y = b.y - lift, spread = 1 - lift * .035;
  // Soft two-layer ground shadow at the anchor that shrinks and fades as the drone lifts.
  ctx.save(); ctx.fillStyle = '#0b1414';
  ctx.globalAlpha = .1 - lift * .006;
  ctx.beginPath(); ctx.ellipse(b.x, b.y + r * .7, r * 1.05 * spread, r * .42 * spread, 0, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = .12 - lift * .008;
  ctx.beginPath(); ctx.ellipse(b.x, b.y + r * .7, r * .6 * spread, r * .24 * spread, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  drone(x, y, b.angle + rock, r, color, .78, 'neutral');
  // Dim neutral lift thrusters breathe slowly beneath the wings.
  ctx.save(); ctx.translate(x, y); ctx.rotate(b.angle + rock); ctx.fillStyle = '#c3cdcb';
  ctx.globalAlpha = .16 + live * .08 * Math.sin(phase * .5 + s);
  for (const side of [-1, 1]) { ctx.beginPath(); ctx.arc(-r * .3, side * r * .55, Math.max(.8, r * .14), 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
  // The recruitment ring follows the rendered offset without touching the simulated bird.
  ctx.save(); ctx.translate(sway, -lift); allegianceRing(b); ctx.restore();
}
function commandAircraft(head) {
  const r = head.radius, color = head.player ? '#dff8fb' : flockColor(head);
  ctx.save(); ctx.translate(head.x, head.y); ctx.rotate(head.angle - Math.PI / 2);
  ctx.shadowColor = head.player ? '#a6ecf4' : '#ff6a5c'; ctx.shadowBlur = 3;
  if (sprite(ctx, 'command', -r, -r, r * 2)) {
    ctx.shadowBlur = 0; ctx.fillStyle = head.player ? '#c8f6fb' : '#ff5a4a';
    ctx.fillRect(-r * .8, -r * .22, 2.5, 2.5); ctx.fillRect(r * .8 - 2.5, -r * .22, 2.5, 2.5);
    ctx.restore(); return;
  }
  ctx.restore();
  ctx.save(); ctx.translate(head.x, head.y); ctx.rotate(head.angle);
  // Keep the hull inside the existing collision radius. Engine exhaust is cosmetic.
  ctx.fillStyle = color; ctx.strokeStyle = head.player ? '#94bfc1' : '#9d6d65'; ctx.lineWidth = .8;
  ctx.beginPath(); ctx.moveTo(r, 0); ctx.lineTo(r * .36, -r * .22);
  ctx.lineTo(-r * .3, -r * .95); ctx.lineTo(-r * .55, -r * .82);
  ctx.lineTo(-r * .4, -r * .3); ctx.lineTo(-r * .72, -r * .27);
  ctx.lineTo(-r * .87, -r * .43); ctx.lineTo(-r * .91, -r * .1);
  ctx.lineTo(-r * .76, 0); ctx.lineTo(-r * .91, r * .1);
  ctx.lineTo(-r * .87, r * .43); ctx.lineTo(-r * .72, r * .27);
  ctx.lineTo(-r * .4, r * .3); ctx.lineTo(-r * .55, r * .82);
  ctx.lineTo(-r * .3, r * .95); ctx.lineTo(r * .36, r * .22);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#163e49';
  ctx.beginPath(); ctx.moveTo(r * .63, 0); ctx.lineTo(r * .12, -r * .14);
  ctx.lineTo(-r * .15, 0); ctx.lineTo(r * .12, r * .14); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#527e7c'; ctx.lineWidth = Math.max(.6, r * .045);
  for (const side of [-1, 1]) {
    ctx.beginPath(); ctx.moveTo(-r * .17, side * r * .29); ctx.lineTo(-r * .43, side * r * .7); ctx.stroke();
    ctx.fillStyle = '#315860'; ctx.fillRect(-r * .76, side * r * .2 - r * .06, r * .23, r * .12);
    ctx.strokeStyle = head.boosting ? '#eefcff' : '#9edfeb';
    ctx.lineWidth = Math.max(1, r * .1); ctx.globalAlpha = head.boosting ? .95 : .65;
    ctx.beginPath(); ctx.moveTo(-r * .77, side * r * .2);
    ctx.lineTo(-r * (head.boosting ? 1.65 : 1.12), side * r * .2); ctx.stroke();
    ctx.globalAlpha = 1; ctx.strokeStyle = '#527e7c'; ctx.lineWidth = Math.max(.6, r * .045);
  }
  ctx.restore();
}
function birdTrail(b, color) {
  if (reducedMotion || b.trail.length < 2) return;
  ctx.strokeStyle = color; ctx.lineWidth = .7;
  for (let i = 1; i < b.trail.length; i++) {
    ctx.globalAlpha = .24 * (1 - i / b.trail.length);
    ctx.beginPath(); ctx.moveTo(b.trail[i - 1].x, b.trail[i - 1].y); ctx.lineTo(b.trail[i].x, b.trail[i].y); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
function allegianceRing(b) {
  if (b.influence <= .1 && b.allegianceGrace <= 0) return;
  // The same progress ring stays visible after a bird becomes neutral.
  const incoming = b.influenceTarget === game.player.id || (b.allegianceGrace > 0 && b.owner === game.player.id);
  ctx.strokeStyle = incoming ? colors.lime : colors.gold;
  ctx.lineWidth = incoming ? 2.5 : 1.2; ctx.globalAlpha = .2;
  ctx.beginPath(); ctx.arc(b.x, b.y, b.radius + 7, 0, Math.PI * 2); ctx.stroke();
  ctx.globalAlpha = .95;
  ctx.beginPath(); ctx.arc(b.x, b.y, b.radius + 7, -Math.PI / 2,
    -Math.PI / 2 + Math.PI * 2 * (b.allegianceGrace > 0 ? b.allegianceGrace / 2 : b.influence));
  ctx.stroke(); ctx.globalAlpha = 1;
}
function rememberLeader(head, time) {
  if (reducedMotion) return;
  let trail = leaderTrails.get(head);
  if (!trail) { trail = []; leaderTrails.set(head, trail); }
  if (trail.at(-1)?.time === time) return;
  trail.push({ x: head.x, y: head.y, angle: head.angle, time });
  while (trail.length > 36 || time - trail[0].time > .55) trail.shift();
}
function leaderWake(head, time) {
  const trail = leaderTrails.get(head);
  if (reducedMotion || !trail || trail.length < 2) return;
  // Keep positions in world space: the wake follows the actual bend even while
  // the camera moves. A time window naturally makes faster motion travel farther.
  const speed = clamp((Math.hypot(head.vx, head.vy) - 50) / 160, 0, 1);
  const lifetime = .24 + speed * .22;
  ctx.save(); ctx.lineCap = 'round'; ctx.strokeStyle = head.player ? '#a7d7dd' : flockColor(head);
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1], b = trail[i], fade = clamp(1 - (time - b.time) / lifetime, 0, 1);
    if (!fade) continue;
    ctx.globalAlpha = (.18 + speed * .16) * fade ** 1.7;
    ctx.lineWidth = Math.max(.7, head.radius * .09) * fade;
    for (const side of [-1, 1]) {
      const offset = side * head.radius * .2;
      ctx.beginPath();
      ctx.moveTo(a.x - Math.sin(a.angle) * offset, a.y + Math.cos(a.angle) * offset);
      ctx.lineTo(b.x - Math.sin(b.angle) * offset, b.y + Math.cos(b.angle) * offset); ctx.stroke();
    }
  }
  ctx.restore();
}
function leaderHeading(head) {
  ctx.save(); ctx.translate(head.x, head.y); ctx.rotate(head.angle);
  const target = angleDelta(head.angle, head.targetHeading ?? head.angle);
  ctx.strokeStyle = '#a8d7c1'; ctx.globalAlpha = .8; ctx.lineWidth = 1.5; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(0, 0, head.radius + 5, target - .22, target + .22); ctx.stroke();
  ctx.restore();
}
function flockColor(e) { return e.player ? colors.lime : e.type === 'hunter' ? '#ff4d73' : e.type === 'titan' ? '#e8744f' : colors.coral; }
function mixColor(from, to, amount) {
  const a = parseInt(from.slice(1), 16), b = parseInt(to.slice(1), 16);
  const r = Math.round(lerp((a >> 16) & 255, (b >> 16) & 255, amount));
  const g = Math.round(lerp((a >> 8) & 255, (b >> 8) & 255, amount));
  const blue = Math.round(lerp(a & 255, b & 255, amount));
  return `rgb(${r},${g},${blue})`;
}
function glow(x, y, radius, color, strength) {
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius); gradient.addColorStop(0, color); gradient.addColorStop(1, '#00000000');
  ctx.globalAlpha = strength; ctx.fillStyle = gradient; ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2); ctx.globalAlpha = 1;
}
function background(home = false) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#091e24'; ctx.fillRect(0, 0, width, height);
  glow(width * .7, height * .45, width * .6, '#194b3b', .36);
  if (!home) { scenery.draw(ctx, camera, width, height, cameraMotion, reducedMotion, visualTime); return; }
  // The title screen drifts slowly over the next battlefield, dimmed behind the form.
  if (!reducedMotion) { homeCamera.x = Math.sin(visualTime * .021) * 900; homeCamera.y = Math.cos(visualTime * .017) * 700; }
  scenery.draw(ctx, homeCamera, width, height, { x: 0, y: 0 }, reducedMotion, visualTime);
  const shade = ctx.createLinearGradient(0, 0, width, 0);
  shade.addColorStop(0, '#091e24f4'); shade.addColorStop(.42, '#091e24d0'); shade.addColorStop(1, '#091e2466');
  ctx.fillStyle = shade; ctx.fillRect(0, 0, width, height);
}
// The title screen runs the same neighbor-based flock simulation as gameplay.
const demo = new Game();
demo.state = 'playing'; demo.spawnTimer = Infinity; demo.duration = Infinity; demo.stats.separation = 1;
while (demo.player.boids.length < 8) demo.addBoid(demo.player);
let demoAccumulator = 0;
const demoCamera = { x: 0, y: 0 };
function stepDemo() {
  const t = demo.elapsed;
  demo.update(1 / 60, { targetX: Math.sin(t * .47) * 180, targetY: Math.sin(t * .71 + .7) * 140, boost: Math.sin(t * .3) > .97 });
  rememberLeader(demo.player, demo.elapsed);
}
for (let i = 0; i < 240; i++) stepDemo();
demoCamera.x = demo.player.boids.reduce((sum, b) => sum + b.x, 0) / demo.player.boids.length;
demoCamera.y = demo.player.boids.reduce((sum, b) => sum + b.y, 0) / demo.player.boids.length;
function drawHome(dt) {
  if (!reducedMotion) {
    demoAccumulator += dt;
    while (demoAccumulator >= 1 / 60) { stepDemo(); demoAccumulator -= 1 / 60; }
  }
  background(true);
  const cx = width * .7, cy = height * .47;
  const scale = Math.min(width / 1280, height / 780) * 1.6;
  const head = demo.player;
  const centerX = head.boids.reduce((sum, b) => sum + b.x, head.x) / (head.boids.length + 1);
  const centerY = head.boids.reduce((sum, b) => sum + b.y, head.y) / (head.boids.length + 1);
  demoCamera.x = lerp(demoCamera.x, centerX, 1 - Math.exp(-dt * 1.2));
  demoCamera.y = lerp(demoCamera.y, centerY, 1 - Math.exp(-dt * 1.2));
  ctx.save(); ctx.translate(cx, cy); ctx.scale(scale, scale);
  glow(0, 0, 410, '#426b3a', .16);
  ctx.translate(-demoCamera.x, -demoCamera.y);
  leaderWake(head, demo.elapsed);
  for (const b of head.boids) {
    birdTrail(b, colors.lime);
    drone(b.x, b.y, b.angle, b.radius, '#a9e9f1', .72 + Math.sin(b.seed) * .18, 'friendly');
  }
  glow(head.x, head.y, 72, '#6fd0de', .12);
  commandAircraft(head);
  ctx.strokeStyle = '#78dcea50'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(head.x, head.y, 20, 0, Math.PI * 2); ctx.stroke();
  leaderHeading(head);
  ctx.restore();
}
function onScreen(x, y, pad = 80) { return Math.abs((x - camera.x) * camera.zoom) < width / 2 + pad && Math.abs((y - camera.y) * camera.zoom) < height / 2 + pad; }
function drawWorld(dt) {
  const p = game.player;
  let sumX = p.x, sumY = p.y;
  for (const b of p.boids) { sumX += b.x; sumY += b.y; }
  const centerX = sumX / (p.boids.length + 1), centerY = sumY / (p.boids.length + 1);
  let focusX = lerp(centerX, p.x, .48) + Math.cos(p.angle) * 22;
  let focusY = lerp(centerY, p.y, .48) + Math.sin(p.angle) * 22;
  const groundTarget = nearestRequest();
  const targetDistance = groundTarget ? Math.hypot(groundTarget.x - p.x, groundTarget.y - p.y) : Infinity;
  const targetFraming = clamp((380 - targetDistance) / 130, 0, 1);
  if (groundTarget && targetFraming) {
    focusX = lerp(focusX, groundTarget.x, .35 * targetFraming);
    focusY = lerp(focusY, groundTarget.y, .35 * targetFraming) - 40 * targetFraming;
  }
  // In a fleet battle, keep a nearby rival commander in view as it closes in.
  const rival = game.practice === 'fleet-battle' ? fleetRival() : null;
  const rivalFraming = rival ? clamp((600 - Math.hypot(rival.x - p.x, rival.y - p.y)) / 150, 0, 1) : 0;
  if (rivalFraming) {
    focusX = lerp(focusX, rival.x, .32 * rivalFraming); focusY = lerp(focusY, rival.y, .32 * rivalFraming);
  }
  let extentX = Math.max(100, Math.abs(p.x - focusX)), extentY = Math.max(100, Math.abs(p.y - focusY));
  for (const b of p.boids) {
    extentX = Math.max(extentX, Math.abs(b.x - focusX));
    extentY = Math.max(extentY, Math.abs(b.y - focusY));
  }
  if (groundTarget && targetFraming) {
    extentX = Math.max(extentX, Math.abs(groundTarget.x - focusX) + (FIRE_SUPPORT.radius + 12) * targetFraming);
    extentY = Math.max(extentY, Math.abs(groundTarget.y - focusY) + (FIRE_SUPPORT.radius + 30) * targetFraming);
  }
  if (rivalFraming) {
    extentX = Math.max(extentX, (Math.abs(rival.x - focusX) + 40) * rivalFraming);
    extentY = Math.max(extentY, (Math.abs(rival.y - focusY) + 40) * rivalFraming);
  }
  // Start closer to the flock, then gradually widen the view as the leader
  // evolves. The fit limits still protect the flock from being clipped.
  const closeZoom = 1.5;
  const evolutionProgress = clamp((headScaleForLevel(game.level) - 1) / (HEAD_GROWTH.maxScale - 1), 0, 1);
  const evolutionZoom = lerp(1, .78, evolutionProgress);
  const targetZoom = Math.min(closeZoom * evolutionZoom, (width / 2 - 28) / extentX, (height / 2 - 110) / extentY);
  const previousX = camera.x, previousY = camera.y;
  camera.x = lerp(camera.x, focusX, 1 - Math.exp(-dt * 4)); camera.y = lerp(camera.y, focusY, 1 - Math.exp(-dt * 4));
  if (dt > 0) {
    cameraMotion.x = lerp(cameraMotion.x, (camera.x - previousX) / dt, 1 - Math.exp(-dt * 8));
    cameraMotion.y = lerp(cameraMotion.y, (camera.y - previousY) / dt, 1 - Math.exp(-dt * 8));
  }
  // Frame the connected flock. An escaped bird never pulls the camera away.
  camera.zoom = lerp(camera.zoom, Math.max(rival ? FLEET_ZOOM_FLOOR : .28, targetZoom), 1 - Math.exp(-dt * 1.5));
  background();
  ctx.save(); ctx.translate(width / 2, height / 2); ctx.scale(camera.zoom, camera.zoom); ctx.translate(-camera.x, -camera.y);
  // The finite arena is a soft current: entering its edge steers a head inward.
  ctx.strokeStyle = '#7cad8960'; ctx.lineWidth = 2; ctx.setLineDash([5, 12]); ctx.beginPath(); ctx.arc(0, 0, WORLD_RADIUS, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
  ctx.strokeStyle = '#6695730a'; ctx.lineWidth = 70; ctx.beginPath(); ctx.arc(0, 0, WORLD_RADIUS + 35, 0, Math.PI * 2); ctx.stroke();
  drawGroundWar(ctx, game, camera, onScreen, reducedMotion);
  for (const f of game.food) {
    if (!onScreen(f.x, f.y, 20)) continue;
    const shimmer = .65 + Math.sin(visualTime * 2 + f.seed) * .2, size = f.value > 1 ? 3.2 : 1.9;
    ctx.fillStyle = f.source === 'strike' ? '#ffd08a' : f.value > 1 ? colors.amber : '#d6b27a'; ctx.globalAlpha = shimmer;
    if (f.value > 1) { ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(Math.PI / 4); ctx.fillRect(-size, -size, size * 2, size * 2); ctx.restore(); }
    else { ctx.beginPath(); ctx.arc(f.x, f.y, size, 0, Math.PI * 2); ctx.fill(); }
    ctx.globalAlpha = .05; ctx.beginPath(); ctx.arc(f.x, f.y, size * 4, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  renderOrder.length = 0; renderFactions.clear();
  for (const e of game.entities) {
    renderFactions.set(e.id, e);
    if (!e.player) renderOrder.push(e);
  }
  renderOrder.push(p);
  let recruitFocus = null;
  for (const e of game.entities) for (const b of e.boids) {
    if (b.influenceTarget === p.id && b.influence > .1 && onScreen(b.x, b.y) && (!recruitFocus || b.influence > recruitFocus.influence)) recruitFocus = b;
  }
  for (const b of game.strays) {
    if (b.influenceTarget === p.id && b.influence > .1 && onScreen(b.x, b.y) && (!recruitFocus || b.influence > recruitFocus.influence)) recruitFocus = b;
  }
  for (const e of renderOrder) if (e.alive && onScreen(e.x, e.y, 140)) leaderWake(e, game.elapsed);
  for (const b of game.strays) {
    if (!onScreen(b.x, b.y, 25)) continue;
    const target = renderFactions.get(b.influenceTarget);
    const color = target ? mixColor('#819995', flockColor(target), b.influence * .8) : '#819995';
    // A hovering drone has no trail; its station-keeping is drawn only and stops with the battle clock.
    if (b.hovering) { drawHoveringDrone(b, color); continue; }
    birdTrail(b, color); drone(b.x, b.y, b.angle, b.radius, color, .65, 'neutral');
    allegianceRing(b);
  }
  for (const e of renderOrder) {
    if (!e.alive) continue;
    const color = flockColor(e);
    if (onScreen(e.x, e.y)) glow(e.x, e.y, e.player ? 85 : 50, e.player ? '#9fe6f040' : '#ff6a5c30', .32);
    for (let i = e.boids.length - 1; i >= 0; i--) {
      const b = e.boids[i]; if (!onScreen(b.x, b.y, 20)) continue;
      const alpha = .8 + Math.sin(b.seed) * .13;
      const target = renderFactions.get(b.influenceTarget);
      const birdColor = b.influence > 0 ? mixColor(color, target ? flockColor(target) : colors.gold, b.influence * .9) : color;
      if (e.player && b.linkReach && Math.hypot(b.x - b.linkX, b.y - b.linkY) > b.linkReach * .78) {
        ctx.strokeStyle = colors.gold; ctx.lineWidth = 1; ctx.globalAlpha = .45;
        ctx.setLineDash([3, 5]); ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.linkX, b.linkY); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
      }
      birdTrail(b, birdColor);
      drone(b.x, b.y, b.angle, b.radius, birdColor, alpha, e.player ? 'friendly' : 'hostile');
      allegianceRing(b);
      if (e.boosting && i % 3 === 0 && !reducedMotion) {
        ctx.globalAlpha = .16; ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - Math.cos(b.angle) * 17, b.y - Math.sin(b.angle) * 17); ctx.stroke(); ctx.globalAlpha = 1;
      }
    }
    if (!onScreen(e.x, e.y)) continue;
    const shieldAlpha = e.invincible > 0 ? .25 + Math.sin(visualTime * 12) * .12 : .12;
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.globalAlpha = shieldAlpha; ctx.beginPath(); ctx.arc(e.x, e.y, e.radius + 6, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
    commandAircraft(e);
    if (e.boosting || e.gathering) {
      ctx.strokeStyle = e.boosting ? '#f3ebce' : color; ctx.lineWidth = e.boosting ? 2 : 1; ctx.globalAlpha = .75;
      ctx.beginPath(); ctx.arc(e.x, e.y, e.radius + (e.boosting ? 9 : 3), 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
    } else if (e.boostPreparing) {
      // Steady muted amber ring while an enemy winds up a boost; no pulse, so reduced motion matches.
      ctx.strokeStyle = '#b8995e'; ctx.lineWidth = 1.5; ctx.globalAlpha = .6;
      ctx.beginPath(); ctx.arc(e.x, e.y, e.radius + 9, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
    }
    if (e.player) leaderHeading(e);
    if (!e.player && game.practice === 'recruitment') {
      ctx.font = '10px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = color; ctx.globalAlpha = .8;
      ctx.fillText(`훈련 편대 · ${e.boids.length}기`, e.x, e.y - 28); ctx.globalAlpha = 1;
    }
  }
  drawBombs(ctx, game, reducedMotion);
  drawAirDefense(ctx, game, camera, reducedMotion);
  for (const r of game.rings) { ctx.strokeStyle = colors[r.color]; ctx.lineWidth = 1; ctx.globalAlpha = r.life * .45; ctx.beginPath(); ctx.arc(r.x, r.y, Math.max(1, (1 - r.life) * r.max), 0, Math.PI * 2); ctx.stroke(); }
  for (const particle of game.particles) { ctx.fillStyle = colors[particle.color]; ctx.globalAlpha = particle.life * .7; ctx.beginPath(); ctx.arc(particle.x, particle.y, 1.7, 0, Math.PI * 2); ctx.fill(); }
  ctx.globalAlpha = 1;
  if (recruitFocus) {
    const b = recruitFocus;
    ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.lineWidth = 4;
    ctx.strokeStyle = '#102a28'; ctx.fillStyle = colors.lime;
    const label = `연결 중 ${Math.floor(b.influence * 100)}%`;
    ctx.strokeText(label, b.x, b.y - 23); ctx.fillText(label, b.x, b.y - 23);
  }
  ctx.restore(); drawEdgeIndicators(); drawMinimap();
}
function drawEdgeIndicators() {
  if (game.state !== 'playing') return;
  const request = nearestRequest();
  if (request) {
    const sx = (request.x - camera.x) * camera.zoom + width / 2, sy = (request.y - camera.y) * camera.zoom + height / 2;
    if (sx < 32 || sx > width - 32 || sy < 185 || sy > height - 240) {
      const angle = Math.atan2(sy - height / 2, sx - width / 2);
      const reach = Math.min((width / 2 - 30) / Math.max(.001, Math.abs(Math.cos(angle))), (height / 2 - 195) / Math.max(.001, Math.abs(Math.sin(angle))));
      const x = width / 2 + Math.cos(angle) * Math.max(30, reach), y = height / 2 + Math.sin(angle) * Math.max(30, reach);
      ctx.save(); ctx.translate(x, y); ctx.rotate(angle); ctx.fillStyle = '#efbb77';
      ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-4, -5); ctx.lineTo(-4, 5); ctx.closePath(); ctx.fill(); ctx.restore();
      ctx.font = '10px system-ui'; ctx.fillStyle = '#efbb77'; ctx.textAlign = 'center'; ctx.fillText('요청', x, y + 19);
    }
  }
  for (const e of game.entities) {
    if (e.player || !e.alive) continue;
    const sx = (e.x - camera.x) * camera.zoom + width / 2, sy = (e.y - camera.y) * camera.zoom + height / 2;
    if (sx > 30 && sx < width - 30 && sy > 100 && sy < height - 85) continue;
    const dist = Math.hypot(e.x - game.player.x, e.y - game.player.y); if (dist > 850) continue;
    const x = clamp(sx, 18, width - 18), y = clamp(sy, 112, height - 100), angle = Math.atan2(sy - height / 2, sx - width / 2);
    drone(x, y, angle, 4, colors.coral, .25 + (1 - dist / 850) * .4);
  }
}
function drawMinimap() {
  map.clearRect(0, 0, 160, 160); const scale = 68 / WORLD_RADIUS;
  map.fillStyle = '#06201e55'; map.strokeStyle = '#7ca78e30'; map.lineWidth = 1;
  map.beginPath(); map.arc(80, 80, 70, 0, Math.PI * 2); map.fill();
  const ground = scenery.overview();
  if (ground) {
    // Generated ground under the markers: roads, scorched fields and compounds.
    map.save(); map.beginPath(); map.arc(80, 80, 70, 0, Math.PI * 2); map.clip();
    map.globalAlpha = .55; map.imageSmoothingEnabled = true;
    map.drawImage(ground, 80 - MAP_HALF * scale, 80 - MAP_HALF * scale, MAP_HALF * 2 * scale, MAP_HALF * 2 * scale);
    map.globalAlpha = 1; map.fillStyle = '#06201e66'; map.fillRect(0, 0, 160, 160); map.restore();
  }
  map.beginPath(); map.arc(80, 80, 70, 0, Math.PI * 2); map.stroke();
  map.strokeStyle = '#7ca78e13'; map.beginPath(); map.moveTo(10, 80); map.lineTo(150, 80); map.moveTo(80, 10); map.lineTo(80, 150); map.stroke();
  for (const r of game.bombardment.requests) {
    map.strokeStyle = r.state === 'complete' ? colors.lime : colors.amber; map.lineWidth = 1.5;
    const x = 80 + r.x * scale, y = 80 + r.y * scale;
    map.strokeRect(x - 3, y - 3, 6, 6);
    if (r.id === game.bombardment.activeId) { map.beginPath(); map.arc(x, y, 7, 0, Math.PI * 2); map.stroke(); }
  }
  for (const e of game.entities) {
    if (!e.alive) continue; map.fillStyle = e.player ? colors.lime : colors.coral; map.globalAlpha = e.player ? 1 : .55;
    map.beginPath(); map.arc(80 + e.x * scale, 80 + e.y * scale, e.player ? 3 : 1.8, 0, Math.PI * 2); map.fill();
  }
  map.globalAlpha = 1;
}
function frame(now) {
  const dt = last ? Math.min((now - last) / 1000, .08) : 1 / 60; last = now; visualTime += dt;
  if (network) {
    const advanced = network.update(dt);
    if (advanced && viewingRoom) for (const e of game.entities) if (e.alive) rememberLeader(e, game.elapsed);
    if (!activeModal && document.hasFocus() && !document.hidden) network.sendInput(getInput(), dt);
  }
  if (toastTimer > 0) { toastTimer -= dt; if (toastTimer <= 0) $('toast').classList.remove('visible'); }
  sound.update(game); updateEffects(dt);
  if (viewingRoom) drawWorld(dt); else drawHome(dt);
  hudTime += dt; if (hudTime > .1 && viewingRoom) { updateHUD(); hudTime = 0; }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
