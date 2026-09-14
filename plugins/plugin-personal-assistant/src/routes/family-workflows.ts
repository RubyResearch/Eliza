/**
 * Owner-only HTTP contracts for school-calendar workflow control and monthly
 * family packet generation, review, drafting, and canonical approval enqueue.
 */

import { ElizaError } from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { ZodError } from "zod";
import type {
  FamilyPacketEmailDelivery,
  FamilyPacketPeriod,
} from "../lifeops/family-coordination/index.js";
import { getFamilyWorkflowRuntimeService } from "../lifeops/family-workflows/index.js";
import { selectedFamilyPacketPeriod } from "../lifeops/family-workflows/period.js";

import { exportFamilyWorkspace } from "../lifeops/family-workflows/workspace-export.js";
import { CONCORD_SCHOOL_CALENDAR_SOURCE } from "../lifeops/school/calendar-workflow.js";
import { handleFamilyDeletionRoutes } from "./family-deletion.js";
import { handleFamilyIntakeRoutes } from "./family-intake.js";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";

function service(ctx: LifeOpsRouteContext) {
  const runtime = ctx.state.runtime;
  if (!runtime) {
    ctx.error(ctx.res, "Agent runtime is not available", 503);
    return null;
  }
  const value = getFamilyWorkflowRuntimeService(runtime);
  if (!value) {
    ctx.error(ctx.res, "Family workflow runtime is not available", 503);
    return null;
  }
  return value;
}

