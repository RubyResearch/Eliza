<!-- Fill every visible section. Keep every evidence row visible; use N/A with a concrete reason when a row does not apply. -->

# Relates to

<!--
Link the issue, ticket, or Project card. For agent/kanban work, follow
CONTRIBUTING.md and keep the Project item status current.
-->

Definition of Done: full standard in [`CONTRIBUTING.md`](../CONTRIBUTING.md).

- [ ] This PR targets `develop` and is rebased onto the latest `origin/develop`
      with zero conflicts (`git fetch origin && git rebase origin/develop`).
- [ ] `bun install` and `bun run verify` were run after sync, or any failure is
      recorded below with the exact unrelated blocker.
- [ ] A reviewer can confirm the change works without reading the code, from the
      evidence attached below.

# Sync with develop

- [ ] Rebased/merged onto the latest `origin/develop`; zero conflicts.
- [ ] `bun run verify` passes post-sync, or the exact unrelated blocker is
      documented in **Known gaps / failures** below.

<!-- This risks section must be filled out before the final review and merge. -->

# Risks

<!--
Low, medium, large. List what kind of risks and what could be affected.
-->

# Background

## What does this PR do?

## What kind of change is this?

<!--
Bug fixes (non-breaking change which fixes an issue)
Improvements (misc. changes to existing features)
Features (non-breaking change which adds functionality)
Updates (new versions of included code)
-->

<!-- This "Why" section is most relevant if there are no linked issues explaining why. If there is a related issue, it might make sense to skip this why section. -->
<!--
## Why are we doing this? Any context or related work?
-->

# Documentation changes needed?

<!--
My changes do not require a change to the project documentation.
My changes require a change to the project documentation.
If documentation change is needed: I have updated the documentation accordingly.
-->

<!-- Please show how you tested the PR. This will really help if the PR needs to be retested and probably help the PR get merged quicker. -->

# Testing

## Where should a reviewer start?

## Detailed testing steps

<!--
None: Automated tests are acceptable.
-->

<!--
- As [anon/admin], go to [link]
  - [do action]
  - verify [result]
-->

# Evidence Gate

Evidence must match the exact commit reviewed. `scripts/pr-evidence.mjs rows`
sets this marker from the live PR head; rerun it after every push.
<!-- evidence-head:replace-with-current-40-character-head-sha -->

Any change testable on the frontend is not mergeable without a video walkthrough,
before/after screenshots, and logs. If you did not attach them, say why.

Attach each applicable artifact **inline in this PR** (drag-and-drop into the
description or a comment), or write `N/A - <reason>` on the row. Do not leave
evidence rows blank. Videos must be **MP4** (GitHub renders them inline);
prefer **JPG over PNG** for screenshots. Do not commit evidence files to the
repo.

<!-- evidence-row:before-screenshots -->
- [ ] Before full-page screenshots are attached for every affected UI surface
      (desktop and mobile), or marked `N/A - <reason>`.
<!-- evidence-row:after-screenshots -->
- [ ] After full-page screenshots are attached for every affected UI surface
      (desktop and mobile), or marked `N/A - <reason>`.
<!-- evidence-row:walkthrough-video -->
- [ ] A video walkthrough of the complete user flow is attached, or marked
      `N/A - <reason>`.
<!-- evidence-row:backend-logs -->
- [ ] Backend logs show the real code path firing end to end, or are marked
      `N/A - <reason>`.
<!-- evidence-row:frontend-logs -->
- [ ] Frontend console and network logs show the request/response and state
      change, or are marked `N/A - <reason>`.
<!-- evidence-row:llm-trajectory -->
- [ ] Real-LLM trajectory is attached for agent/action/provider/prompt/model
      changes, or marked `N/A - <reason>`.
<!-- evidence-row:domain-artifacts -->
- [ ] Domain artifacts are attached where applicable (DB rows, memories,
      scheduled tasks, wallet/on-chain output, generated files, audio, etc.), or
      marked `N/A - <reason>`.
<!-- evidence-row:ocr-review -->
- [ ] OCR visual-text review output is attached for UI changes, or marked
      `N/A - <reason>` when the change has no rendered visual surface.

# Evidence Details

## Real LLM-call trajectory

For agent/action/provider/prompt/model changes, use a real live-model run, not
the deterministic proxy. Produce with:

```bash
  packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out.json>
```

Link the JSON report, run viewer, native jsonl, or write `N/A - <reason>`.

## Backend + frontend logs

Backend: structured logger lines ([ClassName] …) showing the code path firing end to end.
Frontend: console + network trace showing the request/response and state change.
Paste here inline (wrap long output in a `<details>` block), or write
`N/A - <reason>`.

## Screenshots (before / after) + video walkthrough

Full-page before AND after screenshots are required for any UI change. Include a
video click-through of the flow.

```bash
  bun run evidence:doctor                 (check capture tools; prints fixes for any missing)
  bun run test:e2e:record                 (general E2E recordings)
  bun run test:matrix:review              (capture into one verified evidence bundle)
  bun run evidence:review:no-open -- --bundle=evidence/runs/<run-id>
                                          (re-open the exact matrix run)
  bun run --cwd packages/app audit:app    (app + cloud UI — REQUIRED for UI changes)
```

The matrix command creates and verifies one named bundle, then passes that
exact run to the reviewer. Do not replace the `--bundle` path with raw producer
directories; `--source` is only for explicit archived/ad-hoc compatibility.

A UI-touching diff (rendered `.tsx`/`.css`/`.svg` under `packages/app`,
`packages/ui`, `apps/app`, …) MUST attach real screenshot/video/OCR artifacts —
the CI evidence gate rejects `N/A` on those rows for such diffs, label or not.
If a capture tool is missing, `evidence:doctor` prints the install command;
install it rather than marking evidence `N/A`.

### Before

### After

### Walkthrough video

Or write `N/A - <reason>`.

## Audio / voice walkthrough

For voice / transcript / TTS / STT / omnivoice changes, attach captured audio of
the real round-trip plus a narrated walkthrough. Or write `N/A - <reason>`.

## Known gaps / failures

List any command failure, missing artifact, unavailable device, unavailable live
service, or evidence row marked N/A. Include the exact reason and why it is not a
blocker for this PR.

## CI availability record

Write `N/A - applicable checks passed` when all applicable checks passed.
Otherwise, follow [CI availability](../CONTRIBUTING.md#ci-availability) and
record the evidence below. Explicit repository-owner instructions do not
require a second authorization or separate bypass actor; GitHub-enforced
permissions still apply.

- PR head and validated `origin/develop` SHAs:
- Unavailable or failing checks and run URLs:
- Evidence that failures are outside the changed surface:
- Exact-head commands, exit statuses, and artifacts:
- Merge revision and method (record after merge):
- Remaining validation:

<!-- If there is anything about the deployment, please make a note. -->
<!--
# Deploy Notes
-->

<!--  Copy and paste command line output. -->
<!--
## Database changes
-->

<!--  Please specify deploy instructions if there is something more than the automated steps. -->
<!--
## Deployment instructions
-->

<!-- If you are on Discord, please join https://discord.gg/ai16z and state your Discord username here for the contributor role and join us in #development-feed -->
<!--
## Discord username

-->
