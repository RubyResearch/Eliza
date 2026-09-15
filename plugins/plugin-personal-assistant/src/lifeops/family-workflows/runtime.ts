/**
 * Production composition for the school-calendar and monthly family-packet
 * workflows. It projects canonical calendar, school, agreement, household,
 * and owner-fact stores into provenance-bearing packet claims and owns only a
 * restart-safe aggregate run lease; scheduling and approvals remain external.
 */

import { createHash, randomUUID } from "node:crypto";
import { resolveKnowledgeGraphService } from "@elizaos/agent";
import { ElizaError, type IAgentRuntime, Service } from "@elizaos/core";
import {
  CALENDAR_OWNER_MUTATION_GATEWAY_SERVICE,
  CalendarService,
} from "@elizaos/plugin-calendar";
import {
  getScheduledTaskRunner,
  type ScheduledTask,
} from "@elizaos/plugin-scheduling";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { createApprovalQueue } from "../approval-queue.js";
import type { ApprovalRequest } from "../approval-queue.types.js";
import { CalendarCardAccessStore } from "../calendar-card.js";
import {
  type FamilyPacketClaim,
  type FamilyPacketEmailDelivery,
  type FamilyPacketPeriod,
  type MonthlyFamilyDraft,
  type MonthlyFamilyPacket,
  MonthlyFamilyPacketService,
} from "../family-coordination/index.js";
import { familyIntakeClaim } from "../family-coordination/intake-claims.js";
import { FamilyIntakeReviewStore } from "../family-coordination/intake-review.js";
import { getFamilyIntakeService } from "../family-coordination/intake-service.js";
import {
  getAgreementKnowledgeService,
  HOUSEHOLD_AGREEMENT_KNOWLEDGE_SERVICE,
  type ParentingAgreementObligation,
} from "../household/agreement-knowledge.js";
import { HouseholdCoordinationRepository } from "../household/repository.js";
import { resolveOwnerFactStore } from "../owner/fact-store.js";
import {
  CONCORD_SCHOOL_CALENDAR_SOURCE,
  type SchoolCalendarRunResult,
  type SchoolCalendarSourceConfig,
  SchoolCalendarWorkflow,
  type SchoolCalendarWorkflowStatus,
} from "../school/calendar-workflow.js";
import {
  getSchoolSourceFactRuntimeService,
  SCHOOL_SOURCE_FACT_SERVICE,
} from "../school/service.js";
import type { SourceFact } from "../school/types.js";
import { LifeOpsService } from "../service.js";
import { executeRawSql, parseJsonValue, sqlQuote, toText } from "../sql.js";
import { collectCalendarClaims } from "./calendar-claims.js";
import {
  familyPacketCalendarWindow,
  nextFamilyPacketPeriod,
} from "./period.js";
import { ensureFamilyWorkflowRunStore } from "./run-store.js";

export interface FamilyMonthlyScheduleView {
  taskId: string;
  status: ScheduledTask["state"]["status"];
  trigger: ScheduledTask["trigger"];
  lastFiredAt: string | null;
}

export interface FamilySchoolWorkflowStatus
  extends SchoolCalendarWorkflowStatus {
  monthlySchedule: FamilyMonthlyScheduleView | null;
}

export const FAMILY_WORKFLOW_RUNTIME_SERVICE = "lifeops_family_workflows";
export interface FamilyEmailOptions {
  accounts: Array<{ grantId: string; label: string }>;
  recipients: Array<{ entityId: string; name: string; address: string }>;
}
export interface FamilyDraftApprovalStatus {
  id: string;
  state: ApprovalRequest["state"];
  providerAccepted: boolean | null;
  providerMessageId: string | null;
  error: string | null;
  updatedAt: string;
}

function draftApprovalStatus(
  approval: ApprovalRequest,
): FamilyDraftApprovalStatus {
  const receipt = approval.execution?.providerReceipt;
  return {
    id: approval.id,
    state: approval.state,
    providerAccepted:
      typeof receipt?.accepted === "boolean" ? receipt.accepted : null,
    providerMessageId:
      typeof receipt?.messageId === "string" ? receipt.messageId : null,
    error: approval.execution?.error ?? null,
    updatedAt: approval.updatedAt.toISOString(),
  };
}

export const FAMILY_MONTHLY_SYSTEM_OPERATION =
  "family.monthlyCoordination" as const;

