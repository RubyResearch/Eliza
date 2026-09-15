/**
 * `lifeops` provider — the aggregated owner-operations context block.
 *
 * Owner-and-agent-only. Composes the LifeOps overview (active occurrences,
 * goals, reminders) with live Google calendar and Gmail-triage projections and
 * an owner profile summary, then emits both a large routing preamble (mapping
 * owner intents to the right OWNER, CALENDAR, MESSAGE, and BLOCK actions) and
 * structured `values`/`data` for the planner. Connector reads pass through the
 * privacy-egress guard so per-account privacy policies redact what surfaces;
 * connector/calendar/gmail fetch failures degrade to annotated lines rather
 * than aborting the whole context.
 */

import {
  ElizaError,
  evaluateOwnerExclusiveDisclosure,
  getAccountPrivacy,
  getConnectorAccountManager,
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
  toWellFormedUnicode,
} from "@elizaos/core";
import type {
  LifeOpsGmailTriageSummary,
  LifeOpsGoalDefinition,
  LifeOpsNextCalendarEventContext,
} from "../contracts/index.js";
import { hasLifeOpsAccess } from "../lifeops/access.js";
import type { ConnectorStatus } from "../lifeops/connectors/contract.js";
import { getConnectorRegistry } from "../lifeops/connectors/registry.js";
import {
  type OwnerFacts,
  resolveOwnerFactStore,
} from "../lifeops/owner/fact-store.js";
import {
  type LifeOpsOwnerProfile,
  readLifeOpsOwnerProfile,
} from "../lifeops/owner-profile.js";
import {
  canSurfaceForAudience,
  type LifeOpsAudience,
} from "../lifeops/privacy.js";
import {
  canSurfaceConnectorAccountData,
  connectorAccountPrivacyKey,
  createLifeOpsEgressContext,
  deriveConnectorAccountIdFromGrant,
  mapConnectorAccountPrivacyPolicies,
  redactTextForEgress,
} from "../lifeops/privacy-egress.js";
import { LifeOpsService } from "../lifeops/service.js";
import { formatConnectorDegradationLines } from "./lifeops-connector-lines.js";

const INTERNAL_URL = new URL("http://127.0.0.1/");

function formatCount(label: string, count: number): string {
  return `${label}: ${count}`;
}

/**
 * Inspect every registered connector and surface degraded / disconnected
 * connectors so the morning brief and planner context highlight them. The
 * status comes from `ConnectorContribution.status()`; this helper maps it
 * into one-line strings the planner can quote verbatim.
 */
async function summarizeConnectorDegradation(
  runtime: IAgentRuntime,
): Promise<string[]> {
  const registry = getConnectorRegistry(runtime);
  if (!registry) return [];
  const contributions = registry.list();
  if (contributions.length === 0) return [];
  const statuses = await Promise.all(
    contributions.map(async (contribution) => {
      try {
        const status = await contribution.status();
        return { contribution, status };
      } catch (error) {
        // error-policy:J4 a registered connector whose status() probe throws
        // degrades to a visible "disconnected" line below; reportError keeps
        // the failure in RECENT_ERRORS so a broken probe cannot hide behind
        // the degrade.
        runtime.reportError("LifeOpsProvider.connectorStatus", error, {
          connectorId: contribution.kind,
        });
        const message = error instanceof Error ? error.message : String(error);
        return {
          contribution,
          status: {
            state: "disconnected",
            message,
            observedAt: new Date().toISOString(),
          } satisfies ConnectorStatus,
        };
      }
    }),
  );
  return formatConnectorDegradationLines(
    statuses.map(({ contribution, status }) => ({
      label: contribution.describe.label,
      state: status.state,
      message: status.message,
    })),
  );
}

export function normalizeGoalTitle(title: string): string {
  return toWellFormedUnicode(title.trim());
}

function readGoalReviewedAt(goal: LifeOpsGoalDefinition): string | null {
  const metadata = goal.metadata;
  if (metadata && typeof metadata === "object") {
    const computed = (metadata as Record<string, unknown>).computedGoalReview;
    if (computed && typeof computed === "object") {
      const reviewedAt = (computed as Record<string, unknown>).reviewedAt;
      if (typeof reviewedAt === "string" && reviewedAt.length > 0) {
        return reviewedAt;
      }
    }
  }
  return null;
}

