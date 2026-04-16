-- FINANCE ALIVE — Neon Postgres Schema
-- Assets Alive LLC | Tax Shield Architecture

CREATE TYPE transaction_type AS ENUM (
  'owner_contribution',
  'revenue',
  'inter_entity_transfer'
);

CREATE TYPE brand_id AS ENUM (
  'assets_alive',
  'pipeline_alive',
  'inventory_alive'
);

CREATE TYPE transaction_status AS ENUM (
  'pending',
  'cleared',
  'reconciled',
  'voided'
);

CREATE TABLE transactions (
  id                  UUID            PRIMARY KEY DLT gen_random_uuid(),
  brand_id            brand_id        NOT NULL,
  transaction_type    transaction_type NOT NULL,
  amount              NUMERIC(12, 2)  NOT NULL CHECK (amount > 0),
  tax_ghost_reserve   NUMERIC(12, 2)  GENERATED ALWAYS AS (
    CASE WHEN transaction_type = 'revenue' THEN ROUND(amount * 0.30, 2) ELSE NULL END
  ) STORED,
  is_taxable_income   BOOLEAN GENERATED ALWAYS AS (
    transaction_type = 'revenue'
  ) STORED,
  description         TEXT,
  memo                TEXT,
  reference_id        VARCHAR(100),
  source_brand        brand_id,
  destination_brand   brand_id,
  equity_account      VARCHAR(100)    DEFAULT 'managing_member_equity',
  transacted_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  status              transaction_status NOT NULL DEFAULT 'pending',
  CONSTRAINT no_equity_as_revenue CHECK (
    NOT (transaction_type = 'owner_contribution' AND is_taxable_income = TRUE)
  ),
  CONSTRAINT transfer_requires_both_brands CHECK (
    transaction_type != 'inter_entity_transfer'
    OR (source_brand IS NOT NULL AND destination_brand IS NOT NULL)
  ),
  CONSTRAINT no_self_transfer CHECK (
    source_brand IS DISTINCT FROM destination_brand
  )
);

CREATE VIEW tax_summary AS
SELECT
  brand_id,
  DATE_TRUNC('month', transacted_at) AS period,
  SUM(amount) FILTER (WHERE transaction_type = 'revenue') AS gross_revenue,
  SUM(tax_ghost_reserve) AS total_tax_reserve,
  SUM(amount - COALESCE(tax_ghost_reserve, 0)) FILTER (WHERE transaction_type = 'revenue') AS net_revenue_after_reserve,
  SUM(amount) FILTER (WHERE transaction_type = 'owner_contribution') AS equity_contributions,
  SUM(amount) FILTER (WHERE transaction_type = 'inter_entity_transfer') AS internal_transfers,
  COUNT(*) FILTER (WHERE transaction_type = 'revenue') AS revenue_tx_count,
  COUNT(*) FILTER (WHERE transaction_type = 'owner_contribution') AS contribution_count
FROM transactions
WHERE status != 'voided'
GROUP BY brand_id, DATE_TRUNC('month', transacted_at);

CREATE VIEW equity_ledger AS
SELECT id, brand_id, amount, description, memo, equity_account, transacted_at, status
FROM transactions
WHERE transaction_type = 'owner_contribution'
ORDER BY transacted_at DESC;

CREATE INDEX idx_transactions_brand_id      ON transactions (brand_id);
CREATE INDEX idx_transactions_type          ON transactions (transaction_type);
CREATE INDEX idx_transactions_brand_type    ON transactions (brand_id, transaction_type);
CREATE INDEX idx_transactions_taxable       ON transactions (is_taxable_income) WHERE is_taxable_income = TRUE;
CREATE INDEX idx_transactions_transacted_at ON transactions (transacted_at DESC);

ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY brand_isolation ON transactions
  USING (brand_id = current_setting('app.current_brand')::brand_id);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER transactions_updated_at
  BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