const RUN_LEASE_MS = 10 * 60_000;

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function schoolClaim(fact: SourceFact): FamilyPacketClaim {
  return {
    claimId: `school:${fact.id}`,
    stableKey: fact.stableFactKey,
    section: "school",
    statement: JSON.stringify(fact.value),
    visibility:
      fact.visibility === "owner_private" ? "owner_only" : "guest_shareable",
    provenance: [
      {
        source: "school",
        sourceId: fact.artifactId,
        observedAt: fact.createdAt,
        contentSha256: fact.revisionSha256,
      },
    ],
    dates: [fact.effectiveFrom, fact.effectiveUntil].filter(
      (value): value is string => Boolean(value),
    ),
    requests: [],
    urgency: null,
    commitments: [],
    accountability: [],
  };
}

function obligationClaim(
  value: ParentingAgreementObligation,
  recipientEntityIds: readonly string[],
): FamilyPacketClaim {
  return {
    claimId: `agreement:${value.id}`,
    stableKey: `agreement:${value.id}`,
    section: "approved_obligations",
    statement: value.obligationText,
    visibility: "guest_shareable",
    provenance: [
      {
        source: "agreement",
        sourceId: `${value.artifactId}:pages:${value.pageStart}-${value.pageEnd}`,
        observedAt: value.updatedAt,
        contentSha256: hash({
          text: value.obligationText,
          citation: value.citationText,
        }),
      },
    ],
    dates: [],
    requests: [],
    urgency: null,
    commitments: [value.title],
    accountability: [],
    obligationApprovalId: value.id,
    agreementArtifactId: value.artifactId,
    recipientEntityIds,
  };
}

export interface FamilyWorkflowRunResult {
  state: "completed" | "already_running" | "deduplicated";
  runId: string;
  periodKey: string;
  school: SchoolCalendarRunResult | null;
  packet: MonthlyFamilyPacket | null;
}

export interface FamilyWorkflowRuntimeDeps {
  now?: () => Date;
  schoolWorkflow?: SchoolCalendarWorkflow;
  collectClaims?: (period: FamilyPacketPeriod) => Promise<FamilyPacketClaim[]>;
}

export class FamilyWorkflowRuntimeService extends Service {
  static override serviceType = FAMILY_WORKFLOW_RUNTIME_SERVICE;
  override capabilityDescription =
    "Owner-authorized school-calendar ingestion and monthly family packet generation through canonical stores, scheduling, and approvals";

  readonly school: SchoolCalendarWorkflow;
  readonly packets: MonthlyFamilyPacketService;
  private readonly now: () => Date;
  private initialized = false;

  constructor(
    runtime?: IAgentRuntime,
    private readonly deps: FamilyWorkflowRuntimeDeps = {},
  ) {
    super(runtime);
    if (!runtime)
      throw new Error("[FamilyWorkflowRuntime] runtime is required");
    this.now = deps.now ?? (() => new Date());
    this.school = deps.schoolWorkflow ?? new SchoolCalendarWorkflow(runtime);
    this.packets = new MonthlyFamilyPacketService(runtime, this.now);
  }

  static async start(
    runtime: IAgentRuntime,
  ): Promise<FamilyWorkflowRuntimeService> {
    await Promise.all([
      runtime.getServiceLoadPromise(CalendarService.serviceType),
      runtime.getServiceLoadPromise(SCHOOL_SOURCE_FACT_SERVICE),
      runtime.getServiceLoadPromise(HOUSEHOLD_AGREEMENT_KNOWLEDGE_SERVICE),
    ]);
    return new FamilyWorkflowRuntimeService(runtime);
  }

  async stop(): Promise<void> {}

  private async ensureSchema(): Promise<void> {
    if (this.initialized) return;
    await ensureFamilyWorkflowRunStore(this.runtime);
    this.initialized = true;
  }

  configureSchool(
    config: SchoolCalendarSourceConfig = CONCORD_SCHOOL_CALENDAR_SOURCE,
  ): Promise<SchoolCalendarWorkflowStatus> {
    return this.school.configure(config);
  }

  async schoolStatus(): Promise<FamilySchoolWorkflowStatus> {
    const { FAMILY_COORDINATION_RECORD_IDS } = await import(
      "../../default-packs/family-coordination.js"
    );
    const runner = getScheduledTaskRunner(this.runtime, {
      agentId: this.runtime.agentId,
    });
    const [status, tasks] = await Promise.all([
      this.school.status(),
      runner.list(),
    ]);
    const task = tasks.find(
      (candidate) =>
        candidate.idempotencyKey === FAMILY_COORDINATION_RECORD_IDS.monthly,
    );
    return {
      ...status,
      monthlySchedule: task
        ? {
            taskId: task.taskId,
            status: task.state.status,
            trigger: task.trigger,
            lastFiredAt: task.state.firedAt ?? null,
          }
        : null,
    };
  }

