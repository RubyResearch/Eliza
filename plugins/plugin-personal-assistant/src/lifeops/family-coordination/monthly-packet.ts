/**
 * Durable monthly family-coordination packets project existing LifeOps facts
 * into an owner-internal aggregate and a separately versioned, guest-shareable
 * draft. Drafting is deterministic, provenance-preserving, expense-free, and
 * can only enter the canonical approval queue; this module never dispatches it.
 */

import { createHash } from "node:crypto";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import type {
  ApprovalQueue,
  ApprovalRequest,
} from "../approval-queue.types.js";
import {
  assertFamilyWorkspaceActive,
  beginFamilyWorkspaceOperation,
  settleFamilyWorkspaceOperation,
  withFamilyWorkspaceStateTransaction,
} from "../family-workflows/workspace-operation-store.js";
import { getAgreementKnowledgeService } from "../household/agreement-knowledge.js";
import {
  executeRawSql,
  executeRawSqlTx,
  parseJsonArray,
  parseJsonValue,
  sqlQuote,
  type TransactionalDb,
  toNumber,
  toText,
} from "../sql.js";

import { validateFamilyIntakeClaim } from "./intake-claims.js";
import type { FamilyIntakeFactBinding } from "./intake-service.js";

export const FAMILY_PACKET_VERSION = 1 as const;

export const FAMILY_PACKET_SECTIONS = [
  "custody_calendar",
  "school",
  "approved_obligations",
  "travel_consent_health",
  "unanswered",
] as const;

export type FamilyPacketSection = (typeof FAMILY_PACKET_SECTIONS)[number];
export type FamilyPacketVisibility = "owner_only" | "guest_shareable";

export interface FamilyPacketProvenance {
  readonly source:
    | "household"
    | "calendar"
    | "school"
    | "agreement"
    | "knowledge"
    | "correspondence";
  readonly sourceId: string;
  readonly observedAt: string;
  readonly contentSha256: string;
}

export interface FamilyPacketClaim {
  readonly intakeBinding?: FamilyIntakeFactBinding;
  readonly claimId: string;
  readonly stableKey: string;
  readonly section: FamilyPacketSection;
  readonly statement: string;
  readonly visibility: FamilyPacketVisibility;
  readonly provenance: readonly FamilyPacketProvenance[];
  readonly dates: readonly string[];
  readonly requests: readonly string[];
  readonly urgency: string | null;
  readonly commitments: readonly string[];
  readonly accountability: readonly string[];
  readonly obligationApprovalId?: string | null;
  /** Exact guest Entities allowed to receive this non-public claim. */
  readonly recipientEntityIds?: readonly string[];
  /** Required for revalidating agreement access immediately before projection/send. */
  readonly agreementArtifactId?: string | null;
  readonly unanswered?: boolean;
  readonly carryForwardCount?: 0 | 1;
  readonly carriedFromClaimId?: string | null;
}

export interface FamilyPacketPeriod {
  readonly key: string;
  readonly startsOn: string;
  readonly endsOnExclusive: string;
  readonly timeZone: string;
}

export type FamilyPacketSectionState = "complete" | "missing" | "contradictory";

export interface FamilyPacketSectionSummary {
  readonly section: FamilyPacketSection;
  readonly state: FamilyPacketSectionState;
  readonly claimIds: readonly string[];
  readonly contradictoryKeys: readonly string[];
}

export interface MonthlyFamilyPacket {
  readonly schemaVersion: typeof FAMILY_PACKET_VERSION;
  readonly packetId: string;
  readonly agentId: string;
  readonly period: FamilyPacketPeriod;
  readonly version: number;
  readonly claims: readonly FamilyPacketClaim[];
  readonly sections: readonly FamilyPacketSectionSummary[];
  readonly contentSha256: string;
  readonly createdAt: string;
}

export interface FamilyPacketTransformation {
  readonly kind:
    | "private_claim_omitted"
    | "unapproved_obligation_omitted"
    | "recipient_acl_omitted"
    | "agreement_grant_omitted"
    | "calendar_privacy_redacted"
    | "internal_metadata_omitted"
    | "contradiction_surfaced"
    | "missing_section_surfaced"
    | "owner_text_edited"
    | "unanswered_carried_once";
  readonly claimId: string | null;
  readonly detail: string;
}

export interface MonthlyFamilyDraft {
  readonly packetId: string;
  readonly internalVersion: number;
  readonly draftVersion: number;
  readonly recipient: string;
  readonly recipientEntityId: string;
  readonly calendarPrivacyMode: "full" | "times_only" | "busy_only";
  readonly includedClaimIds: readonly string[];
  readonly body: string;
  readonly bodySha256: string;
  readonly transformations: readonly FamilyPacketTransformation[];
  readonly createdAt: string;
  readonly email: FamilyPacketEmailDelivery | null;
}

export interface FamilyPacketEmailDelivery {
  readonly subject: string;
  readonly senderGrantId: string;
}

