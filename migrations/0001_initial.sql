CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email_ciphertext TEXT NOT NULL,
  email_nonce TEXT NOT NULL,
  email_key_version TEXT NOT NULL,
  email_hash TEXT NOT NULL UNIQUE,
  email_masked TEXT NOT NULL,
  session_ciphertext TEXT NOT NULL,
  session_nonce TEXT NOT NULL,
  session_key_version TEXT NOT NULL,
  grooop_user_id INTEGER NOT NULL UNIQUE,
  grooopies INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('active', 'reauth-required')),
  validated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE login_challenges (
  id TEXT PRIMARY KEY,
  email_ciphertext TEXT NOT NULL,
  email_nonce TEXT NOT NULL,
  email_key_version TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX login_challenges_email_hash_idx
  ON login_challenges (email_hash);

CREATE TABLE team_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  roster_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE matches (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (
    status IN ('setup', 'creating', 'joining', 'waiting', 'playing', 'revealed', 'finished', 'error')
  ),
  host_account_id TEXT NOT NULL REFERENCES accounts(id),
  guest_account_id TEXT NOT NULL REFERENCES accounts(id),
  team_a_json TEXT NOT NULL,
  team_b_json TEXT NOT NULL,
  content_slug TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  party_id INTEGER,
  party_code_ciphertext TEXT,
  party_code_nonce TEXT,
  party_code_key_version TEXT,
  game_id INTEGER,
  cost INTEGER,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX matches_status_idx ON matches (status);

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
