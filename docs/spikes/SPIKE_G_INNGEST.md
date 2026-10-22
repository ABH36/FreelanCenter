# Spike G - Inngest durable jobs: retry, idempotency, dead-letter, signed requests (DG-06)

**Status: LOCAL PROOF PASSED (2026-10-22); live Inngest Cloud run pending (Owner account needed).** Automated suite **RUNS**. ADR-007 stays **Proposed** until the Owner ratifies it.
Code: [spikes/spike-g-inngest](../../spikes/spike-g-inngest) · Raw results: `spikes/spike-g-inngest/results/spike-g-results.json`
Reproduce: `cd spikes/spike-g-inngest && pnpm spike:up && pnpm spike:test` (needs Docker; about 3 minutes, most of it real retry backoff).

## Question

ADR-007 chose Inngest as a working assumption with no SDK trial. Phase 1 Task 0(b), slice S3 and gap DG-06 require one real function with retry/backoff, an idempotency key, a dead-letter path, signed requests (SEC-06), a per-workspace concurrency key, ids-only payloads, local dev experience and the live Inngest app, before any job-dependent feature (S5 invitation email) relies on it.

## Setup (what was actually run)

| Item          | Value                                                                                                                                                                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK           | `inngest` **4.22.0** (exact pin; released 2026-10-06, the newest release at least two weeks old)                                                                                                                                                   |
| Server        | `inngest/inngest:v1.46.0` running **`inngest start`** (self-hosted build of the Cloud executor), started with an event key and a signing key. Unlike `inngest dev`, this mode rejects unkeyed events and signs every request to the app.           |
| App mode      | SDK client in **cloud mode** (`isDev: false`) with event key and signing key, i.e. the production code path, including signature verification                                                                                                      |
| Serve adapter | `inngest/next` - the `GET`/`POST`/`PUT` Web `Request -> Response` handlers that `app/api/inngest/route.ts` exports in Next 16 - behind a plain node server on port 3939, which records every request and response with headers and raw bodies      |
| Function      | `notification.email.v1` (id `notification-email-v1`), event `notification/email.requested`, payload `{workspaceId, notificationId}` only; steps `load-notification` -> `send-email` -> `mark-sent`; `retries: 3`; `onFailure` writes a dead letter |
| Collaborators | In-process stand-ins (`src/world.ts`): the notification row (holds the recipient - PII never enters the payload), an email provider that de-duplicates on an idempotency key like Resend/Postmark, the dead-letter list and an alert hook          |
| Signature     | Independent implementation of the wire format (`src/signature.ts`, node `crypto`), so the SDK is not verified with itself                                                                                                                          |

### The function under test

```ts
client.createFunction(
  {
    id: 'notification-email-v1',
    triggers: [{ event: 'notification/email.requested' }],
    retries: 3,
    idempotency: 'event.data.notificationId', // one run per notification (24 h)
    concurrency: [{ key: 'event.data.workspaceId', limit: 1 }], // per-workspace fairness
    onFailure: deadLetter, // after the last retry, or at once on NonRetriableError
  },
  async ({ event, step, attempt }) => {
    const ids = parseIdsOnly(event.data); // else NonRetriableError
    const row = await step.run('load-notification', () => load(ids)); // product: withWorkspace (RLS)
    await step.run('send-email', () => provider.send(row, { idempotencyKey: ids.notificationId }));
    await step.run('mark-sent', () => markSent(ids.notificationId));
  },
);
```

Producers never call `inngest.send` directly; they call `requestNotificationEmail(client, ids)`, which validates the ids-only shape and derives a deterministic event id (`notification-email:<notificationId>`).

## Results

