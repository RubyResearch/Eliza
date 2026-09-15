/** Identifies the renderer-owned delivery channel for view navigation actions. */

import type { Memory } from "@elizaos/core";
import { REALTIME_VOICE_CLIENT_TRANSPORT } from "@elizaos/shared";

export { readViewInteractionClientId } from "@elizaos/shared";

export function isRealtimeVoiceTurn(message: Memory): boolean {
	const metadata = message.content.metadata;
	return (
		typeof metadata === "object" &&
		metadata !== null &&
		!Array.isArray(metadata) &&
		(metadata as Record<string, unknown>).clientTransport ===
			REALTIME_VOICE_CLIENT_TRANSPORT
	);
}
