/**
 * `OWNER_DOCUMENTS` umbrella action — Docs And Portals domain.
 *
 * PRD: `prd-lifeops-executive-assistant.md` §Docs And Portals. The six
 * PRD-named actions are exposed as similes on a single umbrella that
 * dispatches on `subaction`:
 *
 *   - `request_signature`  ← `OWNER_DOCUMENTS_REQUEST_SIGNATURE`
 *   - `request_approval`   ← `OWNER_DOCUMENTS_REQUEST_APPROVAL`
 *   - `track_deadline`     ← `OWNER_DOCUMENTS_TRACK_DEADLINE`
 *   - `upload_asset`       ← `OWNER_DOCUMENTS_UPLOAD_ASSET`
 *   - `collect_id`         ← `OWNER_DOCUMENTS_COLLECT_ID_OR_FORM`
 *   - `close_request`      ← `OWNER_DOCUMENTS_CLOSE_REQUEST`
 *   - `guarantee_class`    ← `OWNER_DOCUMENTS_GUARANTEE_CLASS` (#14864):
 *     installs a standing class guarantee so every future deadline-bearing
 *     artifact of that obligation class is auto-tracked with a lead-time warn.
 *
 * Each subaction composes existing services (`SCHEDULED_TASK` runner for
 * deadline tracking, `ApprovalQueue` for owner-gated dispatch). The
 * `DocumentRequest` record is held in an in-memory map keyed by runtime.
 *
 * Approval gating:
 *   - `request_signature` and `upload_asset` enqueue an `ApprovalRequest`
 *     in the `draft` -> `pending` state and wait for owner approval before
 *     dispatching the actual signing portal call / browser upload.
 *   - `request_approval`, `track_deadline`, `collect_id`, `close_request`
 *     are operator-callable without approval gating.
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { hasLifeOpsAccess } from "../lifeops/access.js";
import { createApprovalQueue } from "../lifeops/approval-queue.js";
import {
  applyCommitmentClassGuarantees,
  createDocumentObligationLedgerRecord,
  installCommitmentClassGuarantee,
  normalizeObligationClass,
} from "../lifeops/commitments/index.js";
import { LifeOpsRepository } from "../lifeops/repository.js";
import type {
  ScheduledTaskRunnerHandle,
  ScheduledTaskTrigger,
} from "../lifeops/scheduled-task/index.js";
import { getScheduledTaskRunner } from "../lifeops/scheduled-task/service.js";
import type {
  DocumentRequest,
  DocumentRequestKind,
  DocumentRequestStatus,
} from "../types/document-request.js";

const ACTION_NAME = "OWNER_DOCUMENTS";

const SUBACTIONS = [
  "request_signature",
  "request_approval",
  "track_deadline",
  "upload_asset",
  "collect_id",
  "close_request",
  "guarantee_class",
] as const;

type Subaction = (typeof SUBACTIONS)[number];

const SIMILE_NAMES: readonly string[] = [
  "OWNER_DOCUMENTS_REQUEST_SIGNATURE",
  "OWNER_DOCUMENTS_REQUEST_APPROVAL",
  "OWNER_DOCUMENTS_TRACK_DEADLINE",
  "OWNER_DOCUMENTS_UPLOAD_ASSET",
  "OWNER_DOCUMENTS_COLLECT_ID_OR_FORM",
  "OWNER_DOCUMENTS_CLOSE_REQUEST",
  "OWNER_DOCUMENTS_GUARANTEE_CLASS",
  "PAPERWORK",
];

/**
 * Map planner-facing simile (e.g.
 * `OWNER_DOCUMENTS_REQUEST_SIGNATURE`) to the umbrella subaction the handler
 * dispatches on. The map is checked when the handler is invoked through a
 * simile virtual rather than the `subaction` arg.
 */