function matchesDraftApproval(
  draft: MonthlyFamilyDraft,
  request: ApprovalRequest,
): boolean {
  const payload = request.payload;
  if (draft.email) {
    return (
      request.action === "send_email" &&
      payload.action === "send_email" &&
      request.channel === "email" &&
      payload.to.length === 1 &&
      payload.to[0] === draft.recipient &&
      payload.cc.length === 0 &&
      payload.bcc.length === 0 &&
      !payload.threadId &&
      !payload.replyToMessageId &&
      payload.subject === draft.email.subject &&
      payload.grantId === draft.email.senderGrantId &&
      payload.body === draft.body &&
      sha256(payload.body) === draft.bodySha256
    );
  }
  return (
    request.action === "send_message" &&
    payload.action === "send_message" &&
    request.channel === "imessage" &&
    payload.recipient === draft.recipient &&
    !payload.replyToMessageId &&
    payload.body === draft.body &&
    sha256(payload.body) === draft.bodySha256
  );
}

function readEmailDelivery(value: unknown): FamilyPacketEmailDelivery | null {
  if (value === null || value === undefined) return null;
  const parsed = parseJsonValue<unknown>(value, null);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("subject" in parsed) ||
    typeof parsed.subject !== "string" ||
    !parsed.subject.trim() ||
    !("senderGrantId" in parsed) ||
    typeof parsed.senderGrantId !== "string" ||
    !parsed.senderGrantId.trim()
  ) {
    fail("stored email delivery is invalid", "FAMILY_PACKET_EMAIL_INVALID");
  }
  return { subject: parsed.subject, senderGrantId: parsed.senderGrantId };
}

