/**
 * Exercises the explicitly proved phone + Telegram provisional-account merge
 * against real PGlite, including retry receipts and strict maturity guards.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { createTodosSqlStore } from "@elizaos/plugin-todos/edge";
import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";
import {
  lifeScheduledTaskLog,
  lifeScheduledTasks,
} from "../../../../../../../plugins/plugin-scheduling/src/scheduled-task/db-schema";
import {
  todoMutationsTable,
  todosTable,
} from "../../../../../../../plugins/plugin-todos/src/db/schema";
import {
  sharedRuntimeConversationRoomId,
  sharedRuntimeWorldId,
  sharedTodoStorageScope,
} from "../../../lib/services/shared-runtime/shared-runtime-storage-identity";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../client";
import { sqlRows } from "../../execute-helpers";
import { organizationBalanceRevisionSequence, organizations } from "../../schemas/organizations";
import { personalAccountConvergences } from "../../schemas/personal-account-convergences";
import { userIdentities } from "../../schemas/user-identities";
import { users } from "../../schemas/users";
import { usersRepository } from "../users";

const PGLITE_TIMEOUT = 120_000;

describe("UsersRepository phone + Telegram provisional convergence (real PGlite)", () => {
  let pgliteReady = true;
  let sequence = 0;

  const createPair = async () => {
    sequence += 1;
    const phoneNumber = `+14155553${String(sequence).padStart(4, "0")}`;
    const telegramId = `20000${sequence}`;
    const phone = await usersRepository.findOrCreatePhonePersonalAccount({
      phoneNumber,
      displayName: `Phone ${sequence}`,
      organizationName: `Phone ${sequence}`,
      organizationSlug: `phone-convergence-${sequence}`,
    });
    const telegram = await usersRepository.findOrCreateMessagingPersonalAccount({
      platform: "telegram",
      telegramId,
      telegramUsername: `telegram_${sequence}`,
      telegramFirstName: `Telegram ${sequence}`,
      displayName: `Telegram ${sequence}`,
      organizationName: `Telegram ${sequence}`,
      organizationSlug: `telegram-convergence-${sequence}`,
    });
    return { phoneNumber, telegramId, phone, telegram };
  };

  const proofFor = (pair: Awaited<ReturnType<typeof createPair>>) => ({
    phoneNumber: pair.phoneNumber,
    telegramId: pair.telegramId,
    stewardUserId: `steward-convergence-${sequence}`,
    expectedTelegramUserId: pair.telegram.user.id,
    expectedTelegramOrganizationId: pair.telegram.organization.id,
  });

  const createCanonicalStewardSubject = async () => {
    sequence += 1;
    const stewardUserId = `steward-canonical-${sequence}`;
    const [organization] = await dbWrite
      .insert(organizations)
      .values({
        name: `Canonical ${sequence}`,
        slug: `canonical-${sequence}`,
      })
      .returning();
    const [user] = await dbWrite
      .insert(users)
      .values({
        steward_user_id: stewardUserId,
        organization_id: organization.id,
        role: "owner",
      })
      .returning();
    await dbWrite.insert(userIdentities).values({
      user_id: user.id,
      steward_user_id: stewardUserId,
    });
    return { stewardUserId, user, organization };
  };

  beforeAll(async () => {
    if (!CAN_USE_ISOLATED_PGLITE) {
      pgliteReady = false;
      console.warn(
        "[users-converge-phone-telegram-personal-account.test] isolated PGlite is required; refusing to mutate an ambient Postgres database.",
      );
      return;
    }

    try {
      await dbWrite.execute(sql`CREATE SCHEMA IF NOT EXISTS todos`);
      await dbWrite.execute(sql`CREATE SCHEMA IF NOT EXISTS app_scheduling`);
      const { apply } = await pushSchema(
        {
          organizationBalanceRevisionSequence,
          organizations,
          users,
          userIdentities,
          personalAccountConvergences,
          todosTable,
          todoMutationsTable,
          lifeScheduledTasks,
          lifeScheduledTaskLog,
        } as never,
        dbWrite as never,
      );
      await apply();
      await dbWrite.execute(sql`
        CREATE TABLE IF NOT EXISTS agent_sandboxes (
          id uuid PRIMARY KEY,
          organization_id uuid NOT NULL,
          user_id uuid NOT NULL,
          pool_status text,
          deleted_at timestamp
        )
      `);
      await dbWrite.execute(sql`
        CREATE TABLE IF NOT EXISTS user_characters (
          id uuid PRIMARY KEY,
          organization_id uuid NOT NULL,
          user_id uuid NOT NULL
        )
      `);
      await dbWrite.execute(sql`
        CREATE TABLE IF NOT EXISTS credit_transactions (
          id uuid PRIMARY KEY,
          organization_id uuid NOT NULL
        )
      `);
      await dbWrite.execute(sql`
        CREATE TABLE IF NOT EXISTS api_keys (
          id uuid PRIMARY KEY,
          organization_id uuid NOT NULL
        )
      `);
      await dbWrite.execute(sql`
        CREATE TABLE IF NOT EXISTS conversations (
          id uuid PRIMARY KEY,
          organization_id uuid NOT NULL
        )
      `);
      await dbWrite.execute(sql`
        CREATE TABLE IF NOT EXISTS user_sessions (
          id uuid PRIMARY KEY,
          organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      await dbWrite.execute(sql`
        CREATE TABLE IF NOT EXISTS payment_requests (
          id uuid PRIMARY KEY,
          payer_user_id uuid REFERENCES users(id) ON DELETE SET NULL
        )
      `);
      await dbWrite.execute(sql`
        CREATE TABLE IF NOT EXISTS ad_report_shares (
          id uuid PRIMARY KEY,
          created_by_user_id uuid
        )
      `);
    } catch (error) {
      // error-policy:J1 The test boundary records setup failure and every case fails loudly.
      pgliteReady = false;
      console.error(
        "[users-converge-phone-telegram-personal-account.test] PGlite schema setup failed.",
        error,
      );
    }
  }, PGLITE_TIMEOUT);

  beforeEach(async () => {
    expect(pgliteReady).toBe(true);
    await dbWrite.delete(lifeScheduledTaskLog);
    await dbWrite.delete(lifeScheduledTasks);
    await dbWrite.delete(todoMutationsTable);
    await dbWrite.delete(todosTable);
    await dbWrite.execute(sql`DELETE FROM agent_sandboxes`);
    await dbWrite.execute(sql`DELETE FROM user_characters`);
    await dbWrite.execute(sql`DELETE FROM credit_transactions`);
    await dbWrite.execute(sql`DELETE FROM api_keys`);
    await dbWrite.execute(sql`DELETE FROM conversations`);
    await dbWrite.execute(sql`DELETE FROM user_sessions`);
    await dbWrite.execute(sql`DELETE FROM payment_requests`);
    await dbWrite.execute(sql`DELETE FROM ad_report_shares`);
    await dbWrite.delete(personalAccountConvergences);
    await dbWrite.delete(userIdentities);
    await dbWrite.delete(users);
    await dbWrite.delete(organizations);
  });

  afterAll(async () => {
    await closeDatabaseConnectionsForTests();
  });

  test("returns not_found when the canonical Steward subject does not exist", async () => {
    await expect(
      usersRepository.findPendingPhoneTelegramPersonalAccountConvergence({
        stewardUserId: "missing-steward-subject",
      }),
    ).resolves.toEqual({ status: "not_found" });
  });

  test("returns the canonical user and organization when no pending alias exists", async () => {
    const canonical = await createCanonicalStewardSubject();

    await expect(
      usersRepository.findPendingPhoneTelegramPersonalAccountConvergence({
        stewardUserId: canonical.stewardUserId,
      }),
    ).resolves.toMatchObject({
      status: "canonical_user",
      user: {
        id: canonical.user.id,
        steward_user_id: canonical.stewardUserId,
        organization_id: canonical.organization.id,
        organization: {
          id: canonical.organization.id,
          slug: canonical.organization.slug,
          credit_balance: "0.000000",
        },
      },
    });
  });

  test("fails closed when the canonical Steward row and identity authority resolve different users", async () => {
    const canonical = await createCanonicalStewardSubject();
    const projected = await createCanonicalStewardSubject();
    await dbWrite
      .update(userIdentities)
      .set({ steward_user_id: `drifted-projection-${sequence}` })
      .where(eq(userIdentities.user_id, canonical.user.id));
    await dbWrite
      .update(userIdentities)
      .set({ steward_user_id: canonical.stewardUserId })
      .where(eq(userIdentities.user_id, projected.user.id));

    await expect(
      usersRepository.findPendingPhoneTelegramPersonalAccountConvergence({
        stewardUserId: canonical.stewardUserId,
      }),
    ).resolves.toEqual({ status: "identity_projection_conflict" });
  });

  test("converges two signup accounts without doubling the zero opening balance", async () => {
    const pair = await createPair();
    const proof = proofFor(pair);
    const inspection = await usersRepository.inspectPhoneTelegramPersonalAccountConvergence(proof);
    expect(inspection.status).toBe("eligible");
    if (inspection.status !== "eligible") return;

    const params = {
      ...proof,
      sourceUserId: pair.phone.user.id,
      sourceOrganizationId: pair.phone.organization.id,
      sourceAgentId: "personal:source",
      targetUserId: pair.telegram.user.id,
      targetOrganizationId: pair.telegram.organization.id,
      targetAgentId: "personal:target",
      token: `phone-telegram:${pair.phone.user.id}:${pair.telegram.user.id}`,
    };
    const result = await usersRepository.commitPhoneTelegramPersonalAccountConvergence(params);
    expect(result.status).toBe("committed");
    if (result.status !== "committed") return;

    expect(result.user).toMatchObject({
      id: pair.telegram.user.id,
      organization_id: pair.telegram.organization.id,
      steward_user_id: proof.stewardUserId,
      telegram_id: pair.telegramId,
      phone_number: pair.phoneNumber,
      phone_verified: true,
    });
    expect(result.organization.credit_balance).toBe("0.000000");
    expect(await dbWrite.select().from(users)).toHaveLength(1);
    expect(await dbWrite.select().from(organizations)).toHaveLength(1);
    expect(await dbWrite.select().from(userIdentities)).toHaveLength(1);
    expect(await dbWrite.select().from(personalAccountConvergences)).toHaveLength(1);

    const retry = await usersRepository.commitPhoneTelegramPersonalAccountConvergence(params);
    expect(retry.status).toBe("already_committed");
    const conflictingRetry = await usersRepository.commitPhoneTelegramPersonalAccountConvergence({
      ...params,
      targetAgentId: "personal:conflicting-target",
    });
    expect(conflictingRetry.status).toBe("continuation_account_mismatch");
    const resumed = await usersRepository.inspectPhoneTelegramPersonalAccountConvergence(proof);
    expect(resumed.status).toBe("resume_alias");
    const ordinaryStewardLoginRecovery =
      await usersRepository.findPendingPhoneTelegramPersonalAccountConvergence({
        stewardUserId: proof.stewardUserId,
      });
    expect(ordinaryStewardLoginRecovery).toMatchObject({
      status: "resume_alias",
      receipt: { token: params.token, status: "pending_alias" },
      user: { id: pair.telegram.user.id, organization_id: pair.telegram.organization.id },
      organization: { id: pair.telegram.organization.id },
    });
    expect(
      await usersRepository.findPendingPhoneTelegramPersonalAccountConvergence({
        stewardUserId: "different-verified-subject",
      }),
    ).toEqual({ status: "not_found" });
    expect(
      await usersRepository.findPendingPhoneTelegramPersonalAccountConvergence({
        phoneNumber: "+14155559999",
        stewardUserId: proof.stewardUserId,
      }),
    ).toEqual({ status: "identity_projection_conflict" });
    expect(
      await usersRepository.hasPendingPhoneTelegramPersonalAccountConvergenceTarget({
        targetUserId: pair.telegram.user.id,
        targetOrganizationId: pair.telegram.organization.id,
        targetAgentId: params.targetAgentId,
      }),
    ).toBe(true);

    const completed = await usersRepository.markPhoneTelegramPersonalAccountAliasComplete(
      params.token,
    );
    expect(completed?.status).toBe("complete");
    expect(
      await usersRepository.findPendingPhoneTelegramPersonalAccountConvergence({
        stewardUserId: proof.stewardUserId,
      }),
    ).toMatchObject({
      status: "canonical_user",
      user: {
        id: pair.telegram.user.id,
        organization_id: pair.telegram.organization.id,
        organization: { id: pair.telegram.organization.id },
      },
    });
    expect(
      await usersRepository.hasPendingPhoneTelegramPersonalAccountConvergenceTarget({
        targetUserId: pair.telegram.user.id,
        targetOrganizationId: pair.telegram.organization.id,
        targetAgentId: params.targetAgentId,
      }),
    ).toBe(false);
    const [projection] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, pair.telegram.user.id));
    expect(projection).toMatchObject({
      steward_user_id: proof.stewardUserId,
      telegram_id: pair.telegramId,
      phone_number: pair.phoneNumber,
      phone_verified: true,
    });
  });

  test("converges a new unfunded phone account into an untouched legacy $0 Telegram account", async () => {
    const pair = await createPair();
    await dbWrite
      .update(organizations)
      .set({ credit_balance: "0.000000", balance_revision: 0 })
      .where(eq(organizations.id, pair.telegram.organization.id));
    const proof = proofFor(pair);
    const inspection = await usersRepository.inspectPhoneTelegramPersonalAccountConvergence(proof);
    expect(inspection.status).toBe("eligible");
    if (inspection.status !== "eligible") return;

    const result = await usersRepository.commitPhoneTelegramPersonalAccountConvergence({
      ...proof,
      sourceUserId: pair.phone.user.id,
      sourceOrganizationId: pair.phone.organization.id,
      sourceAgentId: "personal:legacy-source",
      targetUserId: pair.telegram.user.id,
      targetOrganizationId: pair.telegram.organization.id,
      targetAgentId: "personal:legacy-target",
      token: `phone-telegram-legacy:${pair.phone.user.id}:${pair.telegram.user.id}`,
    });

    expect(result.status).toBe("committed");
    if (result.status !== "committed") return;
    expect(result.organization.credit_balance).toBe("0.000000");
    expect(await dbWrite.select().from(users)).toHaveLength(1);
    expect(await dbWrite.select().from(organizations)).toHaveLength(1);
  });

  test("moves source Todos and replay authority into the retained Telegram scope", async () => {
    const pair = await createPair();
    const proof = proofFor(pair);
    const sourceAgentId = "personal:todo-source";
    const targetAgentId = "personal:todo-target";
    const sourceScope = sharedTodoStorageScope({
      sourceAgentId,
      ownerId: pair.phone.user.id,
    });
    const targetScope = sharedTodoStorageScope({
      sourceAgentId: targetAgentId,
      ownerId: pair.telegram.user.id,
    });
    const sourceRoomId = sharedRuntimeConversationRoomId(sourceAgentId);
    const sourceWorldId = sharedRuntimeWorldId(sourceAgentId);
    const targetRoomId = sharedRuntimeConversationRoomId(targetAgentId);
    const targetWorldId = sharedRuntimeWorldId(targetAgentId);
    const store = createTodosSqlStore(dbWrite);
    const parentMutation = {
      scope: sourceScope,
      idempotencyKey: "todos:v1:phone-turn-parent:0",
      mutation: {
        action: "create" as const,
        input: {
          roomId: sourceRoomId,
          worldId: sourceWorldId,
          content: "Pack passport",
        },
      },
    };
    const parent = await store.applyMutation(parentMutation);
    expect(parent.result.action).toBe("create");
    if (parent.result.action !== "create") {
      throw new Error("Source parent mutation did not create a Todo");
    }
    const parentTodo = parent.result.todo;
    const child = await store.applyMutation({
      scope: sourceScope,
      idempotencyKey: "todos:v1:phone-turn-child:0",
      mutation: {
        action: "create",
        input: {
          roomId: sourceRoomId,
          worldId: sourceWorldId,
          content: "Check passport expiry",
          parentTodoId: parentTodo.id,
        },
      },
    });
    expect(child.result.action).toBe("create");
    if (child.result.action !== "create") {
      throw new Error("Source child mutation did not create a Todo");
    }
    const childTodo = child.result.todo;
    const targetNative = await store.create({
      ...targetScope,
      roomId: targetRoomId,
      worldId: targetWorldId,
      content: "Telegram native Todo",
    });

    const params = {
      ...proof,
      sourceUserId: pair.phone.user.id,
      sourceOrganizationId: pair.phone.organization.id,
      sourceAgentId,
      targetUserId: pair.telegram.user.id,
      targetOrganizationId: pair.telegram.organization.id,
      targetAgentId,
      token: `phone-telegram:${pair.phone.user.id}:${pair.telegram.user.id}`,
    };
    const result = await usersRepository.commitPhoneTelegramPersonalAccountConvergence(params);
    expect(result.status).toBe("committed");

    expect(await store.readCutoverState(sourceScope)).toEqual({ todos: [], mutations: [] });
    const targetState = await store.readCutoverState(targetScope);
    expect(targetState.todos).toHaveLength(3);
    expect(targetState.mutations).toHaveLength(2);
    expect(targetState.todos.find((todo) => todo.id === targetNative.id)).toMatchObject({
      content: "Telegram native Todo",
      roomId: targetRoomId,
      worldId: targetWorldId,
    });
    const movedParent = targetState.todos.find((todo) => todo.id === parentTodo.id);
    const movedChild = targetState.todos.find((todo) => todo.id === childTodo.id);
    expect(movedParent).toMatchObject({
      agentId: targetScope.agentId,
      entityId: targetScope.entityId,
      roomId: targetRoomId,
      worldId: targetWorldId,
    });
    expect(movedChild).toMatchObject({
      agentId: targetScope.agentId,
      entityId: targetScope.entityId,
      roomId: targetRoomId,
      worldId: targetWorldId,
      parentTodoId: parentTodo.id,
    });

    const replay = await store.applyMutation({
      ...parentMutation,
      scope: targetScope,
      mutation: {
        ...parentMutation.mutation,
        input: {
          ...parentMutation.mutation.input,
          roomId: targetRoomId,
          worldId: targetWorldId,
        },
      },
    });
    expect(replay).toMatchObject({
      replayed: true,
      mutationId: parent.mutationId,
      idempotencyKey: parent.idempotencyKey,
    });
    expect(replay.result).toMatchObject({
      action: "create",
      todo: {
        id: parent.result.todo.id,
        agentId: targetScope.agentId,
        entityId: targetScope.entityId,
        roomId: targetRoomId,
        worldId: targetWorldId,
      },
    });
    expect((await store.list({ ...targetScope })).map((todo) => todo.id).sort()).toEqual(
      targetState.todos.map((todo) => todo.id).sort(),
    );

    const retry = await usersRepository.commitPhoneTelegramPersonalAccountConvergence(params);
    expect(retry.status).toBe("already_committed");
    expect((await store.readCutoverState(targetScope)).todos).toHaveLength(3);
  });

  test("rolls back identity and Todo scopes when replay authority conflicts", async () => {
    const pair = await createPair();
    const proof = proofFor(pair);
    const sourceAgentId = "personal:todo-conflict-source";
    const targetAgentId = "personal:todo-conflict-target";
    const sourceScope = sharedTodoStorageScope({
      sourceAgentId,
      ownerId: pair.phone.user.id,
    });
    const targetScope = sharedTodoStorageScope({
      sourceAgentId: targetAgentId,
      ownerId: pair.telegram.user.id,
    });
    const store = createTodosSqlStore(dbWrite);
    const idempotencyKey = "todos:v1:cross-account-conflict:0";
    await store.applyMutation({
      scope: sourceScope,
      idempotencyKey,
      mutation: {
        action: "create",
        input: { content: "Source meaning" },
      },
    });
    await store.applyMutation({
      scope: targetScope,
      idempotencyKey,
      mutation: {
        action: "create",
        input: { content: "Different target meaning" },
      },
    });

    const commit = usersRepository.commitPhoneTelegramPersonalAccountConvergence({
      ...proof,
      sourceUserId: pair.phone.user.id,
      sourceOrganizationId: pair.phone.organization.id,
      sourceAgentId,
      targetUserId: pair.telegram.user.id,
      targetOrganizationId: pair.telegram.organization.id,
      targetAgentId,
      token: `phone-telegram:${pair.phone.user.id}:${pair.telegram.user.id}`,
    });
    await expect(commit).rejects.toMatchObject({ code: "TODO_IDEMPOTENCY_CONFLICT" });
    expect(await dbWrite.select().from(users)).toHaveLength(2);
    expect(await dbWrite.select().from(organizations)).toHaveLength(2);
    expect(await dbWrite.select().from(userIdentities)).toHaveLength(2);
    expect(await dbWrite.select().from(personalAccountConvergences)).toHaveLength(0);
    expect((await store.readCutoverState(sourceScope)).todos).toHaveLength(1);
    expect((await store.readCutoverState(sourceScope)).mutations).toHaveLength(1);
    expect((await store.readCutoverState(targetScope)).todos).toHaveLength(1);
    expect((await store.readCutoverState(targetScope)).mutations).toHaveLength(1);
  });

  test("fails closed instead of orphaning impossible phone-side reminder state", async () => {
    const pair = await createPair();
    const proof = proofFor(pair);
    const sourceAgentId = "personal:unexpected-phone-reminder";
    const now = new Date().toISOString();
    await dbWrite.insert(lifeScheduledTasks).values({
      id: crypto.randomUUID(),
      agentId: sourceAgentId,
      kind: "reminder",
      promptInstructions: "Impossible source reminder",
      triggerJson: JSON.stringify({ kind: "once", atIso: now }),
      stateJson: JSON.stringify({ status: "scheduled" }),
      createdBy: sourceAgentId,
      createdAt: now,
      updatedAt: now,
    });

    const result = await usersRepository.commitPhoneTelegramPersonalAccountConvergence({
      ...proof,
      sourceUserId: pair.phone.user.id,
      sourceOrganizationId: pair.phone.organization.id,
      sourceAgentId,
      targetUserId: pair.telegram.user.id,
      targetOrganizationId: pair.telegram.organization.id,
      targetAgentId: "personal:retained-telegram-reminder",
      token: `phone-telegram:${pair.phone.user.id}:${pair.telegram.user.id}`,
    });
    expect(result.status).toBe("phone_account_mature");
    expect(await dbWrite.select().from(users)).toHaveLength(2);
    expect(await dbWrite.select().from(organizations)).toHaveLength(2);
    expect(await dbWrite.select().from(personalAccountConvergences)).toHaveLength(0);
    const [sourceTask] = await dbWrite
      .select()
      .from(lifeScheduledTasks)
      .where(eq(lifeScheduledTasks.agentId, sourceAgentId));
    expect(sourceTask?.promptInstructions).toBe("Impossible source reminder");
  });

  test("serializes concurrent commit retries onto one canonical user and receipt", async () => {
    const pair = await createPair();
    const proof = proofFor(pair);
    const params = {
      ...proof,
      sourceUserId: pair.phone.user.id,
      sourceOrganizationId: pair.phone.organization.id,
      sourceAgentId: "personal:source-concurrent",
      targetUserId: pair.telegram.user.id,
      targetOrganizationId: pair.telegram.organization.id,
      targetAgentId: "personal:target-concurrent",
      token: `phone-telegram:${pair.phone.user.id}:${pair.telegram.user.id}`,
    };

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        usersRepository.commitPhoneTelegramPersonalAccountConvergence(params),
      ),
    );

    expect(results.filter((result) => result.status === "committed")).toHaveLength(1);
    expect(results.filter((result) => result.status === "already_committed")).toHaveLength(5);
    expect(await dbWrite.select().from(users)).toHaveLength(1);
    expect(await dbWrite.select().from(organizations)).toHaveLength(1);
    expect(await dbWrite.select().from(personalAccountConvergences)).toHaveLength(1);
  });

  test("refuses pending recovery when the target identity projection no longer matches", async () => {
    const pair = await createPair();
    const proof = proofFor(pair);
    const committed = await usersRepository.commitPhoneTelegramPersonalAccountConvergence({
      ...proof,
      sourceUserId: pair.phone.user.id,
      sourceOrganizationId: pair.phone.organization.id,
      sourceAgentId: "personal:source-projection-check",
      targetUserId: pair.telegram.user.id,
      targetOrganizationId: pair.telegram.organization.id,
      targetAgentId: "personal:target-projection-check",
      token: `phone-telegram:${pair.phone.user.id}:${pair.telegram.user.id}`,
    });
    expect(committed.status).toBe("committed");
    await dbWrite
      .update(userIdentities)
      .set({ steward_user_id: "tampered-steward-subject" })
      .where(eq(userIdentities.user_id, pair.telegram.user.id));

    expect(
      await usersRepository.findPendingPhoneTelegramPersonalAccountConvergence({
        stewardUserId: proof.stewardUserId,
      }),
    ).toEqual({ status: "identity_projection_conflict" });
  });

  test("rejects funded, agent-bearing, and mature provisional-shaped accounts", async () => {
    const funded = await createPair();
    await dbWrite.execute(
      sql`INSERT INTO credit_transactions (id, organization_id)
          VALUES (${crypto.randomUUID()}, ${funded.phone.organization.id})`,
    );
    expect(
      (await usersRepository.inspectPhoneTelegramPersonalAccountConvergence(proofFor(funded)))
        .status,
    ).toBe("funded_account");

    await dbWrite.execute(sql`DELETE FROM credit_transactions`);
    const agentBearing = await createPair();
    await dbWrite.execute(
      sql`INSERT INTO agent_sandboxes (id, organization_id, user_id)
          VALUES (${crypto.randomUUID()}, ${agentBearing.telegram.organization.id}, ${agentBearing.telegram.user.id})`,
    );
    expect(
      (await usersRepository.inspectPhoneTelegramPersonalAccountConvergence(proofFor(agentBearing)))
        .status,
    ).toBe("agent_bearing_account");

    await dbWrite.execute(sql`DELETE FROM agent_sandboxes`);
    const mature = await createPair();
    await dbWrite.execute(
      sql`INSERT INTO api_keys (id, organization_id)
          VALUES (${crypto.randomUUID()}, ${mature.phone.organization.id})`,
    );
    expect(
      (await usersRepository.inspectPhoneTelegramPersonalAccountConvergence(proofFor(mature)))
        .status,
    ).toBe("phone_account_mature");

    const sessionBearing = await createPair();
    await dbWrite.execute(
      sql`INSERT INTO user_sessions (id, organization_id, user_id)
          VALUES (
            ${crypto.randomUUID()},
            ${sessionBearing.telegram.organization.id},
            ${sessionBearing.telegram.user.id}
          )`,
    );
    expect(
      (
        await usersRepository.inspectPhoneTelegramPersonalAccountConvergence(
          proofFor(sessionBearing),
        )
      ).status,
    ).toBe("telegram_account_mature");

    const multiMember = await createPair();
    await dbWrite.insert(users).values({
      steward_user_id: `extra-member-${crypto.randomUUID()}`,
      organization_id: multiMember.phone.organization.id,
      role: "member",
      is_active: true,
    });
    expect(
      (await usersRepository.inspectPhoneTelegramPersonalAccountConvergence(proofFor(multiMember)))
        .status,
    ).toBe("phone_account_mature");
  });

  test("rejects a continuation or projection that does not own the Telegram target", async () => {
    const pair = await createPair();
    const proof = proofFor(pair);
    expect(
      (
        await usersRepository.inspectPhoneTelegramPersonalAccountConvergence({
          ...proof,
          expectedTelegramUserId: crypto.randomUUID(),
        })
      ).status,
    ).toBe("continuation_account_mismatch");

    await dbWrite
      .update(userIdentities)
      .set({ steward_user_id: "tampered-telegram-projection" })
      .where(eq(userIdentities.user_id, pair.telegram.user.id));
    expect(
      (await usersRepository.inspectPhoneTelegramPersonalAccountConvergence(proof)).status,
    ).toBe("identity_projection_conflict");
    expect(await dbWrite.select().from(users)).toHaveLength(2);
    expect(await dbWrite.select().from(organizations)).toHaveLength(2);
  });

  test("preserves FK and registered provenance instead of nulling or deleting it", async () => {
    const paymentPair = await createPair();
    const paymentProof = proofFor(paymentPair);
    const paymentRequestId = crypto.randomUUID();
    await dbWrite.execute(
      sql`INSERT INTO payment_requests (id, payer_user_id)
          VALUES (${paymentRequestId}, ${paymentPair.phone.user.id})`,
    );

    const paymentInspection =
      await usersRepository.inspectPhoneTelegramPersonalAccountConvergence(paymentProof);
    expect(paymentInspection.status).toBe("phone_account_mature");
    const paymentCommit = await usersRepository.commitPhoneTelegramPersonalAccountConvergence({
      ...paymentProof,
      sourceUserId: paymentPair.phone.user.id,
      sourceOrganizationId: paymentPair.phone.organization.id,
      sourceAgentId: "personal:payment-source",
      targetUserId: paymentPair.telegram.user.id,
      targetOrganizationId: paymentPair.telegram.organization.id,
      targetAgentId: "personal:payment-target",
      token: `phone-telegram:${paymentPair.phone.user.id}:${paymentPair.telegram.user.id}`,
    });
    expect(paymentCommit.status).toBe("phone_account_mature");
    const [paymentRequest] = await sqlRows<{ payer_user_id: string }>(
      dbWrite,
      sql`SELECT payer_user_id FROM payment_requests WHERE id = ${paymentRequestId}`,
    );
    expect(paymentRequest).toEqual({ payer_user_id: paymentPair.phone.user.id });
    expect(await usersRepository.findById(paymentPair.phone.user.id)).toBeDefined();

    await dbWrite.execute(sql`DELETE FROM payment_requests`);
    const registeredPair = await createPair();
    const registeredProof = proofFor(registeredPair);
    const reportId = crypto.randomUUID();
    await dbWrite.execute(
      sql`INSERT INTO ad_report_shares (id, created_by_user_id)
          VALUES (${reportId}, ${registeredPair.phone.user.id})`,
    );

    const registeredInspection =
      await usersRepository.inspectPhoneTelegramPersonalAccountConvergence(registeredProof);
    expect(registeredInspection.status).toBe("phone_account_mature");
    const registeredCommit = await usersRepository.commitPhoneTelegramPersonalAccountConvergence({
      ...registeredProof,
      sourceUserId: registeredPair.phone.user.id,
      sourceOrganizationId: registeredPair.phone.organization.id,
      sourceAgentId: "personal:registered-source",
      targetUserId: registeredPair.telegram.user.id,
      targetOrganizationId: registeredPair.telegram.organization.id,
      targetAgentId: "personal:registered-target",
      token: `phone-telegram:${registeredPair.phone.user.id}:${registeredPair.telegram.user.id}`,
    });
    expect(registeredCommit.status).toBe("phone_account_mature");
    const [report] = await sqlRows<{ created_by_user_id: string }>(
      dbWrite,
      sql`SELECT created_by_user_id FROM ad_report_shares WHERE id = ${reportId}`,
    );
    expect(report).toEqual({ created_by_user_id: registeredPair.phone.user.id });
    expect(await usersRepository.findById(registeredPair.phone.user.id)).toBeDefined();
  });
});
