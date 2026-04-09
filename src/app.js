'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { ZodError } = require('zod');
const pool = require('./db/pool');
const { validateRequest, validationErrorPayload } = require('./middleware/validate');
const { emptyQuerySchema } = require('./schemas/common');
const posEventsRouter = require('./routes/posEvents');
const checklistRouter = require('./routes/checklist');

const app = express();
const PORT = process.env.PORT || 3000;

const REQUEST_TIMEOUT_MS = 30_000;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 100;
const POS_RATE_LIMIT_MAX = 1000;
const GRACEFUL_SHUTDOWN_DRAIN_MS = REQUEST_TIMEOUT_MS + 5000;
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction) {
  app.set('trust proxy', 1);
}

// ── Global middleware ──────────────────────────────────────────────────────
app.use(helmet());

const posRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: POS_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
});

const appRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) =>
    process.env.NODE_ENV === 'test' || req.path.startsWith('/api/pos'),
});

app.use('/api/pos', posRateLimiter);
app.use(appRateLimiter);

app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  req.setTimeout(REQUEST_TIMEOUT_MS, () => {
    if (!res.headersSent) {
      res.status(408).json({ error: 'Request timeout' });
    }
  });
  next();
});

// Log every incoming request (skip in tests)
if (process.env.NODE_ENV !== 'test') {
  app.use((req, _res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });
}

function parseAllowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS;
  if (raw == null || String(raw).trim() === '') return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Parsed once at startup; reused by CORS middleware. */
const allowedOriginsCache = parseAllowedOrigins();

/**
 * CORS: production uses ALLOWED_ORIGINS (comma-separated). Wildcard (*) only when
 * NODE_ENV is not production and ALLOWED_ORIGINS is unset/empty.
 */
function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  const allowed = allowedOriginsCache;
  const allowWildcardFallback = process.env.NODE_ENV !== 'production';

  const setCommonCorsHeaders = () => {
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, x-tenant-id, x-ia-secret'
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  };

  if (req.method === 'OPTIONS') {
    setCommonCorsHeaders();
    if (!origin) {
      return res.sendStatus(204);
    }
    if (allowed.length > 0) {
      if (!allowed.includes(origin)) {
        return res.status(403).json({ error: 'Origin not allowed' });
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else if (allowWildcardFallback) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else {
      return res.status(403).json({ error: 'Origin not allowed' });
    }
    return res.sendStatus(200);
  }

  if (origin) {
    if (allowed.length > 0) {
      if (!allowed.includes(origin)) {
        return res.status(403).json({ error: 'Origin not allowed' });
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else if (allowWildcardFallback) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else {
      return res.status(403).json({ error: 'Origin not allowed' });
    }
  }
  setCommonCorsHeaders();
  return next();
}

// ── Public routes ──────────────────────────────────────────────────────────

/**
 * GET /health
 * Lightweight liveness check. No auth required.
 */
app.get(
  '/health',
  validateRequest({ query: emptyQuerySchema }),
  (_req, res) => {
    res.status(200).json({ ok: true });
  }
);
// Attach db pool to every request
app.use((req, _res, next) => {
  req.db = pool;
  next();
});

app.use(corsMiddleware);

// ── Checklist sync (public) ───────────────────────────────────────────────
app.use('/checklist', checklistRouter);
// ── Authenticated routes ───────────────────────────────────────────────────
// Auth is enforced by ingestTenantScope on the router (not authMiddleware).
app.use('/api/pos', posEventsRouter);

// ── 404 catch-all ─────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Global error handler ───────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  if (err instanceof ZodError) {
    return res.status(400).json(validationErrorPayload(err));
  }
  console.error('[unhandled error]', err.message, err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Boot ───────────────────────────────────────────────────────────────────
let server;

function gracefulShutdown(signal) {
  console.log(`[server] ${signal} received, draining connections...`);
  if (!server) {
    process.exit(0);
    return;
  }

  let poolEnded = false;
  const endPoolOnce = (exitCode) => {
    if (poolEnded) return;
    poolEnded = true;
    pool.end(() => {
      console.log('[server] HTTP server and database pool closed');
      process.exit(exitCode);
    });
  };

  const forceExit = setTimeout(() => {
    console.error(
      `[server] Forced exit after ${GRACEFUL_SHUTDOWN_DRAIN_MS}ms shutdown drain`
    );
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    endPoolOnce(1);
  }, GRACEFUL_SHUTDOWN_DRAIN_MS);
  forceExit.unref();

  server.close((err) => {
    clearTimeout(forceExit);
    if (err) console.error('[server] HTTP close error:', err.message);
    endPoolOnce(err ? 1 : 0);
  });
}

async function start() {
  // Verify DB connectivity before accepting traffic
  try {
    const result = await pool.query('SELECT NOW() AS now');
    console.log(`[db] Connected. Server time: ${result.rows[0].now}`);
  } catch (err) {
    console.error('[db] Failed to connect on startup:', err.message);
    process.exit(1);
  }

  server = app.listen(PORT, () => {
    console.log(`[server] Inventory Alive POS Ingest listening on port ${PORT}`);
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;

  process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.once('SIGINT', () => gracefulShutdown('SIGINT'));
}

if (require.main === module) {
  start();
}

module.exports = app; // export for testing
