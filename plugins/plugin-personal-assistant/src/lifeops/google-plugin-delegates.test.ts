/** Verifies the Google connector delegate resolution against a stubbed runtime. Deterministic vitest, no live Google API. */
import { getConnectorAccountManager, type IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { LifeOpsService } from "./service.js";

const TestGoogleService = LifeOpsService;

function runtime(): IAgentRuntime {
  return {
    agentId: "11111111-1111-4111-8111-111111111111",
    character: { name: "Test Agent" },
    getService: vi.fn(() => null),
    getSetting: vi.fn((key: string) =>
      key === "GOOGLE_REDIRECT_URI"
        ? "http://127.0.0.1:31437/api/connectors/google/oauth/callback"
        : undefined,
    ),
    setSetting: vi.fn(),
  } as IAgentRuntime;
}

describe("LifeOps Google plugin delegation", () => {
  it("keeps sending available without claiming separately ungranted Gmail reading", async () => {
    const testRuntime = runtime();
    const manager = getConnectorAccountManager(testRuntime);
    manager.registerProvider({ provider: "google", label: "Google" });
    await manager.upsertAccount("google", {
      id: "acct_send_only",
      role: "OWNER",
      purpose: ["messaging"],
      accessGate: "owner_binding",
      status: "connected",
      externalId: "send-only-sub",
      displayHandle: "self@example.com",
      metadata: {
        grantedCapabilities: ["gmail.send"],
        grantedScopes: ["https://www.googleapis.com/auth/gmail.send"],
      },
    });
    const service = new TestGoogleService(testRuntime);
    const url = new URL("http://127.0.0.1/api/connectors/google/accounts");
    const accountId = "connector-account:acct_send_only";
    const status = await service.getGoogleConnectorStatus(
      url,
      "local",
      "owner",
      accountId,
    );
    expect(status.grantedCapabilities).not.toContain("google.gmail.triage");
    await expect(
      service.requireGoogleGmailGrant(url, "local", "owner", accountId),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.requireGoogleGmailSendGrant(url, "local", "owner", accountId),
    ).resolves.toMatchObject({ connectorAccountId: "acct_send_only" });
  });

  it("reports plugin-managed connector accounts as LifeOps Google status", async () => {
    const testRuntime = runtime();
    const manager = getConnectorAccountManager(testRuntime);
    manager.registerProvider({ provider: "google", label: "Google" });
    await manager.upsertAccount("google", {
      id: "acct_google_owner",
      role: "OWNER",
      purpose: ["messaging", "calendar"],
      accessGate: "owner_binding",
      status: "connected",
      externalId: "google-sub-1",
      displayHandle: "owner@example.com",
      metadata: {
        isDefault: true,
        grantedCapabilities: [
          "google.basic_identity",
          "google.gmail.triage",
          "google.calendar.read",
        ],
        grantedScopes: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/calendar.readonly",
        ],
      },
    });

    const service = new TestGoogleService(testRuntime);
    const status = await service.getGoogleConnectorStatus(
      new URL("http://127.0.0.1/api/connectors/google/accounts"),
      "local",
      "owner",
    );

    expect(status.connected).toBe(true);
    expect(status.sourceOfTruth).toBe("connector_account");
    expect(status.grant?.tokenRef).toBeNull();
    expect(status.grant?.connectorAccountId).toBe("acct_google_owner");
    expect(status.grantedCapabilities).toEqual(
      expect.arrayContaining([
        "google.basic_identity",
        "google.gmail.triage",
        "google.calendar.read",
      ]),
    );
  });

  it("rejects legacy cloud-managed mode instead of falling back", async () => {
    const service = new TestGoogleService(runtime());

    await expect(
      service.getGoogleConnectorStatus(
        new URL("http://127.0.0.1/api/connectors/google/accounts"),
        "cloud_managed",
        "owner",
      ),
    ).rejects.toMatchObject({
      status: 410,
      message: expect.stringContaining("no longer manages cloud or legacy"),
    });
  });
});
