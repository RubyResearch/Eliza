/**
 * Contract tests for the staging Cloud live receipt's closed, secret-free schema.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloudLiveContinuityEvidence } from "../../app/test/cloud-live-continuity-contract";
import {
  createDeployedRendererProof,
  DEPLOYED_BROWSER_SMOKE_SCHEMA,
  PAGES_AUTHORITY_SCHEMA,
  PAGES_PUBLIC_CHECK_SCHEMA,
} from "../../cloud/scripts/pages-deployment-authority.mjs";
import { createStagingCloudReceipt } from "../write-staging-cloud-receipt.mjs";

const exactSha = "87da9c8ba169440f0fb21dc613f7bc425c8014b6";
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function args(overrides: Record<string, string> = {}): string[] {
  const values = {
    output: "/tmp/staging-cloud-receipt.json",
    "source-sha": exactSha,
    "run-id": "32237956456",
    "run-attempt": "1",
    outcome: "success",
    "started-ms": "1787151674000",
    "completed-ms": "1787151717600",
    "first-turn-latency-ms": "12345",
    "continuity-evidence": "verified",
    ...overrides,
  };
  return Object.entries(values).flatMap(([name, value]) => [
    `--${name}`,
    value,
  ]);
}

function continuity() {
  return createCloudLiveContinuityEvidence({
    challengeTurnCount: 1,
    noAdditionalChatSendAfterChallenge: true,
    personalIdentityEndpointPassed: true,
    reload: {
      historyGetSucceeded: true,
      challengeUserLinePresent: true,
      challengeAssistantLinePresent: true,
    },
    freshContext: {
      historyGetSucceeded: true,
      challengeUserLinePresent: true,
      challengeAssistantLinePresent: true,
      createdWithoutStorageState: true,
      serviceWorkersBlocked: true,
    },
    bindingReuse: {
      personalIdentityReused: true,
      runtimeBindingReused: true,
      apiBaseReused: true,
    },
    dedicatedMutationProof: {
      approvalGrantedCount: 1,
      confirmationClickCount: 0,
      confirmationKind: "none",
      adoptionConfirmationPostCount: 0,
      activationPostCount: 0,
      cutoverPostCount: 0,
      forbiddenAgentMutationCount: 0,
      approvalBindingPresent: false,
      lifecycleBindingMismatchCount: 0,
    },
    cleanupDisposition: "no-test-owned-agent",
    conversationHistoryDisposition: "preserved",
  });
}

function deployedProofFile(
  overrides: { sourceSha?: string; latency?: number } = {},
): string {
  const sourceSha = overrides.sourceSha ?? exactSha;
  const aliasUrl = "https://develop.eliza-app.pages.dev";
  const apiOrigin = "https://api-staging.eliza.app";
  const buildId = "a".repeat(64);
  const renderer = {
    origin: aliasUrl,
    manifestSchema: "elizaos.renderer.build/v1",
    commit: sourceSha,
    buildId,
    indexHtmlSha256: "b".repeat(64),
    assetCount: 42,
  };
  const api = { origin: apiOrigin, commit: sourceSha, environment: "staging" };
  const authority = {
    schema: PAGES_AUTHORITY_SCHEMA,
    sourceSha,
    workflow: { runId: 32237956456, runAttempt: 1 },
    project: "eliza-app",
    branch: "develop",
    pagesEnvironment: "preview",
    productionBranch: "main",
    deploymentUrl: "https://5f02a912.eliza-app.pages.dev",
    aliasUrl,
    deploymentIdSha256: "c".repeat(64),
  };
  const proof = createDeployedRendererProof({
    authority,
    preflight: {
      schema: PAGES_PUBLIC_CHECK_SCHEMA,
      phase: "preflight",
      sourceSha,
      renderer,
      api,
    },
    remoteSmoke: {
      schema: DEPLOYED_BROWSER_SMOKE_SCHEMA,
      sourceSha,
      rendererOrigin: aliasUrl,
      rendererManifestCommit: sourceSha,
      rendererBuildId: buildId,
      cloudApiOrigin: apiOrigin,
      cloudEnvironment: "staging",
      referenceBinding: {
        runtime: "dedicated",
        apiBase:
          "https://123e4567-e89b-42d3-a456-426614174000.cloud-staging.eliza.app",
      },
      chatCorrelation: {
        traceId: "0123456789abcdef0123456789abcdef",
        serverTiming:
          "dedicated_auth;dur=1.25, dedicated_ownership;dur=1, dedicated_routing;dur=1, dedicated_proxy_dispatch;dur=1, dedicated_total;dur=4.25",
        preforward: "total=3;auth=1;mid=1;reserve=1;setup=0",
        providerRequestIdSha256: "d".repeat(64),
      },
      outcome: "success",
    },
    latency: {
      schemaVersion: 1,
      lane: "app-live-e2e-cloud-staging",
      metric: "first-turn-latency",
      definition:
        "composer-send-click-to-settled-valid-assistant-turn: starts immediately before the UI send click; ends after the same fresh non-empty assistant row settles and passes the liveness contract; not first-token latency",
      firstTurnLatencyMs: overrides.latency ?? 12345,
    },
    continuity: continuity(),
    postflight: {
      schema: PAGES_PUBLIC_CHECK_SCHEMA,
      phase: "postflight",
      sourceSha,
      renderer,
      api,
    },
  });
  const root = mkdtempSync(join(tmpdir(), "deployed-renderer-proof-"));
  tempRoots.push(root);
  const path = join(root, "proof.json");
  writeFileSync(path, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
  return path;
}

describe("staging Cloud live receipt", () => {
  test("binds successful evidence to the exact SHA, run, duration, and fixed annotations", () => {
    expect(createStagingCloudReceipt(args())).toEqual({
      schemaVersion: 2,
      lane: "app-live-e2e-cloud-staging",
      sourceSha: exactSha,
      workflow: { runId: 32237956456, runAttempt: 1 },
      result: {
        outcome: "success",
        startedAtMs: 1787151674000,
        completedAtMs: 1787151717600,
        durationMs: 43600,
      },
      measurements: {
        firstTurnLatencyDefinition:
          "composer-send-click-to-settled-valid-assistant-turn: starts immediately before the UI send click; ends after the same fresh non-empty assistant row settles and passes the liveness contract; not first-token latency",
        firstTurnLatencyMs: 12345,
      },
      continuity: {
        verified: true,
        challengeTurnCount: 1,
        noAdditionalChatSendAfterChallenge: true,
        personalIdentityEndpointPassed: true,
        reloadHistoryPassed: true,
        freshContextHistoryPassed: true,
        personalIdentityReused: true,
        runtimeBindingReused: true,
        apiBaseReused: true,
        forbiddenAgentMutationCount: 0,
      },
      cleanup: {
        cleanupDisposition: "no-test-owned-agent",
        conversationHistoryDisposition: "preserved",
      },
      annotations: {
        cloudApiOrigin: "https://api-staging.eliza.app",
        cloudEnvironment: "staging",
        rendererSource: "local-checkout",
        deployedRendererTested: false,
        loginPersonalIdentityChatPassed: true,
        historyContinuityPassed: true,
      },
    });
  });

  test("records a failed test without claiming login, identity, or chat passed", () => {
    const receipt = createStagingCloudReceipt(
      args({
        outcome: "failure",
        "first-turn-latency-ms": "unavailable",
        "continuity-evidence": "unavailable",
      }),
    );
    expect(receipt.result.outcome).toBe("failure");
    expect(receipt.measurements.firstTurnLatencyMs).toBeNull();
    expect(receipt.continuity).toEqual({
      verified: false,
      challengeTurnCount: null,
      noAdditionalChatSendAfterChallenge: null,
      personalIdentityEndpointPassed: null,
      reloadHistoryPassed: null,
      freshContextHistoryPassed: null,
      personalIdentityReused: null,
      runtimeBindingReused: null,
      apiBaseReused: null,
      forbiddenAgentMutationCount: null,
    });
    expect(receipt.cleanup).toEqual({
      cleanupDisposition: "unavailable",
      conversationHistoryDisposition: "unavailable",
    });
    expect(receipt.annotations.loginPersonalIdentityChatPassed).toBe(false);
    expect(receipt.annotations.historyContinuityPassed).toBe(false);
  });

  test("persists closed correlation in receipt v4 from a validated proof file", () => {
    const receipt = createStagingCloudReceipt(
      args({ "deployed-proof-file": deployedProofFile() }),
    );
    expect(receipt.schemaVersion).toBe(4);
    expect(receipt.annotations).toEqual({
      cloudApiOrigin: "https://api-staging.eliza.app",
      cloudEnvironment: "staging",
      rendererSource: "cloudflare-pages-alias",
      deployedRendererTested: true,
      loginPersonalIdentityChatPassed: true,
      historyContinuityPassed: true,
      cloudflarePagesAlias: "https://develop.eliza-app.pages.dev",
    });
    expect(receipt.deployment).toMatchObject({
      cloudflarePagesAlias: "https://develop.eliza-app.pages.dev",
      deploymentUrl: "https://5f02a912.eliza-app.pages.dev",
      deploymentIdSha256: "c".repeat(64),
      rendererBuildId: "a".repeat(64),
      rendererManifestCommit: exactSha,
      runtime: "dedicated",
      referenceApiBaseSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      chatCorrelation: {
        traceId: "0123456789abcdef0123456789abcdef",
        serverTiming:
          "dedicated_auth;dur=1.25, dedicated_ownership;dur=1, dedicated_routing;dur=1, dedicated_proxy_dispatch;dur=1, dedicated_total;dur=4.25",
        preforward: "total=3;auth=1;mid=1;reserve=1;setup=0",
        providerRequestIdSha256: "d".repeat(64),
      },
      publicPreflightPassed: true,
      remoteBrowserSmokePassed: true,
      publicPostflightPassed: true,
    });
    expect(receipt.deployment.proofSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("rejects boolean claims and proof/source/latency mismatches", () => {
    expect(() =>
      createStagingCloudReceipt([
        ...args(),
        "--deployed-renderer-tested",
        "true",
      ]),
    ).toThrow("unsupported argument");
    expect(() =>
      createStagingCloudReceipt(
        args({
          "deployed-proof-file": deployedProofFile({
            sourceSha: "a".repeat(40),
          }),
        }),
      ),
    ).toThrow("does not match the receipt source/run identity");
    expect(() =>
      createStagingCloudReceipt(
        args({
          "deployed-proof-file": deployedProofFile({ latency: 12346 }),
        }),
      ),
    ).toThrow("latency does not match");
  });

  test("requires independently verified continuity on success and forbids it on failure", () => {
    expect(() =>
      createStagingCloudReceipt(args({ "continuity-evidence": "unavailable" })),
    ).toThrow("requires verified continuity-evidence");
    expect(() =>
      createStagingCloudReceipt(
        args({ "continuity-evidence": "anything-else" }),
      ),
    ).toThrow("requires verified continuity-evidence");
    expect(() =>
      createStagingCloudReceipt(
        args({
          outcome: "failure",
          "first-turn-latency-ms": "unavailable",
          "continuity-evidence": "verified",
        }),
      ),
    ).toThrow("must mark continuity-evidence unavailable");
  });

  test("requires a separate validated-reply measurement on success and forbids one on failure", () => {
    expect(() =>
      createStagingCloudReceipt(
        args({ "first-turn-latency-ms": "unavailable" }),
      ),
    ).toThrow("successful outcome requires");
    expect(() =>
      createStagingCloudReceipt(args({ "first-turn-latency-ms": "0" })),
    ).toThrow("positive integer");
    for (const invalidLatency of [
      "-1",
      "1.5",
      "1e3",
      "NaN",
      "9007199254740992",
    ]) {
      expect(() =>
        createStagingCloudReceipt(
          args({ "first-turn-latency-ms": invalidLatency }),
        ),
      ).toThrow(/positive integer|safe integer range/);
    }
    expect(() =>
      createStagingCloudReceipt(args({ "first-turn-latency-ms": "43601" })),
    ).toThrow("must not exceed the whole lane duration");
    expect(() =>
      createStagingCloudReceipt(
        args({
          outcome: "failure",
          "first-turn-latency-ms": "12345",
        }),
      ),
    ).toThrow("failed outcome must mark");
  });

  test("rejects abbreviated SHAs, invalid outcomes, and impossible timing", () => {
    expect(() =>
      createStagingCloudReceipt(args({ "source-sha": exactSha.slice(0, 8) })),
    ).toThrow("exact lowercase 40-hex commit SHA");
    expect(() =>
      createStagingCloudReceipt(args({ outcome: "skipped" })),
    ).toThrow("outcome must be success or failure");
    expect(() =>
      createStagingCloudReceipt(
        args({
          "started-ms": "1787151717600",
          "completed-ms": "1787151674000",
        }),
      ),
    ).toThrow("must not precede");
  });

  test("rejects unknown inputs so credentials and raw responses cannot enter the artifact", () => {
    expect(() =>
      createStagingCloudReceipt([...args(), "--bearer", "secret"]),
    ).toThrow("unsupported argument: --bearer");
    expect(() =>
      createStagingCloudReceipt([...args(), "--raw-response", "{}"]),
    ).toThrow("unsupported argument: --raw-response");

    const serialized = JSON.stringify(createStagingCloudReceipt(args()));
    expect(serialized).not.toMatch(
      /bearer|authorization|api.?key|response|reply/i,
    );
  });
});
