import { Game, WORLD_RADIUS, TEMPERAMENTS, HEAD_GROWTH, headScaleForLevel, angleDelta, clamp, lerp, timeLabel } from './engine.mjs';
import { Scenery } from './scenery.mjs';
import { FIRE_SUPPORT, TARGET_NAMES, requestCoordinates, droneAttack, facilityDamage, facilityDurability } from './bombardment.mjs';
import { drawGroundWar, drawBombs, drawAirDefense } from './battlefield-view.mjs';
import { FLAK_PATTERN_LABELS } from './air-defense.mjs';
import { RankingClient } from './ranking.mjs';
import { normalizeNickname, validNickname, suggestNickname, rankMode } from './identity.mjs';
import { MouseFlightInput } from './mouse-input.mjs';
import { ReplayRecorder, ReplayPlayer, REPLAY_STEP, seededRandom, validReplay, loadReplay, saveReplay } from './replay.mjs';
import { GameAudio } from './audio.mjs';
import { loadSprites, sprite } from './sprites.mjs';
import { battleContribution, Memorial } from './legacy.mjs';

loadSprites();

const $ = id => document.getElementById(id);
const viewport = $('viewport-shell');
const canvas = $('world'), ctx = canvas.getContext('2d', { alpha: false });
const map = $('minimap').getContext('2d');
// Tactical colour semantics: friendly = cyan, hostile = red, objective = amber, warning = gold.
// Keys keep their historical names because the simulation emits them as effect ids.
const colors = { lime: '#78dcea', coral: '#ff6a5c', gold: '#e6c77f', aqua: '#80cec0', amber: '#efbb77' };
const phases = ['작전 구역 진입', '적 편대 포착', '요격 개시', '교전 확대', '중형 편대 접근', '최종 방어선'];
const challengePhases = ['마지막까지 응답하라', '적 증원 확인', '요격망 확대', '전면 교전', '집중 공격', '한계 작전'];
const pointsLabel = value => value.toLocaleString('ko-KR');
// Tactical debrief remains available beneath the memorial.
const END_REASONS = Object.freeze({
  flak: '대공포 피격',
  'head-on': '적 지휘기와 충돌',
  tail: '적 드론과 충돌',
});
const recordLabel = seconds => { const tenths = Math.floor(seconds * 10 + 1e-7); return `${timeLabel(tenths / 10)}.${tenths % 10}`; };
let width = innerWidth, height = innerHeight, dpr = 1, last = 0, accumulator = 0, visualTime = 0, hudTime = 0;
let camera = { x: 0, y: 0, zoom: 1 };
let cameraMotion = { x: 0, y: 0 };
const scenery = new Scenery(WORLD_RADIUS + 650);
let toastTimer = 0, lastDuration = Infinity, lastPractice = false, detachToastAt = -10, runBest = 0;
const flightInput = new MouseFlightInput(canvas, { enabled: () => game.state === 'playing' && !replaying, point: localPointer });
const leaderTrails = new WeakMap();
const renderOrder = [], renderFactions = new Map();
let activeModal = null, modalOrigin = null, helpOrigin = null, helpReturnToPause = false;
const rankings = new RankingClient();
let memorialStorage;
try { memorialStorage = localStorage; } catch { /* A visit can still hold a memorial. */ }
const memorial = new Memorial(memorialStorage, rankings.profile.playerId);
let currentRun = null, starting = false, rankingReturn = null, rankingOrigin = null, rankingRequest = 0;
let rankingTab = 'ranking', rankingCount = '';
let recorder = null, replayPlayer = null, latestReplay = null, activeReplay = null, replaying = false, lastEndReason = null;
let rankingRetryTimer = null, rankingRetryDelay = 3000;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
// Screen effects are presentation only: they never read or advance the seeded simulation.
const fxFlash = $('fx-flash'), fxSignal = $('fx-signal'), fxNoise = $('fx-noise').getContext('2d');
let shakeTime = 0, shakeAmp = 0, signalTimer = 0, signalDone = null;
const SHAKE_SECONDS = .28, SIGNAL_SECONDS = .5;
function blast(x, y, strength) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !game.player) return;
  const near = Math.max(0, 1 - Math.hypot(x - game.player.x, y - game.player.y) / 260) * strength;
  if (near < .05) return;
  if (!reducedMotion) { shakeAmp = Math.max(shakeTime > 0 ? shakeAmp : 0, 7 * near); shakeTime = SHAKE_SECONDS; }
  fxFlash.style.setProperty('--fx-x', `${(x - camera.x) * camera.zoom + width / 2}px`);
  fxFlash.style.setProperty('--fx-y', `${(y - camera.y) * camera.zoom + height / 2}px`);
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
  fxHit.style.left = `${(p.x - camera.x) * camera.zoom + width / 2}px`;
  fxHit.style.top = `${(p.y - camera.y) * camera.zoom + height / 2}px`;
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

