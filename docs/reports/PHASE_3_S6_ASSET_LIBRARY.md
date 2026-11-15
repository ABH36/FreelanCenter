# Phase 3, slice S6: asset library (upload, crop, alt text)

> **Decisions S6-1 and S6-2 (below) were delegated by the Owner on 2026-11-15** ("decide what is best and enterprise for us") and taken as recommended: S3Mock for development and CI only, R2 in production; and two buckets (private uploads, public variants).

**Status:** built on `feat/p3-s6-asset-library` (`eae4d35`, `f6a4a09`); **awaiting Owner approval.** **Date:** 2026-11-15 · **Requirements:** FR-BLD-05 (asset library per project: upload, crop, alt text, replace; no Next/Vercel optimizer; fixed WebP widths on R2), SEC-08 (MIME sniffing, size limits, re-encoding, EXIF strip, random keys, safe content disposition, SVG refused), F-05 · **ADR:** 009 · **Module:** 05 · **Design approved by the Owner 2026-11-15.** **New migration:** `20261115180000_p3_s6_assets` (live application needs a separate Owner OK, DG-35).

## 1. Why

Until now every template showed grey "photo here" boxes: there was no way to add a picture. S6 lets a freelancer upload the client's photos and logo, crop them, describe them for screen readers and place them on the site, without the platform ever serving an untrusted file.

## 2. What was built

**Database: `app.assets`** (one row per image, RLS like drafts).

- Status moves once: `pending → ready` (with its widths and size) or `pending → rejected` (with a reason code). The trigger sets the actors and times, keeps what was uploaded (name, type, size, storage token) unchanged, and makes hiding one-way.
- **200 images per project** (approved). Counted by the trigger under a per-project advisory lock, so uploads started at the same moment cannot pass a full library (`P5104`, tested with 5 concurrent uploads for 2 places).
- Members read; owners, admins and editors write while the workspace is writable and the project is not archived. **No DELETE grant**: the row is the record of the upload.

**Upload pipeline** (`packages/workspaces/src/assets.ts`, `image.ts`):

| Step       | What happens                                                                                                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Request | The server checks the declared type (JPEG, PNG, WebP; **HEIC and SVG refused**) and size (**10 MB**), records a pending row with a random 128-bit storage token and returns a **10-minute signed PUT** whose signature covers the type and exact length                        |
| 2. Upload  | The browser sends the file **straight to the private upload bucket**. No file passes through a Vercel function body                                                                                                                                                            |
| 3. Finish  | The server reads it back (byte cap, counted while streaming), **sniffs the magic bytes**, decodes it under a **40-megapixel** limit, turns it upright and re-encodes **WebP q78 at 400/800/1200/1600** (never upscaled). Every metadata block (EXIF, GPS, XMP, ICC) is dropped |
| 4. Store   | Variants go to the public bucket with `Cache-Control: immutable` and `Content-Disposition: inline`. **The original is deleted.** The row becomes ready or rejected with a plain-language reason. Repeating the call returns the same outcome                                   |

- Keys never use the file name: `uploads/ws/<workspace>/<asset>/<token>` (private) and `ws/<workspace>/<asset>/<token>/<width>.webp` (public).
- **Storage adapter** in `@platform/providers` (`createS3Storage`): plain S3 API over SigV4 (aws4fetch), no SDK. Same code for R2 in production and S3Mock locally. Seven `ASSET_*` variables; none set means uploads are off and the editor says so; some set is a loud error.

**Editor:**

- A new **"Images"** part: upload, a default description per image, **crop**, delete.
- Every image field in the forms (logo, hero, about, gallery items and any other `assetRef`) shows the chosen picture with **its own required description** and "Choose image", which opens the library in a dialog (pick, or upload and pick). A gallery gets "Add image". When an image has no default description, the field starts from the file name ("Pulse logo") for the person to correct, because the site schema requires one.
- Choosing an image is a normal draft change: it needs the edit lock, autosaves, shows in the preview and can be undone. Uploading, describing, cropping and deleting do not change the site, so they need edit rights but not the lock.
- **Crop (part 2):** Square 1:1, Standard 4:3 or Wide 16:9, with two sliders. The preview uses the same placement rule as the server, so the picture shown is the picture made. Because originals are not kept, a crop is cut from the largest variant and saved as a **new image**; the source and the pages that use it do not change.

