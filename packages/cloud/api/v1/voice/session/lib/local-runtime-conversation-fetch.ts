/**
 * Adapts the cloud voice session's canonical Eliza SSE request to a loopback
 * self-hosted runtime conversation stream. The voice orchestrator and SSE
 * decoder remain unchanged; this boundary only rewrites the route shape and
 * removes cloud-only credentials.
 */

import {
  LOCAL_VOICE_RUNTIME_AGENT_HEADER,
  LOCAL_VOICE_RUNTIME_CONVERSATION_HEADER,
  parseVoiceUiContext,
  REALTIME_VOICE_CLIENT_TRANSPORT,
  type VoiceUiContext,
} from "@elizaos/shared";
import {
  VOICE_CHANNEL_TYPE,
  VOICE_STREAM_PROTOCOL,
} from "@/lib/voice-session/eliza-sse-bridge";

const CLOUD_CONVERSATION_STREAM_PATH =
  /^\/api\/v1\/eliza\/agents\/([^/]+)\/api\/conversations\/([^/]+)\/messages\/stream$/;
const LOOPBACK_IP_LITERALS = new Set(["127.0.0.1", "[::1]"]);
const MAX_CLIENT_MESSAGE_ID_LENGTH = 128;
const FORWARDED_HEADER_NAMES = [
  "X-Eliza-Voice-Trace-Id",
  "X-Eliza-Trace-Id",
] as const;

export interface LocalRuntimeConversationScope {
  agentId: string;
  conversationId: string;
}

export class LocalRuntimeConversationFetchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalRuntimeConversationFetchError";
  }
}

/** Decode an untrusted identity path segment into a typed boundary error. */
function decodeIdentity(label: string, raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch (error) {
    // error-policy:J3 untrusted conversation path segments are client input;
    // malformed percent-encoding is a typed fetch error, not an uncaught URIError.
    throw new LocalRuntimeConversationFetchError(
      `${label} is not valid percent-encoding`,
      { cause: error },
    );
  }
}

