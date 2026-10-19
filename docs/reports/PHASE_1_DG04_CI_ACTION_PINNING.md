# Phase 1 — DG-04 CI Action SHA Pinning

**Status:** Implemented 2026-10-19; pending CI verification on the pinned workflow before DG-04 closure.

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

Before merge, GitHub Actions must run this exact pinned workflow and pass its existing jobs: format/lint/typecheck/test/build, gitleaks, and dependency audit. `git diff --check` and a static full-SHA check are also required locally.