**Rendering:** the editor preview resolves the draft's image ids to variant URLs (`renderAssets`, hidden images included so pages that use them keep them) and its CSP allows the asset origin in `img-src` only. Unknown ids keep the template placeholder.

**Deleting is hiding** (approved): the image leaves the library, its files stay, so drafts and published versions never break. Cleaning unused files is retention work (P8).

## 3. Findings and deviations

| ID   | Finding                                                                                                                                                                       | Consequence                                                                                                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S6-1 | **Deviation from the approved design.** MinIO no longer publishes container images (Docker Hub and quay.io both refuse the pull)                                              | Development and CI use **Adobe S3Mock 5.2.3** (pinned by digest, released 2026-09-19). It speaks the same S3 API. It does not check signatures; R2 does, and the signing is unit-tested |
| S6-2 | **Deviation, stronger than approved.** The design said "private uploads prefix". R2's public access (r2.dev) is per bucket, so a prefix in a public bucket would be reachable | **Two buckets:** private `uploads`, public `assets`                                                                                                                                     |
| S6-3 | A `CHECK` passes on NULL, so "ready needs a width" let a ready row without width through in the first test run                                                                | The ready and rejected rules are wrapped in `coalesce(..., false)`. Found by the new test before anything left this machine                                                             |
| S6-4 | The site schema allows 200 characters of alt text; the first library version allowed 250                                                                                      | Aligned at 200 in the service and the UI (the table keeps 250 as an outer bound)                                                                                                        |
| S6-5 | sharp is a native module of about 30 MB                                                                                                                                       | Loaded only when an upload is finished or cropped, so other dashboard pages do not pay for it at cold start                                                                             |
| S6-6 | A crop re-encodes an already re-encoded WebP (originals are deleted, approved)                                                                                                | Slight quality loss on a cropped image; not visible at q78 in the tests. Keeping originals would need a retention decision (P8)                                                         |

## 4. Security review

