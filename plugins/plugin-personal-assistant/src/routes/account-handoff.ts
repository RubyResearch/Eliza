/**
 * Owner-gated review, readback and checkpoint execution for account handoff.
 * Saving choices derives an immutable review; advancing accepts its revision
 * only and delegates side effects to the durable execution coordinator.
 */
import { ElizaError } from "@elizaos/core";
import {
  CalendarService,
  CalendarServiceError,
} from "@elizaos/plugin-calendar";
import { ZodError, z } from "zod";
import { AccountHandoffExecution } from "../lifeops/account-handoff-execution.js";
import {
  AccountHandoffReviewService,
  accountHandoffChoicesSchema,
} from "../lifeops/account-handoff-review.js";
import { AccountHandoffStore } from "../lifeops/account-handoff-store.js";
import { requireGoogleWorkspaceService } from "../lifeops/google-plugin-delegates.js";
import { LifeOpsService, LifeOpsServiceError } from "../lifeops/service.js";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";

export async function handleAccountHandoffRoutes(
  ctx: LifeOpsRouteContext,
): Promise<boolean> {
  const base = "/api/lifeops/account-handoffs";
  if (ctx.pathname !== base && !ctx.pathname.startsWith(`${base}/`))
    return false;
  const runtime = ctx.state.runtime;
  const owner = ctx.state.adminEntityId;
  if (!runtime || !owner) {
    ctx.error(ctx.res, "The owner workspace is unavailable", 503);
    return true;
  }
  const store = new AccountHandoffStore(runtime, owner);
  try {
    if (ctx.method === "GET" && ctx.pathname === `${base}/active`) {
      ctx.json(ctx.res, { handoff: await store.active() });
      return true;
    }
    if (
      ctx.method === "GET" &&
      (ctx.pathname === `${base}/retirement-candidates` ||
        ctx.pathname === `${base}/calendar-entries`)
    ) {
      const grantId = z
        .string()
        .min(1)
        .parse(ctx.url.searchParams.get("previousGrantId"));
      const calendar = await runtime.getServiceLoadPromise(
        CalendarService.serviceType,
      );
      if (!(calendar instanceof CalendarService)) {
        ctx.error(ctx.res, "Calendar service is unavailable", 503);
        return true;
      }
      const service = new AccountHandoffReviewService(
        runtime,
        owner,
        new LifeOpsService(runtime, { ownerEntityId: owner }),
        calendar,
        ctx.url,
      );
      ctx.json(
        ctx.res,
        ctx.pathname === `${base}/calendar-entries`
          ? { entries: await service.calendarEntries(grantId) }
          : { candidates: await service.retirementCandidates(grantId) },
      );
      return true;
    }
    if (ctx.method === "POST" && ctx.pathname === base) {
      const body = await ctx.readJsonBody<Record<string, unknown>>(
        ctx.req,
        ctx.res,
      );
      if (!body) return true;
      const choices = accountHandoffChoicesSchema.parse(body);
      const calendar = await runtime.getServiceLoadPromise(
        CalendarService.serviceType,
      );
      if (!(calendar instanceof CalendarService)) {
        ctx.error(ctx.res, "Calendar service is unavailable", 503);
        return true;
      }
      const service = new AccountHandoffReviewService(
        runtime,
        owner,
        new LifeOpsService(runtime, { ownerEntityId: owner }),
        calendar,
        ctx.url,
      );
      ctx.json(ctx.res, { handoff: await service.create(choices) });
      return true;
    }
    if (ctx.method === "POST" && ctx.pathname.endsWith("/advance")) {
      const id = ctx.decodePathComponent(
        ctx.pathname.substring(
          base.length + 1,
          ctx.pathname.length - "/advance".length,
        ),
        ctx.res,
        "handoff ID",
      );
      if (id === null) return true;
      const body = await ctx.readJsonBody<Record<string, unknown>>(
        ctx.req,
        ctx.res,
      );
      if (!body) return true;
      const { expectedRevision } = z
        .object({ expectedRevision: z.number().int().nonnegative() })
        .strict()
        .parse(body);
      const calendar = await runtime.getServiceLoadPromise(
        CalendarService.serviceType,
      );
      if (!(calendar instanceof CalendarService)) {
        ctx.error(ctx.res, "Calendar service is unavailable", 503);
        return true;
      }
      const execution = new AccountHandoffExecution(
        runtime,
        owner,
        calendar,
        new LifeOpsService(runtime, { ownerEntityId: owner }),
        requireGoogleWorkspaceService(runtime),
        ctx.url,
      );
      ctx.json(ctx.res, {
        handoff: await execution.advance(id, expectedRevision),
      });
      return true;
    }
    if (ctx.method === "POST" && ctx.pathname.endsWith("/cancel")) {
      const id = ctx.decodePathComponent(
        ctx.pathname.substring(
          base.length + 1,
          ctx.pathname.length - "/cancel".length,
        ),
        ctx.res,
        "handoff ID",
      );
      if (id === null) return true;
      const body = await ctx.readJsonBody<Record<string, unknown>>(
        ctx.req,
        ctx.res,
      );
      if (!body) return true;
      const { expectedRevision } = z
        .object({ expectedRevision: z.number().int().nonnegative() })
        .strict()
        .parse(body);
      ctx.json(ctx.res, {
        handoff: await store.cancelReviewed(id, expectedRevision),
      });
      return true;
    }
    if (ctx.method === "GET" && ctx.pathname.startsWith(`${base}/`)) {
      const id = ctx.decodePathComponent(
        ctx.pathname.substring(base.length + 1),
        ctx.res,
        "handoff ID",
      );
      if (id === null) return true;
      const handoff = await store.read(id);
      if (!handoff) ctx.error(ctx.res, "Account handoff not found", 404);
      else ctx.json(ctx.res, { handoff });
      return true;
    }
    ctx.error(ctx.res, "Account handoff operation not found", 404);
    return true;
  } catch (error) {
    // error-policy:J1 Translate rejected owner requests at the HTTP boundary.
    if (error instanceof ZodError) {
      ctx.json(
        ctx.res,
        {
          error: "Review choices are invalid",
          code: "ACCOUNT_HANDOFF_INVALID_REVIEW",
        },
        400,
      );
      return true;
    }
    if (
      error instanceof CalendarServiceError ||
      error instanceof LifeOpsServiceError
    ) {
      ctx.error(ctx.res, error.message, error.status);
      return true;
    }
    if (error instanceof ElizaError) {
      ctx.json(ctx.res, { error: error.message, code: error.code }, 409);
      return true;
    }
    runtime.reportError("AccountHandoffRoutes", error, { method: ctx.method });
    ctx.error(
      ctx.res,
      "Account switch is unavailable. Retry when the workspace is ready.",
      500,
    );
    return true;
  }
}
