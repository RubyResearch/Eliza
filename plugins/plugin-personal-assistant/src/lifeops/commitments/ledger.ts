/**
 * Durable commitment and obligation ledger primitives for LifeOps. Connector
 * and document ingestion code can write normalized rows here, while brief and
 * prioritization paths can audit the same records for orphaned promises,
 * renewal/filing deadlines, and "what will I regret" queries.
 */
import crypto from "node:crypto";

export type LifeOpsCommitmentSource =
  | "sent_mail"
  | "transcript"
  | "chat"
  | "document";

export type LifeOpsCommitmentKind =
  | "commitment"
  | "renewal"
  | "filing"
  | "warranty";

export type LifeOpsCommitmentStatus =
  | "open"
  | "tracked"
  | "completed"
  | "dismissed"
  | "superseded";

export interface LifeOpsCommitmentLedgerRecord {
  id: string;
  agentId: string;
  source: LifeOpsCommitmentSource;
  sourceKey: string;
  kind: LifeOpsCommitmentKind;
  summary: string;
  counterparty: string | null;
  dueAt: string | null;
  confidence: number;
  status: LifeOpsCommitmentStatus;
  scheduledTaskId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CommitmentExtractionInput {
  agentId: string;
  source: LifeOpsCommitmentSource;
  sourceKey: string;
  text: string;
  observedAt: string;
  counterparty?: string | null;
  metadata?: Record<string, unknown>;
}

export interface DocumentObligationInput {
  agentId: string;
  documentId: string;
  title: string;
  deadline: string;
  observedAt: string;
  note?: string | null;
  counterparty?: string | null;
  scheduledTaskId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CommitmentRegretAuditItem {
  record: LifeOpsCommitmentLedgerRecord;
  score: number;
  reasons: string[];
}

export interface CommitmentRegretAudit {
  generatedAt: string;
  horizonEndAt: string;
  items: CommitmentRegretAuditItem[];
}

const COMMITMENT_RE =
  /\b(i(?:'ll| will| can| need to| owe| promised to)|we(?:'ll| will| need to)|let me|i am going to)\b/i;
const SPECULATIVE_RE =
  /\b(maybe|sometime|eventually|if we get around to it|might|could)\b/i;

/**
 * Event kind emitted when a deadline-bearing obligation artifact is observed.
 * Standing class guarantees subscribe to it with an `obligationKind` filter.
 * Lives here (a leaf module) so both the event-kind registry and the
 * standing-guarantee consumer can import it without a module cycle.
 */
export const COMMITMENT_OBLIGATION_EVENT_KIND = "document.obligation.observed";

/** Cheap deterministic prefilter: does the text contain a first-person commitment cue? */
export function textHasCommitmentCue(text: string): boolean {
  for (const cue of text.matchAll(new RegExp(COMMITMENT_RE, "gi"))) {
    // A requested affordance's purpose ("open Notes so I can see it") is
    // not an owner promise. Other cues in the same source still qualify.
    if (
      cue[0].toLowerCase() === "i can" &&
      /\bso(?:\s+that)?\s+$/i.test(text.slice(0, cue.index))
    )
      continue;
    return true;
  }
  return false;
}

/** True when the text hedges ("maybe sometime") and must never become a ledger row. */
export function isSpeculativeCommitmentText(text: string): boolean {
  return SPECULATIVE_RE.test(text);
}
const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

function sha16(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function endOfUtcDay(date: Date): string {
  const next = new Date(date.getTime());
  next.setUTCHours(17, 0, 0, 0);
  return next.toISOString();
}

function nextWeekdayIso(observedAt: string, weekdayName: string): string {
  const base = new Date(observedAt);
  const target = WEEKDAYS.indexOf(
    weekdayName.toLowerCase() as (typeof WEEKDAYS)[number],
  );
  if (target < 0 || Number.isNaN(base.getTime())) return observedAt;
  const today = base.getUTCDay();
  let delta = (target - today + 7) % 7;
  if (delta === 0) delta = 7;
  return endOfUtcDay(addUtcDays(base, delta));
}

function resolveDueAt(text: string, observedAt: string): string | null {
  const isoDate = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (isoDate?.[1]) {
    return endOfUtcDay(new Date(`${isoDate[1]}T00:00:00.000Z`));
  }
  if (/\btomorrow\b/i.test(text)) {
    return endOfUtcDay(addUtcDays(new Date(observedAt), 1));
  }
  const weekdayPattern = new RegExp(
    `\\b(?:by|before|on|next)?\\s*(${WEEKDAYS.join("|")})\\b`,
    "i",
  );
  const weekday = text.match(weekdayPattern)?.[1];
  return weekday ? nextWeekdayIso(observedAt, weekday) : null;
}

/** Classify a commitment sentence into the ledger's typed obligation kind. */
export function classifyCommitmentKind(text: string): LifeOpsCommitmentKind {
  if (/\b(renew|renewal|cancellation deadline|trial ends)\b/i.test(text)) {
    return "renewal";
  }
  if (/\b(file|filing|submit|tax|court|deadline)\b/i.test(text)) {
    return "filing";
  }
  if (/\b(warranty|guarantee|return window)\b/i.test(text)) {
    return "warranty";
  }
  return "commitment";
}

function classifyDocumentObligationKind(text: string): LifeOpsCommitmentKind {
  if (/\b(renew|renewal|auto-renew|term|msa|sow|contract)\b/i.test(text)) {
    return "renewal";
  }
  if (/\b(warranty|guarantee|return window|rma)\b/i.test(text)) {
    return "warranty";
  }
  if (
    /\b(file|filing|submit|tax|court|compliance|license|permit)\b/i.test(text)
  ) {
    return "filing";
  }
  return "commitment";
}

function firstCommitmentSentence(text: string): string | null {
  for (const part of text.split(/(?<=[.!?])\s+/)) {
    const sentence = normalizeText(part);
    if (!sentence) continue;
    if (!textHasCommitmentCue(sentence)) continue;
    if (SPECULATIVE_RE.test(sentence)) continue;
    let end = sentence.length;
    while (end > 0 && ".!?".includes(sentence[end - 1] ?? "")) end -= 1;
    return sentence.slice(0, end);
  }
  return null;
}

export function createLifeOpsCommitmentLedgerRecord(
  params: Omit<
    LifeOpsCommitmentLedgerRecord,
    "id" | "createdAt" | "updatedAt" | "status" | "scheduledTaskId"
  > & {
    id?: string;
    status?: LifeOpsCommitmentStatus;
    scheduledTaskId?: string | null;
    createdAt?: string;
    updatedAt?: string;
  },
): LifeOpsCommitmentLedgerRecord {
  const timestamp = params.createdAt ?? new Date().toISOString();
  const summary = normalizeText(params.summary);
  return {
    ...params,
    id:
      params.id ??
      `commit_${sha16(`${params.agentId}:${params.source}:${params.sourceKey}:${params.kind}:${summary}`)}`,
    summary,
    confidence: clampConfidence(params.confidence),
    status: params.status ?? "open",
    scheduledTaskId: params.scheduledTaskId ?? null,
    createdAt: timestamp,
    updatedAt: params.updatedAt ?? timestamp,
  };
}

export function extractCommitmentLedgerRecords(
  input: CommitmentExtractionInput,
): LifeOpsCommitmentLedgerRecord[] {
  const sentence = firstCommitmentSentence(input.text);
  if (!sentence) return [];
  const kind = classifyCommitmentKind(sentence);
  return [
    createLifeOpsCommitmentLedgerRecord({
      agentId: input.agentId,
      source: input.source,
      sourceKey: input.sourceKey,
      kind,
      summary: sentence,
      counterparty: input.counterparty?.trim() || null,
      dueAt: resolveDueAt(sentence, input.observedAt),
      confidence: kind === "commitment" ? 0.74 : 0.82,
      metadata: {
        ...(input.metadata ?? {}),
        observedAt: input.observedAt,
        textSha256: crypto
          .createHash("sha256")
          .update(input.text)
          .digest("hex"),
      },
    }),
  ];
}

export function createDocumentObligationLedgerRecord(
  input: DocumentObligationInput,
): LifeOpsCommitmentLedgerRecord {
  const text = normalizeText(`${input.title} ${input.note ?? ""}`);
  const kind = classifyDocumentObligationKind(text);
  return createLifeOpsCommitmentLedgerRecord({
    agentId: input.agentId,
    source: "document",
    sourceKey: input.documentId,
    kind,
    summary: `${input.title} deadline`,
    counterparty: input.counterparty?.trim() || null,
    dueAt: input.deadline,
    confidence: kind === "commitment" ? 0.76 : 0.9,
    status: input.scheduledTaskId ? "tracked" : "open",
    scheduledTaskId: input.scheduledTaskId ?? null,
    metadata: {
      ...(input.metadata ?? {}),
      observedAt: input.observedAt,
      documentTitle: input.title,
      ...(input.note ? { noteSha256: sha16(input.note) } : {}),
    },
    createdAt: input.observedAt,
    updatedAt: input.observedAt,
  });
}

export function buildCommitmentRegretAudit(
  records: LifeOpsCommitmentLedgerRecord[],
  args: { nowIso: string; horizonDays?: number } = {
    nowIso: new Date().toISOString(),
  },
): CommitmentRegretAudit {
  const now = new Date(args.nowIso);
  const horizonEnd = addUtcDays(now, args.horizonDays ?? 7);
  const horizonEndAt = horizonEnd.toISOString();
  const items = records
    .filter((record) => record.status === "open" || record.status === "tracked")
    .map((record): CommitmentRegretAuditItem => {
      const reasons: string[] = [];
      let score = record.confidence;
      if (!record.scheduledTaskId) {
        score += 0.35;
        reasons.push("no scheduled tracker");
      }
      if (record.dueAt) {
        const due = new Date(record.dueAt);
        if (due <= horizonEnd) {
          score += 0.3;
          reasons.push("due inside audit horizon");
        }
        if (due < now) {
          score += 0.25;
          reasons.push("overdue");
        }
      } else {
        score += 0.12;
        reasons.push("no explicit due date");
      }
      if (record.kind !== "commitment") {
        score += 0.15;
        reasons.push(`${record.kind} obligation`);
      }
      return { record, score: Number(score.toFixed(3)), reasons };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.record.createdAt.localeCompare(b.record.createdAt),
    );
  return { generatedAt: args.nowIso, horizonEndAt, items };
}
