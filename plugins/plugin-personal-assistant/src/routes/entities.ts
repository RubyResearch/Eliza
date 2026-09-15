/**
 * REST surface for the EntityStore. Frozen per
 * docs/audit/wave1-interfaces.md §2.4:
 *
 *   GET    /api/lifeops/entities
 *   POST   /api/lifeops/entities
 *   PATCH  /api/lifeops/entities/:id
 *   POST   /api/lifeops/entities/:id/identities
 *   POST   /api/lifeops/entities/merge
 *   GET    /api/lifeops/entities/resolve?q=&platform=&handle=&connectorAccountId=
 */

import { type EntityStore, resolveKnowledgeGraphService } from "@elizaos/agent";
import type { AgentRuntime } from "@elizaos/core";
import type {
  Entity,
  EntityFilter,
  EntityIdentity,
} from "../lifeops/entities/types.js";
import { bindMachineAuthIdentityToEntity } from "./authenticated-entity-principal.js";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";

function defaultAgentId(runtime: AgentRuntime): string {
  return String(runtime.agentId);
}

function makeStore(ctx: LifeOpsRouteContext): EntityStore | null {
  if (!ctx.state.runtime) {
    ctx.error(ctx.res, "Agent runtime is not available", 503);
    return null;
  }
  const knowledgeGraph = resolveKnowledgeGraphService(ctx.state.runtime);
  if (!knowledgeGraph) {
    ctx.error(ctx.res, "Knowledge graph service is not available", 503);
    return null;
  }
  // The authenticated actor authorizes this request; graph records belong to
  // the agent partition shared by chat, principal binding, and family workflows.
  return knowledgeGraph.getEntityStore(defaultAgentId(ctx.state.runtime));
}

function parseEntityLimit(
  raw: string | null,
): { ok: true; limit?: number } | { ok: false; message: string } {
  if (raw === null || raw === "") {
    return { ok: true };
  }
  // Prefix coercion or leading zeros can turn a malformed paging request into
  // an unintended unbounded knowledge-graph response.
  if (!/^[1-9]\d*$/.test(raw)) {
    return { ok: false, message: "limit must be a positive integer" };
  }
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit)) {
    return { ok: false, message: "limit must be a positive integer" };
  }
  return { ok: true, limit };
}