  async ensureMonthlySchedule(): Promise<ScheduledTask> {
    const { familyCoordinationPack } = await import(
      "../../default-packs/family-coordination.js"
    );
    const { toSpineTaskInput } = await import(
      "../../default-packs/spine-registration.js"
    );
    const definition = familyCoordinationPack.records[0];
    if (!definition)
      throw new Error("Monthly family schedule definition is unavailable");
    const runner = getScheduledTaskRunner(this.runtime, {
      agentId: this.runtime.agentId,
    });
    const task = await runner.schedule(
      toSpineTaskInput(definition, familyCoordinationPack.key),
    );
    if (!task.ownerVisible || task.kind !== definition.kind)
      return runner.apply(task.taskId, "edit", {
        ownerVisible: true,
        kind: definition.kind,
      });
    return task;
  }

  reviewSchool(runId: string) {
    return this.school.review(runId);
  }

  async runSchool(
    trigger: "manual" | "scheduled" = "manual",
  ): Promise<SchoolCalendarRunResult> {
    const status = await this.school.status();
    const config = status.config ?? CONCORD_SCHOOL_CALENDAR_SOURCE;
    const result = await this.school.run(config, trigger);
    if (
      result.state !== "awaiting_approval" ||
      config.updateMode !== "automatic"
    )
      return result;
    await this.applySchool(
      result.runId,
      new URL("http://localhost/api/lifeops/family-workflows/school/run"),
      config,
    );
    return { state: "applied", runId: result.runId, plan: result.plan };
  }

  async applySchool(
    runId: string,
    requestUrl: URL,
    configuredSource?: SchoolCalendarSourceConfig,
  ): Promise<void> {
    const gateway = this.runtime.getService(
      CALENDAR_OWNER_MUTATION_GATEWAY_SERVICE,
    ) as
      | Parameters<SchoolCalendarWorkflow["applyApprovedPlan"]>[0]["gateway"]
      | null;
    if (!gateway)
      throw new Error(
        "[FamilyWorkflowRuntime] calendar mutation gateway unavailable",
      );
    const config =
      configuredSource ??
      (await this.school.status()).config ??
      CONCORD_SCHOOL_CALENDAR_SOURCE;
    await this.school.applyApprovedPlan({ runId, requestUrl, gateway, config });
  }

  async collectCanonicalClaims(
    period: FamilyPacketPeriod,
  ): Promise<FamilyPacketClaim[]> {
    if (this.deps.collectClaims) return this.deps.collectClaims(period);
    const claims: FamilyPacketClaim[] = [];
    const calendar = this.runtime.getService<CalendarService>(
      CalendarService.serviceType,
    );
    if (calendar) {
      const feed = await calendar.getCalendarFeed(
        new URL("http://localhost/api/lifeops/calendar/feed"),
        familyPacketCalendarWindow(period),
      );
      claims.push(
        ...collectCalendarClaims(
          feed,
          await calendar.listLinkedCalendarEvents(),
          await this.school.listImportedEvents(),
        ),
      );
    }
    const school = getSchoolSourceFactRuntimeService(this.runtime);
    if (school) claims.push(...(await school.listFacts()).map(schoolClaim));
    const agreements = getAgreementKnowledgeService(this.runtime);
    if (agreements) {
      for (const obligation of await agreements.listApprovedObligations()) {
        claims.push(
          obligationClaim(
            obligation,
            await agreements.listActiveGuestPrincipals({
              artifactId: obligation.artifactId,
              ownerEntityId: SELF_ENTITY_ID,
            }),
          ),
        );
      }
    }
    const household = new HouseholdCoordinationRepository(
      this.runtime,
      this.runtime.agentId,
    );
    for (const agreement of await household.listAgreements()) {
      if (!agreement.isCurrent) continue;
      claims.push({
        claimId: `household:${agreement.id}`,
        stableKey: `household:${agreement.coordinationId}`,
        section: "custody_calendar",
        statement: agreement.terms.summary,
        visibility: "guest_shareable",
        provenance: [
          {
            source: "household",
            sourceId: agreement.id,
            observedAt: agreement.activatedAt,
            contentSha256: hash(agreement),
          },
        ],
        dates: [`${agreement.terms.startAt} through ${agreement.terms.endAt}`],
        requests: [],
        urgency: null,
        commitments: [],
        accountability: [],
        recipientEntityIds: agreement.approvedByEntityIds.filter(
          (entityId) => entityId !== SELF_ENTITY_ID,
        ),
      });
    }
    const travel = (await resolveOwnerFactStore(this.runtime).read())
      .activeTravel;
    if (travel) {
      claims.push({
        claimId: `owner-travel:${travel.provenance.recordedAt}`,
        stableKey: "owner:active-travel",
        section: "travel_consent_health",
        statement: "Owner travel window is active.",
        visibility: "owner_only",
        provenance: [
          {
            source: "knowledge",
            sourceId: "owner-fact:activeTravel",
            observedAt: travel.provenance.recordedAt,
            contentSha256: hash(travel.value),
          },
        ],
        dates: [travel.value.startIso, travel.value.endIso].filter(
          (value): value is string => Boolean(value),
        ),
        requests: [],
        urgency: null,
        commitments: [],
        accountability: [],
      });
    }
    const intakeReviews = await new FamilyIntakeReviewStore(
      this.runtime,
    ).listThrough(period.key);
    if (intakeReviews.some((review) => review.status === "reviewed")) {
      const intake = getFamilyIntakeService(this.runtime);
      claims.push(
        ...(await intake.reviewedFacts(period.key)).map(familyIntakeClaim),
      );
    }
    return claims;
  }

