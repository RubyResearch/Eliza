/**
 * REST surface for the RelationshipStore. Frozen per
 * docs/audit/wave1-interfaces.md §2.4:
 *
 *   GET    /api/lifeops/relationships
 *   POST   /api/lifeops/relationships
 *   PATCH  /api/lifeops/relationships/:id
 *   POST   /api/lifeops/relationships/observe
 *   POST   /api/lifeops/relationships/:id/retire
 */

import {
  type RelationshipStore,
  resolveKnowledgeGraphService,
} from "@elizaos/agent";
import type { AgentRuntime } from "@elizaos/core";
import type {
  Relationship,
  RelationshipFilter,
  RelationshipSource,
} from "../lifeops/relationships/types.js";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";

function defaultAgentId(runtime: AgentRuntime): string {
  return String(runtime.agentId);
}

function makeStore(ctx: LifeOpsRouteContext): RelationshipStore | null {
  if (!ctx.state.runtime) {
    ctx.error(ctx.res, "Agent runtime is not available", 503);
    return null;
  }
  const knowledgeGraph = resolveKnowledgeGraphService(ctx.state.runtime);
  if (!knowledgeGraph) {
    ctx.error(ctx.res, "Knowledge graph service is not available", 503);
    return null;
  }
  // Edges share the agent partition of their entities and household consumers.
  return knowledgeGraph.getRelationshipStore(defaultAgentId(ctx.state.runtime));
}

