/**
 * Document HTTP routes for the app-documents plugin.
 *
 * These routes are registered through the plugin route registry with
 * `rawPath: true` so the agent server dispatches them via runtime routes.
 * The route handler uses the new return-shape `routeHandler` contract so the
 * boundary-resolved `AccessContext` is available for per-viewer authorization.
 */

import type http from "node:http";
import type {
  AccessContext,
  AgentRuntime,
  Plugin,
  Route,
  RouteHandlerContext,
  RouteHandlerResult,
} from "@elizaos/core";
import {
  sendJson as httpSendJson,
  sendJsonError as httpSendJsonError,
  resolveOwnerEntityIdOrDefault,
} from "@elizaos/core";
import { readJsonBody as httpReadJsonBody } from "@elizaos/shared";
import { handleDocumentsRoutes } from "./routes.js";

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  httpSendJson(res, data, status);
}

function error(res: http.ServerResponse, message: string, status = 400): void {
  httpSendJsonError(res, message, status);
}

/**
 * Reconstructs the trusted local principal for document routes. The HTTP
 * boundary intentionally omits `accessContext` for the single-owner local
 * dashboard, but document routes need an explicit actor to apply their scope
 * wall. Resolve the same owner as local client chat and the other owner-scoped
 * views. Explicit remote/viewer principals are preserved before this fallback.
 */
export function resolveTrustedLocalDocumentAccessContext(
  ctx: Pick<
    RouteHandlerContext,
    "accessContext" | "isTrustedLocal" | "runtime"
  >,
): AccessContext | undefined {
  if (ctx.accessContext || !ctx.isTrustedLocal || !ctx.runtime?.agentId) {
    return ctx.accessContext as AccessContext | undefined;
  }

  return {
    requesterEntityId: resolveOwnerEntityIdOrDefault(ctx.runtime),
    role: "OWNER",
    isOwner: true,
    source: "trusted-local",
  };
}

/**
 * Captured response for the legacy-shaped `handleDocumentsRoutes` writer.
 * The route handler writes to this synthetic `ServerResponse`; we collect
 * status, headers, and body so the new return-shape contract can emit a
 * `RouteHandlerResult`.
 */
interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string>;
  chunks: Buffer[];
  ended: boolean;
}

function buildCapturedResponse(): {
  res: http.ServerResponse;
  captured: CapturedResponse;
} {
  const captured: CapturedResponse = {
    statusCode: 200,
    headers: {},
    chunks: [],
    ended: false,
  };

  const setHeader = (
    name: string,
    value: string | number | readonly string[],
  ): void => {
    const text = Array.isArray(value) ? value.join(", ") : String(value);
    captured.headers[name.toLowerCase()] = text;
  };

  const writeChunk = (chunk: unknown): void => {
    if (chunk == null) return;
    let buf: Buffer;
    if (typeof chunk === "string") {
      buf = Buffer.from(chunk, "utf8");
    } else if (Buffer.isBuffer(chunk)) {
      buf = chunk;
    } else if (chunk instanceof Uint8Array) {
      buf = Buffer.from(chunk);
    } else {
      buf = Buffer.from(String(chunk), "utf8");
    }
    captured.chunks.push(buf);
  };

  const res = {
    statusCode: 200,
    get headersSent() {
      return captured.ended;
    },
    setHeader,
    getHeader: (name: string) => captured.headers[name.toLowerCase()],
    removeHeader: (name: string) => {
      delete captured.headers[name.toLowerCase()];
    },
    write: (chunk: unknown) => {
      writeChunk(chunk);
      return true;
    },
    end: (chunk?: unknown) => {
      if (chunk != null) writeChunk(chunk);
      captured.ended = true;
      return res as unknown as http.ServerResponse;
    },
    status(code: number) {
      this.statusCode = code;
      captured.statusCode = code;
      return {
        json(data: unknown) {
          if (captured.ended) return;
          captured.headers["content-type"] =
            captured.headers["content-type"] ??
            "application/json; charset=utf-8";
          writeChunk(JSON.stringify(data));
          captured.ended = true;
        },
      };
    },
    json(data: unknown) {
      if (captured.ended) return res;
      captured.headers["content-type"] =
        captured.headers["content-type"] ?? "application/json; charset=utf-8";
      writeChunk(JSON.stringify(data));
      captured.ended = true;
      return res;
    },
    send(data: unknown) {
      if (captured.ended) return res;
      if (typeof data === "string" || Buffer.isBuffer(data)) {
        writeChunk(data);
      } else if (data != null) {
        captured.headers["content-type"] =
          captured.headers["content-type"] ?? "application/json; charset=utf-8";
        writeChunk(JSON.stringify(data));
      }
      captured.ended = true;
      return res;
    },
  };

  Object.defineProperty(res, "statusCode", {
    get() {
      return captured.statusCode;
    },
    set(v: number) {
      captured.statusCode = v;
    },
    configurable: true,
  });

  return { res: res as unknown as http.ServerResponse, captured };
}

