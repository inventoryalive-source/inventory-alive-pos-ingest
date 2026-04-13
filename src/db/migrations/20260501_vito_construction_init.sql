-- =============================================================
-- Vito Construction — foundation tables
-- Target: Neon Postgres (Postgres 15+)
-- Every table includes tenant_id → tenants(id) for isolation.
-- =============================================================

-- ---------------------------------------------------------------
-- construction_jobs
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS construction_jobs (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    external_id     TEXT,   -- optional stable id from mobile / partner systems
    name            TEXT        NOT NULL,
    status          TEXT        NOT NULL DEFAULT 'draft',
    site_address    TEXT,
    notes           TEXT,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    deleted_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_construction_jobs_tenant_external_id
        UNIQUE (tenant_id, external_id),
    -- Enables composite FKs from job_site_photos / job_measurements (tenant + job must align).
    CONSTRAINT uq_construction_jobs_tenant_id_id
        UNIQUE (tenant_id, id),
    CONSTRAINT chk_construction_jobs_status
        CHECK (status IN ('draft', 'scheduled', 'active', 'on_hold', 'completed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_construction_jobs_tenant_id ON construction_jobs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_construction_jobs_status     ON construction_jobs(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_construction_jobs_deleted_at ON construction_jobs(tenant_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------
-- job_site_photos
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_site_photos (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    construction_job_id UUID        NOT NULL,
    storage_key         TEXT        NOT NULL,   -- e.g. S3 key or blob id
    caption             TEXT,
    taken_at            TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_job_site_photos_job
        FOREIGN KEY (tenant_id, construction_job_id)
        REFERENCES construction_jobs(tenant_id, id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_job_site_photos_tenant_id           ON job_site_photos(tenant_id);
CREATE INDEX IF NOT EXISTS idx_job_site_photos_construction_job_id ON job_site_photos(tenant_id, construction_job_id);

-- ---------------------------------------------------------------
-- job_measurements
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_measurements (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    construction_job_id UUID        NOT NULL,
    label               TEXT,   -- e.g. room or surface name
    length_ft           NUMERIC(12, 4),
    width_ft            NUMERIC(12, 4),
    height_ft           NUMERIC(12, 4),
    area_sq_ft          NUMERIC(14, 4),
    unit_notes          TEXT,
    measured_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_job_measurements_job
        FOREIGN KEY (tenant_id, construction_job_id)
        REFERENCES construction_jobs(tenant_id, id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_job_measurements_tenant_id           ON job_measurements(tenant_id);
CREATE INDEX IF NOT EXISTS idx_job_measurements_construction_job_id ON job_measurements(tenant_id, construction_job_id);
