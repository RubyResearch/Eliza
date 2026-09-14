/** Validates the host's exact funding revocation before its unused balance can be refunded. */

import { z } from "zod";
import type { DockerComputeAuthorization } from "./docker-compute-lease";

const receiptSchema = z.object({
  authorization: z.object({
    agentId: z.uuid(),
    organizationId: z.uuid(),
    containerId: z.string().regex(/^[0-9a-f]{64}$/),
    fundingId: z.uuid(),
    previousFundingId: z.uuid().nullable(),
    issuedAtMs: z.number().int().positive().safe(),
    paidFromMs: z.number().int().positive().safe(),
    paidUntilMs: z.number().int().positive().safe(),
  }),
  bootId: z.uuid(),
  expired: z.literal(true),
  stoppedAtMs: z.number().int().positive().safe(),
  startedAtMs: z.number().int().positive().safe().nullable().optional(),
});

export type DockerComputeStopReceipt = z.infer<typeof receiptSchema>;

export function parseDockerComputeStopReceipt(
  value: unknown,
  expected: DockerComputeAuthorization,
): DockerComputeStopReceipt {
  const receipt = receiptSchema.parse(value);
  for (const key of [
    "agentId",
    "organizationId",
    "containerId",
    "fundingId",
    "previousFundingId",
    "paidFromMs",
    "paidUntilMs",
  ] as const) {
    if (receipt.authorization[key] !== expected[key]) {
      throw new Error(`Dedicated provider stop receipt changed ${key}`);
    }
  }
  return receipt;
}
