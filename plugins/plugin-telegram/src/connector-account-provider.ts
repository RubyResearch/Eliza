/**
 * Telegram ConnectorAccountManager provider.
 *
 * Bridges plugin-telegram to the @elizaos/core ConnectorAccountManager so the
 * generic HTTP CRUD surface can list, create, patch, and delete Telegram
 * accounts. Telegram bots authenticate via a long-lived bot token, so OAuth
 * start/complete flows are unsupported by design for this provider.
 *
 * Single-account env-only configurations (TELEGRAM_BOT_TOKEN) are surfaced as
 * a synthesized 'default' account with role 'AGENT' so downstream consumers
 * see a uniform list. Multi-account configs declared on character.settings.telegram
 * retain manager-owned metadata while connection status comes from exact
 * configured-token polling health. Personal configuration alone is pending.
 */
import type {
  ConnectorAccount,
  ConnectorAccountAccessGate,
  ConnectorAccountManager,
  ConnectorAccountPatch,
  ConnectorAccountProvider,
  ConnectorAccountRole,
  IAgentRuntime,
} from "@elizaos/core";
import {
  DEFAULT_ACCOUNT_ID,
  listEnabledTelegramAccounts,
  listPersonalTelegramAccounts,
  resolveTelegramAccount,
  telegramPersonalExternalId,
} from "./accounts";
import { resolveTelegramBotCredential } from "./bot-credential";
import { TELEGRAM_SERVICE_NAME } from "./constants";
import { getTelegramPollerClaim } from "./poller-lock";

// Suffix for the synthesized OWNER (user-account) entry so the agent's bot
// identity and the human owner's personal identity for the same config never
// collide on a single ConnectorAccount id.
const PERSONAL_ACCOUNT_SUFFIX = ":personal";

function nowMs(): number {
  return Date.now();
}

/**
 * Derive the role and access gate for a Telegram identity. The agent's own bot
 * identity is an open AGENT account (acting as the bot is frictionless); the
 * human owner's personal account is an OWNER account behind the owner_binding
 * gate, so "act as the user" can't fire until the user has proven the account is
 * theirs (via the /eliza_pair owner-binding flow).
 */
function deriveAccountRole(personal: boolean): {
  role: ConnectorAccountRole;
  accessGate: ConnectorAccountAccessGate;
  purpose: string[];
} {
  return personal
    ? {
        role: "OWNER",
        accessGate: "owner_binding",
        purpose: ["messaging", "reading"],
      }
    : { role: "AGENT", accessGate: "open", purpose: ["messaging"] };
}

/**
 * Build a synthetic ConnectorAccount for a resolved Telegram identity — either
 * the agent's bot account (from a bot token) or the owner's personal account
 * (from an MTProto user identity). Role/gate are derived from `personal`.
 */
function synthesizeAccount(
  accountId: string,
  name: string | undefined,
  externalId: string | undefined,
  personal: boolean,
): ConnectorAccount {
  const { role, accessGate, purpose } = deriveAccountRole(personal);
  return {
    id: accountId,
    provider: TELEGRAM_SERVICE_NAME,
    label: name ?? `Telegram (${accountId})`,
    role,
    purpose,
    accessGate,
    status: "pending",
    externalId,
    displayHandle: name,
    createdAt: nowMs(),
    updatedAt: nowMs(),
    metadata: {
      synthesized: true,
      source: "env",
      personal,
    },
  };
}

export function createTelegramConnectorAccountProvider(
  runtime: IAgentRuntime,
): ConnectorAccountProvider {
  return {
    provider: TELEGRAM_SERVICE_NAME,
    label: "Telegram",
    statusAuthority: "provider",

    listAccounts: async (
      manager: ConnectorAccountManager,
    ): Promise<ConnectorAccount[]> => {
      // Merge persisted accounts (from manager storage) with synthesized
      // accounts from env/character config. The persisted set wins on id
      // collision so explicit metadata overrides survive; live status is derived below.
      const persisted = await manager
        .getStorage()
        .listAccounts(TELEGRAM_SERVICE_NAME);
      const persistedById = new Map(persisted.map((a) => [a.id, a]));

      // Agent's own bot identities (AGENT, open gate).
      const enabled = listEnabledTelegramAccounts(runtime);
      const synthesized: ConnectorAccount[] = enabled
        .filter((account) => !persistedById.has(account.accountId))
        .map((account) =>
          synthesizeAccount(account.accountId, account.name, undefined, false),
        );

      // Owner's personal identities (OWNER, owner_binding gate) — a distinct
      // account id (<accountId>:personal) so a config declaring both a bot and a
      // user surfaces two accounts.
      for (const account of listPersonalTelegramAccounts(runtime)) {
        const id = `${account.accountId}${PERSONAL_ACCOUNT_SUFFIX}`;
        if (persistedById.has(id)) {
          continue;
        }
        synthesized.push(
          synthesizeAccount(
            id,
            account.name,
            telegramPersonalExternalId(account),
            true,
          ),
        );
      }

      // If env-only single-account flow is configured but the resolved
      // accounts list is empty (e.g. token not yet validated), fall back to
      // surfacing a 'default' entry so downstream UIs always have an anchor.
      if (synthesized.length === 0 && persisted.length === 0) {
        const fallback = resolveTelegramAccount(runtime, DEFAULT_ACCOUNT_ID);
        if (fallback.botToken) {
          synthesized.push(
            synthesizeAccount(
              DEFAULT_ACCOUNT_ID,
              fallback.name,
              undefined,
              false,
            ),
          );
        }
      }

      return Promise.all(
        [...persisted, ...synthesized].map(async (account) => {
          if (account.status === "revoked" || account.status === "disabled")
            return account;
          if (
            account.id.endsWith(PERSONAL_ACCOUNT_SUFFIX) ||
            account.metadata?.personal === true
          ) {
            // Personal credentials establish configuration, not an identity-bound live MTProto session.
            return { ...account, status: "pending" as const };
          }
          const resolved = resolveTelegramAccount(runtime, account.id);
          if (!resolved.enabled)
            return { ...account, status: "disabled" as const };
          const token = await resolveTelegramBotCredential(
            runtime,
            resolved.botToken ?? null,
            "telegram-account-status",
          );
          const claim = token ? getTelegramPollerClaim(token) : undefined;
          const matches =
            claim?.ownerId === String(runtime.agentId) &&
            claim.accountId === account.id;
          const connected = matches && claim?.ok && claim.connected;
          return {
            ...account,
            status: connected
              ? ("connected" as const)
              : matches && claim?.lastError
                ? ("error" as const)
                : ("pending" as const),
          };
        }),
      );
    },

    createAccount: async (input: ConnectorAccountPatch) => {
      // Manager owns persistence. Provide sensible defaults for Telegram bots:
      // role=AGENT (the bot is the agent identity) and purpose=messaging.
      return {
        ...input,
        provider: TELEGRAM_SERVICE_NAME,
        role: input.role ?? "AGENT",
        purpose: input.purpose ?? ["messaging"],
        accessGate: input.accessGate ?? "open",
        status: "pending",
      };
    },

    patchAccount: async (_accountId: string, patch: ConnectorAccountPatch) => {
      return { ...patch, provider: TELEGRAM_SERVICE_NAME };
    },

    deleteAccount: async (): Promise<void> => {
      // Token cleanup is the runtime/secrets store's responsibility; the
      // manager removes the account row after this resolves.
    },

    // Telegram bots use a long-lived bot token; no OAuth flow exists.
    // startOAuth / completeOAuth are intentionally omitted.
  };
}
