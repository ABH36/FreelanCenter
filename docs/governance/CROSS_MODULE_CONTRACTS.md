# Cross-Module Contracts

## Goal

These contracts are mandatory shared rules. They prevent teams or AI agents from implementing individually plausible features that cannot safely interoperate.

## Actors and trust boundaries

| Actor                | Trust level                        | May do                                                         | Must never do                                                      |
| -------------------- | ---------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| Visitor              | Anonymous/untrusted                | Read active public version; submit rate-limited lead           | Select arbitrary workspace/project/version or invoke admin actions |
| Client               | Token/portal scoped                | Submit onboarding proposal, comment, approve permitted version | Write a live draft/version or see workspace data                   |
| Workspace member     | Authenticated, role-scoped         | Operate assigned workspace/project                             | Supply their own authorization scope                               |
| Platform admin       | Elevated, MFA/audited              | Support, suspend, moderate                                     | Make invisible, unaudited tenant changes                           |
| Job/provider webhook | Machine identity/untrusted payload | Execute validated, idempotent event work                       | Bypass signature, schema, tenancy or entitlement checks            |
| AI/model             | Untrusted generator                | Propose typed patch/classification                             | Persist data, spend unlimited credits or choose scope              |

## Tenant and authorization contract

1. `workspace_id` is the isolation key on every tenant-owned row; composite foreign keys keep child rows in their parent workspace.
2. Server code resolves actor and membership first. Browser/query parameters are selectors, never proof of access.
3. Each normal tenant operation uses one interactive transaction with transaction-local workspace context and RLS as defined in SRS §5.3/ADR-003.
4. Public/client paths use narrow reviewed functions/policies; they do not inherit member/admin access.
5. Admin, service and migration roles are separate; no routine request uses a bypass-RLS connection.

## Ownership and mutability contract

| Object                  | Owner/scope         | Mutability            | Rule                                                                        |
| ----------------------- | ------------------- | --------------------- | --------------------------------------------------------------------------- |
| Template                | Platform or creator | Semver versioned      | Declarative data only; projects pin a version.                              |
| SiteDraft               | Project/workspace   | Mutable with revision | All edits use optimistic concurrency and ChangeSet/audit.                   |
| SiteVersion             | Project/workspace   | Immutable             | Created by publish; live pointer may change, version cannot.                |
| Asset                   | Project/workspace   | Lifecycle-managed     | Published references remain readable until version retention permits purge. |
| Lead                    | Project/workspace   | Status/notes mutable  | Visitor submission is append/create; retention policy applies.              |
| Credit/financial ledger | Workspace           | Append-only           | Reserve/commit/refund entries, idempotency key required.                    |
| Audit event             | System scope        | Append-only           | Redacted metadata, actor/target/result/correlation required.                |

## Command, event and idempotency contract

Commands validate actor, permission, workspace/project relationship, state transition and entitlement before mutation. A retried externally visible command includes an idempotency key; same key plus same actor/scope returns original outcome, while mismatched payload is rejected. Persist state and an outbox/event record atomically where a job must follow; jobs consume validated payloads and have retry, backoff and DLQ semantics.

Minimum event names are namespaced and versioned, for example `project.created.v1`, `site.version.published.v1`, `lead.created.v1`, `domain.verification.requested.v1`, `billing.webhook.received.v1`. Event payloads contain IDs, not secrets/full PII; consumers reload authorized state.

## State-transition contract

```text
Project: Draft → InReview → Approved → Live → Paused → Archived
Draft: revision n → validated ChangeSet → revision n+1
Publish: SiteDraft@revision n → preflight → immutable SiteVersion → atomic pointer change
Domain: Queued → PendingDNS → Verifying → IssuingSSL → Active | Failed(reason)
AI credit: reserved → committed | refunded
```

Transitions are server-side, audited and idempotent. A failed side effect never advances a public pointer/state prematurely. Rollback creates an audit event and points to a prior immutable version; it does not mutate history.

## Public-host resolution contract

`Host → domain mapping → project → active immutable SiteVersion → renderer`. Resolution must reject unknown/suspended/unverified hosts, use bounded positive/negative cache and invalidate on mapping/pointer change. Staging/review/pitch routes require their token/password policy and are always `noindex` and excluded from production analytics.

## Content, input and output contract

All inputs validate against shared Zod schemas at boundaries. Config, template and patch schemas are versioned. Renderer output is escaped; raw script injection and arbitrary template code are prohibited. Uploads are authenticated/scoped, MIME-sniffed, bounded, EXIF-stripped/re-encoded and scanned where feasible. URLs use allowlists and safe redirect logic. AI and client input create proposals; only validated, authorized acceptance changes a draft.

## Privacy, secrets and observability contract

Collect minimum data, classify it, honour retention/export/deletion policy and avoid PII in logs. Credentials are envelope-encrypted/write-only. Every request/job carries correlation ID; structured logs are redacted; metrics and audit events record outcome without secrets. Security incidents use the incident flow in Module 15.

## Compatibility and rollout contract

APIs/events/schema changes are additive and versioned before destructive removal. Database migrations use expand/contract, are forward-only, reviewed and tested against seed/restore data. Feature flags keep incomplete flows unavailable; rollback conditions and ownership are defined before release. A module cannot declare done until these contracts and its module acceptance evidence pass.
