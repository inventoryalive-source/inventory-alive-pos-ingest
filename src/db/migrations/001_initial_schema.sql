-- =============================================================
-- Inventory Alive POS Ingest — Initial Schema Migration
-- Target: Neon Postgres (Postgres 15+)
-- Run once against your Neon database.
-- =============================================================

-- ---------------------------------------------------------------
-- Enable pgcrypto for gen_random_uuid() if not already available
-- (Postgres 13+ has it built-in via the core gen_random_uuid())
-- ---------------------------------------------------------------

-- ---------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id TEXT        NOT NULL UNIQUE,   -- e.g. "tnt_123"
    name        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenants_external_id ON tenants(external_id);

-- ---------------------------------------------------------------
-- locations
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS locations (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id TEXT        NOT NULL UNIQUE,   -- e.g. "loc_abc"
    tenant_id   UUID        REFERENCES tenants(id) ON DELETE CASCADE,
    name        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_locations_external_id ON locations(external_id);
CREATE INDEX IF NOT EXISTS idx_locations_tenant_id   ON locations(tenant_id);

-- ---------------------------------------------------------------
-- pos_events
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pos_events (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Routing / source identifiers (kept as raw strings for decoupled ingestion)
    tenant_id           TEXT        NOT NULL,
    location_id         TEXT        NOT NULL,
    provider            TEXT        NOT NULL,   -- "toast", "square", etc.

    -- Event identifiers
    external_event_id   TEXT        NOT NULL,
    event_type          TEXT        NOT NULL,   -- "SALE", "VOID", "REFUND", etc.
    external_order_id   TEXT,

    -- Financials
    currency            CHAR(3),
    subtotal            NUMERIC(12, 4),
    tax                 NUMERIC(12, 4),
    tip                 NUMERIC(12, 4),
    total               NUMERIC(12, 4),

    -- Timestamps
    occurred_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Processing
    process_status      TEXT        NOT NULL DEFAULT 'pending',
    processed_at        TIMESTAMPTZ,

    -- Full original payload for audit / reprocessing
    raw_event           JSONB       NOT NULL,

    -- Idempotency: one event per (tenant, location, provider, external id)
    CONSTRAINT uq_pos_events_idempotency
        UNIQUE (tenant_id, location_id, provider, external_event_id)
);

CREATE INDEX IF NOT EXISTS idx_pos_events_tenant_location  ON pos_events(tenant_id, location_id);
CREATE INDEX IF NOT EXISTS idx_pos_events_provider         ON pos_events(provider);
CREATE INDEX IF NOT EXISTS idx_pos_events_process_status   ON pos_events(process_status);
CREATE INDEX IF NOT EXISTS idx_pos_events_occurred_at      ON pos_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_pos_events_raw_event        ON pos_events USING GIN (raw_event);

-- ---------------------------------------------------------------
-- pos_event_lines
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pos_event_lines (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    pos_event_id      UUID        NOT NULL REFERENCES pos_events(id) ON DELETE CASCADE,

    external_line_id  TEXT        NOT NULL,
    external_item_id  TEXT,
    name              TEXT,
    quantity          NUMERIC(10, 4) NOT NULL DEFAULT 1,
    unit_price        NUMERIC(12, 4) NOT NULL DEFAULT 0,
    line_total        NUMERIC(12, 4) GENERATED ALWAYS AS (quantity * unit_price) STORED,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_pos_event_lines_idempotency
        UNIQUE (pos_event_id, external_line_id)
);

CREATE INDEX IF NOT EXISTS idx_pos_event_lines_pos_event_id  ON pos_event_lines(pos_event_id);
CREATE INDEX IF NOT EXISTS idx_pos_event_lines_external_item ON pos_event_lines(external_item_id);
