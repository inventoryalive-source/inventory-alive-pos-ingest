'use strict';

const jwt = require('jsonwebtoken');
const { validate: isUuid } = require('uuid');
const pool = require('../db/pool');

/**
 * assertTenantAccess
 *
 * Middleware that runs on every user-facing route.
 * Validates the user's JWT token and confirms their tenant_id
 * matches the tenant they are trying to access.
 *
 * Flow:
 *   1. Extract Bearer token from Authorization header
 *   2. Verify token signature using JWT_SECRET
 *   3. If token claims platform_admin: confirm in DB (users row + platform_admin membership)
 *      Otherwise: look up user in tenant_memberships for the requested tenant
 *   4. Reject soft-deleted users
 *   5. Attach user and tenant context to req for downstream use
 *   6. Call next() if all checks pass — otherwise 401 or 403
 *
 * Usage:
 *   const assertTenantAccess = require('../middleware/assertTenantAccess');
 *   router.get('/inventory', assertTenantAccess, yourHandler);
 */
async function assertTenantAccess(req, res, next) {
  try {
    // ── Step 1: Extract token ────────────────────────────────────────
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or malformed Authorization header' });
    }
    const token = authHeader.slice(7); // Remove "Bearer " prefix

    // ── Step 2: Verify token signature ──────────────────────────────
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      console.error('[assertTenantAccess] JWT_SECRET is not set — rejecting request');
      return res.status(500).json({ error: 'Server misconfiguration: JWT_SECRET not set' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expired — please log in again' });
      }
      return res.status(401).json({ error: 'Invalid token' });
    }

    const userId = decoded.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Token payload missing user_id' });
    }

    // ── Step 3: Resolve tenant_id ────────────────────────────────────
    // tenant_id can come from:
    //   a) Route param  → /api/tenants/:tenant_id/inventory
    //   b) Token itself → decoded.tenant_id (for single-tenant tokens)
    const requestedTenantId =
      req.params.tenant_id ||
      decoded.tenant_id ||
      null;

    // platform_admin in the JWT must still match DB (stale or forged tokens rejected)
    if (decoded.role === 'platform_admin') {
      const { rows: adminRows } = await pool.query(
        'SELECT public.user_is_platform_admin($1::uuid) AS ok',
        [userId]
      );
      if (!adminRows[0]?.ok) {
        return res.status(403).json({ error: 'Access denied' });
      }
      req.user = {
        user_id:   userId,
        role:      'platform_admin',
        tenant_id: requestedTenantId || null,
      };
      return next();
    }

    // All other roles must have a resolvable tenant_id
    if (!requestedTenantId) {
      return res.status(400).json({ error: 'tenant_id is required' });
    }

    if (!isUuid(requestedTenantId)) {
      return res.status(400).json({ error: 'tenant_id must be a UUID' });
    }

    // ── Step 4: Confirm membership (SECURITY DEFINER bypasses RLS) ─
    const { rows } = await pool.query(
      `SELECT role, tenant_id, deleted_at
       FROM public.tenant_membership_for_user($1::uuid, $2::uuid)`,
      [userId, requestedTenantId]
    );

    if (rows.length === 0) {
      // User does not belong to this tenant — hard 403, no details leaked
      return res.status(403).json({ error: 'Access denied' });
    }

    const membership = rows[0];

    // Reject soft-deleted users
    if (membership.deleted_at) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // ── Step 5: Attach context to req ───────────────────────────────
    // Downstream handlers use req.user.tenant_id and req.user.role
    req.user = {
      user_id:   userId,
      tenant_id: membership.tenant_id,
      role:      membership.role,
    };

    // ── Step 6: Pass to next handler ────────────────────────────────
    next();

  } catch (err) {
    // Catch-all — never leak internal error details to client
    console.error('[assertTenantAccess] Unexpected error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * requireRole — optional role gate to stack after assertTenantAccess.
 *
 * Usage:
 *   router.post('/invite', assertTenantAccess, requireRole('tenant_admin'), yourHandler);
 *   router.delete('/tenant', assertTenantAccess, requireRole('platform_admin'), yourHandler);
 */
function requireRole(...allowedRoles) {
  return function (req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = { assertTenantAccess, requireRole };
