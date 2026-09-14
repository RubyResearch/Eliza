/**
 * Serializes X OAuth credential vending for one organization and connection
 * role. The Durable Object is the production cross-isolate authority; Worker
 * KV is eventually consistent and cannot safely lease a single-use token.
 */

import { runWithCloudBindingsAsync } from "@/lib/runtime/cloud-bindings";
import type { TwitterBrokerCredentials } from "@/lib/services/twitter-automation";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

interface CredentialRequest {
  organizationId: string;
  userId: string;
  connectionRole: "agent" | "owner";
}

interface TwitterCredentialBroker {
  getBrokerCredentials(
    organizationId: string,
    userId: string,
    connectionRole: "agent" | "owner",
  ): Promise<TwitterBrokerCredentials>;
}

function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 180;
}

function isCredentialRequest(value: unknown): value is CredentialRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    boundedId(candidate.organizationId) &&
    boundedId(candidate.userId) &&
    (candidate.connectionRole === "agent" ||
      candidate.connectionRole === "owner")
  );
}

function publicCredentialResponse(
  credentials: TwitterBrokerCredentials,
  connectionRole: "agent" | "owner",
): Response {
  if (!credentials) {
    return Response.json(
      {
        error: "no_x_connection",
        message:
          "No X (Twitter) connection found for this organization. Connect via the connectors page.",
        connectionRole,
      },
      { status: 404 },
    );
  }
  if (credentials.authMode === "oauth1a") {
    const values = credentials.credentials;
    return Response.json({
      auth_mode: "oauth1" as const,
      consumer_key: values.TWITTER_API_KEY,
      consumer_secret: values.TWITTER_API_SECRET_KEY,
      access_token: values.TWITTER_ACCESS_TOKEN,
      access_token_secret: values.TWITTER_ACCESS_TOKEN_SECRET,
      ...(values.TWITTER_USER_ID ? { user_id: values.TWITTER_USER_ID } : {}),
    });
  }
  return Response.json({
    auth_mode: "oauth2" as const,
    access_token: credentials.accessToken,
    ...(credentials.expiresAt !== null
      ? { expires_at: credentials.expiresAt }
      : {}),
    ...(credentials.scope ? { scopes: credentials.scope } : {}),
    ...(credentials.twitterUserId
      ? { user_id: credentials.twitterUserId }
      : {}),
  });
}

export class TwitterOAuthRefreshCoordinator {
  private readonly env: AppEnv["Bindings"];
  private readonly broker: TwitterCredentialBroker | undefined;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    _state: DurableObjectState,
    env: AppEnv["Bindings"],
    broker?: TwitterCredentialBroker,
  ) {
    this.env = env;
    this.broker = broker;
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release: () => void = () => undefined;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async fetch(request: Request): Promise<Response> {
    return this.serialize(async () => {
      try {
        if (
          request.method !== "POST" ||
          new URL(request.url).pathname !== "/credentials"
        ) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        const body: unknown = await request.json();
        if (!isCredentialRequest(body)) {
          return Response.json(
            { error: "Invalid credential request" },
            { status: 400 },
          );
        }
        const credentials = await runWithCloudBindingsAsync(
          this.env,
          async () => {
            // Credential vending must not load the automation/provider graph
            // when an unrelated Worker route or Durable Object starts.
            const broker =
              this.broker ??
              (await import("@/lib/services/twitter-automation"))
                .twitterAutomationService;
            return broker.getBrokerCredentials(
              body.organizationId,
              body.userId,
              body.connectionRole,
            );
          },
        );
        return publicCredentialResponse(credentials, body.connectionRole);
      } catch (error) {
        // error-policy:J1 the internal Durable Object transport boundary emits
        // an explicit failed response; it never vends a stale credential.
        logger.error(
          "[TwitterOAuthRefreshCoordinator] credential vend failed",
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return Response.json(
          {
            error: "x_credential_refresh_failed",
            message: "X credential refresh failed.",
          },
          { status: 502 },
        );
      }
    });
  }
}
