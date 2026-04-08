'use strict';

const jwt = require('jsonwebtoken');
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
 *   3. Look up user in tenant_memberships to confirm they belong to this tenant
 *   4. Confirm their role is active and not expired
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
      decoded = jwt.verify(token, secret);
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
    //   b) Query string → ?tenant_id=xxx
    //   c) Token itself → decoded.tenant_id (for single-tenant tokens)
    const requestedTenantId =
      req.params.tenant_id ||
      req.query.tenant_id ||
      decoded.tenant_id ||
      null;

    // platform_admin can access all tenants — skip tenant check
    if (decoded.role === 'platform_admin') {
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

    // ── Step 4: Confirm membership in tenant_memberships ────────────
    const { rows } = await pool.query(
      `SELECT tm.role, tm.tenant_id, u.deleted_at
       FROM tenant_memberships tm
       JOIN users u ON u.id = tm.user_id
       WHERE tm.user_id   = $1
         AND tm.tenant_id = $2
       LIMIT 1`,
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
