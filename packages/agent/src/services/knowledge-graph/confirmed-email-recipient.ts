/**
 * Atomically records an owner-confirmed delivery address in the canonical graph.
 * This operation preserves unrelated identities and never creates guest access.
 * Identity-table locks cover the ambiguity check and insert because historical
 * graph writers do not share an address-level uniqueness constraint.
 */
import { createHash, randomUUID } from "node:crypto";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import {
  executeSql,
  type RuntimeDb,
  sqlQuote,
  toText,
} from "@elizaos/shared/db/raw-sql";
import { z } from "zod";

export interface ConfirmEmailRecipientInput {
  entityId: string | null;
  name: string;
  address: string;
  confirmedBy: string;
}

export interface ConfirmedEmailRecipient {
  entityId: string;
  name: string;
  address: string;
}

type AtomicDatabase = RuntimeDb & {
  transaction<T>(fn: (tx: RuntimeDb) => Promise<T>): Promise<T>;
};

export async function confirmEmailRecipient(
  runtime: IAgentRuntime,
  agentId: string,
  input: ConfirmEmailRecipientInput,
): Promise<ConfirmedEmailRecipient> {
  const name = input.name.trim();
  const address = input.address.trim().toLowerCase();
  if (
    !name ||
    (input.entityId !== null && !input.entityId.trim()) ||
    !input.confirmedBy.trim() ||
    !z.string().email().safeParse(address).success ||
    /[\r\n\0]/u.test(input.name + input.address)
  ) {
    throw new ElizaError(
      "Review a valid name and a single email address before confirming.",
      { code: "ENTITY_RECIPIENT_INVALID" },
    );
  }
  const db = runtime.adapter.db as AtomicDatabase | undefined;
  if (!db || typeof db.transaction !== "function") {
    throw new ElizaError(
      "Recipient confirmation requires an atomic database transaction.",
      { code: "ENTITY_RECIPIENT_TRANSACTION_REQUIRED" },
    );
  }
  return db.transaction(async (tx) => {
    // All existing graph writers acquire row-exclusive table locks. This short,
    // database-only boundary also excludes their concurrent identity changes.
    await executeSql(
      tx,
      "LOCK TABLE app_lifeops.life_entities, app_lifeops.life_entity_identities IN SHARE ROW EXCLUSIVE MODE",
    );
    const matches = await executeSql(
      tx,
      `SELECT DISTINCT entity_id FROM app_lifeops.life_entity_identities WHERE agent_id = ${sqlQuote(agentId)} AND lower(platform) IN ('email', 'gmail') AND lower(handle) = ${sqlQuote(address)}`,
    );
    if (matches.length > 1) {
      throw new ElizaError(
        "This address belongs to multiple contacts. Resolve those contacts before confirming a recipient.",
        { code: "ENTITY_RECIPIENT_AMBIGUOUS" },
      );
    }
    const matchedId = matches[0] ? toText(matches[0].entity_id) : null;
    if (input.entityId && matchedId && input.entityId !== matchedId) {
      throw new ElizaError(
        "This address is already associated with another contact. Review that contact instead.",
        { code: "ENTITY_RECIPIENT_IDENTITY_CONFLICT" },
      );
    }
    const entityId =
      input.entityId ??
      matchedId ??
      `ent_email_${createHash("sha256")
        .update(JSON.stringify([agentId, address]))
        .digest("hex")}`;
    const rows = await executeSql(
      tx,
      `SELECT type, preferred_name FROM app_lifeops.life_entities WHERE agent_id = ${sqlQuote(agentId)} AND entity_id = ${sqlQuote(entityId)}`,
    );
    const existing = rows[0];
    if (input.entityId && !existing) {
      throw new ElizaError(
        "The selected contact is no longer available. Refresh the recipient list.",
        { code: "ENTITY_RECIPIENT_NOT_FOUND" },
      );
    }
    if (
      existing &&
      (existing.type !== "person" || existing.preferred_name !== name)
    ) {
      throw new ElizaError(
        "The contact no longer matches the reviewed name. Refresh and review it again.",
        { code: "ENTITY_RECIPIENT_REVIEW_STALE" },
      );
    }
    const now = new Date().toISOString();
    if (!existing) {
      await executeSql(
        tx,
        `INSERT INTO app_lifeops.life_entities (entity_id, agent_id, type, preferred_name, tags_json, visibility, created_at, updated_at) VALUES (${sqlQuote(entityId)}, ${sqlQuote(agentId)}, 'person', ${sqlQuote(name)}, '[]', 'owner_only', ${sqlQuote(now)}, ${sqlQuote(now)})`,
      );
    }
    const identities = await executeSql(
      tx,
      `SELECT id, verified FROM app_lifeops.life_entity_identities WHERE agent_id = ${sqlQuote(agentId)} AND entity_id = ${sqlQuote(entityId)} AND lower(platform) IN ('email', 'gmail') AND lower(handle) = ${sqlQuote(address)}`,
    );
    if (identities.length) {
      await executeSql(
        tx,
        `UPDATE app_lifeops.life_entity_identities SET verified = TRUE, confidence = 1, evidence_json = (evidence_json::jsonb || ${sqlQuote(JSON.stringify([`owner-confirmation:${input.confirmedBy}`]))}::jsonb)::text WHERE agent_id = ${sqlQuote(agentId)} AND entity_id = ${sqlQuote(entityId)} AND lower(platform) IN ('email', 'gmail') AND lower(handle) = ${sqlQuote(address)} AND verified = FALSE`,
      );
    } else {
      await executeSql(
        tx,
        `INSERT INTO app_lifeops.life_entity_identities (id, agent_id, entity_id, platform, handle, connector_account_id, verified, confidence, added_at, added_via, evidence_json) VALUES (${sqlQuote(`eid_${randomUUID()}`)}, ${sqlQuote(agentId)}, ${sqlQuote(entityId)}, 'email', ${sqlQuote(address)}, 'default', TRUE, 1, ${sqlQuote(now)}, 'user_chat', ${sqlQuote(JSON.stringify([`owner-confirmation:${input.confirmedBy}`]))})`,
      );
    }
    return { entityId, name, address };
  });
}
