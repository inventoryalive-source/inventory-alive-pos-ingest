'use strict';

require('dotenv').config();

const express    = require('express');
const { ZodError } = require('zod');
const pool       = require('./db/pool');
const { validateRequest, validationErrorPayload } = require('./middleware/validate');
const { emptyQuerySchema } = require('./schemas/common');
const posEventsRouter = require('./routes/posEvents');
const checklistRouter = require('./routes/checklist');
const app  = express();
const PORT = process.env.PORT || 3000;

// ── Global middleware ──────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));

// Log every incoming request (skip in tests)
if (process.env.NODE_ENV !== 'test') {
  app.use((req, _res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });
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
app.use((req, _res, next) => { req.db = pool; next(); });

// CORS for checklist (allow SiteGround)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Checklist sync (public) ───────────────────────────────────────────────
app.use('/checklist', checklistRouter);
// ── Authenticated routes ───────────────────────────────────────────────────
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
async function start() {
  // Verify DB connectivity before accepting traffic
  try {
    const result = await pool.query('SELECT NOW() AS now');
    console.log(`[db] Connected. Server time: ${result.rows[0].now}`);
  } catch (err) {
    console.error('[db] Failed to connect on startup:', err.message);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`[server] Inventory Alive POS Ingest listening on port ${PORT}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = app; // export for testing