| #   | Claim (SRS id)                                                                                                        | Result        | Evidence (ranges over the 4 runs; last run in the results file)                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | The app syncs over the signed cloud-mode path                                                                         | **Confirmed** | `PUT` -> `200 Successfully registered`                                                                                                                |
| G2  | Happy path: one run, one email, row marked sent; the stored event carries only ids (SRS 8.7, privacy inventory)       | **Confirmed** | event `data` keys exactly `notificationId, workspaceId`; latency event -> email **HAPPY**                                                             |
| G3  | A transient provider failure is retried after a backoff delay; completed steps are memoized, not re-run (SRS 8.7)     | **Confirmed** | 3 attempts, gaps **RETRYGAPS**; `load-notification` ran once                                                                                          |
| G4  | Steps are at-least-once: a crash after the provider accepted re-runs the step; the provider idempotency key saves it  | **Confirmed** | 2 provider calls, 1 email delivered, 1 duplicate suppressed by the key (finding G-3)                                                                  |
| G5  | Two events with different ids for one notification produce one run (function idempotency key)                         | **Confirmed** | 2 events -> 1 load, 1 send, nothing more 8 s after completion                                                                                         |
| G6  | The same event id sent twice produces one run (event-id de-duplication; retried producer)                             | **Confirmed** | 2 sends -> 1 load                                                                                                                                     |
| G7  | The sender helper refuses anything but `{workspaceId, notificationId}` (UUIDs)                                        | **Confirmed** | extra `email` key and a non-UUID id both throw before any network call                                                                                |
| G8  | A PII payload that bypasses the helper fails without retries and is dead-lettered                                     | **Confirmed** | `NonRetriableError`; 0 loads, 0 sends; dead letter after **PII** (finding G-4)                                                                        |
| G9  | One workspace's runs never overlap; different workspaces run in parallel (concurrency key)                            | **Confirmed** | same workspace: 3 x 2.5 s sends, 0 overlaps, max in flight 1; three workspaces: 2 overlaps                                                            |
| G10 | A permanently failing run makes 1 + 3 attempts, then the failure handler dead-letters it with ids only and alerts     | **Confirmed** | 4 attempts, gaps **DLQGAPS**; dead letter after **DLQ**; record keys `at, error, functionId, notificationId, runId, workspaceId`; row still `pending` |
| G11 | Every executor request and every SDK response is signed; both verify with the independent implementation (SEC-06)     | **Confirmed** | **SIGNED** requests and responses verified                                                                                                            |
| G12 | Missing, wrong-key, tampered-body, expired (-6 min), future (+6 min) and malformed signatures are rejected (SEC-06)   | **Confirmed** | all six `401`, function not executed                                                                                                                  |
| G13 | A request signed by the independent signer is accepted; a captured signed request **replays** within the 5-min window | **Confirmed** | fresh `206`; replay of a 72-121 s old request `206`, the function re-executed, still 1 email (finding G-2)                                            |
| G14 | Dev mode disables signature checks; `INNGEST_DEV` switches it on unless `isDev` is set explicitly                     | **Confirmed** | forged unsigned request executed in dev mode (`206`); env only -> `dev`, env + `isDev: false` -> `cloud` (finding G-1)                                |
| G15 | Events with a wrong event key are refused                                                                             | **Confirmed** | `401 Event key not found`                                                                                                                             |
| G16 | Unsigned `GET` introspection reveals nothing                                                                          | **Confirmed** | `401 {"message":"Unauthorized"}`                                                                                                                      |

Local developer experience: `pnpm spike:up` starts the server in about 5 s; the UI at `http://localhost:8288` shows runs, step output and retries. No account or network access is needed.

## Findings that change the plan or the product configuration

