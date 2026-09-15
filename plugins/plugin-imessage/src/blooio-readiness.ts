/** Verifies hosted sender identity and API access without sending a message. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";

const ChannelSettings = z.object({
  data: z.object({ channel_id: z.string().min(1), type: z.literal("blooio") }),
});

export async function verifyBlooioChannel(input: {
  apiKey: string;
  fromNumber: string;
  channelId: string;
}): Promise<void> {
  let response: Response;
  try {
    response = await fetch(
      `https://api.blooio.com/v4/channels/${encodeURIComponent(input.fromNumber)}/settings`,
      {
        headers: { Authorization: `Bearer ${input.apiKey}` },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      }
    );
  } catch (cause) {
    // error-policy:J2 preserve transport failure without exposing request credentials.
    throw new ElizaError("Blooio channel verification failed; check connectivity and retry", {
      code: "BLOOIO_CHANNEL_UNAVAILABLE",
      cause,
    });
  }
  if (!response.ok) {
    throw new ElizaError(
      "Blooio rejected channel verification; check the API key and sender access",
      {
        code: "BLOOIO_CHANNEL_ACCESS_DENIED",
        context: { status: response.status },
      }
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    // error-policy:J2 malformed provider responses cannot establish readiness.
    throw new ElizaError("Blooio returned invalid channel settings", {
      code: "BLOOIO_CHANNEL_RESPONSE_INVALID",
      cause,
    });
  }
  const parsed = ChannelSettings.safeParse(payload);
  if (!parsed.success || parsed.data.data.channel_id !== input.channelId) {
    throw new ElizaError(
      "Blooio sender does not match the configured channel; review sender settings",
      {
        code: "BLOOIO_CHANNEL_IDENTITY_MISMATCH",
      }
    );
  }
}