function resize() {
  const bounds = viewport.getBoundingClientRect();
  width = bounds.width; height = bounds.height; dpr = Math.min(devicePixelRatio || 1, 2);
  viewport.style.setProperty('--edge', `${Math.max(20, Math.min(56, width * .0375))}px`);
  canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
}
addEventListener('resize', resize); resize();

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
  const bounds = viewport.getBoundingClientRect();
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
}
function showModal(id) {
  if (id && !activeModal) modalOrigin = document.activeElement;
  activeModal = id;
  for (const name of ['upgrade-modal', 'pause-modal', 'end-modal', 'help-modal', 'ranking-modal']) $(name).hidden = name !== id;
  for (const name of ['home', 'hud', 'topbar', 'world']) $(name).inert = Boolean(id);
  if (id) {
    $(id).scrollTop = 0;
    // A later transition may replace this dialog before the next animation frame.
    requestAnimationFrame(() => { if (activeModal === id) $(id).querySelector('button:not(:disabled), select, input')?.focus({ preventScroll: true }); });
  } else if (modalOrigin) {
    const target = game.state === 'playing' ? canvas : modalOrigin;
    if (target.getClientRects().length && !target.closest('[hidden], [inert]')) target.focus({ preventScroll: true });
    modalOrigin = null;
  }
}
function openHelp() {
  helpOrigin = document.activeElement;
  helpReturnToPause = game.state === 'paused';
  if (game.state === 'playing') game.pause();
  $('close-help').firstChild.textContent = game.state === 'paused' && !helpReturnToPause ? '계속하기 ' : '닫기 ';
  showModal('help-modal');
}
function closeHelp() {
  if (helpReturnToPause) {
    showModal('pause-modal');
    requestAnimationFrame(() => { if (activeModal === 'pause-modal') helpOrigin?.focus({ preventScroll: true }); });
  } else if (game.state === 'paused') game.resume();
  else showModal(null);
}
function iconSVG(id) {
  const paths = {
    separation: '<path d="M25 25 13 13m12 12 12-12M25 25 13 37m12-12 12 12M10 20V10h10m20 10V10H30M10 30v10h10m20-10v10H30"/><circle cx="25" cy="25" r="3"/>',
    cohesion: '<path d="m10 10 10 10m20-10L30 20M10 40l10-10m20 10L30 30M13 20h7v-7m10 0v7h7M13 30h7v7m10 0v-7h7"/><circle cx="25" cy="25" r="3"/>',
    alignment: '<path d="m8 14 15 0m-5-5 5 5-5 5M14 26h27m-5-5 5 5-5 5M8 38h22m-5-5 5 5-5 5"/>',
    magnet: '<circle cx="25" cy="25" r="6"/><circle cx="25" cy="25" r="14" stroke-dasharray="3 6"/><path d="M25 3v8m0 28v8M3 25h8m28 0h8"/>',
    growth: '<circle cx="25" cy="25" r="7"/><circle cx="12" cy="12" r="4"/><circle cx="38" cy="12" r="4"/><circle cx="12" cy="38" r="4"/><circle cx="38" cy="38" r="4"/><path d="m16 16 4 4m10 10 4 4m0-18-4 4M20 30l-4 4"/>',
    bombing: '<path d="m17 8 8 8 8-8M25 16v9m-7 0h14v8a7 7 0 0 1-14 0zM13 43h24M25 40v6"/>',
    boost: '<path d="M28 4 12 28h12l-2 18 17-26H27z"/>',
  };
  return `<svg class="upgrade-icon" viewBox="0 0 50 50" aria-hidden="true">${paths[id]}</svg>`;
}
function showUpgrades() {
  const scale = headScaleForLevel(game.level);
  $('upgrade-description').textContent = `일시정지 · 지휘기 ${Number(scale.toFixed(1))}배${game.player.radius < game.player.growthTargetRadius ? '로 확장 · 속도 증가' : ''}`;
  $('upgrade-cards').replaceChildren();
  game.choices.forEach((upgrade, index) => {
    const button = document.createElement('button'); button.className = 'upgrade-card';
    const effect = upgrade.id === 'boost' ? '더 오래 가속할 수 있습니다.' : upgrade.effect;
    const description = upgrade.id === 'bombing'
      ? `드론당 공격력<strong class="upgrade-damage">${droneAttack(game.stats.bombing)} → ${droneAttack(game.stats.bombing + 1)}</strong>`
      : upgrade.id === 'growth'
      ? `드론 수<strong class="upgrade-damage">${game.player.boids.length} → ${Math.min(game.flockLimit, game.player.boids.length + 2)}기</strong>`
      : `${upgrade.description} ${effect}`;
    button.innerHTML = `${iconSVG(upgrade.icon)}<h3>${upgrade.name}</h3><span class="card-level">선택 시 ${game.stats[upgrade.id] + 1} / ${upgrade.max}단계</span><div class="card-description">${description}</div>`;
    button.addEventListener('click', () => chooseUpgrade(index));
    $('upgrade-cards').append(button);
  });
  showModal('upgrade-modal');
}
function onEvent(event) {
  sound.handle(event, game);
  if (event.type === 'flak-impact') blast(event.x, event.y, 1);
  if (event.type === 'bomb-impact') blast(event.x ?? event.request?.x, event.y ?? event.request?.y, .45);
  if (event.type === 'start') {
    if (replaying) toast('마지막 출격', 4, '기록', 'system');
    else if (event.practice) toast(event.practice === 'recruitment' ? '아군 4기 대 적 12기. 적 후방 드론을 확보하라.' : '적 없음. 결집과 가속을 시험하라.', 4, '교관', 'system');
    else if (event.challenge) toast(`출격 확인. 첫 요청 좌표 ${requestCoordinates(game.bombardment.requests[0])}.`, 4, '관제', 'objective');
  }
  if (event.type === 'strike-request') { toast(`새 요청. 좌표 ${requestCoordinates(event.request)}, ${TARGET_NAMES[event.request.kind]}.`, 3.5, '관제', 'objective'); }
  if (event.type === 'strike-start') { toast('목표 진입. 폭격 개시.', 3, '편대', 'friendly'); }
  if (event.type === 'interception') { toast('적 요격 편대 접근. 드론을 엄호하라.', 3, '경보', 'hostile'); }
  if (event.type === 'strike-complete') { toast(`좌표 ${requestCoordinates(event.request)} 제압.`, 4, '편대', 'friendly'); }
  if (event.type === 'kill') { toast('적 지휘기 격추. 잔해를 회수하라.', 3.4, '편대', 'friendly'); }
  if (event.type === 'sway') { toast('통신 교란 감지. 결집해 연결을 유지하라.', 4, '경보', 'hostile'); }
  if (event.type === 'allegiance') {
    toast(event.lost ? `드론 ${event.lost}기 통제권 상실.` : `드론 ${event.gained}기 합류.`, 4, event.lost ? '경보' : '편대', event.lost ? 'hostile' : 'friendly');
  }
  if (event.type === 'detached' && visualTime - detachToastAt > 3) {
    detachToastAt = visualTime;
    toast('드론 연결 끊김. 가까이 붙어 재연결하라.', 4, '편대', 'hostile');
  }
  if (event.type === 'phase') { toast(`${(game.challenge ? challengePhases : phases)[event.phase]}. 적 전력 증강.`, 3, '정보', 'hostile'); }
  if (event.type === 'evolution-ready') { updateHUD(); toast('개량 준비 완료. 하단 버튼으로 진행.', 4, '정비', 'friendly'); }
  if (event.type === 'upgrade') { if (!replaying) { resetInput(); showUpgrades(); } }
  if (event.type === 'evolved') { if (!replaying) showModal(null); toast(`${event.upgrade.name} ${game.stats[event.upgrade.id]}단계 장착 완료.`, 3.4, '정비', 'friendly'); updateBehavior(); updateHUD(); }
  if (event.type === 'pause') { resetInput(); updateHUD(); showModal('pause-modal'); }
  if (event.type === 'resume') { resetInput(); showModal(null); }
  if (event.type === 'mastery') { resetInput(); updateHUD(); toast('가속 에너지 재충전 완료.', 3.4, '정비', 'friendly'); }
  if (event.type === 'end') {
    lastEndReason = event.reason;
    if (replaying) return; // The player verifies the last frame before showing the result.
    resetInput();
    const contribution = battleContribution(game), best = memorial.data.best;
    const newRecord = !game.practice && contribution.score > best;
    const heroName = currentRun?.heroName || rankings.profile.nickname;
    $('end-modal').dataset.outcome = event.won ? 'won' : 'lost';
    $('end-eyebrow').textContent = game.practice ? '훈련 종료' : event.won ? '출격 완료' : '전사';
    $('end-title').textContent = heroName;
    $('end-feed').hidden = Boolean(event.won);
    $('end-reason').textContent = event.won ? '출격 완료' : END_REASONS[event.reason] ?? END_REASONS.tail;
    renderContribution(contribution);
    if (!game.practice && !event.won && currentRun) {
      memorial.record({ runId: currentRun.runId, name: heroName, elapsed: game.elapsed, ...contribution });
      updateRecord();
    }
    $('end-record').hidden = !newRecord;
    $('end-record').classList.toggle('is-new', newRecord);
    $('end-record').textContent = newRecord ? '최고 기여도 갱신' : '';
    $('build-summary').textContent = game.upgrades.filter(u => game.stats[u.id]).map(u => `${u.name} ${game.stats[u.id]}단계`).join(' · ');
    $('build-summary').hidden = !$('build-summary').textContent;
    $('build-details').hidden = false;
    $('build-details').open = false;
    $('rank-result').hidden = Boolean(game.practice) || !currentRun;
    $('rank-end').hidden = Boolean(game.practice);
    $('replay-button').hidden = true;
    if (!game.practice && currentRun) $('rank-result').textContent = '기록 중';
    if (event.won) showModal('end-modal');
    else signalLoss(() => { if (game.state === 'ended' && !replaying) showModal('end-modal'); });
  }
}
const game = new Game({ onEvent });


