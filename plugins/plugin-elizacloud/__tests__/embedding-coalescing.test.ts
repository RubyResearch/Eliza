/**
 * Exercises overlapping embedding calls through real runtimes and the Cloud SDK.
 * A loopback HTTP server supplies controlled vectors and delayed responses;
 * these tests prove request ownership, not model quality or cloud latency.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AgentRuntime, EventType } from "@elizaos/core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { handleBatchTextEmbedding, handleTextEmbedding } from "../src/models/embeddings";

interface RecordedRequest {
  input: string[];
  model: string;
  dimensions: number;
}

interface PendingResponse {
  request: RecordedRequest;
  authorization: string | undefined;
  appId: string | string[] | undefined;
  path: string | undefined;
  host: string | undefined;
  response: ServerResponse;
  closed: Promise<void>;
  respond: (status?: number) => void;
}

const received: PendingResponse[] = [];
const waiting: ((response: PendingResponse) => void)[] = [];
let origin: string;
let alternateOrigin: string;
let automaticResponses = false;
const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body: RecordedRequest = JSON.parse(Buffer.concat(chunks).toString());
  const pending: PendingResponse = {
    request: body,
    authorization: request.headers.authorization,
    appId: request.headers["x-app-id"],
    path: request.url,
    host: request.headers.host,
    response,
    closed: new Promise((resolve) => response.once("close", resolve)),
    respond(status = 200) {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify(
          status === 200
            ? {
                data: body.input.map((_, index) => ({
                  index,
                  embedding: Array.from({ length: body.dimensions }, (_v, i) =>
                    i === 0 ? index + 0.25 : 0
                  ),
                })),
                usage: { prompt_tokens: 3, total_tokens: 3 },
              }
            : { error: { message: "Explicit test rejection" } }
        )
      );
    },
  };
  const waiter = waiting.shift();
  if (waiter) waiter(pending);
  else received.push(pending);
  if (automaticResponses) pending.respond();
};
const server = createServer(handleRequest);
const alternate = createServer(handleRequest);

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  origin = `http://127.0.0.1:${address.port}`;
  await new Promise<void>((resolve) => alternate.listen(0, "127.0.0.1", resolve));
  const otherAddress = alternate.address();
  if (!otherAddress || typeof otherAddress === "string")
    throw new Error("Missing alternate address");
  alternateOrigin = `http://127.0.0.1:${otherAddress.port}`;
});

afterAll(async () => {
  await Promise.all(
    [server, alternate].map(async (listener) => {
      listener.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve()))
      );
    })
  );
});

afterEach(() => {
  automaticResponses = false;
  vi.unstubAllEnvs();
});

function nextRequest(): Promise<PendingResponse> {
  const next = received.shift();
  return next ? Promise.resolve(next) : new Promise((resolve) => waiting.push(resolve));
}

function runtime(): AgentRuntime {
  return new AgentRuntime({
    settings: {
      ELIZAOS_CLOUD_BASE_URL: `${origin}/api/v1`,
      ELIZAOS_CLOUD_EMBEDDING_URL: `${origin}/api/v1`,
      ELIZAOS_CLOUD_API_KEY: "eliza_test_coalescing_a",
      ELIZAOS_CLOUD_EMBEDDING_API_KEY: "eliza_test_coalescing_a",
      ELIZAOS_CLOUD_EMBEDDING_MODEL: "text-embedding-3-small",
      ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS: "384",
      ELIZA_APP_ID: "test-app-a",
    },
  });
}

describe("pending Cloud embedding ownership", () => {
  it("shares foreground and indexing work, meters once, copies vectors and forgets completion", async () => {
    const owner = runtime();
    let usageEvents = 0;
    owner.registerEvent(EventType.MODEL_USED, async () => {
      usageEvents += 1;
    });
    const foreground = handleTextEmbedding(owner, "same complete query");
    const request = await nextRequest();
    const indexing = handleBatchTextEmbedding(owner, ["same complete query"]);
    automaticResponses = true;
    request.respond();
    const [vector, batch] = await Promise.all([foreground, indexing]);
    automaticResponses = false;
    expect(vector).toEqual(batch[0]);
    vector[0] = 99;
    expect(batch[0][0]).toBe(0.25);
    expect(usageEvents).toBe(1);
    const later = handleTextEmbedding(owner, "same complete query");
    const fresh = await nextRequest();
    expect(fresh.request.input).toEqual(["same complete query"]);
    fresh.respond();
    await later;
    expect(usageEvents).toBe(2);
  });

  it("keeps indexing alive when its foreground owner aborts", async () => {
    const owner = runtime();
    const controller = new AbortController();
    const foreground = handleTextEmbedding(owner, {
      text: "shared query",
      signal: controller.signal,
    });
    const rejected = expect(foreground).rejects.toThrow("foreground canceled");
    const request = await nextRequest();
    const indexing = handleBatchTextEmbedding(owner, ["shared query"]);
    controller.abort(new Error("foreground canceled"));
    await rejected;
    expect(request.response.destroyed).toBe(false);
    request.respond();
    expect((await indexing)[0][0]).toBe(0.25);
  });

  it("cancels transport after the final owner leaves and admits a fresh operation", async () => {
    const owner = runtime();
    const first = new AbortController();
    const second = new AbortController();
    const a = handleTextEmbedding(owner, { text: "cancel both", signal: first.signal });
    const aRejected = expect(a).rejects.toThrow("first canceled");
    const old = await nextRequest();
    const b = handleTextEmbedding(owner, { text: "cancel both", signal: second.signal });
    const bRejected = expect(b).rejects.toThrow("second canceled");
    first.abort(new Error("first canceled"));
    await aRejected;
    expect(old.response.destroyed).toBe(false);
    second.abort(new Error("second canceled"));
    await bRejected;
    await old.closed;
    const fresh = handleTextEmbedding(owner, "cancel both");
    (await nextRequest()).respond();
    expect((await fresh)[0]).toBe(0.25);
  });

  it.each([
    ["ELIZAOS_CLOUD_EMBEDDING_API_KEY", "eliza_test_coalescing_b"],
    ["ELIZAOS_CLOUD_EMBEDDING_MODEL", "text-embedding-3-large"],
    ["ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS", "768"],
    ["ELIZA_APP_ID", "test-app-b"],
  ])("isolates overlapping work when %s changes", async (setting, value) => {
    const owner = runtime();
    const first = handleTextEmbedding(owner, "same text");
    const a = await nextRequest();
    owner.setSetting(setting, value);
    const second = handleTextEmbedding(owner, "same text");
    const b = await nextRequest();
    expect({ body: a.request, auth: a.authorization, app: a.appId }).not.toEqual({
      body: b.request,
      auth: b.authorization,
      app: b.appId,
    });
    a.respond();
    b.respond();
    await Promise.all([first, second]);
  });

  it.each(["runtime", "endpoint", "order", "complete text"])("isolates %s", async (boundary) => {
    const owner = runtime();
    const prefix = boundary === "complete text" ? "long input ".repeat(12_000) : "query ";
    const first = handleBatchTextEmbedding(owner, [`${prefix}first`, "second"]);
    const a = await nextRequest();
    if (boundary === "endpoint")
      owner.setSetting("ELIZAOS_CLOUD_EMBEDDING_URL", `${alternateOrigin}/api/v1`);
    const secondInput =
      boundary === "order"
        ? ["second", `${prefix}first`]
        : boundary === "complete text"
          ? [`${prefix}different suffix`, "second"]
          : [`${prefix}first`, "second"];
    const second = handleBatchTextEmbedding(
      boundary === "runtime" ? runtime() : owner,
      secondInput
    );
    const b = await nextRequest();
    expect(a.request.input[0]).toBe(`${prefix}first`);
    expect(b.request.input).toEqual(secondInput);
    if (boundary === "endpoint") expect(b.host).not.toBe(a.host);
    a.respond();
    b.respond();
    await Promise.all([first, second]);
  });

  it("propagates a rejected batch to every owner and allows a later retry", async () => {
    const owner = runtime();
    const first = handleTextEmbedding(owner, "rejected");
    const aRejected = expect(first).rejects.toThrow("Authentication failed");
    const request = await nextRequest();
    const second = handleBatchTextEmbedding(owner, ["rejected"]);
    const bRejected = expect(second).rejects.toThrow("Authentication failed");
    request.respond(403);
    await Promise.all([aRejected, bRejected]);
    const later = handleTextEmbedding(owner, "rejected");
    (await nextRequest()).respond();
    expect((await later)[0]).toBe(0.25);
  });

  it("keeps calls without an explicit credential independent", async () => {
    vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "");
    vi.stubEnv("ELIZAOS_CLOUD_EMBEDDING_API_KEY", "");
    const owner = runtime();
    owner.setSetting("ELIZAOS_CLOUD_API_KEY", null);
    owner.setSetting("ELIZAOS_CLOUD_EMBEDDING_API_KEY", null);
    const first = handleTextEmbedding(owner, "cookie session");
    const a = await nextRequest();
    const second = handleTextEmbedding(owner, "cookie session");
    const b = await nextRequest();
    expect(a.authorization).toBeUndefined();
    expect(b.authorization).toBeUndefined();
    a.respond();
    b.respond();
    await Promise.all([first, second]);
  });
});
