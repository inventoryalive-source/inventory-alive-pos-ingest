'use strict';

/**
 * authMiddleware — validates the x-ia-secret header against IA_INGEST_SECRET env var.
 * Returns 401 if missing or incorrect.
 */
function authMiddleware(req, res, next) {
  const secret = process.env.IA_INGEST_SECRET;

  if (!secret) {
    // Fail closed: if the secret is not configured, reject all requests.
    console.error('[auth] IA_INGEST_SECRET is not set — rejecting request');
    return res.status(500).json({ error: 'Server misconfiguration: secret not set' });
  }

  const provided = req.headers['x-ia-secret'];

  if (!provided) {
    return res.status(401).json({ error: 'Missing required header: x-ia-secret' });
  }

  if (provided !== secret) {
    return res.status(401).json({ error: 'Invalid x-ia-secret' });
  }

  next();
}

module.exports = authMiddleware;
