'use strict';

process.env.IA_INGEST_SECRET = 'test-ingest-secret';
process.env.IA_INGEST_TENANT_KEYS = JSON.stringify({
  tenant_A: 'test-ingest-secret',
  tenant_B: 'test-ingest-secret',
});

jest.mock('../src/db/pool', () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

const request = require('supertest');
const pool = require('../src/db/pool');
const app = require('../src/app');

const TENANT_A = 'tenant_A';
const TENANT_B = 'tenant_B';

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

describe('cross-tenant access (x-tenant-id vs body / DB scope)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/pos/events', () => {
    it('returns only rows scoped to the requesting tenant (tenant_A)', async () => {
      pool.query.mockImplementation((sql, params) => {
        expect(params[0]).toBe(TENANT_A);
        return Promise.resolve({
          rows: [
            {
              id: '00000000-0000-0000-0000-0000000000a1',
              tenant_id: TENANT_A,
              location_id: 'loc_1',
              provider: 'toast',
              external_event_id: 'ext-a',
              event_type: 'SALE',
              occurred_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
            },
          ],
        });
      });

      const res = await request(app)
        .get('/api/pos/events')
        .set(authHeaders(TENANT_A));

      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(1);
      expect(res.body.events[0].tenant_id).toBe(TENANT_A);
      expect(pool.query).toHaveBeenCalledTimes(1);
      const [, params] = pool.query.mock.calls[0];
      expect(params[0]).toBe(TENANT_A);
    });

    it('does not return another tenant\'s data when using tenant_B', async () => {
      pool.query.mockImplementation((_sql, params) => {
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
      });

      const res = await request(app)
        .get('/api/pos/events')
        .set(authHeaders(TENANT_B));

      expect(res.status).toBe(200);
      expect(res.body.events).toEqual([]);
      expect(pool.query).toHaveBeenCalledWith(
        expect.any(String),
        [TENANT_B]
      );
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
        query: jest.fn(),
        release: jest.fn(),
      };
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ id: '00000000-0000-0000-0000-0000000000e1' }],
        }) // INSERT event
        .mockResolvedValueOnce(undefined) // line insert
        .mockResolvedValueOnce(undefined); // COMMIT
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
