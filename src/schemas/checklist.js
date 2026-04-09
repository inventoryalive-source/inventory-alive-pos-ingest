'use strict';

const { z } = require('zod');
const { emptyQuerySchema } = require('./common');

const checklistProgressGetQuerySchema = emptyQuerySchema;

const checklistProgressPostBodySchema = z
  .object({
    item_id: z
      .string({ message: 'item_id must be a string' })
      .trim()
      .min(1, 'item_id must be a non-empty string'),
    checked: z.boolean().optional().default(false),
  })
  .strict();

module.exports = {
  checklistProgressGetQuerySchema,
  checklistProgressPostBodySchema,
};
