/** Exercises authenticated deletion HTTP requests and rejects malformed successful replies through the production client. */
import { client } from "@elizaos/ui/api";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultFamilyDeletionAdapter } from "./deletion-adapter.js";

vi.mock("@elizaos/ui/api", async () => {
  const { ElizaClient } = await import(
    "../../../../../packages/ui/src/api/client-base.ts"
  );
  return { client: new ElizaClient() };
});
beforeEach(() => {
  client.setBaseUrl("https://family-delete.example", { persist: false });
  client.setToken("synthetic-owner");
});
afterEach(() => {
  client.setToken(null);
  client.setBaseUrl(null, { persist: false });
  vi.unstubAllGlobals();
});
it("carries owner authority and the reviewed identity without replaying a rejected mutation", async () => {
  const calls: RequestInit[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe(
        "/api/lifeops/family-workflows/deletion",
      );
      expect(new Headers(init.headers).get("authorization")).toBe(
        "Bearer synthetic-owner",
      );
      calls.push(init);
      return Response.json(
        {
          error: "Workspace changed; review again",
          code: "FAMILY_DELETION_PREVIEW_STALE",
        },
        { status: 409 },
      );
    },
  );
  const confirmation = {
    expectedSha256: "a".repeat(64),
    backupRetention: "7-days" as const,
  };
  await expect(
    defaultFamilyDeletionAdapter.begin(confirmation),
  ).rejects.toThrow("Workspace changed; review again");
  expect(calls).toHaveLength(1);
  expect(calls[0].method).toBe("POST");
  expect(JSON.parse(String(calls[0].body))).toEqual(confirmation);
});
it("distinguishes no deletion from a malformed or fabricated completion response", async () => {
  let payload: object = { job: null };
  vi.stubGlobal("fetch", async () => Response.json(payload));
  expect(await defaultFamilyDeletionAdapter.status()).toBeNull();
  payload = {};
  await expect(defaultFamilyDeletionAdapter.status()).rejects.toThrow();
  payload = { job: { state: "complete" } };
  await expect(defaultFamilyDeletionAdapter.resume()).rejects.toThrow();
  payload = { agentId: "agent", sha256: "a".repeat(64), records: [] };
  await expect(defaultFamilyDeletionAdapter.preview()).rejects.toThrow();
});
