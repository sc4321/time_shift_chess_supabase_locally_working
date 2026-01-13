export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  rating INTEGER NOT NULL DEFAULT 1200,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,              -- 'solo' | 'team'
  time_control_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  result TEXT,                     -- 'white' | 'black' | 'draw'
  termination TEXT                 -- 'checkmate' | 'timeout' | 'resign'
);

CREATE TABLE IF NOT EXISTS match_players (
  match_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  color TEXT NOT NULL,             -- 'w' | 'b'
  board_role INTEGER,              -- 1/2/3 for team mode, NULL for solo
  team_index INTEGER NOT NULL,     -- 1 for white, 2 for black (convenience)
  PRIMARY KEY (match_id, user_id),
  FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rating_history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  match_id TEXT NOT NULL,
  old_rating INTEGER NOT NULL,
  new_rating INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
);
`;