  async generatePacket(
    period = nextFamilyPacketPeriod(this.now()),
  ): Promise<MonthlyFamilyPacket> {
    return this.packets.buildInternal(
      period,
      await this.collectCanonicalClaims(period),
    );
  }

  async createDraft(
    packetId: string,
    input: {
      expectedPacketVersion: number;
      recipient: string;
      recipientEntityId: string;
      calendarPrivacyMode: "full" | "times_only" | "busy_only";
      email?: FamilyPacketEmailDelivery;
    },
  ): Promise<MonthlyFamilyDraft> {
    const packet = await this.packets.read(packetId);
    if (!packet) throw new Error("[FamilyWorkflowRuntime] packet not found");
    if (packet.version !== input.expectedPacketVersion) {
      throw new ElizaError(
        "The packet changed. Refresh and review its latest version before creating a draft.",
        {
          code: "FAMILY_PACKET_VERSION_STALE",
          context: {
            packetId,
            expectedVersion: input.expectedPacketVersion,
            currentVersion: packet.version,
          },
        },
      );
    }
    const recipient = input.recipient.trim();
    await this.validateRecipientIdentity({ ...input, recipient });
    if (input.email) {
      await new LifeOpsService(this.runtime).requireGoogleGmailSendGrant(
        new URL("http://localhost"),
        "local",
        "owner",
        input.email.senderGrantId,
      );
    }
    return this.packets.createExternalDraft(packet, { ...input, recipient });
  }

  async reviseDraft(input: {
    packetId: string;
    expectedDraftVersion: number;
    body: string;
    subject: string;
  }): Promise<MonthlyFamilyDraft> {
    const previous = await this.packets.readDraft(
      input.packetId,
      input.expectedDraftVersion,
    );
    if (!previous?.email)
      throw new ElizaError("Email draft not found", {
        code: "FAMILY_PACKET_DRAFT_STALE",
        context: {
          packetId: input.packetId,
          draftVersion: input.expectedDraftVersion,
        },
      });
    await this.validateRecipientIdentity(previous);
    await new LifeOpsService(this.runtime).requireGoogleGmailSendGrant(
      new URL("http://localhost"),
      "local",
      "owner",
      previous.email.senderGrantId,
    );
    return this.packets.reviseDraft(input);
  }

