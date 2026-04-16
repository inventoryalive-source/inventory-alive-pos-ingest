-- =============================================================
-- 002 — Security & performance hardening (composite FKs, RLS,
--        memberships, indexes, updated_at triggers, quotas)
-- Apply after 001_initial_schema.sql
-- =============================================================

BEGIN;

-- ----------------------------------------------------------------
-- Cross-tenant FK hardening: composite (id, tenant_id) on pos_events
-- and composite FK from pos_event_lines
-- ----------------------------------------------------------------
ALTER TABLE pos_event_lines
  DROP CONSTRAINT IF EXISTS pos_event_lines_pos_event_id_fkey;

ALTER TABLE pos_events
  DROP CONSTRAINT IF EXISTS uq_pos_events_id_tenant;

ALTER TABLE pos_events
  ADD CONSTRAINT uq_pos_events_id_tenant UNIQUE (id, tenant_id);

ALTER TABLE pos_event_lines
  ADD CONSTRAINT fk_pos_event_lines_pos_event_tenant
    FOREIGN KEY (pos_event_id, tenant_id)
    REFERENCES pos_events (id, tenant_id)
    ON DELETE CASCADE;

-- ----------------------------------------------------------------
-- pos_events.event_type: normalize to lowercase (DB + constraint)
-- ----------------------------------------------------------------
UPDATE pos_events
SET event_type = lower(event_type)
WHERE event_type IS DISTINCT FROM lower(event_type);

ALTER TABLE pos_events
  DROP CONSTRAINT IF EXISTS chk_pos_events_event_type;

ALTER TABLE pos_events
  ADD CONSTRAINT chk_pos_events_event_type CHECK (
    event_type IN (
      'sale',
      'void',
      'refund',
      'exchange',
      'comp',
      'open_tab',
      'other'
    )
  );

-- ----------------------------------------------------------------
-- tenant_memberships: block assigning platform_admin unless bootstrap
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_platform_admin_membership_escalation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.role = 'platform_admin' THEN
    IF current_setting('app.allow_platform_admin_membership', true) IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'platform_admin cannot be assigned outside controlled bootstrap (app.allow_platform_admin_membership)';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tenant_memberships_no_platform_admin_escalation ON tenant_memberships;
CREATE TRIGGER trg_tenant_memberships_no_platform_admin_escalation
  BEFORE INSERT OR UPDATE OF role ON tenant_memberships
  FOR EACH ROW
  EXECUTE PROCEDURE public.prevent_platform_admin_membership_escalation();

-- ----------------------------------------------------------------
-- audit_logs: optional actor link to users
-- ----------------------------------------------------------------
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS actor_user_id UUID REFERENCES users (id) ON DELETE SET NULL;

UPDATE audit_logs al
SET actor_user_id = u.id
FROM users u
WHERE al.actor_user_id IS NULL
  AND al.actor_id IS NOT NULL
  AND al.actor_id = u.id::text;

-- ----------------------------------------------------------------
-- updated_at maintenance (tables that already have updated_at)
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tenants_set_updated_at ON tenants;
CREATE TRIGGER trg_tenants_set_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at();

DROP TRIGGER IF EXISTS trg_locations_set_updated_at ON locations;
CREATE TRIGGER trg_locations_set_updated_at
  BEFORE UPDATE ON locations
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at();

DROP TRIGGER IF EXISTS trg_users_set_updated_at ON users;
CREATE TRIGGER trg_users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at();

DROP TRIGGER IF EXISTS trg_inventory_items_set_updated_at ON inventory_items;
CREATE TRIGGER trg_inventory_items_set_updated_at
  BEFORE UPDATE ON inventory_items
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at();

DROP TRIGGER IF EXISTS trg_sku_mappings_set_updated_at ON sku_mappings;
CREATE TRIGGER trg_sku_mappings_set_updated_at
  BEFORE UPDATE ON sku_mappings
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at();

DROP TRIGGER IF EXISTS trg_scanner_usage_set_updated_at ON scanner_usage;
CREATE TRIGGER trg_scanner_usage_set_updated_at
  BEFORE UPDATE ON scanner_usage
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at();

-- ----------------------------------------------------------------
-- Scanner usage: tighter quota / period sanity
-- ----------------------------------------------------------------
ALTER TABLE scanner_usage
  DROP CONSTRAINT IF EXISTS chk_scanner_usage_period_quota;

ALTER TABLE scanner_usage
  ADD CONSTRAINT chk_scanner_usage_period_quota CHECK (
    scans_used >= 0
    AND scans_quota > 0
    AND scans_used <= scans_quota
    AND period_end > period_start
    AND (period_end - period_start) <= interval '400 days'
    AND (period_end - period_start) >= interval '1 second'
    AND scans_quota <= 100000000
  );

-- ----------------------------------------------------------------
-- Indexes: drop broad indexes, add partial / composite
-- ----------------------------------------------------------------
DROP INDEX IF EXISTS idx_pos_events_process_status;
DROP INDEX IF EXISTS idx_pos_events_occurred_at;
DROP INDEX IF EXISTS idx_pos_event_lines_pos_event_id;
DROP INDEX IF EXISTS idx_pos_event_lines_tenant_id;
DROP INDEX IF EXISTS idx_inventory_events_tenant_id;
DROP INDEX IF EXISTS idx_inventory_events_inventory_item_id;
DROP INDEX IF EXISTS idx_inventory_items_tenant_id;
DROP INDEX IF EXISTS idx_inventory_items_location_id;
DROP INDEX IF EXISTS idx_audit_logs_tenant_id;