if (!validNickname(rankings.profile.nickname)) rankings.setNickname(suggestNickname());
$('nickname').value = rankings.profile.nickname;
$('nickname').addEventListener('input', () => { $('nickname').setCustomValidity(''); $('nickname-error').hidden = true; });
$('shuffle-nickname').addEventListener('click', () => {
  rankings.setNickname(suggestNickname(normalizeNickname($('nickname').value)));
  $('nickname').value = rankings.profile.nickname;
  $('nickname').setCustomValidity(''); $('nickname-error').hidden = true;
  $('nickname').focus({ preventScroll: true });
});

async function beginRun(duration, practice = false) {
  if (starting) return;
  const nickname = normalizeNickname($('nickname').value);
  if (!validNickname(nickname)) {
    const message = '이름을 1~16자로 입력하세요.';
    $('nickname').setCustomValidity(message); $('nickname-error').textContent = message; $('nickname-error').hidden = false;
    $('nickname').reportValidity(); $('nickname').focus({ preventScroll: true }); return;
  }
  rankings.setNickname(nickname); $('nickname').value = nickname;
  starting = true; $('start').disabled = true; $('start-form').setAttribute('aria-busy', 'true');
  $('start').firstChild.textContent = '준비 중… '; $('home').inert = true; $('topbar').inert = true;
  try { await rankings.register(); rankings.flush().catch(() => {}); }
  catch { /* Completed offline runs are queued for automatic retry. */ }
  finally {
    starting = false; $('start').disabled = false; $('start-form').removeAttribute('aria-busy');
    $('start').firstChild.textContent = '출격 '; $('home').inert = false; $('topbar').inert = false;
    start(duration, practice);
  }
}

async function saveFinishedRun(replay) {
  const runId = currentRun.runId;
  const score = { ...currentRun, elapsedMs: Math.floor(game.elapsed * 10 + 1e-7) * 100, maxFlock: game.maxFlock, kills: game.kills, completed: game.bombardment.completed };
  $('rank-result').textContent = '기록 중';
  try {
    const result = await rankings.submit(score, replay);
    if (currentRun?.runId === runId && game.state === 'ended') $('rank-result').textContent = `최고 기여도 ${result.own.rank}위`;
  } catch {
    if (currentRun?.runId === runId && game.state === 'ended') $('rank-result').textContent = '연결되면 기록 저장';
    scheduleRankingRetry();
  }
}

