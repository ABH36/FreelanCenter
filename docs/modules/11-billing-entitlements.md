# 11 — Billing and Entitlements

**Status:** Planned (P6). **SRS:** FR-BIL-01..06, FR-AI-04, FR-MKT-08.

## Outcome

Convert plans, quotas, subscriptions, top-ups and marketplace rights into one server-enforced decision system.

## Contract

`can(workspace, feature)` and `remaining(workspace, quota)` are the only application-facing entitlement APIs. Plans/limits are data, not UI constants. Payment webhooks are signature-verified, stored once by provider event ID, processed asynchronously and reconciled against provider state.

```text
Checkout/provider event → verify + dedupe → billing state transition
→ entitlement projection → audit/notification → feature gate reads projection
```

Downgrade behavior for over-quota sites/domains, failed renewals, grace periods, refunds and credit expiry must be explicitly designed before launch. UI may show limits but API/job paths must re-check them.

## Evidence

Provider sandbox tests for replayed/out-of-order webhooks, failed payment, cancellation, proration, top-up, refund and entitlement race. Contract tests keep provider adapters interchangeable. Finance events are immutable and retained; no card/payment secrets are stored. Payment/payout vendor selection remains blocked until the approved decision/spike.