- **IDOR:** six new server actions (`requestAssetUpload`, `finishAssetUpload`, `listAssets`, `describeAsset`, `hideAsset`, `cropAsset`) and the preview's image lookup are registered with the isolation harness and probed with another workspace's ids: same answer as an id that never existed, and B's library unchanged.
- **Tenant isolation:** `assets` is in the per-table matrix (select, insert, update, delete across tenants, raw SQL and Prisma).
- **Untrusted files (SEC-08):** the declared type is only a hint. The magic bytes decide, the decoder must agree with them, and a pixel limit stops decompression bombs. SVG, HTML, PDF, GIF and HEIC are refused, also when renamed `.jpg`. Only re-encoded WebP is ever served, without metadata (tested: an EXIF artist name and GPS do not survive). Originals are private and deleted.
- **Keys and URLs:** random 128-bit tokens, no user text in keys, key validation refuses `..`, `//` and absolute paths. Upload URLs expire after 10 minutes and are bound to one type and length.
- **Authorization:** a viewer cannot start, finish, crop, describe or hide (also tested: a viewer cannot make the server process an editor's upload). Archived projects and read-only workspaces refuse uploads.
- **Logs and audit:** audit rows carry ids, sizes, widths and reason codes only, never file names. Credentials are never logged.
- **CSP:** the preview allows images from the asset origin only; still no script source, `frame-ancestors 'self'`.

## 5. Tests and evidence

| Check                         | Result                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DB `assets-model.test.ts`     | **7/7**: starts pending, moves once, shape rules, nothing uploaded changes, hiding is one-way, no DELETE, viewer read-only, archived project, **200 cap under 5 concurrent uploads**                                                                                                                                                          |
| DB catalog                    | `assets` and `assets_guard` registered; every tenant table still has context-bound policies                                                                                                                                                                                                                                                   |
| `@platform/providers` storage | signed URL covers `content-length;content-type;host`, no secret in the URL, key escapes refused, byte cap with and without Content-Length, https outside local hosts, partial config is an error                                                                                                                                              |
| Image unit tests              | **9/9**: sniffing (SVG, HTML, PDF, GIF, HEIC refused), widths, EXIF/GPS strip and upright, size and pixel limits, mislabelled and truncated files, crop placement and shape                                                                                                                                                                   |
| Asset service on S3Mock       | **8/8**: upload → WebP variants without metadata → original deleted → idempotent → listed and rendered; SVG rejected; missing upload; input, role and configuration checks; alt and hide; cross-workspace NOT_FOUND; crop                                                                                                                     |
| Isolation suite               | **339/339**, including the `assets` matrix and every new action                                                                                                                                                                                                                                                                               |
| e2e                           | **17/17**. New journey: open Images, upload a photo (ready), crop it to 16:9 (a new image), upload an SVG named and typed as a JPEG (refused with the server reason), choose the photo as the logo (the description starts from the file name and is edited), see it in the preview from the asset origin as WebP without the EXIF name, undo |

## 6. CI-equivalent

The full CI-equivalent ran on `f6a4a09` in a clean worktree (`C:/Users/Lenevo/s6-ci`), every step of `.github/workflows/ci.yml`. **34 of 36 steps passed.**

| Step                                                   | Result                                                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| install (frozen lockfile), format, sync-plan, lint     | pass                                                                                                                                 |
| typecheck, unit tests, traceability, build, audit      | pass                                                                                                                                 |
| db: bootstrap twice, migrate, configure, drift, verify | pass; `db:verify` 39/39 (new: `app_public` cannot read `assets`); no drift                                                           |
| db integration, with the coverage gate, and again      | **167/167** both times                                                                                                               |
| isolation suite, mutation check                        | **339/339**; 13/13 mutations killed                                                                                                  |
| auth ×3, workspaces, jobs, hosting                     | pass; workspaces 192/192 (S6 service suite on S3Mock included)                                                                       |
| e2e                                                    | **17/17**                                                                                                                            |
| a11y, Lighthouse                                       | 114/114; Lighthouse 99–100 performance and 100 accessibility, SEO and best practices on all three templates                          |
| perf (informational)                                   | pass                                                                                                                                 |
| visual, browsers                                       | **fail: the known Windows-only failures** (screenshot baselines are Linux; WebKit/Firefox on Windows). Templates are unchanged by S6 |

**The first full run (on `eae4d35`) found three real problems, fixed in `f6a4a09`:**

1. The lockfile carried a sharp specifier that the repository's sharp override rewrites, so `pnpm install --frozen-lockfile` (GitHub CI) would have failed.
2. A test fixture typed `as const` was refused by Prisma's types (typecheck).
3. The DB suite's auto-discovered scoping test needs a seed row in every tenant table; `assets` had none.

An earlier attempt reported success without running anything: an old folder blocked the worktree and pnpm found no projects. The script now refuses to run outside a real checkout.

gitleaks found no leaks in the S6 commits. GitHub CI is the reference.

## 7. What the Owner needs to do before uploads work on production (DG-35)

1. **Cloudflare R2** (may ask for a payment method; free tier 10 GB storage, no egress fee):
   - bucket `uploads`: private; lifecycle rule "delete objects after 1 day"; CORS rule allowing `PUT` with header `content-type` from `https://dashboard-liard-tau-14.vercel.app` (and the Preview domain if previews should upload);
   - bucket `assets`: public access through r2.dev until the asset domain exists (DG-33);
   - an R2 API token with object read and write on these two buckets only.
2. **Vercel** (Production and Preview): `ASSET_S3_ENDPOINT`, `ASSET_S3_REGION=auto`, `ASSET_S3_ACCESS_KEY_ID`, `ASSET_S3_SECRET_ACCESS_KEY`, `ASSET_UPLOAD_BUCKET=uploads`, `ASSET_PUBLIC_BUCKET=assets`, `ASSET_PUBLIC_URL=<r2.dev URL>`. I can prepare a script like the S0 one so no value is typed into chat.
3. **Live migration** `20261115180000_p3_s6_assets`, with a separate OK, after the PR merges.
4. **Extension check** on production: upload, crop, use as logo, preview, a refused fake photo.

## 8. Open items

- Publishing (S7) must carry the resolved image URLs into the immutable site version (the sites app has no asset lookup yet).
- AVIF is optional in ADR-009 and not generated; WebP covers every supported browser.
- Retention of hidden and unused images, and of crop sources: P8.