function parseRelationshipFilter(url: URL): RelationshipFilter {
  const filter: RelationshipFilter = {};
  const from =
    url.searchParams.get("from") ?? url.searchParams.get("fromEntityId");
  if (from) filter.fromEntityId = from;
  const to = url.searchParams.get("to") ?? url.searchParams.get("toEntityId");
  if (to) filter.toEntityId = to;
  const type = url.searchParams.get("type");
  if (type) {
    filter.type = type.includes(",")
      ? type.split(",").map((s) => s.trim())
      : type;
  }
  const cadenceOverdueAsOf = url.searchParams.get("cadenceOverdueAsOf");
  if (cadenceOverdueAsOf) filter.cadenceOverdueAsOf = cadenceOverdueAsOf;
  const includeRetired = url.searchParams.get("includeRetired");
  if (includeRetired === "true" || includeRetired === "1") {
    filter.includeRetired = true;
  }
  const limit = url.searchParams.get("limit");
  if (limit && /^\d+$/.test(limit)) {
    filter.limit = Number.parseInt(limit, 10);
  }
  return filter;
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

export async function handleRelationshipRoutes(
  ctx: LifeOpsRouteContext,
): Promise<boolean> {
  const { method, pathname, url, json, readJsonBody, req, res } = ctx;

  if (!pathname.startsWith("/api/lifeops/relationships")) {
    return false;
  }

  // POST /api/lifeops/relationships/observe
  if (method === "POST" && pathname === "/api/lifeops/relationships/observe") {
    const store = makeStore(ctx);
    if (!store) return true;
    const body = await readJsonBody<{
      fromEntityId?: unknown;
      toEntityId?: unknown;
      type?: unknown;
      metadataPatch?: unknown;
      evidence?: unknown;
      confidence?: unknown;
      occurredAt?: unknown;
      source?: unknown;
    }>(req, res);
    if (!body) return true;
    const fromEntityId = asString(body.fromEntityId);
    const toEntityId = asString(body.toEntityId);
    const type = asString(body.type);
    if (!fromEntityId || !toEntityId || !type) {
      ctx.error(res, "fromEntityId, toEntityId, and type are required", 400);
      return true;
    }
    const result = await store.observe({
      fromEntityId,
      toEntityId,
      type,
      ...(body.metadataPatch && typeof body.metadataPatch === "object"
        ? { metadataPatch: body.metadataPatch as Record<string, unknown> }
        : {}),
      evidence: asStringArray(body.evidence),
      confidence: asNumber(body.confidence, 0.5),
      ...(typeof body.occurredAt === "string"
        ? { occurredAt: body.occurredAt }
        : {}),
      ...(typeof body.source === "string"
        ? { source: body.source as RelationshipSource }
        : {}),
    });
    json(res, { relationship: result });
    return true;
  }

  // POST /api/lifeops/relationships/:id/retire
  const retireMatch = pathname.match(
    /^\/api\/lifeops\/relationships\/([^/]+)\/retire$/,
  );
  if (method === "POST" && retireMatch) {
    const relationshipId = ctx.decodePathComponent(
      retireMatch[1] ?? "",
      res,
      "relationship id",
    );
    if (relationshipId === null) return true;
    if (!relationshipId) {
      ctx.error(res, "relationship id required", 400);
      return true;
    }
    const store = makeStore(ctx);
    if (!store) return true;
    const body = await readJsonBody<{ reason?: unknown }>(req, res);
    if (!body) return true;
    await store.retire(relationshipId, asString(body.reason, "manual_retire"));
    json(res, { ok: true });
    return true;
  }

  // PATCH /api/lifeops/relationships/:id
  const patchMatch = pathname.match(/^\/api\/lifeops\/relationships\/([^/]+)$/);
  if (method === "PATCH" && patchMatch) {
    const relationshipId = ctx.decodePathComponent(
      patchMatch[1] ?? "",
      res,
      "relationship id",
    );
    if (relationshipId === null) return true;
    if (!relationshipId) {
      ctx.error(res, "relationship id required", 400);
      return true;
    }
    const store = makeStore(ctx);
    if (!store) return true;
    const existing = await store.get(relationshipId);
    if (!existing) {
      ctx.error(res, "relationship not found", 404);
      return true;
    }
    const body = await readJsonBody<Partial<Relationship>>(req, res);
    if (!body) return true;
    const updated = await store.upsert({
      ...existing,
      relationshipId: existing.relationshipId,
      ...(body.fromEntityId ? { fromEntityId: body.fromEntityId } : {}),
      ...(body.toEntityId ? { toEntityId: body.toEntityId } : {}),
      ...(body.type ? { type: body.type } : {}),
      ...(body.metadata
        ? { metadata: { ...(existing.metadata ?? {}), ...body.metadata } }
        : {}),
      ...(body.state ? { state: { ...existing.state, ...body.state } } : {}),
      ...(body.evidence ? { evidence: body.evidence } : {}),
      ...(typeof body.confidence === "number"
        ? { confidence: body.confidence }
        : {}),
      ...(body.source ? { source: body.source } : {}),
    });
    json(res, { relationship: updated });
    return true;
  }

  // GET /api/lifeops/relationships/:id
  const getOneMatch = pathname.match(
    /^\/api\/lifeops\/relationships\/([^/]+)$/,
  );
  if (method === "GET" && getOneMatch) {
    const relationshipId = ctx.decodePathComponent(
      getOneMatch[1] ?? "",
      res,
      "relationship id",
    );
    if (relationshipId === null) return true;
    if (!relationshipId) {
      ctx.error(res, "relationship id required", 400);
      return true;
    }
    const store = makeStore(ctx);
    if (!store) return true;
    const relationship = await store.get(relationshipId);
    if (!relationship) {
      ctx.error(res, "relationship not found", 404);
      return true;
    }
    json(res, { relationship });
    return true;
  }

  // POST /api/lifeops/relationships (upsert)
  if (method === "POST" && pathname === "/api/lifeops/relationships") {
    const store = makeStore(ctx);
    if (!store) return true;
    const body = await readJsonBody<{
      relationshipId?: string;
      fromEntityId?: string;
      toEntityId?: string;
      type?: string;
      metadata?: Record<string, unknown>;
      state?: Relationship["state"];
      evidence?: string[];
      confidence?: number;
      source?: RelationshipSource;
    }>(req, res);
    if (!body) return true;
    if (!body.fromEntityId || !body.toEntityId || !body.type) {
      ctx.error(res, "fromEntityId, toEntityId, and type are required", 400);
      return true;
    }
    const relationship = await store.upsert({
      ...(body.relationshipId ? { relationshipId: body.relationshipId } : {}),
      fromEntityId: body.fromEntityId,
      toEntityId: body.toEntityId,
      type: body.type,
      ...(body.metadata ? { metadata: body.metadata } : { metadata: {} }),
      state: body.state ?? {},
      evidence: body.evidence ?? [],
      confidence: typeof body.confidence === "number" ? body.confidence : 0.5,
      source: body.source ?? "user_chat",
    });
    json(res, { relationship });
    return true;
  }

  // GET /api/lifeops/relationships (list)
  if (method === "GET" && pathname === "/api/lifeops/relationships") {
    const store = makeStore(ctx);
    if (!store) return true;
    const filter = parseRelationshipFilter(url);
    const relationships = await store.list(filter);
    json(res, { relationships });
    return true;
  }

  return false;
}
