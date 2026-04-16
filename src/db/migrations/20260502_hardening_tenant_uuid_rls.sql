-- =============================================================
-- Hardening migration: UUID tenant_id, constraints, RLS
-- Apply after 001_initial_schema.sql and 20260501_vito_construction_init.sql
-- Idempotent where possible (safe if 001 was already hardened).
-- =============================================================

-- ----------------------------------------------------------------
-- Session + auth helpers (SECURITY DEFINER bypasses RLS for auth)
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_session_tenant_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  s text;
BEGIN
  s := NULLIF(btrim(current_setting('app.current_tenant_id', true)), '');
  IF s IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN s::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.user_is_platform_admin(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM tenant_memberships tm
    JOIN users u ON u.id = tm.user_id
    WHERE tm.user_id = p_user_id
      AND tm.role = 'platform_admin'
      AND u.deleted_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION public.tenant_membership_for_user(
  p_user_id uuid,
  p_tenant_id uuid
)
RETURNS TABLE(role text, tenant_id uuid, deleted_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT tm.role, tm.tenant_id, u.deleted_at
  FROM tenant_memberships tm
  JOIN users u ON u.id = tm.user_id
  WHERE tm.user_id = p_user_id
    AND tm.tenant_id = p_tenant_id
  LIMIT 1;
$$;

-- ----------------------------------------------------------------
-- Phase A: TEXT tenant_id → UUID (skip if already uuid)
-- ----------------------------------------------------------------
DO $phase_a$
DECLARE
  pos_tid text;
BEGIN
  SELECT c.udt_name INTO pos_tid
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'pos_events'
    AND c.column_name = 'tenant_id';

  IF pos_tid = 'text' THEN
    -- Ensure parent rows exist for every distinct ingest tenant id
    INSERT INTO tenants (id, name)
    SELECT DISTINCT pe.tenant_id::uuid, NULL
    FROM pos_events pe
    WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = pe.tenant_id::uuid)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO tenants (id, name)
    SELECT DISTINCT sm.tenant_id::uuid, NULL
    FROM sku_mappings sm
    WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = sm.tenant_id::uuid)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO tenants (id, name)
    SELECT DISTINCT su.tenant_id::uuid, NULL
    FROM scanner_usage su
    WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = su.tenant_id::uuid)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO tenants (id, name)
    SELECT DISTINCT al.tenant_id::uuid, NULL
    FROM audit_logs al
    WHERE al.tenant_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = al.tenant_id::uuid)
    ON CONFLICT (id) DO NOTHING;

    -- Keep line denormalized tenant_id aligned before type change
    UPDATE pos_event_lines pel
    SET tenant_id = pe.tenant_id
    FROM pos_events pe
    WHERE pel.pos_event_id = pe.id;

    ALTER TABLE pos_events
      DROP CONSTRAINT IF EXISTS fk_pos_events_tenant;

    ALTER TABLE pos_events
      ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;

    ALTER TABLE pos_events
      ADD CONSTRAINT fk_pos_events_tenant
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

    ALTER TABLE pos_event_lines
      DROP CONSTRAINT IF EXISTS fk_pos_event_lines_tenant;

    ALTER TABLE pos_event_lines
      ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;

    ALTER TABLE pos_event_lines
      ADD CONSTRAINT fk_pos_event_lines_tenant
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

    ALTER TABLE audit_logs
      DROP CONSTRAINT IF EXISTS fk_audit_logs_tenant;

    ALTER TABLE audit_logs
      ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;

    ALTER TABLE audit_logs
      ADD CONSTRAINT fk_audit_logs_tenant
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL;

    ALTER TABLE sku_mappings
      DROP CONSTRAINT IF EXISTS fk_sku_mappings_tenant;

    ALTER TABLE sku_mappings
      ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;

    ALTER TABLE sku_mappings
      ADD CONSTRAINT fk_sku_mappings_tenant
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

    ALTER TABLE scanner_usage
      DROP CONSTRAINT IF EXISTS fk_scanner_usage_tenant;

    ALTER TABLE scanner_usage
      ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;

    ALTER TABLE scanner_usage
      ADD CONSTRAINT fk_scanner_usage_tenant
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
  END IF;
END
$phase_a$;

-- ----------------------------------------------------------------
-- Phase B: Column constraints (idempotent)
-- ----------------------------------------------------------------
ALTER TABLE pos_event_lines
  ALTER COLUMN quantity DROP DEFAULT;

ALTER TABLE pos_event_lines
  ALTER COLUMN unit_price DROP DEFAULT;

ALTER TABLE pos_event_lines
  ALTER COLUMN quantity SET NOT NULL;

ALTER TABLE pos_event_lines
  ALTER COLUMN unit_price SET NOT NULL;

ALTER TABLE pos_events
  DROP CONSTRAINT IF EXISTS chk_pos_events_event_type;

ALTER TABLE pos_events
  ADD CONSTRAINT chk_pos_events_event_type CHECK (
    event_type IN (
      'SALE',
      'VOID',
      'REFUND',
      'EXCHANGE',
      'COMP',
      'OPEN_TAB',
      'OTHER'
    )
  );

