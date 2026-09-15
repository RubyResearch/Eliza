/**
 * Freezes reviewed destinations to exact verified identities in the canonical
 * entity graph. Revalidation reads the same entities, never a new global handle
 * match. These checks prove identity binding, not provider reachability or delivery.
 */
import { resolveKnowledgeGraphService } from "@elizaos/agent";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { normalizeEntityConnectorAccountId } from "@elizaos/shared";
import { z } from "zod";
import {
  type AccountHandoffRecord,
  AccountHandoffStore,
  handoffRecipientBindingsSchema,
} from "./account-handoff-store.js";

type Destination =
  AccountHandoffRecord["review"]["messageDestinations"][number];
const platforms: Record<Destination["channel"], readonly string[]> = {
  email: ["email", "gmail"],
  imessage: ["imessage", "blooio", "sms", "phone"],
  telegram: ["telegram"],
  discord: ["discord"],
};

export class AccountHandoffRecipients {
  private readonly store: AccountHandoffStore;
  constructor(
    private readonly runtime: IAgentRuntime,
    ownerEntityId: string,
  ) {
    this.store = new AccountHandoffStore(runtime, ownerEntityId);
  }

  async capture(
    operationId: string,
    expectedRevision: number,
    recipientEntityIds: string[],
  ): Promise<AccountHandoffRecord> {
    const record = await this.requireRecord(operationId, expectedRevision);
    if (record.phase !== "reviewed") throw this.changed();
    const ids = z
      .array(
        z
          .string()
          .min(1)
          .refine((value) => value === value.trim() && !value.includes("\0")),
      )
      .safeParse(recipientEntityIds);
    if (
      !ids.success ||
      ids.data.length !== record.review.messageDestinations.length
    )
      throw this.changed();
    if (record.receipt.recipientReview) {
      const saved = handoffRecipientBindingsSchema.safeParse(
        record.receipt.recipientReview,
      );
      if (
        !saved.success ||
        saved.data.length !== ids.data.length ||
        saved.data.some(
          (binding, index) => binding.recipientEntityId !== ids.data[index],
        )
      )
        throw this.changed();
      await this.verify(operationId, expectedRevision);
      return record;
    }
    const bindings = await this.resolve(
      record.review.messageDestinations,
      ids.data,
    );
    return this.store.checkpointRecipientReview({
      operationId,
      expectedRevision,
      bindings,
    });
  }

  async resolve(
    destinations: Destination[],
    recipientEntityIds: string[],
  ): Promise<z.infer<typeof handoffRecipientBindingsSchema>> {
    if (destinations.length !== recipientEntityIds.length) throw this.changed();
    const graph = this.graph();
    const bindings: z.infer<typeof handoffRecipientBindingsSchema> = [];
    for (const [index, destination] of destinations.entries()) {
      const entityId = recipientEntityIds[index];
      if (!entityId) throw this.changed();
      const entity = await graph.get(entityId);
      if (!entity) throw this.changed();
      const identities = entity.identities.filter(
        (identity) =>
          identity.verified &&
          platforms[destination.channel].includes(
            identity.platform.toLowerCase(),
          ) &&
          this.sameHandle(
            destination.channel,
            identity.handle,
            destination.recipientId,
          ) &&
          (destination.channel === "email" ||
            normalizeEntityConnectorAccountId(identity.connectorAccountId) ===
              destination.connectorAccountId),
      );
      if (identities.length !== 1) throw this.changed();
      const identity = identities[0];
      if (!identity) throw this.changed();
      bindings.push({
        ...destination,
        recipientEntityId: entity.entityId,
        identityPlatform: identity.platform,
        identityHandle: identity.handle,
        identityConnectorAccountId: normalizeEntityConnectorAccountId(
          identity.connectorAccountId,
        ),
      });
    }
    return bindings;
  }

  async verify(operationId: string, expectedRevision: number): Promise<void> {
    const record = await this.requireRecord(operationId, expectedRevision);
    const parsed = handoffRecipientBindingsSchema.safeParse(
      record.receipt.recipientReview,
    );
    if (
      !parsed.success ||
      parsed.data.length !== record.review.messageDestinations.length
    )
      throw this.changed();
    const graph = this.graph();
    for (const [index, binding] of parsed.data.entries()) {
      const destination = record.review.messageDestinations[index];
      if (
        !destination ||
        binding.channel !== destination.channel ||
        binding.connectorAccountId !== destination.connectorAccountId ||
        binding.recipientId !== destination.recipientId
      )
        throw this.changed();
      const entity = await graph.get(binding.recipientEntityId);
      if (!entity) throw this.changed();
      if (
        !entity.identities.some(
          (identity) =>
            identity.verified &&
            identity.platform === binding.identityPlatform &&
            identity.handle === binding.identityHandle &&
            normalizeEntityConnectorAccountId(identity.connectorAccountId) ===
              binding.identityConnectorAccountId &&
            platforms[destination.channel].includes(
              identity.platform.toLowerCase(),
            ) &&
            this.sameHandle(
              destination.channel,
              identity.handle,
              destination.recipientId,
            ) &&
            (destination.channel === "email" ||
              binding.identityConnectorAccountId ===
                destination.connectorAccountId),
        )
      )
        throw this.changed();
    }
  }

  private graph() {
    const graph = resolveKnowledgeGraphService(this.runtime);
    if (!graph)
      throw new ElizaError(
        "Verified contacts are unavailable. Retry recipient review when the identity service is ready.",
        { code: "ACCOUNT_HANDOFF_RECIPIENT_GRAPH_UNAVAILABLE" },
      );
    return graph.getEntityStore(this.runtime.agentId);
  }

  private async requireRecord(operationId: string, expectedRevision: number) {
    const record = await this.store.read(operationId);
    if (!record) throw this.changed();
    if (record.revision !== expectedRevision) throw this.changed();
    return record;
  }

  private sameHandle(
    channel: Destination["channel"],
    left: string,
    right: string,
  ): boolean {
    return channel === "email"
      ? left.toLowerCase() === right.toLowerCase()
      : left === right;
  }

  private changed(): ElizaError {
    return new ElizaError(
      "A reviewed recipient identity changed or is not verified for the selected channel and account. Refresh the saved handoff review.",
      { code: "ACCOUNT_HANDOFF_RECIPIENT_CHANGED" },
    );
  }
}
