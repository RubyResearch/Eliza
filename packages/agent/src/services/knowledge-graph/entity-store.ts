/**
 * EntityStore — persistence + business-logic surface for the runtime
 * knowledge-graph node primitive.
 *
 * Backed by `app_lifeops.life_entities` + `life_entity_identities` +
 * `life_entity_attributes`. The store is per-agent (multi-tenant by
 * agentId); the special `entityId === "self"` row is bootstrapped on first
 * use.
 */

import crypto from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import {
  AUTO_MERGE_CONFIDENCE_THRESHOLD,
  decideIdentityOutcome,
  type Entity,
  type EntityAttribute,
  type EntityFilter,
  type EntityIdentity,
  type EntityIdentityAddedVia,
  type EntityResolveCandidate,
  type EntityState,
  type EntityVisibility,
  findIdentityMatches,
  foldIdentity,
  mergeEntities,
  normalizeEntityConnectorAccountId,
  SELF_ENTITY_ID,
} from "@elizaos/shared";
import {
  type ConfirmEmailRecipientInput,
  type ConfirmedEmailRecipient,
  confirmEmailRecipient,
} from "./confirmed-email-recipient.ts";
import {
  executeRawSql,
  parseJsonArray,
  parseJsonValue,
  sqlInteger,
  sqlJson,
  sqlNumber,
  sqlQuote,
  sqlText,
  toBoolean,
  toNumber,
  toText,
} from "./sql.ts";

function isoNow(): string {
  return new Date().toISOString();
}