async function playRankedReplay(entry, mode, button) {
  button.disabled = true; setRankingStatus('출격 기록 불러오는 중…');
  const request = rankingRequest;
  try {
    const { replay } = await rankings.replay(entry.playerId, mode);
    if (request !== rankingRequest) return;
    if (!validReplay(replay)) throw new Error('출격 기록을 재생할 수 없습니다.');
    startPlayback(replay);
  } catch (error) {
    if (request === rankingRequest) setRankingStatus(error.message || '출격 기록을 불러올 수 없습니다.');
  } finally { button.disabled = false; }
}
function rankCell(value, className = '') {
  const cell = document.createElement('td'); cell.className = className; cell.textContent = value;
  return cell;
}
function rankingRow(entry, mode) {
  const row = document.createElement('tr'); row.className = 'ranking-row'; row.dataset.rank = entry.rank;
  const isMe = entry.playerId === rankings.profile.playerId;
  row.classList.toggle('is-me', isMe);
  const name = rankCell('', 'rank-name'), label = document.createElement('span');
  label.textContent = entry.nickname; label.title = `${entry.nickname}#${entry.tag}`;
  const identifier = document.createElement('span'); identifier.className = 'sr-only'; identifier.textContent = ` #${entry.tag}`;
  name.append(label, identifier);
  if (isMe) { const badge = document.createElement('span'); badge.className = 'rank-me'; badge.textContent = '나'; name.append(badge); }
  row.append(rankCell(String(entry.rank).padStart(2, '0'), 'rank-place'), name,
    rankCell(entry.completed ?? '—', 'rank-objectives'), rankCell(entry.kills, 'rank-kills'),
    rankCell(recordLabel(entry.elapsedMs / 1000), 'rank-duration'),
    rankCell(entry.completed == null ? '이전 기록' : pointsLabel(entry.contribution), 'rank-score'));
  const replay = rankCell('', 'rank-watch');
  if (entry.hasReplay) {
    const watch = document.createElement('button'); watch.className = 'rank-replay';
    watch.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 9 6-9 6z"/></svg>';
    watch.title = '마지막 출격 다시 보기'; watch.setAttribute('aria-label', `${entry.nickname}#${entry.tag} 마지막 출격 다시 보기`);
    watch.addEventListener('click', () => playRankedReplay(entry, mode, watch)); replay.append(watch);
  } else { replay.textContent = '—'; replay.setAttribute('aria-label', '재생 기록 없음'); }
  row.append(replay);
  return row;
}
function setRankingStatus(message = '') {
  $('ranking-status').textContent = message;
  $('ranking-status').hidden = !message;
}
function selectRankingTab(tab) {
  rankingTab = tab;
  for (const name of ['ranking', 'memorial']) {
    const selected = name === tab;
    $(`${name}-tab`).setAttribute('aria-selected', String(selected));
    $(`${name}-tab`).tabIndex = selected ? 0 : -1;
  }
  $('ranking-board').hidden = tab !== 'ranking';
  $('memorial').hidden = tab !== 'memorial';
  $('refresh-ranking').hidden = tab !== 'ranking';
  $('ranking-count').textContent = tab === 'ranking' ? rankingCount : '';
}
async function refreshRanking() {
  const request = ++rankingRequest, mode = 'challenge';
  setRankingStatus('불러오는 중…'); rankingCount = '';
  $('ranking-count').textContent = '';
  $('ranking-list').replaceChildren(); $('my-ranking').hidden = true; $('refresh-ranking').disabled = true;
  $('ranking-board').setAttribute('aria-busy', 'true');
  try {
    await rankings.flush().catch(() => {});
    const result = await rankings.list(mode);
    if (request !== rankingRequest) return;
    rankingCount = `전체 ${pointsLabel(result.total)}명`;
    if (rankingTab === 'ranking') $('ranking-count').textContent = rankingCount;
    setRankingStatus(result.entries.length ? rankings.pending.size ? '내 기록 등록 대기 중' : '' : '등록된 전쟁 기여도 없음');
    $('ranking-list').replaceChildren(...result.entries.map(entry => rankingRow(entry, mode)));
    if (result.own && !result.entries.some(entry => entry.playerId === result.own.playerId)) {
      const table = document.createElement('table'); table.className = 'ranking-table'; table.setAttribute('aria-label', '내 기여도 순위');
      const body = document.createElement('tbody'); body.append(rankingRow(result.own, mode)); table.append(body);
      $('my-ranking').replaceChildren(table); $('my-ranking').hidden = false;
    }
  } catch { if (request === rankingRequest) setRankingStatus('연결 실패 · 새로고침으로 다시 시도'); }
  finally {
    if (request === rankingRequest) { $('refresh-ranking').disabled = false; $('ranking-board').setAttribute('aria-busy', 'false'); }
  }
}
function openRanking() {
  rankingReturn = activeModal; rankingOrigin = document.activeElement;
  updateRecord(); selectRankingTab('ranking');
  showModal('ranking-modal'); refreshRanking();
}
function closeRanking() {
  rankingRequest++; showModal(rankingReturn);
  if (rankingReturn) requestAnimationFrame(() => { if (activeModal === rankingReturn) rankingOrigin?.focus({ preventScroll: true }); });
}
$('rank-home').addEventListener('click', openRanking); $('rank-end').addEventListener('click', openRanking);
$('close-ranking').addEventListener('click', closeRanking);
$('refresh-ranking').addEventListener('click', refreshRanking);
for (const name of ['ranking', 'memorial']) {
  $(`${name}-tab`).addEventListener('click', () => selectRankingTab(name));
  $(`${name}-tab`).addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'ranking' : event.key === 'End' ? 'memorial' : name === 'ranking' ? 'memorial' : 'ranking';
    selectRankingTab(next); $(`${next}-tab`).focus();
  });
}

