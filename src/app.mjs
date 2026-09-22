import { Game, WORLD_RADIUS, UPGRADES, TEMPERAMENTS, HEAD_GROWTH, headScaleForLevel, clamp, lerp, timeLabel } from './engine.mjs';
import { Scenery } from './scenery.mjs';
import { RankingClient } from './ranking.mjs';
import { normalizeNickname, validNickname, rankMode } from './identity.mjs';

const $ = id => document.getElementById(id);
const viewport = $('viewport-shell');
const canvas = $('world'), ctx = canvas.getContext('2d', { alpha: false });
const map = $('minimap').getContext('2d');
const colors = { lime: '#c9ed92', coral: '#f2957e', gold: '#e6c77f', aqua: '#80cec0' };
const phases = ['고요한 수면', '낯선 물결', '사냥의 시작', '거친 흐름', '깊은 곳의 포식자', '마지막 물결'];
const challengePhases = ['첫 사냥', '좁아지는 틈', '이어지는 추격', '거친 흐름', '포식자의 시간', '한계 너머'];
const recordScore = seconds => Math.floor(seconds * 10 + 1e-7) / 10;
const recordLabel = seconds => { const tenths = Math.floor(seconds * 10 + 1e-7); return `${timeLabel(tenths / 10)}.${tenths % 10}`; };
let width = innerWidth, height = innerHeight, dpr = 1, last = 0, accumulator = 0, visualTime = 0, hudTime = 0;
let camera = { x: 0, y: 0, zoom: 1 };
let cameraMotion = { x: 0, y: 0 };
const scenery = new Scenery(WORLD_RADIUS + 650);
let aim = null, mouseHeld = false, gatherHeld = false, gatherToggle = false, toastTimer = 0, lastDuration = Infinity, lastPractice = false, detachToastAt = -10, runBest = 0;
const keys = new Set(), touches = new Map();
const leaderTrails = new WeakMap();
let activeModal = null, modalOrigin = null, helpOrigin = null, helpReturnToPause = false;
const rankings = new RankingClient();
let currentRun = null, starting = false, rankingReturn = null, rankingOrigin = null, rankingRequest = 0;
let rankingRetryTimer = null, rankingRetryDelay = 3000;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const readStorage = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const saveStorage = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Private browsing can disable storage. */ } };
const readBest = key => { const value = readStorage(key, 0); return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0; };
let soundEnabled = readStorage('murmur-sound', false), audio = null, lastChirp = 0;

function resize() {
  const bounds = viewport.getBoundingClientRect();
  width = bounds.width; height = bounds.height; dpr = Math.min(devicePixelRatio || 1, 2);
  viewport.style.setProperty('--edge', `${Math.max(20, Math.min(56, width * .0375))}px`);
  canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
}
addEventListener('resize', resize); resize();

function playTone(frequency = 440, length = .1, volume = .04, type = 'sine', slide = 1) {
  if (!soundEnabled) return;
  try {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const osc = audio.createOscillator(), gain = audio.createGain();
    osc.type = type; osc.frequency.setValueAtTime(frequency, audio.currentTime);
    osc.frequency.exponentialRampToValueAtTime(frequency * slide, audio.currentTime + length);
    gain.gain.setValueAtTime(volume, audio.currentTime); gain.gain.exponentialRampToValueAtTime(.0001, audio.currentTime + length);
    osc.connect(gain); gain.connect(audio.destination); osc.start(); osc.stop(audio.currentTime + length);
  } catch { /* Sound is optional; the game remains playable without Web Audio. */ }
}
function updateSound() {
  $('sound').setAttribute('aria-label', soundEnabled ? '소리 끄기' : '소리 켜기');
  $('sound').title = soundEnabled ? '소리 끄기' : '소리 켜기';
  $('sound').setAttribute('aria-pressed', String(soundEnabled));
  $('sound').querySelector('.sound-slash').style.display = soundEnabled ? 'none' : '';
}
$('sound').addEventListener('click', () => { soundEnabled = !soundEnabled; saveStorage('murmur-sound', soundEnabled); updateSound(); playTone(520); }); updateSound();

