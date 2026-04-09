'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const { ingestTenantScope } = require('../middleware/ingestTenantScope');
const { validateRequest } = require('../middleware/validate');
const { emptyQuerySchema } = require('../schemas/common');
const { posEventBodySchema } = require('../schemas/posEvent');

const router = express.Router();

router.use(ingestTenantScope);

/**
 * GET /api/pos/events
 *
 * Lists recent POS events for the tenant named in x-tenant-id only.
 */
router.get(
  '/events',
  validateRequest({ query: emptyQuerySchema }),
  async (req, res) => {
    try {
      const tenantId = req.ingestTenantId;
      const result = await pool.query(
        `SELECT id, tenant_id, location_id, provider, external_event_id, event_type, occurred_at, created_at
         FROM pos_events
         WHERE tenant_id = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [tenantId]
      );
      return res.status(200).json({ events: result.rows });
    } catch (err) {
      console.error('[GET /api/pos/events] Error:', err.message, err.stack);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /api/pos/events
 *
 * Ingests a normalized POS event, stores it in pos_events + pos_event_lines.
 * Handles idempotency via UNIQUE(tenant_id, location_id, provider, external_event_id).
 */
router.post('/events', validateRequest({ body: posEventBodySchema }), async (req, res) => {
  const { provider, tenant_id, location_id, event } = req.body;

  if (tenant_id !== req.ingestTenantId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const {
    external_event_id,
    event_type,
    occurred_at,
    external_order_id,
    currency,
    line_items,
    totals,
  } = event;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── 2. Attempt to insert pos_event ──────────────────────────────────────
    const posEventId = uuidv4();

    const insertEventSQL = `
      INSERT INTO pos_events (
        id,
        tenant_id,
        location_id,
        provider,
        external_event_id,
        event_type,
        external_order_id,
        currency,
        subtotal,
        tax,
        tip,
        total,
        occurred_at,
        process_status,
        raw_event
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15
      )
      ON CONFLICT ON CONSTRAINT uq_pos_events_idempotency DO NOTHING
      RETURNING id
    `;

    const eventResult = await client.query(insertEventSQL, [
      posEventId,
      tenant_id,
      location_id,
      provider,
      external_event_id,
      event_type,
      external_order_id || null,
      currency.toUpperCase(),
      totals.subtotal,
      totals.tax,
      totals.tip,
      totals.total,
      occurred_at,
      'pending',
      JSON.stringify(req.body), // full original payload
    ]);

    // ── 3. Idempotency check ────────────────────────────────────────────────
    if (eventResult.rowCount === 0) {
      // Row already existed — duplicate event, do not re-insert lines
      await client.query('ROLLBACK');
      return res.status(200).json({ status: 'duplicate' });
    }

    const insertedEventId = eventResult.rows[0].id;

    // ── 4. Insert line items ────────────────────────────────────────────────
    const insertLineSQL = `
      INSERT INTO pos_event_lines (
        id,
        pos_event_id,
        external_line_id,
        external_item_id,
        name,
        quantity,
        unit_price
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT ON CONSTRAINT uq_pos_event_lines_idempotency DO NOTHING
    `;

    for (const line of line_items) {
      await client.query(insertLineSQL, [
        uuidv4(),
        insertedEventId,
        line.external_line_id,
        line.external_item_id || null,
        line.name || null,
        line.quantity,
        line.unit_price,
      ]);
    }

    await client.query('COMMIT');

    return res.status(200).json({
      status: 'received',
      pos_event_id: insertedEventId,
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[POST /api/pos/events] Error:', err.message, err.stack);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
