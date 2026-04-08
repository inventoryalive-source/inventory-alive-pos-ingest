# RBAC Design — Inventory Alive SaaS

**Document Version:** 1.0  
**Last Updated:** April 8, 2026  
**Status:** Approved for implementation

---

## Overview

Inventory Alive uses Role-Based Access Control (RBAC) to enforce what each user can see and do within the platform. Every authenticated request passes through the authorization middleware which checks both the user's role and their tenant_id before any operation is permitted.

There are four roles in the system:

| Role | Scope | Description |
|------|-------|-------------|
| `platform_admin` | All tenants | Ryan (system owner) — full access across the entire platform |
| `tenant_admin` | Own tenant only | Restaurant/business owner or manager |
| `staff` | Own tenant only | Servers, bartenders, floor staff |
| `read_only` | Own tenant only | Accountants, silent partners, observers |

---

## Role Definitions

### platform_admin
> System-level access. This role is assigned only to the Inventory Alive platform owner.

- Access to all tenants simultaneously
- Can create, suspend, and delete tenant accounts
- Can view all audit logs across all tenants
- Can override any tenant setting
- Can manage subscription tiers and feature flags
- Can access all system-level configuration
- Cannot be created from within the tenant dashboard

---

### tenant_admin
> Full control within their own tenant. Cannot see or touch any other tenant's data.

- Access to their own tenant only — enforced at middleware level
- Can invite staff and read_only users via email
- Can assign and change roles within their tenant
- Can revoke access for any user in their tenant
- Can configure inventory settings and alert thresholds
- Can view full audit log for their tenant
- Can manage SKU mappings and bulk CSV uploads
- Can configure scanner usage quotas
- Can connect POS integration *(see note below)*
- Can view all reports and analytics
- Can manage By-the-Glass settings
- Can export PDF reports and send low-stock emails

---

### staff
> Operational access only. Can perform daily inventory tasks, cannot change any settings.

- Access to their own tenant only — enforced at middleware level
- Can view current inventory
- Can use the AI label scanner (subject to tenant quota)
- Can confirm and process guest orders via the staff dashboard
- Can perform By-the-Glass order confirmations
- Cannot invite or manage other users
- Cannot change any settings or thresholds
- Cannot view the audit log
- Cannot access SKU mapper or POS settings
- Cannot export data or send emails

---

### read_only
> View-only access. Zero write permissions anywhere in the system.

- Access to their own tenant only — enforced at middleware level
- Can view current inventory and stock levels
- Can view reports and analytics
- Cannot confirm orders or use the scanner
- Cannot make any changes of any kind
- Cannot view the audit log
- Cannot export data or send emails

---

## Cross-Tenant Isolation

Every database query is scoped by `tenant_id`. The authorization middleware (`assertTenantAccess`) runs on every route and verifies:

1. The request carries a valid, non-expired access token
2. The user's `tenant_id` matches the resource being requested
3. The user's role permits the operation being attempted

Any attempt to access another tenant's data returns `403 Forbidden`. Cross-tenant access tests are written and must pass before this phase is marked complete.

---

## POS Integration — Subscription Tier Note

POS integration (Toast, Square) is accessible to `tenant_admin` role only. However, visibility of the POS connection option is also gated by the tenant's subscription tier.

The permission check follows this order:

1. **Role check** — Is the user a `tenant_admin`? If not → deny.
2. **Feature flag check** — Does this tenant's subscription include POS integration? If not → show upgrade prompt.
3. **Both pass** → POS connection settings are shown and accessible.

This means roles control **who** can perform an action. Subscription tiers control **what features are unlocked**. These are two separate systems that operate in sequence.

The subscription/feature flag system will be implemented in a later phase. For now, the role permission is documented here as `tenant_admin` only.

---

## Permissions Matrix

| Operation | platform_admin | tenant_admin | staff | read_only |
|-----------|:--------------:|:------------:|:-----:|:---------:|
| View inventory | ✓ | ✓ | ✓ | ✓ |
| Add inventory item | ✓ | ✓ | ✗ | ✗ |
| Edit inventory item | ✓ | ✓ | ✗ | ✗ |
| Archive inventory item | ✓ | ✓ | ✗ | ✗ |
| Use AI label scanner | ✓ | ✓ | ✓ | ✗ |
| Confirm guest orders | ✓ | ✓ | ✓ | ✗ |
| Confirm glass orders | ✓ | ✓ | ✓ | ✗ |
| View audit log | ✓ | ✓ | ✗ | ✗ |
| Invite users | ✓ | ✓ | ✗ | ✗ |
| Manage roles | ✓ | ✓ | ✗ | ✗ |
| Configure alert thresholds | ✓ | ✓ | ✗ | ✗ |
| Manage SKU mappings | ✓ | ✓ | ✗ | ✗ |
| Bulk CSV import | ✓ | ✓ | ✗ | ✗ |
| Connect POS integration* | ✓ | ✓* | ✗ | ✗ |
| Configure scanner quotas | ✓ | ✓ | ✗ | ✗ |
| Export PDF reports | ✓ | ✓ | ✗ | ✗ |
| Send low-stock emails | ✓ | ✓ | ✗ | ✗ |
| View all tenants | ✓ | ✗ | ✗ | ✗ |
| Create/suspend tenants | ✓ | ✗ | ✗ | ✗ |
| Manage subscription tiers | ✓ | ✗ | ✗ | ✗ |

*\* tenant_admin POS access also requires subscription tier feature flag*

---

## Implementation Notes

- Roles are stored on the `tenant_memberships` table alongside `tenant_id` and `user_id`
- Role is checked server-side on every request — client-side role checks are for UI only and are never trusted
- No privilege escalation is possible from the client
- `platform_admin` is assigned directly in the database — it cannot be granted through any UI
- All role changes are written to the audit log with actor, timestamp, and previous value
