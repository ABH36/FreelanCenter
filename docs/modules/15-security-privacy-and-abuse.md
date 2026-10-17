# 15 — Security, Privacy and Abuse Prevention

**Status:** Cross-cutting; P3 baseline, P8 launch gate. **SRS:** SEC-01..21, FR-ABU-01..06, FR-ONB-04, FR-LEAD-01/07.

## Outcome

Protect tenant data, client data, visitors and the public hosting platform throughout its lifecycle. Security is implemented in each feature, then independently verified before launch.

## Controls

- RLS plus server authorization for tenant separation; no service-role use in normal request paths.
- Input schemas, output encoding, CSP/security headers, CSRF/origin protections and safe redirects.
- Malware/file validation, rate limits/captcha, abuse reporting, blocklists and takedown workflow for public sites.
- Encryption in transit/at rest and envelope encryption for integrations; key rotation process.
- Data classification, purpose/retention/deletion/export with audit trail; no PII/secrets in logs.
- Dependency/supply-chain scanning, pinned CI actions, incident runbooks, backups and restore testing.

## Incident flow

```text
Detect/report → triage severity → contain (suspend/key revoke/feature flag)
→ preserve redacted evidence → notify required parties → remediate
→ verify → post-incident review and control update
```

## Evidence / gate

Threat model is updated per phase; security tests cover auth/RLS/IDOR/XSS/SSRF/upload/webhook replay/rate-limit bypass. Run external penetration test before launch (SEC-18), backup restore drill, privacy/legal review and abuse-response exercise. Read `SECURITY.md`, threat model, privacy inventory and data classification documents; none are substitutes for legal counsel.