const SCHEMA = [
  `CREATE SCHEMA IF NOT EXISTS app_lifeops`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_family_packets (
    agent_id TEXT NOT NULL, packet_id TEXT NOT NULL, period_key TEXT NOT NULL,
    internal_version INTEGER NOT NULL, content_sha256 TEXT NOT NULL,
    packet_json TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, packet_id, internal_version),
    UNIQUE (agent_id, period_key, internal_version)
  )`,
  `CREATE INDEX IF NOT EXISTS life_family_packets_period_idx
    ON app_lifeops.life_family_packets (agent_id, period_key, internal_version DESC)`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_family_packet_drafts (
    agent_id TEXT NOT NULL, packet_id TEXT NOT NULL, internal_version INTEGER NOT NULL,
    draft_version INTEGER NOT NULL, recipient TEXT NOT NULL, body TEXT NOT NULL,
    recipient_entity_id TEXT, calendar_privacy_mode TEXT,
    included_claim_ids_json TEXT,
    body_sha256 TEXT NOT NULL, transformations_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, packet_id, draft_version)
  )`,
  `ALTER TABLE app_lifeops.life_family_packet_drafts ADD COLUMN IF NOT EXISTS recipient_entity_id TEXT`,
  `ALTER TABLE app_lifeops.life_family_packet_drafts ADD COLUMN IF NOT EXISTS calendar_privacy_mode TEXT`,
  `ALTER TABLE app_lifeops.life_family_packet_drafts ADD COLUMN IF NOT EXISTS included_claim_ids_json TEXT`,
  `ALTER TABLE app_lifeops.life_family_packet_drafts ADD COLUMN IF NOT EXISTS email_json TEXT`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_family_packet_approvals (
    agent_id TEXT NOT NULL, packet_id TEXT NOT NULL, draft_version INTEGER NOT NULL,
    draft_sha256 TEXT NOT NULL, approval_id TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, packet_id, draft_version), UNIQUE (agent_id, approval_id)
  )`,
] as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fail(message: string, code: string): never {
  throw new ElizaError(`[MonthlyFamilyPacket] ${message}`, {
    code,
    severity: "ephemeral",
  });
}

function validatePeriod(period: FamilyPacketPeriod): void {
  if (!/^\d{4}-\d{2}$/.test(period.key))
    fail("invalid period key", "FAMILY_PACKET_PERIOD_INVALID");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(period.startsOn) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(period.endsOnExclusive)
  ) {
    fail(
      "period boundaries must be explicit ISO dates",
      "FAMILY_PACKET_PERIOD_INVALID",
    );
  }
  for (const boundary of [period.startsOn, period.endsOnExclusive]) {
    const parsed = new Date(`${boundary}T00:00:00.000Z`);
    if (
      !Number.isFinite(parsed.getTime()) ||
      !parsed.toISOString().startsWith(`${boundary}T`)
    )
      fail(
        "period contains an invalid calendar date",
        "FAMILY_PACKET_PERIOD_INVALID",
      );
  }
  if (
    period.startsOn >= period.endsOnExclusive ||
    period.timeZone.trim() === ""
  ) {
    fail(
      "period boundary or timezone is invalid",
      "FAMILY_PACKET_PERIOD_INVALID",
    );
  }
}

function validateClaim(claim: FamilyPacketClaim): void {
  if (!(FAMILY_PACKET_SECTIONS as readonly string[]).includes(claim.section)) {
    fail(
      "unsupported section; expenses are excluded",
      "FAMILY_PACKET_EXPENSE_FORBIDDEN",
    );
  }
  const raw = claim as FamilyPacketClaim & { dataClass?: string };
  if (raw.dataClass === "expense")
    fail("expense claims are forbidden", "FAMILY_PACKET_EXPENSE_FORBIDDEN");
  if (
    !claim.claimId ||
    !claim.stableKey ||
    !claim.statement ||
    claim.provenance.length === 0
  ) {
    fail(
      "claim and provenance fields are required",
      "FAMILY_PACKET_CLAIM_INVALID",
    );
  }
  for (const source of claim.provenance) {
    if (
      !source.sourceId ||
      !/^\d{4}-\d{2}-\d{2}T/.test(source.observedAt) ||
      !/^[a-f0-9]{64}$/.test(source.contentSha256)
    ) {
      fail(
        "claim provenance is incomplete",
        "FAMILY_PACKET_PROVENANCE_INVALID",
      );
    }
  }
  if (
    claim.provenance.some((source) => source.source === "correspondence") &&
    !claim.intakeBinding
  )
    fail(
      "correspondence requires its reviewed source binding",
      "FAMILY_INTAKE_BINDING_REQUIRED",
    );
  if (claim.section === "approved_obligations" && !claim.obligationApprovalId) {
    // Allowed internally, but it can never enter the external draft.
    return;
  }
}

function claimsForSection(
  claims: readonly FamilyPacketClaim[],
  section: FamilyPacketSection,
): FamilyPacketClaim[] {
  return claims.filter((claim) =>
    section === "unanswered"
      ? claim.unanswered === true ||
        (claim.section === section && claim.unanswered !== false)
      : claim.section === section,
  );
}

function summarizeSections(
  claims: readonly FamilyPacketClaim[],
): FamilyPacketSectionSummary[] {
  return FAMILY_PACKET_SECTIONS.map((section) => {
    const selected = claimsForSection(claims, section);
    const groups = new Map<string, Set<string>>();
    for (const claim of selected) {
      const values = groups.get(claim.stableKey) ?? new Set<string>();
      values.add(
        sha256(
          stable({
            statement: claim.statement,
            dates: claim.dates,
            requests: claim.requests,
            urgency: claim.urgency,
            commitments: claim.commitments,
            accountability: claim.accountability,
          }),
        ),
      );
      groups.set(claim.stableKey, values);
    }
    const contradictoryKeys = [...groups.entries()]
      .filter(([, values]) => values.size > 1)
      .map(([key]) => key)
      .sort();
    return {
      section,
      state:
        selected.length === 0
          ? "missing"
          : contradictoryKeys.length > 0
            ? "contradictory"
            : "complete",
      claimIds: selected.map((claim) => claim.claimId).sort(),
      contradictoryKeys,
    };
  });
}

function parsePacket(row: Record<string, unknown>): MonthlyFamilyPacket {
  return parseJsonValue<MonthlyFamilyPacket>(row.packet_json, null as never);
}

/** Serialize version allocation and hold workspace admission through commit. */
async function withPacketMutation<T>(
  runtime: IAgentRuntime,
  mutate: (tx: TransactionalDb) => Promise<T>,
): Promise<T> {
  return withFamilyWorkspaceStateTransaction(
    runtime,
    [
      "app_lifeops.life_family_packet_drafts",
      "app_lifeops.life_family_packets",
    ],
    (tx, state) => {
      assertFamilyWorkspaceActive(state);
      return mutate(tx);
    },
    { lockMode: "SHARE ROW EXCLUSIVE" },
  );
}

export class MonthlyFamilyPacketService {
  private initialized = false;

  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async ensureSchema(): Promise<void> {
    if (this.initialized) return;
    for (const statement of SCHEMA)
      await executeRawSql(this.runtime, statement);
    this.initialized = true;
  }

  async latest(periodKey: string): Promise<MonthlyFamilyPacket | null> {
    await this.ensureSchema();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT packet_json FROM app_lifeops.life_family_packets WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND period_key=${sqlQuote(periodKey)} ORDER BY internal_version DESC LIMIT 1`,
    );
    return rows[0] ? parsePacket(rows[0]) : null;
  }

  async list(periodKey?: string): Promise<MonthlyFamilyPacket[]> {
    await this.ensureSchema();
    const filter = periodKey ? ` AND period_key=${sqlQuote(periodKey)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT packet_json FROM app_lifeops.life_family_packets WHERE agent_id=${sqlQuote(this.runtime.agentId)}${filter} ORDER BY period_key DESC, internal_version DESC`,
    );
    return rows.map(parsePacket);
  }

  async read(
    packetId: string,
    version?: number,
  ): Promise<MonthlyFamilyPacket | null> {
    await this.ensureSchema();
    const versionClause =
      version === undefined ? "" : ` AND internal_version=${version}`;
    const rows = await executeRawSql(
      this.runtime,
      `SELECT packet_json FROM app_lifeops.life_family_packets WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND packet_id=${sqlQuote(packetId)}${versionClause} ORDER BY internal_version DESC LIMIT 1`,
    );
    return rows[0] ? parsePacket(rows[0]) : null;
  }

  async buildInternal(
    period: FamilyPacketPeriod,
    incoming: readonly FamilyPacketClaim[],
  ): Promise<MonthlyFamilyPacket> {
    await this.ensureSchema();
    validatePeriod(period);
    incoming.forEach(validateClaim);
    return await withPacketMutation(this.runtime, async (tx) => {
      const priorRows = await executeRawSqlTx(
        tx,
        `SELECT packet_json FROM app_lifeops.life_family_packets WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND period_key < ${sqlQuote(period.key)} ORDER BY period_key DESC, internal_version DESC LIMIT 1`,
      );
      const prior = priorRows[0] ? parsePacket(priorRows[0]) : null;
      const currentKeys = new Set(incoming.map((claim) => claim.stableKey));
      const carried = (prior?.claims ?? [])
        .filter(
          (claim) =>
            claim.unanswered === true &&
            // Correspondence is recollected from its current source review;
            // a historical packet cannot resurrect a revoked or resolved fact.
            !claim.intakeBinding &&
            (claim.carryForwardCount ?? 0) === 0 &&
            !currentKeys.has(claim.stableKey),
        )
        .map(
          (claim): FamilyPacketClaim => ({
            ...claim,
            claimId: `${claim.claimId}:carry:${period.key}`,
            carryForwardCount: 1,
            carriedFromClaimId: claim.claimId,
          }),
        );
      const claims = [...incoming, ...carried].sort((a, b) =>
        a.claimId.localeCompare(b.claimId),
      );
      const core = {
        schemaVersion: FAMILY_PACKET_VERSION,
        agentId: this.runtime.agentId,
        period,
        claims,
        sections: summarizeSections(claims),
      };
      const contentSha256 = sha256(stable(core));
      const latestRows = await executeRawSqlTx(
        tx,
        `SELECT packet_json FROM app_lifeops.life_family_packets WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND period_key=${sqlQuote(period.key)} ORDER BY internal_version DESC LIMIT 1`,
      );
      const latest = latestRows[0] ? parsePacket(latestRows[0]) : null;
      if (latest?.contentSha256 === contentSha256) return latest;
      const version = (latest?.version ?? 0) + 1;
      const packetId =
        latest?.packetId ??
        `family-packet:${this.runtime.agentId}:${period.key}`;
      const packet: MonthlyFamilyPacket = {
        ...core,
        packetId,
        version,
        contentSha256,
        createdAt: this.now().toISOString(),
      };
      await executeRawSqlTx(
        tx,
        `INSERT INTO app_lifeops.life_family_packets (agent_id,packet_id,period_key,internal_version,content_sha256,packet_json,created_at) VALUES (${sqlQuote(this.runtime.agentId)},${sqlQuote(packetId)},${sqlQuote(period.key)},${version},${sqlQuote(contentSha256)},${sqlQuote(JSON.stringify(packet))},${sqlQuote(packet.createdAt)})`,
      );
      return packet;
    });
  }

  async createExternalDraft(
    requestedPacket: MonthlyFamilyPacket,
    input: {
      recipient: string;
      recipientEntityId: string;
      calendarPrivacyMode: "full" | "times_only" | "busy_only";
      email?: FamilyPacketEmailDelivery;
    },
  ): Promise<MonthlyFamilyDraft> {
    await this.ensureSchema();
    const current = await this.latest(requestedPacket.period.key);
    if (
      !current ||
      current.packetId !== requestedPacket.packetId ||
      current.version !== requestedPacket.version ||
      current.contentSha256 !== requestedPacket.contentSha256
    ) {
      fail(
        "internal packet is stale or tampered",
        "FAMILY_PACKET_INTERNAL_STALE",
      );
    }
    // Render persisted claims, not caller-supplied fields accompanying a valid
    // version/hash. Otherwise an altered object could bypass source bindings.
    const packet = current;
    const recipient = input.recipient.trim();
    const recipientEntityId = input.recipientEntityId.trim();
    if (!recipient || !recipientEntityId)
      fail("recipient is required", "FAMILY_PACKET_RECIPIENT_INVALID");
    if (
      input.email &&
      (!input.email.subject.trim() ||
        /[\r\n]/u.test(input.email.subject) ||
        !input.email.senderGrantId.trim())
    ) {
      fail(
        "email subject and sender account are required",
        "FAMILY_PACKET_EMAIL_INVALID",
      );
    }
    const transformations: FamilyPacketTransformation[] = [];
    const shareable: FamilyPacketClaim[] = [];
    const agreements = getAgreementKnowledgeService(this.runtime);
    for (const claim of packet.claims) {
      if (claim.visibility !== "guest_shareable") {
        transformations.push({
          kind: "private_claim_omitted",
          claimId: claim.claimId,
          detail: "Owner-only claim omitted from external draft.",
        });
        continue;
      }
      if (
        claim.section === "approved_obligations" &&
        !claim.obligationApprovalId
      ) {
        transformations.push({
          kind: "unapproved_obligation_omitted",
          claimId: claim.claimId,
          detail: "Obligation notice omitted until approved.",
        });
        continue;
      }
      const requiresRecipientAcl =
        claim.section === "custody_calendar" ||
        claim.section === "approved_obligations";
      if (
        (requiresRecipientAcl || claim.recipientEntityIds !== undefined) &&
        !claim.recipientEntityIds?.includes(recipientEntityId)
      ) {
        transformations.push({
          kind: "recipient_acl_omitted",
          claimId: claim.claimId,
          detail:
            "Claim omitted because the recipient Entity is not authorized.",
        });
        continue;
      }
      if (claim.intakeBinding)
        await validateFamilyIntakeClaim(this.runtime, claim, recipientEntityId);
      if (claim.section === "approved_obligations") {
        if (!agreements || !claim.agreementArtifactId) {
          transformations.push({
            kind: "agreement_grant_omitted",
            claimId: claim.claimId,
            detail:
              "Agreement claim omitted because no resource grant can be proven.",
          });
          continue;
        }
        try {
          await agreements.readFor({
            artifactId: claim.agreementArtifactId,
            principalEntityId: recipientEntityId,
          });
        } catch {
          // error-policy:J4 authorization denial is projected as an explicit
          // omission; another claim may still be independently shareable.
          transformations.push({
            kind: "agreement_grant_omitted",
            claimId: claim.claimId,
            detail:
              "Agreement claim omitted because its guest grant is inactive.",
          });
          continue;
        }
      }
      if (claim.carriedFromClaimId)
        transformations.push({
          kind: "unanswered_carried_once",
          claimId: claim.claimId,
          detail: `Unanswered item carried once from ${claim.carriedFromClaimId}.`,
        });
      let projected = claim;
      if (
        claim.section === "custody_calendar" &&
        input.calendarPrivacyMode !== "full"
      ) {
        projected = {
          ...claim,
          statement:
            input.calendarPrivacyMode === "times_only"
              ? "Scheduled event"
              : "Busy",
          requests: [],
          commitments: [],
          accountability: [],
        };
        transformations.push({
          kind: "calendar_privacy_redacted",
          claimId: claim.claimId,
          detail: `Calendar claim projected as ${input.calendarPrivacyMode}.`,
        });
      }
      if (claim.provenance.length > 0 || claim.accountability.length > 0) {
        transformations.push({
          kind: "internal_metadata_omitted",
          claimId: claim.claimId,
          detail: "Internal provenance and Entity attribution omitted.",
        });
      }
      shareable.push(projected);
    }
    validatePeriod(packet.period);
    // Stored periods are half-open civil dates; the reader-facing range is inclusive.
    const finalDay = new Date(`${packet.period.endsOnExclusive}T00:00:00.000Z`);
    finalDay.setUTCDate(finalDay.getUTCDate() - 1);
    const inclusiveEnd = finalDay.toISOString().split("T")[0];
    const lines = [
      `Family coordination for ${packet.period.startsOn} through ${inclusiveEnd} (${packet.period.timeZone})`,
      "",
    ];
    for (const summary of summarizeSections(shareable)) {
      lines.push(`## ${summary.section.replaceAll("_", " ")}`);
      const claims = claimsForSection(shareable, summary.section);
      if (claims.length === 0) {
        lines.push("Missing: no shareable information is available.", "");
        transformations.push({
          kind: "missing_section_surfaced",
          claimId: null,
          detail: `${summary.section} has no shareable claims.`,
        });
        continue;
      }
      if (summary.state === "contradictory") {
        lines.push(
          `Needs resolution: contradictory sources for ${summary.contradictoryKeys.join(", ")}.`,
        );
        transformations.push({
          kind: "contradiction_surfaced",
          claimId: null,
          detail: `${summary.section}: ${summary.contradictoryKeys.join(", ")}`,
        });
      }
      for (const claim of claims) {
        if (
          summary.section === "unanswered" &&
          claim.section !== "unanswered"
        ) {
          // Full details already appear in the source category; repeat only the open request.
          lines.push(
            `- Awaiting response: ${claim.requests.length ? claim.requests.join("; ") : claim.statement}`,
          );
          if (claim.urgency) lines.push(`  Urgency: ${claim.urgency}`);
          continue;
        }
        lines.push(`- ${claim.statement}`);
        if (claim.dates.length)
          lines.push(`  Dates: ${claim.dates.join("; ")}`);
        if (claim.requests.length)
          lines.push(`  Requests: ${claim.requests.join("; ")}`);
        if (claim.urgency) lines.push(`  Urgency: ${claim.urgency}`);
        if (claim.commitments.length)
          lines.push(`  Commitments: ${claim.commitments.join("; ")}`);
        // Provenance and accountability remain owner-internal. The external
        // body contains only approved user-facing claim fields.
      }
      lines.push("");
    }
    const body = lines.join("\n").trimEnd();
    for (const claim of packet.claims.filter(
      (entry) => entry.visibility === "owner_only",
    )) {
      if (body.includes(claim.statement))
        fail("owner-only content leaked", "FAMILY_PACKET_PRIVACY_LEAK");
    }
    return await withPacketMutation(this.runtime, async (tx) => {
      const latestPackets = await executeRawSqlTx(
        tx,
        `SELECT packet_json FROM app_lifeops.life_family_packets WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND packet_id=${sqlQuote(packet.packetId)} ORDER BY internal_version DESC LIMIT 1`,
      );
      const latest = latestPackets[0] ? parsePacket(latestPackets[0]) : null;
      if (
        !latest ||
        latest.version !== packet.version ||
        latest.contentSha256 !== packet.contentSha256
      )
        fail(
          "Packet changed while preparing the draft",
          "FAMILY_PACKET_INTERNAL_STALE",
        );
      const rows = await executeRawSqlTx(
        tx,
        `SELECT COALESCE(MAX(draft_version),0) AS version FROM app_lifeops.life_family_packet_drafts WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND packet_id=${sqlQuote(packet.packetId)}`,
      );
      const draftVersion = toNumber(rows[0]?.version) + 1;
      const draft: MonthlyFamilyDraft = {
        packetId: packet.packetId,
        internalVersion: packet.version,
        draftVersion,
        recipient,
        recipientEntityId,
        calendarPrivacyMode: input.calendarPrivacyMode,
        includedClaimIds: shareable.map((claim) => claim.claimId),
        body,
        bodySha256: sha256(body),
        transformations,
        createdAt: this.now().toISOString(),
        email: input.email ?? null,
      };
      await executeRawSqlTx(
        tx,
        `INSERT INTO app_lifeops.life_family_packet_drafts (agent_id,packet_id,internal_version,draft_version,recipient,recipient_entity_id,calendar_privacy_mode,included_claim_ids_json,body,body_sha256,transformations_json,created_at,email_json) VALUES (${sqlQuote(this.runtime.agentId)},${sqlQuote(packet.packetId)},${packet.version},${draftVersion},${sqlQuote(recipient)},${sqlQuote(recipientEntityId)},${sqlQuote(input.calendarPrivacyMode)},${sqlQuote(JSON.stringify(draft.includedClaimIds))},${sqlQuote(body)},${sqlQuote(draft.bodySha256)},${sqlQuote(JSON.stringify(transformations))},${sqlQuote(draft.createdAt)},${draft.email ? sqlQuote(JSON.stringify(draft.email)) : "NULL"})`,
      );
      return draft;
    });
  }

  async reviseDraft(input: {
    packetId: string;
    expectedDraftVersion: number;
    body: string;
    subject: string;
  }): Promise<MonthlyFamilyDraft> {
    await this.ensureSchema();
    if (
      !Number.isSafeInteger(input.expectedDraftVersion) ||
      input.expectedDraftVersion < 1
    )
      fail(
        "A valid saved draft version is required",
        "FAMILY_PACKET_EDIT_INVALID",
      );
    if (
      !input.body.trim() ||
      !input.subject.trim() ||
      /[\r\n]/u.test(input.subject)
    )
      fail(
        "Email text and a single-line subject are required",
        "FAMILY_PACKET_EDIT_INVALID",
      );
    const previous = await this.readDraft(
      input.packetId,
      input.expectedDraftVersion,
    );
    if (!previous?.email)
      fail("Email draft not found", "FAMILY_PACKET_DRAFT_STALE");
    const packet = await this.read(input.packetId);
    if (!packet || packet.version !== previous.internalVersion)
      fail(
        "Regenerate the draft from the current packet before editing",
        "FAMILY_PACKET_INTERNAL_STALE",
      );
    for (const claim of packet.claims) {
      if (
        claim.visibility === "owner_only" &&
        (input.body.includes(claim.statement) ||
          input.subject.includes(claim.statement))
      )
        fail(
          "Owner-only content cannot be included in an external draft",
          "FAMILY_PACKET_PRIVACY_LEAK",
        );
    }
    const draft: MonthlyFamilyDraft = {
      ...previous,
      draftVersion: previous.draftVersion + 1,
      body: input.body,
      bodySha256: sha256(input.body),
      email: { ...previous.email, subject: input.subject },
      createdAt: this.now().toISOString(),
      transformations: [
        ...previous.transformations,
        {
          kind: "owner_text_edited",
          claimId: null,
          detail: `Owner revised draft ${previous.draftVersion}; a fresh approval is required.`,
        },
      ],
    };
    await withPacketMutation(this.runtime, async (tx) => {
      // Read the current versions after every publisher has acquired the same lock.
      const packets = await executeRawSqlTx(
        tx,
        `SELECT internal_version FROM app_lifeops.life_family_packets WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND packet_id=${sqlQuote(input.packetId)} ORDER BY internal_version DESC LIMIT 1 FOR UPDATE`,
      );
      if (toNumber(packets[0]?.internal_version) !== previous.internalVersion)
        fail("Packet changed while editing", "FAMILY_PACKET_INTERNAL_STALE");
      const versions = await executeRawSqlTx(
        tx,
        `SELECT MAX(draft_version) AS version FROM app_lifeops.life_family_packet_drafts WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND packet_id=${sqlQuote(input.packetId)}`,
      );
      if (toNumber(versions[0]?.version) !== input.expectedDraftVersion)
        fail(
          "Another draft was saved; reload before editing",
          "FAMILY_PACKET_DRAFT_STALE",
        );
      await executeRawSqlTx(
        tx,
        `INSERT INTO app_lifeops.life_family_packet_drafts (agent_id,packet_id,internal_version,draft_version,recipient,recipient_entity_id,calendar_privacy_mode,included_claim_ids_json,body,body_sha256,transformations_json,created_at,email_json) VALUES (${sqlQuote(this.runtime.agentId)},${sqlQuote(draft.packetId)},${draft.internalVersion},${draft.draftVersion},${sqlQuote(draft.recipient)},${sqlQuote(draft.recipientEntityId)},${sqlQuote(draft.calendarPrivacyMode)},${sqlQuote(JSON.stringify(draft.includedClaimIds))},${sqlQuote(draft.body)},${sqlQuote(draft.bodySha256)},${sqlQuote(JSON.stringify(draft.transformations))},${sqlQuote(draft.createdAt)},${sqlQuote(JSON.stringify(draft.email))})`,
      );
    });
    return draft;
  }

  async enqueueDraftApproval(args: {
    draft: MonthlyFamilyDraft;
    queue: Pick<
      ApprovalQueue,
      "enqueueTransactional" | "surfaceEnqueuedApproval"
    >;
    requestedBy: string;
    subjectUserId: string;
    expiresAt: Date;
  }): Promise<ApprovalRequest> {
    await this.ensureSchema();
    const draft = await this.readDraft(
      args.draft.packetId,
      args.draft.draftVersion,
    );
    if (
      !draft ||
      draft.bodySha256 !== args.draft.bodySha256 ||
      draft.body !== args.draft.body ||
      draft.recipient !== args.draft.recipient ||
      draft.recipientEntityId !== args.draft.recipientEntityId ||
      draft.calendarPrivacyMode !== args.draft.calendarPrivacyMode ||
      draft.email?.subject !== args.draft.email?.subject ||
      draft.email?.senderGrantId !== args.draft.email?.senderGrantId
    ) {
      fail("draft is missing or tampered", "FAMILY_PACKET_DRAFT_TAMPERED");
    }
    const operationId = await beginFamilyWorkspaceOperation(this.runtime, {
      kind: "family-packet-approval",
      packetId: draft.packetId,
      draftVersion: draft.draftVersion,
    });
    // The claim spans approval persistence and reminder surfacing. Uncertain
    // failures retain its identity for reconciliation before workspace deletion.
    const request = await withPacketMutation(this.runtime, async (tx) => {
      const packets = await executeRawSqlTx(
        tx,
        `SELECT internal_version FROM app_lifeops.life_family_packets WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND packet_id=${sqlQuote(draft.packetId)} ORDER BY internal_version DESC LIMIT 1`,
      );
      if (toNumber(packets[0]?.internal_version) !== draft.internalVersion)
        fail(
          "The source packet changed. Review a new draft before approval or delivery.",
          "FAMILY_PACKET_INTERNAL_STALE",
        );
      const latestRows = await executeRawSqlTx(
        tx,
        `SELECT MAX(draft_version) AS version FROM app_lifeops.life_family_packet_drafts WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND packet_id=${sqlQuote(draft.packetId)}`,
      );
      if (toNumber(latestRows[0]?.version) !== draft.draftVersion)
        fail("draft approval is stale", "FAMILY_PACKET_DRAFT_STALE");
      const enqueued = await args.queue.enqueueTransactional(
        {
          requestedBy: args.requestedBy,
          subjectUserId: args.subjectUserId,
          action: draft.email ? "send_email" : "send_message",
          payload: draft.email
            ? {
                action: "send_email",
                familyPacketId: draft.packetId,
                grantId: draft.email.senderGrantId,
                to: [draft.recipient],
                cc: [],
                bcc: [],
                subject: draft.email.subject,
                body: draft.body,
                threadId: null,
              }
            : {
                action: "send_message",
                familyPacketId: draft.packetId,
                recipient: draft.recipient,
                body: draft.body,
                replyToMessageId: null,
              },
          channel: draft.email ? "email" : "imessage",
          reason: `Review monthly family coordination packet ${draft.packetId} draft ${draft.draftVersion}`,
          idempotencyKey: `family-packet:${draft.packetId}:draft:${draft.draftVersion}:${draft.bodySha256}`,
          expiresAt: args.expiresAt,
        },
        tx,
      );
      const approval = enqueued.request;
      if (!matchesDraftApproval(draft, approval)) {
        fail(
          "approval payload does not match the immutable draft",
          "FAMILY_PACKET_APPROVAL_TAMPERED",
        );
      }
      await executeRawSqlTx(
        tx,
        `INSERT INTO app_lifeops.life_family_packet_approvals (agent_id,packet_id,draft_version,draft_sha256,approval_id,created_at) VALUES (${sqlQuote(this.runtime.agentId)},${sqlQuote(draft.packetId)},${draft.draftVersion},${sqlQuote(draft.bodySha256)},${sqlQuote(approval.id)},${sqlQuote(this.now().toISOString())}) ON CONFLICT (agent_id,packet_id,draft_version) DO UPDATE SET draft_sha256=EXCLUDED.draft_sha256,approval_id=EXCLUDED.approval_id,created_at=EXCLUDED.created_at`,
      );
      return approval;
    });
    await args.queue.surfaceEnqueuedApproval(request);
    await settleFamilyWorkspaceOperation(this.runtime, operationId);
    return request;
  }

  async validateApprovedDraft(
    request: ApprovalRequest,
  ): Promise<MonthlyFamilyDraft> {
    await this.ensureSchema();
    if (
      request.state !== "approved" ||
      (request.action !== "send_message" && request.action !== "send_email")
    )
      fail(
        "approval is not an approved message",
        "FAMILY_PACKET_APPROVAL_INVALID",
      );
    return this.validateBoundDraft(request);
  }

  async validateDraftForDecision(
    request: ApprovalRequest,
  ): Promise<MonthlyFamilyDraft> {
    if (!["pending", "approved", "retryable"].includes(request.state))
      fail(
        "Approval cannot accept a new decision",
        "FAMILY_PACKET_APPROVAL_INVALID",
      );
    await this.ensureSchema();
    return this.validateBoundDraft(request);
  }

  private async validateBoundDraft(
    request: ApprovalRequest,
  ): Promise<MonthlyFamilyDraft> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT packet_id,draft_version,draft_sha256 FROM app_lifeops.life_family_packet_approvals WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND approval_id=${sqlQuote(request.id)} LIMIT 1`,
    );
    const binding = rows[0];
    if (!binding)
      fail(
        "approval is not bound to a packet draft",
        "FAMILY_PACKET_APPROVAL_INVALID",
      );
    const draft = await this.readDraft(
      toText(binding.packet_id),
      toNumber(binding.draft_version),
    );
    if (
      !draft ||
      draft.bodySha256 !== toText(binding.draft_sha256) ||
      !matchesDraftApproval(draft, request) ||
      ((request.payload.action === "send_email" ||
        request.payload.action === "send_message") &&
        request.payload.familyPacketId !== undefined &&
        request.payload.familyPacketId !== draft.packetId)
    )
      fail("approved payload was tampered", "FAMILY_PACKET_APPROVAL_TAMPERED");
    const latestPacket = await this.read(draft.packetId);
    if (!latestPacket || latestPacket.version !== draft.internalVersion)
      fail(
        "The source packet changed. Review a new draft before approval or delivery.",
        "FAMILY_PACKET_INTERNAL_STALE",
      );
    const latestRows = await executeRawSql(
      this.runtime,
      `SELECT MAX(draft_version) AS version FROM app_lifeops.life_family_packet_drafts WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND packet_id=${sqlQuote(draft.packetId)}`,
    );
    if (toNumber(latestRows[0]?.version) !== draft.draftVersion)
      fail("approved draft is stale", "FAMILY_PACKET_APPROVAL_STALE");
    await this.validateDraftRecipientAccess(draft);
    return draft;
  }

  private async validateDraftRecipientAccess(
    draft: MonthlyFamilyDraft,
  ): Promise<void> {
    const packet = await this.read(draft.packetId, draft.internalVersion);
    if (!packet)
      fail("draft source packet is missing", "FAMILY_PACKET_APPROVAL_STALE");
    const included = new Set(draft.includedClaimIds);
    const agreements = getAgreementKnowledgeService(this.runtime);
    for (const claim of packet.claims) {
      if (!included.has(claim.claimId)) continue;
      if (claim.intakeBinding)
        await validateFamilyIntakeClaim(
          this.runtime,
          claim,
          draft.recipientEntityId,
        );
      if (
        (claim.section === "custody_calendar" ||
          claim.section === "approved_obligations") &&
        !claim.recipientEntityIds?.includes(draft.recipientEntityId)
      ) {
        fail(
          "recipient claim authorization changed",
          "FAMILY_PACKET_RECIPIENT_ACCESS_REVOKED",
        );
      }
      if (claim.section === "approved_obligations") {
        if (!agreements || !claim.agreementArtifactId) {
          fail(
            "agreement grant cannot be revalidated",
            "FAMILY_PACKET_RECIPIENT_ACCESS_REVOKED",
          );
        }
        await agreements.readFor({
          artifactId: claim.agreementArtifactId,
          principalEntityId: draft.recipientEntityId,
        });
      }
    }
  }

  /** Return null for unrelated approvals; otherwise enforce the full stale guard. */
  async validateApprovedDraftIfBound(
    request: ApprovalRequest,
  ): Promise<MonthlyFamilyDraft | null> {
    await this.ensureSchema();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT approval_id FROM app_lifeops.life_family_packet_approvals WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND approval_id=${sqlQuote(request.id)} LIMIT 1`,
    );
    if (
      (request.payload.action === "send_email" ||
        request.payload.action === "send_message") &&
      request.payload.familyPacketId &&
      !rows[0]
    )
      fail(
        "family approval binding is missing",
        "FAMILY_PACKET_APPROVAL_INVALID",
      );
    return rows[0] ? this.validateApprovedDraft(request) : null;
  }

  async readDraft(
    packetId: string,
    version: number,
  ): Promise<MonthlyFamilyDraft | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_family_packet_drafts WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND packet_id=${sqlQuote(packetId)} AND draft_version=${version} LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      packetId: toText(row.packet_id),
      internalVersion: toNumber(row.internal_version),
      draftVersion: toNumber(row.draft_version),
      recipient: toText(row.recipient),
      recipientEntityId: toText(row.recipient_entity_id),
      calendarPrivacyMode: toText(
        row.calendar_privacy_mode,
      ) as MonthlyFamilyDraft["calendarPrivacyMode"],
      includedClaimIds: parseJsonArray<string>(row.included_claim_ids_json),
      body: toText(row.body),
      bodySha256: toText(row.body_sha256),
      transformations: parseJsonArray<FamilyPacketTransformation>(
        row.transformations_json,
      ),
      createdAt: toText(row.created_at),
      email: readEmailDelivery(row.email_json),
    };
  }

  async readLatestDraft(
    packetId: string,
    internalVersion?: number,
  ): Promise<MonthlyFamilyDraft | null> {
    if (
      internalVersion !== undefined &&
      (!Number.isSafeInteger(internalVersion) || internalVersion < 1)
    )
      fail(
        "Packet version must be a positive integer",
        "FAMILY_PACKET_VERSION_INVALID",
      );
    await this.ensureSchema();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT draft_version FROM app_lifeops.life_family_packet_drafts WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND packet_id=${sqlQuote(packetId)}${internalVersion === undefined ? "" : ` AND internal_version=${internalVersion}`} ORDER BY draft_version DESC LIMIT 1`,
    );
    return rows[0]
      ? this.readDraft(packetId, toNumber(rows[0].draft_version))
      : null;
  }

  async readDraftApprovalId(
    packetId: string,
    draftVersion: number,
  ): Promise<string | null> {
    await this.ensureSchema();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT approval_id FROM app_lifeops.life_family_packet_approvals WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND packet_id=${sqlQuote(packetId)} AND draft_version=${draftVersion} LIMIT 1`,
    );
    return rows[0] ? toText(rows[0].approval_id) : null;
  }
}
