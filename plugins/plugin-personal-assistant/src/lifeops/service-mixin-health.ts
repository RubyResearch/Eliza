/**
 * Health service mixin: declares the LifeOps health service surface and the
 * `withHealth` mixin that composes the health domain's connect/disconnect and
 * summary methods onto the LifeOpsService base.
 */
import type {
  HealthBackend,
  HealthDailySummary,
  HealthDataPoint,
} from "@elizaos/plugin-health";
import type {
  DisconnectLifeOpsHealthConnectorRequest,
  GetLifeOpsHealthSummaryRequest,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsHealthConnectorProvider,
  LifeOpsHealthConnectorStatus,
  LifeOpsHealthSummaryResponse,
  StartLifeOpsHealthConnectorRequest,
  StartLifeOpsHealthConnectorResponse,
  SyncLifeOpsHealthConnectorRequest,
} from "../contracts/index.js";

export type LifeOpsHealthServicePublic = {
  getHealthConnectorStatus(): Promise<{
    available: boolean;
    backend: HealthBackend;
    lastCheckedAt: string;
  }>;
  getHealthDataConnectorStatuses(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsHealthConnectorStatus[]>;
  getHealthDataConnectorStatus(
    provider: LifeOpsHealthConnectorProvider,
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsHealthConnectorStatus>;
  startHealthConnector(
    request: StartLifeOpsHealthConnectorRequest,
    requestUrl: URL,
  ): Promise<StartLifeOpsHealthConnectorResponse>;
  completeHealthConnectorCallback(
    callbackUrl: URL,
  ): Promise<LifeOpsHealthConnectorStatus>;
  disconnectHealthConnector(
    request: DisconnectLifeOpsHealthConnectorRequest,
    requestUrl: URL,
  ): Promise<LifeOpsHealthConnectorStatus>;
  syncHealthConnectors(
    request?: SyncLifeOpsHealthConnectorRequest,
  ): Promise<LifeOpsHealthSummaryResponse>;
  getHealthSummary(
    request?: GetLifeOpsHealthSummaryRequest,
  ): Promise<LifeOpsHealthSummaryResponse>;
  getHealthDailySummary(date: string): Promise<HealthDailySummary>;
  getHealthTrend(
    days: number,
    window: { timeZone: string },
  ): Promise<HealthDailySummary[]>;
  getHealthDataPoints(opts: {
    metric: HealthDataPoint["metric"];
    startAt: string;
    endAt: string;
  }): Promise<HealthDataPoint[]>;
};
