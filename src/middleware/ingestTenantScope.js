'use strict';

const jwt = require('jsonwebtoken');

/**
 * ingestTenantScope — for service-to-service POS ingest.
 * - Requires a valid x-tenant-id (trimmed non-empty, max length, UUID or slug format).
 * - Binds the caller to that tenant via a signed JWT (IA_INGEST_JWT_SECRET) or
 *   per-tenant API key map (IA_INGEST_TENANT_KEYS JSON).
 * - Legacy: outside production, IA_INGEST_SECRET alone may still be used (dev only).
 * Handlers compare scope to body/DB so one tenant cannot read or write another's data.
 */

const MAX_TENANT_ID_HEADER_LENGTH = 128;
/** UUID (any version variant) or slug-style id (e.g. tenant_A in tests). */
const TENANT_ID_FORMAT =
  /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[a-zA-Z0-9_-]+)$/;

/** Normalize loopback / IPv4-mapped IPv6 for comparison with TRUSTED_PROXY_IPS. */
function normalizeSocketIp(ip) {
  if (typeof ip !== 'string' || ip === '') return '';
  const s = ip.trim();
  if (s.startsWith('::ffff:')) return s.slice(7);
  return s;
}

function trustedProxyIpSet() {
  const raw = process.env.TRUSTED_PROXY_IPS;
  if (raw == null || String(raw).trim() === '') return new Set();
  return new Set(
    String(raw)
      .split(',')
      .map((s) => normalizeSocketIp(s))
      .filter(Boolean)
  );
}

function isTrustedProxyPeer(remoteAddress, trusted) {
  if (!remoteAddress || trusted.size === 0) return false;
  const n = normalizeSocketIp(remoteAddress);
  return trusted.has(n);
}

/**
 * Audit-only client IP. Does not use req.ip (Express-derived; spoofable behind proxies).
 * x-forwarded-for is used only when the TCP peer is listed in TRUSTED_PROXY_IPS.
 */
function clientIp(req) {
  const remote = req.socket?.remoteAddress;
  const trusted = trustedProxyIpSet();

  if (isTrustedProxyPeer(remote, trusted)) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string') {
      const fromFwd = fwd.split(',')[0].trim();
      if (fromFwd) return fromFwd;
    }
  }

  return normalizeSocketIp(remote) || remote || 'unknown';
}

function audit400(req, reason) {
  console.warn(
    `[ingestTenantScope] 400 ${reason} ip=${clientIp(req)} path=${req.path || req.url}`
  );
}

function parseTenantKeys() {
  const raw = process.env.IA_INGEST_TENANT_KEYS;
  if (raw == null || String(raw).trim() === '') return null;
  try {
    const obj = JSON.parse(raw);
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
    return obj;
  } catch {
    return null;
  }
}

function normalizeTenantHeader(raw) {
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw) && raw.length && typeof raw[0] === 'string') {
    return raw[0].trim();
  }
  return '';
}

function verifyTenantCredential(req, tenantId) {
  const jwtSecret = process.env.IA_INGEST_JWT_SECRET;
  const authHeader = req.headers.authorization;
  const bearer =
    typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : '';

  if (jwtSecret && bearer) {
    try {
      const payload = jwt.verify(bearer, jwtSecret, {
        algorithms: ['HS256'],
      });
      const claim = payload.tenant_id ?? payload.tid ?? payload.sub;
      if (claim !== tenantId) {
        return { ok: false, status: 401, body: { error: 'Invalid credentials' } };
      }
      return { ok: true };
    } catch {
      return { ok: false, status: 401, body: { error: 'Invalid credentials' } };
    }
  }

  const tenantKeys = parseTenantKeys();
  if (tenantKeys) {
    const provided = req.headers['x-ia-secret'];
    if (provided === undefined || provided === null) {
      return { ok: false, status: 401, body: { error: 'Missing required header: x-ia-secret' } };
    }
    const expected = tenantKeys[tenantId];
    if (expected === undefined) {
      return { ok: false, status: 401, body: { error: 'Invalid credentials' } };
    }
    if (provided !== expected) {
      return { ok: false, status: 401, body: { error: 'Invalid x-ia-secret' } };
    }
    return { ok: true };
  }

  if (process.env.NODE_ENV === 'production') {
    return {
      ok: false,
      status: 401,
      body: {
        error:
          'Tenant-bound authentication required: set IA_INGEST_TENANT_KEYS or IA_INGEST_JWT_SECRET',
      },
    };
  }

  const globalSecret = process.env.IA_INGEST_SECRET;
  if (!globalSecret) {
    console.error('[ingestTenantScope] IA_INGEST_SECRET is not set — rejecting request');
    return {
      ok: false,
      status: 500,
      body: { error: 'Server misconfiguration: secret not set' },
    };
  }

  const provided = req.headers['x-ia-secret'];
  if (provided === undefined || provided === null) {
    return { ok: false, status: 401, body: { error: 'Missing required header: x-ia-secret' } };
  }
  if (provided !== globalSecret) {
    return { ok: false, status: 401, body: { error: 'Invalid x-ia-secret' } };
  }
  return { ok: true };
}

function ingestTenantScope(req, res, next) {
  const rawHeader = req.headers['x-tenant-id'];
  const tenantId = normalizeTenantHeader(rawHeader);

  if (tenantId.length > MAX_TENANT_ID_HEADER_LENGTH) {
    audit400(req, 'x-tenant-id exceeds max length');
    return res.status(400).json({ error: 'Invalid x-tenant-id header' });
  }

  if (!tenantId) {
    audit400(req, 'missing or empty x-tenant-id after trim');
    return res.status(400).json({ error: 'Missing x-tenant-id header' });
  }

  if (!TENANT_ID_FORMAT.test(tenantId)) {
    audit400(req, 'x-tenant-id format invalid');
    return res.status(400).json({ error: 'Invalid x-tenant-id header' });
  }

  req.ingestTenantId = tenantId;

  const auth = verifyTenantCredential(req, tenantId);
  if (!auth.ok) {
    return res.status(auth.status).json(auth.body);
  }

  next();
}

module.exports = { ingestTenantScope };
