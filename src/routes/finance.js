'use strict';

const express = require('express');

const router = express.Router();
const DEFAULT_BRAND_ID = 'inventory_alive';

function parsePositiveAmount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.round(parsed * 100) / 100;
}

router.get('/summary', async (req, res) => {
  const brandId = req.query.brand_id || DEFAULT_BRAND_ID;

  try {
    const result = await req.db.query(
      `SELECT
         COALESCE(SUM(amount), 0) AS total_cash,
         COALESCE(SUM(CASE WHEN transaction_type = 'revenue' THEN ROUND(amount * 0.30, 2) ELSE 0 END), 0) AS tax_ghost
       FROM transactions
       WHERE brand_id = $1::brand_id
         AND status != 'voided'`,
      [brandId]
    );

    return res.status(200).json({
      brand_id: brandId,
      total_cash: Number(result.rows[0].total_cash),
      tax_ghost: Number(result.rows[0].tax_ghost),
      spendable_cash: Number(result.rows[0].total_cash) - Number(result.rows[0].tax_ghost),
    });
  } catch (err) {
    console.error('[GET /api/finance/summary] Error:', err.message, err.stack);
    return res.status(500).json({ error: 'Failed to load finance summary' });
  }
});

router.post('/log', async (req, res) => {
  const brandId = req.body.brand_id || DEFAULT_BRAND_ID;
  const transactionType = req.body.transaction_type;
  const amount = parsePositiveAmount(req.body.amount);
  const description = req.body.description || null;

  if (!['owner_contribution', 'revenue'].includes(transactionType)) {
    return res.status(400).json({ error: 'transaction_type must be owner_contribution or revenue' });
  }

  if (amount == null) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }

  try {
    const result = await req.db.query(
      `INSERT INTO transactions (
         id,
         brand_id,
         transaction_type,
         amount,
         description,
         status
       ) VALUES (
         gen_random_uuid(),
         $1::brand_id,
         $2::transaction_type,
         $3,
         $4,
         'cleared'
       )
       RETURNING id, brand_id, transaction_type, amount, tax_ghost_reserve, transacted_at`,
      [brandId, transactionType, amount, description]
    );

    return res.status(201).json({ log: result.rows[0] });
  } catch (err) {
    console.error('[POST /api/finance/log] Error:', err.message, err.stack);
    return res.status(500).json({ error: 'Failed to save finance log' });
  }
});

module.exports = router;