function formatRelativePast(fromIso: string, now: Date): string {
  const fromMs = new Date(fromIso).getTime();
  if (!Number.isFinite(fromMs)) {
    return "unknown";
  }
  const deltaMs = now.getTime() - fromMs;
  if (deltaMs < 60_000) {
    return "just now";
  }
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }
  const weeks = Math.floor(days / 7);
  if (weeks < 5) {
    return `${weeks}w ago`;
  }
  const months = Math.floor(days / 30);
  if (months < 12) {
    return `${months}mo ago`;
  }
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

function summarizeActiveGoals(
  goals: LifeOpsGoalDefinition[],
  now: Date,
): string[] {
  const active = goals.filter((goal) => goal.status === "active");
  if (active.length === 0) {
    return [];
  }
  const sorted = [...active].sort((left, right) => {
    const leftActivityIso = readGoalReviewedAt(left) ?? left.updatedAt;
    const rightActivityIso = readGoalReviewedAt(right) ?? right.updatedAt;
    const leftMs = new Date(leftActivityIso).getTime();
    const rightMs = new Date(rightActivityIso).getTime();
    const leftSafe = Number.isFinite(leftMs) ? leftMs : 0;
    const rightSafe = Number.isFinite(rightMs) ? rightMs : 0;
    return rightSafe - leftSafe;
  });
  return sorted.map((goal) => {
    const reviewedAtIso = readGoalReviewedAt(goal);
    const lastReviewedFragment = reviewedAtIso
      ? `last reviewed ${formatRelativePast(reviewedAtIso, now)}`
      : "review pending";
    return `- ${normalizeGoalTitle(goal.title)} (${goal.reviewState}, ${lastReviewedFragment})`;
  });
}

/**
 * "Completed today" context lines for the owner. Recap turns ("how did today
 * go?") need the owner's finished items in view to lead with wins; the
 * overview itself deliberately lists only open occurrences, which left recap
 * replies claiming an empty day while completions sat in the store (#16935).
 */
function summarizeCompletedToday(
  occurrences: Array<{ title: string; updatedAt: string }>,
): string[] {
  if (occurrences.length === 0) {
    return [];
  }
  return [
    "Owner completed today:",
    ...occurrences.map((occurrence) => `- ${occurrence.title} (completed)`),
  ];
}

function summarizeOccurrences(
  title: string,
  occurrences: Array<{
    title: string;
    state: string;
    progress?: {
      completedCount: number;
      targetCount: number;
      remainingCount: number;
      unit: string;
    } | null;
  }>,
): string[] {
  if (occurrences.length === 0) {
    return [];
  }
  return [
    title,
    ...occurrences.map((occurrence) => {
      const progress = occurrence.progress;
      return progress
        ? `- ${occurrence.title} (${progress.completedCount}/${progress.targetCount} ${progress.unit}${progress.targetCount === 1 ? "" : "s"}; ${progress.remainingCount} remaining)`
        : `- ${occurrence.title} (${occurrence.state})`;
    }),
  ];
}

function formatRelativeMinutes(minutes: number): string {
  if (minutes <= 0) return "now";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const remaining = Math.round(minutes % 60);
  if (remaining === 0) return `${hours}h`;
  return `${hours}h ${remaining}m`;
}

function summarizeNextEvent(
  context: LifeOpsNextCalendarEventContext,
): string[] {
  if (!context.event) {
    return [];
  }
  const event = context.event;
  const timing =
    context.startsInMinutes !== null
      ? ` (${formatRelativeMinutes(context.startsInMinutes)})`
      : "";
  const lines = [`Next event: ${event.title}${timing}`];
  if (context.attendeeNames.length > 0) {
    lines.push(`  With: ${context.attendeeNames.join(", ")}`);
  }
  if (context.location) {
    lines.push(`  At: ${context.location}`);
  }
  return lines;
}

function summarizeGmailTriage(summary: LifeOpsGmailTriageSummary): string[] {
  const parts: string[] = [];
  if (summary.unreadCount > 0) parts.push(`${summary.unreadCount} unread`);
  if (summary.importantNewCount > 0)
    parts.push(`${summary.importantNewCount} important`);
  if (summary.likelyReplyNeededCount > 0)
    parts.push(`${summary.likelyReplyNeededCount} needing reply`);
  if (parts.length === 0) {
    return [];
  }
  return [`Inbox: ${parts.join(", ")}`];
}

