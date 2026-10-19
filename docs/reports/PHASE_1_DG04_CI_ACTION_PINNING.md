# Phase 1 — DG-04 CI Action SHA Pinning

**Status:** Verified and closed 2026-10-19.

## Scope and requirements

- **SRS:** `SEC-13` (dependency hygiene, pinned GitHub Actions) and §11.2 (green CI required).
- **Module contract:** Module 16, “Delivery and evidence”.
- **In scope:** Every third-party `uses:` entry in `.github/workflows/ci.yml`.
- **Out of scope:** First-party shell commands, Docker image pinning, and future workflows; any new workflow must follow this same policy.

## Immutable references

| Action               | Release label | Immutable commit SHA                       | CI uses |
| -------------------- | ------------- | ------------------------------------------ | ------: |
| `actions/checkout`   | `v4.4.0`      | `11d5960a326750d5838078e36cf38b85af677262` |       3 |
| `pnpm/action-setup`  | `v4.4.0`      | `fc06bc1257f339d1d5d8b3a19a8cae5388b55320` |       2 |
| `actions/setup-node` | `v4.4.0`      | `49933ea5288caeca8642d1e84afbd3f7d6820020` |       2 |

The release labels are comments for human review only. The SHA is the executable reference; it cannot move when an upstream tag is retargeted.

## Update and review policy

`.github/dependabot.yml` has a weekly `github-actions` update schedule. For each resulting update PR:

1. Confirm the action repository and release provenance using the upstream GitHub release/commit.
2. Keep a full 40-character commit SHA in every `uses:` reference; do not replace it with a tag or branch.
3. Review the action release notes and permissions, then require normal CI, secret scan, dependency audit and preview checks.
4. Record a security decision if the action adds privileges, network access, or materially changes the build/release supply chain.

## Security and compatibility review

- Workflow-level permissions remain `contents: read`.
- The change does not alter application, database, RLS, API, event, migration, or deployment contracts.
- No credentials, secrets, customer data, or environment values are added.
- Pinning prevents a mutable action tag from silently changing CI behavior; Dependabot keeps pin updates visible and reviewable.

## Verification

Static validation confirmed all seven `uses:` references carry full 40-character SHAs. Scoped Prettier, SRS/`DEVELOPMENT_PLAN.md` mirror, and `git diff --check` validations passed locally.

GitHub Actions run [`39228427320`](https://github.com/ABH36/FreelanCenter/actions/runs/39228427320) ran the pinned workflow and passed format/lint/typecheck/test/build, gitleaks, dependency audit and GitGuardian. Both Vercel previews also completed successfully. This establishes DG-04 closure; every future workflow/action update remains subject to the policy above.
