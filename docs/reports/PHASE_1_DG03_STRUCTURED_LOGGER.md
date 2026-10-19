# Phase 1 — DG-03 Structured Redacting Logger Evidence

**Status:** Verified on 2026-10-17. Shared `@platform/logger` package, deep redaction engine, bare secret-bearing pattern redaction, full Error object serialization, child logger safe merge policy, AsyncLocalStorage correlation ID propagation, safe health endpoint logging, and 38 automated tests passed.

**Recorded:** 2026-10-17 · **Scope:** DG-03 only.

---

## 1. Context and Requirements Addressed

- **Requirement IDs:**
  - `FR-OBS-01`: Structured logging (correlation IDs, `workspace_id` tenant isolation tag, no PII/secrets in logs), log levels, and ambient context.
  - `SEC-05`: Credentials/API keys: no secrets in logs, write-only credential handling.
  - `SEC-15`: Privacy compliance baseline (India DPDP Act 2023, GDPR): no PII (emails, phone numbers, payment cards, national IDs) in logs.
  - `Cross-Module Contracts §Privacy, secrets and observability contract`: Every request/job carries correlation ID; structured logs are redacted.
  - `Documentation Gap Register`: Closes DG-03 ("Redacting structured logger").

- **Exclusions:**
  - External Sentry DSN integration and OpenTelemetry collector export are deferred until production vendor accounts exist (as planned in P0/P1 scope).
  - Authentication, Prisma schema, tenant data modules, and Vercel infrastructure configurations were not modified.

---

## 2. Implementation Summary

### 2.1 Shared Package (`@platform/logger`)

A zero-external-dependency, high-performance structured logger implemented in TypeScript at `packages/logger`, conforming to the monorepo layering architecture (packages do not import apps, pure TypeScript, consumed as source via `exports: ./src/index.ts`).

- **Entry point (`src/index.ts`):** Exports logger constructors, context helpers, and redaction utilities.
- **Context propagation (`src/context.ts`):**
  - Ambient request context management via Node.js `AsyncLocalStorage`.
  - Context interface: `correlationId`, `workspaceId`, `projectId`, `userId`, `app`, `deploymentSurface`, plus arbitrary safe bindings.
  - Server-side UUID v4 generation (`createCorrelationId`).
  - Strict header extraction & sanitization (`getCorrelationIdFromHeaders`): checks `x-correlation-id`, `x-request-id`, `x-trace-id`. Validates with `/^[A-Za-z0-9_-]{1,128}$/` to prevent log injection, CRLF injection, and unbounded header size.
  - Scope utilities: `runWithContext(context, fn)`, `withCorrelationId(id, fn)`, `getLogContext()`.
