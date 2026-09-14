/**
 * POST /api/eliza-app/identity-link/start — mints a short-lived link code for
 * the authenticated session (#17344). The user then sends the code from the
 * messaging handle they want bound; the channel side confirms it through
 * /api/eliza-app/identity-link/confirm.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { elizaAppSessionService } from "@/lib/services/eliza-app";
import { startIdentityLink } from "@/lib/services/eliza-app/identity-link";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const startSchema = z.object({
  platform: z.enum(["telegram", "discord", "whatsapp", "phone"]),
});

const app = new Hono<AppEnv>();

// A request with no Authorization header is already a guaranteed 401, so
// answer it locally rather than spending a Redis round trip on the shared
// limiter first. The global per-IP backstop in bootstrap-app still bounds
// credential-less floods; this only removes the second, distributed hop.
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

app.post(
  "/",
  rejectMissingAuthHeader,
  rateLimit(RateLimitPresets.STRICT),
  async (c) => {
    try {
      const authHeader = c.req.header("Authorization");
      if (!authHeader) {
        return c.json(
          {
            success: false,
            error: "Authorization header required",
            code: "UNAUTHORIZED",
          },
          401,
        );
      }
      const session =
        await elizaAppSessionService.validateAuthHeader(authHeader);
      if (!session) {
        return c.json(
          {
            success: false,
            error: "Invalid or expired session",
            code: "INVALID_SESSION",
          },
          401,
        );
      }

      const parsed = startSchema.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!parsed.success) {
        return c.json(
          {
            success: false,
            error: "platform must be one of telegram, discord, whatsapp, phone",
            code: "VALIDATION_ERROR",
          },
          400,
        );
      }

      const result = await startIdentityLink({
        userId: session.userId,
        organizationId: session.organizationId,
        platform: parsed.data.platform,
      });

      return c.json({
        success: true,
        data: {
          code: result.code,
          platform: result.platform,
          expires_at: result.expiresAt.toISOString(),
          instructions: `Send "${result.code}" as a message from the ${result.platform} account you want to link. The code expires in 10 minutes.`,
        },
      });
    } catch (error) {
      logger.error("[IdentityLink Start] Error", { error });
      return failureResponse(c, error);
    }
  },
);

export default app;
