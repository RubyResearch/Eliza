/** Preserves observed provider evidence when an approval dispatch needs reconciliation instead of an automatic retry. */
import { ElizaError } from "@elizaos/core";

export class ApprovalAmbiguousDeliveryError extends ElizaError {
  override readonly name = "ApprovalAmbiguousDeliveryError";

  constructor(
    message: string,
    public readonly providerReceipt: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, {
      code: "APPROVAL_DELIVERY_UNCERTAIN",
      cause: options?.cause,
      context: { providerReceipt },
    });
  }
}