export async function handleFamilyWorkflowRoutes(
  ctx: LifeOpsRouteContext,
): Promise<boolean> {
  const { method, pathname, req, res, json, readJsonBody, url } = ctx;
  if (!pathname.startsWith("/api/lifeops/family-workflows")) return false;
  if (await handleFamilyDeletionRoutes(ctx)) return true;
  const runtimeService = service(ctx);
  if (!runtimeService) return true;
  try {
    if (await handleFamilyIntakeRoutes(ctx)) return true;
    if (
      method === "POST" &&
      pathname === "/api/lifeops/family-workflows/export"
    ) {
      const runtime = ctx.state.runtime;
      if (!runtime) throw new Error("Agent runtime is unavailable");
      const file = await exportFamilyWorkspace(runtime, SELF_ENTITY_ID);
      res.statusCode = 200;
      res.setHeader("Content-Type", file.mimeType);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      );
      res.setHeader("Content-Length", String(file.bytes.length));
      res.end(file.bytes);
      return true;
    }
    if (
      method === "GET" &&
      pathname === "/api/lifeops/family-workflows/email-options"
    ) {
      json(res, { options: await runtimeService.emailOptions() });
      return true;
    }
    if (
      method === "POST" &&
      pathname === "/api/lifeops/family-workflows/email-recipients/confirm"
    ) {
      const body = await readJsonBody<{
        entityId?: unknown;
        name?: unknown;
        address?: unknown;
        confirmed?: unknown;
      }>(req, res);
      if (!body) return true;
      if (
        body.confirmed !== true ||
        typeof body.name !== "string" ||
        typeof body.address !== "string" ||
        (body.entityId !== null && typeof body.entityId !== "string")
      ) {
        ctx.error(
          res,
          "Review and confirm the exact contact name and email address.",
          400,
        );
        return true;
      }
      json(res, {
        recipient: await runtimeService.confirmEmailRecipient({
          entityId: body.entityId,
          name: body.name,
          address: body.address,
          confirmedBy: String(ctx.state.adminEntityId ?? "self"),
        }),
      });
      return true;
    }
    if (
      method === "PUT" &&
      pathname === "/api/lifeops/family-workflows/school/source"
    ) {
      const body = await readJsonBody<{
        schoolLevel?: unknown;
        updateMode?: unknown;
      }>(req, res);
      if (!body) return true;
      if (
        (body.schoolLevel !== undefined &&
          body.schoolLevel !== "all" &&
          body.schoolLevel !== "elementary") ||
        (body.updateMode !== undefined &&
          body.updateMode !== "review" &&
          body.updateMode !== "automatic")
      ) {
        ctx.error(res, "Choose a valid school level and update mode", 400);
        return true;
      }
      const status = await runtimeService.configureSchool({
        ...CONCORD_SCHOOL_CALENDAR_SOURCE,
        schoolLevel: body.schoolLevel ?? "elementary",
        updateMode: body.updateMode ?? "review",
      });
      await runtimeService.ensureMonthlySchedule();
      json(res, status);
      return true;
    }
    if (
      method === "GET" &&
      pathname === "/api/lifeops/family-workflows/school/status"
    ) {
      json(res, await runtimeService.schoolStatus());
      return true;
    }
    if (
      method === "POST" &&
      pathname === "/api/lifeops/family-workflows/school/run"
    ) {
      json(res, await runtimeService.runSchool("manual"));
      return true;
    }
    const schoolReviewMatch = pathname.match(
      /^\/api\/lifeops\/family-workflows\/school\/runs\/([^/]+)$/u,
    );
    if (method === "GET" && schoolReviewMatch) {
      const review = await runtimeService.reviewSchool(
        decodeURIComponent(schoolReviewMatch[1] ?? ""),
      );
      if (!review) ctx.error(res, "School calendar run not found", 404);
      else json(res, review);
      return true;
    }
    if (
      method === "POST" &&
      pathname === "/api/lifeops/family-workflows/school/apply"
    ) {
      const body = await readJsonBody<{ runId?: unknown }>(req, res);
      if (!body) return true;
      if (typeof body.runId !== "string" || !body.runId.trim()) {
        ctx.error(res, "runId is required", 400);
        return true;
      }
      await runtimeService.applySchool(body.runId.trim(), url);
      json(res, { applied: true, runId: body.runId.trim() });
      return true;
    }
    if (
      method === "POST" &&
      pathname === "/api/lifeops/family-workflows/run-now"
    ) {
      json(res, await runtimeService.runMonthly("manual"));
      return true;
    }
    if (
      method === "GET" &&
      pathname === "/api/lifeops/family-workflows/packets"
    ) {
      const packets = await runtimeService.packets.list(
        url.searchParams.get("period") ?? undefined,
      );
      json(res, {
        packets,
        packetStates: await Promise.all(
          packets.map(async (packet) => {
            const draft = await runtimeService.packets.readLatestDraft(
              packet.packetId,
              packet.version,
            );
            return {
              packetId: packet.packetId,
              internalVersion: packet.version,
              draft,
              approval: draft
                ? await runtimeService.readDraftApprovalStatus(
                    packet.packetId,
                    draft.draftVersion,
                    String(ctx.state.adminEntityId ?? "self"),
                  )
                : null,
              approvalId: draft
                ? await runtimeService.packets.readDraftApprovalId(
                    packet.packetId,
                    draft.draftVersion,
                  )
                : null,
            };
          }),
        ),
      });
      return true;
    }
    if (
      method === "POST" &&
      pathname === "/api/lifeops/family-workflows/packets"
    ) {
      const body = await readJsonBody<{
        period?: FamilyPacketPeriod;
        periodKey?: string;
      }>(req, res);
      if (body === null) return true;
      if (
        body.periodKey !== undefined &&
        (typeof body.periodKey !== "string" || body.period !== undefined)
      ) {
        ctx.error(res, "Select one packet month", 400);
        return true;
      }
      json(
        res,
        await runtimeService.generatePacket(
          body.periodKey === undefined
            ? body.period
            : selectedFamilyPacketPeriod(body.periodKey),
        ),
      );
      return true;
    }
    const packetMatch = pathname.match(
      /^\/api\/lifeops\/family-workflows\/packets\/([^/]+)$/u,
    );
    if (method === "GET" && packetMatch) {
      const packet = await runtimeService.packets.read(
        decodeURIComponent(packetMatch[1] ?? ""),
      );
      if (!packet) ctx.error(res, "Packet not found", 404);
      else json(res, packet);
      return true;
    }
    const draftMatch = pathname.match(
      /^\/api\/lifeops\/family-workflows\/packets\/([^/]+)\/drafts$/u,
    );
    if (method === "POST" && draftMatch) {
      const body = await readJsonBody<{
        expectedPacketVersion?: unknown;
        recipient?: unknown;
        recipientEntityId?: unknown;
        calendarPrivacyMode?: unknown;
        email?: unknown;
      }>(req, res);
      if (!body) return true;
      if (
        typeof body.expectedPacketVersion !== "number" ||
        !Number.isSafeInteger(body.expectedPacketVersion) ||
        body.expectedPacketVersion < 1
      ) {
        ctx.error(res, "expectedPacketVersion must be a positive integer", 400);
        return true;
      }
      let email: FamilyPacketEmailDelivery | undefined;
      if (body.email !== undefined) {
        if (
          !body.email ||
          typeof body.email !== "object" ||
          !("subject" in body.email) ||
          typeof body.email.subject !== "string" ||
          !("senderGrantId" in body.email) ||
          typeof body.email.senderGrantId !== "string"
        ) {
          ctx.error(res, "Email subject and sender account are required", 400);
          return true;
        }
        email = {
          subject: body.email.subject,
          senderGrantId: body.email.senderGrantId,
        };
      }
      if (typeof body.recipient !== "string" || !body.recipient.trim()) {
        ctx.error(res, "recipient is required", 400);
        return true;
      }
      if (
        typeof body.recipientEntityId !== "string" ||
        !body.recipientEntityId.trim() ||
        !["full", "times_only", "busy_only"].includes(
          String(body.calendarPrivacyMode),
        )
      ) {
        ctx.error(
          res,
          "recipientEntityId and calendarPrivacyMode are required",
          400,
        );
        return true;
      }
      json(
        res,
        await runtimeService.createDraft(
          decodeURIComponent(draftMatch[1] ?? ""),
          {
            expectedPacketVersion: body.expectedPacketVersion,
            recipient: body.recipient.trim(),
            recipientEntityId: body.recipientEntityId.trim(),
            ...(email ? { email } : {}),
            calendarPrivacyMode: body.calendarPrivacyMode as
              | "full"
              | "times_only"
              | "busy_only",
          },
        ),
        201,
      );
      return true;
    }
    const revisionMatch = pathname.match(
      /^\/api\/lifeops\/family-workflows\/packets\/([^/]+)\/drafts\/(\d+)\/revision$/u,
    );
    if (method === "POST" && revisionMatch) {
      const body = await readJsonBody<{ body?: unknown; subject?: unknown }>(
        req,
        res,
      );
      if (!body) return true;
      if (typeof body.body !== "string" || typeof body.subject !== "string") {
        ctx.error(res, "Email body and subject are required", 400);
        return true;
      }
      json(
        res,
        await runtimeService.reviseDraft({
          packetId: decodeURIComponent(revisionMatch[1] ?? ""),
          expectedDraftVersion: Number(revisionMatch[2]),
          body: body.body,
          subject: body.subject,
        }),
        201,
      );
      return true;
    }
    const decisionMatch = pathname.match(
      /^\/api\/lifeops\/family-workflows\/packets\/([^/]+)\/drafts\/(\d+)\/decision$/u,
    );
    if (method === "POST" && decisionMatch) {
      const body = await readJsonBody<{
        approvalId?: unknown;
        bodySha256?: unknown;
        decision?: unknown;
      }>(req, res);
      if (!body) return true;
      const draftVersion = Number(decisionMatch[2]);
      if (
        typeof body.approvalId !== "string" ||
        !body.approvalId.trim() ||
        typeof body.bodySha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(body.bodySha256) ||
        (body.decision !== "approve" && body.decision !== "reject") ||
        !Number.isSafeInteger(draftVersion) ||
        draftVersion < 1
      ) {
        ctx.error(
          res,
          "A reviewed draft, approval, and explicit decision are required",
          400,
        );
        return true;
      }
      json(
        res,
        await runtimeService.decideDraftApproval({
          packetId: decodeURIComponent(decisionMatch[1] ?? ""),
          draftVersion,
          approvalId: body.approvalId,
          bodySha256: body.bodySha256,
          decision: body.decision,
          ownerUserId: String(ctx.state.adminEntityId ?? "self"),
        }),
      );
      return true;
    }
    const approvalMatch = pathname.match(
      /^\/api\/lifeops\/family-workflows\/packets\/([^/]+)\/drafts\/(\d+)\/approval$/u,
    );
    if (method === "POST" && approvalMatch) {
      const body = await readJsonBody<{ expiresAt?: unknown }>(req, res);
      if (!body) return true;
      const expiresAt =
        typeof body.expiresAt === "string"
          ? new Date(body.expiresAt)
          : new Date(Date.now() + 7 * 24 * 60 * 60_000);
      if (!Number.isFinite(expiresAt.getTime())) {
        ctx.error(res, "expiresAt must be an ISO date", 400);
        return true;
      }
      const actor = String(ctx.state.adminEntityId ?? "self");
      json(
        res,
        await runtimeService.requestDraftApproval({
          packetId: decodeURIComponent(approvalMatch[1] ?? ""),
          draftVersion: Number(approvalMatch[2]),
          requestedBy: actor,
          subjectUserId: actor,
          expiresAt,
        }),
        201,
      );
      return true;
    }
    ctx.error(res, "Family workflow route not found", 404);
    return true;
  } catch (error) {
    // error-policy:J1 HTTP boundary returns a structured failure.
    if (error instanceof ZodError) {
      json(
        res,
        {
          error: {
            code: "FAMILY_INPUT_INVALID",
            message: "Review the input fields and try again",
          },
        },
        400,
      );
      return true;
    }
    if (
      error instanceof ElizaError &&
      error.code.startsWith("FAMILY_INTAKE_")
    ) {
      const status =
        error.code.endsWith("CONFLICT") ||
        error.code === "FAMILY_INTAKE_SOURCE_CHANGED"
          ? 409
          : error.code === "FAMILY_INTAKE_OWNER_REQUIRED"
            ? 403
            : error.code.endsWith("_UNAVAILABLE")
              ? 503
              : 400;
      json(
        res,
        { error: { code: error.code, message: error.message } },
        status,
      );
      return true;
    }

    if (
      error instanceof ElizaError &&
      [
        "FAMILY_PACKET_VERSION_STALE",
        "FAMILY_PACKET_INTERNAL_STALE",
        "FAMILY_PACKET_DRAFT_STALE",
      ].includes(error.code)
    ) {
      json(res, { error: { code: error.code, message: error.message } }, 409);
      return true;
    }
    ctx.error(res, error instanceof Error ? error.message : String(error), 400);
    return true;
  }
}