function summarizeOwnerProfile(profile: LifeOpsOwnerProfile): string[] {
  return [
    `Owner profile: name=${profile.name} | relationship=${profile.relationshipStatus} | partner=${profile.partnerName} | orientation=${profile.orientation} | gender=${profile.gender} | age=${profile.age} | location=${profile.location} | travelPrefs=${profile.travelBookingPreferences}`,
  ];
}

function summarizeOwnerTimingFacts(facts: OwnerFacts): string[] {
  const timezone = facts.timezone?.value;
  const morning = facts.morningWindow?.value;
  const evening = facts.eveningWindow?.value;
  const quiet = facts.quietHours?.value;
  const parts: string[] = [];
  if (timezone) {
    parts.push(`timezone=${timezone}`);
  }
  if (morning) {
    parts.push(`morningWindow=${morning.startLocal}-${morning.endLocal}`);
  }
  if (evening) {
    parts.push(`eveningWindow=${evening.startLocal}-${evening.endLocal}`);
  }
  if (quiet) {
    parts.push(
      `protected quiet/sleep window=${quiet.startLocal}-${quiet.endLocal} ${quiet.timezone}`,
    );
  }
  if (parts.length === 0) {
    return [];
  }
  const lines = [`Owner timing facts: ${parts.join(" | ")}`];
  if (quiet) {
    lines.push(
      "Calendar creates inside the protected quiet/sleep window are conflicts: do not book silently; ask for explicit owner override and propose alternatives outside the protected window.",
    );
  }
  return lines;
}