export function createLocalRuntimeConversationFetch(
  localRuntimeOrigin: string,
  scope: LocalRuntimeConversationScope,
  fetchImpl: typeof fetch = fetch,
): typeof fetch {
  const origin = resolveLoopbackOrigin(localRuntimeOrigin);

  return (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const sourceUrl = resolveRequestUrl(input);
    const match = CLOUD_CONVERSATION_STREAM_PATH.exec(sourceUrl.pathname);
    if (!match?.[1] || !match[2]) {
      throw new LocalRuntimeConversationFetchError(
        `unsupported local voice upstream path: ${sourceUrl.pathname}`,
      );
    }
    if ((init?.method ?? "GET").toUpperCase() !== "POST") {
      throw new LocalRuntimeConversationFetchError(
        "local voice conversation bridge requires POST",
      );
    }

    const agentId = decodeIdentity("agent id", match[1]);
    const conversationId = decodeIdentity("conversation id", match[2]);
    if (agentId !== scope.agentId || conversationId !== scope.conversationId) {
      throw new LocalRuntimeConversationFetchError(
        "local voice request does not match the bound runtime identity",
      );
    }
    const target = new URL(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages/stream`,
      origin,
    );
    const body = parseRequestBody(init?.body);
    const { uiClientId, ...messageMetadata } = body.metadata;
    const sourceHeaders = new Headers(init?.headers);
    const headers = new Headers();
    for (const name of FORWARDED_HEADER_NAMES) {
      const value = sourceHeaders.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "text/event-stream");
    // Preserve the speaking renderer's routing identity through the existing
    // request-scoped API seam, not persisted history or a new model tool arg.
    // The authenticated voice session and bound runtime scope still own auth.
    if (uiClientId) headers.set("X-ElizaOS-Client-Id", uiClientId);
    // These values come from the startup-validated scope, never the untrusted
    // cloud request headers. The loopback host uses them as an atomic runtime
    // generation fence at its enqueue boundary.
    headers.set(LOCAL_VOICE_RUNTIME_AGENT_HEADER, scope.agentId);
    headers.set(LOCAL_VOICE_RUNTIME_CONVERSATION_HEADER, scope.conversationId);

    return fetchImpl(target, {
      ...init,
      headers,
      body: JSON.stringify({ ...body, metadata: messageMetadata }),
      redirect: "error",
    });
  }) as typeof fetch;
}

function resolveLoopbackOrigin(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    // error-policy:J2 Configuration errors retain their parse cause so the
    // local gateway fails at startup rather than hiding a broken route.
    throw new LocalRuntimeConversationFetchError(
      "local runtime origin is not a valid URL",
      { cause: error },
    );
  }
  if (
    url.protocol !== "http:" ||
    !LOOPBACK_IP_LITERALS.has(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new LocalRuntimeConversationFetchError(
      "local runtime origin must be a canonical HTTP loopback origin",
    );
  }
  if (raw !== url.origin && raw !== `${url.origin}/`) {
    throw new LocalRuntimeConversationFetchError(
      "local runtime origin must use its canonical serialized form",
    );
  }
  return new URL(`${url.origin}/`);
}

function resolveRequestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

function parseRequestBody(body: BodyInit | null | undefined): {
  text: string;
  channelType: typeof VOICE_CHANNEL_TYPE;
  messageRole?: "system";
  clientMessageId?: string;
  metadata: VoiceUiContext & {
    clientTransport: typeof REALTIME_VOICE_CLIENT_TRANSPORT;
  };
  streamProtocol: typeof VOICE_STREAM_PROTOCOL;
} {
  if (typeof body !== "string") {
    throw new LocalRuntimeConversationFetchError(
      "local voice conversation body must be JSON text",
    );
  }
  try {
    const parsed = JSON.parse(body) as {
      text?: unknown;
      messageRole?: unknown;
      clientMessageId?: unknown;
      metadata?: unknown;
      streamProtocol?: unknown;
    };
    if (typeof parsed.text !== "string" || parsed.text.trim() === "") {
      throw new LocalRuntimeConversationFetchError(
        "local voice conversation text is required",
      );
    }
    const metadata =
      typeof parsed.metadata === "object" &&
      parsed.metadata !== null &&
      !Array.isArray(parsed.metadata)
        ? (parsed.metadata as Record<string, unknown>)
        : null;
    if (metadata?.clientTransport !== REALTIME_VOICE_CLIENT_TRANSPORT) {
      throw new LocalRuntimeConversationFetchError(
        "local voice conversation transport metadata is required",
      );
    }
    if (parsed.streamProtocol !== VOICE_STREAM_PROTOCOL) {
      throw new LocalRuntimeConversationFetchError(
        "local voice conversation delta stream protocol is required",
      );
    }
    const uiContext = parseVoiceUiContext(metadata);
    if (!uiContext) {
      throw new LocalRuntimeConversationFetchError("invalid voice UI context");
    }
    if (parsed.messageRole !== undefined && parsed.messageRole !== "system") {
      throw new LocalRuntimeConversationFetchError(
        "local voice conversation message role must be system",
      );
    }
    if (parsed.clientMessageId !== undefined) {
      if (
        typeof parsed.clientMessageId !== "string" ||
        parsed.clientMessageId.length === 0 ||
        parsed.clientMessageId.length > MAX_CLIENT_MESSAGE_ID_LENGTH ||
        parsed.clientMessageId.trim() !== parsed.clientMessageId
      ) {
        throw new LocalRuntimeConversationFetchError(
          "local voice client message id must be canonical and at most 128 characters",
        );
      }
    }
    return {
      text: parsed.text,
      channelType: VOICE_CHANNEL_TYPE,
      ...(parsed.messageRole === undefined
        ? {}
        : { messageRole: parsed.messageRole }),
      ...(parsed.clientMessageId === undefined
        ? {}
        : { clientMessageId: parsed.clientMessageId }),
      metadata: {
        ...uiContext,
        clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT,
      },
      streamProtocol: parsed.streamProtocol,
    };
  } catch (error) {
    // error-policy:J3 The generated upstream body crosses a transport boundary;
    // malformed input fails explicitly instead of becoming an empty chat turn.
    if (error instanceof LocalRuntimeConversationFetchError) throw error;
    throw new LocalRuntimeConversationFetchError(
      "local voice conversation body is invalid JSON",
      { cause: error },
    );
  }
}
