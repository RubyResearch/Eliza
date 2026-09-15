/**
 * Owner-authenticated correspondence intake operations under the existing family
 * route gate. Request JSON cannot select an actor or grant extraction authority.
 */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import { extractFamilyIntake } from "../lifeops/family-coordination/intake-extraction.js";
import {
  familyIntakeImportSchema,
  importFamilyCorrespondence,
} from "../lifeops/family-coordination/intake-import.js";
import {
  familyIntakeFactsSchema,
  familyIntakeIdSchema,
  familyRequestDecisionSchema,
} from "../lifeops/family-coordination/intake-review.js";
import { getFamilyIntakeService } from "../lifeops/family-coordination/intake-service.js";
import {
  familyInterviewAnswerSchema,
  recordFamilyInterviewAnswer,
} from "../lifeops/family-coordination/interview.js";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";

const root = "/api/lifeops/family-workflows/intake";
const revisionSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
});
const selectSchema = z.strictObject({
  id: familyIntakeIdSchema,
  periodKey: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u),
  documentId: familyIntakeIdSchema,
});
const reviewSchema = revisionSchema.extend({ facts: familyIntakeFactsSchema });

export async function handleFamilyIntakeRoutes(
  ctx: LifeOpsRouteContext,
): Promise<boolean> {
  if (ctx.pathname !== root && !ctx.pathname.startsWith(`${root}/`))
    return false;
  const runtime = ctx.state.runtime;
  if (!runtime)
    throw new ElizaError("Agent runtime is unavailable", {
      code: "FAMILY_INTAKE_SOURCE_UNAVAILABLE",
    });
  const intake = getFamilyIntakeService(runtime);
  if (ctx.method === "POST" && ctx.pathname === `${root}/interview`) {
    const body = await ctx.readJsonBody<Record<string, unknown>>(
      ctx.req,
      ctx.res,
    );
    if (body === null) return true;
    ctx.json(
      ctx.res,
      {
        review: await recordFamilyInterviewAnswer(
          runtime,
          familyInterviewAnswerSchema.parse(body),
        ),
      },
      201,
    );
    return true;
  }

  if (ctx.method === "POST" && ctx.pathname === `${root}/import`) {
    const body = await ctx.readJsonBody<Record<string, unknown>>(
      ctx.req,
      ctx.res,
    );
    if (body === null) return true;
    ctx.json(
      ctx.res,
      {
        review: await importFamilyCorrespondence(
          runtime,
          familyIntakeImportSchema.parse(body),
        ),
      },
      201,
    );
    return true;
  }
  if (ctx.method === "GET" && ctx.pathname === root) {
    const sources = await intake.describe(
      ctx.url.searchParams.get("period") ?? "",
    );
    ctx.json(ctx.res, {
      reviews: sources.map((source) => source.review),
      sources,
    });
    return true;
  }
  if (ctx.method === "POST" && ctx.pathname === root) {
    const body = await ctx.readJsonBody<Record<string, unknown>>(
      ctx.req,
      ctx.res,
    );
    if (body === null) return true;
    ctx.json(
      ctx.res,
      { review: await intake.select(selectSchema.parse(body)) },
      201,
    );
    return true;
  }
  const match = ctx.pathname.match(
    /^\/api\/lifeops\/family-workflows\/intake\/([^/]+)\/(extract|review|withdraw|reselect|request-decision)$/u,
  );
  if (ctx.method !== "POST" || !match) return false;
  const id = familyIntakeIdSchema.parse(match[1]);
  const operation = match[2];
  const body = await ctx.readJsonBody<Record<string, unknown>>(
    ctx.req,
    ctx.res,
  );
  if (body === null) return true;
  if (operation === "request-decision") {
    const input = revisionSchema
      .extend({ decision: familyRequestDecisionSchema })
      .parse(body);
    ctx.json(ctx.res, { review: await intake.decideRequest({ id, ...input }) });
    return true;
  }
  if (operation === "review") {
    const input = reviewSchema.parse(body);
    ctx.json(ctx.res, { review: await intake.review({ id, ...input }) });
    return true;
  }
  const { expectedRevision } = revisionSchema.parse(body);
  const review =
    operation === "extract"
      ? await extractFamilyIntake(runtime, id, expectedRevision)
      : operation === "withdraw"
        ? await intake.withdraw(id, expectedRevision)
        : await intake.reselect(id, expectedRevision);
  ctx.json(ctx.res, { review });
  return true;
}
