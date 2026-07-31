ALTER TABLE matches ADD COLUMN request_fingerprint TEXT;

CREATE UNIQUE INDEX matches_single_nonterminal_idx
  ON matches ((1))
  WHERE status IN ('creating', 'joining', 'waiting', 'playing', 'revealed')
     OR (status = 'error' AND error_code = 'party-create-outcome-unknown');
