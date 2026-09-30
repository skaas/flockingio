// Current-match standings: every live commander ranked by the drones it holds right now.
// Presentation only; it never mutates entities or draws from the simulation's random source.
const CALLSIGNS = Object.freeze(['바이퍼', '레이븐', '코브라', '팬텀', '호크', '울프', '스콜피온', '이글']);

// Opponents keep one label for life, derived from their id and never from their rank.
export const commanderCallsign = id => `${CALLSIGNS[id % CALLSIGNS.length]} ${id}`;

// Most drones first; equal fleets keep a fixed order by entity id. Gray strays belong to nobody.
export function fleetStandings(entities, playerName) {
  return entities.filter(e => e.alive && !e.neutral)
    .map(e => ({ id: e.id, player: Boolean(e.player), name: e.player ? playerName : commanderCallsign(e.id), drones: e.boids.length }))
    .sort((a, b) => b.drones - a.drones || a.id - b.id);
}