function toast(message, duration = 3.4) { $('toast').textContent = message; $('toast').classList.add('visible'); toastTimer = duration; }
function resetInput() { keys.clear(); mouseHeld = false; gatherHeld = false; gatherToggle = false; touches.clear(); aim = null; $('gather').setAttribute('aria-pressed', 'false'); }
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
    boost: '<path d="M28 4 12 28h12l-2 18 17-26H27z"/>',
  };
  return `<svg class="upgrade-icon" viewBox="0 0 50 50" aria-hidden="true">${paths[id]}</svg>`;
}
function showUpgrades() {
  const scale = headScaleForLevel(game.level);
  $('upgrade-description').textContent = `시간은 멈춰 있어요. ${game.player.radius < game.player.growthTargetRadius ? `대장이 ${Number(scale.toFixed(1))}배로 커지고, 더 빨라져요.` : '대장은 최대 크기예요.'} 무리를 키울 힘을 골라주세요.`;
  $('upgrade-cards').replaceChildren();
  game.choices.forEach((upgrade, index) => {
    const button = document.createElement('button'); button.className = 'upgrade-card';
    const effect = upgrade.id === 'boost' ? '더 오래 가속할 수 있어요.' : upgrade.effect;
    button.innerHTML = `<span class="card-index desktop-copy" aria-hidden="true">${index + 1}</span>${iconSVG(upgrade.icon)}<h3>${upgrade.name}</h3><span class="card-level">선택 시 ${game.stats[upgrade.id] + 1} / ${upgrade.max}단계</span><div class="card-description">${upgrade.description} ${effect}</div>`;
    button.addEventListener('click', () => { resetInput(); game.chooseUpgrade(index); });
    $('upgrade-cards').append(button);
  });
  showModal('upgrade-modal');
}
function onEvent(event) {
  if (event.type === 'start') { toast(event.practice === 'recruitment' ? '내 12마리 vs 적 64마리 · 꼬리 끝을 노려보세요' : event.practice ? '적 없는 자유 비행 · 결집과 가속을 시험해 보세요' : event.challenge ? `작은 적을 먼저 노리세요 · 진화 에너지 ${game.nextXp}을 모아보세요` : '머리를 지키고, 적의 잔해를 모으세요', 4); playTone(220, .4, .035, 'sine', 2); }
  if (event.type === 'food' && visualTime - lastChirp > .12) { lastChirp = visualTime; playTone(620 + game.collected % 5 * 90, .085, .012); }
  if (event.type === 'kill') { toast(`적 군체 해체 · 남은 먹이를 흡수하세요`); playTone(140, .3, .04, 'triangle', 2.8); }
  if (event.type === 'sway') { toast('동료가 흔들려요 · 가까이 돌아가 결집하세요', 4); playTone(230, .3, .025, 'triangle', .75); }
  if (event.type === 'allegiance') {
    toast(event.lost ? `동료 ${event.lost}마리가 적 군체로 넘어갔습니다` : `새 동료 ${event.gained}마리가 우리 군체에 합류했습니다`, 4);
    playTone(event.lost ? 180 : 480, .18, .014, 'sine', event.lost ? .7 : 1.4);
  }
  if (event.type === 'detached' && visualTime - detachToastAt > 3) {
    detachToastAt = visualTime;
    toast('동료가 떨어졌어요 · 가까이 함께 날면 다시 합류해요', 4);
  }
  if (event.type === 'phase') { toast(`${(game.challenge ? challengePhases : phases)[event.phase]} · 더 강한 군체가 다가옵니다`, 3); playTone(140, .5, .045, 'sine', .6); }
  if (event.type === 'evolution-ready') { updateHUD(); toast('진화 준비 완료 · 아래의 진화하기를 눌러주세요', 4); playTone(420, .18, .025, 'sine', 1.5); }
  if (event.type === 'upgrade') { resetInput(); showUpgrades(); playTone(420, .25, .03, 'sine', 2); }
  if (event.type === 'evolved') { showModal(null); toast(`진화 완료 · ${event.upgrade.name} ${game.stats[event.upgrade.id]}단계`); updateBehavior(); updateHUD(); playTone(650, .3, .025, 'sine', 1.5); }
  if (event.type === 'pause') { resetInput(); updateHUD(); showModal('pause-modal'); }
  if (event.type === 'resume') { resetInput(); showModal(null); }
  if (event.type === 'mastery') { resetInput(); updateHUD(); toast('진화 완료 · 가속 에너지를 채웠어요'); }
  if (event.type === 'end') {
    resetInput();
    const key = game.challenge ? 'murmur-challenge-best' : game.duration === 1800 ? 'murmur-best' : 'murmur-quick-best';
    const best = readBest(key), score = game.challenge ? recordScore(game.elapsed) : game.elapsed, newRecord = !game.practice && score > best;
    if (!game.practice) saveStorage(key, Math.max(best, score));
    $('end-title').textContent = event.won ? '우리는 살아남았다.' : game.challenge && newRecord ? '조금 더, 멀리.' : '한 번 더, 날아볼까요.';
    $('end-reason').textContent = event.won ? `${game.duration === 1800 ? '30분의 생존' : '3분의 탐색'}을 마쳤습니다. 함께였기에 가능했어요.` : event.reason === 'head-on' ? '대장끼리 부딪혀 둘 다 쓰러졌습니다.' : '머리가 적의 꼬리에 닿았습니다. 다음엔 더 큰 흐름으로.';
    $('end-time').textContent = game.challenge ? recordLabel(game.elapsed) : timeLabel(game.elapsed); $('end-flock').textContent = `${game.maxFlock}마리`; $('end-kills').textContent = game.kills;
    $('end-record').hidden = Boolean(game.practice);
    $('end-record').textContent = newRecord ? best ? `새 기록 · 이전보다 ${recordLabel(score - best)} 더 생존` : `첫 기록 ${game.challenge ? recordLabel(score) : timeLabel(score)}` : `최고 기록 ${game.challenge ? recordLabel(best) : timeLabel(best)}`;
    $('build-summary').textContent = UPGRADES.filter(u => game.stats[u.id]).map(u => `${u.name} ${game.stats[u.id]}단계`).join(' · ');
    $('build-summary').hidden = !$('build-summary').textContent;
    $('rank-result').hidden = Boolean(game.practice);
    $('rank-end').hidden = Boolean(game.practice);
    if (!game.practice && currentRun) saveFinishedRun();
    showModal('end-modal'); playTone(event.won ? 400 : 160, .7, .04, 'sine', event.won ? 2 : .3);
  }
}
const game = new Game({ onEvent });

