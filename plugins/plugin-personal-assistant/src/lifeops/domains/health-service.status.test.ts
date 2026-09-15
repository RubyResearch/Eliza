/**
 * Verifies HealthDomain connector-status projection across the three grant
 * states: no grant (config_missing), grant without a readable token
 * (needs_reauth), and grant with a real encrypted token on disk (connected /
 * sync_failed). Token reads go through the real AES-GCM store under a
 * per-test ELIZA_OAUTH_DIR.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LifeOpsConnectorGrant } from "@elizaos/plugin-health";
import {
  encryptTokenPayload,
  resolveTokenEncryptionKey,
} from "@elizaos/plugin-health/util/token-encryption";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LifeOpsContext } from "../lifeops-context.js";
import { HealthDomain } from "./health-service.js";

const HEALTH_ENV_KEYS = [
  "ELIZA_STRAVA_CLIENT_ID",
  "ELIZA_STRAVA_CLIENT_SECRET",
  "ELIZA_OAUTH_DIR",
] as const;

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa";
const REQUEST_URL = new URL("http://127.0.0.1:2138");

function makeGrant(
  overrides: Partial<LifeOpsConnectorGrant> = {},
): LifeOpsConnectorGrant {
  const now = new Date().toISOString();
  return {
    id: "grant-1",
    agentId: AGENT_ID,
    provider: "strava",
    connectorAccountId: null,
    side: "owner",
    identity: { username: "runner" },
    grantedScopes: ["activity:read_all"],
    capabilities: ["health.activity.read"],
    tokenRef: path.join(AGENT_ID, "owner", "local", "strava.json"),
    mode: "local",
    executionTarget: "local",
    sourceOfTruth: "local_storage",
    preferredByAgent: false,
    cloudConnectionId: null,
    metadata: { authState: "connected" },
    lastRefreshAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeDomain(repository: Record<string, unknown>): HealthDomain {
  return new HealthDomain({
    repository,
    agentId: () => AGENT_ID,
  } as unknown as LifeOpsContext);
}

function writeEncryptedToken(oauthDir: string, tokenRef: string): void {
  const storageRoot = path.join(oauthDir, "lifeops", "health");
  const filePath = path.join(storageRoot, tokenRef);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const key = resolveTokenEncryptionKey(storageRoot);
  const token = {
    provider: "strava",
    agentId: AGENT_ID,
    side: "owner",
    mode: "local",
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri:
      "http://127.0.0.1:2138/api/lifeops/connectors/health/strava/callback",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    tokenType: "Bearer",
    grantedScopes: ["activity:read_all"],
    expiresAt: Date.now() + 3_600_000,
    identity: { username: "runner" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    filePath,
    JSON.stringify(encryptTokenPayload(JSON.stringify(token), key), null, 2),
    { mode: 0o600 },
  );
}

describe("HealthDomain connector status", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const key of HEALTH_ENV_KEYS) {
      delete process.env[key];
    }
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  function makeOAuthDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-oauth-"));
    tempDirs.push(dir);
    process.env.ELIZA_OAUTH_DIR = dir;
    return dir;
  }

  it("reports config_missing when no connector grant or OAuth config exists", async () => {
    for (const key of HEALTH_ENV_KEYS) {
      delete process.env[key];
    }
    const repository = {
      listConnectorGrants: vi.fn(async () => []),
      getConnectorGrant: vi.fn(async () => null),
      getHealthSyncState: vi.fn(),
    };
    const domain = makeDomain(repository);

    const status = await domain.getHealthDataConnectorStatus(
      "strava",
      REQUEST_URL,
    );

    expect(status).toMatchObject({
      provider: "strava",
      side: "owner",
      mode: "local",
      executionTarget: "local",
      sourceOfTruth: "local_storage",
      configured: false,
      connected: false,
      reason: "config_missing",
      identity: null,
      grantedScopes: [],
      grant: null,
    });
    expect(repository.getHealthSyncState).not.toHaveBeenCalled();
  });

  it("reports needs_reauth when a grant's tokenRef has no readable stored token", async () => {
    makeOAuthDir();
    process.env.ELIZA_STRAVA_CLIENT_ID = "client-id";
    process.env.ELIZA_STRAVA_CLIENT_SECRET = "client-secret";
    const grant = makeGrant();
    const repository = {
      listConnectorGrants: vi.fn(async () => [grant]),
      getConnectorGrant: vi.fn(async () => null),
      getHealthSyncState: vi.fn(async () => null),
    };
    const domain = makeDomain(repository);

    const status = await domain.getHealthDataConnectorStatus(
      "strava",
      REQUEST_URL,
    );

    expect(status).toMatchObject({
      provider: "strava",
      configured: true,
      connected: false,
      reason: "needs_reauth",
      mode: "local",
      identity: { username: "runner" },
      grantedCapabilities: ["health.activity.read"],
      grantedScopes: ["activity:read_all"],
      grant,
    });
    // The preferred grant was found in the list; the point lookup is skipped.
    expect(repository.getConnectorGrant).not.toHaveBeenCalled();
  });

  it("reports connected when the grant's encrypted token is present on disk", async () => {
    const oauthDir = makeOAuthDir();
    process.env.ELIZA_STRAVA_CLIENT_ID = "client-id";
    process.env.ELIZA_STRAVA_CLIENT_SECRET = "client-secret";
    const grant = makeGrant();
    if (!grant.tokenRef) throw new Error("test grant must carry a tokenRef");
    writeEncryptedToken(oauthDir, grant.tokenRef);
    const lastSyncedAt = "2026-07-10T08:00:00.000Z";
    const repository = {
      listConnectorGrants: vi.fn(async () => [grant]),
      getConnectorGrant: vi.fn(async () => null),
      getHealthSyncState: vi.fn(async () => ({
        id: "sync-1",
        agentId: AGENT_ID,
        provider: "strava",
        grantId: grant.id,
        lastSyncedAt,
        lastSyncError: null,
        updatedAt: lastSyncedAt,
      })),
    };
    const domain = makeDomain(repository);

    const status = await domain.getHealthDataConnectorStatus(
      "strava",
      REQUEST_URL,
    );

    expect(status).toMatchObject({
      provider: "strava",
      configured: true,
      connected: true,
      reason: "connected",
      identity: { username: "runner" },
      grantedScopes: ["activity:read_all"],
      hasRefreshToken: true,
      lastSyncAt: lastSyncedAt,
      grant,
    });
    expect(status.expiresAt).toEqual(expect.any(String));
    expect(status.degradations).toBeUndefined();
    expect(repository.getHealthSyncState).toHaveBeenCalledWith(
      AGENT_ID,
      "strava",
      grant.id,
    );
  });

  it("reports sync_failed with a delivery degradation when the last sync errored", async () => {
    const oauthDir = makeOAuthDir();
    process.env.ELIZA_STRAVA_CLIENT_ID = "client-id";
    process.env.ELIZA_STRAVA_CLIENT_SECRET = "client-secret";
    const grant = makeGrant();
    if (!grant.tokenRef) throw new Error("test grant must carry a tokenRef");
    writeEncryptedToken(oauthDir, grant.tokenRef);
    const repository = {
      listConnectorGrants: vi.fn(async () => [grant]),
      getConnectorGrant: vi.fn(async () => null),
      getHealthSyncState: vi.fn(async () => ({
        id: "sync-1",
        agentId: AGENT_ID,
        provider: "strava",
        grantId: grant.id,
        lastSyncedAt: "2026-07-10T08:00:00.000Z",
        lastSyncError: "strava API returned 500",
        updatedAt: "2026-07-10T08:00:00.000Z",
      })),
    };
    const domain = makeDomain(repository);

    const status = await domain.getHealthDataConnectorStatus(
      "strava",
      REQUEST_URL,
    );

    expect(status.connected).toBe(true);
    expect(status.reason).toBe("sync_failed");
    expect(status.degradations).toEqual([
      {
        axis: "delivery-degraded",
        code: "last_sync_failed",
        message: "strava API returned 500",
        retryable: true,
      },
    ]);
  });

  it("projects a status for every provider via getHealthDataConnectorStatuses", async () => {
    makeOAuthDir();
    const repository = {
      listConnectorGrants: vi.fn(async () => []),
      getConnectorGrant: vi.fn(async () => null),
      getHealthSyncState: vi.fn(),
    };
    const domain = makeDomain(repository);

    const statuses = await domain.getHealthDataConnectorStatuses(REQUEST_URL);

    expect(statuses.length).toBeGreaterThanOrEqual(4);
    expect(new Set(statuses.map((s) => s.provider)).size).toBe(statuses.length);
    for (const status of statuses) {
      expect(status.connected).toBe(false);
      expect(status.side).toBe("owner");
    }
  });

  it("rejects an unknown provider with a 400", async () => {
    makeOAuthDir();
    const domain = makeDomain({
      listConnectorGrants: vi.fn(async () => []),
      getConnectorGrant: vi.fn(async () => null),
      getHealthSyncState: vi.fn(),
    });
    await expect(
      domain.getHealthDataConnectorStatus(
        "not-a-provider" as never,
        REQUEST_URL,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("HealthDomain connector lifecycle and summaries", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const key of HEALTH_ENV_KEYS) {
      delete process.env[key];
    }
    delete process.env.ELIZA_HEALTHKIT_CLI_PATH;
    delete process.env.ELIZA_GOOGLE_FIT_ACCESS_TOKEN;
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  function makeOAuthDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-oauth-"));
    tempDirs.push(dir);
    process.env.ELIZA_OAUTH_DIR = dir;
    return dir;
  }

  function makeSample(
    metric: string,
    value: number,
    overrides: Record<string, unknown> = {},
  ) {
    const now = new Date().toISOString();
    return {
      id: `sample-${metric}-${value}`,
      agentId: AGENT_ID,
      provider: "strava",
      grantId: "grant-1",
      metric,
      value,
      unit: "unit",
      startAt: now,
      endAt: now,
      localDate: "2026-07-10",
      sourceExternalId: `ext-${metric}-${value}`,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  it("reports the bridge backend as unavailable when nothing is configured", async () => {
    delete process.env.ELIZA_HEALTHKIT_CLI_PATH;
    delete process.env.ELIZA_GOOGLE_FIT_ACCESS_TOKEN;
    const domain = makeDomain({});

    const status = await domain.getHealthConnectorStatus();

    expect(status.available).toBe(false);
    expect(status.backend).toBe("none");
    expect(status.lastCheckedAt).toEqual(expect.any(String));
  });

  it("rejects cloud_managed OAuth start with a 501", async () => {
    const domain = makeDomain({});
    await expect(
      domain.startHealthConnector(
        { provider: "strava", mode: "cloud_managed" },
        REQUEST_URL,
      ),
    ).rejects.toMatchObject({ status: 501 });
  });

  it("rejects non-array capabilities on OAuth start with a 400", async () => {
    const domain = makeDomain({});
    await expect(
      domain.startHealthConnector(
        { provider: "strava", capabilities: "everything" as never },
        REQUEST_URL,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("surfaces missing OAuth config as a client error on start", async () => {
    makeOAuthDir();
    const domain = makeDomain({});
    await expect(
      domain.startHealthConnector(
        {
          provider: "strava",
          capabilities: ["health.activity.read", "health.activity.read"],
        },
        REQUEST_URL,
      ),
    ).rejects.toBeInstanceOf(Error);
  });

  it("rejects a malformed OAuth callback URL", async () => {
    makeOAuthDir();
    const domain = makeDomain({});
    await expect(
      domain.completeHealthConnectorCallback(
        new URL("http://127.0.0.1:2138/callback?error=access_denied"),
      ),
    ).rejects.toBeInstanceOf(Error);
  });

  it("disconnects a grant, deleting the stored token and grant row", async () => {
    makeOAuthDir();
    process.env.ELIZA_STRAVA_CLIENT_ID = "client-id";
    process.env.ELIZA_STRAVA_CLIENT_SECRET = "client-secret";
    const grant = makeGrant();
    const deleteConnectorGrant = vi.fn(async () => undefined);
    let deleted = false;
    const repository = {
      listConnectorGrants: vi.fn(async () => (deleted ? [] : [grant])),
      getConnectorGrant: vi.fn(async () => null),
      getHealthSyncState: vi.fn(async () => null),
      deleteConnectorGrant: deleteConnectorGrant.mockImplementation(
        async () => {
          deleted = true;
        },
      ),
    };
    const domain = makeDomain(repository);

    const status = await domain.disconnectHealthConnector(
      { provider: "strava" },
      REQUEST_URL,
    );

    expect(deleteConnectorGrant).toHaveBeenCalledWith(
      AGENT_ID,
      "strava",
      grant.mode,
      grant.side,
      grant.id,
    );
    expect(status.connected).toBe(false);
  });

  it("summarizes stored samples across every metric bucket", async () => {
    makeOAuthDir();
    const samples = [
      makeSample("steps", 4_000),
      makeSample("steps", 2_000),
      makeSample("active_minutes", 30),
      makeSample("sleep_hours", 7.5),
      makeSample("calories", 500),
      makeSample("distance_meters", 3_000),
      makeSample("heart_rate", 60),
      makeSample("heart_rate", 80),
      makeSample("resting_heart_rate", 52),
      makeSample("heart_rate_variability", 45),
      makeSample("sleep_score", 88),
      makeSample("readiness_score", 91),
      makeSample("weight_kg", 70),
      makeSample("blood_pressure_systolic", 118),
      makeSample("blood_pressure_diastolic", 76),
      makeSample("blood_oxygen_percent", 98),
      makeSample("respiratory_rate", 14),
      makeSample("steps", 1_000, { localDate: "2026-07-09" }),
    ];
    const repository = {
      listConnectorGrants: vi.fn(async () => []),
      getConnectorGrant: vi.fn(async () => null),
      getHealthSyncState: vi.fn(),
      listHealthMetricSamples: vi.fn(async () => samples),
      listHealthWorkouts: vi.fn(async () => []),
      listHealthSleepEpisodes: vi.fn(async () => []),
    };
    const domain = makeDomain(repository);

    const response = await domain.getHealthSummary({
      provider: "strava",
      days: 7,
      metrics: ["steps", "heart_rate", "steps"] as never,
    });

    expect(response.samples).toHaveLength(samples.length);
    expect(response.summaries).toHaveLength(2);
    const [latest, previous] = response.summaries;
    expect(latest).toMatchObject({
      date: "2026-07-10",
      provider: "strava",
      steps: 6_000,
      activeMinutes: 30,
      sleepHours: 7.5,
      calories: 500,
      distanceMeters: 3_000,
      heartRateAvg: 70,
      restingHeartRate: 52,
      hrvMs: 45,
      sleepScore: 88,
      readinessScore: 91,
      weightKg: 70,
      bloodPressureSystolic: 118,
      bloodPressureDiastolic: 76,
      bloodOxygenPercent: 98,
    });
    expect(previous).toMatchObject({ date: "2026-07-09", steps: 1_000 });
    expect(repository.listHealthMetricSamples).toHaveBeenCalledWith(
      AGENT_ID,
      expect.objectContaining({
        provider: "strava",
        metrics: ["steps", "heart_rate"],
        limit: 2_000,
      }),
    );
  });

  it("rejects malformed summary windows", async () => {
    const domain = makeDomain({
      listConnectorGrants: vi.fn(async () => []),
      getConnectorGrant: vi.fn(async () => null),
      getHealthSyncState: vi.fn(),
    });
    await expect(
      domain.getHealthSummary({ startDate: "yesterday" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(domain.getHealthSummary({ days: -3 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      domain.getHealthSummary({
        startDate: "2026-07-10",
        endDate: "2026-07-01",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("skips disconnected providers on sync and returns the stored summary", async () => {
    makeOAuthDir();
    const repository = {
      listConnectorGrants: vi.fn(async () => []),
      getConnectorGrant: vi.fn(async () => null),
      getHealthSyncState: vi.fn(),
      listHealthMetricSamples: vi.fn(async () => []),
      listHealthWorkouts: vi.fn(async () => []),
      listHealthSleepEpisodes: vi.fn(async () => []),
    };
    const domain = makeDomain(repository);

    const response = await domain.syncHealthConnectors({ provider: "strava" });

    expect(response.summaries).toEqual([]);
    expect(response.providers).toHaveLength(1);
    expect(response.providers[0].connected).toBe(false);
  });

  it("routes forceSync summaries through the sync path", async () => {
    makeOAuthDir();
    const repository = {
      listConnectorGrants: vi.fn(async () => []),
      getConnectorGrant: vi.fn(async () => null),
      getHealthSyncState: vi.fn(),
      listHealthMetricSamples: vi.fn(async () => []),
      listHealthWorkouts: vi.fn(async () => []),
      listHealthSleepEpisodes: vi.fn(async () => []),
    };
    const domain = makeDomain(repository);

    const response = await domain.getHealthSummary({
      provider: "strava",
      forceSync: true,
    });

    expect(response.providers).toHaveLength(1);
    expect(response.syncedAt).toEqual(expect.any(String));
  });

  it("translates bridge unavailability into 503s for daily reads", async () => {
    delete process.env.ELIZA_HEALTHKIT_CLI_PATH;
    delete process.env.ELIZA_GOOGLE_FIT_ACCESS_TOKEN;
    const domain = makeDomain({});

    await expect(
      domain.getHealthDailySummary("2026-07-10"),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      domain.getHealthTrend(7, { timeZone: "UTC" }),
    ).rejects.toMatchObject({
      status: 503,
    });
    await expect(
      domain.getHealthDataPoints({
        metric: "steps",
        startAt: "2026-07-09T00:00:00.000Z",
        endAt: "2026-07-10T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ status: 503 });
  });
});
