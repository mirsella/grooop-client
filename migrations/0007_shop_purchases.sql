CREATE TABLE shop_purchases (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  product_slug TEXT NOT NULL,
  expected_price INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'purchased', 'unknown', 'rejected')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  purchased_at TEXT,
  rejected_at TEXT
);

CREATE UNIQUE INDEX shop_purchases_active_product_claim_idx
  ON shop_purchases (account_id, product_slug)
  WHERE status IN ('pending', 'unknown', 'purchased');