function scheduleRankingRetry() {
  if (rankingRetryTimer || !rankings.pending.size) return;
  rankingRetryTimer = setTimeout(() => { rankingRetryTimer = null; retryRanking(); }, rankingRetryDelay);
  rankingRetryDelay = Math.min(30000, rankingRetryDelay * 2);
}
async function retryRanking() {
  try {
    await rankings.flush(); rankingRetryDelay = 3000;
    const result = rankings.results.get(currentRun?.runId);
    if (result && game.state === 'ended') $('rank-result').textContent = `최고 기여도 ${result.own.rank}위`;
  } catch { scheduleRankingRetry(); }
}
addEventListener('online', retryRanking);
if (rankings.pending.size && validNickname(rankings.profile.nickname)) retryRanking();

function updateBehavior() {
  $('behavior-stats').innerHTML = game.upgrades.filter(u => game.stats[u.id]).map(u => `<div class="behavior"><span>${u.name}</span><small>${game.stats[u.id]} / ${u.max}단계</small></div>`).join('') || '<div class="empty-build">개량 장비 없음</div>';
}
function start(duration, practice = false, options = {}) {
  const reconnect = feed?.phase === 'residual';
  cancelSignal();
  replaying = Boolean(options.replay);
  lastEndReason = null;
  if (!replaying) activeReplay = null;
  document.body.classList.toggle('replaying', replaying);
  const seed = options.seed ?? crypto.getRandomValues(new Uint32Array(1))[0];
  game.random = seededRandom(seed);
  currentRun = replaying ? null : { runId: crypto.randomUUID(), mode: rankMode(duration, practice), heroName: rankings.profile.nickname };
  recorder = !replaying && !practice ? new ReplayRecorder(currentRun.mode, seed) : null;
  if (!replaying) replayPlayer = null;
  lastDuration = duration; lastPractice = practice; resetInput(); showModal(null); $('home').hidden = true; $('hud').hidden = false; $('pause').hidden = false; $('run-clock').hidden = false;
  document.body.classList.add('playing'); camera = { x: 0, y: 0, zoom: 1.2 }; cameraMotion = { x: 0, y: 0 };
  document.body.classList.toggle('practice-mode', Boolean(practice));
  accumulator = 0; detachToastAt = -10;
  $('run-details').open = false;
  if (practice === 'recruitment') {
    game.startRecruitmentPractice();
    camera.x = game.player.x; camera.y = game.player.y;
  } else if (practice) game.startPractice(); else if (duration === Infinity) game.startChallenge(); else game.start(duration);
  const openingRequest = game.bombardment.requests.find(request => request.state !== 'complete');
  if (openingRequest && Math.hypot(openingRequest.x - game.player.x, openingRequest.y - game.player.y) < 380) {
    camera.x = game.player.x + (openingRequest.x - game.player.x) * .33;
    camera.y = game.player.y + (openingRequest.y - game.player.y) * .33 - 40;
    const extentX = Math.max(100, Math.abs(game.player.x - camera.x), Math.abs(openingRequest.x - camera.x) + FIRE_SUPPORT.radius + 12);
    const extentY = Math.max(100, Math.abs(game.player.y - camera.y), Math.abs(openingRequest.y - camera.y) + FIRE_SUPPORT.radius + 30);
    camera.zoom = Math.max(.28, Math.min(1, (width / 2 - 40) / extentX, (height / 2 - 95) / extentY));
  }
  $('recruit-guide').hidden = practice !== 'recruitment';
  $('restart').firstChild.textContent = practice ? '다시 훈련하기 ' : '다음 출격 ';
  runBest = memorial.data.best;
  updateBehavior(); updateHUD();
  $('time-target').textContent = practice === 'recruitment' ? ' / 훈련' : practice ? ' / 자유 비행' : game.challenge ? '' : ` / ${timeLabel(duration)}`;
  document.querySelector('.time-track').hidden = Boolean(practice || game.challenge);
  $('run-best').hidden = !game.challenge;
  $('exit-replay').hidden = !replaying;
  $('xp-meter').parentElement.hidden = practice;
  canvas.focus({ preventScroll: true });
  if (reconnect) linkFeed();
  if (document.hidden) game.pause();
}
function goHome() {
  cancelSignal();
  sound.reset(); sound.setScene('home', 0, false);
  replaying = false; replayPlayer = null; recorder = null; activeReplay = null; document.body.classList.remove('replaying');
  game.state = 'home'; resetInput(); showModal(null); $('home').hidden = false; $('hud').hidden = true; $('pause').hidden = true; $('run-clock').hidden = true;
  $('exit-replay').hidden = true; $('home-replay').hidden = !latestReplay;
  document.body.classList.remove('playing', 'practice-mode'); updateRecord(); $('start').focus({ preventScroll: true });
}
function updateRecord() {
  $('best-record').textContent = pointsLabel(memorial.data.best);
  updateMemorial();
}
function updateMemorial() {
  const { fallen, total, entries } = memorial.data;
  $('memorial-empty').hidden = Boolean(entries.length);
  $('memorial-fallen').textContent = pointsLabel(fallen);
  $('memorial-total').textContent = pointsLabel(total);
  $('memorial-list').replaceChildren(...entries.map((entry, index) => {
    const row = document.createElement('tr'); row.className = 'ranking-row';
    row.append(rankCell(String(fallen - index).padStart(2, '0'), 'rank-place'), rankCell(entry.name, 'rank-name'),
      rankCell(entry.completed, 'rank-objectives'), rankCell(entry.kills, 'rank-kills'),
      rankCell(recordLabel(entry.elapsed), 'rank-duration'), rankCell(pointsLabel(entry.score), 'rank-score'));
    return row;
  }));
}