function entityRowToEntity(args: {
  row: Record<string, unknown>;
  identities: EntityIdentity[];
  attributes: Record<string, EntityAttribute>;
}): Entity {
  const { row, identities, attributes } = args;
  const state: EntityState = {};
  if (row.state_last_observed_at) {
    state.lastObservedAt = toText(row.state_last_observed_at);
  }
  if (row.state_last_inbound_at) {
    state.lastInboundAt = toText(row.state_last_inbound_at);
  }
  if (row.state_last_outbound_at) {
    state.lastOutboundAt = toText(row.state_last_outbound_at);
  }
  if (row.state_last_interaction_platform) {
    state.lastInteractionPlatform = toText(row.state_last_interaction_platform);
  }

  const fullName = row.full_name ? toText(row.full_name) : undefined;

  return {
    entityId: toText(row.entity_id),
    type: toText(row.type),
    preferredName: toText(row.preferred_name),
    ...(fullName ? { fullName } : {}),
    identities,
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    state,
    tags: parseJsonArray<string>(row.tags_json),
    visibility: toText(row.visibility, "owner_agent_admin") as EntityVisibility,
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function identityRowToIdentity(row: Record<string, unknown>): EntityIdentity {
  const evidence = parseJsonArray<string>(row.evidence_json);
  const displayName = row.display_name ? toText(row.display_name) : undefined;
  return {
    platform: toText(row.platform),
    handle: toText(row.handle),
    connectorAccountId: normalizeEntityConnectorAccountId(
      toText(row.connector_account_id),
    ),
    ...(displayName ? { displayName } : {}),
    verified: toBoolean(row.verified),
    confidence: toNumber(row.confidence, 0),
    addedAt: toText(row.added_at),
    addedVia: toText(
      row.added_via,
      "platform_observation",
    ) as EntityIdentityAddedVia,
    evidence,
  };
}

function attributeRowToAttribute(row: Record<string, unknown>): {
  key: string;
  attribute: EntityAttribute;
} {
  return {
    key: toText(row.key),
    attribute: {
      value: parseJsonValue<unknown>(row.value_json, null),
      confidence: toNumber(row.confidence, 0),
      evidence: parseJsonArray<string>(row.evidence_json),
      updatedAt: toText(row.updated_at),
    },
  };
}

export class EntityStore {
  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly agentId: string,
  ) {}

  confirmEmailRecipient(
    input: ConfirmEmailRecipientInput,
  ): Promise<ConfirmedEmailRecipient> {
    return confirmEmailRecipient(this.runtime, this.agentId, input);
  }

  /**
   * Bootstrap the special `self` entity if it does not exist. Idempotent.
   * Called on first store init for an agent.
   */
  async ensureSelf(): Promise<Entity> {
    const existing = await this.get(SELF_ENTITY_ID);
    if (existing) return existing;
    return this.upsertInternal({
      entityId: SELF_ENTITY_ID,
      type: "person",
      preferredName: "self",
      identities: [],
      tags: [],
      visibility: "owner_only",
      state: {},
    });
  }

  async upsert(
    input: Omit<Entity, "entityId" | "createdAt" | "updatedAt"> & {
      entityId?: string;
    },
  ): Promise<Entity> {
    return this.upsertInternal(input);
  }

  private async upsertInternal(
    input: Omit<Entity, "entityId" | "createdAt" | "updatedAt"> & {
      entityId?: string;
    },
  ): Promise<Entity> {
    const now = isoNow();
    const entityId = input.entityId ?? `ent_${crypto.randomUUID()}`;
    const existing = await this.get(entityId);
    const createdAt = existing?.createdAt ?? now;

    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_entities (
         entity_id, agent_id, type, preferred_name, full_name, tags_json,
         visibility, state_last_observed_at, state_last_inbound_at,
         state_last_outbound_at, state_last_interaction_platform,
         created_at, updated_at
       ) VALUES (
         ${sqlQuote(entityId)},
         ${sqlQuote(this.agentId)},
         ${sqlQuote(input.type)},
         ${sqlQuote(input.preferredName)},
         ${sqlText(input.fullName ?? null)},
         ${sqlJson(input.tags)},
         ${sqlQuote(input.visibility)},
         ${sqlText(input.state.lastObservedAt ?? null)},
         ${sqlText(input.state.lastInboundAt ?? null)},
         ${sqlText(input.state.lastOutboundAt ?? null)},
         ${sqlText(input.state.lastInteractionPlatform ?? null)},
         ${sqlQuote(createdAt)},
         ${sqlQuote(now)}
       )
       ON CONFLICT (agent_id, entity_id) DO UPDATE SET
         type = EXCLUDED.type,
         preferred_name = EXCLUDED.preferred_name,
         full_name = EXCLUDED.full_name,
         tags_json = EXCLUDED.tags_json,
         visibility = EXCLUDED.visibility,
         state_last_observed_at = EXCLUDED.state_last_observed_at,
         state_last_inbound_at = EXCLUDED.state_last_inbound_at,
         state_last_outbound_at = EXCLUDED.state_last_outbound_at,
         state_last_interaction_platform = EXCLUDED.state_last_interaction_platform,
         updated_at = EXCLUDED.updated_at`,
    );

    // Replace identity rows wholesale — caller passes the canonical list.
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_lifeops.life_entity_identities
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND entity_id = ${sqlQuote(entityId)}`,
    );
    for (const identity of input.identities) {
      await this.persistIdentity(entityId, identity);
    }

    // Replace attribute rows wholesale.
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_lifeops.life_entity_attributes
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND entity_id = ${sqlQuote(entityId)}`,
    );
    for (const [key, attr] of Object.entries(input.attributes ?? {})) {
      await this.persistAttribute(entityId, key, attr);
    }

    const fetched = await this.get(entityId);
    if (!fetched) {
      throw new Error(
        `[EntityStore] failed to read back upserted entity ${entityId}`,
      );
    }
    return fetched;
  }

  private async persistIdentity(
    entityId: string,
    identity: EntityIdentity,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_entity_identities (
         id, agent_id, entity_id, platform, handle, connector_account_id, display_name,
         verified, confidence, added_at, added_via, evidence_json
       ) VALUES (
         ${sqlQuote(`eid_${crypto.randomUUID()}`)},
         ${sqlQuote(this.agentId)},
         ${sqlQuote(entityId)},
         ${sqlQuote(identity.platform)},
         ${sqlQuote(identity.handle)},
         ${sqlQuote(
           normalizeEntityConnectorAccountId(identity.connectorAccountId),
         )},
         ${sqlText(identity.displayName ?? null)},
         ${identity.verified ? "TRUE" : "FALSE"},
         ${sqlNumber(identity.confidence)},
         ${sqlQuote(identity.addedAt)},
         ${sqlQuote(identity.addedVia)},
         ${sqlJson(identity.evidence)}
       )
       ON CONFLICT (
         agent_id, entity_id, platform, connector_account_id, handle
       ) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         verified = EXCLUDED.verified,
         confidence = EXCLUDED.confidence,
         added_via = EXCLUDED.added_via,
         evidence_json = EXCLUDED.evidence_json`,
    );
  }

  private async persistAttribute(
    entityId: string,
    key: string,
    attribute: EntityAttribute,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_entity_attributes (
         id, agent_id, entity_id, key, value_json, confidence,
         evidence_json, updated_at
       ) VALUES (
         ${sqlQuote(`ea_${crypto.randomUUID()}`)},
         ${sqlQuote(this.agentId)},
         ${sqlQuote(entityId)},
         ${sqlQuote(key)},
         ${sqlJson(attribute.value)},
         ${sqlNumber(attribute.confidence)},
         ${sqlJson(attribute.evidence)},
         ${sqlQuote(attribute.updatedAt)}
       )
       ON CONFLICT (agent_id, entity_id, key) DO UPDATE SET
         value_json = EXCLUDED.value_json,
         confidence = EXCLUDED.confidence,
         evidence_json = EXCLUDED.evidence_json,
         updated_at = EXCLUDED.updated_at`,
    );
  }

  async get(entityId: string): Promise<Entity | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_entities
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND entity_id = ${sqlQuote(entityId)}
        LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;
    const identities = await this.loadIdentities([entityId]);
    const attributes = await this.loadAttributes([entityId]);
    return entityRowToEntity({
      row,
      identities: identities.get(entityId) ?? [],
      attributes: attributes.get(entityId) ?? {},
    });
  }

  async list(filter?: EntityFilter): Promise<Entity[]> {
    const clauses = [`e.agent_id = ${sqlQuote(this.agentId)}`];
    if (filter?.type) {
      clauses.push(`e.type = ${sqlQuote(filter.type)}`);
    }
    if (filter?.tag) {
      // tags_json is a JSON array — use LIKE on the serialized form for
      // portability across PG / PGLite. The string form `"<tag>"` is
      // safe because tags are validated as plain strings on write.
      clauses.push(`e.tags_json LIKE ${sqlQuote(`%"${filter.tag}"%`)}`);
    }
    if (filter?.nameContains) {
      const needle = sqlQuote(`%${filter.nameContains.toLowerCase()}%`);
      clauses.push(
        `(LOWER(e.preferred_name) LIKE ${needle} OR LOWER(COALESCE(e.full_name, '')) LIKE ${needle})`,
      );
    }
    if (filter?.hasPlatform || filter?.hasConnectorAccountId) {
      const identityClauses = [
        "i.agent_id = e.agent_id",
        "i.entity_id = e.entity_id",
      ];
      if (filter.hasPlatform) {
        identityClauses.push(
          `LOWER(i.platform) = ${sqlQuote(filter.hasPlatform.toLowerCase())}`,
        );
      }
      if (filter.hasConnectorAccountId) {
        identityClauses.push(
          `i.connector_account_id = ${sqlQuote(
            normalizeEntityConnectorAccountId(filter.hasConnectorAccountId),
          )}`,
        );
      }
      clauses.push(
        `EXISTS (SELECT 1 FROM app_lifeops.life_entity_identities i
                  WHERE ${identityClauses.join("\n                    AND ")})`,
      );
    }

    const limitClause =
      typeof filter?.limit === "number" && Number.isFinite(filter.limit)
        ? `LIMIT ${sqlInteger(filter.limit)}`
        : "";

    const rows = await executeRawSql(
      this.runtime,
      `SELECT e.* FROM app_lifeops.life_entities e
        WHERE ${clauses.join(" AND ")}
        ORDER BY e.preferred_name ASC
        ${limitClause}`,
    );
    if (rows.length === 0) return [];

    const ids = rows.map((row) => toText(row.entity_id));
    const identities = await this.loadIdentities(ids);
    const attributes = await this.loadAttributes(ids);

    return rows.map((row) => {
      const id = toText(row.entity_id);
      return entityRowToEntity({
        row,
        identities: identities.get(id) ?? [],
        attributes: attributes.get(id) ?? {},
      });
    });
  }

  private async loadIdentities(
    entityIds: string[],
  ): Promise<Map<string, EntityIdentity[]>> {
    if (entityIds.length === 0) return new Map();
    const idList = entityIds.map((id) => sqlQuote(id)).join(", ");
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_entity_identities
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND entity_id IN (${idList})
        ORDER BY added_at ASC`,
    );
    const grouped = new Map<string, EntityIdentity[]>();
    for (const row of rows) {
      const id = toText(row.entity_id);
      const list = grouped.get(id) ?? [];
      list.push(identityRowToIdentity(row));
      grouped.set(id, list);
    }
    return grouped;
  }

  private async loadAttributes(
    entityIds: string[],
  ): Promise<Map<string, Record<string, EntityAttribute>>> {
    if (entityIds.length === 0) return new Map();
    const idList = entityIds.map((id) => sqlQuote(id)).join(", ");
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_entity_attributes
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND entity_id IN (${idList})`,
    );
    const grouped = new Map<string, Record<string, EntityAttribute>>();
    for (const row of rows) {
      const id = toText(row.entity_id);
      const bag = grouped.get(id) ?? {};
      const { key, attribute } = attributeRowToAttribute(row);
      bag[key] = attribute;
      grouped.set(id, bag);
    }
    return grouped;
  }

  /**
   * Observe a `(platform, connector account, handle)` claim. Decision tree:
   *   - no candidate: create a new entity with this identity.
   *   - exactly one candidate AND confidence >= AUTO_MERGE: fold in.
   *   - exactly one candidate, low confidence: create a conflict outcome.
   *   - multiple candidates: create a conflict outcome.
   *
   * Returns the resulting entity (the existing one in merge cases, the
   * newly-created one in create cases). For conflicts, the FIRST candidate
   * is returned and `mergedFrom` lists the conflicting candidate ids; the
   * caller surfaces the conflict via the ScheduledTask approval queue.
   */
  async observeIdentity(obs: {
    platform: string;
    handle: string;
    connectorAccountId?: string;
    displayName?: string;
    evidence: string[];
    confidence: number;
    suggestedType?: string;
  }): Promise<{ entity: Entity; mergedFrom?: string[]; conflict?: boolean }> {
    const connectorAccountId = normalizeEntityConnectorAccountId(
      obs.connectorAccountId,
    );
    const all = await this.list();
    const candidates = findIdentityMatches(all, {
      platform: obs.platform,
      handle: obs.handle,
      connectorAccountId,
      confidence: obs.confidence,
    });
    const outcome = decideIdentityOutcome({
      candidates,
      newConfidence: obs.confidence,
    });

    const now = isoNow();
    const newIdentity: EntityIdentity = {
      platform: obs.platform,
      handle: obs.handle,
      connectorAccountId,
      ...(obs.displayName ? { displayName: obs.displayName } : {}),
      verified: false,
      confidence: obs.confidence,
      addedAt: now,
      addedVia: "platform_observation",
      evidence: [...obs.evidence],
    };

    if (outcome.kind === "create") {
      const entity = await this.upsertInternal({
        type: obs.suggestedType ?? "person",
        preferredName: obs.displayName ?? obs.handle,
        identities: [newIdentity],
        tags: [],
        visibility: "owner_agent_admin",
        state: { lastObservedAt: now },
      });
      return { entity };
    }

    if (outcome.kind === "merge") {
      const target = candidates.find(
        (c) => c.entityId === outcome.targetEntityId,
      );
      if (!target) {
        throw new Error("[EntityStore] merge target disappeared mid-observe");
      }
      const folded = foldIdentity(target.identities, newIdentity);
      const updated = await this.upsertInternal({
        ...target,
        identities: folded,
        state: { ...target.state, lastObservedAt: now },
      });
      return { entity: updated, mergedFrom: [target.entityId] };
    }

    // conflict: store on the highest-confidence existing match (first
    // one — list is name-ordered, but for this purpose the runtime treats
    // any candidate as the "best guess" and the approval task surfaces
    // the rest). We do NOT auto-merge.
    const first = candidates[0];
    if (!first) {
      throw new Error("[EntityStore] conflict outcome with no candidates");
    }
    return {
      entity: first,
      mergedFrom: outcome.candidateEntityIds,
      conflict: true,
    };
  }

  /**
   * Resolve an entity by name, identity, or type. Returns ranked candidates
   * (highest confidence first). `safeToSend` is `true` when the entity has
   * at least one verified identity on a sendable platform.
   */
  async resolve(query: {
    name?: string;
    identity?: {
      platform: string;
      handle: string;
      connectorAccountId?: string;
    };
    type?: string;
  }): Promise<EntityResolveCandidate[]> {
    const filters: EntityFilter = {};
    if (query.type) filters.type = query.type;
    if (query.name) filters.nameContains = query.name;
    if (query.identity) {
      filters.hasPlatform = query.identity.platform;
      filters.hasConnectorAccountId = normalizeEntityConnectorAccountId(
        query.identity.connectorAccountId,
      );
    }

    let entities = await this.list(filters);

    if (query.identity) {
      const platformKey = query.identity.platform.toLowerCase();
      const handleKey = query.identity.handle.toLowerCase();
      const accountKey = normalizeEntityConnectorAccountId(
        query.identity.connectorAccountId,
      );
      entities = entities.filter((entity) =>
        entity.identities.some(
          (identity) =>
            identity.platform.toLowerCase() === platformKey &&
            normalizeEntityConnectorAccountId(identity.connectorAccountId) ===
              accountKey &&
            identity.handle.toLowerCase() === handleKey,
        ),
      );
    }

    return entities
      .map((entity): EntityResolveCandidate => {
        const evidence: string[] = [];
        let confidence = 0;
        let safeToSend = false;
        if (query.identity) {
          const match = entity.identities.find(
            (identity) =>
              identity.platform.toLowerCase() ===
                query.identity?.platform.toLowerCase() &&
              normalizeEntityConnectorAccountId(identity.connectorAccountId) ===
                normalizeEntityConnectorAccountId(
                  query.identity.connectorAccountId,
                ) &&
              identity.handle.toLowerCase() ===
                query.identity.handle.toLowerCase(),
          );
          if (match) {
            confidence = match.confidence;
            evidence.push(...match.evidence);
            safeToSend = match.verified;
          }
        }
        if (query.name && entity.preferredName) {
          const exact =
            entity.preferredName.toLowerCase() === query.name.toLowerCase();
          confidence = Math.max(confidence, exact ? 0.9 : 0.55);
        }
        if (
          !query.identity &&
          entity.identities.some((identity) => identity.verified)
        ) {
          safeToSend = true;
        }
        return { entity, confidence, evidence, safeToSend };
      })
      .sort((a, b) => {
        const aConf = Number.isFinite(a.confidence) ? a.confidence : 0;
        const bConf = Number.isFinite(b.confidence) ? b.confidence : 0;
        return bConf - aConf;
      });
  }

  /**
   * Record an interaction against an entity. Updates `state.lastInboundAt`
   * or `lastOutboundAt`, plus `lastObservedAt` and
   * `lastInteractionPlatform`. Caller is responsible for also calling
   * `RelationshipStore.observe` to strengthen the per-edge state where
   * applicable.
   */
  async recordInteraction(
    entityId: string,
    interaction: {
      platform: string;
      direction: "inbound" | "outbound";
      summary: string;
      occurredAt: string;
    },
  ): Promise<void> {
    const directionColumn =
      interaction.direction === "inbound"
        ? "state_last_inbound_at"
        : "state_last_outbound_at";

    await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_entities
          SET ${directionColumn} = ${sqlQuote(interaction.occurredAt)},
              state_last_observed_at = ${sqlQuote(interaction.occurredAt)},
              state_last_interaction_platform = ${sqlQuote(interaction.platform)},
              updated_at = ${sqlQuote(isoNow())}
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND entity_id = ${sqlQuote(entityId)}`,
    );
    // Summary is an audit trail concern. The repo relationship-interactions
    // table provides per-edge history; for entity-only recordings the
    // observation-id list captured on the next identity / relationship
    // observe call is the canonical home. We keep this method narrow
    // rather than duplicating audit logging.
  }

  /**
   * Explicit merge: fold N source entities into a target. Identities,
   * attributes, and tags survive. Source rows are deleted. Returns the
   * merged target.
   */
  async merge(targetId: string, sourceIds: string[]): Promise<Entity> {
    if (sourceIds.length === 0) {
      const existing = await this.get(targetId);
      if (!existing) {
        throw new Error(`[EntityStore.merge] target ${targetId} not found`);
      }
      return existing;
    }
    const target = await this.get(targetId);
    if (!target) {
      throw new Error(`[EntityStore.merge] target ${targetId} not found`);
    }
    const sources: Entity[] = [];
    for (const id of sourceIds) {
      if (id === targetId) continue;
      const source = await this.get(id);
      if (source) sources.push(source);
    }
    const now = isoNow();
    const merged = mergeEntities({ target, sources, now });
    const persisted = await this.upsertInternal({
      ...merged,
      identities: merged.identities,
    });

    // Rewrite any relationships that reference sources to point at target,
    // then delete the source rows. The relationships rewrite is part of
    // the merge contract; do it before source deletion so audit events
    // can still resolve.
    for (const source of sources) {
      const rewriteSql = (column: string) =>
        `UPDATE app_lifeops.life_relationships_v2
            SET ${column} = ${sqlQuote(targetId)},
                updated_at = ${sqlQuote(now)}
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND ${column} = ${sqlQuote(source.entityId)}`;
      await executeRawSql(this.runtime, rewriteSql("from_entity_id"));
      await executeRawSql(this.runtime, rewriteSql("to_entity_id"));
      await executeRawSql(
        this.runtime,
        `DELETE FROM app_lifeops.life_entity_identities
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND entity_id = ${sqlQuote(source.entityId)}`,
      );
      await executeRawSql(
        this.runtime,
        `DELETE FROM app_lifeops.life_entity_attributes
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND entity_id = ${sqlQuote(source.entityId)}`,
      );
      await executeRawSql(
        this.runtime,
        `DELETE FROM app_lifeops.life_entities
          WHERE agent_id = ${sqlQuote(this.agentId)}
            AND entity_id = ${sqlQuote(source.entityId)}`,
      );
    }

    return persisted;
  }

  /**
   * Test-only helper for removing an entity. Production callers should use
   * `merge` to consolidate or simply leave entities in place.
   */
  async deleteForTest(entityId: string): Promise<void> {
    if (entityId === SELF_ENTITY_ID) {
      throw new Error("[EntityStore] cannot delete self entity");
    }
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_lifeops.life_entity_identities
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND entity_id = ${sqlQuote(entityId)}`,
    );
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_lifeops.life_entity_attributes
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND entity_id = ${sqlQuote(entityId)}`,
    );
    await executeRawSql(
      this.runtime,
      `DELETE FROM app_lifeops.life_entities
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND entity_id = ${sqlQuote(entityId)}`,
    );
  }
}

export { AUTO_MERGE_CONFIDENCE_THRESHOLD };
