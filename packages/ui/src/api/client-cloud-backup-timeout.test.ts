/** Exercises backup receipt delivery and failure through the real HTTP client with a local server. */
// @vitest-environment jsdom
import { createServer, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ElizaClient } from "./client-base";
import "./client-cloud";

let server: Server;
let baseUrl: string;
let requests = 0;
let fail = false;
let restoreRequests = 0;
let failRestore = false;

beforeAll(async () => {
  server = createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/api/backups/restore") {
      restoreRequests += 1;
      if (failRestore) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({ error: "Archive integrity check failed" }),
        );
        return;
      }
      await delay(11_000);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ restored: true, requiresRestart: true }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/backups") {
      response.writeHead(404).end();
      return;
    }
    requests += 1;
    if (fail) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Snapshot encryption failed" }));
      return;
    }
    await delay(11_000);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({ backup: { fileName: "completed.agent-backup.json" } }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Backup HTTP server did not bind");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

it("returns a completed backup after the generic deadline without creating it twice", async () => {
  requests = 0;
  const backup = await new ElizaClient(baseUrl).createLocalAgentBackup();
  expect(backup.fileName).toBe("completed.agent-backup.json");
  expect(requests).toBe(1);
}, 25_000);

it("surfaces a creation failure without retrying an uncertain operation", async () => {
  fail = true;
  requests = 0;
  await expect(
    new ElizaClient(baseUrl).createLocalAgentBackup(),
  ).rejects.toThrow("Snapshot encryption failed");
  expect(requests).toBe(1);
});

it("returns the restart receipt after the generic deadline without restoring twice", async () => {
  restoreRequests = 0;
  const receipt = await new ElizaClient(baseUrl).restoreLocalAgentBackup(
    "existing.agent-backup.json",
  );
  expect(receipt).toEqual({ restored: true, requiresRestart: true });
  expect(restoreRequests).toBe(1);
}, 25_000);

it("surfaces a restore failure without repeating an uncertain operation", async () => {
  failRestore = true;
  restoreRequests = 0;
  await expect(
    new ElizaClient(baseUrl).restoreLocalAgentBackup(
      "existing.agent-backup.json",
    ),
  ).rejects.toThrow("Archive integrity check failed");
  expect(restoreRequests).toBe(1);
});
