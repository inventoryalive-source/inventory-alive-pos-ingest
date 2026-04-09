'use strict';

const express = require('express');
const { validateRequest } = require('../middleware/validate');
const {
  checklistProgressGetQuerySchema,
  checklistProgressPostBodySchema,
} = require('../schemas/checklist');

const router = express.Router();

// GET /checklist/progress — return all checked item IDs
router.get(
  '/progress',
  validateRequest({ query: checklistProgressGetQuerySchema }),
  async (req, res) => {
    try {
      const result = await req.db.query(
        'SELECT item_id FROM checklist_progress WHERE wp_user_id = $1',
        [1]
      );
      const checkedIds = result.rows.map(r => r.item_id);
      res.json({ checked: checkedIds });
    } catch (err) {
      console.error('[checklist] GET error:', err.message);
      res.status(500).json({ error: 'Failed to load progress' });
    }
  }
);

// POST /checklist/progress — check or uncheck an item
// Body: { item_id: "item_42", checked: true }
router.post(
  '/progress',
  validateRequest({ body: checklistProgressPostBodySchema }),
  async (req, res) => {
    const { item_id, checked } = req.body;

    try {
      if (checked) {
        await req.db.query(
          `INSERT INTO checklist_progress (id, wp_user_id, item_id, checked_at)
           VALUES (gen_random_uuid(), $1, $2, NOW())
           ON CONFLICT DO NOTHING`,
          [1, item_id]
        );
      } else {
        await req.db.query(
          'DELETE FROM checklist_progress WHERE wp_user_id = $1 AND item_id = $2',
          [1, item_id]
        );
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('[checklist] POST error:', err.message);
      res.status(500).json({ error: 'Failed to save progress' });
    }
  }
);

module.exports = router;
