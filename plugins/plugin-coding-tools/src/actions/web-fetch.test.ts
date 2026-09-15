/**
 * WEB_FETCH coverage for the coding-tools plugin: routing metadata, SSRF
 * rejection, redirect revalidation, byte caps, timeout/error surfacing, HTML
 * extraction, binary rejection, and stable success metadata. The HTTP layer is
 * injected so tests run without real DNS or network.
 */
import type {
  ActionParameters,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetWebHttpTestOverrides,
  __setWebHttpFetchImplForTests,
  __setWebHttpLookupFnForTests,
  __setWebHttpPinnedFetchImplForTests,
} from "../lib/web-http.js";
import { htmlToReadableText, webFetchAction } from "./web-fetch.js";

vi.mock("@elizaos/logger", () => {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  return {
    __loggerTestHooks: {},
    addLogListener: vi.fn(),
    createLogger: () => logger,
    customLevels: {},
    default: logger,
    elizaLogger: logger,
    logChatIn: vi.fn(),
    logChatOut: vi.fn(),
    logger,
    logPrompt: vi.fn(),
    logResponse: vi.fn(),
    recentLogs: [],
    removeLogListener: vi.fn(),
  };
});

const PUBLIC_IP = "93.184.216.34";

async function runFetch(parameters: ActionParameters): Promise<ActionResult> {
  const result = await webFetchAction.handler(
    {} as IAgentRuntime,
    {} as Memory,
    {} as State,
    { parameters },
  );
  if (!result) throw new Error("handler returned no result");
  return result;
}

function usePinnedRoutes(routes: Record<string, Response>): void {
  __setWebHttpLookupFnForTests(async (hostname) => {
    if (hostname === "private.example.test") {
      return [{ address: "10.0.0.7", family: 4 }];
    }
    return [{ address: PUBLIC_IP, family: 4 }];
  });
  __setWebHttpPinnedFetchImplForTests(async ({ url, init }) => {
    init.signal?.throwIfAborted();
    const response = routes[url.toString()];
    if (!response) throw new Error(`unhandled URL ${url.toString()}`);
    return response;
  });
}

