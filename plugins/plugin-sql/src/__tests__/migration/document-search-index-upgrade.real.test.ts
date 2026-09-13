/**
 * Migrates an existing document GIN index on real SQL storage, preserving its
 * records and admitting full binary/text sources that exceeded the old entry
 * limit. Exact search predicates reject partial-token index candidates.
 */
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";
import { RuntimeMigrator } from "../../runtime-migrator/runtime-migrator";
import {
  documentSearchQueryTokensExpression,
  documentSearchTokensExpression,
} from "../../schema/memory";
import { createIsolatedTestDatabaseForSchemaEvolutionTests } from "../test-helpers";

it("upgrades the existing index without truncating sources or widening exact search", async () => {
  const fixture = await createIsolatedTestDatabaseForSchemaEvolutionTests(
    "document_search_index_upgrade"
  );
  try {
    const { db } = fixture;
    const tableFor = (candidates: boolean) =>
      pgTable(
        "document_index_upgrade",
        {
          id: text("id").primaryKey(),
          content: jsonb("content").notNull(),
          metadata: jsonb("metadata").notNull(),
        },
        (table) => [
          index("idx_document_upgrade_search").using(
            "gin",
            documentSearchTokensExpression(table.content, table.metadata, candidates)
          ),
        ]
      );
    const legacy = tableFor(false);
    const current = tableFor(true);
    const migrator = new RuntimeMigrator(db);
    await migrator.initialize();
    await migrator.migrate("@elizaos/document-index-upgrade", { documents: legacy });
    const retained = {
      id: "existing",
      content: { text: "Existing complete record" },
      metadata: { title: "Source" },
    };
    await db.insert(legacy).values(retained);
    const token = randomBytes(20_000).toString("base64");
    const query = "文".repeat(256);
    const oversized = {
      id: "oversized",
      content: { text: `${token} ${query}` },
      metadata: { title: "Large source" },
    };
    await expect(db.insert(legacy).values(oversized)).rejects.toMatchObject({
      cause: { code: "54000" },
    });

    await migrator.migrate("@elizaos/document-index-upgrade", { documents: current });
    await db.insert(current).values(oversized);
    expect(await db.select().from(current).orderBy(current.id)).toEqual([retained, oversized]);
    for (const search of [query, "文".repeat(128)]) {
      const found = await db
        .select()
        .from(current)
        .where(sql`
        ${documentSearchTokensExpression(current.content, current.metadata, true)}
          @> ${documentSearchQueryTokensExpression(sql`${search}`, true)}
        AND ${documentSearchTokensExpression(current.content, current.metadata)}
          @> ${documentSearchQueryTokensExpression(sql`${search}`)}
      `);
      expect(found).toEqual(search === query ? [oversized] : []);
    }
    // A second startup must leave both content and the replacement index usable.
    await migrator.migrate("@elizaos/document-index-upgrade", { documents: current });
    expect(await db.select().from(current).orderBy(current.id)).toEqual([retained, oversized]);
  } finally {
    await fixture.cleanup();
  }
}, 120_000);
