/** Child-process fixture for paid restore crash/recovery. Job ownership, funding, and SSH remain real; backup transport and runtime bootstrap are explicit fixtures. */
import { readFile } from "node:fs/promises";
import { z } from "zod";

const database = new URL(process.env.COMPUTE_FUNDING_POSTGRES_TEST_URL ?? "invalid:");
if (
  process.env.NODE_ENV !== "test" ||
  database.hostname !== "127.0.0.1" ||
  !/^\/dedicated_compute_test_[a-z0-9]+$/.test(database.pathname)
) {
  throw new Error("Paid worker fixture requires isolated loopback PostgreSQL");
}
process.env.DATABASE_URL = database.toString();
process.env.TEST_DATABASE_URL = database.toString();
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";
const input = z
  .object({
    agentId: z.uuid(),
    organizationId: z.uuid(),
    backupId: z.uuid(),
    token: z.string(),
    restoreUrl: z.url(),
    recover: z.boolean(),
    state: z.object({
      memories: z.array(z.never()),
      config: z.record(z.string(), z.string()),
      workspaceFiles: z.record(z.string(), z.string()),
    }),
  })
  .strict()
  .parse(JSON.parse(await readFile(process.env.COMPUTE_FUNDING_WORKER_FIXTURE!, "utf8")));
if (new URL(input.restoreUrl).hostname !== "127.0.0.1")
  throw new Error("Restore fixture must be loopback");
const { agentSandboxesRepository } = await import("../../../../db/repositories/agent-sandboxes");
const { elizaSandboxService } = await import("../../eliza-sandbox");
const { DockerSandboxProvider } = await import("../../docker-sandbox-provider");
const { SandboxTransport } = await import("../bridge/transport");
const { ProvisioningJobService } = await import("../../provisioning-jobs");
const { JOB_TYPES } = await import("../../provisioning-job-types");
const { closeDatabaseConnectionsForTests } = await import("../../../../db/client");
const { DockerSSHClient } = await import("../../docker-ssh");
const backup = {
  id: input.backupId,
  sandbox_record_id: input.agentId,
  snapshot_type: "pre-shutdown" as const,
  state_data: input.state,
  state_data_storage: "inline" as const,
  state_data_key: null,
  size_bytes: JSON.stringify(input.state).length,
  backup_kind: "full" as const,
  parent_backup_id: null,
  content_hash: null,
  created_at: new Date(),
};
const stored = {
  ...backup,
  state_data: null,
  verification_status: "verified" as const,
  verified_at: new Date(),
  verification_error: null,
};
// Fixed, freshly verified backup metadata matches the parent transport fixture.
// This does not replace the separate real crypto/integrity suite.
Object.assign(agentSandboxesRepository, {
  getBackupById: async () => backup,
  getLatestBackup: async () => backup,
  getStoredBackupById: async () => stored,
  getLatestStoredBackup: async () => stored,
  getReconstructedBackupState: async () => input.state,
});
Object.assign(SandboxTransport.prototype, {
  getSafeBridgeEndpoint: async (_target: string, path: string) => {
    if (path !== "/api/restore") throw new Error("Unexpected worker fixture transport");
    return new URL(path, input.restoreUrl).toString();
  },
});
const provider = new DockerSandboxProvider();
provider.create = async () => {
  throw new Error("Retained worker retry attempted a new container");
};
Object.assign(elizaSandboxService, {
  getProvider: async () => provider,
  ensureRuntimeAgentStarted: async () => null,
});
const service = new ProvisioningJobService({
  executionOwnerId: crypto.randomUUID(),
  executionTimeoutMs: () => 45_000,
  executionLeaseMs: 2_000,
  executionLeaseHeartbeatMs: 500,
  // No provider capacity is allocated in this retained-container test.
  // Organization admission, job lease and agent execution fences remain real.
  acquireProviderAdmission: async () => true,
  releaseProviderAdmission: async () => {},
});
try {
  if (input.recover) {
    const recovered = await service.recoverInterruptedJobsOnStartup(new Date(), [
      JOB_TYPES.AGENT_WAKE,
    ]);
    process.stdout.write(JSON.stringify({ event: "startup-recovery", recovered }) + "\n");
  }
  const result = await service.processPendingJobs(1, { jobTypes: [JOB_TYPES.AGENT_WAKE] });
  process.stdout.write(JSON.stringify({ event: "worker-result", result }) + "\n");
  if (result.succeeded !== 1 || result.failed !== 0) process.exitCode = 1;
} finally {
  await DockerSSHClient.disconnectAll();
  await closeDatabaseConnectionsForTests();
}
