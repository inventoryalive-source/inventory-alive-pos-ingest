'use strict';

const { z } = require('zod');

/**
 * No query parameters allowed (strict). Use for GET routes that do not accept ?key=value.
 */
const emptyQuerySchema = z.object({}).strict();

module.exports = { emptyQuerySchema };
