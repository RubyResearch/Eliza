/**
 * Health connector domain for LifeOps: connect/disconnect the owner's health
 * data provider and project daily summaries and data points from
 * `@elizaos/plugin-health` into assistant DTOs. All health/circadian domain
 * logic lives in the health plugin; this is a thin owner-access wrapper.
 */
import {
  completeHealthConnectorOAuth,
  deleteStoredHealthToken,
  detectHealthBackend,
  getDailySummary,
  getDataPoints,
  getRecentSummaries,
  type HealthBackend,
  type HealthBridgeConfig,
  HealthBridgeError,
  HealthConnectorApiError,
  type HealthDailySummary,
  type HealthDataPoint,
  HealthOAuthError,
  refreshStoredHealthToken,
  startHealthConnectorOAuth,
  syncHealthConnectorData,
} from "@elizaos/plugin-health";
import type {
  DisconnectLifeOpsHealthConnectorRequest,
  GetLifeOpsHealthSummaryRequest,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsHealthConnectorCapability,
  LifeOpsHealthConnectorProvider,
  LifeOpsHealthConnectorStatus,
  LifeOpsHealthDailySummary,
  LifeOpsHealthMetric,
  LifeOpsHealthMetricSample,
  LifeOpsHealthSummaryResponse,
  StartLifeOpsHealthConnectorRequest,
  StartLifeOpsHealthConnectorResponse,
  SyncLifeOpsHealthConnectorRequest,
} from "../../contracts/index.js";
import {
  LIFEOPS_HEALTH_CONNECTOR_CAPABILITIES,
  LIFEOPS_HEALTH_CONNECTOR_PROVIDERS,
} from "../../contracts/index.js";
import type { LifeOpsContext } from "../lifeops-context.js";
import {
  createLifeOpsConnectorGrant,
  createLifeOpsHealthSyncState,
} from "../repository.js";
import {
  fail,
  normalizeEnumValue,
  normalizeOptionalString,
} from "../service-normalize.js";
import {
  normalizeOptionalConnectorMode,
  normalizeOptionalConnectorSide,
} from "../service-normalize-connector.js";
import { LifeOpsServiceError } from "../service-types.js";
import {
  getHealthDataConnectorStatus,
  getHealthDataConnectorStatuses,
} from "./health-connector-status.js";

type HealthSyncRequest = SyncLifeOpsHealthConnectorRequest & {
  failOnProviderError?: boolean;
};

type DailySummaryAverageField =
  | "heartRateAvg"
  | "restingHeartRate"
  | "hrvMs"
  | "sleepScore"
  | "readinessScore"
  | "weightKg"
  | "bloodPressureSystolic"
  | "bloodPressureDiastolic"
  | "bloodOxygenPercent";

const DEFAULT_HEALTH_SUMMARY_DAYS = 7;
const MAX_HEALTH_SUMMARY_DAYS = 31;

function resolveHealthConfig(): HealthBridgeConfig {
  return {
    healthKitCliPath: process.env.ELIZA_HEALTHKIT_CLI_PATH,
    googleFitAccessToken: process.env.ELIZA_GOOGLE_FIT_ACCESS_TOKEN,
  };
}

function translateHealthError(error: unknown): never {
  if (error instanceof HealthBridgeError) {
    const status = error.backend === "none" ? 503 : 502;
    throw new LifeOpsServiceError(status, error.message);
  }
  throw error;
}

function normalizeHealthProvider(
  value: unknown,
  field = "provider",
): LifeOpsHealthConnectorProvider {
  return normalizeEnumValue(value, field, LIFEOPS_HEALTH_CONNECTOR_PROVIDERS);
}

function normalizeOptionalHealthProvider(
  value: unknown,
): LifeOpsHealthConnectorProvider | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return normalizeHealthProvider(value);
}

function normalizeHealthCapabilities(
  value: unknown,
): LifeOpsHealthConnectorCapability[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    fail(400, "capabilities must be an array");
  }
  const capabilities: LifeOpsHealthConnectorCapability[] = [];
  const seen = new Set<LifeOpsHealthConnectorCapability>();
  for (const candidate of value) {
    const capability = normalizeEnumValue(
      candidate,
      "capabilities[]",
      LIFEOPS_HEALTH_CONNECTOR_CAPABILITIES,
    );
    if (!seen.has(capability)) {
      seen.add(capability);
      capabilities.push(capability);
    }
  }
  return capabilities;
}

