'use strict';

const crypto = require('crypto');
const { validate: isUuid } = require('uuid');

/**
 * Validates x-ia-secret and requires x-tenant-id to be a UUID matching tenants(id).
 * Optional IA_INGEST_TENANT_KEYS JSON object maps tenant UUID string -> per-tenant secret;
 * otherwise IA_INGEST_SECRET is used for all tenants.
 */
function ingestTenantScope(req, res, next) {
  const tenantHeader = req.headers['x-tenant-id'];
  const providedSecret = req.headers['x-ia-secret'];

  if (!tenantHeader || Array.isArray(tenantHeader)) {
    return res.status(400).json({ error: 'Valid, single x-tenant-id header is required.' });
  }

  if (!isUuid(tenantHeader)) {
    return res.status(400).json({ error: 'x-tenant-id must be a UUID.' });
  }

  const globalSecret = process.env.IA_INGEST_SECRET;
  if (!globalSecret) {
    console.error('[ingestTenantScope] IA_INGEST_SECRET is not set — rejecting request');
    return res.status(500).json({ error: 'Server misconfiguration: secret not set' });
  }

  let expectedKey = globalSecret;
  const rawMap = process.env.IA_INGEST_TENANT_KEYS;
  if (rawMap) {
    try {
      const map = JSON.parse(rawMap);
      if (map && typeof map === 'object' && map[tenantHeader]) {
        expectedKey = map[tenantHeader];
      }
    } catch (err) {
      console.error('[ingestTenantScope] IA_INGEST_TENANT_KEYS is not valid JSON:', err.message);
      return res.status(500).json({ error: 'Server misconfiguration' });
    }
  }

  if (!providedSecret) {
    return res.status(401).json({ error: 'Missing required header: x-ia-secret' });
  }

  const a = Buffer.from(String(providedSecret), 'utf8');
  const b = Buffer.from(String(expectedKey), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Invalid x-ia-secret' });
  }

  req.ingestTenantId = tenantHeader;
  next();
}

module.exports = { ingestTenantScope };
