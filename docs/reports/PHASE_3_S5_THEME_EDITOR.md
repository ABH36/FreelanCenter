# Phase 3, slice S5: theme editor

**Status:** built on `feat/p3-s5-theme-editor`; awaiting the Owner's approval of the slice. **Date:** 2026-11-15 · **Requirement:** FR-BLD-04 (colours with contrast warnings, fonts from the allow-list, radius, button style, shape and hover, motion preset) · **Module:** 05 · **Design and four decisions approved by the Owner 2026-11-15.** No migration.

## 1. Why

After S3 and S4 a freelancer could change the content and structure of a site, but not its look. S5 adds the brand: colours, fonts and shapes, with guard rails so the site stays readable.

## 2. What was built

**`@platform/ui`:**

- `contrastChecks(colors, buttonStyle)`, available from a new subpath `@platform/ui/color` that does not import the schema, so it can run in the browser.
  - It covers the same six WCAG 2.1 AA pairs as before: text on background and on surface, button label on button, primary on background and on surface, and accent on background.
  - `contrastIssues(theme)` now delegates to it, so the editor and the preflight can never disagree.
- `THEME_PALETTES`: Deep blue, Warm saffron, Forest green, Royal maroon, Midnight and Clinic teal (decision 2). A test checks that each passes every check with every button style.

**Editor: a "Theme" part under "Business details"** (`editor/theme-form.tsx`):

| Group           | What can be changed                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| Colours         | Palette buttons; a picker and a hex field for each of the 6 colours, each saying what it is used for              |
| Text            | Heading and body font from the allow-list. On a Hindi site, fonts without Hindi letters are marked. Text size     |
| Shape and space | Corner radius, spacing                                                                                            |
| Buttons         | Style, shape, hover                                                                                               |
| Motion          | None, subtle or energetic. Reduced motion for visitors who ask for it is always honoured and cannot be turned off |

- **Contrast warnings (decision 1):** as soon as a pair falls below AA, a warning shows the pair, its ratio and the required ratio, for example "text on background: 1:1 (needs 4.5:1)". Saving is not blocked, and S7's preflight shows the warning again.
- Every change autosaves through the existing `updateTheme` operation, shows in the preview and can be undone.
- **No new theme tokens (decision 3):** the existing ones cover the three templates. New tokens will be added when a template needs one.
- **S4 follow-up (decision 4):** the "Add section" panel says where the section will go, for example "Will be added after Services" or "at the end of Home".

## 3. Findings

| ID   | Finding                                                                                                                                                                                            | Consequence                                                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| S5-1 | **Bug.** The editor's "selected page no longer exists" fallback treated the new Theme selection as a page and sent the person back to Business details                                             | The check now runs only for page selections                                                                                 |
| S5-2 | **Bug.** For one render after switching parts, the form still held the previous part's value. The theme form read the business details as a theme and the page crashed ("This page couldn't load") | The theme form gets the working value only when it is a theme, and the draft's theme otherwise                              |
| S5-3 | Chromium exposes `<input type="color">` as a textbox, so "Primary" matched the picker and the hex field in the test                                                                                | The test targets the hex field by its full label. The picker has its own name ("Primary colour picker")                     |
| S5-4 | Twice, the local e2e run stopped before the editor because the Turnstile test token did not arrive while the development server was still compiling the sign-up page                               | This is not related to S5 and the next runs passed. It is a known local development-server issue; GitHub CI is not affected |

## 4. Security review

- **No new action or route:** theme changes go through the existing `saveDraftChangeAction`, which is IDOR-probed and checks the lock, the revision and RLS.
- **Validation:** the theme part of the patch (`updateTheme`) is closed. Colours must be hex, fonts must come from the allow-list, and every option must be a known value. The server validates the whole SiteConfig.
- **Untrusted input:** hex fields are plain text inputs, validated on the client for feedback and on the server for truth. Nothing becomes CSS except through the renderer's token compiler, which only emits known variables.
- **Accessibility:** contrast is checked as colours are chosen. Every palette passes. Reduced motion is enforced by the schema (`reducedMotionRespected: true`).

## 5. Tests and evidence

| Check              | Result                                                                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@platform/ui`     | 33/33, including the palette checks with every button style and the unchanged theme and contrast tests                                                                                                                                     |
| e2e                | **16/16**. New journey: open Theme, apply Deep blue (saved, "All colour pairs are easy to read"), set white text and see the contrast warning (still saved), reload and see the colour kept, then two undos restore the template's colours |
| Full CI-equivalent | section 6                                                                                                                                                                                                                                  |

## 6. CI-equivalent

The full run on `3c9cdaf` was done in a clean worktree. **36 steps passed**, including Lighthouse, a11y and e2e.

The only failures are the known local ones:

- **Visual and browsers:** Windows only.
- **Perf:** this machine was under load. The same test also fails on `main` here.

gitleaks found no leaks in the S5 commits. GitHub CI is the reference.
