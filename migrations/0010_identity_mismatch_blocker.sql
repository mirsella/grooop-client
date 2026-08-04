DROP INDEX matches_single_nonterminal_idx;

CREATE UNIQUE INDEX matches_single_nonterminal_idx
  ON matches ((1))
  WHERE status IN ('creating', 'joining', 'waiting', 'playing', 'revealed')
     OR (status = 'error' AND error_code IN ('party-create-outcome-unknown', 'party-identity-mismatch'));
