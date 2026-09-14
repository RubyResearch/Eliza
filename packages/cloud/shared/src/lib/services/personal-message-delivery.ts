/**
 * Routes a normalized personal connector turn to the user's active Dedicated
 * runtime when present, otherwise to their rowless personal Shared runtime.
 */

import { ChannelType } from "@elizaos/core/edge";
import type { Organization } from "../../db/schemas/organizations";
import type { User } from "../../db/schemas/users";
import type { AppEnv, RuntimeDurableObjectNamespace } from "../../types/cloud-worker-env";
import { findActivePersonalDedicatedTarget } from "./agent-tier-upgrade-target";
import { elizaSandboxService } from "./eliza-sandbox";
import { preparePersonalDedicatedDelivery } from "./personal-dedicated-delivery";
import { coordinateSharedHistory } from "./shared-runtime/conversation-coordinator";
import { personalSharedAgent } from "./shared-runtime/personal-shared-agent";
import { sharedRestMessageSend } from "./shared-runtime/shared-rest-adapter";

export interface PersonalMessageAccount {
  user: User;
  organization: Organization;
}

export type PersonalMessageDeliveryResult =
  | {
      success: true;
      identity: { id: string; runtime: "shared" | "dedicated"; activeAgentId?: string };
      account: { userId: string; organizationId: string };
      reply: string;
    }
  | {
      success: false;
      status: 402 | 428 | 502 | 503;
      code: string;
      error: string;
      retryable: boolean;
      retryAfterSeconds?: number;
      currentBalance?: number;
      data?: Record<string, unknown>;
    };

export async function deliverPersonalTextMessage(params: {
  account: PersonalMessageAccount;
  message: string;
  messageId: string;
  platform: string;
  senderName?: string;
  env: AppEnv["Bindings"];
  executionCtx: { waitUntil(promise: Promise<unknown>): void };
  namespace: RuntimeDurableObjectNamespace;
}): Promise<PersonalMessageDeliveryResult> {
  const { account } = params;
  const agent = personalSharedAgent({
    userId: account.user.id,
    organizationId: account.organization.id,
  });
  const dedicated = await findActivePersonalDedicatedTarget(
    account.organization.id,
    account.user.id,
    agent.id,
  );
  if (dedicated) {
    const preparation = await preparePersonalDedicatedDelivery(dedicated);
    if (preparation.state === "unavailable") {
      return {
        success: false,
        status: preparation.status,
        code: preparation.code,
        error: preparation.error,
        retryable: preparation.retryable,
        retryAfterSeconds: preparation.retryAfterSeconds,
      };
    }
    const bridgeRequest = {
      jsonrpc: "2.0" as const,
      id: params.messageId,
      method: "message.send",
      params: {
        text: params.message,
        roomId: agent.id,
        conversationId: agent.id,
        canonicalBridgeBase: dedicated.bridge_url,
        userId: account.user.id,
        clientMessageId: params.messageId,
        platformName: params.platform,
        source: params.platform,
        ...(params.senderName ? { senderName: params.senderName } : {}),
      },
    };
    let response = await elizaSandboxService.bridge(
      dedicated.id,
      account.organization.id,
      bridgeRequest,
    );
    if (response.error?.message === "Bridge returned HTTP 404") {
      const history = await coordinateSharedHistory(agent.id, agent.id, {
        namespace: params.namespace,
      });
      const importableHistory = history.filter(
        (message): message is typeof message & { role: "user" | "assistant" } =>
          message.role === "user" || message.role === "assistant",
      );
      const importMessages = importableHistory.flatMap((message) =>
        message.id
          ? [
              {
                sourceId: message.id,
                role: message.role,
                text: message.content,
                ...(typeof message.createdAt === "number" ? { timestamp: message.createdAt } : {}),
              },
            ]
          : [],
      );
      let receipt =
        importMessages.length === importableHistory.length
          ? await elizaSandboxService.importCanonicalConversation(
              dedicated.id,
              account.organization.id,
              agent.id,
              importMessages,
            )
          : null;
      if (!receipt && importMessages.length > 0) {
        receipt = await elizaSandboxService.importCanonicalConversation(
          dedicated.id,
          account.organization.id,
          agent.id,
          [],
        );
      }
      if (receipt) {
        response = await elizaSandboxService.bridge(
          dedicated.id,
          account.organization.id,
          bridgeRequest,
        );
      }
    }
    const result = response.result as { text?: unknown } | undefined;
    if (response.error || typeof result?.text !== "string") {
      return {
        success: false,
        status: 503,
        code: "service_unavailable",
        error: "Dedicated Eliza is temporarily unavailable.",
        retryable: true,
      };
    }
    return {
      success: true,
      identity: { id: agent.id, runtime: "dedicated", activeAgentId: dedicated.id },
      account: { userId: account.user.id, organizationId: account.organization.id },
      reply: result.text,
    };
  }

  const result = await sharedRestMessageSend(
    agent,
    agent.id,
    params.message,
    agent.agent_name ?? "Eliza",
    params.executionCtx,
    params.namespace,
    params.messageId,
    "platform",
    undefined,
    params.message,
    { type: ChannelType.DM, source: params.platform },
  );
  return {
    success: true,
    identity: { id: agent.id, runtime: "shared" },
    account: { userId: account.user.id, organizationId: account.organization.id },
    reply: result.text,
  };
}