function renderContribution(contribution) {
  $('end-time').textContent = pointsLabel(contribution.score);
  $('end-caption').textContent = '전쟁 기여도';
  $('end-objectives').textContent = `${contribution.completed}곳`;
  $('end-kills').textContent = `${game.kills}기`;
  $('end-flock').textContent = `${game.maxFlock}기`;
  $('end-duration').textContent = recordLabel(game.elapsed);
}

function requestEvolution() {
  if (replaying) return;
  if (!game.levelUp()) return;
  recorder?.action('evolve');
  updateHUD();
  if (game.state === 'playing') canvas.focus({ preventScroll: true });
}
function chooseUpgrade(index) {
  if (replaying) return;
  resetInput();
  if (game.chooseUpgrade(index)) recorder?.action('choose', index);
}
function startPlayback(data = latestReplay) {
  if (!data) return;
  try { replayPlayer = new ReplayPlayer(data); }
  catch (error) { $('replay-status').textContent = error.message; return; }
  activeReplay = data;
  const duration = data.mode === 'challenge' ? Infinity : data.mode === 'classic' ? 1800 : 180;
  start(duration, false, { seed: data.seed, replay: true });
  $('run-best').hidden = false;
  $('run-best').textContent = '마지막 출격 · 재생 중';
}
function finishRecording() {
  if (!recorder || game.state !== 'ended') return;
  let replay = null;
  try {
    replay = recorder.finish(game); replay.heroName = currentRun?.heroName; latestReplay = replay;
    $('home-replay').hidden = false; $('replay-button').hidden = false;
    $('replay-status').textContent = '';
    saveReplay(latestReplay)
      .catch(() => { $('replay-status').textContent = '출격 기록 저장 실패'; });
  } catch { $('replay-status').textContent = '출격 기록 저장 실패'; }
  recorder = null;
  if (currentRun) saveFinishedRun(replay);
}
function finishPlayback(error = null) {
  replayPlayer = null; resetInput();
  $('end-eyebrow').textContent = error ? '마지막 출격 · 재생 중단' : '마지막 출격';
  $('end-title').textContent = typeof activeReplay?.heroName === 'string' ? activeReplay.heroName : '영웅';
  $('end-reason').textContent = error ? error.message : game.won ? '출격 완료' : END_REASONS[lastEndReason] ?? '전사';
  $('end-modal').dataset.outcome = error ? 'lost' : 'replay';
  $('end-feed').hidden = true;
  renderContribution(battleContribution(game));
  $('end-record').hidden = !error; $('end-record').classList.remove('is-new');
  $('end-record').textContent = error ? '출격 기록 불일치' : '';
  $('rank-result').hidden = true; $('rank-end').hidden = true; $('replay-button').hidden = true;
  $('build-summary').textContent = game.upgrades.filter(u => game.stats[u.id]).map(u => `${u.name} ${game.stats[u.id]}단계`).join(' · ');
  $('build-summary').hidden = !$('build-summary').textContent;
  $('build-details').hidden = false;
  $('build-details').open = false;
  $('restart').firstChild.textContent = '다시 재생 ';
  if (error) game.state = 'ended';
  showModal('end-modal');
}
$('start-form').addEventListener('submit', event => { event.preventDefault(); beginRun(Infinity); });
$('retry-recruit').addEventListener('click', () => start(1800, 'recruitment'));
$('evolve').addEventListener('click', requestEvolution);
$('restart').addEventListener('click', () => replaying ? startPlayback(activeReplay) : start(lastDuration, lastPractice)); $('resume').addEventListener('click', () => game.resume());
$('home-replay').addEventListener('click', () => startPlayback()); $('replay-button').addEventListener('click', () => startPlayback()); $('exit-replay').addEventListener('click', goHome);
$('pause').addEventListener('click', () => game.pause()); $('quit').addEventListener('click', goHome); $('home-button').addEventListener('click', goHome);
$('help').addEventListener('click', openHelp); $('pause-help').addEventListener('click', openHelp); $('close-help').addEventListener('click', closeHelp);
updateRecord();
loadReplay().then(data => { if (data && !latestReplay) { latestReplay = data; $('home-replay').hidden = false; } }).catch(() => {});

