/**
 * PROXY_STATUS action
 *
 * Returns Anthropic proxy stats by querying the AnthropicProxyService.
 */

import type { Action, ActionResult, IAgentRuntime } from "@elizaos/core";
import {
  ANTHROPIC_PROXY_SERVICE_NAME,
  type AnthropicProxyService,
} from "../services/proxy-service.js";

export const proxyStatusAction: Action = {
  name: "PROXY_STATUS",
  similes: ["ANTHROPIC_PROXY_STATUS", "CLAUDE_MAX_PROXY_STATUS", "CHECK_PROXY"],
  description:
    "Report current Anthropic proxy status: mode (inline/shared/off), bound URL, " +
    "whether the local server is listening, request count, token expiry hours, " +
    "and (in shared mode) reachability of the upstream proxy.",
  descriptionCompressed:
    "anthropic-proxy-status: mode, url, listening, requests, token expiry, upstream check",
  contexts: ["system", "settings"],
  validate: async () => true,
  handler: async (runtime: IAgentRuntime): Promise<ActionResult> => {
    const service = runtime.getService<AnthropicProxyService>(ANTHROPIC_PROXY_SERVICE_NAME);
    if (!service) {
      return {
        success: false,
        text: "AnthropicProxyService not loaded",
        values: { available: false },
      };
    }
    const status = await service.getStatus();
    const lines: string[] = [
      `mode: ${status.mode}`,
      `url: ${status.url ?? "(none)"}`,
      `listening: ${status.listening}`,
    ];
    if (status.startError) lines.push(`startError: ${status.startError}`);
    if (status.stats) {
      lines.push(`requests: ${status.stats.requestsServed}`);
      lines.push(`uptime: ${status.stats.uptimeSec}s`);
      if (status.stats.tokenExpiresInHours !== null) {
        lines.push(`tokenExpiresInHours: ${status.stats.tokenExpiresInHours.toFixed(1)}`);
      }
      lines.push(`subscription: ${status.stats.subscriptionType ?? "unknown"}`);
    }
    if (status.upstream) {
      lines.push(
        `upstream: reachable=${status.upstream.reachable} ` +
          `status=${status.upstream.status ?? "n/a"}` +
          (status.upstream.error ? ` error=${status.upstream.error}` : "")
      );
    }
    return {
      success: true,
      text: lines.join("\n"),
      values: { available: true, ...status },
    };
  },
  examples: [],
};
