DELETE FROM login_challenges;

DROP INDEX login_challenges_email_hash_idx;

CREATE UNIQUE INDEX login_challenges_email_hash_idx
  ON login_challenges (email_hash);