function parseEntityFilter(
  url: URL,
): { ok: true; filter: EntityFilter } | { ok: false; message: string } {
  const filter: EntityFilter = {};
  const type = url.searchParams.get("type");
  if (type) filter.type = type;
  const tag = url.searchParams.get("tag");
  if (tag) filter.tag = tag;
  const nameContains = url.searchParams.get("nameContains");
  if (nameContains) filter.nameContains = nameContains;
  const hasPlatform = url.searchParams.get("hasPlatform");
  if (hasPlatform) filter.hasPlatform = hasPlatform;
  const hasConnectorAccountId = url.searchParams.get("hasConnectorAccountId");
  if (hasConnectorAccountId) {
    filter.hasConnectorAccountId = hasConnectorAccountId;
  }
  const parsedLimit = parseEntityLimit(url.searchParams.get("limit"));
  if (!parsedLimit.ok) {
    return parsedLimit;
  }
  if (parsedLimit.limit !== undefined) {
    filter.limit = parsedLimit.limit;
  }
  return { ok: true, filter };
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

export async function handleEntityRoutes(
  ctx: LifeOpsRouteContext,
): Promise<boolean> {
  const { method, pathname, url, json, readJsonBody, req, res } = ctx;

  if (!pathname.startsWith("/api/lifeops/entities")) {
    return false;
  }

  // GET /api/lifeops/entities/resolve
  if (method === "GET" && pathname === "/api/lifeops/entities/resolve") {
    const store = makeStore(ctx);
    if (!store) return true;
    const q = url.searchParams.get("q") ?? undefined;
    const platform = url.searchParams.get("platform") ?? undefined;
    const handle = url.searchParams.get("handle") ?? undefined;
    const connectorAccountId =
      url.searchParams.get("connectorAccountId") ?? undefined;
    const type = url.searchParams.get("type") ?? undefined;
    const candidates = await store.resolve({
      ...(q ? { name: q } : {}),
      ...(type ? { type } : {}),
      ...(platform && handle
        ? {
            identity: {
              platform,
              handle,
              ...(connectorAccountId ? { connectorAccountId } : {}),
            },
          }
        : {}),
    });
    json(res, { candidates });
    return true;
  }

  // POST /api/lifeops/entities/merge
  if (method === "POST" && pathname === "/api/lifeops/entities/merge") {
    const store = makeStore(ctx);
    if (!store) return true;
    const body = await readJsonBody<{
      targetId?: unknown;
      sourceIds?: unknown;
    }>(req, res);
    if (!body) return true;
    const targetId = asString(body.targetId);
    const sourceIds = asStringArray(body.sourceIds);
    if (!targetId) {
      ctx.error(res, "targetId is required", 400);
      return true;
    }
    const merged = await store.merge(targetId, sourceIds);
    json(res, { entity: merged });
    return true;
  }

  // POST /api/lifeops/entities/:id/identities
  const authBindingMatch = pathname.match(
    /^\/api\/lifeops\/entities\/([^/]+)\/auth-bindings$/,
  );
  if (method === "POST" && authBindingMatch) {
    const entityId = ctx.decodePathComponent(
      authBindingMatch[1] ?? "",
      res,
      "entity id",
    );
    if (!entityId) return true;
    const body = await readJsonBody<{ authIdentityId?: unknown }>(req, res);
    if (!body) return true;
    if (
      typeof body.authIdentityId !== "string" ||
      !body.authIdentityId.trim()
    ) {
      ctx.error(res, "authIdentityId is required", 400);
      return true;
    }
    try {
      json(
        res,
        {
          binding: await bindMachineAuthIdentityToEntity({
            runtime: ctx.state.runtime as AgentRuntime,
            entityId,
            authIdentityId: body.authIdentityId.trim(),
          }),
        },
        201,
      );
    } catch (error) {
      // error-policy:J1 translate the typed owner binding failure at the HTTP
      // boundary; no auth or Entity mutation is reported as successful.
      ctx.error(
        res,
        error instanceof Error ? error.message : "Auth binding failed",
        409,
      );
    }
    return true;
  }

  // POST /api/lifeops/entities/:id/identities
  const identitiesMatch = pathname.match(
    /^\/api\/lifeops\/entities\/([^/]+)\/identities$/,
  );
  if (method === "POST" && identitiesMatch) {
    const entityId = ctx.decodePathComponent(
      identitiesMatch[1] ?? "",
      res,
      "entity id",
    );
    if (entityId === null) return true;
    if (!entityId) {
      ctx.error(res, "entity id required", 400);
      return true;
    }
    const store = makeStore(ctx);
    if (!store) return true;
    const body = await readJsonBody<{
      platform?: unknown;
      handle?: unknown;
      connectorAccountId?: unknown;
      displayName?: unknown;
      evidence?: unknown;
      confidence?: unknown;
      suggestedType?: unknown;
    }>(req, res);
    if (!body) return true;
    const platform = asString(body.platform);
    const handle = asString(body.handle);
    if (!platform || !handle) {
      ctx.error(res, "platform and handle are required", 400);
      return true;
    }
    const result = await store.observeIdentity({
      platform,
      handle,
      ...(typeof body.connectorAccountId === "string"
        ? { connectorAccountId: body.connectorAccountId }
        : {}),
      ...(typeof body.displayName === "string"
        ? { displayName: body.displayName }
        : {}),
      evidence: asStringArray(body.evidence),
      confidence: asNumber(body.confidence, 0.5),
      ...(typeof body.suggestedType === "string"
        ? { suggestedType: body.suggestedType }
        : {}),
    });
    json(res, result);
    return true;
  }

  // PATCH /api/lifeops/entities/:id
  const patchMatch = pathname.match(/^\/api\/lifeops\/entities\/([^/]+)$/);
  if (method === "PATCH" && patchMatch) {
    const entityId = ctx.decodePathComponent(
      patchMatch[1] ?? "",
      res,
      "entity id",
    );
    if (entityId === null) return true;
    if (!entityId) {
      ctx.error(res, "entity id required", 400);
      return true;
    }
    const store = makeStore(ctx);
    if (!store) return true;
    const existing = await store.get(entityId);
    if (!existing) {
      ctx.error(res, "entity not found", 404);
      return true;
    }
    const body = await readJsonBody<Partial<Entity>>(req, res);
    if (!body) return true;
    const merged: Omit<Entity, "createdAt" | "updatedAt"> = {
      ...existing,
      ...(body.type ? { type: body.type } : {}),
      ...(body.preferredName ? { preferredName: body.preferredName } : {}),
      ...(body.fullName ? { fullName: body.fullName } : {}),
      ...(body.tags ? { tags: body.tags } : {}),
      ...(body.visibility ? { visibility: body.visibility } : {}),
      ...(body.identities ? { identities: body.identities } : {}),
      ...(body.attributes ? { attributes: body.attributes } : {}),
      ...(body.state ? { state: { ...existing.state, ...body.state } } : {}),
    };
    const updated = await store.upsert(merged);
    json(res, { entity: updated });
    return true;
  }

  // GET /api/lifeops/entities/:id
  const getOneMatch = pathname.match(/^\/api\/lifeops\/entities\/([^/]+)$/);
  if (method === "GET" && getOneMatch) {
    const entityId = ctx.decodePathComponent(
      getOneMatch[1] ?? "",
      res,
      "entity id",
    );
    if (entityId === null) return true;
    if (!entityId) {
      ctx.error(res, "entity id required", 400);
      return true;
    }
    const store = makeStore(ctx);
    if (!store) return true;
    const entity = await store.get(entityId);
    if (!entity) {
      ctx.error(res, "entity not found", 404);
      return true;
    }
    json(res, { entity });
    return true;
  }

  // POST /api/lifeops/entities (upsert)
  if (method === "POST" && pathname === "/api/lifeops/entities") {
    const store = makeStore(ctx);
    if (!store) return true;
    const body = await readJsonBody<{
      entityId?: string;
      type?: string;
      preferredName?: string;
      fullName?: string;
      identities?: EntityIdentity[];
      tags?: string[];
      visibility?: Entity["visibility"];
      attributes?: Entity["attributes"];
      state?: Entity["state"];
    }>(req, res);
    if (!body) return true;
    if (!body.type || !body.preferredName) {
      ctx.error(res, "type and preferredName are required", 400);
      return true;
    }
    const entity = await store.upsert({
      ...(body.entityId ? { entityId: body.entityId } : {}),
      type: body.type,
      preferredName: body.preferredName,
      ...(body.fullName ? { fullName: body.fullName } : {}),
      identities: body.identities ?? [],
      tags: body.tags ?? [],
      visibility: body.visibility ?? "owner_agent_admin",
      ...(body.attributes ? { attributes: body.attributes } : {}),
      state: body.state ?? {},
    });
    json(res, { entity });
    return true;
  }

  // GET /api/lifeops/entities (list)
  if (method === "GET" && pathname === "/api/lifeops/entities") {
    const store = makeStore(ctx);
    if (!store) return true;
    const parsed = parseEntityFilter(url);
    if (!parsed.ok) {
      ctx.error(res, parsed.message, 400);
      return true;
    }
    const entities = await store.list(parsed.filter);
    json(res, { entities });
    return true;
  }

  return false;
}