const SIMILE_TO_SUBACTION: Readonly<Record<string, Subaction>> = {
  OWNER_DOCUMENTS_REQUEST_SIGNATURE: "request_signature",
  OWNER_DOCUMENTS_REQUEST_APPROVAL: "request_approval",
  OWNER_DOCUMENTS_TRACK_DEADLINE: "track_deadline",
  OWNER_DOCUMENTS_UPLOAD_ASSET: "upload_asset",
  OWNER_DOCUMENTS_COLLECT_ID_OR_FORM: "collect_id",
  OWNER_DOCUMENTS_CLOSE_REQUEST: "close_request",
  OWNER_DOCUMENTS_GUARANTEE_CLASS: "guarantee_class",
};

interface DocActionParameters {
  /** Canonical subaction selector. */
  subaction?: Subaction | string;
  /** Alias accepted from planner output. */
  action?: Subaction | string;
  /** Alias accepted from planner output. */
  op?: Subaction | string;
  /** Existing DocumentRequest id (track_deadline, close_request). */
  documentRequestId?: string;
  /** Entity (person) ref for the requestee. */
  requesteeEntityId?: string;
  /** Short human label, e.g. "Partnership NDA". */
  documentTitle?: string;
  /** ISO-8601 deadline. */
  deadline?: string;
  /** Portal endpoint for upload / collect_id. */
  portalUrl?: string;
  /** Local path or URL of the asset to upload. */
  assetPath?: string;
  /** "deck" | "headshot" | "id" | "form" | etc. */
  assetKind?: string;
  /** Optional signing portal URL (DocuSign / HelloSign / etc.). */
  signatureUrl?: string;
  /** Approval-class label for `request_approval`. */
  approvalReason?: string;
  /** Free-form note recorded on the DocumentRequest. */
  note?: string;
  /** close_request: outcome ("completed" | "expired" | "cancelled"). */
  resolution?: "completed" | "expired" | "cancelled";
  /** guarantee_class: obligation class to auto-track. */
  obligationClass?: string;
  /** guarantee_class: lead-time warn in days before each deadline (default 60). */
  warnDaysBefore?: number;
}

/**
 * In-memory DocumentRequest store. Keyed by `runtime.agentId` so multiple
 * runtimes in one test process don't bleed into each other.
 */
const DOCUMENT_STORE = new Map<string, Map<string, DocumentRequest>>();

function getDocStore(runtime: IAgentRuntime): Map<string, DocumentRequest> {
  const key = String(runtime.agentId);
  let store = DOCUMENT_STORE.get(key);
  if (!store) {
    store = new Map();
    DOCUMENT_STORE.set(key, store);
  }
  return store;
}

