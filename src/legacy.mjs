// Combat contribution is derived from the simulation, never from time survived.
// Only destroyed facilities and enemy commanders earn contribution.
import { CONTRIBUTION_POINTS } from './rules.mjs';
export const contributionScore = ({ completed = 0, kills = 0 }) =>
  completed * CONTRIBUTION_POINTS.objective + kills * CONTRIBUTION_POINTS.kill;

export function battleContribution(game) {
  const completed = game.bombardment.completed;
  const kills = game.kills;
  return { completed, kills, score: contributionScore({ completed, kills }) };
}

// A sortie ends either when its battle time runs out or when the hero falls.
// Entries saved before outcomes existed were all deaths.
export const MEMORIAL_OUTCOMES = Object.freeze(['completed', 'fallen']);
const emptyMemorial = () => ({ sorties: 0, fallen: 0, total: 0, best: 0, entries: [] });
const natural = value => Number.isSafeInteger(value) && value >= 0;
const validEntry = entry => entry && typeof entry.runId === 'string' && typeof entry.name === 'string'
  && natural(entry.score) && natural(entry.completed) && natural(entry.kills) && Number.isFinite(entry.elapsed) && entry.elapsed >= 0
  && (entry.outcome === undefined || MEMORIAL_OUTCOMES.includes(entry.outcome));
const withOutcome = entry => ({ ...entry, outcome: entry.outcome ?? 'fallen' });

// Keep names as they were on each sortie. Storage failure still preserves this visit.
export class Memorial {
  constructor(storage, playerId) {
    this.storage = storage; this.key = `fallen-heroes-memorial-v1:${playerId}`;
    this.data = emptyMemorial(); this.persistent = Boolean(storage);
    try {
      const saved = JSON.parse(storage?.getItem(this.key) ?? 'null');
      if (saved && natural(saved.fallen) && natural(saved.total) && natural(saved.best) && Array.isArray(saved.entries)) {
        // Older records counted only deaths, so their death count is also their sortie count.
        const sorties = natural(saved.sorties) ? Math.max(saved.sorties, saved.fallen) : saved.fallen;
        this.data = { sorties, fallen: saved.fallen, total: saved.total, best: saved.best,
          entries: saved.entries.filter(validEntry).slice(0, 50).map(withOutcome) };
      }
    } catch { this.persistent = false; }
  }
  record(entry) {
    if (!validEntry(entry) || this.data.entries.some(item => item.runId === entry.runId)) return false;
    const saved = withOutcome(entry);
    this.data = { sorties: this.data.sorties + 1, fallen: this.data.fallen + (saved.outcome === 'fallen' ? 1 : 0),
      total: this.data.total + saved.score, best: Math.max(this.data.best, saved.score),
      entries: [saved, ...this.data.entries].slice(0, 50) };
    try { this.storage.setItem(this.key, JSON.stringify(this.data)); }
    catch { this.persistent = false; }
    return true;
  }
}