addEventListener('keydown', event => {
  // Retain normal dialog focus navigation without gameplay keyboard shortcuts.
  if (event.key === 'Escape' && activeModal === 'ranking-modal') { event.preventDefault(); closeRanking(); return; }
  if (event.key === 'Tab') {
    const dialog = document.querySelector('.modal:not([hidden])');
    if (dialog) {
      const buttons = [...dialog.querySelectorAll('button:not(:disabled), summary, select, input')].filter(el => el.getClientRects().length), first = buttons[0], end = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); end.focus(); }
      else if (!event.shiftKey && document.activeElement === end) { event.preventDefault(); first.focus(); }
    }
  }
});
addEventListener('blur', () => { resetInput(); game.pause(); });
document.addEventListener('visibilitychange', () => { sound.setHidden(document.hidden); if (document.hidden) { resetInput(); game.pause(); } });
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
  updateSupportHUD();
  $('clock').textContent = game.challenge ? recordLabel(game.elapsed) : timeLabel(game.elapsed); $('time-fill').style.width = `${game.elapsed / game.duration * 100}%`;
  $('phase-label').textContent = game.practice === 'recruitment' ? '드론 확보 훈련' : game.practice ? '조작 훈련' : (game.challenge ? challengePhases : phases)[game.phase];
  const contribution = battleContribution(game);
  $('run-best').textContent = replaying ? `마지막 출격 · 재생 중 · 기여도 ${pointsLabel(contribution.score)}점` : `전쟁 기여도 ${pointsLabel(contribution.score)}점${contribution.score > runBest ? ' · 최고 기록' : ''}`;
  $('detached-count').textContent = game.detachedFollowers;
  $('head-size').textContent = `${Number((game.player.radius / HEAD_GROWTH.baseRadius).toFixed(1))}배 / 최대 ${HEAD_GROWTH.maxScale}배`;
  $('gather').classList.toggle('active', game.player.gathering);
  $('flock-count').textContent = game.player.boids.length; $('kills').textContent = game.kills; $('food-count').textContent = game.collected;
  const swaying = game.player.boids.filter(b => b.influence > .1).length;
  if ($('sway-count').textContent !== String(swaying)) $('sway-count').textContent = swaying;
  $('sway-signal').hidden = !swaying;
  const recruits = [...game.entities.filter(e => e.alive && !e.player).flatMap(e => e.boids), ...game.strays]
    .filter(b => b.influenceTarget === game.player.id && b.influence > .1);
  if ($('recruit-count').textContent !== String(recruits.length)) $('recruit-count').textContent = recruits.length;
  $('recruit-progress').textContent = `${Math.floor(Math.max(0, ...recruits.map(b => b.influence)) * 100)}%`;
  $('recruit-signal').hidden = !recruits.length;
  if (game.practice === 'recruitment') {
    $('recruit-lesson').textContent = game.recruitedFollowers ? `통제권 확보 · 드론 ${game.recruitedFollowers}기 연결 완료` : '적 후방 드론 옆에서 함께 비행하세요';
    $('recruit-instruction').textContent = game.recruitedFollowers ? '적 후방에서 아군 드론이 더 가깝게 모여 통신 우위를 확보했습니다.' : '마우스를 오른쪽으로 향하고 오른쪽 버튼을 꾹 누르세요. 초록 연결 표시가 차면 합류합니다.';
  }
  $('level').textContent = game.level; $('xp-label').textContent = `${Math.floor(game.xp)} / ${game.nextXp}`;
  const evolutionReady = game.xp >= game.nextXp;
  $('evolve').disabled = !game.canEvolve();
  $('evolve').hidden = $('evolve').disabled;
  $('evolve').setAttribute('aria-haspopup', game.availableUpgrades.length ? 'dialog' : 'false');
  $('xp-meter').parentElement.classList.toggle('ready', evolutionReady);
  const evolutionStatus = evolutionReady ? '개량 준비 완료 · 원할 때 선택하세요' : '표적과 적 기체의 잔해에서 부품을 회수하세요';
  if ($('evolution-status').textContent !== evolutionStatus) $('evolution-status').textContent = evolutionStatus;
  $('xp-fill').style.width = `${clamp(game.xp / game.nextXp, 0, 1) * 100}%`; $('boost-fill').style.width = `${game.energy}%`;
  $('boost-fill').style.background = game.player.exhausted ? '#809382' : colors.lime;
  $('energy-label').textContent = game.player.exhausted ? '에너지 회복 중' : game.player.boosting ? '가속 중' : '가속';
  $('energy-meter').setAttribute('aria-valuenow', Math.round(game.energy));
  $('xp-meter').setAttribute('aria-valuenow', Math.min(game.nextXp, Math.floor(game.xp)));
  $('xp-meter').setAttribute('aria-valuemax', game.nextXp);
  $('xp-meter').setAttribute('aria-valuetext', `회수 부품 ${Math.floor(game.xp)}, 개량에 필요한 부품 ${game.nextXp}${evolutionReady ? ', 개량 가능' : ''}`);
}

function nearestRequest() {
  const requests = game.bombardment.requests.filter(r => r.state !== 'complete');
  return requests.find(r => r.id === game.bombardment.activeId) ?? requests.sort((a, b) =>
    Math.hypot(a.x - game.player.x, a.y - game.player.y) - Math.hypot(b.x - game.player.x, b.y - game.player.y))[0];
}
function updateSupportHUD() {
  updateRadarHUD();
  $('support-panel').hidden = !game.bombardment.enabled;
  $('strike-count').textContent = game.bombardment.completed;
  if (!game.bombardment.enabled) return;
  const r = nearestRequest();
  $('support-heading').textContent = r ? `폭격 목표 ${String(r.id).padStart(2, '0')}` : '전장 통신';
  let title = '새 좌표 수신 중', detail = '다음 폭격 목표 대기', progress = game.bombardment.completed ? 1 : 0;
  let progressLabel = game.bombardment.completed ? '제압 완료' : '새 요청 대기', rewardLabel = '다음 좌표 대기 중';
  if (r) {
    title = `좌표 ${requestCoordinates(r)}`;
    const distance = Math.hypot(r.x - game.player.x, r.y - game.player.y);
    progress = facilityDamage(r) / facilityDurability(r);
    progressLabel = `시설 피해 ${facilityDamage(r)} / ${facilityDurability(r)}`;
    rewardLabel = `제압 시 부품 +${r.reward}`;
    $('support-bearing').style.transform = `rotate(${Math.atan2(r.y - game.player.y, r.x - game.player.x)}rad)`;
    if (r.state === 'bombing') {
      detail = `${TARGET_NAMES[r.kind]} · 드론 폭격 중`;
    } else if (r.state === 'paused') {
      detail = `${TARGET_NAMES[r.kind]} · 폭격 중단 · ${Math.round(distance)}m`;
    } else detail = game.player.boids.length ? `${TARGET_NAMES[r.kind]} · 드론 진입 시 폭격 · ${Math.round(distance)}m` : '드론 연결 상실 · 회색 드론 곁에서 결집';
  }
  $('support-title').textContent = title; $('support-detail').textContent = detail;
  $('support-bearing').hidden = !r || r.state === 'bombing' || !game.player.boids.length;
  $('support-progress-label').textContent = progressLabel; $('support-reward').textContent = rewardLabel;
  $('support-fill').style.width = `${progress * 100}%`;
  $('support-meter').setAttribute('aria-valuenow', Math.round(progress * 100));
  $('support-meter').setAttribute('aria-valuetext', progressLabel);
  $('support-panel').classList.toggle('active', r?.state === 'bombing');
  $('support-panel').classList.toggle('complete', !r && game.bombardment.completed > 0);
}

