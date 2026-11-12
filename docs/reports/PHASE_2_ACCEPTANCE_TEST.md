# Phase 2 acceptance test (Owner, through the Claude extension)

**Purpose:** the Owner's design review and hands-on check of Phase 2 (condition C2 of the Phase 2 report). The extension drives Chrome on the Owner's machine against a **local** copy of the product (synthetic data, no live system). The Owner sends the extension's report back to Claude, who fixes what it finds and answers every point in writing.

**Start the environment (Claude does this, or the Owner runs it):**

```
pnpm --filter @platform/db db:setup
pnpm --filter @platform/db db:seed-templates
pnpm --filter @platform/e2e acceptance          # once, to create the test account (dev mail box)
pnpm --filter @platform/e2e acceptance --prod   # the environment for the test: production builds, no hot reload
```

**Run 1 (2026-11-12) found that the development servers' hot reload reloaded the sign-up and sign-in pages every few seconds in the extension's Chrome** (finding A-1 below), so the test now runs on production builds, and the test account `tester1@example.test` is created and verified in advance (production builds have no dev mail box).

Dashboard `http://localhost:3000` · sites `http://localhost:3001` · preview links open on `http://preview.sites.localhost:3001` · mail box for the sign-up e-mail `http://localhost:3000/dev/mailbox`.

---

## The message to give the extension (copy everything below this line)

You are testing a website-builder product for freelancers and small agencies in India. A freelancer signs up, picks a ready-made website design (a "template") for a client's business, and sends the client a private preview link so the client can see their own website idea before paying. You are the tester: look at this like a demanding freelancer and like that freelancer's client, and report honestly. Do not be polite; I need the problems.

**Environment (local test copy, fake data only).** Dashboard: http://localhost:3000 . Preview links open on http://preview.sites.localhost:3001 . First page loads are slow (the development server compiles each page the first time): wait up to 30 seconds before calling something broken. Use only invented data (fake names, a fake business). Never enter any real personal information. If something looks unsafe or you are unsure, stop and tell me.

**Take a screenshot at each numbered step marked (shot), at the widest width you can get (if the side panel limits it to about 890 px, say so in the report) and, for the preview pages, also at phone width (about 390 px).**

### Part 1. Sign in and set up (about 10 minutes)

1. Open /sign-up and review the page only (do not submit: the test account already exists). Below the security check there is a short status line; with the test set-up the check passes on its own and the line disappears. (shot)
2. Open /sign-in and sign in with the test account: e-mail `tester1@example.test`, password `Accept-Test-Pass-2026-local` (a throw-away password for this local test copy only). You should land on "Create your first workspace".
3. Create a workspace (fake agency name, a short address such as `tester-one`). Then create one project (business name, for example "Sharma Fitness"). (shot)
   Note: any confusing wording, missing explanation, slow step or error message. Is it clear what to do next at every step?

### Part 2. Share a template preview (about 10 minutes)

4. In the workspace, open **Templates**. There should be three templates: Gym Bold, Taxi Quick, Wedding Royal. (shot)
5. For each template, enter a prospect business name (Gym Bold: "Sharma Fitness"; Taxi Quick: "City Cabs Indore"; Wedding Royal: "Royal Vivah Events"), keep 7 days, and press **Create preview link**. Copy each link. Does the page explain clearly what the link does and who can open it?
6. Open each link in a NEW tab (they open on preview.sites.localhost:3001).

### Part 3. Design review of each template (main part, about 15 minutes per template)