function updateIdentity() {
  const nickname = normalizeNickname($('nickname').value);
  $('player-identity').textContent = nickname ? `${nickname}#${rankings.profile.tag}${rankings.persistent ? ' · 이 브라우저에서 기억해요' : ' · 이번 방문에만 기억해요'}` : '이름이 같아도 고유번호로 구분해요.';
}
$('nickname').value = rankings.profile.nickname;
$('nickname').addEventListener('input', () => { $('nickname').setCustomValidity(''); $('nickname-error').hidden = true; updateIdentity(); });
updateIdentity();

async function beginRun(duration, practice = false) {
  if (starting) return;
  const nickname = normalizeNickname($('nickname').value);
  if (!validNickname(nickname)) {
    $('nickname').setCustomValidity('닉네임을 1~16자로 입력해주세요.');
    $('nickname').reportValidity(); $('nickname').focus(); return;
  }
  rankings.setNickname(nickname); $('nickname').value = nickname; updateIdentity();
  starting = true; $('start').disabled = true; $('start-form').setAttribute('aria-busy', 'true');
  $('start').firstChild.textContent = '준비 중… '; $('home').inert = true; $('topbar').inert = true;
  try { await rankings.register(); rankings.flush().catch(() => {}); }
  catch { /* Completed offline runs are queued for automatic retry. */ }
  finally {
    starting = false; $('start').disabled = false; $('start-form').removeAttribute('aria-busy');
    $('start').firstChild.textContent = '플레이 '; $('home').inert = false; $('topbar').inert = false;
    updateIdentity(); start(duration, practice);
  }
}

async function saveFinishedRun() {
  const runId = currentRun.runId;
  const score = { ...currentRun, elapsedMs: Math.floor(game.elapsed * 10 + 1e-7) * 100, maxFlock: game.maxFlock, kills: game.kills };
  const playerLabel = rankings.label;
  $('rank-result').textContent = `${playerLabel} · 랭킹에 등록하는 중…`;
  try {
    const result = await rankings.submit(score);
    if (currentRun?.runId === runId && game.state === 'ended') $('rank-result').textContent = `${playerLabel} · ${result.own.rank}위${result.newBest ? ' · 최고 기록 등록' : ' · 기존 최고 기록 유지'}`;
  } catch {
    if (currentRun?.runId === runId && game.state === 'ended') $('rank-result').textContent = '랭킹 등록 대기 중 · 연결되면 자동으로 다시 시도해요.';
    scheduleRankingRetry();
  }
}

function rankingRow(entry) {
  const row = document.createElement('li'); row.className = 'ranking-row';
  row.classList.toggle('is-me', entry.playerId === rankings.profile.playerId);
  const place = document.createElement('span'); place.className = 'rank-place'; place.textContent = entry.rank;
  const name = document.createElement('span'); name.className = 'rank-name'; name.textContent = entry.nickname;
  const tag = document.createElement('small'); tag.textContent = `#${entry.tag}${entry.playerId === rankings.profile.playerId ? ' · 나' : ''}`; name.append(tag);
  const time = document.createElement('span'); time.className = 'rank-time'; time.textContent = recordLabel(entry.elapsedMs / 1000);
  row.append(place, name, time); return row;
}
async function refreshRanking() {
  const request = ++rankingRequest, mode = $('ranking-mode').value;
  $('ranking-status').textContent = '랭킹을 불러오는 중이에요.';
  $('ranking-list').replaceChildren(); $('my-ranking').hidden = true; $('refresh-ranking').disabled = true;
  try {
    await rankings.flush().catch(() => {});
    const result = await rankings.list(mode);
    if (request !== rankingRequest) return;
    $('ranking-status').textContent = result.entries.length ? `${result.total}명의 최고 기록${rankings.pending.size ? ' · 내 기록은 등록 대기 중' : ''}` : '아직 기록이 없어요. 첫 번째로 이름을 남겨보세요.';
    $('ranking-list').replaceChildren(...result.entries.map(rankingRow));
    if (result.own && !result.entries.some(entry => entry.playerId === result.own.playerId)) {
      const label = document.createElement('p'); label.textContent = '내 최고 기록';
      const list = document.createElement('ol'); list.className = 'ranking-list'; list.append(rankingRow(result.own));
      $('my-ranking').replaceChildren(label, list); $('my-ranking').hidden = false;
    }
  } catch { if (request === rankingRequest) $('ranking-status').textContent = '랭킹에 연결할 수 없어요. 새로고침으로 다시 시도해주세요.'; }
  finally { if (request === rankingRequest) $('refresh-ranking').disabled = false; }
}
function openRanking() {
  rankingReturn = activeModal; rankingOrigin = document.activeElement;
  $('ranking-mode').value = game.state === 'ended' ? currentRun?.mode || 'challenge' : 'challenge';
  showModal('ranking-modal'); refreshRanking();
}
function closeRanking() {
  rankingRequest++; showModal(rankingReturn);
  if (rankingReturn) requestAnimationFrame(() => { if (activeModal === rankingReturn) rankingOrigin?.focus({ preventScroll: true }); });
}
$('rank-home').addEventListener('click', openRanking); $('rank-end').addEventListener('click', openRanking);
$('close-ranking').addEventListener('click', closeRanking); $('ranking-mode').addEventListener('change', refreshRanking);
$('refresh-ranking').addEventListener('click', refreshRanking);
function scheduleRankingRetry() {
  if (rankingRetryTimer || !rankings.pending.size) return;
  rankingRetryTimer = setTimeout(() => { rankingRetryTimer = null; retryRanking(); }, rankingRetryDelay);
  rankingRetryDelay = Math.min(30000, rankingRetryDelay * 2);
}
async function retryRanking() {
  try {
    await rankings.flush(); rankingRetryDelay = 3000;
    const result = rankings.results.get(currentRun?.runId);
    if (result && game.state === 'ended') $('rank-result').textContent = `${rankings.label} · ${result.own.rank}위 · 등록 완료`;
  } catch { scheduleRankingRetry(); }
}
addEventListener('online', retryRanking);
if (rankings.pending.size && validNickname(rankings.profile.nickname)) retryRanking();

