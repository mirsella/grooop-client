CREATE TABLE observed_questions_backup AS
SELECT id, fingerprint, content_slug, category, question, answer, first_match_id, first_seen_at
FROM observed_questions;

DROP TABLE observed_questions;

CREATE TABLE matches_next (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (
    status IN ('setup', 'creating', 'joining', 'waiting', 'playing', 'revealed', 'finished', 'error')
  ),
  host_account_id TEXT NOT NULL REFERENCES accounts(id),
  guest_account_id TEXT NOT NULL REFERENCES accounts(id),
  team_a_json TEXT NOT NULL,
  team_b_json TEXT NOT NULL,
  game_mode TEXT NOT NULL CHECK (game_mode IN ('proximo', 'ttmc')),
  content_slug TEXT,
  duration_minutes INTEGER,
  rounds INTEGER,
  party_id INTEGER,
  party_code_ciphertext TEXT,
  party_code_nonce TEXT,
  party_code_key_version TEXT,
  game_id INTEGER,
  cost INTEGER,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  idempotency_key TEXT,
  request_fingerprint TEXT,
  CHECK (
    (game_mode = 'proximo' AND content_slug IS NOT NULL AND duration_minutes BETWEEN 5 AND 60 AND rounds IS NULL)
    OR
    (game_mode = 'ttmc' AND content_slug IS NULL AND duration_minutes IS NULL AND rounds BETWEEN 2 AND 10)
  )
);

INSERT INTO matches_next (
  id, status, host_account_id, guest_account_id, team_a_json, team_b_json,
  game_mode, content_slug, duration_minutes, rounds, party_id,
  party_code_ciphertext, party_code_nonce, party_code_key_version, game_id,
  cost, error_code, created_at, updated_at, finished_at, idempotency_key,
  request_fingerprint
)
SELECT
  id, status, host_account_id, guest_account_id, team_a_json, team_b_json,
  game_mode,
  CASE WHEN game_mode = 'proximo' THEN content_slug END,
  CASE WHEN game_mode = 'proximo' THEN duration_minutes END,
  CASE WHEN game_mode = 'ttmc' THEN rounds END,
  party_id, party_code_ciphertext, party_code_nonce, party_code_key_version,
  game_id, cost, error_code, created_at, updated_at, finished_at,
  idempotency_key, request_fingerprint
FROM matches;

DROP TABLE matches;
ALTER TABLE matches_next RENAME TO matches;

CREATE INDEX matches_status_idx ON matches (status);
CREATE UNIQUE INDEX matches_idempotency_key_idx
  ON matches (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX matches_single_nonterminal_idx
  ON matches ((1))
  WHERE status IN ('creating', 'joining', 'waiting', 'playing', 'revealed')
     OR (status = 'error' AND error_code = 'party-create-outcome-unknown');

CREATE TABLE observed_questions (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  content_slug TEXT NOT NULL,
  category TEXT,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  first_match_id TEXT NOT NULL REFERENCES matches(id),
  first_seen_at TEXT NOT NULL
);

INSERT INTO observed_questions (
  id, fingerprint, content_slug, category, question, answer, first_match_id, first_seen_at
)
SELECT id, fingerprint, content_slug, category, question, answer, first_match_id, first_seen_at
FROM observed_questions_backup;

DROP TABLE observed_questions_backup;