  async emailOptions(): Promise<FamilyEmailOptions> {
    const graph = resolveKnowledgeGraphService(this.runtime);
    if (!graph) throw new Error("Verified contacts are unavailable");
    const [accounts, people] = await Promise.all([
      new LifeOpsService(this.runtime).getGoogleConnectorAccounts(
        new URL("http://localhost"),
        "owner",
      ),
      graph.getEntityStore(this.runtime.agentId).list({ type: "person" }),
    ]);
    return {
      accounts: accounts.flatMap((account) => {
        if (
          !account.connected ||
          !account.grant ||
          !account.grantedCapabilities.includes("google.gmail.send")
        )
          return [];
        const label = account.identity?.email;
        if (typeof label !== "string" || !label.trim())
          throw new Error(
            "Sending account identity is unavailable. Reconnect Google before preparing email.",
          );
        return [{ grantId: account.grant.id, label }];
      }),
      recipients: people.flatMap((person) =>
        person.identities
          .filter(
            (identity) =>
              identity.verified &&
              ["email", "gmail"].includes(identity.platform.toLowerCase()),
          )
          .map((identity) => ({
            entityId: person.entityId,
            name: person.preferredName,
            address: identity.handle,
          })),
      ),
    };
  }

  async confirmEmailRecipient(input: {
    entityId: string | null;
    name: string;
    address: string;
    confirmedBy: string;
  }): Promise<{ entityId: string; name: string; address: string }> {
    const graph = resolveKnowledgeGraphService(this.runtime);
    if (!graph)
      throw new ElizaError(
        "The contact graph is unavailable. Retry recipient setup when it is ready.",
        { code: "FAMILY_RECIPIENT_GRAPH_UNAVAILABLE" },
      );
    return graph
      .getEntityStore(this.runtime.agentId)
      .confirmEmailRecipient(input);
  }

  async validateRecipientIdentity(input: {
    recipientEntityId: string;
    recipient: string;
    email?: FamilyPacketEmailDelivery | null;
  }): Promise<void> {
    const entity = await resolveKnowledgeGraphService(this.runtime)
      ?.getEntityStore(this.runtime.agentId)
      .get(input.recipientEntityId);
    const recipient = input.recipient.trim();
    if (
      !entity?.identities.some(
        (identity) =>
          identity.verified &&
          (input.email
            ? ["email", "gmail"]
            : ["imessage", "blooio", "sms", "phone"]
          ).includes(identity.platform.toLowerCase()) &&
          (input.email
            ? identity.handle.toLowerCase() === recipient.toLowerCase()
            : identity.handle === recipient),
      )
    ) {
      throw new Error(
        "[FamilyWorkflowRuntime] recipient is not a verified identity for the selected delivery channel",
      );
    }
  }

  async requestDraftApproval(args: {
    packetId: string;
    draftVersion: number;
    requestedBy: string;
    subjectUserId: string;
    expiresAt: Date;
  }): Promise<ApprovalRequest> {
    const draft = await this.packets.readDraft(
      args.packetId,
      args.draftVersion,
    );
    if (!draft) throw new Error("[FamilyWorkflowRuntime] draft not found");
    return this.packets.enqueueDraftApproval({
      ...args,
      draft,
      queue: createApprovalQueue(this.runtime, {
        agentId: this.runtime.agentId,
      }),
    });
  }

  async readDraftApprovalStatus(
    packetId: string,
    draftVersion: number,
    ownerUserId: string,
  ): Promise<FamilyDraftApprovalStatus | null> {
    const id = await this.packets.readDraftApprovalId(packetId, draftVersion);
    if (!id) return null;
    const queue = createApprovalQueue(this.runtime, {
      agentId: this.runtime.agentId,
    });
    const approval = await queue.byId(id, ownerUserId);
    if (!approval)
      throw new ElizaError(
        "The saved approval status is unavailable. Check delivery before retrying.",
        { code: "FAMILY_PACKET_APPROVAL_UNAVAILABLE" },
      );
    return draftApprovalStatus(approval);
  }

  async decideDraftApproval(input: {
    packetId: string;
    draftVersion: number;
    approvalId: string;
    bodySha256: string;
    decision: "approve" | "reject";
    ownerUserId: string;
  }) {
    const draft = await this.packets.readDraft(
      input.packetId,
      input.draftVersion,
    );
    const approvalId = await this.packets.readDraftApprovalId(
      input.packetId,
      input.draftVersion,
    );
    const queue = createApprovalQueue(this.runtime, {
      agentId: this.runtime.agentId,
    });
    const approval = await queue.byId(input.approvalId, input.ownerUserId);
    if (
      !draft?.email ||
      draft.bodySha256 !== input.bodySha256 ||
      approvalId !== input.approvalId ||
      !approval ||
      approval.subjectUserId !== input.ownerUserId ||
      approval.action !== "send_email"
    )
      throw new ElizaError(
        "The reviewed email approval could not be verified. Reload the draft.",
        { code: "FAMILY_PACKET_APPROVAL_INVALID" },
      );
    if (
      input.decision === "approve" &&
      ["pending", "approved", "retryable"].includes(approval.state)
    ) {
      await this.packets.validateDraftForDecision(approval);
      await this.validateRecipientIdentity(draft);
    }
    const { resolveExplicitOwnerApproval } = await import(
      "../../actions/resolve-request.js"
    );
    const result = await resolveExplicitOwnerApproval(this.runtime, {
      subjectUserId: input.ownerUserId,
      requestId: approval.id,
      decision: input.decision,
      reason: "Owner reviewed the exact family email in Family Operations.",
    });
    const persisted = await queue.byId(approval.id, input.ownerUserId);
    if (!persisted)
      throw new ElizaError(
        "Approval result could not be read. Check delivery before retrying.",
        { code: "FAMILY_PACKET_APPROVAL_UNAVAILABLE" },
      );
    return { result, approval: draftApprovalStatus(persisted) };
  }