function updateBehavior() {
  $('behavior-stats').innerHTML = UPGRADES.filter(u => game.stats[u.id]).map(u => `<div class="behavior"><span>${u.name}</span><small>${game.stats[u.id]} / ${u.max}단계</small></div>`).join('') || '<div class="empty-build">잔해를 모으면 새 능력을 고를 수 있어요.</div>';
}
function start(duration, practice = false) {
  currentRun = { runId: crypto.randomUUID(), mode: rankMode(duration, practice) };
  lastDuration = duration; lastPractice = practice; resetInput(); showModal(null); $('home').hidden = true; $('hud').hidden = false; $('pause').hidden = false; $('run-clock').hidden = false;
  document.body.classList.add('playing'); camera = { x: 0, y: 0, zoom: width < 600 ? .88 : 1.2 }; cameraMotion = { x: 0, y: 0 };
  document.body.classList.toggle('practice-mode', Boolean(practice));
  accumulator = 0; detachToastAt = -10;
  $('run-details').open = false;
  if (practice === 'recruitment') {
    game.startRecruitmentPractice(); gatherToggle = true; $('gather').setAttribute('aria-pressed', 'true');
    camera.x = game.player.x; camera.y = game.player.y;
  } else if (practice) game.startPractice(); else if (duration === Infinity) game.startChallenge(); else game.start(duration);
  $('recruit-guide').hidden = practice !== 'recruitment';
  runBest = readBest('murmur-challenge-best');
  updateBehavior(); updateHUD();
  $('time-target').textContent = practice === 'recruitment' ? ' / 연습' : practice ? ' / 자유 비행' : game.challenge ? '' : ` / ${timeLabel(duration)}`;
  document.querySelector('.time-track').hidden = Boolean(practice || game.challenge);
  $('run-best').hidden = !game.challenge;
  $('xp-meter').parentElement.hidden = practice;
  canvas.focus({ preventScroll: true });
  if (document.hidden) game.pause();
}
function goHome() {
  game.state = 'home'; resetInput(); showModal(null); $('home').hidden = false; $('hud').hidden = true; $('pause').hidden = true; $('run-clock').hidden = true;
  document.body.classList.remove('playing', 'practice-mode'); updateRecord(); updateIdentity(); $('nickname').focus({ preventScroll: true });
  $('other-modes').open = false;
}
function updateRecord() { const record = readBest('murmur-challenge-best'); $('best-record').textContent = record ? `최고 생존 ${recordLabel(record)}` : ''; $('best-record').hidden = !record; }
function requestEvolution() {
  if (!game.levelUp()) return;
  updateHUD();
  if (game.state === 'playing') canvas.focus({ preventScroll: true });
}
$('start-form').addEventListener('submit', event => { event.preventDefault(); beginRun(Infinity); });
$('classic').addEventListener('click', () => beginRun(1800)); $('quick').addEventListener('click', () => beginRun(180));
$('practice').addEventListener('click', () => beginRun(1800, true));
$('recruit-practice').addEventListener('click', () => beginRun(1800, 'recruitment'));
$('retry-recruit').addEventListener('click', () => start(1800, 'recruitment'));
$('gather').addEventListener('click', () => { if (game.state === 'playing') { gatherToggle = !gatherToggle; $('gather').setAttribute('aria-pressed', String(gatherToggle)); } });
$('evolve').addEventListener('click', requestEvolution);
$('restart').addEventListener('click', () => start(lastDuration, lastPractice)); $('resume').addEventListener('click', () => game.resume());
$('pause').addEventListener('click', () => game.pause()); $('quit').addEventListener('click', goHome); $('home-button').addEventListener('click', goHome);
$('help').addEventListener('click', openHelp); $('pause-help').addEventListener('click', openHelp); $('close-help').addEventListener('click', closeHelp);
updateRecord();

