'use strict';

/**
 * Build a dotted path like "event.line_items[0].quantity" from Zod's path array.
 */
function formatIssuePath(path) {
  if (!path || path.length === 0) return 'request';
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${segment}]`;
    } else {
      out = out ? `${out}.${segment}` : segment;
    }
  }
  return out;
}

/**
 * Normalized issue list for JSON responses.
 */
function formatZodIssues(zodError) {
  return zodError.issues.map((issue) => ({
    path: formatIssuePath(issue.path),
    message: issue.message,
  }));
}

/**
 * Payload for HTTP 400 responses (use from middleware and global error handler).
 */
function validationErrorPayload(zodError) {
  const details = formatZodIssues(zodError);
  const message =
    details.length === 1
      ? `${details[0].path}: ${details[0].message}`
      : 'Request input failed validation. See the details array for each problem.';

  return {
    error: 'Validation failed',
    message,
    details,
  };
}

/**
 * Express middleware: validate req.body, req.params, and/or req.query with Zod schemas.
 * On success, replaces each validated segment with parsed output (coercion / transforms apply).
 *
 * @param {{ body?: import('zod').ZodTypeAny; params?: import('zod').ZodTypeAny; query?: import('zod').ZodTypeAny }} schemas
 */
function validateRequest(schemas) {
  const { body: bodySchema, params: paramsSchema, query: querySchema } = schemas;

  return function validateRequestMiddleware(req, res, next) {
    if (bodySchema) {
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json(validationErrorPayload(parsed.error));
      }
      req.body = parsed.data;
    }

    if (paramsSchema) {
      const parsed = paramsSchema.safeParse(req.params);
      if (!parsed.success) {
        return res.status(400).json(validationErrorPayload(parsed.error));
      }
      req.params = parsed.data;
    }

    if (querySchema) {
      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json(validationErrorPayload(parsed.error));
      }
      req.query = parsed.data;
    }

    next();
  };
}

module.exports = {
  validateRequest,
  validationErrorPayload,
  formatZodIssues,
};
