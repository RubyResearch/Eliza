/**
 * Exercises X personal identity creation and OAuth linking against isolated
 * PGlite, including replay convergence and cross-account conflict refusal.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../../db/client";
import { identityLinks } from "../../../db/schemas/identity-links";
import {
  organizationBalanceRevisionSequence,
  organizations,
} from "../../../db/schemas/organizations";
import { users } from "../../../db/schemas/users";
import { findOrCreateXPersonalAccount, linkVerifiedXOwnerIdentity } from "./x-personal-identity";

const USER_A = "00000000-0000-4000-8000-000000000101";
const USER_B = "00000000-0000-4000-8000-000000000102";
let pgliteReady = true;

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    return;
  }
  try {
    const { apply } = await pushSchema(
      { organizationBalanceRevisionSequence, organizations, users, identityLinks } as never,
      dbWrite as never,
    );
    await apply();
  } catch {
    // error-policy:J1 schema setup failure makes every test fail explicitly.
    pgliteReady = false;
  }
}, 60_000);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(identityLinks);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

async function seedMatureUser(userId: string, suffix: string) {
  const [organization] = await dbWrite
    .insert(organizations)
    .values({ name: `Org ${suffix}`, slug: `org-${suffix}` })
    .returning();
  if (!organization) throw new Error("Failed to seed organization");
  await dbWrite.insert(users).values({
    id: userId,
    steward_user_id: `steward-${suffix}`,
    organization_id: organization.id,
    role: "owner",
    is_active: true,
  });
  return organization;
}

describe("X personal identity", () => {
  test("creates one unfunded account and reuses it for a retried DM", async () => {
    const created = await findOrCreateXPersonalAccount({
      twitterUserId: "111",
      username: "alice",
      displayName: "Alice",
    });
    const replayed = await findOrCreateXPersonalAccount({
      twitterUserId: "111",
      username: "alice-new",
    });

    expect(created.isNew).toBe(true);
    expect(replayed.isNew).toBe(false);
    expect(replayed.user.id).toBe(created.user.id);
    expect(Number(created.organization.credit_balance)).toBe(0);
    expect(created.user.steward_user_id).toBe("x:111");
    const links = await dbWrite
      .select()
      .from(identityLinks)
      .where(eq(identityLinks.right_entity_id, "x:111"));
    expect(links).toHaveLength(1);
    expect(links[0]?.user_id).toBe(created.user.id);
    expect(links[0]?.source).toBe("transport");
  });

  test("links verified owner OAuth and resolves DMs to that mature account", async () => {
    const organization = await seedMatureUser(USER_A, "a");
    await linkVerifiedXOwnerIdentity({
      organizationId: organization.id,
      userId: USER_A,
      twitterUserId: "222",
    });

    const resolved = await findOrCreateXPersonalAccount({ twitterUserId: "222" });
    expect(resolved.isNew).toBe(false);
    expect(resolved.user.id).toBe(USER_A);
    expect(resolved.organization.id).toBe(organization.id);
  });

  test("refuses to move a verified X identity between accounts", async () => {
    const organizationA = await seedMatureUser(USER_A, "a");
    const organizationB = await seedMatureUser(USER_B, "b");
    await linkVerifiedXOwnerIdentity({
      organizationId: organizationA.id,
      userId: USER_A,
      twitterUserId: "333",
    });

    await expect(
      linkVerifiedXOwnerIdentity({
        organizationId: organizationB.id,
        userId: USER_B,
        twitterUserId: "333",
      }),
    ).rejects.toMatchObject({ code: "X_PERSONAL_IDENTITY_CONFLICT" });
  });
});