addEventListener('keydown', event => {
  const key = event.key.toLowerCase();
  const isEvolutionKey = event.code === 'KeyE' || key === 'e' || key === 'ㄷ';
  if (key === 'tab') {
    const dialog = document.querySelector('.modal:not([hidden])');
    if (dialog) {
      const buttons = [...dialog.querySelectorAll('button:not(:disabled), summary, select, input')].filter(el => el.getClientRects().length), first = buttons[0], end = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); end.focus(); }
      else if (!event.shiftKey && document.activeElement === end) { event.preventDefault(); first.focus(); }
    }
  }
  if (activeModal === 'help-modal') { if (key === 'escape') { event.preventDefault(); closeHelp(); } return; }
  if (activeModal === 'ranking-modal') { if (key === 'escape') { event.preventDefault(); closeRanking(); } return; }
  if (event.target.matches?.('input, select, textarea')) return;
  if (event.repeat) return;
  if (game.state === 'ended' && activeModal === 'end-modal' && key === 'r') { event.preventDefault(); start(lastDuration, lastPractice); return; }
  if (key === 'escape' || key === 'p') { if (game.state === 'playing') game.pause(); else if (game.state === 'paused') game.resume(); return; }
  if (game.state === 'upgrade' && ['1', '2', '3'].includes(key)) { game.chooseUpgrade(Number(key) - 1); return; }
  if (game.state === 'playing') {
    if (isEvolutionKey) { event.preventDefault(); requestEvolution(); return; }
    // Space activates a focused control; it only boosts while steering the canvas.
    if (event.target.closest?.('button, summary') && [' ', 'enter'].includes(key)) return;
    if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) event.preventDefault();
    keys.add(key);
  }
});
addEventListener('keyup', event => keys.delete(event.key.toLowerCase()));
canvas.addEventListener('pointermove', event => {
  if (event.pointerType === 'touch' && !touches.has(event.pointerId)) return;
  const point = localPointer(event);
  if (event.pointerType === 'touch') touches.set(event.pointerId, point);
  aim = point;
});
canvas.addEventListener('pointerdown', event => {
  if (game.state !== 'playing') return;
  canvas.focus({ preventScroll: true });
  canvas.setPointerCapture(event.pointerId);
  if (event.pointerType === 'touch') touches.set(event.pointerId, localPointer(event));
  else if (event.button === 2) gatherHeld = true;
  else if (event.button === 0) mouseHeld = true;
  aim = localPointer(event);
});
canvas.addEventListener('contextmenu', event => { if (game.state !== 'home') event.preventDefault(); });
function releasePointer(event) { if (event.button === 2 || event.type === 'pointercancel') gatherHeld = false; if (event.button === 0 || event.type === 'pointercancel') mouseHeld = false; touches.delete(event.pointerId); if (event.pointerType === 'touch' && !touches.size) aim = null; }
addEventListener('pointerup', releasePointer); addEventListener('pointercancel', releasePointer);
addEventListener('blur', () => { resetInput(); game.pause(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { resetInput(); game.pause(); } });
function getInput() {
  return {
    dx: Number(keys.has('d') || keys.has('arrowright')) - Number(keys.has('a') || keys.has('arrowleft')),
    dy: Number(keys.has('s') || keys.has('arrowdown')) - Number(keys.has('w') || keys.has('arrowup')),
    targetX: aim ? (aim.x - width / 2) / camera.zoom + camera.x : undefined,
    targetY: aim ? (aim.y - height / 2) / camera.zoom + camera.y : undefined,
    boost: keys.has(' ') || mouseHeld || touches.size > 1,
    gather: keys.has('shift') || gatherHeld || gatherToggle,
  };
}
function updateHUD() {
  $('clock').textContent = game.challenge ? recordLabel(game.elapsed) : timeLabel(game.elapsed); $('time-fill').style.width = `${game.elapsed / game.duration * 100}%`;
  $('phase-label').textContent = game.practice === 'recruitment' ? '꼬리 데려오기' : game.practice ? '조작 연습' : (game.challenge ? challengePhases : phases)[game.phase];
  $('run-best').textContent = runBest ? recordScore(game.elapsed) > runBest ? '최고 기록 경신 중' : `최고 ${recordLabel(runBest)}` : '첫 기록에 도전';
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
    $('recruit-lesson').textContent = game.recruitedFollowers ? `성공! 새 친구 ${game.recruitedFollowers}마리를 데려왔어요` : '꼬리 옆에서 함께 날아요';
    $('recruit-instruction').textContent = game.recruitedFollowers ? '적 전체는 더 컸지만, 꼬리 끝에서는 우리 친구들이 더 가까이 모여 있었어요.' : '결집을 켜 두었어요. 그대로 오른쪽으로 날며 초록 원이 차는 모습을 보세요. 연습 상대는 직진해요.';
  }
  $('level').textContent = game.level; $('xp-label').textContent = `${Math.floor(game.xp)} / ${game.nextXp}`;
  const evolutionReady = game.xp >= game.nextXp;
  $('evolve').disabled = !game.canEvolve();
  $('evolve').setAttribute('aria-haspopup', String(UPGRADES.some(u => game.stats[u.id] < u.max) ? 'dialog' : 'false'));
  $('xp-meter').parentElement.classList.toggle('ready', evolutionReady);
  const evolutionStatus = evolutionReady ? '진화 준비 완료 · 원할 때 눌러주세요' : '먹이로 진화 에너지를 모아요';
  if ($('evolution-status').textContent !== evolutionStatus) $('evolution-status').textContent = evolutionStatus;
  $('xp-fill').style.width = `${clamp(game.xp / game.nextXp, 0, 1) * 100}%`; $('boost-fill').style.width = `${game.energy}%`;
  $('boost-fill').style.background = game.player.exhausted ? '#809382' : colors.lime;
  $('energy-label').textContent = game.player.exhausted ? '에너지 회복 중' : game.player.boosting ? '가속 중' : '가속';
  $('energy-meter').setAttribute('aria-valuenow', Math.round(game.energy));
  $('xp-meter').setAttribute('aria-valuenow', Math.min(game.nextXp, Math.floor(game.xp)));
  $('xp-meter').setAttribute('aria-valuemax', game.nextXp);
  $('xp-meter').setAttribute('aria-valuetext', `모은 진화 에너지 ${Math.floor(game.xp)}, 필요한 에너지 ${game.nextXp}${evolutionReady ? ', 진화 가능' : ''}`);
}

