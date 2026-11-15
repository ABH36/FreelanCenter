# Phase 3, slice S4: sections and pages

**Status:** built on `feat/p3-s4-sections-pages`; **approved by the Owner 2026-11-15.** **Date:** 2026-11-15 · **Requirement:** FR-BLD-03 (add, remove, duplicate, hide, reorder sections and pages; change block variants), plus FR-BLD-08 for keyboard use · **Module:** 05 · **Design and three decisions approved by the Owner 2026-11-15.** No migration in this slice.

## 1. Why

S3 let a freelancer change the content of the sections a template brings. S4 lets them change the structure: which sections a page has and in what order, which layout each one uses, and which pages the site has.

## 2. What was built

**Patch operations** (`@platform/schema`, the closed list that AI in P4 will also use; the change is additive):

| Operation    | Behaviour                                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `addPage`    | Adds a page at an optional index. Adds a navigation link to it unless `addToNavigation: false`                                    |
| `removePage` | Removes the page and every navigation link to it (its path, or an anchor on it). Refuses the home page (`/`) with a clear message |
| `movePage`   | Reorders the pages                                                                                                                |

- Every operation is still validated against the whole SiteConfig: unique page ids and paths, page limits, and link targets.
- The committed `patch.schema.json` was regenerated. The test that compares it with the Zod schemas guards against drift.

**Placeholder content** (`sampleSection`, approved decision 1):

- Every block has starting content such as "Your headline here", so a new section shows in the preview at once.
- `SAMPLE_TEXTS` lists these texts for S7's preflight, which will warn when one is left before publishing.

**Undo.** A page operation stores the whole page list and navigation as one snapshot (`restorePages`). If a patch adds a page and fills it in the same step, the page snapshot covers both.

**Editor** (`editor/structure.tsx`):

- **Selected section toolbar:** Move section up/down, Hide section/Show section, Duplicate section, Delete section (with an in-page "Sure?" confirmation), and Layout (the variant).
- **"+ Add section"** under every page: choose the block and the layout. The new section goes after the selected section, or at the end.
- **Page settings,** opened by clicking a page's name: rename, move the page up or down, delete. The home page cannot be deleted; deleting a page also removes its navigation links (decision 2).
- **"+ Add page":** the address is made from the name and kept unique, for example `/offers` or `/offers-2`.
- Changing a section's type is not offered (decision 3): add a new section instead.
- Every structure change saves at once, is validated on the server and can be undone. Everything is a button, so it all works from the keyboard.

## 3. Findings

| ID   | Finding                                                                                                                                                                                               | Consequence                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| S4-1 | Two buttons on the same screen were both named "Move up": the section toolbar and a list item in the FAQ form. Screen-reader users could not tell them apart, and the e2e test hit the same ambiguity | The toolbar buttons now name what they act on: "Move section up", "Hide section", "Duplicate section" |
| S4-2 | The navigation entry of a hidden section was announced as "Faq(hidden)": the visible gap came only from a CSS margin                                                                                  | A real space was added; it is now "Faq (hidden)"                                                      |
| S4-3 | The first e2e version assumed the template had no FAQ section, but Gym Bold has one                                                                                                                   | The test now counts relative to the sections already on the page                                      |

## 4. Security review

- **Untrusted input:**
  - The new operations go through the same closed `patchSchema`.
  - The result is validated as a whole SiteConfig.
  - Removing the home page is refused in the operation itself, and the schema requires a `/` page anyway.
- **Undo:** the inverse operations (`restorePages`) are made by the server. Clients cannot send them.
- **Authorization:** no new action or route. Every change goes through `saveDraftChangeAction` (S3), which the IDOR harness already probes, so the lock, the revision and RLS apply as before.
- **Size:** a page snapshot can be large. An inverse over 256 KB is refused with `CHANGE_TOO_LARGE` rather than stored partially.

## 5. Tests and evidence

| Check                   | Result                                                                                                                                                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema: page operations | 9/9 (add with and without a navigation link, duplicate id or path refused, remove with its navigation links, home page refused, move)                                                                                                                                                    |
| Schema: `sampleSection` | 25/25: every variant of all 12 blocks is valid and accepted by a page                                                                                                                                                                                                                    |
| Builder inverse (unit)  | 15/15, including add/remove/move page and "add a page and fill it in the same patch"                                                                                                                                                                                                     |
| e2e                     | **15/15**. New journey: add an FAQ with placeholder content (it shows in the preview), duplicate, move up, hide (marked "(hidden)"), delete with confirmation, add the page "Offers" (linked in the site's navigation), delete it, undo restores it, and the home page cannot be deleted |
| Full CI-equivalent      | section 6                                                                                                                                                                                                                                                                                |

## 6. CI-equivalent

Full run in a clean worktree on `a1ce053`: **35 steps passed**. They cover install, format, lint, typecheck, unit tests, build, audit, the database suites, isolation and the mutation suite, auth, workspaces, jobs, hosting, e2e and a11y. gitleaks found no leaks in the S4 commits.

Four steps failed:

- **Visual and browsers:** fail only on Windows, as on every run.
- **Perf:** fails under machine load here, and also fails on `main` on this machine.
- **Lighthouse:** `wedding-royal` dropped below 90 because Total Blocking Time rose under CPU load. A rerun passed: gym-bold 93, taxi-quick 100, wedding-royal 99, and accessibility 100 on all three.

S4 does not touch the renderer or the templates. GitHub CI is the reference.