export const lifeOpsProvider: Provider = {
  name: "lifeops",
  description:
    "Owner and agent only. Provides owner operations overview plus live calendar and Gmail context. Route todos to OWNER_TODOS, reminders to OWNER_REMINDERS, alarms to OWNER_ALARMS, habits/routines to OWNER_ROUTINES, goals to OWNER_GOALS, owner health reads to OWNER_HEALTH, screen-time reads to OWNER_SCREENTIME, owner finance/subscription work to OWNER_FINANCES, all owner calendar/scheduling/availability work to CALENDAR, all owner inbox/email/draft/reply/message-management work to MESSAGE with the appropriate action, stable owner facts through automatic profile extraction, contact/entity facts to ENTITY or CONTACT, travel booking and scheduling workflows to PERSONAL_ASSISTANT, X/Twitter DMs to MESSAGE with source=x, X/Twitter feed/search to POST with source=x, website and app blocking to BLOCK with target=website or target=app, browser-companion management to MANAGE_BROWSER_BRIDGE, browser tab control to BROWSER, credential lookup/autofill to CREDENTIALS, and pending approval decisions to RESOLVE_REQUEST. Morning/night self-review briefings run as scheduled tasks rather than as a planner-visible action. Available in private owner conversations, including Discord.",
  descriptionCompressed:
    "Owner operations overview, upcoming calendar, email triage. Owner only.",
  dynamic: true,
  position: 12,
  contexts: [
    "tasks",
    "calendar",
    "email",
    "contacts",
    "payments",
    "finance",
    "subscriptions",
    "health",
    "screen_time",
    "browser",
    "messaging",
  ],
  contextGate: {
    anyOf: [
      "tasks",
      "calendar",
      "email",
      "contacts",
      "payments",
      "finance",
      "subscriptions",
      "health",
      "screen_time",
      "browser",
      "messaging",
    ],
  },
  cacheScope: "turn",
  roleGate: { minRole: "OWNER" },
  async get(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    // The destination decides the audience, never the sender's claim about
    // itself: an unattested turn (or one attested to a shared room) reads as
    // public here even when its own metadata says "OWNER". `plugin.ts` stamps
    // this provider with OWNER_EXCLUSIVE_DISCLOSURE_GATE via
    // `ownerPrivateProvider`, and this check is the same evidence read inside
    // the provider so a direct call cannot bypass it.
    const disclosure = evaluateOwnerExclusiveDisclosure(message);
    const audience: LifeOpsAudience = disclosure.allowed ? "owner" : "public";
    if (audience !== "owner") {
      return { text: "", values: {}, data: {} };
    }
    const isOwner = await hasLifeOpsAccess(runtime, message);
    if (!isOwner) {
      return { text: "", values: {}, data: {} };
    }

    try {
      const service = new LifeOpsService(runtime);
      const accountManager = getConnectorAccountManager(runtime);
      const now = new Date();
      // These reads have no data dependency on each other, so they go out
      // together instead of one await at a time (0.55-1.1 s of serial round
      // trips per planner recompose, live 2026-09-13). Failure handling is
      // per read and unchanged: reads that used to throw out of `get()`
      // still reject here and reach the provider boundary below; reads that
      // used to degrade in place still degrade in place. Only
      // `listOwnerOccurrencesCompletedToday` stays chained after
      // `getOverview()`, which materializes occurrences before it reads them,
      // so the completed-today query observes the same post-refresh rows it
      // did when the two ran back to back. The calendar/gmail reads further
      // down depend on the connector status resolved here and stay ordered
      // after it.
      const [
        ownerProfile,
        ownerFacts,
        { overview, completedToday },
        connectorAccounts,
        privacyPolicies,
        googleAccountsRead,
        connectorDegradationLines,
      ] = await Promise.all([
        readLifeOpsOwnerProfile(runtime),
        resolveOwnerFactStore(runtime).read(),
        service.getOverview().then(async (refreshed) => ({
          overview: refreshed,
          completedToday: await service.listOwnerOccurrencesCompletedToday(now),
        })),
        (async () => {
          try {
            return await accountManager.listAccounts("google");
          } catch (cause) {
            // error-policy:J2 context-adding rethrow — a failed
            // connector-account read must not silently shrink the privacy
            // metadata to an empty set; the provider boundary below reports it
            // and renders the explicit unavailable state instead of a
            // healthy-looking overview.
            runtime.reportError("LifeOpsProvider.connectorAccounts", cause, {
              provider: "google",
            });
            throw new ElizaError("Google connector account read failed.", {
              code: "LIFEOPS_CONNECTOR_ACCOUNTS_READ_FAILED",
              cause,
              context: { provider: "google" },
            });
          }
        })(),
        (async () => {
          try {
            return mapConnectorAccountPrivacyPolicies(
              await service.repository.listConnectorAccountPrivacy(
                service.agentId(),
              ),
            );
          } catch (cause) {
            // error-policy:J4 fail closed — with the per-account privacy
            // table unreadable every account stays owner-only (the most
            // restrictive policy); reportError surfaces the broken read
            // instead of letting the degrade look healthy.
            runtime.reportError("LifeOpsProvider.accountPrivacy", cause, {
              agentId: runtime.agentId,
            });
            return mapConnectorAccountPrivacyPolicies([]);
          }
        })(),
        (async () => {
          // Captured, not thrown: the Google block below re-raises a failure
          // into its own catch so the degrade path stays exactly as it was.
          try {
            return {
              ok: true as const,
              accounts: await service.getGoogleConnectorAccounts(INTERNAL_URL),
            };
          } catch (cause) {
            return { ok: false as const, cause };
          }
        })(),
        summarizeConnectorDegradation(runtime),
      ]);
      const egressContext = createLifeOpsEgressContext({
        isOwner: true,
        agentId: runtime.agentId,
        entityId: message.entityId,
      });
      const privacyByAccountKey = new Map<
        string,
        ReturnType<typeof getAccountPrivacy>
      >();
      for (const account of connectorAccounts) {
        const privacy = getAccountPrivacy(account);
        privacyByAccountKey.set(account.id, privacy);
        if (account.externalId) {
          privacyByAccountKey.set(account.externalId, privacy);
        }
        const email =
          typeof account.metadata?.email === "string"
            ? account.metadata.email.toLowerCase()
            : null;
        if (email) {
          privacyByAccountKey.set(`email:${email}`, privacy);
        }
      }

      const resolveAccountPrivacy = (
        connectorAccountId: string | null,
        identityEmail: string | null,
      ): ReturnType<typeof getAccountPrivacy> => {
        if (connectorAccountId) {
          const direct = privacyByAccountKey.get(connectorAccountId);
          if (direct) return direct;
        }
        if (identityEmail) {
          const byEmail = privacyByAccountKey.get(
            `email:${identityEmail.toLowerCase()}`,
          );
          if (byEmail) return byEmail;
        }
        return "owner_only";
      };

      let privacyFilteredCount = 0;
      const ownerLines = summarizeOccurrences(
        "Owner active items:",
        overview.owner.occurrences,
      );
      const completedTodayLines = summarizeCompletedToday(completedToday);
      const ownerGoalLines = summarizeActiveGoals(overview.owner.goals, now);
      const agentLines = summarizeOccurrences(
        "Agent ops:",
        overview.agentOps.occurrences,
      );

      const calendarLines: string[] = [];
      const emailLines: string[] = [];
      const accountLines: string[] = [];
      let nextEventContext: LifeOpsNextCalendarEventContext | null = null;
      let gmailSummary: LifeOpsGmailTriageSummary | null = null;

      try {
        if (!googleAccountsRead.ok) {
          throw googleAccountsRead.cause;
        }
        const accounts = googleAccountsRead.accounts;
        const connectedAccounts = accounts.filter((a) => a.connected);

        if (connectedAccounts.length > 1) {
          accountLines.push("Available Google accounts:");
          for (const account of connectedAccounts) {
            const connectorAccountId = account.grant
              ? (account.grant.connectorAccountId ??
                deriveConnectorAccountIdFromGrant(account.grant))
              : null;
            const identityEmail =
              typeof (account.identity as Record<string, unknown> | null)
                ?.email === "string"
                ? String((account.identity as Record<string, unknown>).email)
                : null;
            const accountPrivacy = resolveAccountPrivacy(
              connectorAccountId,
              identityEmail,
            );
            if (!canSurfaceForAudience(accountPrivacy, audience)) {
              privacyFilteredCount += 1;
              accountLines.push("- Google account [redacted: owner_only]");
              continue;
            }
            const policy = connectorAccountId
              ? (privacyPolicies.get(
                  connectorAccountPrivacyKey("google", connectorAccountId),
                ) ?? null)
              : null;
            if (
              !canSurfaceConnectorAccountData({
                context: egressContext,
                provider: "google",
                connectorAccountId,
                dataClass: "metadata",
                policy,
              })
            ) {
              accountLines.push("- Google account hidden by privacy policy");
              continue;
            }
            const email = redactTextForEgress(
              String(
                (account.identity as Record<string, unknown> | null)?.email ??
                  "unknown",
              ),
              { context: egressContext, dataClass: "metadata", policy },
            );
            accountLines.push(
              `- ${email} (connectorAccountId: ${connectorAccountId ?? "unknown"})`,
            );
          }
        }

        const status = connectedAccounts[0];
        if (status?.connected) {
          const connectorAccountId = status.grant
            ? (status.grant.connectorAccountId ??
              deriveConnectorAccountIdFromGrant(status.grant))
            : null;
          const statusIdentityEmail =
            typeof (status.identity as Record<string, unknown> | null)
              ?.email === "string"
              ? String((status.identity as Record<string, unknown>).email)
              : null;
          const statusPrivacy = resolveAccountPrivacy(
            connectorAccountId,
            statusIdentityEmail,
          );
          const statusAllowedByMetadataPrivacy = canSurfaceForAudience(
            statusPrivacy,
            audience,
          );
          if (!statusAllowedByMetadataPrivacy) {
            privacyFilteredCount += 1;
          }
          const policy = connectorAccountId
            ? (privacyPolicies.get(
                connectorAccountPrivacyKey("google", connectorAccountId),
              ) ?? null)
            : null;
          const capabilities = status.grantedCapabilities ?? [];
          const hasCalendar = capabilities.some((c) =>
            c.startsWith("google.calendar"),
          );
          const hasGmail = capabilities.some((c) =>
            c.startsWith("google.gmail"),
          );

          if (hasCalendar) {
            if (!statusAllowedByMetadataPrivacy) {
              calendarLines.push("Calendar context [redacted: owner_only]");
            } else if (
              !canSurfaceConnectorAccountData({
                context: egressContext,
                provider: "google",
                connectorAccountId,
                dataClass: "snippet",
                policy,
              })
            ) {
              calendarLines.push("Calendar context hidden by privacy policy.");
            } else {
              try {
                nextEventContext =
                  await service.getNextCalendarEventContext(INTERNAL_URL);
                calendarLines.push(...summarizeNextEvent(nextEventContext));
              } catch (cause) {
                // error-policy:J4 the granted calendar read failed — degrade
                // to a visible "degraded" line and report, never a silently
                // empty calendar.
                runtime.reportError("LifeOpsProvider.calendar", cause, {
                  roomId: message.roomId,
                });
                calendarLines.push(
                  `Calendar connector degraded: ${cause instanceof Error ? cause.message : String(cause)}`,
                );
              }
            }
          }

          if (hasGmail) {
            if (!statusAllowedByMetadataPrivacy) {
              emailLines.push("Gmail context [redacted: owner_only]");
            } else if (
              !canSurfaceConnectorAccountData({
                context: egressContext,
                provider: "google",
                connectorAccountId,
                dataClass: "metadata",
                policy,
              })
            ) {
              emailLines.push("Gmail context hidden by privacy policy.");
            } else {
              try {
                const triage = await service.getGmailTriage(INTERNAL_URL, {
                  maxResults: 5,
                });
                gmailSummary = triage.summary;
                emailLines.push(...summarizeGmailTriage(triage.summary));
              } catch (cause) {
                // error-policy:J4 the granted Gmail triage read failed —
                // degrade to a visible "degraded" line and report, never a
                // silently empty inbox.
                runtime.reportError("LifeOpsProvider.gmail", cause, {
                  roomId: message.roomId,
                });
                emailLines.push(
                  `Gmail connector degraded: ${cause instanceof Error ? cause.message : String(cause)}`,
                );
              }
            }
          }
        }

        if (calendarLines.length === 0 && audience === "owner") {
          try {
            nextEventContext =
              await service.getNextCalendarEventContext(INTERNAL_URL);
            calendarLines.push(...summarizeNextEvent(nextEventContext));
          } catch (cause) {
            // error-policy:J4 designed absence — with no calendar source
            // connected this probe throws CALENDAR_SOURCES_UNAVAILABLE on
            // every turn of a connector-less install, so it stays a
            // debug-level omit rather than a reportError that would escalate
            // an unconfigured install as a systemic failure; genuine failures
            // on the capability-granted path are reported above.
            logger.debug(
              { err: cause },
              "[LifeOpsProvider] native calendar context unavailable — omitting calendar context",
            );
          }
        }
      } catch (cause) {
        // error-policy:J4 the Google connector read itself failed (a missing
        // plugin reports connected:false without throwing) — degrade to a
        // visible status line and report rather than silently dropping the
        // calendar/email context.
        runtime.reportError("LifeOpsProvider.googleConnector", cause, {
          roomId: message.roomId,
        });
        accountLines.push(
          `Google connector status unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }

      if (privacyFilteredCount > 0) {
        logger.debug(
          `[LifeOpsPrivacy] filtered ${privacyFilteredCount} accounts of provider google for audience ${audience}`,
        );
      }

      return {
        text: [
          "## Owner Operations",
          // Per-action routing ("Use OWNER_TODOS for…") is not repeated here: every
          // LifeOps tool on the planner surface already carries that guidance in its
          // own description, and repeating ~17 lines of it cost 11.5K chars in every
          // planner and evaluator call (live 2026-09-05). Only the cross-cutting
          // rules that no single tool description can express stay below.
          "The LifeOps tool descriptions on this turn's surface say which action owns which request; pick the best-fit one instead of staying in advice-only chat.",
          "When the owner retracts something that was just saved ('actually don't save that', 'cancel that one', 'never mind'), call the owning surface with action=delete and the item title — never answer with a bare reply or a review call: a saved row stays saved until a delete runs.",
          "Route all meeting-time proposals, availability checks, durable scheduling rules, and explicit multi-turn scheduling negotiations through CALENDAR.",
          "For third-party availability requests, minimize to free/busy windows or ask the owner to confirm sharing. Never volunteer event titles, medical details, home addresses, locations, attendees, or stored private facts to someone who only asked when the owner is free.",
          "Stable owner-only profile details and reusable travel-preference checklists are extracted automatically by evaluators. Do not use a planner action for goals, todos, reminders, temporary plans, or live task state.",
          "When the owner is only making an observation or venting like 'my calendar has been crazy this quarter', 'I hate email', or 'I think I spend too much time on my phone', stay in REPLY instead of calling a LifeOps action unless they actually ask you to do something.",
          "When the owner reports missing a reminder, step, or habit (once or repeatedly): acknowledge neutrally in one short clause with no shame, blame, streak, or discipline framing; offer ONE smaller version of the missed step (a few minutes, a partial batch) instead of re-proposing the full original task; and in that repair flow ASK before creating, rescheduling, or re-arming anything — never silently create a reminder or claim one was set.",
          "When the owner gives a clear, unambiguous reminder ask with a date or deadline ('remind me to renew the registration by the 20th'), save it right away with a sensible plain default time (a day or two before a deadline, or the morning it is due) and confirm briefly — do not interrogate for exact times or add scaffolding, check-ins, or extra structure the owner did not ask for.",
          "For an end-of-day recap or 'how did today go' ask: LEAD with what the owner completed today (listed under 'Owner completed today' below and in scheduled-item history), then frame still-open items neutrally as carryovers — never as failures — and ask before scheduling anything for tomorrow.",
          "Reminder and scheduling confirmations to the owner must be plain everyday words: name the thing and the time ('I'll remind you the morning of the 27th'). Never expose internal ids, trigger kinds, cron/ISO timestamp formats, schema or field names, or storage details, and never describe a saved reminder as session-only, temporary, or at risk of being lost — saved reminders persist.",
          "Treat owner instructions phrased as standing policies, triggers, or conditionals like 'if this happens, do x' or 'when that arrives, handle it' as executable requests, not hypotheticals.",
          "When the owner clearly asks for one of these LifeOps executive-assistant operations, call the best-fit action instead of staying in advice-only chat. If details are missing, let the action ask the minimum follow-up question.",
          "When the owner asks about their stable personal details for LifeOps, answer from the stored owner profile values below. If a field is not n/a, treat it as known instead of saying it is missing.",
          "Owner life-ops are private to the owner and the agent. Agent ops are internal and should stay separated unless explicitly requested.",
          ...summarizeOwnerProfile(ownerProfile),
          ...summarizeOwnerTimingFacts(ownerFacts),
          formatCount(
            "Owner open occurrences",
            overview.owner.summary.activeOccurrenceCount,
          ),
          formatCount(
            "Owner active goals",
            overview.owner.summary.activeGoalCount,
          ),
          ...ownerGoalLines,
          formatCount(
            "Owner live reminders",
            overview.owner.summary.activeReminderCount,
          ),
          formatCount("Owner completed today", completedToday.length),
          ...completedTodayLines,
          ...ownerLines,
          ...accountLines,
          ...calendarLines,
          ...emailLines,
          ...connectorDegradationLines,
          formatCount(
            "Agent open occurrences",
            overview.agentOps.summary.activeOccurrenceCount,
          ),
          formatCount(
            "Agent active goals",
            overview.agentOps.summary.activeGoalCount,
          ),
          ...agentLines,
        ].join("\n"),
        values: {
          ownerOpenOccurrences: overview.owner.summary.activeOccurrenceCount,
          ownerCompletedToday: completedToday.length,
          ownerActiveGoals: overview.owner.summary.activeGoalCount,
          ownerActiveGoalTitles: overview.owner.goals
            .filter((goal) => goal.status === "active")
            .map((goal) => goal.title),
          ownerProfileName: ownerProfile.name,
          ownerRelationshipStatus: ownerProfile.relationshipStatus,
          ownerPartnerName: ownerProfile.partnerName,
          ownerOrientation: ownerProfile.orientation,
          ownerGender: ownerProfile.gender,
          ownerAge: ownerProfile.age,
          ownerLocation: ownerProfile.location,
          agentOpenOccurrences: overview.agentOps.summary.activeOccurrenceCount,
          agentActiveGoals: overview.agentOps.summary.activeGoalCount,
        },
        data: {
          ownerProfile,
          overview: {
            ...overview,
            owner: {
              ...overview.owner,
              goals: overview.owner.goals,
              occurrences: overview.owner.occurrences,
            },
            agentOps: {
              ...overview.agentOps,
              occurrences: overview.agentOps.occurrences,
            },
          },
          nextEventContext,
          gmailSummary,
        },
      };
    } catch (error) {
      // error-policy:J4 provider boundary — the owner sees an explicit
      // "LifeOps overview unavailable." block rather than a healthy-looking
      // overview, and reportError surfaces the failure in RECENT_ERRORS so the
      // agent can react to a broken overview pipeline.
      runtime.reportError("LifeOpsProvider.get", error, {
        roomId: message.roomId,
        entityId: message.entityId,
      });
      return {
        text: "LifeOps overview unavailable.",
        // No counts: a failed read that reports zero open occurrences and zero
        // active goals is indistinguishable from a genuinely empty day, and the
        // model would state it as fact. The marker lets a consumer tell the
        // three states apart.
        values: { lifeOpsOverviewUnavailable: true },
        data: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  },
};