function bird(x, y, angle, size, color, alpha = 1, phase = 0) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(angle); ctx.globalAlpha = alpha; ctx.fillStyle = color;
  const wing = size * (reducedMotion ? 1 : 1 + Math.sin(visualTime * 7 + phase) * .18);
  ctx.beginPath(); ctx.moveTo(size, 0); ctx.lineTo(-size * .55, -wing);
  ctx.lineTo(-size * .2, -size * .18); ctx.lineTo(-size * .7, 0);
  ctx.lineTo(-size * .2, size * .18); ctx.lineTo(-size * .55, wing); ctx.closePath(); ctx.fill(); ctx.restore();
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
  ctx.save(); ctx.lineCap = 'round'; ctx.strokeStyle = flockColor(head);
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1], b = trail[i], fade = clamp(1 - (time - b.time) / lifetime, 0, 1);
    if (!fade) continue;
    ctx.globalAlpha = (.12 + speed * .1) * fade ** 1.7;
    ctx.lineWidth = head.radius * 1.45 * fade;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  // A few fading silhouettes read as afterimages, not additional flock members.
  let lastGhost = null;
  for (let age = .1; age < lifetime; age += .085) {
    const sample = trail.find(point => time - point.time <= age);
    if (!sample || Math.hypot(head.x - sample.x, head.y - sample.y) < 10 ||
        (lastGhost && Math.hypot(lastGhost.x - sample.x, lastGhost.y - sample.y) < 8)) continue;
    lastGhost = sample;
    const fade = 1 - age / lifetime;
    ctx.globalAlpha = .18 * fade; ctx.fillStyle = head.player ? '#dff5b4' : flockColor(head);
    ctx.beginPath(); ctx.arc(sample.x, sample.y, head.radius * (.55 + fade * .35), 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}
function leaderHeading(head) {
  ctx.save(); ctx.translate(head.x, head.y); ctx.rotate(head.angle);
  ctx.save(); const markerScale = Math.sqrt(head.radius / HEAD_GROWTH.baseRadius); ctx.scale(markerScale, markerScale);
  ctx.strokeStyle = '#214531'; ctx.lineWidth = 2.3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(1, -3.4); ctx.lineTo(5, 0); ctx.lineTo(1, 3.4); ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = '#e4f6ba'; ctx.globalAlpha = .8; ctx.lineWidth = 1.7;
  ctx.beginPath(); ctx.arc(0, 0, head.radius + 6, -.37, .37); ctx.stroke();
  ctx.restore();
}
function flockColor(e) { return e.player ? colors.lime : e.type === 'hunter' ? '#de858f' : e.type === 'titan' ? '#d8aa74' : colors.coral; }
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
  const space = 46, ox = 0, oy = 0;
  ctx.fillStyle = '#81b99b'; ctx.globalAlpha = .1;
  for (let y = oy; y < height; y += space) for (let x = ox; x < width; x += space) { ctx.beginPath(); ctx.arc(x, y, .7, 0, Math.PI * 2); ctx.fill(); }
  ctx.globalAlpha = 1;
}
// The title screen runs the same neighbor-based flock simulation as gameplay.
const demo = new Game();
demo.state = 'playing'; demo.spawnTimer = Infinity; demo.duration = Infinity; demo.stats.separation = 1;
while (demo.player.boids.length < 100) demo.addBoid(demo.player);
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
  const small = width < 600, cx = width * (small ? .73 : .735), cy = height * (small ? .22 : .47);
  const scale = Math.min(width / 1280, height / 780) * (small ? 2.1 : 1.6);
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
    birdTrail(b, '#c9ed92');
    bird(b.x, b.y, b.angle, b.radius, '#d0e8a0', .72 + Math.sin(b.seed) * .18, b.seed);
  }
  glow(head.x, head.y, 72, '#b1d984', .12);
  ctx.fillStyle = '#e4f3af'; ctx.beginPath(); ctx.arc(head.x, head.y, 12, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#c9ed9250'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(head.x, head.y, 20, 0, Math.PI * 2); ctx.stroke();
  leaderHeading(head);
  ctx.restore();
}
function onScreen(x, y, pad = 80) { return Math.abs((x - camera.x) * camera.zoom) < width / 2 + pad && Math.abs((y - camera.y) * camera.zoom) < height / 2 + pad; }
function drawWorld(dt) {
  const p = game.player;
  const centerX = p.boids.reduce((sum, b) => sum + b.x, p.x) / (p.boids.length + 1);
  const centerY = p.boids.reduce((sum, b) => sum + b.y, p.y) / (p.boids.length + 1);
  const focusX = lerp(centerX, p.x, .48) + Math.cos(p.angle) * 22;
  const focusY = lerp(centerY, p.y, .48) + Math.sin(p.angle) * 22;
  const extentX = Math.max(100, ...[p, ...p.boids].map(b => Math.abs(b.x - focusX)));
  const extentY = Math.max(100, ...[p, ...p.boids].map(b => Math.abs(b.y - focusY)));
  // Start closer to the flock, then gradually widen the view as the leader
  // evolves. The fit limits still protect the flock from being clipped.
  const closeZoom = width < 600 ? 1.15 : 1.5;
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
  for (const f of game.food) {
    if (!onScreen(f.x, f.y, 20)) continue;
    const shimmer = .65 + Math.sin(visualTime * 2 + f.seed) * .2, size = f.value > 1 ? 3.2 : 1.9;
    ctx.fillStyle = f.value > 1 ? colors.gold : '#a8c886'; ctx.globalAlpha = shimmer;
    if (f.value > 1) { ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(Math.PI / 4); ctx.fillRect(-size, -size, size * 2, size * 2); ctx.restore(); }
    else { ctx.beginPath(); ctx.arc(f.x, f.y, size, 0, Math.PI * 2); ctx.fill(); }
    ctx.globalAlpha = .05; ctx.beginPath(); ctx.arc(f.x, f.y, size * 4, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  const drawOrder = [...game.entities.filter(e => !e.player), p];
  const factions = new Map(game.entities.map(e => [e.id, e]));
  let recruitFocus = null;
  for (const b of [...game.entities.flatMap(e => e.boids), ...game.strays]) {
    if (b.influenceTarget === p.id && b.influence > .1 && onScreen(b.x, b.y) && (!recruitFocus || b.influence > recruitFocus.influence)) recruitFocus = b;
  }
  for (const e of drawOrder) if (e.alive && onScreen(e.x, e.y, 140)) leaderWake(e, game.elapsed);
  for (const b of game.strays) {
    if (!onScreen(b.x, b.y, 25)) continue;
    const target = factions.get(b.influenceTarget);
    const color = target ? mixColor('#819995', flockColor(target), b.influence * .8) : '#819995';
    birdTrail(b, color); bird(b.x, b.y, b.angle, b.radius, color, .65, b.seed);
    allegianceRing(b);
  }
  for (const e of drawOrder) {
    if (!e.alive) continue;
    const color = flockColor(e);
    if (onScreen(e.x, e.y)) glow(e.x, e.y, e.player ? 85 : 50, e.player ? '#d0ef9140' : '#e9827830', .32);
    for (let i = e.boids.length - 1; i >= 0; i--) {
      const b = e.boids[i]; if (!onScreen(b.x, b.y, 20)) continue;
      const alpha = .8 + Math.sin(b.seed) * .13;
      const target = factions.get(b.influenceTarget);
      const birdColor = b.influence > 0 ? mixColor(color, target ? flockColor(target) : colors.gold, b.influence * .9) : color;
      if (e.player && b.linkReach && Math.hypot(b.x - b.linkX, b.y - b.linkY) > b.linkReach * .78) {
        ctx.strokeStyle = colors.gold; ctx.lineWidth = 1; ctx.globalAlpha = .45;
        ctx.setLineDash([3, 5]); ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.linkX, b.linkY); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
      }
      birdTrail(b, birdColor);
      bird(b.x, b.y, b.angle, b.radius, birdColor, alpha, b.seed);
      allegianceRing(b);
      if (e.boosting && i % 3 === 0 && !reducedMotion) {
        ctx.globalAlpha = .16; ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - Math.cos(b.angle) * 17, b.y - Math.sin(b.angle) * 17); ctx.stroke(); ctx.globalAlpha = 1;
      }
    }
    if (!onScreen(e.x, e.y)) continue;
    const shieldAlpha = e.invincible > 0 ? .25 + Math.sin(visualTime * 12) * .12 : .12;
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.globalAlpha = shieldAlpha; ctx.beginPath(); ctx.arc(e.x, e.y, e.radius + 6, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillStyle = e.player ? '#e8f7ba' : color; ctx.beginPath(); ctx.arc(e.x, e.y, e.radius, 0, Math.PI * 2); ctx.fill();
    if (e.boosting || e.gathering) {
      ctx.strokeStyle = e.boosting ? '#f3ebce' : color; ctx.lineWidth = e.boosting ? 2 : 1; ctx.globalAlpha = .75;
      ctx.beginPath(); ctx.arc(e.x, e.y, e.radius + (e.boosting ? 9 : 3), 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
    }
    if (e.player) leaderHeading(e);
    else { ctx.fillStyle = '#153e32'; ctx.beginPath(); ctx.arc(e.x + Math.cos(e.angle) * 5, e.y + Math.sin(e.angle) * 5, 2.6, 0, Math.PI * 2); ctx.fill(); }
    if (!e.player) {
      const action = { roam: '탐색', forage: '먹이 접근', pursue: '진로 차단', regroup: '재결집', recover: '동료 회수', evade: '회피' }[e.intent];
      ctx.font = '10px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = color; ctx.globalAlpha = .8;
      ctx.fillText(game.practice === 'recruitment' ? `직진하는 연습 상대 · ${e.boids.length}마리` : `${TEMPERAMENTS[e.temperament]} · ${action}`, e.x, e.y - 28); ctx.globalAlpha = 1;
    }
  }
  for (const r of game.rings) { ctx.strokeStyle = colors[r.color]; ctx.lineWidth = 1; ctx.globalAlpha = r.life * .45; ctx.beginPath(); ctx.arc(r.x, r.y, Math.max(1, (1 - r.life) * r.max), 0, Math.PI * 2); ctx.stroke(); }
  for (const particle of game.particles) { ctx.fillStyle = colors[particle.color]; ctx.globalAlpha = particle.life * .7; ctx.beginPath(); ctx.arc(particle.x, particle.y, 1.7, 0, Math.PI * 2); ctx.fill(); }
  ctx.globalAlpha = 1;
  if (recruitFocus) {
    const b = recruitFocus;
    ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.lineWidth = 4;
    ctx.strokeStyle = '#102a28'; ctx.fillStyle = colors.lime;
    const label = `합류 중 ${Math.floor(b.influence * 100)}%`;
    ctx.strokeText(label, b.x, b.y - 23); ctx.fillText(label, b.x, b.y - 23);
  }
  ctx.restore(); drawEdgeIndicators(); drawMinimap();
}
function drawEdgeIndicators() {
  if (game.state !== 'playing') return;
  for (const e of game.entities) {
    if (e.player || !e.alive) continue;
    const sx = (e.x - camera.x) * camera.zoom + width / 2, sy = (e.y - camera.y) * camera.zoom + height / 2;
    if (sx > 30 && sx < width - 30 && sy > 100 && sy < height - 85) continue;
    const dist = Math.hypot(e.x - game.player.x, e.y - game.player.y); if (dist > 850) continue;
    const x = clamp(sx, 18, width - 18), y = clamp(sy, 112, height - 100), angle = Math.atan2(sy - height / 2, sx - width / 2);
    bird(x, y, angle, 4, colors.coral, .25 + (1 - dist / 850) * .4);
  }
}
function drawMinimap() {
  map.clearRect(0, 0, 160, 160); const scale = 68 / WORLD_RADIUS;
  map.fillStyle = '#06201e55'; map.strokeStyle = '#7ca78e30'; map.lineWidth = 1;
  map.beginPath(); map.arc(80, 80, 70, 0, Math.PI * 2); map.fill(); map.stroke();
  map.strokeStyle = '#7ca78e13'; map.beginPath(); map.moveTo(10, 80); map.lineTo(150, 80); map.moveTo(80, 10); map.lineTo(80, 150); map.stroke();
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
    while (accumulator >= 1 / 60 && game.state === 'playing') {
      game.update(1 / 60, getInput());
      for (const e of game.entities) if (e.alive) rememberLeader(e, game.elapsed);
      accumulator -= 1 / 60;
    }
    if (toastTimer > 0) { toastTimer -= dt; if (toastTimer <= 0) $('toast').classList.remove('visible'); }
  } else accumulator = 0;
  if (game.state === 'home') drawHome(dt); else drawWorld(game.state === 'playing' ? dt : 0);
  hudTime += dt; if (hudTime > .1 && game.state !== 'home') { updateHUD(); hudTime = 0; }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
