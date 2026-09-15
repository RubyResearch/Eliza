/**
 * Adapts configured iMessage accounts to the canonical connector inventory.
 * Configuration alone never establishes readiness: only the default account
 * backed by the running transport can be reported connected.
 */

import type {
  ConnectorAccount,
  ConnectorAccountManager,
  ConnectorAccountPatch,
  ConnectorAccountProvider,
  IAgentRuntime,
} from "@elizaos/core";
import {
  DEFAULT_ACCOUNT_ID,
  listEnabledIMessageAccounts,
  normalizeAccountId,
  type ResolvedIMessageAccount,
  resolveIMessageAccount,
} from "./accounts.js";

import type { IIMessageService, IMessageServiceStatus } from "./types.js";

export const IMESSAGE_PROVIDER_ID = "imessage";

function purposeForAccount(_account: ResolvedIMessageAccount): string[] {
  return ["messaging"];
}

function accessGateForAccount(account: ResolvedIMessageAccount): string {
  const dmPolicy = account.config.dmPolicy;
  if (dmPolicy === "disabled") return "disabled";
  if (dmPolicy === "pairing") return "pairing";
  return "open";
}

function roleForAccount(_account: ResolvedIMessageAccount): "OWNER" | "AGENT" {
  // iMessage uses the macOS user's own Messages app; always OWNER.
  return "OWNER";
}

function toConnectorAccount(
  account: ResolvedIMessageAccount,
  transport: IMessageServiceStatus | null
): ConnectorAccount {
  const now = Date.now();
  return {
    id: normalizeAccountId(account.accountId),
    provider: IMESSAGE_PROVIDER_ID,
    label: account.name ?? account.accountId,
    role: roleForAccount(account),
    purpose: purposeForAccount(account),
    accessGate: accessGateForAccount(account),
    status: !account.enabled
      ? "disabled"
      : normalizeAccountId(account.accountId) !== DEFAULT_ACCOUNT_ID
        ? "error"
        : transport?.connected === true
          ? "connected"
          : "pending",
    createdAt: now,
    updatedAt: now,
    metadata: {
      transport: transport?.transport ?? null,
      channelId: transport?.channelId ?? null,
      dbPath: transport?.transport === "native" ? transport.chatDbPath : null,
      dmPolicy: account.config.dmPolicy ?? "pairing",
      groupPolicy: account.config.groupPolicy ?? "allowlist",
    },
  };
}

export function createIMessageConnectorAccountProvider(
  runtime: IAgentRuntime
): ConnectorAccountProvider {
  return {
    provider: IMESSAGE_PROVIDER_ID,
    label: "iMessage",
    statusAuthority: "provider",
    listAccounts: async (_manager: ConnectorAccountManager): Promise<ConnectorAccount[]> => {
      const transport =
        runtime.getService<IIMessageService>(IMESSAGE_PROVIDER_ID)?.getStatus() ?? null;
      const enabled = listEnabledIMessageAccounts(runtime);
      if (enabled.length > 0) {
        return enabled.map((account) => toConnectorAccount(account, transport));
      }
      const fallback = resolveIMessageAccount(runtime, DEFAULT_ACCOUNT_ID);
      return [toConnectorAccount(fallback, transport)];
    },
    createAccount: async (input: ConnectorAccountPatch, _manager: ConnectorAccountManager) => {
      return {
        ...input,
        provider: IMESSAGE_PROVIDER_ID,
        role: input.role ?? "OWNER",
        purpose: input.purpose ?? ["messaging"],
        accessGate: input.accessGate ?? "open",
        status: input.status ?? "pending",
      };
    },
    patchAccount: async (
      _accountId: string,
      patch: ConnectorAccountPatch,
      _manager: ConnectorAccountManager
    ) => {
      return { ...patch, provider: IMESSAGE_PROVIDER_ID };
    },
    deleteAccount: async (_accountId: string, _manager: ConnectorAccountManager) => {
      // iMessage account state lives in the macOS Messages app, out of band.
    },
    // No OAuth — iMessage reads the local chat.db on macOS.
  };
}
