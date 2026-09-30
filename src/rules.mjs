// One supported simulation and recording format. Increment when replay-affecting
// behavior or the fingerprint changes; old recordings do not select old engines.
export const RULES_VERSION = 19;
export const SIMULATION_STEP = 1 / 60;
export const WORLD_RADIUS = 1450;
export const CONTRIBUTION_POINTS = Object.freeze({ objective: 1000, kill: 200 });
export const FLEET = Object.freeze({ initial: 4, max: 16, reinforcement: 4, reinforcementLevels: 3, enemySalvageCost: 12 });
// Each weapon card is a single pick that doubles sustained fleet damage.
export const DRONE_ATTACK = Object.freeze({ base: 10, perLevel: 10, maxLevel: 1, interval: .88, salvoMaxLevel: 1, reloadMaxLevel: 1 });
// Each utility card is a single pick that applies four former upgrade levels.
export const UTILITY_UPGRADE = Object.freeze({ max: 1, effectLevels: 4 });
export const FIRE_SUPPORT = Object.freeze({
  radius: 120, durability: 100, durabilityStep: 40, durabilityEvery: 3, maxDurability: 220,
  requestCount: 1, replacementSeconds: 2.8,
});
export const AIR_DEFENSE = Object.freeze({
  range: 300, releaseRange: 340, trackSpeed: 135, trackTolerance: 60,
  acquireSeconds: 2.4, warningSeconds: 1, reloadSeconds: 2.8,
  flightSeconds: .65, blastRadius: 36, lostSeconds: .8, overflightRadius: 135,
  salvoCount: 3, salvoInterval: .36, salvoSpread: 18,
  // Turn solutions assume the commander keeps turning after a short reaction; the
  // radial ring holds the commander's current range from the battery.
  turnPrediction: 1, turnDelay: .4, radialSpacing: 80, radialMin: 8, radialMax: 16,
});
export const EVOLUTION_XP_MULTIPLIER = 3;
// Parts needed for each successive upgrade pick in every mode. Index 0 is the
// level 1 pick; picks beyond the table keep its last cost.
export const UPGRADE_COSTS = Object.freeze([12, 18, 24, 36, 48, 66, 84, 108, 132, 162, 192]);
export const upgradeCost = level => UPGRADE_COSTS[Math.max(0, Math.min(UPGRADE_COSTS.length - 1, (Math.floor(level) || 1) - 1))];
// Capped growth keeps upgrade picks from being punished by a much larger collision body.
export const HEAD_GROWTH = Object.freeze({ baseRadius: 11, perLevel: .1, maxScale: 1.6, seconds: 1 });
export const FLIGHT = Object.freeze({ turnRate: 1.2, maxTurnRate: 1.8, turnAcceleration: 2.4, thrust: 90, braking: 110, boostMultiplier: 3.5 });
// Enemy boost is a short, readable burst after a visible windup; later pressure comes from count and flak.
export const ENEMY_FLIGHT = Object.freeze({ thrust: 45, boostMultiplier: 1.35, boostWindup: .8 });
// The challenge sortie is five minutes of battle time. Phase i starts at
// CHALLENGE_PHASES[i] and reads SORTIE_BALANCE[i]; nothing depends on the player's
// build, level or kills. enemyCap counts living enemy flocks, never the player.
export const SORTIE_DURATION = 300;
// Objective interception waits this long, protecting the first reward loop.
export const SORTIE_INTERCEPT_DELAY = 20;
export const CHALLENGE_PHASES = Object.freeze([0, 45, 90, 150, 210, 255]);
export const FLAK_PATTERN_IDS = Object.freeze(['predict', 'left', 'right', 'radial']);
const SORTIE_COLUMNS = {
  enemyCap: [2, 3, 4, 5, 6, 7],
  minDrones: [2, 3, 3, 4, 5, 6],
  maxDrones: [3, 4, 5, 6, 7, 8],
  spawnSeconds: [10, 8, 6.5, 5.5, 4.5, 3.5],
  acquireSeconds: [3.2, 2.9, 2.6, 2.3, 2, 1.8],
  warningSeconds: [1.4, 1.3, 1.2, 1.15, 1.1, 1],
  reloadSeconds: [4, 3.8, 3.5, 3.2, 2.9, 2.6],
  // Objective HP follows elapsed time only. Late batteries must outlast several
  // releases of a fully upgraded 16-drone fleet (640 per volley) instead of vanishing
  // in one; each site snapshots its row when spawned and never heals or rescales.
  durability: [160, 480, 1200, 2400, 4000, 6000],
  reward: [24, 30, 33, 36, 42, 45],
  patterns: [['predict'], ['predict', 'left'], ['predict', 'left', 'right'], FLAK_PATTERN_IDS, FLAK_PATTERN_IDS, FLAK_PATTERN_IDS],
};
export const SORTIE_BALANCE = Object.freeze(CHALLENGE_PHASES.map((start, phase) => Object.freeze({
  phase, start, ...Object.fromEntries(Object.entries(SORTIE_COLUMNS).map(([key, values]) =>
    [key, Array.isArray(values[phase]) ? Object.freeze([...values[phase]]) : values[phase]])),
})));
export const sortiePhase = phase => SORTIE_BALANCE[Math.max(0, Math.min(SORTIE_BALANCE.length - 1, Math.floor(phase) || 0))];
export const challengePhaseAt = elapsed => CHALLENGE_PHASES.reduce((phase, time, index) => elapsed >= time ? index : phase, 0);