function capturedToResult(captured: CapturedResponse): RouteHandlerResult {
  const buffer = Buffer.concat(captured.chunks);
  const contentTypeHeader = captured.headers["content-type"];
  const isJson =
    typeof contentTypeHeader === "string" &&
    (contentTypeHeader.includes("application/json") ||
      contentTypeHeader.includes("+json"));

  if (buffer.length === 0) {
    return {
      status: captured.statusCode || 200,
      headers: captured.headers,
    };
  }

  const text = buffer.toString("utf8");
  if (isJson) {
    try {
      return {
        status: captured.statusCode || 200,
        headers: captured.headers,
        body: JSON.parse(text),
      };
    } catch {
      // error-policy:J3 the handler declared JSON but the bytes are not;
      // fall through to the raw text body rather than fabricating a parsed
      // object the caller would treat as valid.
    }
  }
  return {
    status: captured.statusCode || 200,
    headers: captured.headers,
    body: text,
  };
}

function documentRouteHandler(): (
  ctx: RouteHandlerContext,
) => Promise<RouteHandlerResult> {
  return async (ctx: RouteHandlerContext): Promise<RouteHandlerResult> => {
    const { res: capturedRes, captured } = buildCapturedResponse();
    const baseUrl = `http://${ctx.headers.host ?? "localhost"}`;
    const url = new URL(ctx.path, baseUrl);
    if (ctx.query) {
      for (const [key, val] of Object.entries(ctx.query)) {
        if (Array.isArray(val)) {
          for (const v of val) {
            if (v != null) url.searchParams.append(key, String(v));
          }
        } else if (val != null) {
          url.searchParams.set(key, String(val));
        }
      }
    }

    await handleDocumentsRoutes({
      req: { headers: ctx.headers } as http.IncomingMessage,
      res: capturedRes,
      method: (ctx.method ?? "GET").toUpperCase(),
      pathname: ctx.path,
      url,
      runtime: (ctx.runtime as AgentRuntime) ?? null,
      json,
      error,
      readJsonBody: async <T extends object>(
        req: http.IncomingMessage,
        _res: http.ServerResponse,
        options?: Parameters<typeof httpReadJsonBody>[2],
      ): Promise<T | null> => {
        // Prefer the already-parsed body from the route context; fall back to
        // reading from the raw body buffer if present.
        if (ctx.body !== undefined && ctx.body !== null) {
          return ctx.body as T;
        }
        if (typeof ctx.rawBody === "string" && ctx.rawBody.trim()) {
          try {
            return JSON.parse(ctx.rawBody) as T;
          } catch {
            // error-policy:J3 a malformed raw body resolves to an explicit
            // absent body, which callers already handle, rather than a
            // fake-valid parsed object.
            return null;
          }
        }
        return httpReadJsonBody<T>(req, _res, options);
      },
      accessContext: resolveTrustedLocalDocumentAccessContext(ctx),
    });

    return capturedToResult(captured);
  };
}

const DOCUMENT_ROUTES: Array<{ type: string; path: string }> = [
  { type: "GET", path: "/api/documents" },
  { type: "GET", path: "/api/documents/stats" },
  { type: "POST", path: "/api/documents" },
  { type: "POST", path: "/api/documents/bulk" },
  { type: "POST", path: "/api/documents/url" },
  { type: "GET", path: "/api/documents/search" },
  { type: "GET", path: "/api/documents/:id" },
  { type: "PATCH", path: "/api/documents/:id" },
  { type: "PATCH", path: "/api/documents/:id/access" },
  { type: "GET", path: "/api/documents/:id/access" },
  { type: "GET", path: "/api/documents/:id/pins" },
  { type: "PATCH", path: "/api/documents/:id/pins" },
  { type: "DELETE", path: "/api/documents/:id" },
  { type: "GET", path: "/api/documents/:id/fragments" },
];

export const documentsRoutes: Route[] = DOCUMENT_ROUTES.map(
  (route) =>
    ({
      type: route.type as Route["type"],
      path: route.path,
      rawPath: true as const,
      routeHandler: documentRouteHandler(),
    }) as Route,
);

export const documentsPlugin: Plugin = {
  name: "@elizaos/plugin-documents-routes",
  description: "Document management, fragment listing, and search routes",
  routes: documentsRoutes,
  // OWNER_DOCUMENTS remains host-adapted by plugin-personal-assistant. The
  // registered Knowledge renderer is declared by src/register.ts so the
  // runtime route plugin stays free of React imports.
  actions: [],
};
