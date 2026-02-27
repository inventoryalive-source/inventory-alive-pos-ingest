'use strict';

/**
 * validatePosEventPayload — validates the POST /api/pos/events request body.
 * Returns an array of error strings; empty array means valid.
 */
function validatePosEventPayload(body) {
  const errors = [];

  if (!body || typeof body !== 'object') {
    return ['Request body must be a JSON object'];
  }

  // Top-level required fields
  if (!body.provider || typeof body.provider !== 'string' || !body.provider.trim()) {
    errors.push('"provider" is required and must be a non-empty string');
  }
  if (!body.tenant_id || typeof body.tenant_id !== 'string' || !body.tenant_id.trim()) {
    errors.push('"tenant_id" is required and must be a non-empty string');
  }
  if (!body.location_id || typeof body.location_id !== 'string' || !body.location_id.trim()) {
    errors.push('"location_id" is required and must be a non-empty string');
  }

  // event object
  if (!body.event || typeof body.event !== 'object') {
    errors.push('"event" is required and must be an object');
    return errors; // no point validating deeper
  }

  const ev = body.event;

  if (!ev.external_event_id || typeof ev.external_event_id !== 'string' || !ev.external_event_id.trim()) {
    errors.push('"event.external_event_id" is required and must be a non-empty string');
  }
  if (!ev.event_type || typeof ev.event_type !== 'string' || !ev.event_type.trim()) {
    errors.push('"event.event_type" is required and must be a non-empty string');
  }
  if (!ev.occurred_at || typeof ev.occurred_at !== 'string') {
    errors.push('"event.occurred_at" is required and must be an ISO 8601 string');
  } else if (isNaN(Date.parse(ev.occurred_at))) {
    errors.push('"event.occurred_at" must be a valid ISO 8601 date-time string');
  }
  if (!ev.currency || typeof ev.currency !== 'string' || ev.currency.trim().length !== 3) {
    errors.push('"event.currency" is required and must be a 3-character currency code (e.g. "USD")');
  }

  // totals
  if (!ev.totals || typeof ev.totals !== 'object') {
    errors.push('"event.totals" is required and must be an object');
  } else {
    for (const field of ['subtotal', 'tax', 'tip', 'total']) {
      if (ev.totals[field] === undefined || ev.totals[field] === null) {
        errors.push(`"event.totals.${field}" is required`);
      } else if (typeof ev.totals[field] !== 'number') {
        errors.push(`"event.totals.${field}" must be a number`);
      }
    }
  }

  // line_items
  if (!Array.isArray(ev.line_items)) {
    errors.push('"event.line_items" is required and must be an array');
  } else if (ev.line_items.length === 0) {
    errors.push('"event.line_items" must contain at least one item');
  } else {
    ev.line_items.forEach((item, i) => {
      if (!item.external_line_id || typeof item.external_line_id !== 'string' || !item.external_line_id.trim()) {
        errors.push(`"event.line_items[${i}].external_line_id" is required`);
      }
      if (item.quantity === undefined || item.quantity === null) {
        errors.push(`"event.line_items[${i}].quantity" is required`);
      } else if (typeof item.quantity !== 'number' || item.quantity <= 0) {
        errors.push(`"event.line_items[${i}].quantity" must be a positive number`);
      }
      if (item.unit_price === undefined || item.unit_price === null) {
        errors.push(`"event.line_items[${i}].unit_price" is required`);
      } else if (typeof item.unit_price !== 'number' || item.unit_price < 0) {
        errors.push(`"event.line_items[${i}].unit_price" must be a non-negative number`);
      }
    });
  }

  return errors;
}

module.exports = { validatePosEventPayload };