- **Redaction Engine (`src/redact.ts`):**
  - **Key-name detection:** Normalized token and word-boundary analyzer detecting camelCase, snake_case, kebab-case sensitive keys (e.g. `password`, `secret`, `secretToken`, `totpSecret`, `databaseUrl`, `apiKey`, `creditCard`, `authSecret`) while strictly preventing false positives (e.g. `author`, `authority`).
  - **Inline string patterns:**
    - Authorization headers: Bearer and Basic tokens (`/(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/gi` -> `$1 [REDACTED]`).
    - JSON Web Tokens: standard 3-part base64url format (`/\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g` -> `[REDACTED_JWT]`).
    - Database connection strings & basic auth URLs: `postgres://`, `postgresql://`, `mysql://`, `redis://`, `mongodb://`, `https://` with credentials (`user:password@host` -> `user:[REDACTED]@host`).
    - URL query secrets: `?token=...`, `&apiKey=...`, `&password=...`, `&secret=...` -> replaced with `[REDACTED]`.
    - Cloud & Vendor API keys: Anthropic (`sk-ant-...`), OpenAI (`sk-...`), AWS Access Keys (`AKIA...`), GitHub (`ghp_...`), Stripe/Razorpay (`rzp_...`, `sk_...`), Supabase (`sbp_...`).
    - **Bare secret-bearing patterns:**
      - Bare assignment patterns: `secret=value`, `token: abc`, `api_key=...`, `password: cleartext` -> key preserved, secret redacted to `[REDACTED]`.
      - Verb phrases: `password is cleartext`, `token set to xyz`, `secret equals my-secret` -> verb preserved, secret redacted.
      - Space-separated bare secrets: `password cleartext-value`, `secret my-secret` -> redacted to `password [REDACTED]`.
      - Safe keyword preservation: Whitelist `SAFE_NON_SECRET_FOLLOWING_WORDS` (e.g. `reset`, `update`, `policy`, `rotation`, `bucket`, `limit`, `status`, `format`, `is`, `set`, etc.) ensures legitimate messages like `"password reset completed"`, `"token rotation successful"`, or `"Password policy applied"` are never corrupted or over-redacted.
      - Prefixed secret codes: `ERR_TOKEN_xyz123`, `TOKEN_secretVal` -> sanitized to `ERR_TOKEN_[REDACTED]`.
    - Cookies: `Cookie` and `Set-Cookie` value redaction, preserving safe directives (`Path`, `Secure`, `HttpOnly`, `SameSite`).
    - Common PII: Emails (`[REDACTED_EMAIL]`), Indian mobile and international phone numbers (`[REDACTED_PHONE]`), credit/debit cards (`[REDACTED_CARD]`), Indian Aadhaar national IDs (`[REDACTED_NATIONAL_ID]`).
    - Semantic safety: Designed regexes ensure dates (e.g. `2026-10-17`), ISO timestamps, semantic versions (`16.3.8`), and UUIDs are preserved intact.
  - **Comprehensive Error Object Serialization:**
    - Serializes standard properties: `name`, `message` (redacted), `stack` (redacted).
    - Deeply sanitizes and redacts `Error.code` (both string codes and complex objects).
    - Recursively redacts `Error.cause`.
    - Sanitizes and copies every custom own property (both enumerable and non-enumerable via `Object.getOwnPropertyNames(value)`), ensuring custom error attachments cannot leak secrets or credentials.
  - **Deep object traversal:** Handles primitives, strings, plain objects, arrays, `Error` instances, `Headers`, `URL`, `Map`, `Set`, circular references (`[Circular]`), and depth limit caps (`[MaxDepthExceeded]`).
- **Structured Logger (`src/logger.ts`) & Safe Merge Policy:**
  - Log levels: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. Configurable via `LOG_LEVEL` environment variable.
  - Reserved integrity fields: `RESERVED_LOG_FIELDS = new Set(['timestamp', 'level', 'message', 'correlationId', 'workspaceId', 'projectId', 'userId', 'app', 'deploymentSurface', 'error', 'data'])`.
  - **Safe merge policy:**
    - Child logger bindings are sanitized: any attempt to override reserved integrity fields in child bindings (`logger.child({ correlationId: 'spoofed', app: 'fake' })`) is stripped via `sanitizeBindings`.
    - Authoritative ambient context (`AsyncLocalStorage` containing `correlationId`, `workspaceId`, `projectId`, `userId`, `app`, `deploymentSurface`) is applied _after_ child bindings, guaranteeing that identity fields cannot be hijacked or overridden.
    - Call-site additional data is nested under `data`, with reserved fields stripped.

### 2.2 Health Endpoint Instrumentation

Both Next.js applications (`apps/dashboard` and `apps/sites`) instrumented at `app/api/health/route.ts`:

- Extracts client correlation ID if present and valid; generates server-side UUID if absent or malformed.
- Executes request handling inside `runWithContext`.
- Emits structured log entry with `path: '/api/health'`, `app`, and `deploymentSurface`.
- Echoes safe `x-correlation-id` in response headers for tracing.
- Exposes no credentials, database URLs, or sensitive environment values; `deploymentSurface` is an explicitly configured public marker used for environment verification.

---

## 3. Automated Test Evidence

Automated tests were executed with Vitest across the monorepo workspace:

