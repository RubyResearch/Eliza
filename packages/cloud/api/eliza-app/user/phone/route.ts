/**
 * Eliza App - Link Phone Number Endpoint
 *
 * Allows an authenticated user to link a phone number to their account.
 * This enables cross-platform messaging with iMessage.
 *
 * Useful when a user signed up via Discord (where phone is optional)
 * and wants to add their phone number later.
 *
 * POST /api/eliza-app/user/phone
 */

import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  elizaAppSessionService,
  elizaAppUserService,
} from "@/lib/services/eliza-app";
import { logger } from "@/lib/utils/logger";
import {
  isValidE164,
  normalizePhoneNumber,
} from "@/lib/utils/phone-normalization";
import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * E.164 phone number validation (after normalization)
 */
const phoneNumberSchema = z
  .string()
  .min(1, "Phone number is required")
  .transform((val, ctx) => {
    const normalized = normalizePhoneNumber(val);
    if (!isValidE164(normalized)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Invalid phone number format. Please use international format (e.g., +1234567890)",
      });
      return z.NEVER;
    }
    return normalized;
  });

/**
 * Request body schema
 */
const linkPhoneSchema = z.object({
  phone_number: phoneNumberSchema,
});

async function handleLinkPhone(request: Request): Promise<Response> {
  // Extract Authorization header
  const authHeader = request.headers.get("Authorization");

  if (!authHeader) {
    return Response.json(
      {
        success: false,
        error: "Authorization header required",
        code: "UNAUTHORIZED",
      },
      { status: 401 },
    );
  }

  // Validate session
  const session = await elizaAppSessionService.validateAuthHeader(authHeader);

  if (!session) {
    return Response.json(
      {
        success: false,
        error: "Invalid or expired session",
        code: "INVALID_SESSION",
      },
      { status: 401 },
    );
  }

  // Parse and validate request body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body", code: "INVALID_JSON" },
      { status: 400 },
    );
  }

  const parseResult = linkPhoneSchema.safeParse(body);
  if (!parseResult.success) {
    const firstIssue = parseResult.error.issues[0];
    return Response.json(
      {
        success: false,
        error: firstIssue?.message || "Invalid request body",
        code: "INVALID_REQUEST",
      },
      { status: 400 },
    );
  }

  const { phone_number: phoneNumber } = parseResult.data;

  // Check if user already has a phone number
  const user = await elizaAppUserService.getById(session.userId);
  if (!user) {
    return Response.json(
      { success: false, error: "User not found", code: "USER_NOT_FOUND" },
      { status: 404 },
    );
  }

  if (user.phone_number) {
    return Response.json(
      {
        success: false,
        error: "A phone number is already linked to this account",
        code: "PHONE_ALREADY_SET",
      },
      { status: 409 },
    );
  }

  // Link the phone number
  const result = await elizaAppUserService.linkPhoneToUser(
    session.userId,
    phoneNumber,
  );

  if (!result.success) {
    logger.warn("[ElizaApp LinkPhone] Phone linking failed", {
      userId: session.userId,
      phone: `***${phoneNumber.slice(-4)}`,
      error: result.error,
    });
    return Response.json(
      {
        success: false,
        error: result.error || "Failed to link phone number",
        code: "PHONE_ALREADY_LINKED",
      },
      { status: 409 },
    );
  }

  logger.info("[ElizaApp LinkPhone] Phone number linked successfully", {
    userId: session.userId,
    phone: `***${phoneNumber.slice(-4)}`,
  });

  return Response.json({
    success: true,
    phone_number: phoneNumber,
  });
}

const honoRouter = new Hono<AppEnv>();

// `handleLinkPhone` already answers a missing Authorization header with this
// exact 401, so running the shared limiter first spends a Redis round trip on
// a request that can only fail. The global per-IP backstop in bootstrap-app
// still bounds credential-less floods; this only removes the distributed hop.
const rejectMissingAuthHeader: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.req.header("Authorization")) {
    return c.json(
      {
        success: false,
        error: "Authorization header required",
        code: "UNAUTHORIZED",
      },
      401,
    );
  }
  await next();
};

honoRouter.post(
  "/",
  rejectMissingAuthHeader,
  rateLimit(RateLimitPresets.STANDARD),
  async (c) => {
    try {
      return await handleLinkPhone(c.req.raw);
    } catch (error) {
      return failureResponse(c, error);
    }
  },
);
export default honoRouter;