function newDocumentRequestId(): string {
  return `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeSubaction(value: unknown): Subaction | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const upper = trimmed.toUpperCase();
  if (upper in SIMILE_TO_SUBACTION) {
    return SIMILE_TO_SUBACTION[upper] ?? null;
  }
  const lower = trimmed.toLowerCase();
  return (SUBACTIONS as readonly string[]).includes(lower)
    ? (lower as Subaction)
    : null;
}

function resolveSubaction(params: DocActionParameters): Subaction | null {
  return (
    normalizeSubaction(params.subaction) ??
    normalizeSubaction(params.action) ??
    normalizeSubaction(params.op)
  );
}

function getParams(options: HandlerOptions | undefined): DocActionParameters {
  const raw = (options as HandlerOptions | undefined)?.parameters;
  if (raw && typeof raw === "object") {
    return raw as DocActionParameters;
  }
  return {};
}

function nowIso(): string {
  return new Date().toISOString();
}

function kindForSubaction(subaction: Subaction): DocumentRequestKind {
  switch (subaction) {
    case "request_signature":
      return "signature";
    case "request_approval":
      return "approval";
    case "upload_asset":
      return "upload";
    case "collect_id":
      return "collect_id";
    case "track_deadline":
    case "close_request":
    case "guarantee_class":
      // No new kind — these operate on existing requests or standing rules.
      return "signature";
  }
}

function missing(name: string, subaction: Subaction): ActionResult {
  return {
    success: false,
    text: `I need ${name} to ${subaction.replace("_", " ")}.`,
    data: { subaction, error: `MISSING_${name.toUpperCase()}` },
  };
}

function notFound(
  documentRequestId: string,
  subaction: Subaction,
): ActionResult {
  return {
    success: false,
    text: `No DocumentRequest found with id ${documentRequestId}.`,
    data: { subaction, error: "DOCUMENT_REQUEST_NOT_FOUND" },
  };
}

function saveDocument(
  runtime: IAgentRuntime,
  doc: DocumentRequest,
): DocumentRequest {
  const store = getDocStore(runtime);
  store.set(doc.id, doc);
  return doc;
}

function patchDocument(
  runtime: IAgentRuntime,
  id: string,
  patch: Partial<DocumentRequest>,
): DocumentRequest | null {
  const store = getDocStore(runtime);
  const existing = store.get(id);
  if (!existing) return null;
  const next: DocumentRequest = {
    ...existing,
    ...patch,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: nowIso(),
  };
  store.set(id, next);
  return next;
}

/** Read-only preflight for a queued signature approval. */
export function getDocumentRequest(
  runtime: IAgentRuntime,
  documentRequestId: string,
): DocumentRequest | null {
  return getDocStore(runtime).get(documentRequestId) ?? null;
}

/**
 * Execute an owner-approved `sign_document` request: flip the underlying
 * DocumentRequest from `pending` to `in_progress` so the deadline watcher
 * and escalators treat the signature request as live. Invoked by
 * RESOLVE_REQUEST after the approval-queue row transitions to `approved`.
 *
 * Returns `null` when the DocumentRequest no longer exists (the Wave-1
 * document store is in-memory and does not survive restarts) — callers must
 * surface that as a failure, never as a completed dispatch.
 */
export function dispatchApprovedSignatureRequest(
  runtime: IAgentRuntime,
  documentRequestId: string,
): DocumentRequest | null {
  const next = patchDocument(runtime, documentRequestId, {
    status: "in_progress",
  });
  if (!next) return null;
  logger.info(
    `[OWNER_DOCUMENTS] signature request ${documentRequestId} dispatched (status=${next.status})`,
  );
  return next;
}

interface RunnerScope {
  readonly runtime: IAgentRuntime;
  readonly runner: ScheduledTaskRunnerHandle;
  readonly agentId: string;
  readonly subjectUserId: string;
}

function makeScope(runtime: IAgentRuntime, message: Memory): RunnerScope {
  const agentId = String(runtime.agentId);
  const runner = getScheduledTaskRunner(runtime, { agentId });
  const subjectUserId =
    typeof message.entityId === "string" && message.entityId.length > 0
      ? message.entityId
      : agentId;
  return { runtime, runner, agentId, subjectUserId };
}

async function scheduleDeadlineTask(
  scope: RunnerScope,
  doc: DocumentRequest,
): Promise<string | undefined> {
  if (!doc.deadline) return undefined;
  const trigger: ScheduledTaskTrigger = {
    kind: "once",
    atIso: doc.deadline,
  };
  const task = await scope.runner.schedule({
    kind: "watcher",
    promptInstructions: `Tell the owner that the deadline for "${doc.title}" has arrived and ask them to check its status. Keep the message concise. Never expose internal record identifiers.`,
    trigger,
    priority: "medium",
    output: {
      destination: "in_app_card",
      fallback: {
        title: "Document deadline",
        body: `The deadline for "${doc.title}" is here. Please check its status.`,
      },
    },
    subject: { kind: "document", id: doc.id },
    metadata: {
      documentRequestId: doc.id,
      documentKind: doc.kind,
    },
    respectsGlobalPause: true,
    source: "user_chat",
    createdBy: scope.agentId,
    ownerVisible: true,
  });
  return task.taskId;
}

async function persistDocumentObligation(
  scope: RunnerScope,
  doc: DocumentRequest,
  scheduledTaskId: string | undefined,
): Promise<void> {
  if (!doc.deadline) return;
  const record = createDocumentObligationLedgerRecord({
    agentId: scope.agentId,
    documentId: doc.id,
    title: doc.title,
    deadline: doc.deadline,
    observedAt: doc.updatedAt,
    counterparty: doc.requesteeEntityId ?? null,
    scheduledTaskId: scheduledTaskId ?? null,
    metadata: {
      documentKind: doc.kind,
      documentStatus: doc.status,
    },
    ...(doc.note ? { note: doc.note } : {}),
  });
  const adapter = (scope.runtime as { adapter?: { db?: unknown } }).adapter;
  if (adapter?.db) {
    await new LifeOpsRepository(scope.runtime).upsertCommitmentLedgerRecord(
      record,
    );
  } else {
    logger.debug(
      `[OWNER_DOCUMENTS] commitment ledger unavailable for ${doc.id}; runtime has no SQL adapter`,
    );
  }
  // Class-level standing guarantees (#14864): a previously installed
  // guarantee whose obligation class matches this artifact's typed kind adds
  // the lead-time warn watcher and fires the guarantee's event task. Runs on
  // no-DB hosts too — the watchers live in the ScheduledTask spine.
  await applyCommitmentClassGuarantees(scope.runtime, {
    agentId: scope.agentId,
    artifact: {
      documentId: doc.id,
      title: doc.title,
      deadline: doc.deadline,
      obligationKind: record.kind,
    },
  });
}

async function handleGuaranteeClass(
  scope: RunnerScope,
  params: DocActionParameters,
): Promise<ActionResult> {
  const subaction: Subaction = "guarantee_class";
  const obligationClass = normalizeObligationClass(params.obligationClass);
  if (!obligationClass) return missing("obligationClass", subaction);
  const warnDaysBefore =
    typeof params.warnDaysBefore === "number" && params.warnDaysBefore > 0
      ? Math.floor(params.warnDaysBefore)
      : undefined;

  const task = await installCommitmentClassGuarantee(scope.runtime, {
    agentId: scope.agentId,
    obligationClass,
    ...(warnDaysBefore ? { warnDaysBefore } : {}),
  });

  const effectiveWarnDays = warnDaysBefore ?? 60;
  logger.info(
    `[OWNER_DOCUMENTS] guarantee_class class=${obligationClass} warnDays=${effectiveWarnDays} task=${task.taskId}`,
  );

  return {
    success: true,
    text: `Standing guarantee installed: every new ${obligationClass} obligation will be tracked automatically with a ${effectiveWarnDays}-day warning before its deadline.`,
    data: {
      subaction,
      obligationClass,
      warnDaysBefore: effectiveWarnDays,
      scheduledTaskId: task.taskId,
    },
  };
}

// ── Subaction handlers ───────────────────────────────────

async function handleRequestSignature(
  scope: RunnerScope,
  params: DocActionParameters,
): Promise<ActionResult> {
  const subaction: Subaction = "request_signature";
  const requesteeEntityId = params.requesteeEntityId?.trim();
  if (!requesteeEntityId) return missing("requesteeEntityId", subaction);
  const documentTitle = params.documentTitle?.trim();
  if (!documentTitle) return missing("documentTitle", subaction);
  const deadline = params.deadline?.trim();
  if (!deadline) return missing("deadline", subaction);

  const now = nowIso();
  const doc: DocumentRequest = {
    id: newDocumentRequestId(),
    kind: "signature",
    requesteeEntityId,
    title: documentTitle,
    deadline,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    createdBy: scope.agentId,
    ...(params.note ? { note: params.note } : {}),
  };

  // Owner approval gate. The actual signing dispatch waits for
  // RESOLVE_REQUEST approve to flip the approval queue entry to `done`.
  const queue = createApprovalQueue(scope.runtime, { agentId: scope.agentId });
  const approvalRequest = await queue.enqueue({
    requestedBy: ACTION_NAME,
    subjectUserId: scope.subjectUserId,
    action: "sign_document",
    payload: {
      action: "sign_document",
      documentId: doc.id,
      documentName: doc.title,
      signatureUrl: params.signatureUrl?.trim() ?? "",
      deadline,
    },
    channel: "internal",
    reason: `Request signature from ${requesteeEntityId} on "${doc.title}" by ${deadline}`,
    expiresAt: new Date(
      Date.parse(deadline) || Date.now() + 24 * 60 * 60 * 1000,
    ),
  });

  // Schedule the deadline watcher up front so a SCHEDULED_TASK exists even
  // before the owner approves. The watcher metadata carries the documentId
  // so escalators can branch on document state.
  const scheduledTaskId = await scheduleDeadlineTask(scope, doc);
  await persistDocumentObligation(scope, doc, scheduledTaskId);

  const saved = saveDocument(scope.runtime, {
    ...doc,
    status: "pending",
    approvalRequestId: approvalRequest.id,
    ...(scheduledTaskId ? { scheduledTaskId } : {}),
  });

  logger.info(
    `[OWNER_DOCUMENTS] request_signature id=${saved.id} requestee=${requesteeEntityId} deadline=${deadline} approval=${approvalRequest.id}`,
  );

  return {
    success: true,
    text: `Queued signature request for "${saved.title}" pending owner approval.`,
    data: {
      subaction,
      documentRequest: saved,
      documentRequestId: saved.id,
      status: saved.status,
      approvalRequestId: approvalRequest.id,
      scheduledTaskId: saved.scheduledTaskId ?? null,
    },
  };
}

async function handleRequestApproval(
  scope: RunnerScope,
  params: DocActionParameters,
): Promise<ActionResult> {
  const subaction: Subaction = "request_approval";
  const documentTitle = params.documentTitle?.trim();
  if (!documentTitle) return missing("documentTitle", subaction);

  const now = nowIso();
  const doc: DocumentRequest = {
    id: newDocumentRequestId(),
    kind: "approval",
    title: documentTitle,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    createdBy: scope.agentId,
    ...(params.requesteeEntityId
      ? { requesteeEntityId: params.requesteeEntityId.trim() }
      : {}),
    ...(params.deadline ? { deadline: params.deadline.trim() } : {}),
    ...(params.note ? { note: params.note } : {}),
  };

  const scheduledTaskId = await scheduleDeadlineTask(scope, doc);
  await persistDocumentObligation(scope, doc, scheduledTaskId);
  const saved = saveDocument(scope.runtime, {
    ...doc,
    ...(scheduledTaskId ? { scheduledTaskId } : {}),
  });

  logger.info(
    `[OWNER_DOCUMENTS] request_approval id=${saved.id} title="${documentTitle}" reason=${params.approvalReason ?? "(none)"}`,
  );

  return {
    success: true,
    text: `Logged approval request for "${saved.title}".`,
    data: {
      subaction,
      documentRequest: saved,
      documentRequestId: saved.id,
      status: saved.status,
      scheduledTaskId: saved.scheduledTaskId ?? null,
    },
  };
}

async function handleTrackDeadline(
  scope: RunnerScope,
  params: DocActionParameters,
): Promise<ActionResult> {
  const subaction: Subaction = "track_deadline";
  const documentRequestId = params.documentRequestId?.trim();
  if (!documentRequestId) return missing("documentRequestId", subaction);
  const store = getDocStore(scope.runtime);
  const existing = store.get(documentRequestId);
  if (!existing) return notFound(documentRequestId, subaction);

  const deadline = params.deadline?.trim() ?? existing.deadline;
  if (!deadline) return missing("deadline", subaction);

  const patched = patchDocument(scope.runtime, documentRequestId, {
    deadline,
    status: existing.status === "draft" ? "pending" : existing.status,
  });
  if (!patched) return notFound(documentRequestId, subaction);
  const scheduledTaskId = await scheduleDeadlineTask(scope, patched);
  await persistDocumentObligation(scope, patched, scheduledTaskId);
  const next = patchDocument(scope.runtime, documentRequestId, {
    ...(scheduledTaskId ? { scheduledTaskId } : {}),
  });
  if (!next) return notFound(documentRequestId, subaction);

  logger.info(
    `[OWNER_DOCUMENTS] track_deadline id=${next.id} deadline=${deadline} task=${scheduledTaskId ?? "(none)"}`,
  );

  return {
    success: true,
    text: `Tracking ${next.title} deadline ${deadline}.`,
    data: {
      subaction,
      documentRequest: next,
      documentRequestId: next.id,
      status: next.status,
      scheduledTaskId: next.scheduledTaskId ?? null,
    },
  };
}

async function handleUploadAsset(
  scope: RunnerScope,
  params: DocActionParameters,
): Promise<ActionResult> {
  const subaction: Subaction = "upload_asset";
  const portalUrl = params.portalUrl?.trim();
  if (!portalUrl) return missing("portalUrl", subaction);
  const assetPath = params.assetPath?.trim();
  if (!assetPath) return missing("assetPath", subaction);
  const assetKind = params.assetKind?.trim();
  if (!assetKind) return missing("assetKind", subaction);

  const documentTitle =
    params.documentTitle?.trim() ?? `Upload ${assetKind} to ${portalUrl}`;
  const now = nowIso();
  const doc: DocumentRequest = {
    id: newDocumentRequestId(),
    kind: "upload",
    title: documentTitle,
    portalUrl,
    assetKind,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    createdBy: scope.agentId,
    ...(params.deadline ? { deadline: params.deadline.trim() } : {}),
    ...(params.requesteeEntityId
      ? { requesteeEntityId: params.requesteeEntityId.trim() }
      : {}),
    ...(params.note ? { note: params.note } : {}),
  };

  // Owner approval gate. Sensitive uploads (decks, IDs) must not dispatch
  // through the browser bridge without explicit consent — this matches the
  // PRD §Approval-Required Operations row "Upload sensitive document or ID".
  const queue = createApprovalQueue(scope.runtime, { agentId: scope.agentId });
  const approvalRequest = await queue.enqueue({
    requestedBy: ACTION_NAME,
    subjectUserId: scope.subjectUserId,
    action: "execute_workflow",
    payload: {
      action: "execute_workflow",
      workflowId: "doc.upload_asset",
      input: {
        documentId: doc.id,
        portalUrl,
        assetPath,
        assetKind,
      },
    },
    channel: "browser",
    reason: `Upload ${assetKind} to ${portalUrl}`,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  const scheduledTaskId = await scheduleDeadlineTask(scope, doc);
  const saved = saveDocument(scope.runtime, {
    ...doc,
    status: "pending",
    approvalRequestId: approvalRequest.id,
    ...(scheduledTaskId ? { scheduledTaskId } : {}),
  });

  // Execution is intentionally deferred to the approval/workflow bridge. This
  // action only creates the DocumentRequest and approval payload.
  logger.info(
    `[OWNER_DOCUMENTS] upload_asset id=${saved.id} portal=${portalUrl} asset=${assetKind} approval=${approvalRequest.id}`,
  );

  return {
    success: true,
    text: `Queued ${assetKind} upload to ${portalUrl} pending owner approval.`,
    data: {
      subaction,
      documentRequest: saved,
      documentRequestId: saved.id,
      status: saved.status,
      approvalRequestId: approvalRequest.id,
      scheduledTaskId: saved.scheduledTaskId ?? null,
    },
  };
}

async function handleCollectId(
  scope: RunnerScope,
  params: DocActionParameters,
): Promise<ActionResult> {
  const subaction: Subaction = "collect_id";
  const requesteeEntityId = params.requesteeEntityId?.trim();
  if (!requesteeEntityId) return missing("requesteeEntityId", subaction);
  const assetKind = params.assetKind?.trim();
  if (!assetKind) return missing("assetKind", subaction);

  const now = nowIso();
  const doc: DocumentRequest = {
    id: newDocumentRequestId(),
    kind: "collect_id",
    requesteeEntityId,
    title:
      params.documentTitle?.trim() ??
      `Collect ${assetKind} from ${requesteeEntityId}`,
    assetKind,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    createdBy: scope.agentId,
    ...(params.portalUrl ? { portalUrl: params.portalUrl.trim() } : {}),
    ...(params.deadline ? { deadline: params.deadline.trim() } : {}),
    ...(params.note ? { note: params.note } : {}),
  };

  const scheduledTaskId = await scheduleDeadlineTask(scope, doc);
  const saved = saveDocument(scope.runtime, {
    ...doc,
    ...(scheduledTaskId ? { scheduledTaskId } : {}),
  });

  logger.info(
    `[OWNER_DOCUMENTS] collect_id id=${saved.id} requestee=${requesteeEntityId} kind=${assetKind}`,
  );

  return {
    success: true,
    text: `Tracking ${assetKind} collection from ${requesteeEntityId}.`,
    data: {
      subaction,
      documentRequest: saved,
      documentRequestId: saved.id,
      status: saved.status,
      scheduledTaskId: saved.scheduledTaskId ?? null,
    },
  };
}

async function handleCloseRequest(
  scope: RunnerScope,
  params: DocActionParameters,
): Promise<ActionResult> {
  const subaction: Subaction = "close_request";
  const documentRequestId = params.documentRequestId?.trim();
  if (!documentRequestId) return missing("documentRequestId", subaction);

  const resolution: DocumentRequestStatus = params.resolution ?? "completed";
  if (
    resolution !== "completed" &&
    resolution !== "expired" &&
    resolution !== "cancelled"
  ) {
    return {
      success: false,
      text: `Invalid resolution "${resolution}". Use completed | expired | cancelled.`,
      data: { subaction, error: "INVALID_RESOLUTION" },
    };
  }

  const patched = patchDocument(scope.runtime, documentRequestId, {
    status: resolution,
  });
  if (!patched) return notFound(documentRequestId, subaction);

  // Cancel the linked deadline watcher so we don't fire on a closed request.
  if (patched.scheduledTaskId) {
    try {
      await scope.runner.apply(patched.scheduledTaskId, "dismiss", {
        reason: `document ${resolution}`,
      });
    } catch (error) {
      logger.warn(
        `[OWNER_DOCUMENTS] close_request failed to dismiss task ${patched.scheduledTaskId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  logger.info(
    `[OWNER_DOCUMENTS] close_request id=${patched.id} resolution=${resolution}`,
  );

  return {
    success: true,
    text: `Closed DocumentRequest ${patched.id} as ${resolution}.`,
    data: {
      subaction,
      documentRequest: patched,
      documentRequestId: patched.id,
      status: patched.status,
    },
  };
}

const examples: ActionExample[][] = [
  [
    {
      name: "{{name1}}",
      content: {
        text: "Get the NDA signed by Alice before Friday — she's at entity-alice-001.",
      },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Queued signature request for the NDA pending owner approval.",
        action: ACTION_NAME,
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: {
        text: "Upload the deck to the Solana Breakpoint speaker portal.",
      },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Queued deck upload to the speaker portal pending owner approval.",
        action: ACTION_NAME,
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: {
        text: "From now on, always track contract renewals and warn me 60 days before they lapse.",
      },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Standing guarantee installed: every new renewal obligation will be tracked automatically with a 60-day warning before its deadline.",
        action: ACTION_NAME,
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: { text: "Close out doc-abc123 — it's signed." },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Closed DocumentRequest doc-abc123 as completed.",
        action: ACTION_NAME,
      },
    },
  ],
];

