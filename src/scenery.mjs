import { sprite } from './sprites.mjs';
// Terrain and abandoned earthworks stay fixed in world space and never consume
// simulation randomness. Live objectives are drawn separately.
const TAU = Math.PI * 2;
function noise(x, y, salt = 0) {
  const n = Math.sin(x * 127.1 + y * 311.7 + salt * 74.7) * 43758.5453;
  return n - Math.floor(n);
}
function contour(radius, phase, scale = 1) {
  const path = new Path2D();
  for (let i = 0; i <= 48; i++) {
    const a = i / 48 * TAU;
    const r = radius * scale * (1 + Math.sin(a * 3 + phase) * .15 + Math.sin(a * 5 - phase) * .07);
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
  }
  path.closePath(); return path;
}

export class Scenery {
  constructor(radius) {
    this.landmarks = []; this.haze = []; this.dust = [];
    const cells = Math.ceil(radius / 330);
    for (let y = -cells; y < cells; y++) for (let x = -cells; x < cells; x++) {
      const size = 80 + noise(x, y, 1) * 76, phase = noise(x, y, 2) * TAU;
      this.landmarks.push({
        x: (x + .5) * 330 + (noise(x, y, 3) - .5) * 120,
        y: (y + .5) * 330 + (noise(x, y, 4) - .5) * 120,
        angle: phase, aspect: .55 + noise(x, y, 5) * .4,
        size, paths: [1, .76, .53].map(scale => contour(size, phase, scale)),
      });
    }
    for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) {
      this.haze.push({ x: x * 640 + noise(x, y, 6) * 250, y: y * 640 + noise(x, y, 7) * 250,
        size: 250 + noise(x, y, 8) * 170, angle: noise(x, y, 9) * TAU });
    }
    const specks = Math.ceil(radius * 1.35 / 98);
    for (let y = -specks; y < specks; y++) for (let x = -specks; x < specks; x++) {
      this.dust.push({ x: (x + noise(x, y, 10)) * 98, y: (y + noise(x, y, 11)) * 98,
        size: .65 + noise(x, y, 12) * .65, alpha: .18 + noise(x, y, 13) * .15 });
    }
  }
  draw(ctx, camera, width, height, motion, reducedMotion) {
    const zoom = camera.zoom;
    const visible = (p, depth, pad) => Math.abs((p.x - camera.x * depth) * zoom) < width / 2 + pad * zoom &&
      Math.abs((p.y - camera.y * depth) * zoom) < height / 2 + pad * zoom;
    const layer = depth => {
      ctx.save(); ctx.translate(width / 2, height / 2); ctx.scale(zoom, zoom);
      ctx.translate(-camera.x * depth, -camera.y * depth);
    };

    // Distant broad patches move slowly; their edges stay diffuse and quiet.
    layer(.42);
    for (const p of this.haze) {
      if (!visible(p, .42, p.size * 1.6)) continue;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.angle); ctx.scale(1.5, .7);
      const fill = ctx.createRadialGradient(0, 0, p.size * .15, 0, 0, p.size);
      fill.addColorStop(0, '#30615e'); fill.addColorStop(1, '#30615e00');
      ctx.fillStyle = fill; ctx.globalAlpha = .16;
      ctx.fillRect(-p.size, -p.size, p.size * 2, p.size * 2); ctx.restore();
    }
    ctx.restore();

    // The ground is a one-to-one reference for distance and turns. Returning to
    // a location reveals exactly the same shapes, including after camera zooms.
    layer(1);
    ctx.strokeStyle = '#64705b'; ctx.globalAlpha = .15; ctx.lineWidth = 16;
    for (let road = -3; road <= 3; road++) {
      ctx.beginPath(); ctx.moveTo(-2300, road * 510 - 320); ctx.lineTo(0, road * 510 + 40); ctx.lineTo(2300, road * 510 - 180); ctx.stroke();
    }
    for (const p of this.landmarks) {
      if (!visible(p, 1, p.size * 1.3)) continue;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.angle); ctx.scale(1, p.aspect);
      ctx.fillStyle = '#183d40'; ctx.globalAlpha = .42; ctx.fill(p.paths[0]);
      ctx.fillStyle = '#1d4647'; ctx.globalAlpha = .18; ctx.fill(p.paths[1]);
      ctx.strokeStyle = '#548d88'; ctx.lineWidth = 1 / Math.max(.55, zoom);
      for (let i = 0; i < p.paths.length; i++) { ctx.globalAlpha = .26 - i * .055; ctx.stroke(p.paths[i]); }
      // Off-center rock marks give each patch a recognizable orientation.
      ctx.strokeStyle = '#6c9992'; ctx.globalAlpha = .23;
      ctx.beginPath(); ctx.moveTo(-p.size * .17, p.size * .1); ctx.lineTo(p.size * .06, p.size * .2);
      ctx.lineTo(p.size * .21, p.size * .07); ctx.stroke(); ctx.restore();
      ctx.save(); ctx.translate(p.x + p.size * .35, p.y); ctx.rotate(p.angle);
      ctx.strokeStyle = '#8a8868'; ctx.globalAlpha = .24; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(-45, -8); ctx.lineTo(-23, -8); ctx.lineTo(-23, 4); ctx.lineTo(3, 4); ctx.lineTo(3, -8); ctx.lineTo(33, -8); ctx.stroke();
      ctx.fillStyle = '#101e20'; ctx.globalAlpha = .5;
      ctx.beginPath(); ctx.ellipse(45, 38, 18, 13, .3, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#847a58'; ctx.lineWidth = 2; ctx.globalAlpha = .2; ctx.stroke(); ctx.restore();
    }
    // The abandoned airfield and scattered outposts are fixed world landmarks.
    ctx.globalAlpha = .32; sprite(ctx, 'airport', -520, -520, 1040);
    for (let i = 0; i < this.landmarks.length; i++) {
      const p = this.landmarks[i];
      if (i % 3 || !visible(p, 1, 100) || Math.hypot(p.x, p.y) < 550) continue;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(Math.round(p.angle / (Math.PI / 2)) * Math.PI / 2);
      ctx.globalAlpha = .62; sprite(ctx, i % 2 ? 'hangarRuined' : 'depot', -42, -42, 84);
      ctx.globalAlpha = .45; sprite(ctx, 'carrier', 52, 15, 30); ctx.restore();
    }
    ctx.restore();

    // Nearby motes cross the view faster. Streaks use actual camera travel, so
    // they reverse along a turn rather than always pointing away from the head.
    const depth = reducedMotion ? 1 : 1.28;
    const speed = Math.hypot(motion.x, motion.y);
    const exposure = reducedMotion ? 0 : Math.min(.075, Math.max(0, (speed - 45) / 180) * .075);
    const tailX = motion.x * depth * exposure, tailY = motion.y * depth * exposure;
    layer(depth); ctx.lineCap = 'round'; ctx.strokeStyle = '#83aaa6'; ctx.fillStyle = '#83aaa6';
    for (const p of this.dust) {
      if (!visible(p, depth, 30)) continue;
      ctx.globalAlpha = p.alpha;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.fill();
      if (exposure > .003) {
        ctx.globalAlpha = p.alpha * .6; ctx.lineWidth = .85;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + tailX, p.y + tailY); ctx.stroke();
      }
    }
    ctx.restore();
  }
}
