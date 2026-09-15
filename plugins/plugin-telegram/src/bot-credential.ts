/** Resolves agent-scoped Telegram bot credentials for setup and account-health reads. */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";

interface CredentialReader {
  get(
    reference: string,
    options: { reveal: boolean; caller: string },
  ): Promise<string>;
}

function isCredentialReader(value: unknown): value is CredentialReader {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as Partial<CredentialReader>).get === "function",
  );
}

export async function resolveTelegramBotCredential(
  runtime: IAgentRuntime,
  token: string | null,
  caller: string,
): Promise<string | null> {
  if (!token?.startsWith("vault://")) return token;
  const reference = token.slice("vault://".length);
  const store = runtime.getService("connector_credential_store");
  if (
    !reference.startsWith(`connector.${runtime.agentId}.telegram.`) ||
    !reference.endsWith(".bot-token") ||
    !isCredentialReader(store)
  ) {
    throw new ElizaError("The configured Telegram credential is unavailable.", {
      code: "TELEGRAM_SETUP_CREDENTIAL_UNAVAILABLE",
    });
  }
  let resolved: string;
  try {
    resolved = await store.get(reference, { reveal: true, caller });
  } catch (cause) {
    // error-policy:J2 Keep credential-store diagnostics out of the owner-visible message.
    throw new ElizaError("The configured Telegram credential is unavailable.", {
      code: "TELEGRAM_SETUP_CREDENTIAL_UNAVAILABLE",
      cause,
    });
  }
  if (!resolved.trim() || resolved.startsWith("vault://")) {
    throw new ElizaError("The configured Telegram credential is unavailable.", {
      code: "TELEGRAM_SETUP_CREDENTIAL_UNAVAILABLE",
    });
  }
  return resolved;
}
