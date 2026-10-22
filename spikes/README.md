# Spikes

Disposable experiments that answer one question each. **Not product code**: nothing under `apps/` or `packages/` may import from here. Each has a report in [`docs/spikes/`](../docs/spikes) that states plainly what was and was not measured.

| Spike                    | Question                                                          | Status                                            |
| ------------------------ | ----------------------------------------------------------------- | ------------------------------------------------- |
| A - domains              | Vercel Domains API vs Cloudflare for SaaS                         | not executed (runbook only)                       |
| [B](spike-b-rls-pooling) | Do Prisma 7 + RLS + a transaction-mode pooler isolate tenants?    | executed locally (Docker)                         |
| [C](spike-c-ai-patch)    | Does structured output + validation + repair hold up?             | offline half executed; live half needs an API key |
| D - payments             | Razorpay vs Stripe Connect for Indian creators                    | not executed (research only)                      |
| [E](spike-e-images)      | What do image variants cost to make and deliver?                  | measured (one photo) + modelled                   |
| [F](spike-f-better-auth) | Does Better Auth work on Prisma 7 + pooler without weakening RLS? | executed locally (Docker); Google live run manual |
| [G](spike-g-inngest)     | Do Inngest retry, idempotency, dead-letter and signing hold up?   | executed locally (Docker) + live on Inngest Cloud |

Scripts are named `spike:*` on purpose so `pnpm test` / Turborepo never run them (Spike B needs Docker).
