# 13 — Integrations and Source Export

**Status:** Planned (P7B; credential vault P7A). **SRS:** FR-INT-01..05, FR-EXP-01..06.

## Outcome

Connect a workspace’s approved external accounts and offer verified, licence-compliant portability without exporting another tenant’s data or reusable paid-template IP.

## Credential and provider contract

All credentials are write-only UI fields, envelope-encrypted using AES-256-GCM with per-record data keys and key versioning. Decryption occurs only inside the adapter execution path; values are never logs, analytics or API responses. Provider adapters define capability, validation, retry and error normalization; no UI calls providers directly.

## Export flow

```text
Authorized project request → entitlement + licence check → snapshot exact version
→ assemble only project config/assets/licence manifest → isolated build/Lighthouse job
→ malware-safe signed download → expiry + immutable audit record
```

Offer Next.js and static HTML as SRS-defined. Export is denied when licence disallows it, but own content/assets/leads remain exportable as JSON/CSV/archive. GitHub App uses least privilege and repo scope; Vercel OAuth creates only user-authorized projects.

## Evidence

Automated export build plus Lighthouse smoke test is mandatory before download. Test paid-licence denial, content-only export, cross-project leakage, stale job/retry, revoked integration, secret redaction, GitHub permission scope and Vercel deployment callback validation. Read SRS §6.14 and marketplace licence rules.
