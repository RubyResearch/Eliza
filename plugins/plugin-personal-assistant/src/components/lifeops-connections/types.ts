/** View-facing contracts for the focused LifeOps connection manager. */

import type {
  LifeOpsCalendarFeed,
  LifeOpsCalendarImportedDataPurgeReceipt,
  LifeOpsCalendarSummary,
  LifeOpsGmailImportedDataPurgeReceipt,
  LifeOpsGmailSyncHealth,
  LifeOpsGoogleCapability,
  LifeOpsGoogleConnectorStatus,
  LifeOpsLinkedCalendarControl,
  PermissionState,
  UpdateLifeOpsLinkedCalendarControlRequest,
} from "@elizaos/shared";

export type LifeOpsSeedRangeDays = 7 | 30 | 90;
export type LifeOpsSeedPhase =
  | "preparing"
  | "gmail"
  | "calendar"
  | "deduplicating"
  | "complete";

export interface LifeOpsConnectionsSnapshot {
  googleAccounts: LifeOpsGoogleConnectorStatus[];
  calendars: LifeOpsCalendarSummary[];
  calendarFeed: LifeOpsCalendarFeed;
  gmailHealthByGrantId: Readonly<Record<string, LifeOpsGmailSyncHealth>>;
  applePermission: PermissionState;
  observedAt: string;
}

export interface LifeOpsSeedRequest {
  grantId: string | null;
  rangeDays: LifeOpsSeedRangeDays;
  includeGmail: boolean;
  calendarKeys: string[];
}

export interface LifeOpsSeedReceipt {
  grantId: string | null;
  rangeDays: LifeOpsSeedRangeDays;
  gmailMessageCount: number;
  calendarEventCount: number;
  calendarSourceCount: number;
  duplicateEventCount: number;
  completedAt: string;
}

export interface LifeOpsPurgeReceipt {
  gmail: LifeOpsGmailImportedDataPurgeReceipt | null;
  calendars: LifeOpsCalendarImportedDataPurgeReceipt[];
}

export interface LifeOpsConnectionsAdapter {
  getLinkedCalendarControl(): Promise<LifeOpsLinkedCalendarControl>;
  updateLinkedCalendarControl(
    request: UpdateLifeOpsLinkedCalendarControlRequest,
  ): Promise<LifeOpsLinkedCalendarControl>;
  load(options?: { forceSync?: boolean }): Promise<LifeOpsConnectionsSnapshot>;
  connectGoogle(capabilities: LifeOpsGoogleCapability[]): Promise<void>;
  disconnectGoogle(grantId: string): Promise<void>;
  setCalendarIncluded(
    calendar: LifeOpsCalendarSummary,
    includeInFeed: boolean,
  ): Promise<LifeOpsCalendarSummary>;
  seed(
    request: LifeOpsSeedRequest,
    onProgress: (phase: LifeOpsSeedPhase) => void,
  ): Promise<LifeOpsSeedReceipt>;
  purgeImportedData(args: {
    grantId: string;
    connectorAccountId: string | null;
    includeGmail: boolean;
    calendars: LifeOpsCalendarSummary[];
  }): Promise<LifeOpsPurgeReceipt>;
  requestApplePermission(): Promise<PermissionState>;
  openApplePermissionSettings(): Promise<void>;
  navigate(path: "/inbox" | "/calendar"): void;
}
