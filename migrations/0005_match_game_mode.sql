ALTER TABLE matches ADD COLUMN game_mode TEXT NOT NULL DEFAULT 'proximo'
  CHECK (game_mode IN ('proximo', 'ttmc'));

ALTER TABLE matches ADD COLUMN rounds INTEGER CHECK (rounds BETWEEN 2 AND 10);