CREATE INDEX IF NOT EXISTS idx_pos_events_pending
  ON pos_events (tenant_id, occurred_at DESC)
  WHERE process_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_pos_events_tenant_occurred
  ON pos_events (tenant_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_pos_event_lines_tenant_event
  ON pos_event_lines (tenant_id, pos_event_id);

CREATE INDEX IF NOT EXISTS idx_inventory_events_tenant_item_occurred
  ON inventory_events (tenant_id, inventory_item_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_inventory_items_tenant_location_active
  ON inventory_items (tenant_id, location_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_created
  ON audit_logs (tenant_id, created_at DESC)
  WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_user_id
  ON audit_logs (actor_user_id)
  WHERE actor_user_id IS NOT NULL;

-- ----------------------------------------------------------------
-- Row Level Security (session: app.current_tenant_id)
-- ----------------------------------------------------------------
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_event_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sku_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE scanner_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_scope_all ON locations;
CREATE POLICY tenant_scope_all ON locations
  FOR ALL
  USING (
    tenant_id = (
      NULLIF(trim(COALESCE(current_setting('app.current_tenant_id', true), '')), '')
    )::uuid
  )
  WITH CHECK (
    tenant_id = (
      NULLIF(trim(COALESCE(current_setting('app.current_tenant_id', true), '')), '')
    )::uuid
  );

DROP POLICY IF EXISTS tenant_scope_all ON pos_events;
CREATE POLICY tenant_scope_all ON pos_events
  FOR ALL
  USING (
    tenant_id = (
      NULLIF(trim(COALESCE(current_setting('app.current_tenant_id', true), '')), '')
    )::uuid
  )
  WITH CHECK (
    tenant_id = (
      NULLIF(trim(COALESCE(current_setting('app.current_tenant_id', true), '')), '')
    )::uuid
  );

DROP POLICY IF EXISTS tenant_scope_all ON pos_event_lines;
CREATE POLICY tenant_scope_all ON pos_event_lines
  FOR ALL
  USING (
    tenant_id = (
      NULLIF(trim(COALESCE(current_setting('app.current_tenant_id', true), '')), '')
    )::uuid
  )
  WITH CHECK (
    tenant_id = (
      NULLIF(trim(COALESCE(current_setting('app.current_tenant_id', true), '')), '')
    )::uuid
  );

DROP POLICY IF EXISTS tenant_scope_all ON tenant_memberships;
CREATE POLICY tenant_scope_all ON tenant_memberships
  FOR ALL
  USING (
    tenant_id = (
      NULLIF(trim(COALESCE(current_setting('app.current_tenant_id', true), '')), '')
    )::uuid
  )
  WITH CHECK (
    tenant_id = (
      NULLIF(trim(COALESCE(current_setting('app.current_tenant_id', true), '')), '')
    )::uuid
  );

DROP POLICY IF EXISTS tenant_scope_all ON inventory_items;
CREATE POLICY tenant_scope_all ON inventory_items
  FOR ALL
  USING (
    tenant_id = (
      NULLIF(trim(COALESCE(current_setting('app.current_tenant_id', true), '')), '')
    )::uuid
  )
  WITH CHECK (
    tenant_id = (
      NULLIF(trim(COALESCE(current_setting('app.current_tenant_id', true), '')), '')
    )::uuid
  );

DROP POLICY IF EXISTS tenant_scope_all ON inventory_events;
CREATE POLICY tenant_scope_all ON inventory_events
  FOR ALL
  USING (
    tenant_id = (
      NULLIF(trim(COALESCE(current_setting('app.current_tenant_id', true), '')), '')
    )::uuid
  )
  WITH CHECK (
    tenant_id = (
      NULLIF(trim(COALESCE(current_setting('app.current_tenant_id', true), '')), '')
    )::uuid
  );

DROP POLICY IF EXISTS tenant_scope_all ON audit_logs;
CREATE POLICY tenant_scope_all ON audit_logs
  FOR ALL
  USING (
    tenant_id IS NOT NULL
    AND tenant_id = (
      NULLIF(trim(COALESCE(current_setting('app.current_tenant_id', true), '')), '')
    )::uuid
  )
  WITH CHECK (
    tenant_id IS NOT NULL
    AND tenant_id = (
      NULLIF(trim(COALESCE(current_setting('app.current_tenant_id', true), '')), '')
    )::uuid
  );

DROP POLICY IF EXISTS tenant_scope_all ON sku_mappings;
CREATE POLICY tenant_scope_all ON sku_mappings
  FOR ALL
  USING (
    tenant_id = (
      NULLIF(trim(COALESCE(current_setting('app.current_tenant_id', true), '')), '')
    )::uuid
  )
  WITH CHECK (
    tenant_id = (
      NULLIF(trim(COALESCE(current_setting('app.current_tenant_id', true), '')), '')
    )::uuid
  );

DROP POLICY IF EXISTS tenant_scope_all ON scanner_usage;
CREATE POLICY tenant_scope_all ON scanner_usage
  FOR ALL
  USING (
    tenant_id = (
      NULLIF(trim(COALESCE(current_setting('app.current_tenant_id', true), '')), '')
    )::uuid
  )
  WITH CHECK (
    tenant_id = (
      NULLIF(trim(COALESCE(current_setting('app.current_tenant_id', true), '')), '')
    )::uuid
  );

COMMENT ON COLUMN pos_events.tenant_id IS
  'Tenant UUID; matches tenants(id). RLS is enabled: rows are visible for read/write only when app.current_tenant_id is set to a non-empty uuid string matching this column (see policies on pos_events).';

COMMIT;
