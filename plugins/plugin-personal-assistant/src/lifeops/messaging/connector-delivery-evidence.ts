/** Preserves connector outcomes for durable reconciliation after a provider call has begun. */
import {
  ElizaError,
  inspectSendHandlerResult,
  type SendHandlerDisposition,
  type SendHandlerResult,
} from "@elizaos/core";

export class ConnectorDeliveryEvidenceError extends ElizaError {
  constructor(
    message: string,
    public readonly providerReceipt: Readonly<Record<string, unknown>>,
    cause?: unknown,
  ) {
    super(message, {
      code: "CONNECTOR_DELIVERY_RECONCILIATION_REQUIRED",
      context: { providerReceipt },
      cause,
    });
  }
}

export class ConnectorSenderChangedError extends ElizaError {
  constructor(provider: string, expected: string, actual: string | null) {
    super(
      "The reviewed sending account changed or is unavailable. Create a fresh review.",
      {
        code: "CONNECTOR_SENDER_CHANGED",
        context: { provider, expected, actual },
      },
    );
  }
}

export function assertConnectorSenderIdentity(
  provider: string,
  expected: string | undefined,
  actual: string | null,
): void {
  if (expected !== undefined && (!expected || expected !== actual))
    throw new ConnectorSenderChangedError(provider, expected, actual);
}

export async function dispatchWithDeliveryEvidence(args: {
  provider: "telegram" | "discord";
  accountId: string;
  channelId: string;
  dispatch: () => SendHandlerResult;
}): Promise<Extract<SendHandlerDisposition, { kind: "delivered" }>> {
  let result: Awaited<SendHandlerResult>;
  try {
    result = await args.dispatch();
  } catch (cause) {
    // error-policy:J2 retain the attempted destination when acknowledgement is lost.
    throw new ConnectorDeliveryEvidenceError(
      "Connector acknowledgement is unavailable; reconcile before sending again.",
      {
        provider: args.provider,
        accountId: args.accountId,
        channelId: args.channelId,
        deliveryStatus: "unknown",
      },
      cause,
    );
  }
  const disposition = inspectSendHandlerResult(result);
  if (
    disposition.kind === "delivered" &&
    disposition.receipt?.persistence.status !== "partial" &&
    disposition.receipt?.persistence.status !== "failed"
  )
    return disposition;
  throw new ConnectorDeliveryEvidenceError(
    "Connector delivery or local receipt persistence is incomplete; reconcile before sending again.",
    {
      provider: args.provider,
      accountId: args.accountId,
      channelId: args.channelId,
      disposition,
    },
  );
}