function updateRadarHUD() {
  const defense = game.bombardment.defense, state = defense.state;
  const airborne = defense.shells.length > 0;
  const danger = state === 'locked' || state === 'salvo' || airborne;
  const visible = game.bombardment.enabled && defense.enabled && (state !== 'idle' || defense.overflight || airborne);
  $('radar-warning').hidden = !visible;
  viewport.classList.toggle('radar-threat', Boolean(visible));
  viewport.classList.toggle('radar-locked', Boolean(visible && danger));
  viewport.classList.toggle('radar-incoming', Boolean(visible && (state === 'salvo' || airborne)));
  if (!visible) return;
  $('radar-warning').dataset.state = airborne && state !== 'locked' ? 'salvo' : state;
  const labels = { tracking: '적 레이더 추적 중', locked: '예측 탄막 · 항로 변경', salvo: '대공포 연속 사격', cooldown: '대공포 재장전', lost: '레이더 추적 해제', idle: '적 시설 상공' };
  const solution = FLAK_PATTERN_LABELS[defense.pattern] ?? FLAK_PATTERN_LABELS.predict;
  const title = state === 'locked' ? solution.name : airborne && state !== 'salvo' ? '대공포탄 접근 중' : labels[state];
  if ($('radar-title').textContent !== title) $('radar-title').textContent = title;
  $('radar-detail').textContent = state === 'locked' ? `발포 ${Math.max(0, defense.timer).toFixed(1)}초 전 · ${solution.counter}`
    : state === 'salvo' ? `${defense.shotIndex} / ${defense.salvo.length}발 발사 · ${solution.counter}`
    : airborne ? '발사된 포탄은 계속 접근합니다 · 회피 유지'
    : state === 'tracking' ? '현재 항로를 계산 중 · 직진 주의'
    : state === 'cooldown' ? '재장전 중 · 거리 확보'
    : state === 'lost' ? '안전 거리 확보' : '사거리 밖으로 이탈';
  $('radar-overflight').hidden = !defense.overflight;
  const progress = state === 'tracking' ? defense.progress : state === 'locked' ? 1 - defense.timer / defense.config.warningSeconds : danger ? 1 : 0;
  $('radar-fill').style.width = `${progress * 100}%`;
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
  if (!home) { scenery.draw(ctx, camera, width, height, cameraMotion, reducedMotion); return; }
  ctx.globalAlpha = .15; sprite(ctx, 'airport', width * .1, height * .05, height * .9); ctx.globalAlpha = 1;
  const space = 46, ox = 0, oy = 0;
  ctx.fillStyle = '#81b99b'; ctx.globalAlpha = .1;
  for (let y = oy; y < height; y += space) for (let x = ox; x < width; x += space) { ctx.beginPath(); ctx.arc(x, y, .7, 0, Math.PI * 2); ctx.fill(); }
  ctx.globalAlpha = 1;
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
  let extentX = Math.max(100, Math.abs(p.x - focusX)), extentY = Math.max(100, Math.abs(p.y - focusY));
  for (const b of p.boids) {
    extentX = Math.max(extentX, Math.abs(b.x - focusX));
    extentY = Math.max(extentY, Math.abs(b.y - focusY));
  }
  if (groundTarget && targetFraming) {
    extentX = Math.max(extentX, Math.abs(groundTarget.x - focusX) + (FIRE_SUPPORT.radius + 12) * targetFraming);
    extentY = Math.max(extentY, Math.abs(groundTarget.y - focusY) + (FIRE_SUPPORT.radius + 30) * targetFraming);
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
  camera.zoom = lerp(camera.zoom, Math.max(.28, targetZoom), 1 - Math.exp(-dt * 1.5));
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
    }
    if (e.player) leaderHeading(e);
    if (!e.player) {
      const action = { roam: '탐색', forage: '부품 회수', pursue: '진로 차단', intercept: '지원 드론 공격', regroup: '재결집', recover: '드론 회수', evade: '회피' }[e.intent];
      ctx.font = '10px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = color; ctx.globalAlpha = .8;
      ctx.fillText(game.practice === 'recruitment' ? `훈련 편대 · ${e.boids.length}기` : `${TEMPERAMENTS[e.temperament]} · ${action}`, e.x, e.y - 28); ctx.globalAlpha = 1;
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
  map.beginPath(); map.arc(80, 80, 70, 0, Math.PI * 2); map.fill(); map.stroke();
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
  if (game.state === 'playing') {
    accumulator = Math.min(accumulator + dt, .1);
    while (accumulator >= REPLAY_STEP && game.state === 'playing') {
      if (replaying) {
        try { if (replayPlayer?.step(game)) finishPlayback(); }
        catch (error) { finishPlayback(error); }
      } else {
        const input = getInput();
        recorder?.input(input);
        game.update(REPLAY_STEP, input);
        recorder?.afterStep(game);
        if (game.state === 'ended') finishRecording();
      }
      for (const e of game.entities) if (e.alive) rememberLeader(e, game.elapsed);
      accumulator -= REPLAY_STEP;
    }
    if (toastTimer > 0) { toastTimer -= dt; if (toastTimer <= 0) $('toast').classList.remove('visible'); }
  } else accumulator = 0;
  sound.update(game); updateEffects(dt);
  if (game.state === 'home') drawHome(dt); else drawWorld(game.state === 'playing' ? dt : 0);
  hudTime += dt; if (hudTime > .1 && game.state !== 'home') { updateHUD(); hudTime = 0; }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
