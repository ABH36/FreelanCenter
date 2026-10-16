# AI Agent Handoff Protocol

## Goal

Allow multiple AI agents to work safely without contradictory architecture, invented implementation status or hidden dependency changes.

## Required input for every task

Provide the agent the exact target module file, relevant SRS requirement IDs, linked ADRs, current phase, permitted file scope and a precise acceptance test. State that `SRS.md` is frozen and deviations require an ADR.

## Required agent output

1. Files inspected and changed.
2. Requirement IDs satisfied and requirements deliberately not touched.
3. API/schema/event changes and compatibility impact.
4. Security/tenant/permission review.
5. Tests run with result; unrun tests and reason.
6. Open questions, risks and proposed ADRs.
7. Phase-report evidence update.

## Guardrails

- Do not claim planned features are implemented.
- Do not bypass RLS, add an unscoped service client or trust browser workspace IDs.
- Do not add arbitrary template JS, raw scripts, secrets in client code, or unvalidated AI writes.
- Do not edit `DEVELOPMENT_PLAN.md` directly; change `SRS.md` only after approved ADR and regenerate its mirror.
- Keep work small: one module slice/requirement cluster per PR. Do not silently fix unrelated files.

## Definition of done

Implementation, type safety, relevant automated tests, security/error paths, telemetry/audit events, documentation status update and review evidence are all present. A passing UI demo alone is never complete.
