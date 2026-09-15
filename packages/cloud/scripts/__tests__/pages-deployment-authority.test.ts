/**
 * Exercises the closed Cloudflare Pages authority and deployed-browser proof
 * contracts with deterministic provider records and public HTTP responses.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloudLiveContinuityEvidence } from "../../../app/test/cloud-live-continuity-contract";
import {
  createDeployedRendererProof,
  DEPLOYED_BROWSER_SMOKE_SCHEMA,
  PAGES_AUTHORITY_SCHEMA,
  parseDeployedRendererProof,
  parseWranglerPagesDeploymentOutput,
  resolveWranglerPagesDeploymentOutput,
  verifyPublicPagesDeployment,
} from "../pages-deployment-authority.mjs";

const sourceSha = "87da9c8ba169440f0fb21dc613f7bc425c8014b6";
const deploymentId = "3d07ff31-d66e-4cf0-948c-3f44cd9ed23d";
const deploymentUrl = "https://5f02a912.eliza-app.pages.dev";
const aliasUrl = "https://staging.eliza-app.pages.dev";
const apiOrigin = "https://api-staging.eliza.app";
const buildId = "a".repeat(64);
const indexHtmlSha256 = "b".repeat(64);

function wranglerRecord(
  overrides: Record<string, unknown> = {},
  sessionOverrides: Record<string, unknown> = {},
): string {
  const session = {
    type: "wrangler-session",
    version: 1,
    wrangler_version: "4.100.0",
    command_line_args: [
      "pages",
      "deploy",
      "--project-name=eliza-app",
      "--branch=staging",
      `--commit-hash=${sourceSha}`,
      "--commit-dirty=false",
    ],
    log_file_path: "/tmp/wrangler.log",
    timestamp: "2026-08-21T19:59:59.999Z",
    ...sessionOverrides,
  };
  const summary = {
    type: "pages-deploy",
    version: 1,
    pages_project: "eliza-app",
    deployment_id: deploymentId,
    url: deploymentUrl,
    timestamp: "2026-08-21T20:00:00.000Z",
  };
  const detailed = {
    type: "pages-deploy-detailed",
    version: 1,
    pages_project: "eliza-app",
    deployment_id: deploymentId,
    url: deploymentUrl,
    alias: aliasUrl,
    environment: "preview",
    production_branch: "main",
    deployment_trigger: { metadata: { commit_hash: sourceSha } },
    timestamp: "2026-08-21T20:00:00.001Z",
    ...overrides,
  };
  return `${JSON.stringify(session)}\n${JSON.stringify(summary)}\n${JSON.stringify(detailed)}\n`;
}

function authority() {
  return parseWranglerPagesDeploymentOutput(wranglerRecord(), {
    expectedProject: "eliza-app",
    expectedCommit: sourceSha,
    expectedBranch: "staging",
    expectedAlias: aliasUrl,
    expectedEnvironment: "preview",
    expectedProductionBranch: "main",
    runId: "32500000001",
    runAttempt: "2",
  });
}

describe("Pages alias reconciliation", () => {
  const options = {
    expectedProject: "eliza-app",
    expectedCommit: sourceSha,
    expectedBranch: "staging",
    expectedAlias: aliasUrl,
    expectedEnvironment: "preview",
    expectedProductionBranch: "main",
    runId: "32500000001",
    runAttempt: "2",
  };
  const credentials = {
    accountId: "a".repeat(32),
    apiToken: "test-only-token",
  };
  function deployment(overrides: Record<string, unknown> = {}) {
    return {
      id: deploymentId,
      project_name: "eliza-app",
      url: deploymentUrl,
      aliases: [aliasUrl],
      environment: "preview",
      production_branch: "main",
      deployment_trigger: {
        metadata: {
          commit_hash: sourceSha,
          branch: "staging",
          commit_dirty: false,
        },
      },
      latest_stage: { name: "deploy", status: "success" },
      ...overrides,
    };
  }
  const apiResponse = (value: unknown) =>
    new Response(JSON.stringify({ success: true, result: value }));

  test("keeps complete Wrangler output offline and unchanged", async () => {
    const result = await resolveWranglerPagesDeploymentOutput(
      wranglerRecord(),
      options,
      {
        fetchImpl: async () => {
          throw new Error("Unexpected provider lookup");
        },
      },
    );
    expect(result).toEqual(authority());
  });

  test("waits for the exact deployment alias without rewriting Wrangler records", async () => {
    const raw = wranglerRecord({ alias: undefined });
    expect(() => parseWranglerPagesDeploymentOutput(raw, options)).toThrow(
      "exact closed schema",
    );
    const requests: string[] = [];
    const delays: number[] = [];
    const result = await resolveWranglerPagesDeploymentOutput(raw, options, {
      ...credentials,
      fetchImpl: async (url: string, init: RequestInit) => {
        requests.push(url);
        expect(init.redirect).toBe("error");
        expect(init.headers).toEqual({
          Authorization: "Bearer test-only-token",
        });
        return apiResponse(
          deployment({ aliases: requests.length === 1 ? null : [aliasUrl] }),
        );
      },
      sleep: async (ms: number) => {
        delays.push(ms);
      },
    });
    expect(requests).toEqual(
      Array(2).fill(
        `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/pages/projects/eliza-app/deployments/${deploymentId}`,
      ),
    );
    expect(delays).toEqual([1000]);
    expect(result).toEqual(authority());
    expect(raw).toBe(wranglerRecord({ alias: undefined }));
    expect(JSON.stringify(result)).not.toContain(credentials.apiToken);
    expect(JSON.stringify(result)).not.toContain(deploymentId);
  });

  test.each([
    { id: "4d07ff31-d66e-4cf0-948c-3f44cd9ed23d" },
    { project_name: "other-app" },
    { url: "https://other.eliza-app.pages.dev" },
    { environment: "production" },
    { production_branch: "staging" },
    {
      deployment_trigger: {
        metadata: {
          commit_hash: "b".repeat(40),
          branch: "staging",
          commit_dirty: false,
        },
      },
    },
    {
      deployment_trigger: {
        metadata: {
          commit_hash: sourceSha,
          branch: "main",
          commit_dirty: false,
        },
      },
    },
    {
      deployment_trigger: {
        metadata: {
          commit_hash: sourceSha,
          branch: "staging",
          commit_dirty: true,
        },
      },
    },
    { latest_stage: { name: "deploy", status: "failure" } },
  ])("rejects conflicting provider identity %j", async (overrides) => {
    await expect(
      resolveWranglerPagesDeploymentOutput(
        wranglerRecord({ alias: undefined }),
        options,
        {
          ...credentials,
          fetchImpl: async () => apiResponse(deployment(overrides)),
        },
      ),
    ).rejects.toThrow("differs from release identity");
  });

  test("bounds alias polling and never fabricates the expected alias", async () => {
    let calls = 0;
    await expect(
      resolveWranglerPagesDeploymentOutput(
        wranglerRecord({ alias: undefined }),
        options,
        {
          ...credentials,
          fetchImpl: async () => {
            calls += 1;
            return apiResponse(deployment({ aliases: [] }));
          },
          sleep: async () => {},
        },
      ),
    ).rejects.toThrow("bounded identity lookup");
    expect(calls).toBe(5);
  });

  test("rejects extra Wrangler fields before any authenticated lookup", async () => {
    let calls = 0;
    await expect(
      resolveWranglerPagesDeploymentOutput(
        wranglerRecord({ alias: undefined, unexpected: true }),
        options,
        {
          ...credentials,
          fetchImpl: async () => {
            calls += 1;
            return apiResponse(deployment());
          },
        },
      ),
    ).rejects.toThrow("exact closed schema");
    expect(calls).toBe(0);
  });

  test.each(["transport", "http", "json"])(
    "fails closed without exposing provider payloads on %s errors",
    async (failure) => {
      let thrown: unknown;
      try {
        await resolveWranglerPagesDeploymentOutput(
          wranglerRecord({ alias: undefined }),
          options,
          {
            ...credentials,
            fetchImpl: async () => {
              if (failure === "transport")
                throw new Error(credentials.apiToken);
              if (failure === "http")
                return new Response(credentials.apiToken, { status: 403 });
              return new Response(credentials.apiToken);
            },
          },
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(String(thrown)).toContain("Pages deployment identity");
      expect(String(thrown)).not.toContain(credentials.apiToken);
    },
  );
});

function rendererManifest() {
  return {
    schema: "elizaos.renderer.build/v1",
    buildId,
    indexHtmlSha256,
    assetCount: 42,
    builtAt: "2026-08-21T19:59:00.000Z",
    commit: sourceSha,
    variant: null,
    capacitorTarget: null,
    runtimeMode: null,
    playwrightTestAuth: false,
    iosApnsEnabled: null,
  };
}

function response(url: string, value: unknown) {
  return {
    ok: true,
    status: 200,
    url,
    text: async () => JSON.stringify(value),
  };
}

async function publicCheck(phase: "preflight" | "postflight") {
  const fetchImpl = (async (url: string) => {
    const parsed = new URL(url);
    if (parsed.origin === aliasUrl) {
      return response(
        `${aliasUrl}/eliza-renderer-build.json?source=${sourceSha}`,
        rendererManifest(),
      );
    }
    return response(`${apiOrigin}/api/health?source=${sourceSha}`, {
      commit: sourceSha,
      environment: "staging",
      status: "ok",
    });
  }) as unknown as typeof fetch;
  return verifyPublicPagesDeployment(authority(), {
    apiBase: apiOrigin,
    phase,
    fetchImpl,
  });
}

function remoteSmoke() {
  return {
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
  };
}

function latency() {
  return {
    schemaVersion: 1,
    lane: "app-live-e2e-cloud-staging",
    metric: "first-turn-latency",
    definition:
      "composer-send-click-to-settled-valid-assistant-turn: starts immediately before the UI send click; ends after the same fresh non-empty assistant row settles and passes the liveness contract; not first-token latency",
    firstTurnLatencyMs: 12_345,
  };
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

describe("Pages deployment authority", () => {
  test("closes the exact Wrangler session and deployment records without publishing local metadata", () => {
    const parsed = authority();
    expect(parsed).toEqual({
      schema: PAGES_AUTHORITY_SCHEMA,
      sourceSha,
      workflow: { runId: 32500000001, runAttempt: 2 },
      project: "eliza-app",
      branch: "staging",
      pagesEnvironment: "preview",
      productionBranch: "main",
      deploymentUrl,
      aliasUrl,
      deploymentIdSha256:
        "eb251bd0455144d0f3c6642e81b5ad148ffbc82522239e94028b9154159222fc",
    });
    expect(JSON.stringify(parsed)).not.toContain(deploymentId);
    expect(JSON.stringify(parsed)).not.toContain("command_line_args");
    expect(JSON.stringify(parsed)).not.toContain("/tmp/wrangler.log");
  });

  test("rejects extra records, unexpected fields, and cross-record drift", () => {
    expect(() =>
      parseWranglerPagesDeploymentOutput(`${wranglerRecord()}{}\n`, {
        expectedProject: "eliza-app",
        expectedCommit: sourceSha,
        expectedBranch: "staging",
        expectedAlias: aliasUrl,
        expectedEnvironment: "preview",
        expectedProductionBranch: "main",
        runId: "1",
        runAttempt: "1",
      }),
    ).toThrow("exactly three");
    expect(() =>
      parseWranglerPagesDeploymentOutput(
        wranglerRecord({ deployment_id: "other" }),
        {
          expectedProject: "eliza-app",
          expectedCommit: sourceSha,
          expectedBranch: "staging",
          expectedAlias: aliasUrl,
          expectedEnvironment: "preview",
          expectedProductionBranch: "main",
          runId: "1",
          runAttempt: "1",
        },
      ),
    ).toThrow("deployment_id differs");
    expect(() =>
      parseWranglerPagesDeploymentOutput(wranglerRecord({ unexpected: true }), {
        expectedProject: "eliza-app",
        expectedCommit: sourceSha,
        expectedBranch: "staging",
        expectedAlias: aliasUrl,
        expectedEnvironment: "preview",
        expectedProductionBranch: "main",
        runId: "1",
        runAttempt: "1",
      }),
    ).toThrow("exact closed schema");
  });

  test("rejects missing or malformed Wrangler session records", () => {
    const withoutSession = wranglerRecord().split("\n").slice(1).join("\n");
    expect(() =>
      parseWranglerPagesDeploymentOutput(withoutSession, {
        expectedProject: "eliza-app",
        expectedCommit: sourceSha,
        expectedBranch: "staging",
        expectedAlias: aliasUrl,
        expectedEnvironment: "preview",
        expectedProductionBranch: "main",
        runId: "1",
        runAttempt: "1",
      }),
    ).toThrow("exactly three");

    for (const sessionOverrides of [
      { wrangler_version: "4.99.0" },
      { command_line_args: ["deploy"] },
      { unexpected: true },
    ]) {
      expect(() =>
        parseWranglerPagesDeploymentOutput(
          wranglerRecord({}, sessionOverrides),
          {
            expectedProject: "eliza-app",
            expectedCommit: sourceSha,
            expectedBranch: "staging",
            expectedAlias: aliasUrl,
            expectedEnvironment: "preview",
            expectedProductionBranch: "main",
            runId: "1",
            runAttempt: "1",
          },
        ),
      ).toThrow();
    }
  });

  test("binds the Wrangler command exactly to the attested release", () => {
    const validArgs = [
      "pages",
      "deploy",
      "--project-name=eliza-app",
      "--branch=staging",
      `--commit-hash=${sourceSha}`,
      "--commit-dirty=false",
    ];
    const mutations = [
      validArgs.map((argument) =>
        argument.startsWith("--commit-hash=")
          ? `--commit-hash=${"c".repeat(40)}`
          : argument,
      ),
      validArgs.map((argument) =>
        argument === "--project-name=eliza-app"
          ? "--project-name=other-app"
          : argument,
      ),
      validArgs.map((argument) =>
        argument === "--branch=staging" ? "--branch=main" : argument,
      ),
      validArgs.slice(0, -1),
      [...validArgs, "--skip-caching"],
    ];

    for (const commandLineArgs of mutations) {
      expect(() =>
        parseWranglerPagesDeploymentOutput(
          wranglerRecord({}, { command_line_args: commandLineArgs }),
          {
            expectedProject: "eliza-app",
            expectedCommit: sourceSha,
            expectedBranch: "staging",
            expectedAlias: aliasUrl,
            expectedEnvironment: "preview",
            expectedProductionBranch: "main",
            runId: "1",
            runAttempt: "1",
          },
        ),
      ).toThrow("command_line_args do not match the release");
    }
  });

  test("requires exact commit, alias, environment, and production branch", () => {
    for (const [field, value] of [
      ["deployment_trigger", { metadata: { commit_hash: "c".repeat(40) } }],
      ["alias", "https://other.eliza-app.pages.dev"],
      ["environment", "production"],
      ["production_branch", "staging"],
    ] as const) {
      expect(() =>
        parseWranglerPagesDeploymentOutput(wranglerRecord({ [field]: value }), {
          expectedProject: "eliza-app",
          expectedCommit: sourceSha,
          expectedBranch: "staging",
          expectedAlias: aliasUrl,
          expectedEnvironment: "preview",
          expectedProductionBranch: "main",
          runId: "1",
          runAttempt: "1",
        }),
      ).toThrow();
    }
  });
});

describe("deployed renderer proof", () => {
  test("binds public checks and remote smoke to one exact renderer", async () => {
    const proof = createDeployedRendererProof({
      authority: authority(),
      preflight: await publicCheck("preflight"),
      remoteSmoke: remoteSmoke(),
      latency: latency(),
      continuity: continuity(),
      postflight: await publicCheck("postflight"),
    });
    expect(parseDeployedRendererProof(proof)).toEqual(proof);
    expect(proof.sourceSha).toBe(sourceSha);
    expect(proof.remoteSmoke.outcome).toBe("success");
    expect(proof.remoteSmoke.chatCorrelation).toEqual(
      remoteSmoke().chatCorrelation,
    );
    expect(proof.continuity.forbiddenAgentMutationCount).toBe(0);
  });

  test("combines the browser producer's current evidence through the Node release CLI", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eliza-pages-proof-"));
    try {
      const inputs = {
        authority: authority(),
        preflight: await publicCheck("preflight"),
        "remote-smoke": remoteSmoke(),
        latency: latency(),
        continuity: continuity(),
        postflight: await publicCheck("postflight"),
      };
      const args = [
        new URL("../pages-deployment-authority.mjs", import.meta.url).pathname,
        "combine",
      ];
      for (const [name, value] of Object.entries(inputs)) {
        const path = join(directory, `${name}.json`);
        await writeFile(path, JSON.stringify(value));
        args.push(`--${name}`, path);
      }
      const output = join(directory, "proof.json");
      args.push("--output", output);
      execFileSync("node", args, { timeout: 10_000, stdio: "pipe" });
      const proof = parseDeployedRendererProof(
        JSON.parse(await readFile(output, "utf8")),
      );
      expect(proof.continuity).toEqual(inputs.continuity);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps continuity validation closed and enforces lifecycle approval binding", async () => {
    const inputs = {
      authority: authority(),
      preflight: await publicCheck("preflight"),
      remoteSmoke: remoteSmoke(),
      latency: latency(),
      postflight: await publicCheck("postflight"),
    };
    for (const invalid of [
      { ...continuity(), schemaVersion: 1 },
      { ...continuity(), credential: "must-not-be-published" },
      { ...continuity(), reloadHistoryPassed: false },
      { ...continuity(), dedicatedLifecycleBindingMismatchCount: 1 },
      { ...continuity(), dedicatedCutoverPostCount: 1 },
    ]) {
      expect(() =>
        createDeployedRendererProof({ ...inputs, continuity: invalid }),
      ).toThrow();
    }
  });

  test("rejects unsafe or unvalidated browser correlation fields", async () => {
    const inputs = {
      authority: authority(),
      preflight: await publicCheck("preflight"),
      latency: latency(),
      continuity: continuity(),
      postflight: await publicCheck("postflight"),
    };
    for (const chatCorrelation of [
      { ...remoteSmoke().chatCorrelation, traceId: "Bearer private-secret" },
      {
        ...remoteSmoke().chatCorrelation,
        serverTiming:
          "dedicated_auth;dur=1, dedicated_ownership;dur=1, dedicated_routing;dur=1, dedicated_proxy_dispatch;dur=1, dedicated_total;dur=4, private_api_key;dur=1",
      },
      {
        ...remoteSmoke().chatCorrelation,
        providerRequestIdSha256: "private request id with spaces",
      },
      { ...remoteSmoke().chatCorrelation, credential: "private-secret" },
    ]) {
      expect(() =>
        createDeployedRendererProof({
          ...inputs,
          remoteSmoke: { ...remoteSmoke(), chatCorrelation },
        }),
      ).toThrow();
    }
    for (const remote of [
      {
        ...remoteSmoke(),
        referenceBinding: {
          ...remoteSmoke().referenceBinding,
          runtime: "shared",
        },
      },
      {
        ...remoteSmoke(),
        referenceBinding: {
          runtime: "dedicated",
          apiBase: "https://api-staging.eliza.app",
        },
      },
      {
        ...remoteSmoke(),
        chatCorrelation: {
          ...remoteSmoke().chatCorrelation,
          serverTiming: "dedicated_total;dur=4",
        },
      },
    ]) {
      expect(() =>
        createDeployedRendererProof({ ...inputs, remoteSmoke: remote }),
      ).toThrow();
    }
  });

  test("rejects a stale renderer manifest before browser auth", async () => {
    const fetchImpl = (async (url: string) => {
      const parsed = new URL(url);
      return parsed.origin === aliasUrl
        ? response(url, { ...rendererManifest(), commit: "c".repeat(40) })
        : response(url, { commit: sourceSha, environment: "staging" });
    }) as unknown as typeof fetch;
    await expect(
      verifyPublicPagesDeployment(authority(), {
        apiBase: apiOrigin,
        phase: "preflight",
        fetchImpl,
      }),
    ).rejects.toThrow("renderer manifest commit is stale");
  });

  test("rejects renderer drift between browser and postflight", async () => {
    const preflight = await publicCheck("preflight");
    const postflight = await publicCheck("postflight");
    expect(() =>
      createDeployedRendererProof({
        authority: authority(),
        preflight,
        remoteSmoke: remoteSmoke(),
        latency: latency(),
        continuity: continuity(),
        postflight: {
          ...postflight,
          renderer: { ...postflight.renderer, buildId: "c".repeat(64) },
        },
      }),
    ).toThrow("renderer changed");
  });

  test("rejects forged public manifest schema and commit identities", async () => {
    const preflight = await publicCheck("preflight");
    const postflight = await publicCheck("postflight");
    const inputs = {
      authority: authority(),
      preflight,
      remoteSmoke: remoteSmoke(),
      latency: latency(),
      continuity: continuity(),
      postflight,
    };
    expect(() =>
      createDeployedRendererProof({
        ...inputs,
        preflight: {
          ...preflight,
          renderer: {
            ...preflight.renderer,
            manifestSchema: "elizaos.renderer.build/v0",
          },
        },
      }),
    ).toThrow("renderer/API source identity is inconsistent");
    expect(() =>
      createDeployedRendererProof({
        ...inputs,
        postflight: {
          ...postflight,
          renderer: { ...postflight.renderer, commit: "b".repeat(40) },
        },
      }),
    ).toThrow("renderer/API source identity is inconsistent");
  });
});
