# 08 — Client Onboarding and Portal

**Status:** Planned (P5). **SRS:** FR-ONB-01..07.

## Outcome

Collect accurate client business content with minimal friction while preserving agency review and data boundaries. Client input is a proposal, never an unreviewed live-site write.

## Flow

```text
Freelancer issues project-scoped magic link → client opens mobile wizard
→ manifest-driven validation + resumable draft + secure uploads
→ proposed ChangeSet → freelancer reviews diff → accepts into SiteDraft
→ staging/review/publish flow
```

Magic links are ≥128-bit random, stored hashed, scoped, expiring and revocable. The onboarding manifest comes from the selected template and maps each field to a validated config path. Portal access has limited project-level permissions: view status/leads, approve a version and create a change request/comment.

## Safety and operations

Validate upload MIME/content/size, strip EXIF, re-encode and scan where feasible. Never expose workspace membership or other projects through token enumeration. Reminder jobs are idempotent and opt-out/consent aware; English/Hindi copy is versioned. White-label branding is presentation-only and cannot change authorization.

## Evidence

Test token expiry/revocation/race, resume behavior, manifest validation, client-to-proposal isolation, upload abuse, portal role denial, notifications and Hindi fallback. Upstream: template manifest, projects, assets, review. Downstream: publishing, leads and notifications.
