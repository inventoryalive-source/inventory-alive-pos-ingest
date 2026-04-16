'use strict';

const { z } = require('zod');

const posEventTypeValues = [
  'sale',
  'void',
  'refund',
  'exchange',
  'comp',
  'open_tab',
  'other',
];

const posEventTypeEnum = z.enum(posEventTypeValues);

const isoDateTimeString = z
  .string({ message: 'occurred_at must be a string' })
  .refine((s) => !Number.isNaN(Date.parse(s)), {
    message: 'must be a valid ISO 8601 date-time string',
  });

const lineItemSchema = z
  .object({
    external_line_id: z
      .string({ message: 'external_line_id must be a string' })
      .trim()
      .min(1, 'external_line_id must be a non-empty string'),
    external_item_id: z.union([z.string().trim().min(1), z.null()]).optional(),
    name: z.union([z.string(), z.null()]).optional(),
    quantity: z
      .number({ message: 'quantity must be a number' })
      .positive('quantity must be a positive number'),
    unit_price: z
      .number({ message: 'unit_price must be a number' })
      .min(0, 'unit_price must be a non-negative number'),
  })
  .strict();

const eventSchema = z
  .object({
    external_event_id: z
      .string({ message: 'external_event_id must be a string' })
      .trim()
      .min(1, 'external_event_id must be a non-empty string')
      .max(100, 'external_event_id must be at most 100 characters'),
    event_type: z
      .string({ message: 'event_type must be a string' })
      .transform((s) => s.trim().toLowerCase())
      .pipe(posEventTypeEnum),
    occurred_at: isoDateTimeString,
    external_order_id: z.union([z.string(), z.null()]).optional(),
    currency: z
      .string({ message: 'currency must be a string' })
      .length(3, 'currency must be a 3-character ISO code (e.g. USD)')
      .transform((c) => c.toUpperCase()),
    totals: z.object({
      subtotal: z.number({ message: 'totals.subtotal must be a number' }),
      tax: z.number({ message: 'totals.tax must be a number' }),
      tip: z.number({ message: 'totals.tip must be a number' }),
      total: z.number({ message: 'totals.total must be a number' }),
    }),
    line_items: z
      .array(lineItemSchema, { message: 'line_items must be an array' })
      .min(1, 'line_items must contain at least one line item')
      .max(500, 'line_items must contain at most 500 line items'),
  })
  .strict();

const posEventBodySchema = z
  .object({
    provider: z
      .string({ message: 'provider must be a string' })
      .trim()
      .min(1, 'provider must be a non-empty string')
      .max(100, 'provider must be at most 100 characters'),
    tenant_id: z.uuid({ message: 'tenant_id must be a valid UUID' }),
    location_id: z
      .string({ message: 'location_id must be a string' })
      .trim()
      .min(1, 'location_id must be a non-empty string')
      .max(100, 'location_id must be at most 100 characters'),
    event: eventSchema,
  })
  .strict();

module.exports = { posEventBodySchema };
