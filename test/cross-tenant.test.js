'use strict';

process.env.IA_INGEST_SECRET = 'test-ingest-secret';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

process.env.IA_INGEST_TENANT_KEYS = JSON.stringify({
  [TENANT_A]: 'test-ingest-secret',
  [TENANT_B]: 'test-ingest-secret',
});

jest.mock('../src/db/pool', () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

const request = require('supertest');
const pool = require('../src/db/pool');
const app = require('../src/app');

function authHeaders(tenantId) {
  return {
    'x-ia-secret': process.env.IA_INGEST_SECRET,
    'x-tenant-id': tenantId,
    'content-type': 'application/json',
  };
}

function validPosEventBody(tenantId, externalEventId) {
  const t = new Date().toISOString();
  return {
    provider: 'toast',
    tenant_id: tenantId,
    location_id: 'loc_1',
    event: {
      external_event_id: externalEventId,
      event_type: 'SALE',
      occurred_at: t,
      currency: 'usd',
      totals: { subtotal: 10, tax: 1, tip: 2, total: 13 },
      line_items: [
        { external_line_id: 'line_1', quantity: 1, unit_price: 10 },
      ],
    },
  };
}

/** Minimal pg client mock for runWithTenantRls (BEGIN → set_config → … → COMMIT). */
function rlsClientMock(queryImpl) {
  return {
    query: jest.fn((sql, params) => queryImpl(sql, params)),
    release: jest.fn(),
  };
}

describe('cross-tenant access (x-tenant-id vs body / DB scope)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/pos/events', () => {
    it('returns only rows scoped to the requesting tenant (tenant_A)', async () => {
      const eventRow = {
        id: '00000000-0000-0000-0000-0000000000a1',
        tenant_id: TENANT_A,
        location_id: 'loc_1',
        provider: 'toast',
        external_event_id: 'ext-a',
        event_type: 'SALE',
        occurred_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      };

      pool.connect.mockResolvedValue(
        rlsClientMock((sql, params) => {
          if (String(sql).includes('set_config')) {
            expect(params[0]).toBe(TENANT_A);
            return Promise.resolve({ rows: [] });
          }
          if (String(sql).trim().startsWith('SELECT')) {
            expect(params[0]).toBe(TENANT_A);
            return Promise.resolve({ rows: [eventRow] });
          }
          return Promise.resolve({ rows: [] });
        })
      );

      const res = await request(app)
        .get('/api/pos/events')
        .set(authHeaders(TENANT_A));

      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(1);
      expect(res.body.events[0].tenant_id).toBe(TENANT_A);
      expect(pool.connect).toHaveBeenCalledTimes(1);
    });

    it('does not return another tenant\'s data when using tenant_B', async () => {
      pool.connect.mockResolvedValue(
        rlsClientMock((sql, params) => {
          if (String(sql).includes('set_config')) {
            return Promise.resolve({ rows: [] });
          }
          if (String(sql).trim().startsWith('SELECT')) {
            if (params[0] === TENANT_A) {
              return Promise.resolve({
                rows: [
                  {
                    id: '00000000-0000-0000-0000-0000000000a1',
                    tenant_id: TENANT_A,
                    location_id: 'loc_1',
                    provider: 'toast',
                    external_event_id: 'secret-a',
                    event_type: 'SALE',
                    occurred_at: new Date().toISOString(),
                    created_at: new Date().toISOString(),
                  },
                ],
              });
            }
            return Promise.resolve({ rows: [] });
          }
          return Promise.resolve({ rows: [] });
        })
      );

      const res = await request(app)
        .get('/api/pos/events')
        .set(authHeaders(TENANT_B));

      expect(res.status).toBe(200);
      expect(res.body.events).toEqual([]);
    });
  });

  describe('POST /api/pos/events', () => {
    it('returns 403 when x-tenant-id does not match body tenant_id', async () => {
      const body = validPosEventBody(TENANT_A, 'evt-mismatch-1');

      const res = await request(app)
        .post('/api/pos/events')
        .set(authHeaders(TENANT_B))
        .send(body);

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Access denied' });
      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('allows POST when header and body tenant_id match (tenant_A)', async () => {
      const mockClient = {
        query: jest.fn((sql) => {
          if (String(sql).includes('set_config')) {
            return Promise.resolve({ rows: [] });
          }
          if (String(sql).includes('INSERT INTO pos_events')) {
            return Promise.resolve({
              rowCount: 1,
              rows: [{ id: '00000000-0000-0000-0000-0000000000e1' }],
            });
          }
          if (String(sql).includes('INSERT INTO pos_event_lines')) {
            return Promise.resolve({ rowCount: 1, rows: [] });
          }
          return Promise.resolve({ rows: [] });
        }),
        release: jest.fn(),
      };

      pool.connect.mockResolvedValue(mockClient);

      const body = validPosEventBody(TENANT_A, 'evt-match-1');

      const res = await request(app)
        .post('/api/pos/events')
        .set(authHeaders(TENANT_A))
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('received');
      expect(pool.connect).toHaveBeenCalled();
    });
  });
});