For **each** of the three preview pages, scroll the whole page at desktop width and again at phone width (use the browser's device toolbar or resize to about 390 px). Rate each point 1 (poor) to 5 (excellent) and write one sentence of reason:

- First impression in 5 seconds: can a stranger tell what business this is and what to do next?
- Visual quality: does it look professional and modern, or like a cheap template? Colours, fonts, spacing, alignment, consistency between sections.
- Readability: all text easy to read? Any text hard to see against its background (very important, check every coloured section and every card)?
- Hierarchy and layout: is the most important thing the biggest? Any section that feels empty, crowded, or out of place?
- Buttons and links: do WhatsApp, Call, email and map buttons look clickable and sensible? Click them (they should open WhatsApp/phone/mail/map links; do not sign in anywhere).
- Navigation: the menu, the in-page jump links (they must stay inside the preview and keep the address starting with /p/), the menu on the phone, the footer.
- The floating WhatsApp/call button: does it ever cover important content?
- Scroll animations: do they feel smooth and tasteful, or distracting or janky?
- The "Preview of ... template / demo content" banner and the prospect's business name: is it clear this is a preview, and does the business name appear where it should?
- Images are grey placeholders on purpose for now (real photos come later): judge whether the layout would still work with real photos, and where photos matter most.
- Anything broken: overlapping text, cut-off text, horizontal scrolling, wrong order, odd gaps, anything that looks like a bug.
- Would you, as a freelancer, send this to a client today? What exactly would stop you? Give your top 5 improvements for this template, most important first.

### Part 4. Preview link behaviour (about 10 minutes)

7. Click through the menu items inside a preview: the address must keep the `/p/...` part and never leave the preview.
8. Edit one character in the middle of a preview link and open it: you should see a calm "This preview link is not valid" page. (shot)
9. Back in the dashboard, Templates page, scroll to **Your preview links**: your three links should be listed as Active. Press **Turn off** on one of them (confirm). The page should say it worked, and the list should show it as Turned off. (shot)
10. Reload that link in the preview tab: you should see "This preview link was withdrawn". Another link of yours must still work. (shot of both)
    Note: is "Turn off" clear and safe-feeling? Is the confirmation wording clear? Would a freelancer understand the status labels?

### Part 5. Dashboard review (about 15 minutes)

11. Visit every dashboard page once: Overview, Projects, a project page, New project, Templates, Members, Notifications, Audit log, Settings, and your account Security settings. For each, note anything confusing, ugly, cramped, mis-aligned, in the wrong language or tone, or missing. (shot of each)
12. Make the browser window phone-narrow (about 390 px) and visit Overview, Projects and Templates again. Does everything fit and stay usable?
13. Keyboard only: on the Templates page, use only Tab, Shift+Tab, Enter and Space. Can you reach and use every control? Is the keyboard focus always clearly visible?
14. Zoom the page to 200 % and back. Does anything overlap or disappear?

### Part 6. What is NOT built yet (do not report these as bugs)

There is no website editor yet (coming in the next phase), no publishing, no custom domains, no payments, no real e-mail sending, the contact form on the sites does nothing yet, images are placeholders, and there are only three templates. The preview pages are English only for now.

### Report format (send everything back in this structure, in Hinglish or English)

A. **Summary:** 5 lines: is this at a professional, enterprise level? What is the biggest strength and the biggest weakness?
B. **Ratings table** for each template: the 12 points of Part 3 with a score 1 to 5 and one sentence each.
C. **Problems list:** number each problem; for each give severity (Blocker / Major / Minor / Polish), the exact page address, what you did, what you expected, what happened, and a screenshot reference.
D. **Top 5 improvements per template** (from Part 3) and **top 5 improvements for the dashboard**.
E. **Anything you were unsure about**, and anything you could not test (and why).

---

## After the test (Claude's side)

1. Every problem in the report gets an answer: fixed (with the change and a test), or explained, or turned into a tracked decision for the Owner.
2. Fixes follow the usual path: tests, clean-worktree run, Owner approval, PR, green CI.
3. The Owner's reply to the Phase 2 report (acknowledgements 1 to 3) plus the answered acceptance report close condition C2 and C3; then the Phase 2 audit can be closed as "approved with conditions" (C1, C4, C5 stay tracked).

## Findings log

| ID  | Run | Severity                   | Finding                                                                                                                                                                                                                                                                                                                                                                    | Resolution                                                                                                                                                                               |
| --- | --- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-1 | 1   | Blocker (test environment) | Sign-up and sign-in reloaded every 2.5 to 3 seconds in the extension's Chrome, wiping the form. Cause: the development servers' hot-reload connection; sign-in has no CAPTCHA and looped too, and the server log showed 81 sign-up loads. The Turnstile widget stayed empty only because the page reloaded before it rendered. Not reproducible in a plain headless Chrome | The test runs on production builds (`acceptance --prod`): one load in 12 s, sign-in works. A production deployment has no hot reload, so users are not affected                          |
| A-2 | 1   | Minor                      | The empty security-check box left an unexplained gap                                                                                                                                                                                                                                                                                                                       | The widget now shows a status line: "Loading the security check…", "Complete the security check above to continue.", or "Couldn’t load the security check. Your details are kept. Retry" |
| A-3 | 1   | Polish                     | The brand reads "P Platform", a placeholder                                                                                                                                                                                                                                                                                                                                | **Owner decision needed:** the product name (and a logo) to show in the dashboard                                                                                                        |
| A-4 | 1   | Polish                     | "Create account" disabled with no hint                                                                                                                                                                                                                                                                                                                                     | Covered by A-2: the status line says what is missing                                                                                                                                     |
| A-5 | 1   | Note                       | A failed security check must never reload the page or clear the form                                                                                                                                                                                                                                                                                                       | Confirmed in code: there is no reload anywhere in the auth forms; the error path now shows Retry                                                                                         |
