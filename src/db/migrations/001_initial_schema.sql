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
    name        TEXT,
    deleted_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------
-- locations
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS locations (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID        REFERENCES tenants(id) ON DELETE CASCADE,
    name        TEXT,
    deleted_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
    occurred_at         TIMESTAMPTZ NOT NULL,
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
    tenant_id         TEXT        NOT NULL,

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
CREATE INDEX IF NOT EXISTS idx_pos_event_lines_tenant_id     ON pos_event_lines(tenant_id);
CREATE INDEX IF NOT EXISTS idx_pos_event_lines_external_item ON pos_event_lines(external_item_id);

-- ---------------------------------------------------------------
-- users
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    email          TEXT        NOT NULL UNIQUE,
    name           TEXT,
    password_hash  TEXT,
    deleted_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------
-- tenant_memberships
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_memberships (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT        NOT NULL,   -- e.g. 'owner', 'admin', 'member'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_tenant_memberships_tenant_user UNIQUE (tenant_id, user_id),
    CONSTRAINT chk_tenant_memberships_role CHECK (role IN ('platform_admin', 'tenant_admin', 'staff', 'read_only'))
);

CREATE INDEX IF NOT EXISTS idx_tenant_memberships_tenant_id ON tenant_memberships(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_memberships_user_id   ON tenant_memberships(user_id);

-- ---------------------------------------------------------------
-- inventory_items
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_items (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    location_id        UUID        NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    external_item_id   TEXT        NOT NULL,
    name               TEXT,
    sku                TEXT,
    unit_cost          NUMERIC(12, 4),
    quantity_on_hand   NUMERIC(10, 4) DEFAULT 0,
    deleted_at         TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_inventory_items_tenant_external_item UNIQUE (tenant_id, external_item_id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_items_tenant_id    ON inventory_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_location_id ON inventory_items(location_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_sku         ON inventory_items(sku);

-- ---------------------------------------------------------------
-- inventory_events
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_events (
    id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    inventory_item_id      UUID        NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    event_type             TEXT        NOT NULL,   -- e.g. 'sale', 'restock', 'adjustment', 'void'
    quantity_delta         NUMERIC(10, 4) NOT NULL,
    quantity_after         NUMERIC(10, 4),
    source_pos_event_id    UUID        REFERENCES pos_events(id) ON DELETE SET NULL,
    occurred_at            TIMESTAMPTZ NOT NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_inventory_events_event_type CHECK (event_type IN ('sale', 'restock', 'adjustment', 'void', 'refund'))
);

CREATE INDEX IF NOT EXISTS idx_inventory_events_tenant_id         ON inventory_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_inventory_events_inventory_item_id ON inventory_events(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_events_occurred_at       ON inventory_events(occurred_at);

-- ---------------------------------------------------------------
-- audit_logs
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      TEXT,
    actor_id       TEXT,   -- user or system that made the change
    action         TEXT        NOT NULL,   -- e.g. 'create', 'update', 'delete'
    resource_type  TEXT        NOT NULL,   -- e.g. 'pos_event', 'inventory_item'
    resource_id    TEXT,
    payload        JSONB,   -- before/after snapshot
    ip_address     TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_id      ON audit_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_id       ON audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource_type  ON audit_logs(resource_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at     ON audit_logs(created_at);

-- ---------------------------------------------------------------
-- Column comments (decoupled ingestion)
-- ---------------------------------------------------------------
COMMENT ON COLUMN pos_events.tenant_id IS
    'External tenant identifier as TEXT (not tenants.id UUID) so ingest can accept payloads before tenant rows exist; stays decoupled from core tenant registry.';

-- ---------------------------------------------------------------
-- sku_mappings
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sku_mappings (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          TEXT        NOT NULL,
    external_item_id   TEXT        NOT NULL,   -- POS item ID
    sku                TEXT        NOT NULL,   -- internal inventory SKU
    provider           TEXT        NOT NULL,   -- e.g. 'toast', 'square'
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_sku_mappings_tenant_provider_external_item
        UNIQUE (tenant_id, provider, external_item_id)
);

CREATE INDEX IF NOT EXISTS idx_sku_mappings_tenant_id ON sku_mappings(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sku_mappings_sku       ON sku_mappings(sku);

-- ---------------------------------------------------------------
-- scanner_usage
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scanner_usage (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     TEXT        NOT NULL,
    period_start  TIMESTAMPTZ NOT NULL,   -- start of quota period
    period_end    TIMESTAMPTZ NOT NULL,   -- end of quota period
    scans_used    INTEGER     NOT NULL DEFAULT 0 CHECK (scans_used >= 0),
    scans_quota   INTEGER     NOT NULL DEFAULT 100 CHECK (scans_quota > 0),   -- per-tenant limit
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_scanner_usage_tenant_period_start
        UNIQUE (tenant_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_scanner_usage_tenant_id ON scanner_usage(tenant_id);
