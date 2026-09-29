export const schema = [
  `CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY, tag TEXT NOT NULL UNIQUE, nickname TEXT NOT NULL,
    token_hash TEXT NOT NULL, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS runs (
    player_id TEXT NOT NULL REFERENCES players(id), run_id TEXT NOT NULL,
    mode TEXT NOT NULL, elapsed_ms INTEGER NOT NULL, max_flock INTEGER NOT NULL,
    kills INTEGER NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (player_id, run_id)
  )`,
  `CREATE TABLE IF NOT EXISTS scores (
    player_id TEXT NOT NULL REFERENCES players(id), mode TEXT NOT NULL,
    elapsed_ms INTEGER NOT NULL, max_flock INTEGER NOT NULL, kills INTEGER NOT NULL,
    achieved_at INTEGER NOT NULL, PRIMARY KEY (player_id, mode)
  )`,
  `CREATE TABLE IF NOT EXISTS score_replays (
    player_id TEXT NOT NULL REFERENCES players(id), mode TEXT NOT NULL,
    run_id TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY (player_id, mode)
  )`,
  `CREATE INDEX IF NOT EXISTS scores_order ON scores(mode, elapsed_ms DESC, max_flock DESC, kills DESC, achieved_at ASC, player_id ASC)`,
];