function normalizeDateOnly(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    fail(400, `${field} must be a YYYY-MM-DD date`);
  }
  const normalized = value.trim();
  const parsed = Date.parse(`${normalized}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) {
    fail(400, `${field} must be a valid date`);
  }
  return normalized;
}

function normalizeDays(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_HEALTH_SUMMARY_DAYS;
  }
  const parsed = typeof value === "number" ? value : Number(String(value));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(400, "days must be a positive integer");
  }
  return Math.min(Math.trunc(parsed), MAX_HEALTH_SUMMARY_DAYS);
}

function dateOnlyFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function resolveHealthWindow(request: {
  startDate?: string | null;
  endDate?: string | null;
  days?: number;
}): { startDate: string; endDate: string; days: number } {
  const days = normalizeDays(request.days);
  const endDate =
    normalizeDateOnly(request.endDate, "endDate") ?? dateOnlyFromMs(Date.now());
  const startDate =
    normalizeDateOnly(request.startDate, "startDate") ??
    dateOnlyFromMs(
      Date.parse(`${endDate}T00:00:00.000Z`) - (days - 1) * 86_400_000,
    );
  if (startDate > endDate) {
    fail(400, "startDate must be on or before endDate");
  }
  return { startDate, endDate, days };
}

function normalizeHealthMetrics(
  metrics: readonly LifeOpsHealthMetric[] | undefined,
): LifeOpsHealthMetric[] | undefined {
  if (!metrics || metrics.length === 0) {
    return undefined;
  }
  return [...new Set(metrics)];
}

function emptyDailySummary(
  provider: LifeOpsHealthConnectorProvider,
  date: string,
): LifeOpsHealthDailySummary {
  return {
    date,
    provider,
    steps: 0,
    activeMinutes: 0,
    sleepHours: 0,
    calories: null,
    distanceMeters: null,
    heartRateAvg: null,
    restingHeartRate: null,
    hrvMs: null,
    sleepScore: null,
    readinessScore: null,
    weightKg: null,
    bloodPressureSystolic: null,
    bloodPressureDiastolic: null,
    bloodOxygenPercent: null,
  };
}

function summarizeSamples(
  samples: readonly LifeOpsHealthMetricSample[],
): LifeOpsHealthDailySummary[] {
  const summaries = new Map<string, LifeOpsHealthDailySummary>();
  const averages = new Map<string, { total: number; count: number }>();
  const keyFor = (sample: LifeOpsHealthMetricSample) =>
    `${sample.provider}:${sample.localDate}`;
  const summaryFor = (sample: LifeOpsHealthMetricSample) => {
    const key = keyFor(sample);
    const current = summaries.get(key);
    if (current) {
      return current;
    }
    const next = emptyDailySummary(sample.provider, sample.localDate);
    summaries.set(key, next);
    return next;
  };
  const addNullable = (
    summary: LifeOpsHealthDailySummary,
    field: "calories" | "distanceMeters",
    value: number,
  ) => {
    summary[field] = (summary[field] ?? 0) + value;
  };
  const addAverage = (
    sample: LifeOpsHealthMetricSample,
    output: DailySummaryAverageField,
  ) => {
    const bucketKey = `${keyFor(sample)}:${output}`;
    const bucket = averages.get(bucketKey) ?? { total: 0, count: 0 };
    bucket.total += sample.value;
    bucket.count += 1;
    averages.set(bucketKey, bucket);
  };
  for (const sample of samples) {
    const summary = summaryFor(sample);
    switch (sample.metric) {
      case "steps":
        summary.steps += sample.value;
        break;
      case "active_minutes":
        summary.activeMinutes += sample.value;
        break;
      case "sleep_hours":
        summary.sleepHours += sample.value;
        break;
      case "calories":
        addNullable(summary, "calories", sample.value);
        break;
      case "distance_meters":
        addNullable(summary, "distanceMeters", sample.value);
        break;
      case "heart_rate":
        addAverage(sample, "heartRateAvg");
        break;
      case "resting_heart_rate":
        addAverage(sample, "restingHeartRate");
        break;
      case "heart_rate_variability":
        addAverage(sample, "hrvMs");
        break;
      case "sleep_score":
        addAverage(sample, "sleepScore");
        break;
      case "readiness_score":
        addAverage(sample, "readinessScore");
        break;
      case "weight_kg":
        addAverage(sample, "weightKg");
        break;
      case "blood_pressure_systolic":
        addAverage(sample, "bloodPressureSystolic");
        break;
      case "blood_pressure_diastolic":
        addAverage(sample, "bloodPressureDiastolic");
        break;
      case "blood_oxygen_percent":
        addAverage(sample, "bloodOxygenPercent");
        break;
      case "respiratory_rate":
      case "body_temperature_celsius":
        break;
    }
  }
  for (const [bucketKey, bucket] of averages) {
    const [provider, date, field] = bucketKey.split(":") as [
      LifeOpsHealthConnectorProvider,
      string,
      DailySummaryAverageField,
    ];
    const summary = summaries.get(`${provider}:${date}`);
    if (summary && bucket.count > 0) {
      summary[field] = bucket.total / bucket.count;
    }
  }
  return [...summaries.values()].sort((left, right) =>
    left.date === right.date
      ? left.provider.localeCompare(right.provider)
      : right.date.localeCompare(left.date),
  );
}

function healthReasonForAuthError(error: unknown): boolean {
  return (
    error instanceof HealthOAuthError ||
    (error instanceof HealthConnectorApiError &&
      (error.status === 401 || error.status === 403))
  );
}

/**
 * Health connector status, OAuth lifecycle, sync, and summary reads, backed by
 * `@elizaos/plugin-health`. Base-only domain (no cross-domain dependencies).
 */
export class HealthDomain {
  constructor(private readonly ctx: LifeOpsContext) {}

  async getHealthConnectorStatus(): Promise<{
    available: boolean;
    backend: HealthBackend;
    lastCheckedAt: string;
  }> {
    const config = resolveHealthConfig();
    const backend = await detectHealthBackend(config);
    return {
      available: backend !== "none",
      backend,
      lastCheckedAt: new Date().toISOString(),
    };
  }

  async getHealthDataConnectorStatuses(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsHealthConnectorStatus[]> {
    return getHealthDataConnectorStatuses(
      this.ctx,
      LIFEOPS_HEALTH_CONNECTOR_PROVIDERS,
      requestUrl,
      requestedMode,
      requestedSide,
    );
  }

  async getHealthDataConnectorStatus(
    providerInput: LifeOpsHealthConnectorProvider,
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsHealthConnectorStatus> {
    return getHealthDataConnectorStatus(
      this.ctx,
      providerInput,
      requestUrl,
      requestedMode,
      requestedSide,
    );
  }

  async startHealthConnector(
    request: StartLifeOpsHealthConnectorRequest,
    requestUrl: URL,
  ): Promise<StartLifeOpsHealthConnectorResponse> {
    const provider = normalizeHealthProvider(request.provider);
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    if (mode === "cloud_managed") {
      fail(
        501,
        "Cloud-managed health OAuth is not wired for this provider yet.",
      );
    }
    const side =
      normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
    const capabilities = normalizeHealthCapabilities(request.capabilities);
    try {
      return startHealthConnectorOAuth({
        provider,
        agentId: this.ctx.agentId(),
        side,
        mode,
        requestUrl,
        redirectUrl: normalizeOptionalString(request.redirectUrl),
        capabilities,
      });
    } catch (error) {
      if (error instanceof HealthOAuthError) {
        fail(error.status, error.message);
      }
      this.ctx.logLifeOpsError("health_connector_start", error, { provider });
      throw error;
    }
  }

  async completeHealthConnectorCallback(
    callbackUrl: URL,
  ): Promise<LifeOpsHealthConnectorStatus> {
    try {
      const result = await completeHealthConnectorOAuth(callbackUrl);
      if (result.agentId !== this.ctx.agentId()) {
        fail(
          409,
          "Health connector callback does not belong to the active agent.",
        );
      }
      const existingGrant = await this.ctx.repository.getConnectorGrant(
        this.ctx.agentId(),
        result.provider,
        result.mode,
        result.side,
      );
      const nowIso = new Date().toISOString();
      const grant = existingGrant
        ? {
            ...existingGrant,
            identity: { ...result.identity },
            grantedScopes: [...result.grantedScopes],
            capabilities: [...result.grantedCapabilities],
            tokenRef: result.tokenRef,
            executionTarget: "local" as const,
            sourceOfTruth: "local_storage" as const,
            cloudConnectionId: null,
            metadata: {
              ...existingGrant.metadata,
              authState: "connected",
              expiresAt: result.expiresAt,
              hasRefreshToken: result.hasRefreshToken,
            },
            lastRefreshAt: nowIso,
            updatedAt: nowIso,
          }
        : createLifeOpsConnectorGrant({
            agentId: this.ctx.agentId(),
            provider: result.provider,
            side: result.side,
            identity: { ...result.identity },
            grantedScopes: [...result.grantedScopes],
            capabilities: [...result.grantedCapabilities],
            tokenRef: result.tokenRef,
            mode: result.mode,
            executionTarget: "local",
            sourceOfTruth: "local_storage",
            metadata: {
              authState: "connected",
              expiresAt: result.expiresAt,
              hasRefreshToken: result.hasRefreshToken,
            },
            lastRefreshAt: nowIso,
          });
      await this.ctx.repository.upsertConnectorGrant(grant);
      await this.ctx.recordConnectorAudit(
        `${result.provider}:${result.mode}`,
        "health connector granted",
        {
          provider: result.provider,
          side: result.side,
          mode: result.mode,
          capabilities: result.grantedCapabilities,
        },
        {
          tokenRef: result.tokenRef,
          expiresAt: result.expiresAt,
        },
      );
      return this.getHealthDataConnectorStatus(
        result.provider,
        callbackUrl,
        result.mode,
        result.side,
      );
    } catch (error) {
      if (error instanceof HealthOAuthError) {
        fail(error.status, error.message);
      }
      throw error;
    }
  }

  async disconnectHealthConnector(
    request: DisconnectLifeOpsHealthConnectorRequest,
    requestUrl: URL,
  ): Promise<LifeOpsHealthConnectorStatus> {
    const provider = normalizeHealthProvider(request.provider);
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side =
      normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
    const grantId = normalizeOptionalString(request.grantId);
    const grants = (
      await this.ctx.repository.listConnectorGrants(this.ctx.agentId())
    ).filter(
      (grant) =>
        grant.provider === provider &&
        grant.side === side &&
        (!mode || grant.mode === mode),
    );
    const grant = grantId
      ? (grants.find((candidate) => candidate.id === grantId) ?? null)
      : ([...grants].sort((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt),
        )[0] ?? null);
    if (grant?.tokenRef) {
      deleteStoredHealthToken(grant.tokenRef);
    }
    if (grant) {
      await this.ctx.repository.deleteConnectorGrant(
        this.ctx.agentId(),
        provider,
        grant.mode,
        grant.side,
        grant.id,
      );
    }
    return this.getHealthDataConnectorStatus(
      provider,
      requestUrl,
      mode ?? grant?.mode,
      side,
    );
  }

  async syncHealthConnectors(
    request: HealthSyncRequest = {},
  ): Promise<LifeOpsHealthSummaryResponse> {
    const provider = normalizeOptionalHealthProvider(request.provider);
    const side =
      normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const { startDate, endDate } = resolveHealthWindow(request);
    const requestUrl = new URL("http://127.0.0.1/");
    const statuses = provider
      ? [
          await this.getHealthDataConnectorStatus(
            provider,
            requestUrl,
            mode,
            side,
          ),
        ]
      : await this.getHealthDataConnectorStatuses(requestUrl, mode, side);
    for (const status of statuses) {
      const grant = status.grant;
      if (!status.connected || !grant?.tokenRef) {
        continue;
      }
      try {
        const token = await refreshStoredHealthToken(grant.tokenRef);
        if (!token) {
          fail(
            401,
            `${status.provider} health connector needs re-authentication.`,
          );
        }
        const payload = await syncHealthConnectorData({
          token,
          grantId: grant.id,
          startDate,
          endDate,
        });
        for (const sample of payload.samples) {
          await this.ctx.repository.upsertHealthMetricSample(sample);
        }
        for (const workout of payload.workouts) {
          await this.ctx.repository.upsertHealthWorkout(workout);
        }
        for (const episode of payload.sleepEpisodes) {
          await this.ctx.repository.upsertHealthSleepEpisode(episode);
        }
        const syncedAt = new Date().toISOString();
        await this.ctx.repository.upsertHealthSyncState(
          createLifeOpsHealthSyncState({
            agentId: this.ctx.agentId(),
            provider: status.provider,
            grantId: grant.id,
            cursor: payload.cursor,
            lastSyncedAt: syncedAt,
            lastSyncStartedAt: syncedAt,
            lastSyncError: null,
            metadata: {
              sampleCount: payload.samples.length,
              workoutCount: payload.workouts.length,
              sleepEpisodeCount: payload.sleepEpisodes.length,
            },
          }),
        );
        await this.ctx.repository.upsertConnectorGrant({
          ...grant,
          identity: payload.identity ?? grant.identity,
          metadata: {
            ...grant.metadata,
            authState: "connected",
            lastSyncAt: syncedAt,
          },
          lastRefreshAt: syncedAt,
          updatedAt: syncedAt,
        });
      } catch (error) {
        const failedAt = new Date().toISOString();
        await this.ctx.repository.upsertHealthSyncState(
          createLifeOpsHealthSyncState({
            agentId: this.ctx.agentId(),
            provider: status.provider,
            grantId: grant.id,
            cursor: null,
            lastSyncedAt: status.lastSyncAt,
            lastSyncStartedAt: failedAt,
            lastSyncError:
              error instanceof Error ? error.message : String(error),
            metadata: {},
          }),
        );
        if (healthReasonForAuthError(error)) {
          await this.ctx.repository.upsertConnectorGrant({
            ...grant,
            metadata: {
              ...grant.metadata,
              authState: "needs_reauth",
              lastAuthError:
                error instanceof Error ? error.message : String(error),
              lastAuthErrorAt: failedAt,
            },
            updatedAt: failedAt,
          });
        }
        this.ctx.logLifeOpsWarn(
          "health_connector_sync",
          error instanceof Error ? error.message : String(error),
          { provider: status.provider },
        );
        if (provider || request.failOnProviderError) {
          if (error instanceof HealthConnectorApiError) {
            fail(error.status || 502, error.message);
          }
          if (error instanceof HealthOAuthError) {
            fail(error.status, error.message);
          }
          throw error;
        }
      }
    }
    return this.getHealthSummary({
      provider,
      side,
      mode,
      startDate,
      endDate,
      forceSync: false,
    });
  }

  async getHealthSummary(
    request: GetLifeOpsHealthSummaryRequest = {},
  ): Promise<LifeOpsHealthSummaryResponse> {
    const provider = normalizeOptionalHealthProvider(request.provider);
    const side =
      normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const { startDate, endDate } = resolveHealthWindow(request);
    if (request.forceSync) {
      return this.syncHealthConnectors({
        provider,
        side,
        mode,
        startDate,
        endDate,
        days: request.days,
      });
    }
    const requestUrl = new URL("http://127.0.0.1/");
    const providers = provider
      ? [
          await this.getHealthDataConnectorStatus(
            provider,
            requestUrl,
            mode,
            side,
          ),
        ]
      : await this.getHealthDataConnectorStatuses(requestUrl, mode, side);
    const samples = await this.ctx.repository.listHealthMetricSamples(
      this.ctx.agentId(),
      {
        provider,
        startDate,
        endDate,
        metrics: normalizeHealthMetrics(request.metrics),
        limit: 2_000,
      },
    );
    const [workouts, sleepEpisodes] = await Promise.all([
      this.ctx.repository.listHealthWorkouts(this.ctx.agentId(), {
        provider,
        startDate,
        endDate,
        limit: 500,
      }),
      this.ctx.repository.listHealthSleepEpisodes(this.ctx.agentId(), {
        provider,
        startDate,
        endDate,
        limit: 500,
      }),
    ]);
    return {
      providers,
      summaries: summarizeSamples(samples),
      samples,
      workouts,
      sleepEpisodes,
      syncedAt: new Date().toISOString(),
    };
  }

  async getHealthDailySummary(date: string): Promise<HealthDailySummary> {
    try {
      return await getDailySummary(date, resolveHealthConfig());
    } catch (error) {
      translateHealthError(error);
    }
  }

  async getHealthTrend(
    days: number,
    window: { timeZone: string },
  ): Promise<HealthDailySummary[]> {
    try {
      return await getRecentSummaries(days, {
        ...resolveHealthConfig(),
        timeZone: window.timeZone,
      });
    } catch (error) {
      translateHealthError(error);
    }
  }

  async getHealthDataPoints(opts: {
    metric: HealthDataPoint["metric"];
    startAt: string;
    endAt: string;
  }): Promise<HealthDataPoint[]> {
    try {
      return await getDataPoints(opts, resolveHealthConfig());
    } catch (error) {
      translateHealthError(error);
    }
  }
}
