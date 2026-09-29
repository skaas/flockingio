// One supported simulation and recording format. Increment when replay-affecting
// behavior or the fingerprint changes; old recordings do not select old engines.
export const RULES_VERSION = 15;
export const SIMULATION_STEP = 1 / 60;
export const WORLD_RADIUS = 1450;
export const CONTRIBUTION_POINTS = Object.freeze({ objective: 1000, kill: 200 });
export const FLEET = Object.freeze({ initial: 4, max: 16, reinforcement: 2, reinforcementLevels: 6, enemySalvageCost: 12 });
export const DRONE_ATTACK = Object.freeze({ base: 10, perLevel: 5, maxLevel: 5, interval: .88 });
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
export const HEAD_GROWTH = Object.freeze({ baseRadius: 11, perLevel: .1, maxScale: 4, seconds: 1 });
export const CHALLENGE_PHASES = Object.freeze([0, 15, 30, 50, 75, 110]);
export const FLIGHT = Object.freeze({ turnRate: 1.2, maxTurnRate: 1.8, turnAcceleration: 2.4, thrust: 90, braking: 110, boostMultiplier: 3.5 });
