# Agent Fleet — coordination guide

Canonical rules for every AI agent (and human) working this repo as part of the
fleet. Code conventions live in `AGENTS.md`/`CLAUDE.md`; the evidence bar lives
in `CONTRIBUTING.md`. This file covers the third thing: **how we coordinate** —
the board, the claims, the lanes, and where each kind of conversation goes.

## Where things live

| Surface | Used for | Not for |
|---|---|---|
| **GitHub Project 12** (org board) | Live work state: every card is an issue, columns below | Chat, design debate |
| **Issues** | Actionable cards only — one bug/feature/task each, `launch-qa` labels | Status chatter (that's the Discussion) |
| **Discussions → "Agent Fleet — Coordination HQ"** (pinned, General) | Standups, claims visibility, cross-lane questions, incident threads | Anything needing a card (open an issue) |
| **PRs** | The work itself + its evidence | Coordination side-talk |
| **`.github/FLEET.md`** (this file) | The rules — PR a change to propose a rule change | — |

Long-running "tracking issues" with hundreds of linear comments are
**deprecated** for coordination: threads in the Discussion replace them. Keep
tracking issues only as durable logs of a specific push, closed by the owner.

## Identity

- Every agent has a **lane tag** — `[qa-agent]`, `[maintainer]`,
  `[cloud-agent]`, `[core-brain]`, … — and **signs every comment** with it.
- Agents may voluntarily include runtime provenance in their GitHub text, but
  provider/model input is never a prerequisite for posting. Any supplied
  footer must be internally consistent and must never expose hidden reasoning,
  private prompts, session IDs, credentials, or tokens.
- One lane tag = one running context. If you inherit a lane, say so in the
  Discussion before acting in it.

## The loop

1. **Read first**: the Discussion's latest posts + the board. Never start work
   someone has claimed.
2. **Claim**: comment `CLAIMING: <card>` (Discussion thread or the card
   itself), move the card **Todo → Claimed**, then **In progress** when you
   start.
3. **Work to the evidence bar** (`CONTRIBUTING.md`): real end-to-end proof, no
   mocks, no shortcuts.
4. **Deliver**: post evidence (PR links, screenshots, logs) on the card, move
   it to **Needs-human-verify**. Only the owner (nubs) moves cards to **Done**
   or closes the push.
5. **Next card immediately.** Blocked >30 min → say so where you claimed, move
   the card back, pick another.

Board columns: `Todo → Claimed → In progress → Needs-agent-verify →
needs-human-verify → Done(owner-only)`.

## Shared levers — claim before you mutate

Some things exist once. Announce **before** touching, wait for objections when
another lane is active on it, release when done:

- Prod deploys (Workers, Pages) and the develop→main promote
- Staging environment (deploys, env vars, secrets, seeded data)
- The production database (any write — even additive grants get a
  transparency note with the ledger row id)
- DNS / Cloudflare settings / repo settings & rulesets
- **Physical devices** (the Seeker phone + its adb) — one installer at a time
- Worker secrets, CI runner capacity

Case study: two agents built + installed on the Seeker in parallel
(2026-07-05). Cost: a duplicated build and a mid-air de-conflict. The rule
exists so the *second* agent finds the claim before spending the compute.

## Merge & deploy etiquette

- **Never self-merge your own PR** into a lane that has a reviewer
  (maintainer shepherds merges). Never solo-merge **money, schema, or deploy**
  changes — those need a second lane or the owner.
- When hosted checks are unavailable or fail outside the changed surface,
  follow [**CI availability**](../CONTRIBUTING.md#ci-availability): record the
  exact-head validation, check failures, merge revision, and remaining work.
  Explicit repository-owner instructions authorize the requested merge
  workflow without a second authorization or separate bypass actor. Respect
  GitHub-enforced permissions and report any platform rejection directly.
- **Sync before PR**: `git fetch origin && git rebase origin/develop`; a
  branch that can't fast-forward is not ready. develop history gets rewritten
  by squash-merges — if rebase replays foreign commits, recover with
  `git checkout -B tmp origin/develop && git cherry-pick <your-commits>`.
- **Re-verify against current develop** before filing or contesting — the tip
  moves fast; stale findings burn everyone's time.
- Deploy lanes: **develop → staging** is the default flow; **prod** rides the
  main promote (maintainer lane) or an explicitly-claimed out-of-band deploy.
- Live verification uses **real flows** — real sign-in, real devices, real
  money paths on staging. Auth injection / fabricated state proves nothing and
  is banned as evidence.

## Using the Discussion HQ (features, not flat chat)

The HQ is **[#14308 — Agent Fleet Coordination HQ](https://github.com/orgs/elizaOS/discussions/14308)**.
Use the platform's features — a flat comment stream doesn't scale to a fleet:

- **One claim = one thread.** Your standup/claim is a **top-level comment**;
  every update, question, and hand-off about it goes as a **reply under it** —
  not a new top-level post.
- **React to ack** (👍 seen / 👀 looking / 🚀 shipped) instead of posting
  "ack"/"+1" comments.
- **Don't create new Discussions for coordination** — that's how duplicate
  rooms happen (#14292, locked). Per-topic **workstream discussions** (e.g.
  the LifeOps MVP rooms) are for deep design/build threads; fleet-wide
  standups, claims, and cross-lane asks stay in the HQ, cross-linked.
- **Categories:** 📣 Announcements = owner directives / GO signals only ·
  🙏 Q&A = cross-lane questions — **mark the resolving reply as the Answer** ·
  🗳️ Polls = fleet decisions · 🙌 Show and tell = shipped demos + evidence.
- **Link, don't paste** — reference PRs/issues/cards by number so GitHub
  cross-links them.

## Communication hygiene

- Sign everything. Link evidence, not adjectives.
- Read the last hour of the Discussion before posting — don't duplicate.
- New bug found mid-task → new issue (card) + one Discussion line, then keep
  going. Don't bury findings in comment threads.
- When two lanes collide, the one **holding the physical/exclusive lever**
  finishes; the other yields and takes the review. Escalate to the owner only
  on real deadlock.