| ID  | Finding                                                                                                                                                                                                                                                                                           | Severity | Consequence                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G-1 | The SDK **skips signature verification entirely whenever it is in dev mode**, and dev mode is switched on by the `INNGEST_DEV` env var (set to `1` or to a dev-server URL) when `isDev` is not set. One stray env var in production would make the job endpoint accept forged requests (G14).     | S1       | Mandatory: `packages/jobs` sets `isDev` explicitly from validated config (`true` only for local development), and startup fails when `VERCEL_ENV` is `preview`/`production` and either `isDev` is true or `INNGEST_SIGNING_KEY` is missing. Test both. |
| G-2 | Signatures carry a timestamp but no nonce; the SDK accepts any correctly signed request up to **5 minutes** old (and up to 5 minutes in the future). A captured request re-executes the function (G13). Exposure needs a TLS break or a log that stores request bodies with headers.              | S3       | Mandatory: every side-effecting step is idempotent on a stable domain key (provider idempotency key or a unique constraint), which is also what SEC-06 "idempotent" requires. Never log `X-Inngest-Signature` with bodies.                             |
| G-3 | Steps are **at-least-once**: a step that crashes after its side effect is executed again on retry (G4). Memoization only covers steps whose result was recorded.                                                                                                                                  | S2       | Mandatory: provider calls send an idempotency key derived from the domain id (`notificationId`); DB writes are upserts or guarded by unique constraints. Recorded in the jobs contract.                                                                |
| G-4 | Inngest stores the full event payload (a cross-border processor, ADR-013). The in-function ids-only check **detects** a PII payload (G8) but the PII is already stored by then; only the sender-side check prevents it.                                                                           | S2       | Mandatory: product code emits events only through typed helpers in `packages/jobs` that validate the ids-only shape; an ESLint/architecture rule forbids `inngest.send`/`step.sendEvent` elsewhere. The privacy inventory row is updated.              |
| G-5 | Retry timing is set by the server, with jitter: gaps between attempts were **GAPRANGE** here, and `retries: 3` reached the dead letter after about **DLQAPPROX**. Inngest has **no built-in dead-letter table**; `onFailure` is the only hook.                                                    | S3       | The product failure handler writes a workspace-scoped `job_dead_letter` row (RLS, ids + error class only) and raises an alert (Sentry, S9), so SRS 8.7 "DLQ with alerting" is ours to build. Use `RetryAfterError` for provider `429`/`Retry-After`.   |
| G-6 | An **unauthenticated `PUT`** to the serve endpoint made the app re-sync itself with the server (G1 used an anonymous `PUT`). The target and the key are fixed by config, so it cannot be redirected, but it is a free outbound call.                                                              | S4       | Rate-limit the route at the edge (SEC-19) and log syncs.                                                                                                                                                                                               |
| G-7 | `inngest` 4.22.0 pulls in the OpenTelemetry Node SDK and auto-instrumentations (about 2,200 lockfile lines), including a `protobufjs` install script (denied in `pnpm-workspace.yaml`, it only prints a warning) and unmet `@opentelemetry/api` peer ranges (installed 1.10.0, wanted `<1.10.0`). | S4       | `pnpm audit` and the SEC-13 install-script gate keep covering it. Before S5 imports it into `apps/dashboard`, measure the function bundle size and check whether the OTel peer mismatch matters at runtime.                                            |

## Limits (stated plainly)

- **Live Inngest Cloud run not done yet.** It needs an Inngest account (Owner action). The same 16 tests run against Cloud with `SPIKE_G_LIVE=1`, `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` and `SPIKE_G_SERVE_ORIGIN` (a temporary public tunnel to port 3939); results go to `results/spike-g-live-results.json`. Cloud backoff, region and retention are unverified until then.
- **Self-hosted server, not Cloud.** `inngest start` is the open-source build of the Cloud executor; the SDK path is identical, but queueing, limits and timing under Cloud load are not measured.
- **Collaborators are stand-ins.** The row lookup mimics RLS visibility; the real job will read through `withWorkspace` (S1) and is covered by the isolation suite once S5 adds it. The provider is a fake; real delivery is DG-10.
- **Not measured:** Vercel deployment of the route (product work in S5), the 24-hour idempotency window length, a failure inside `onFailure`, the app endpoint being down during a run, replaying failed runs from the Inngest UI, cron (`retention.sweep`), throttle (Vercel domain limits, ADR-005), throughput and cost.

## Recommendation

Accept ADR-007 (Inngest) **with the mandatory configuration above** (G-1 to G-5), with `packages/jobs` as the only place that creates the client, defines functions and emits events. DG-06 closes after the live Cloud run and the Owner's ratification of ADR-007.
