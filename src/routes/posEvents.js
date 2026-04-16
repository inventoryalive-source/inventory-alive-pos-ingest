'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { runWithTenantRls } = require('../db/runWithTenantRls');
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
      const result = await runWithTenantRls(tenantId, (client) =>
        client.query(
          `SELECT id, tenant_id, location_id, provider, external_event_id, event_type, occurred_at, created_at
           FROM pos_events
           WHERE tenant_id = $1::uuid
           ORDER BY created_at DESC
           LIMIT 50`,
          [tenantId]
        )
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
  const tenantId = req.ingestTenantId;

  if (tenant_id !== tenantId) {
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

  try {
    let duplicate = false;
    let insertedEventId;

    await runWithTenantRls(tenantId, async (client) => {
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
        tenantId,
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
        JSON.stringify(req.body),
      ]);

      if (eventResult.rowCount === 0) {
        duplicate = true;
        return;
      }

      insertedEventId = eventResult.rows[0].id;

      const insertLineSQL = `
      INSERT INTO pos_event_lines (
        id,
        pos_event_id,
        tenant_id,
        external_line_id,
        external_item_id,
        name,
        quantity,
        unit_price
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT ON CONSTRAINT uq_pos_event_lines_idempotency DO NOTHING
    `;

      for (const line of line_items) {
        await client.query(insertLineSQL, [
          uuidv4(),
          insertedEventId,
          tenantId,
          line.external_line_id,
          line.external_item_id || null,
          line.name || null,
          line.quantity,
          line.unit_price,
        ]);
      }
    });

    if (duplicate) {
      return res.status(200).json({ status: 'duplicate' });
    }

    return res.status(200).json({
      status: 'received',
      pos_event_id: insertedEventId,
    });
  } catch (err) {
    console.error('[POST /api/pos/events] Error:', err.message, err.stack);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