export const ownerDocumentsAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: SIMILE_NAMES.slice(),
  tags: [
    "domain:docs",
    "capability:read",
    "capability:write",
    "capability:update",
    "capability:schedule",
    "surface:internal",
  ],
  description:
    "Owner documents: signature requests, approvals, deadlines, portal uploads, ID/form collection, close-out, standing obligation-class guarantees. Ops: request_signature|request_approval|track_deadline|upload_asset|collect_id|close_request|guarantee_class.",
  descriptionCompressed:
    "OWNER_DOCUMENTS signature|approval|deadline|upload_asset|collect_id|close_request|guarantee_class",
  routingHint:
    'owner document signature/approval/upload/portal/ID-form ("get signed", "send approval", "upload deck", "track NDA deadline", "close doc") -> OWNER_DOCUMENTS; approval queue resolution -> RESOLVE_REQUEST',
  contexts: ["documents", "tasks", "calendar", "contacts"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
  parameters: [
    {
      name: "action",
      description:
        "Document op: request_signature|request_approval|track_deadline|upload_asset|collect_id|close_request|guarantee_class.",
      schema: { type: "string" as const, enum: [...SUBACTIONS] },
    },
    {
      name: "documentRequestId",
      description:
        "Existing DocumentRequest id; required track_deadline/close_request.",
      schema: { type: "string" as const },
    },
    {
      name: "requesteeEntityId",
      description:
        "Requestee Entity id; required request_signature/collect_id.",
      schema: { type: "string" as const },
    },
    {
      name: "documentTitle",
      description: "Short doc label.",
      schema: { type: "string" as const },
    },
    {
      name: "deadline",
      description: "Deadline ISO-8601.",
      schema: { type: "string" as const },
    },
    {
      name: "portalUrl",
      description: "Portal URL; required upload_asset, optional collect_id.",
      schema: { type: "string" as const },
    },
    {
      name: "assetPath",
      description: "Asset path/URL; required upload_asset.",
      schema: { type: "string" as const },
    },
    {
      name: "assetKind",
      description:
        "Asset kind deck|headshot|id|form|etc.; required upload_asset/collect_id.",
      schema: { type: "string" as const },
    },
    {
      name: "signatureUrl",
      description: "Optional signing portal URL: DocuSign|HelloSign|etc.",
      schema: { type: "string" as const },
    },
    {
      name: "approvalReason",
      description: "request_approval reason label.",
      schema: { type: "string" as const },
    },
    {
      name: "note",
      description: "Free-form DocumentRequest note.",
      schema: { type: "string" as const },
    },
    {
      name: "resolution",
      description:
        "close_request only: completed|expired|cancelled; default completed.",
      schema: {
        type: "string" as const,
        enum: ["completed", "expired", "cancelled"],
      },
    },
    {
      name: "obligationClass",
      description:
        "guarantee_class only: obligation class to auto-track (renewal covers contracts).",
      schema: {
        type: "string" as const,
        enum: ["commitment", "renewal", "filing", "warranty"],
      },
    },
    {
      name: "warnDaysBefore",
      description:
        "guarantee_class only: warn lead time in days before each deadline; default 60.",
      schema: { type: "number" as const },
    },
  ],
  examples,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
    callback,
  ): Promise<ActionResult> => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      const text = "Document workflow control is restricted to the owner.";
      await callback?.({ text });
      return { text, success: false, data: { error: "PERMISSION_DENIED" } };
    }

    const params = getParams(options);
    const subaction = resolveSubaction(params);
    if (!subaction) {
      return {
        success: false,
        text: "Tell me which document operation: request_signature, request_approval, track_deadline, upload_asset, collect_id, close_request, or guarantee_class.",
        data: { error: "MISSING_SUBACTION" },
      };
    }

    const scope = makeScope(runtime, message);
    let result: ActionResult;
    switch (subaction) {
      case "request_signature":
        result = await handleRequestSignature(scope, params);
        break;
      case "request_approval":
        result = await handleRequestApproval(scope, params);
        break;
      case "track_deadline":
        result = await handleTrackDeadline(scope, params);
        break;
      case "upload_asset":
        result = await handleUploadAsset(scope, params);
        break;
      case "collect_id":
        result = await handleCollectId(scope, params);
        break;
      case "close_request":
        result = await handleCloseRequest(scope, params);
        break;
      case "guarantee_class":
        result = await handleGuaranteeClass(scope, params);
        break;
    }

    if (result.text) {
      await callback?.({
        text: result.text,
        source: "action",
        action: ACTION_NAME,
      });
    }
    return result;
  },
};

// Test-only export: lets the unit test reset the in-memory store between cases.
export function __resetDocumentStoreForTests(): void {
  DOCUMENT_STORE.clear();
}

// Test-only export of the kind mapper for completeness.
export function __kindForSubactionForTests(s: Subaction): DocumentRequestKind {
  return kindForSubaction(s);
}