ALTER TABLE scanner_usage
  DROP CONSTRAINT IF EXISTS chk_scanner_usage_period_quota;

ALTER TABLE scanner_usage
  ADD CONSTRAINT chk_scanner_usage_period_quota CHECK (
    scans_used <= scans_quota
    AND period_end > period_start
  );

COMMENT ON COLUMN tenant_memberships.role IS
  'Membership role; must be one of: platform_admin, tenant_admin, staff, read_only (see chk_tenant_memberships_role).';

DROP INDEX IF EXISTS idx_audit_logs_tenant_id;
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_id ON audit_logs(tenant_id);

-- ----------------------------------------------------------------
-- Phase C: Row Level Security
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
  USING (tenant_id = public.app_session_tenant_id())
  WITH CHECK (tenant_id = public.app_session_tenant_id());

DROP POLICY IF EXISTS tenant_scope_all ON pos_events;
CREATE POLICY tenant_scope_all ON pos_events
  FOR ALL
  USING (tenant_id = public.app_session_tenant_id())
  WITH CHECK (tenant_id = public.app_session_tenant_id());

DROP POLICY IF EXISTS tenant_scope_all ON pos_event_lines;
CREATE POLICY tenant_scope_all ON pos_event_lines
  FOR ALL
  USING (tenant_id = public.app_session_tenant_id())
  WITH CHECK (tenant_id = public.app_session_tenant_id());

DROP POLICY IF EXISTS tenant_scope_all ON tenant_memberships;
CREATE POLICY tenant_scope_all ON tenant_memberships
  FOR ALL
  USING (tenant_id = public.app_session_tenant_id())
  WITH CHECK (tenant_id = public.app_session_tenant_id());

DROP POLICY IF EXISTS tenant_scope_all ON inventory_items;
CREATE POLICY tenant_scope_all ON inventory_items
  FOR ALL
  USING (tenant_id = public.app_session_tenant_id())
  WITH CHECK (tenant_id = public.app_session_tenant_id());

DROP POLICY IF EXISTS tenant_scope_all ON inventory_events;
CREATE POLICY tenant_scope_all ON inventory_events
  FOR ALL
  USING (tenant_id = public.app_session_tenant_id())
  WITH CHECK (tenant_id = public.app_session_tenant_id());

DROP POLICY IF EXISTS tenant_scope_all ON audit_logs;
CREATE POLICY tenant_scope_all ON audit_logs
  FOR ALL
  USING (
    public.app_session_tenant_id() IS NOT NULL
    AND tenant_id IS NOT NULL
    AND tenant_id = public.app_session_tenant_id()
  )
  WITH CHECK (
    public.app_session_tenant_id() IS NOT NULL
    AND tenant_id IS NOT NULL
    AND tenant_id = public.app_session_tenant_id()
  );

DROP POLICY IF EXISTS tenant_scope_all ON sku_mappings;
CREATE POLICY tenant_scope_all ON sku_mappings
  FOR ALL
  USING (tenant_id = public.app_session_tenant_id())
  WITH CHECK (tenant_id = public.app_session_tenant_id());

DROP POLICY IF EXISTS tenant_scope_all ON scanner_usage;
CREATE POLICY tenant_scope_all ON scanner_usage
  FOR ALL
  USING (tenant_id = public.app_session_tenant_id())
  WITH CHECK (tenant_id = public.app_session_tenant_id());

-- Construction module (present only if vito migration ran)
DO $construction_rls$
BEGIN
  IF to_regclass('public.construction_jobs') IS NOT NULL THEN
  EXECUTE 'ALTER TABLE construction_jobs ENABLE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_scope_all ON construction_jobs';
  EXECUTE $p$
    CREATE POLICY tenant_scope_all ON construction_jobs
      FOR ALL
      USING (tenant_id = public.app_session_tenant_id())
      WITH CHECK (tenant_id = public.app_session_tenant_id())
  $p$;

  EXECUTE 'ALTER TABLE job_site_photos ENABLE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_scope_all ON job_site_photos';
  EXECUTE $p$
    CREATE POLICY tenant_scope_all ON job_site_photos
      FOR ALL
      USING (tenant_id = public.app_session_tenant_id())
      WITH CHECK (tenant_id = public.app_session_tenant_id())
  $p$;

  EXECUTE 'ALTER TABLE job_measurements ENABLE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_scope_all ON job_measurements';
  EXECUTE $p$
    CREATE POLICY tenant_scope_all ON job_measurements
      FOR ALL
      USING (tenant_id = public.app_session_tenant_id())
      WITH CHECK (tenant_id = public.app_session_tenant_id())
  $p$;
  END IF;
END
$construction_rls$;

-- Remove obsolete comment (tenant_id is now registry UUID)
COMMENT ON COLUMN pos_events.tenant_id IS
  'Tenant registry UUID; matches tenants(id). Session variable app.current_tenant_id must match for RLS.';