  async runMonthly(
    trigger: "manual" | "scheduled",
  ): Promise<FamilyWorkflowRunResult> {
    await new CalendarCardAccessStore(this.runtime).cleanup();
    await this.ensureSchema();
    const period = nextFamilyPacketPeriod(this.now());
    const token = randomUUID();
    const now = this.now();
    const expires = new Date(now.getTime() + RUN_LEASE_MS).toISOString();
    const runId = randomUUID();
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_family_workflow_runs (agent_id,period_key,run_id,state,trigger_kind,lease_token,lease_expires_at,created_at,updated_at) VALUES (${sqlQuote(this.runtime.agentId)},${sqlQuote(period.key)},${sqlQuote(runId)},'running',${sqlQuote(trigger)},${sqlQuote(token)},${sqlQuote(expires)},${sqlQuote(now.toISOString())},${sqlQuote(now.toISOString())}) ON CONFLICT (agent_id,period_key) DO NOTHING`,
    );
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_family_workflow_runs SET run_id=${sqlQuote(runId)},state='running',trigger_kind=${sqlQuote(trigger)},lease_token=${sqlQuote(token)},lease_expires_at=${sqlQuote(expires)},updated_at=${sqlQuote(now.toISOString())} WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND period_key=${sqlQuote(period.key)} AND state <> 'completed' AND (lease_token IS NULL OR lease_expires_at < ${sqlQuote(now.toISOString())} OR lease_token=${sqlQuote(token)}) RETURNING run_id`,
    );
    if (rows.length === 0) {
      const existing = await executeRawSql(
        this.runtime,
        `SELECT run_id,state,result_json FROM app_lifeops.life_family_workflow_runs WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND period_key=${sqlQuote(period.key)} LIMIT 1`,
      );
      const row = existing[0];
      if (toText(row?.state) === "completed") {
        const result = parseJsonValue<FamilyWorkflowRunResult>(
          row?.result_json,
          null as never,
        );
        return { ...result, state: "deduplicated" };
      }
      return {
        state: "already_running",
        runId: toText(row?.run_id),
        periodKey: period.key,
        school: null,
        packet: null,
      };
    }
    try {
      const school = await this.runSchool(trigger);
      const packet = await this.generatePacket(period);
      const result: FamilyWorkflowRunResult = {
        state: "completed",
        runId,
        periodKey: period.key,
        school,
        packet,
      };
      await executeRawSql(
        this.runtime,
        `UPDATE app_lifeops.life_family_workflow_runs SET state='completed',lease_token=NULL,lease_expires_at=NULL,result_json=${sqlQuote(JSON.stringify(result))},updated_at=${sqlQuote(this.now().toISOString())} WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND period_key=${sqlQuote(period.key)} AND lease_token=${sqlQuote(token)}`,
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await executeRawSql(
        this.runtime,
        `UPDATE app_lifeops.life_family_workflow_runs SET state='failed',lease_token=NULL,lease_expires_at=NULL,error_message=${sqlQuote(message)},updated_at=${sqlQuote(this.now().toISOString())} WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND period_key=${sqlQuote(period.key)} AND lease_token=${sqlQuote(token)}`,
      );
      throw error;
    }
  }
}

export function getFamilyWorkflowRuntimeService(
  runtime: IAgentRuntime,
): FamilyWorkflowRuntimeService | null {
  return runtime.getService<FamilyWorkflowRuntimeService>(
    FAMILY_WORKFLOW_RUNTIME_SERVICE,
  );
}
