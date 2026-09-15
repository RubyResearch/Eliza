/**
 * Google connector send translation preserves the owner-approved email
 * envelope and returns the provider receipt used by durable scheduling.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INTERNAL_URL } from "../access.js";
import { LifeOpsService } from "../service.js";
import { createGoogleConnectorContribution } from "./google.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Google connector scheduling envelope", () => {
  it("forwards to, cc, bcc, subject, and exact body before returning a receipt", async () => {
    const send = vi
      .spyOn(LifeOpsService.prototype, "sendGmailMessage")
      .mockResolvedValue({
        ok: true,
        messageId: "gmail-message-17",
        threadId: "gmail-thread-9",
      });
    const connector = createGoogleConnectorContribution({
      agentId: "agent-google-envelope",
    } as IAgentRuntime);

    const result = await connector.send?.({
      target: "parent@example.com,school@example.com",
      message: "The exact approved scheduling body.",
      idempotencyKey: "scheduling-message:v1:abc",
      metadata: {
        subject: "Scheduling: school conference",
        grantId: "reviewed-sender",
        cc: ["caregiver@example.com"],
        bcc: ["archive@example.com"],
      },
    });

    expect(send).toHaveBeenCalledWith(INTERNAL_URL, {
      mode: "local",
      grantId: "reviewed-sender",
      side: "owner",
      to: ["parent@example.com", "school@example.com"],
      cc: ["caregiver@example.com"],
      bcc: ["archive@example.com"],
      subject: "Scheduling: school conference",
      bodyText: "The exact approved scheduling body.",
      confirmSend: true,
    });
    expect(result).toMatchObject({
      ok: true,
      messageId: "gmail-message-17",
      receipt: {
        provider: "gmail",
        providerMessageId: "gmail-message-17",
        idempotencyKey: "scheduling-message:v1:abc",
        metadata: { threadId: "gmail-thread-9" },
      },
    });
  });
});

it.each(["", " ", " sender ", 42])(
  "rejects an invalid sender binding before provider dispatch: %s",
  async (grantId) => {
    const send = vi.spyOn(LifeOpsService.prototype, "sendGmailMessage");
    const connector = createGoogleConnectorContribution({
      agentId: "sender-validation",
    } as IAgentRuntime);
    const result = await connector.send?.({
      target: "synthetic@example.test",
      message: "Synthetic",
      metadata: { grantId },
    });
    expect(result).toMatchObject({ ok: false });
    expect(send).not.toHaveBeenCalled();
  },
);
