import { FLAK_PATTERN_LABELS } from './air-defense.mjs';
import { FIRE_SUPPORT, requestCoordinates, facilityDamage, facilityDurability } from './bombardment.mjs';
import { sprite, explosion } from './sprites.mjs';
const TAU = Math.PI * 2;
// Objective = amber, friendly/cleared = cyan, hostile fire control = red.
const amber = '#efbb77', mint = '#78dcea';

function structure(ctx, kind, damaged = false, damage = 0) {
  const name = ['bunker', 'radar', 'depot'][kind];
  if (sprite(ctx, damaged || damage > .65 ? `${name}Ruined` : name, -42, -42, 84)) {
    if (!damaged) {
      sprite(ctx, 'missileTruck', -76, 0, 26, 42);
      sprite(ctx, 'turret', 48, -35, 24, 48);
      if (kind === 0) sprite(ctx, 'turret', -16, -34, 32, 64);
      else sprite(ctx, 'carrier', 22, 42, 32);
    }
    return;
  }
  ctx.fillStyle = damaged ? '#1c292a' : '#40514b'; ctx.strokeStyle = damaged ? '#5d6050' : '#9b9974'; ctx.lineWidth = 1.5;
  if (kind === 0) {
    for (const x of [-25, 22]) {
      ctx.fillRect(x - 13, -15, 26, 30); ctx.strokeRect(x - 13, -15, 26, 30);
      ctx.beginPath(); ctx.arc(x, 0, 9, 0, TAU); ctx.fill(); ctx.stroke();
      if (!damaged) { ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 12, -31); ctx.stroke(); ctx.lineWidth = 1.5; }
    }
  } else if (kind === 1) {
    for (const [x, y] of [[-29, -22], [5, -22], [-12, 8]]) {
      ctx.fillRect(x, y, 26, 20); ctx.strokeRect(x, y, 26, 20);
      ctx.beginPath(); ctx.moveTo(x + 5, y); ctx.lineTo(x + 5, y + 20); ctx.moveTo(x + 21, y); ctx.lineTo(x + 21, y + 20); ctx.stroke();
    }
  } else {
    ctx.fillRect(-27, -5, 29, 28); ctx.strokeRect(-27, -5, 29, 28);
    ctx.beginPath(); ctx.moveTo(5, 22); ctx.lineTo(17, -30); ctx.lineTo(30, 22); ctx.closePath(); ctx.stroke();
    if (!damaged) { ctx.beginPath(); ctx.arc(17, -27, 15, -.3, Math.PI + .3); ctx.stroke(); }
  }
}

