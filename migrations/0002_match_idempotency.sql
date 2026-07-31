ALTER TABLE matches ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX matches_idempotency_key_idx
  ON matches (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
