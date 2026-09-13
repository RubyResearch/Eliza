/**
 * Wallet signup creates an opening-balance organization and its owner atomically.
 * Database triggers exercise rollback, retry, and legacy orphan adoption against real PGlite transactions.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

const PGLITE_TIMEOUT = 120_000;
const EVM_ADDRESS = `0x${"ab".repeat(20)}`;
const EVM_ADDRESS_2 = `0x${"cd".repeat(20)}`;
const SOLANA_ADDRESS = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

let pgliteReady = true;
let pgliteError: unknown;
let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let walletSignup: typeof import("../wallet-signup");
let flushWalletLookupCache: () => Promise<void>;

async function armUserInsertFailure(): Promise<void> {
  await dbWrite.execute(`INSERT INTO test_fail_flags (name) VALUES ('users_insert')
    ON CONFLICT (name) DO NOTHING;`);
}

async function disarmFailures(): Promise<void> {
  await dbWrite.execute(`DELETE FROM test_fail_flags;`);
}

async function countRows(table: "organizations" | "users" | "credit_transactions") {
  const result = await dbWrite.execute(`SELECT count(*)::int AS n FROM ${table};`);
  return (result.rows[0] as { n: number }).n;
}

async function orgBalanceBySlug(slug: string): Promise<number> {
  const result = await dbWrite.execute(
    `SELECT credit_balance FROM organizations WHERE slug = '${slug}';`,
  );
  return Number((result.rows[0] as { credit_balance: string }).credit_balance);
}

async function expectRejectsFromTrigger(promise: Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  const messages: string[] = [];
  let current: unknown = thrown;
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    messages.push(current.message);
    current = current.cause;
  }
  expect(messages.join(" | ")).toContain("simulated transient user insert failure");
}

beforeAll(async () => {
  try {
    const dbClient = await import("../../../db/client");
    dbWrite = dbClient.dbWrite;
    closeDb = dbClient.closeDatabaseConnectionsForTests;
    const { organizations } = await import("../../../db/schemas/organizations");
    const { users } = await import("../../../db/schemas/users");
    const { creditTransactions } = await import("../../../db/schemas/credit-transactions");
    const { pushSchema } = await import("../../../db/push-schema-for-tests");
    const { apply } = await pushSchema(
      { organizations, users, creditTransactions } as never,
      dbClient.dbWrite as never,
    );
    await apply();

    await dbWrite.execute(`CREATE TABLE IF NOT EXISTS test_fail_flags (name text PRIMARY KEY);`);
    await dbWrite.execute(`
      CREATE OR REPLACE FUNCTION test_users_insert_gate() RETURNS trigger AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM test_fail_flags WHERE name = 'users_insert') THEN
          RAISE EXCEPTION 'simulated transient user insert failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;`);
    await dbWrite.execute(`
      CREATE TRIGGER test_users_insert_gate_trg BEFORE INSERT ON users
        FOR EACH ROW EXECUTE FUNCTION test_users_insert_gate();`);

    walletSignup = await import("../wallet-signup");

    const { cache } = await import("../../cache/client");
    const { CacheKeys } = await import("../../cache/keys");
    const { getAddress } = await import("viem");
    flushWalletLookupCache = async () => {
      for (const address of [EVM_ADDRESS, EVM_ADDRESS_2]) {
        await cache.del(CacheKeys.user.byWalletAddressWithOrg(getAddress(address)));
      }
    };
  } catch (error) {
    pgliteReady = false;
    pgliteError = error;
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  await closeDb?.();
});

beforeEach(async () => {
  if (!pgliteReady) return;
  await disarmFailures();
  await dbWrite.execute(`DELETE FROM credit_transactions;`);
  await dbWrite.execute(`DELETE FROM users;`);
  await dbWrite.execute(`DELETE FROM organizations;`);
  await flushWalletLookupCache();
});

describe("wallet signup atomic opening-balance creation", () => {
  test("PGlite harness is available", () => {
    if (!pgliteReady) throw pgliteError;
    expect(pgliteReady).toBe(true);
  });

  test(
    "EVM signup rolls back the organization when owner creation fails, then creates an unfunded account on retry",
    async () => {
      if (!pgliteReady) throw pgliteError;

      await armUserInsertFailure();
      await expectRejectsFromTrigger(walletSignup.findOrCreateUserByWalletAddress(EVM_ADDRESS));

      expect(await countRows("organizations")).toBe(0);
      expect(await countRows("users")).toBe(0);
      expect(await countRows("credit_transactions")).toBe(0);

      await disarmFailures();
      const retry = await walletSignup.findOrCreateUserByWalletAddress(EVM_ADDRESS);

      expect(retry.isNewAccount).toBe(true);
      expect(retry.user.role).toBe("owner");
      expect(retry.initialCreditsGranted).toBe(false);
      expect(retry.initialFreeCreditsUsd).toBe(0);
      expect(await countRows("organizations")).toBe(1);
      expect(await countRows("users")).toBe(1);
      expect(await countRows("credit_transactions")).toBe(0);
      expect(await orgBalanceBySlug(`wallet-${EVM_ADDRESS.toLowerCase()}`)).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "Solana signup rolls back the organization when owner creation fails, then creates an unfunded account on retry",
    async () => {
      if (!pgliteReady) throw pgliteError;

      await armUserInsertFailure();
      await expectRejectsFromTrigger(
        walletSignup.findOrCreateSolanaUserByWalletAddress(SOLANA_ADDRESS),
      );

      expect(await countRows("organizations")).toBe(0);
      expect(await countRows("users")).toBe(0);
      expect(await countRows("credit_transactions")).toBe(0);

      await disarmFailures();
      const retry = await walletSignup.findOrCreateSolanaUserByWalletAddress(SOLANA_ADDRESS);

      expect(retry.isNewAccount).toBe(true);
      expect(retry.user.role).toBe("owner");
      expect(retry.initialCreditsGranted).toBe(false);
      expect(retry.initialFreeCreditsUsd).toBe(0);
      expect(await countRows("organizations")).toBe(1);
      expect(await countRows("users")).toBe(1);
      expect(await countRows("credit_transactions")).toBe(0);
      expect(await orgBalanceBySlug(`wallet-solana-${SOLANA_ADDRESS}`)).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a legacy zero-balance wallet organization is adopted without adding signup funds",
    async () => {
      if (!pgliteReady) throw pgliteError;

      const normalized = EVM_ADDRESS_2.toLowerCase();
      const slug = `wallet-${normalized}`;
      await dbWrite.execute(
        `INSERT INTO organizations (name, slug, credit_balance) VALUES ('Existing', '${slug}', '0');`,
      );

      const result = await walletSignup.findOrCreateUserByWalletAddress(EVM_ADDRESS_2);

      expect(result.isNewAccount).toBe(true);
      expect(result.user.role).toBe("owner");
      expect(result.user.organization?.slug).toBe(slug);
      expect(result.initialCreditsGranted).toBe(false);
      expect(result.initialFreeCreditsUsd).toBe(0);
      expect(await countRows("organizations")).toBe(1);
      expect(await countRows("users")).toBe(1);
      expect(await countRows("credit_transactions")).toBe(0);
      expect(await orgBalanceBySlug(slug)).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  test.each(["5.00", "42.25"])(
    "adopting an existing wallet organization preserves its %s balance without a new grant",
    async (balance) => {
      if (!pgliteReady) throw pgliteError;
      const slug = `wallet-${EVM_ADDRESS_2.toLowerCase()}`;
      await dbWrite.execute(
        `INSERT INTO organizations (name, slug, credit_balance) VALUES ('Funded', '${slug}', '${balance}');`,
      );
      const result = await walletSignup.findOrCreateUserByWalletAddress(EVM_ADDRESS_2);
      expect(result.initialCreditsGranted).toBe(false);
      expect(result.initialFreeCreditsUsd).toBe(0);
      expect(await orgBalanceBySlug(slug)).toBe(Number(balance));
      expect(await countRows("credit_transactions")).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a second sign-in returns the existing owner without creating rows",
    async () => {
      if (!pgliteReady) throw pgliteError;

      const first = await walletSignup.findOrCreateUserByWalletAddress(EVM_ADDRESS);
      const again = await walletSignup.findOrCreateUserByWalletAddress(EVM_ADDRESS);

      expect(first.isNewAccount).toBe(true);
      expect(again.isNewAccount).toBe(false);
      expect(again.user.id).toBe(first.user.id);
      expect(await countRows("organizations")).toBe(1);
      expect(await countRows("users")).toBe(1);
      expect(await countRows("credit_transactions")).toBe(0);
    },
    PGLITE_TIMEOUT,
  );
});