```text
✓ packages/logger
  ✓ src/__tests__/redact.test.ts (16 tests)
    ✓ redacts Authorization Bearer and Basic headers
    ✓ redacts JSON Web Tokens (JWT)
    ✓ redacts database credentials in connection strings
    ✓ redacts sensitive query parameters in URLs
    ✓ redacts vendor and cloud API keys
    ✓ redacts email addresses
    ✓ redacts credit card numbers
    ✓ redacts national IDs (Indian Aadhaar)
    ✓ redacts phone numbers while preserving dates, timestamps, and semantic versions
    ✓ redacts cookie values while preserving standard directives
    ✓ redacts sensitive keys in plain objects
    ✓ redacts cookie and authorization in headers
    ✓ redacts Error objects including stack trace and cause
    ✓ redacts bare secret-bearing message patterns while preserving non-sensitive text
    ✓ redacts Error.code and all custom Error properties
    ✓ safely handles circular references and depth limits
  ✓ src/__tests__/context.test.ts (6 tests)
    ✓ generates a valid UUID v4 correlation ID
    ✓ sanitizes clean correlation IDs and rejects malicious / invalid ones
    ✓ extracts correlation ID from headers with priority order
    ✓ propagates context via runWithContext across async operations
    ✓ isolates context between concurrent async calls
    ✓ works with withCorrelationId helper
  ✓ src/__tests__/logger.test.ts (10 tests)
    ✓ outputs structured JSON entries with correlationId and timestamp
    ✓ inherits correlationId and workspaceId from ambient AsyncLocalStorage context
    ✓ filters logs below the configured minLevel
    ✓ automatically redacts sensitive data and PII in messages and data payloads
    ✓ redacts error messages and stack traces
    ✓ creates child loggers with merged and redacted bindings
    ✓ strips reserved integrity fields from child logger bindings
    ✓ prevents child logger bindings from overriding ambient correlationId or identity
    ✓ redacts bare secret patterns in message and data fields, emitting no cleartext secrets
    ✓ redacts Error.code and custom Error properties in log payloads

✓ apps/dashboard
  ✓ app/api/health/route.test.ts (3 tests)
    ✓ returns status ok with deploymentSurface and generates correlation ID if absent
    ✓ preserves valid client-supplied correlation ID in header
    ✓ sanitizes malicious or invalid correlation ID headers

✓ apps/sites
  ✓ app/api/health/route.test.ts (3 tests)
    ✓ returns status ok with deploymentSurface and generates correlation ID if absent
    ✓ preserves valid client-supplied correlation ID in header
    ✓ sanitizes malicious or invalid correlation ID headers

Total: 38 automated tests passed (38/38)
```

Linting, typechecking, and build verification:

- `pnpm lint`: 10/10 tasks successful (0 errors, 0 warnings).
- `pnpm typecheck`: 10/10 tasks successful (0 errors).
- `pnpm build`: 2/2 Next.js production builds completed cleanly with Turbopack.

---

## 4. Security and Privacy Review

1. **Information Leakage & Bare Secrets:**
   - All log writes pass through `redactString` and `redact`.
   - Credentials (bare assignment patterns `token=...`, `token: ...`, bare space patterns `password cleartext`, verb phrases `password is ...`, connection strings, cloud keys) and PII (emails, phones, national IDs, credit cards) are scrubbed before serialization.
   - Regression tests verify that the serialized JSON log lines never contain cleartext secret values.
2. **Error Serialization Integrity:**
   - `Error.code` is sanitized against secret tokens and patterns.
   - Every custom own property (enumerable and non-enumerable) attached to `Error` instances is deeply sanitized and redacted.
3. **Child Logger Safe Merge Policy:**
   - Child logger bindings and call-site data cannot overwrite reserved integrity fields (`timestamp`, `level`, `message`, `correlationId`, `workspaceId`, `projectId`, `userId`, `app`, `deploymentSurface`, `error`, `data`).
   - Ambient identity (`workspaceId`, `correlationId`, `userId`, `app`, `deploymentSurface`) is authoritative and always overrides child bindings.
4. **Log Injection & CRLF Injection:**
   - Incoming correlation IDs from HTTP headers are checked against strict regex whitelist `^[A-Za-z0-9_-]{1,128}$`. Any string with newlines (`\r`, `\n`), delimiters, or excessive length is rejected and replaced with a fresh `crypto.randomUUID()`.
5. **Tenant Context Safety:**
   - Ambient `workspaceId` is bound strictly via `AsyncLocalStorage` and cannot bleed into concurrent requests or asynchronous tasks.
6. **Denial of Service (DoS) Mitigation:**
   - Object traversal includes `WeakSet` circular reference detection to prevent infinite recursion.
   - `maxDepth` guard (10 levels) prevents deep stack exhaustion.

---

## 5. Residual Limitations and Decisions

- **Sentry and OpenTelemetry:** Live ingestion endpoints and SDK instrumentation (e.g. Sentry DSN, OTel collector exporter) remain deferred to launch hardening / environment provisioning when enterprise accounts are created. The logger architecture provides the sink and structured context ready for these transports.
- **Traceparent / W3C Tracing:** Correlation IDs are currently formatted as UUID / safe strings matching `x-correlation-id` / `x-request-id`. W3C distributed traceparent propagation can be layered in when OpenTelemetry spans are initialized.

---

**Verdict:** DG-03 is **CLOSED**. Code, tests, security blockers resolution, and evidence verified.