describe("coding-tools WEB_FETCH", () => {
  afterEach(() => {
    __resetWebHttpTestOverrides();
  });

  it("is reachable from web turns without widening its admin role gate", () => {
    expect(webFetchAction.contexts).toEqual([
      "code",
      "terminal",
      "automation",
      "web",
    ]);
    expect(webFetchAction.contextGate).toEqual({
      anyOf: ["code", "terminal", "automation", "web"],
    });
    expect(webFetchAction.roleGate).toEqual({ minRole: "ADMIN" });
  });

  it("advertises exact live endpoints as the fresh-data path", () => {
    expect(webFetchAction.routingHint).toContain("live NOW-values");
    expect(webFetchAction.routingHint).toContain("api.coingecko.com");
    expect(webFetchAction.routingHint).toContain("wttr.in");
    expect(webFetchAction.description).toContain("Prefer this over WEB_SEARCH");
  });

  it("rejects private literal IP targets before any request is sent", async () => {
    __setWebHttpFetchImplForTests(async () => {
      throw new Error("fetch should not run");
    });

    const result = await runFetch({ url: "https://10.0.0.1/metadata" });

    expect(result.success).toBe(false);
    expect(result.text).toContain("private");
  });

  it("rejects redirects to private-resolving hosts", async () => {
    usePinnedRoutes({
      "https://public.example.test/start": new Response("", {
        status: 302,
        headers: { location: "https://private.example.test/secret" },
      }),
    });

    const result = await runFetch({ url: "https://public.example.test/start" });

    expect(result.success).toBe(false);
    expect(result.text).toContain("private");
  });

  it("rejects redirects that downgrade HTTPS to plaintext HTTP without requesting the plaintext hop", async () => {
    const requested: string[] = [];
    __setWebHttpLookupFnForTests(async () => [
      { address: PUBLIC_IP, family: 4 },
    ]);
    __setWebHttpPinnedFetchImplForTests(async ({ url }) => {
      requested.push(url.toString());
      if (url.toString() === "https://public.example.test/start") {
        return new Response("", {
          status: 302,
          headers: { location: "http://public.example.test/plaintext" },
        });
      }
      throw new Error(`unexpected request to ${url.toString()}`);
    });

    const result = await runFetch({ url: "https://public.example.test/start" });

    expect(result.success).toBe(false);
    expect(result.text).toContain("redirect downgrade");
    // The plaintext hop must be rejected BEFORE any request is issued to it.
    expect(requested).toEqual(["https://public.example.test/start"]);
  });

  it("honors the ELIZA_WEB_FETCH kill switch at validate and handler entry", async () => {
    const previous = process.env.ELIZA_WEB_FETCH;
    process.env.ELIZA_WEB_FETCH = "0";
    try {
      __setWebHttpFetchImplForTests(async () => {
        throw new Error("fetch should not run");
      });

      const valid = await webFetchAction.validate(
        {} as IAgentRuntime,
        {} as Memory,
        {} as State,
      );
      expect(valid).toBe(false);

      const result = await runFetch({ url: "https://public.example.test/x" });
      expect(result.success).toBe(false);
      expect(result.text).toContain("disabled");
    } finally {
      if (previous === undefined) delete process.env.ELIZA_WEB_FETCH;
      else process.env.ELIZA_WEB_FETCH = previous;
    }
  });

  it("rejects a response beyond the complete-capture ceiling without partial text", async () => {
    usePinnedRoutes({
      "https://public.example.test/large.txt": new Response(
        "x".repeat(300_000),
        { status: 200, headers: { "content-type": "text/plain" } },
      ),
    });

    const result = await runFetch({
      url: "https://public.example.test/large.txt",
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain("safety ceiling");
    expect(result.text).not.toContain("x".repeat(100));
  });

  it("preserves the complete response and surrogate pairs", async () => {
    const text = `${"a".repeat(7_999)}🦊${"b".repeat(100)}`;
    usePinnedRoutes({
      "https://public.example.test/emoji.txt": new Response(text, {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    });
    const result = await runFetch({
      url: "https://public.example.test/emoji.txt",
    });
    expect(result.success).toBe(true);
    const complete = result.text ?? "";
    expect(complete.isWellFormed()).toBe(true);
    expect(complete).toBe(text);
  });

  it("preserves an emoji in a complete response", async () => {
    const text = `${"a".repeat(100)}🦊`;
    usePinnedRoutes({
      "https://public.example.test/fitting.txt": new Response(text, {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    });
    const result = await runFetch({
      url: "https://public.example.test/fitting.txt",
    });
    expect(result.success).toBe(true);
    expect(result.text).toBe(text);
    expect(result.text?.isWellFormed()).toBe(true);
  });

  it("sanitizes lone surrogates in fetched text", async () => {
    const text = "a\ud800bc";
    usePinnedRoutes({
      "https://public.example.test/lone.txt": new Response(text, {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    });
    const result = await runFetch({
      url: "https://public.example.test/lone.txt",
    });
    expect(result.success).toBe(true);
    expect(result.text).toBe("a\ufffdbc");
    expect(result.text?.isWellFormed()).toBe(true);
  });

  it("names the WEB_SEARCH fallback on an upstream 5xx (live sweep: wttr.in HTTP 500)", async () => {
    usePinnedRoutes({
      "https://wttr.in/Austin,Texas?format=j1": new Response("boom", {
        status: 500,
        headers: { "content-type": "text/plain" },
      }),
    });
    const result = await runFetch({
      url: "https://wttr.in/Austin,Texas?format=j1",
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("HTTP 500");
    expect(result.text).toContain("wttr.in failed upstream");
    expect(result.text).toContain("WEB_SEARCH");
    expect(result.data).toMatchObject({ status: 500 });
  });

  it("carries no fallback hint on a plain 4xx", async () => {
    usePinnedRoutes({
      "https://public.example.test/missing": new Response("nope", {
        status: 404,
        headers: { "content-type": "text/plain" },
      }),
    });
    const result = await runFetch({
      url: "https://public.example.test/missing",
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("HTTP 404");
    expect(result.text).not.toContain("WEB_SEARCH");
  });

  it("surfaces timeout-style fetch errors honestly", async () => {
    __setWebHttpLookupFnForTests(async () => [
      { address: PUBLIC_IP, family: 4 },
    ]);
    __setWebHttpPinnedFetchImplForTests(async () => {
      throw new Error("request aborted by timeout");
    });

    const result = await runFetch({ url: "https://public.example.test/slow" });

    expect(result.success).toBe(false);
    expect(result.text).toContain("request aborted by timeout");
    expect(result.text).toContain("WEB_SEARCH");
  });

  it("extracts useful readable text from HTML instead of raw markup", async () => {
    usePinnedRoutes({
      "https://public.example.test/page": new Response(
        "<html><head><title>Docs &amp; API</title><style>.x{}</style></head><body><h1>Hello</h1><script>bad()</script><p>Readable <b>text</b>.</p></body></html>",
        {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      ),
    });

    const result = await runFetch({ url: "https://public.example.test/page" });

    expect(result.success).toBe(true);
    expect(result.text).toContain("Docs & API");
    expect(result.text).toContain("Hello");
    expect(result.text).toContain("Readable text.");
    expect(result.text).not.toContain("<h1>");
    expect(result.text).not.toContain("bad()");
    expect(result.data).toMatchObject({ kind: "html" });
  });

  it("rejects declared binary content types and cancels the rejected body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      start(controller) {
        controller.enqueue(new TextEncoder().encode("binary bytes"));
      },
    });
    usePinnedRoutes({
      "https://public.example.test/image": new Response(body, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    });

    const result = await runFetch({ url: "https://public.example.test/image" });

    expect(result.success).toBe(false);
    expect(result.text).toContain("Unsupported content type");
    expect(cancelled).toBe(true);
  });

  it("extracts a JSON path and returns stable metadata", async () => {
    usePinnedRoutes({
      "https://public.example.test/data": new Response(
        JSON.stringify({ data: { price: 42 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    });

    const result = await runFetch({
      url: "https://public.example.test/data",
      extract: "data.price",
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe("42");
    expect(result.data).toMatchObject({
      action: "WEB_FETCH",
      url: "https://public.example.test/data",
      final_url: "https://public.example.test/data",
      status: 200,
      kind: "json",
      truncated: false,
    });
  });

  it("decodes valid numeric and named HTML entities in readable text", () => {
    expect(htmlToReadableText("<p>&#65; &#x41; &amp; &lt; &gt;</p>")).toBe(
      "A A & < >",
    );
    expect(htmlToReadableText("<p>&quot;&apos;&nbsp;x</p>")).toBe("\"' x");
  });

  it("removes browser-tokenized and unclosed script/style blocks", () => {
    expect(
      htmlToReadableText(
        "<p>visible</p><script>steal()</script:lookalike>still-script</sCrIpT data-x=1><style>hidden{}</style=lookalike>still-style</style/ignored><p>after</p><script>unclosed",
      ),
    ).toBe("visible\n\nafter");
  });

  it("degrades invalid numeric entities without throwing and keeps surrounding text", () => {
    // Invalid scalar values must remain literal instead of hard-failing the
    // fetch or introducing an unpaired UTF-16 surrogate into readable text.
    const hex = htmlToReadableText("<p>hello &#x110000; world</p>");
    expect(hex).toContain("hello");
    expect(hex).toContain("world");
    expect(hex).toContain("&#x110000;");

    const dec = htmlToReadableText("<p>hi &#1114112; there</p>");
    expect(dec).toContain("hi");
    expect(dec).toContain("there");
    expect(dec).toContain("&#1114112;");

    expect(htmlToReadableText("<p>&#xD800; &#55296;</p>")).toBe(
      "&#xD800; &#55296;",
    );
    expect(htmlToReadableText("<p>&#xDFFF; &#57343;</p>")).toBe(
      "&#xDFFF; &#57343;",
    );
  });

  it("degrades a malformed numeric entity to readable text through the handler instead of io_error", async () => {
    usePinnedRoutes({
      "https://public.example.test/bad-entity": new Response(
        "<html><body><p>alpha &#x110000; omega</p></body></html>",
        {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      ),
    });

    const result = await runFetch({
      url: "https://public.example.test/bad-entity",
    });

    // On unpatched develop htmlToReadableText throws RangeError, which the
    // handler surfaces as an io_error failure. The fix keeps the fetch success.
    expect(result.success).toBe(true);
    expect(result.text).toContain("alpha");
    expect(result.text).toContain("omega");
    expect(result.data).toMatchObject({ kind: "html" });
  });

  it("falls back to the full JSON when the extract path is missing", async () => {
    usePinnedRoutes({
      "https://public.example.test/data": new Response(
        JSON.stringify({ data: { price: 42 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    });

    const result = await runFetch({
      url: "https://public.example.test/data",
      extract: "data.missing",
    });

    // The extract path is a best-effort hint from the planner; a miss must not
    // fail the whole fetch. The model gets the full JSON and picks what it
    // needs instead of the turn dying on an io_error.
    expect(result.success).toBe(true);
    expect(result.text).toContain('"price":42');
  });
});

describe("coding-tools WEB_FETCH extract bounds", () => {
  afterEach(() => {
    __resetWebHttpTestOverrides();
  });

  it("extracts a valid nested path", async () => {
    usePinnedRoutes({
      "https://public.example.test/bounded": new Response(
        JSON.stringify({ a: { b: { c: 123 } } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    });
    const result = await runFetch({
      url: "https://public.example.test/bounded",
      extract: "a.b.c",
    });
    expect(result.success).toBe(true);
    expect(result.text).toBe("123");
  });

  it("falls back to full JSON on missing path", async () => {
    usePinnedRoutes({
      "https://public.example.test/bounded2": new Response(
        JSON.stringify({ a: 1 }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    });
    const result = await runFetch({
      url: "https://public.example.test/bounded2",
      extract: "a.missing",
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain('"a":1');
  });

  it("falls back on empty segment", async () => {
    usePinnedRoutes({
      "https://public.example.test/empty-seg": new Response(
        JSON.stringify({ a: { b: 1 } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    });
    const result = await runFetch({
      url: "https://public.example.test/empty-seg",
      extract: "a..b",
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain('"a"');
  });

  it("falls back on depth >16", async () => {
    const deep = Array.from({ length: 17 }, (_, i) => `k${i}`).join(".");
    usePinnedRoutes({
      "https://public.example.test/deep": new Response(
        JSON.stringify({ k0: 1 }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    });
    const result = await runFetch({
      url: "https://public.example.test/deep",
      extract: deep,
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain('"k0"');
  });

  it("falls back on segment >256", async () => {
    const longSeg = "x".repeat(257);
    usePinnedRoutes({
      "https://public.example.test/long-seg": new Response(
        JSON.stringify({ [longSeg]: 1, a: 1 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    });
    const result = await runFetch({
      url: "https://public.example.test/long-seg",
      extract: longSeg,
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain('"a":1');
  });

  it("falls back on path >1024", async () => {
    const longPath = "a.".repeat(513);
    usePinnedRoutes({
      "https://public.example.test/long-path": new Response(
        JSON.stringify({ a: 1 }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    });
    const result = await runFetch({
      url: "https://public.example.test/long-path",
      extract: longPath,
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain('"a":1');
  });

  it("gracefully falls back to raw text on malformed JSON responses without throwing", async () => {
    usePinnedRoutes({
      "https://public.example.test/malformed-json": new Response(
        '{"error": unclosed json string',
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    });
    const result = await runFetch({
      url: "https://public.example.test/malformed-json",
    });
    expect(result.success).toBe(true);
    expect(result.text).toBe('{"error": unclosed json string');
  });

  it("gracefully falls back to raw text on non-JSON text starting with brace", async () => {
    usePinnedRoutes({
      "https://public.example.test/brace-text": new Response(
        "{ plain text starting with curly brace",
        {
          status: 200,
          headers: { "content-type": "text/plain" },
        },
      ),
    });
    const result = await runFetch({
      url: "https://public.example.test/brace-text",
    });
    expect(result.success).toBe(true);
    expect(result.text).toBe("{ plain text starting with curly brace");
  });
});