export function drawGroundWar(ctx, game, camera, onScreen, reducedMotion) {
  const war = game.bombardment;
  if (!war.enabled) return;
  ctx.save();
  for (const crater of war.craters) {
    if (!onScreen(crater.x, crater.y, 100)) continue;
    ctx.save(); ctx.translate(crater.x, crater.y);
    ctx.fillStyle = '#071718'; ctx.globalAlpha = .8;
    ctx.beginPath(); ctx.ellipse(0, 0, 56, 40, -.3, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#7b725444'; ctx.lineWidth = 5; ctx.stroke();
    ctx.globalAlpha = .48; structure(ctx, crater.kind, true); ctx.restore();
  }
  for (const r of war.requests) {
    if (!onScreen(r.x, r.y, FIRE_SUPPORT.radius + 60)) continue;
    const complete = r.state === 'complete', active = r.state === 'bombing';
    const color = complete ? mint : amber;
    ctx.save(); ctx.translate(r.x, r.y);
    if (!complete) {
      // Earthworks and hard targets sit below the targeting overlay and drones.
      ctx.fillStyle = '#253632'; ctx.globalAlpha = .75; ctx.fillRect(-61, -48, 122, 96);
      ctx.strokeStyle = '#7f8060'; ctx.lineWidth = 6; ctx.setLineDash([16, 5]); ctx.strokeRect(-61, -48, 122, 96); ctx.setLineDash([]);
      ctx.globalAlpha = 1; structure(ctx, r.kind, false, facilityDamage(r) / facilityDurability(r));
    }
    if (!complete) { ctx.globalAlpha = .7; sprite(ctx, 'focus', -15, -FIRE_SUPPORT.radius + 5, 30); }
    if (!complete) {
      ctx.globalAlpha = active ? .2 : .11; ctx.fillStyle = amber;
      ctx.beginPath(); ctx.arc(0, 0, FIRE_SUPPORT.radius, 0, TAU); ctx.fill();
    }
    const pulse = reducedMotion ? .9 : .8 + Math.sin(game.elapsed * 3) * .12;
    ctx.globalAlpha = complete ? .35 : active ? .9 : pulse;
    ctx.strokeStyle = color; ctx.lineWidth = (active ? 3 : 2) / camera.zoom;
    ctx.setLineDash(active ? [] : [10, 8]);
    ctx.beginPath(); ctx.arc(0, 0, FIRE_SUPPORT.radius, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    if (!complete && r.shots > 0) {
      ctx.fillStyle = '#efbb7708'; ctx.fill(); ctx.lineWidth = 5 / camera.zoom;
      const progress = facilityDamage(r) / facilityDurability(r);
      ctx.beginPath(); ctx.arc(0, 0, FIRE_SUPPORT.radius, -Math.PI / 2, -Math.PI / 2 + TAU * progress); ctx.stroke();
    }
    ctx.globalAlpha = 1; ctx.lineWidth = 1.5 / camera.zoom;
    for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
      ctx.save(); ctx.rotate(angle); ctx.beginPath(); ctx.moveTo(72, -9); ctx.lineTo(72, 9); ctx.moveTo(72, 0); ctx.lineTo(83, 0); ctx.stroke(); ctx.restore();
    }
    // Labels retain screen-space legibility when the flock makes the view wider.
    ctx.save(); ctx.translate(0, -FIRE_SUPPORT.radius - 19 / camera.zoom); ctx.scale(1 / camera.zoom, 1 / camera.zoom);
    ctx.font = '650 13px system-ui'; ctx.textAlign = 'center';
    const label = complete ? `제압 완료 · 좌표 ${requestCoordinates(r)}` : `폭격 목표 · 좌표 ${requestCoordinates(r)}`;
    const w = ctx.measureText(label).width + 18;
    ctx.fillStyle = '#0a1e22ed'; ctx.fillRect(-w / 2, -15, w, 27);
    ctx.fillStyle = color; ctx.fillText(label, 0, 4); ctx.restore();
    if (!complete) {
      ctx.save(); ctx.translate(0, FIRE_SUPPORT.radius + 20 / camera.zoom); ctx.scale(1 / camera.zoom, 1 / camera.zoom);
      ctx.font = '10px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = color;
      ctx.fillText(active ? `드론 폭격 중 · 시설 피해 ${facilityDamage(r)} / ${facilityDurability(r)}` : r.state === 'paused' ? '드론 재진입 시 폭격 재개' : '드론 진입 시 폭격', 0, 0); ctx.restore();
    }
    ctx.restore();
  }
  for (const r of war.requests) {
    if (r.state !== 'bombing' || !onScreen(r.x, r.y, FIRE_SUPPORT.radius + 60)) continue;
    ctx.strokeStyle = '#efbb7730'; ctx.lineWidth = 1; ctx.setLineDash([3, 6]);
    for (const b of war.support(game, r).slice(0, 6)) {
      ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(r.x, r.y); ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  for (const impact of war.impacts) {
    const t = 1 - impact.life / .65;
    ctx.globalAlpha = 1;
    if (!reducedMotion && explosion(ctx, impact.x, impact.y, t, 76)) continue;
    ctx.globalAlpha = (1 - t) * .75; ctx.fillStyle = '#f2d79e';
    ctx.beginPath(); ctx.arc(impact.x, impact.y, reducedMotion ? 12 : 4 + t * 25, 0, TAU); ctx.fill();
    ctx.strokeStyle = amber; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(impact.x, impact.y, 8 + t * 43, 0, TAU); ctx.stroke();
  }
  ctx.restore();
}

export function drawBombs(ctx, game, reducedMotion) {
  ctx.save();
  for (const b of game.bombardment.bombs) {
    // Launch from the drone's recorded release position, even after it moves or is lost.
    const originX = b.x, originY = b.y;
    const arcHeight = Math.min(28, Math.hypot(b.tx - b.x, b.ty - b.y) * .2);
    if (b.age < .15) {
      ctx.strokeStyle = amber; ctx.globalAlpha = (1 - b.age / .15) * .8; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(originX, originY, reducedMotion ? 7 : 5 + b.age * 38, 0, TAU); ctx.stroke();
    }
    const t = Math.min(1, b.age / b.duration), arc = reducedMotion ? 0 : Math.sin(t * Math.PI) * arcHeight;
    const x = originX + (b.tx - originX) * t, y = originY + (b.ty - originY) * t - arc;
    const prev = Math.max(0, t - .16);
    ctx.strokeStyle = '#ffe2a2'; ctx.globalAlpha = .55; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(originX + (b.tx - originX) * prev, originY + (b.ty - originY) * prev - (reducedMotion ? 0 : Math.sin(prev * Math.PI) * arcHeight)); ctx.lineTo(x, y); ctx.stroke();
    ctx.globalAlpha = 1; ctx.fillStyle = '#fff0c9'; ctx.beginPath(); ctx.arc(x, y, 3 - t, 0, TAU); ctx.fill();
  }
  ctx.restore();
}

export function drawAirDefense(ctx, game, camera, reducedMotion) {
  const defense = game.bombardment.defense;
  if (!game.bombardment.enabled || !defense.enabled) return;
  const config = defense.config;
  const state = defense.state, source = game.bombardment.requests.find(r => r.id === defense.sourceId);
  const locked = state === 'locked', firing = state === 'salvo', color = locked || firing ? '#ff5a4a' : '#ff9a7e';
  ctx.save();
  if (source && state !== 'idle' && state !== 'lost') {
    // A physical radar dish at the firing site makes the threat's origin legible.
    ctx.save(); ctx.translate(source.x, source.y);
    ctx.strokeStyle = color; ctx.lineWidth = 1 / camera.zoom; ctx.globalAlpha = .13;
    ctx.setLineDash([4 / camera.zoom, 9 / camera.zoom]);
    ctx.beginPath(); ctx.arc(0, 0, config.range, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    ctx.globalAlpha = .8; ctx.fillStyle = '#172e31';
    ctx.fillRect(-9, -9, 18, 18); ctx.strokeRect(-9, -9, 18, 18);
    ctx.rotate(state === 'tracking' && !reducedMotion ? game.elapsed * 1.7 : Math.atan2(defense.aimY - source.y, defense.aimX - source.x));
    ctx.beginPath(); ctx.arc(0, 0, 7, -1.1, 1.1); ctx.moveTo(0, 0); ctx.lineTo(12, 0); ctx.stroke(); ctx.restore();
    if (state !== 'cooldown') {
      ctx.strokeStyle = color; ctx.globalAlpha = locked ? .48 : .18; ctx.lineWidth = 1 / camera.zoom;
      ctx.setLineDash([5 / camera.zoom, 7 / camera.zoom]);
      ctx.beginPath(); ctx.moveTo(source.x, source.y); ctx.lineTo(defense.aimX, defense.aimY); ctx.stroke(); ctx.setLineDash([]);
    }
  }
  const showReticle = state === 'tracking' || state === 'lost' && !defense.shells.length;
  if (showReticle) {
    const radius = config.blastRadius, z = camera.zoom;
    const pad = state === 'tracking' ? (1 - defense.progress) * 16 / z : 0;
    ctx.save(); ctx.translate(defense.aimX, defense.aimY);
    ctx.globalAlpha = state === 'lost' ? defense.timer / config.lostSeconds * .6 : 1;
    ctx.strokeStyle = state === 'lost' ? mint : color; ctx.lineWidth = 1 / z;
    ctx.fillStyle = '#efbb7705';
    ctx.beginPath(); ctx.arc(0, 0, radius, 0, TAU); ctx.fill();
    const reach = radius + pad, corner = 10 / z;
    for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.beginPath(); ctx.moveTo(x * reach, y * (reach - corner)); ctx.lineTo(x * reach, y * reach);
      ctx.lineTo(x * (reach - corner), y * reach); ctx.stroke();
    }
    ctx.lineWidth = 1 / z; ctx.beginPath(); ctx.moveTo(-5 / z, 0); ctx.lineTo(5 / z, 0);
    ctx.moveTo(0, -5 / z); ctx.lineTo(0, 5 / z); ctx.stroke();
    ctx.font = `600 ${10 / z}px system-ui`; ctx.textAlign = 'center'; ctx.fillStyle = state === 'lost' ? mint : color;
    const label = state === 'lost' ? '추적 해제' : '레이더 추적';
    ctx.strokeStyle = '#10272beb'; ctx.lineWidth = 4 / z;
    ctx.strokeText(label, 0, reach + 16 / z); ctx.fillText(label, 0, reach + 16 / z); ctx.restore();
  }
  {
    const z = camera.zoom, radius = config.blastRadius;
    // Only un-fired destinations and shells still in flight are dangerous.
    // Keep their exact blast footprints visible, even after the site is destroyed.
    const targets = defense.salvo.slice(defense.shotIndex).map((shot, i) => ({ ...shot,
      shot: defense.shotIndex + i + 1, progress: locked ? 1 - defense.timer / config.warningSeconds : 1 }));
    for (const shell of defense.shells) targets.push({ ...shell, progress: shell.age / config.flightSeconds, airborne: true });
    targets.sort((a, b) => a.shot - b.shot);
    // Radial shells burst together on one ring: draw the ring, not a numbered path.
    const radial = defense.pattern === 'radial';
    if (targets.length > 1) {
      ctx.globalAlpha = .4; ctx.strokeStyle = '#ff6a5c'; ctx.lineWidth = 1 / z; ctx.setLineDash([4 / z, 5 / z]);
      ctx.beginPath(); ctx.moveTo(targets[0].tx, targets[0].ty);
      for (const target of targets.slice(1)) ctx.lineTo(target.tx, target.ty);
      if (radial) ctx.closePath();
      ctx.stroke(); ctx.setLineDash([]);
    }
    for (const target of targets) {
      ctx.save(); ctx.translate(target.tx, target.ty);
      ctx.globalAlpha = target.airborne ? 1 : .75; ctx.strokeStyle = '#ff6a5c';
      ctx.fillStyle = target.airborne ? '#ff6e5524' : '#ff6e5510'; ctx.lineWidth = 1 / z;
      ctx.beginPath(); ctx.arc(0, 0, radius, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.lineWidth = 2 / z;
      ctx.beginPath(); ctx.arc(0, 0, radius + 4 / z, -Math.PI / 2, -Math.PI / 2 + TAU * Math.max(0, Math.min(1, target.progress))); ctx.stroke();
      ctx.font = `600 ${11 / z}px system-ui`; ctx.textAlign = 'center'; ctx.fillStyle = '#ffe4d6';
      ctx.strokeStyle = '#10272beb'; ctx.lineWidth = 4 / z;
      if (!radial) { ctx.strokeText(String(target.shot), 0, 4 / z); ctx.fillText(String(target.shot), 0, 4 / z); }
      ctx.restore();
    }
    if (targets.length) {
      ctx.globalAlpha = 1; ctx.font = `600 ${10 / z}px system-ui`; ctx.textAlign = 'center';
      ctx.fillStyle = '#ffac94'; ctx.strokeStyle = '#10272beb'; ctx.lineWidth = 4 / z;
      const solution = FLAK_PATTERN_LABELS[defense.pattern] ?? FLAK_PATTERN_LABELS.predict;
      const label = locked ? `${solution.name} · ${solution.counter}` : '탄착점 회피';
      ctx.strokeText(label, targets[0].tx, targets[0].ty - radius - 14 / z);
      ctx.fillText(label, targets[0].tx, targets[0].ty - radius - 14 / z);
    }
  }
  for (const shell of defense.shells) {
    const t = Math.min(1, shell.age / config.flightSeconds), tail = Math.max(0, t - .25);
    ctx.globalAlpha = 1; ctx.strokeStyle = '#fff0c9'; ctx.lineWidth = 2 / camera.zoom;
    ctx.beginPath(); ctx.moveTo(shell.x + (shell.tx - shell.x) * tail, shell.y + (shell.ty - shell.y) * tail);
    ctx.lineTo(shell.x + (shell.tx - shell.x) * t, shell.y + (shell.ty - shell.y) * t); ctx.stroke();
  }
  for (const burst of defense.bursts) {
    const t = 1 - burst.life / .6, radius = config.blastRadius;
    ctx.globalAlpha = 1;
    if (!reducedMotion && explosion(ctx, burst.x, burst.y, t, radius * 2.6)) continue;
    ctx.globalAlpha = (1 - t) * .8; ctx.fillStyle = t < .2 ? '#ffe8b1' : '#4d4f49';
    ctx.beginPath(); ctx.arc(burst.x, burst.y, reducedMotion ? radius : radius * (.7 + t * .3), 0, TAU); ctx.fill();
    ctx.strokeStyle = '#ffac7b'; ctx.lineWidth = 1.5 / camera.zoom; ctx.stroke();
  }
  ctx.restore();
}
