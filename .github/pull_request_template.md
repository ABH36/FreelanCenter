## What and why

<!-- One paragraph. Reference requirement IDs (e.g. FR-AUTH-01, SEC-10) and any ADR. -->

## Requirements covered

-

## Checklist

- [ ] Tests added/updated; `pnpm check` passes locally
- [ ] Any new tenant table has `workspace_id`, forced RLS, composite FKs **and** is covered by the isolation suite
- [ ] No secrets, tokens or real personal data in code, fixtures or logs
- [ ] Untrusted input is validated (Zod) and authorisation is checked in the data layer, not only the UI
- [ ] No `dangerouslySetInnerHTML`; no cross-imports between apps
- [ ] Docs/ADR updated if a decision changed; `pnpm traceability` output committed if the SRS changed
- [ ] Evidence for the phase report attached (test output, screenshots, numbers)
