'use strict';

const pool = require('./pool');

/**
 * Runs callback inside a transaction with SET LOCAL app.current_tenant_id so RLS policies apply.
 * @param {string} tenantId - UUID string
 * @param {(client: import('pg').PoolClient) => Promise<T>} callback
 * @returns {Promise<T>}
 */
async function runWithTenantRls(tenantId, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_tenant_id', $1::text, true)`,
      [tenantId]
    );
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { runWithTenantRls };
