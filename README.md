# Inventory Alive POS Ingest

A minimal, production-ready **Node.js / Express** API that receives normalized POS events and stores them in **Neon Postgres**.

---

## Project structure

```
inventory-alive-pos-ingest/
├── src/
│   ├── app.js                          # Express entry point
│   ├── db/
│   │   ├── pool.js                     # pg Pool singleton
│   │   ├── migrate.js                  # Migration runner
│   │   └── migrations/
│   │       └── 001_initial_schema.sql  # DDL: tenants, locations, pos_events, pos_event_lines
│   ├── middleware/
│   │   └── auth.js                     # x-ia-secret header check
│   ├── routes/
│   │   └── posEvents.js                # POST /api/pos/events
│   └── validators/
│       └── posEvent.js                 # Payload validation
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

---

## Prerequisites

| Tool | Version |
|------|---------|
| Node.js | ≥ 18 |
| npm | ≥ 9 |
| Neon Postgres | any (Postgres 15 recommended) |

---

## Setup

### 1. Clone and install

```bash
git clone <your-repo-url>
cd inventory-alive-pos-ingest
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in your values (see **Environment variables** section below).

### 3. Run the database migration

```bash
npm run migrate
```

This will create the following tables in your Neon database:
- `tenants`
- `locations`
- `pos_events`
- `pos_event_lines`
- `_migrations` (internal migration tracking)

### 4. Start the server

```bash
# Production
npm start

# Development (with auto-reload via nodemon)
npm run dev
```

The API will boot, confirm a DB connection, and listen on `http://localhost:3000` (or the `PORT` you set).

---

## Environment variables

Copy `.env.example` to `.env` and set the following:

```dotenv
# Neon Postgres connection string
# Find this in your Neon dashboard → Connection Details
DATABASE_URL=postgres://your_user:your_password@your-neon-host.neon.tech/your_dbname?sslmode=require

# Shared secret — sent by all callers in the x-ia-secret header
IA_INGEST_SECRET=change_me_to_a_strong_random_secret

# Port to listen on (optional, defaults to 3000)
PORT=3000
```

> **Never commit `.env` to source control.** The `.gitignore` already excludes it.

---

## Running migrations manually in Neon

If you prefer to run the SQL directly in the Neon SQL editor or via `psql`:

```bash
psql "$DATABASE_URL" -f src/db/migrations/001_initial_schema.sql
```

Or paste the contents of `src/db/migrations/001_initial_schema.sql` directly into the **Neon Console → SQL Editor** and click **Run**.

---

## API Reference

### `GET /health`

Liveness check — no authentication required.

**Response**
```json
{ "ok": true }
```

---

### `POST /api/pos/events`

Ingest a normalized POS event.

**Required header**
```
x-ia-secret: <your IA_INGEST_SECRET>
Content-Type: application/json
```

**Request body**
```json
{
  "provider": "toast",
  "tenant_id": "tnt_123",
  "location_id": "loc_abc",
  "event": {
    "external_event_id": "toast:loc_abc:check_998877:close:1700000123",
    "event_type": "SALE",
    "occurred_at": "2026-02-26T02:12:00Z",
    "external_order_id": "check_998877",
    "currency": "USD",
    "line_items": [
      {
        "external_line_id": "li_1",
        "external_item_id": "toast_menu_444",
        "name": "Cabernet Sauvignon Glass",
        "quantity": 2,
        "unit_price": 18.00
      }
    ],
    "totals": { "subtotal": 36.00, "tax": 0.00, "tip": 0.00, "total": 36.00 }
  }
}
```

**Responses**

| Status | Body | Meaning |
|--------|------|---------|
| `200` | `{"status":"received","pos_event_id":"<uuid>"}` | Event stored successfully |
| `200` | `{"status":"duplicate"}` | Event already exists (idempotent) |
| `400` | `{"error":"Validation failed","details":[...]}` | Invalid payload |
| `401` | `{"error":"Missing required header: x-ia-secret"}` | Auth header missing |
| `401` | `{"error":"Invalid x-ia-secret"}` | Wrong secret |
| `500` | `{"error":"Internal server error"}` | Unexpected server error |

---

## curl example

```bash
curl -X POST http://localhost:3000/api/pos/events \
  -H "Content-Type: application/json" \
  -H "x-ia-secret: change_me_to_a_strong_random_secret" \
  -d '{
    "provider": "toast",
    "tenant_id": "tnt_123",
    "location_id": "loc_abc",
    "event": {
      "external_event_id": "toast:loc_abc:check_998877:close:1700000123",
      "event_type": "SALE",
      "occurred_at": "2026-02-26T02:12:00Z",
      "external_order_id": "check_998877",
      "currency": "USD",
      "line_items": [
        {
          "external_line_id": "li_1",
          "external_item_id": "toast_menu_444",
          "name": "Cabernet Sauvignon Glass",
          "quantity": 2,
          "unit_price": 18.00
        }
      ],
      "totals": { "subtotal": 36.00, "tax": 0.00, "tip": 0.00, "total": 36.00 }
    }
  }'
```

**Expected response (first call)**
```json
{"status":"received","pos_event_id":"a1b2c3d4-..."}
```

**Expected response (duplicate call with same external_event_id)**
```json
{"status":"duplicate"}
```

---

## Idempotency design

The `pos_events` table has a database-level unique constraint:

```sql
UNIQUE (tenant_id, location_id, provider, external_event_id)
```

The insert uses `ON CONFLICT ON CONSTRAINT uq_pos_events_idempotency DO NOTHING`. If `rowCount === 0` after the insert, the caller receives `{"status":"duplicate"}` and no line items are re-inserted. This is safe for retries and at-least-once delivery scenarios.

---

## Security

- All `/api/*` routes require the `x-ia-secret` header to match `IA_INGEST_SECRET`.
- The server fails closed: if `IA_INGEST_SECRET` is not set, all requests are rejected with `500`.
- Neon SSL is enforced via `sslmode=require` in the connection string.
- Raw payloads are stored in `pos_events.raw_event` (jsonb) for audit and future reprocessing.

---

## What's NOT included (intentional)

- Inventory deduction / mapping logic
- Webhook delivery
- Worker / queue processing of `pending` events
- Multi-tenancy row-level security (future: add Postgres RLS)
- Rate limiting (add `express-rate-limit` before deploying publicly)
