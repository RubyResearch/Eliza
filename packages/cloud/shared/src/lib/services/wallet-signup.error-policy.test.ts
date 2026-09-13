/**
 * Fail-closed error semantics for wallet signup: an internal DB failure during
 * org/user creation must PROPAGATE (never swallow into a fabricated user),
 * while the designed unique-violation race recovers to the winning row and a
 * genuinely-found existing user returns distinctly. Collaborators are mocked to
 * inject the two failure shapes; the real findOrCreateUserByWalletAddress
 * control flow is under test (deterministic mocks, no live DB, no network).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

process.env.NODE_ENV ||= "test";

const EVM_ADDRESS = `0x${"cd".repeat(20)}`;

// Mutable behavior holders — each test rewires the collaborator responses.
let getByWallet: (addr: string) => Promise<unknown>;
let findBySlug: (slug: string) => Promise<unknown>;
let orgCreate: (input: unknown) => Promise<unknown>;
let orgUpdateInput: unknown;
let userCreate: (input: { organization_id: string; role: string }) => Promise<unknown>;

mock.module("../../db/repositories/organizations", () => ({
  organizationsRepository: { findBySlug: (s: string) => findBySlug(s) },
}));
mock.module("../../db/repositories/users", () => ({
  usersRepository: {
    create: (i: { organization_id: string; role: string }) => userCreate(i),
    findBySolanaWalletAddressWithOrganization: (a: string) => getByWallet(a),
  },
}));
mock.module("../../db/helpers", () => ({
  writeTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      query: {
        organizations: {
          findFirst: () => findBySlug("wallet-slug"),
        },
        users: {
          findFirst: () => getByWallet(EVM_ADDRESS),
        },
      },
      insert: () => ({
        values: (input: { slug?: string; organization_id?: string; role?: string }) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              if (input.slug) {
                const org = await orgCreate(input);
                return org ? [org] : [];
              }
              const user = await userCreate(input as { organization_id: string; role: string });
              return user ? [user] : [];
            },
          }),
        }),
      }),
      update: () => ({
        set: (input: unknown) => ({
          where: () => ({
            returning: async () => {
              orgUpdateInput = input;
              const org = await findBySlug("wallet-slug");
              return org ? [org] : [];
            },
          }),
        }),
      }),
    }),
}));
mock.module("./organizations", () => ({
  organizationsService: { create: (i: unknown) => orgCreate(i) },
}));
mock.module("./users", () => ({
  usersService: {
    getByWalletAddressWithOrganization: (a: string) => getByWallet(a),
    findBySolanaWalletAddressWithOrganization: (a: string) => getByWallet(a),
  },
}));
let walletSignup: typeof import("./wallet-signup");

beforeAll(async () => {
  walletSignup = await import("./wallet-signup");
});

const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = mock(() => {
    throw new Error("no network allowed in this test");
  }) as never;
  // Sensible defaults; individual tests override.
  getByWallet = async () => null;
  findBySlug = async () => null;
  orgCreate = async () => null;
  orgUpdateInput = undefined;
  userCreate = async () => {
    throw new Error("userCreate not configured");
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("wallet-signup fail-closed error policy", () => {
  test("internal DB failure during org creation PROPAGATES (not swallowed into a fake user)", async () => {
    getByWallet = async () => null;
    findBySlug = async () => null;
    orgCreate = async () => {
      throw new Error("connection terminated unexpectedly");
    };

    await expect(walletSignup.findOrCreateUserByWalletAddress(EVM_ADDRESS)).rejects.toThrow(
      "connection terminated unexpectedly",
    );
  });

  test("org create conflict is a DESIGNED race recovery to the winning org", async () => {
    const racedOrg = { id: "org-raced", slug: "wallet-slug", credit_balance: "5.000000" };
    getByWallet = async () => null;
    findBySlug = async () => racedOrg;
    let organizationInput: unknown;
    orgCreate = async (input) => {
      organizationInput = input;
      return null;
    };
    userCreate = async (input) => ({
      id: "user-1",
      organization_id: input.organization_id,
      role: input.role,
    });

    const res = await walletSignup.findOrCreateUserByWalletAddress(EVM_ADDRESS);

    expect(res.isNewAccount).toBe(true);
    expect(res.user.organization).toBe(racedOrg as never);
    expect(res.user.organization_id).toBe("org-raced");
    expect(organizationInput).toEqual(expect.objectContaining({ credit_balance: "0.00" }));
    expect(orgUpdateInput).toBeUndefined();
    expect(res.initialCreditsGranted).toBe(false);
    expect(res.initialFreeCreditsUsd).toBe(0);
  });

  test("internal DB failure during user creation PROPAGATES", async () => {
    const org = { id: "org-1", slug: "wallet-slug" };
    getByWallet = async () => null;
    findBySlug = async () => org;
    userCreate = async () => {
      throw new Error("deadlock detected");
    };

    await expect(walletSignup.findOrCreateUserByWalletAddress(EVM_ADDRESS)).rejects.toThrow(
      "deadlock detected",
    );
  });

  test("user-create conflict with unrecoverable re-fetch RETHROWS (never fabricates a user)", async () => {
    const org = { id: "org-1", slug: "wallet-slug" };
    // Both the initial lookup and the post-race re-fetch return null: the race
    // handler must not invent a user, it must rethrow the original error.
    getByWallet = async () => null;
    findBySlug = async () => org;
    userCreate = async () => {
      throw new Error("duplicate key value violates unique constraint users_wallet_address");
    };

    await expect(walletSignup.findOrCreateUserByWalletAddress(EVM_ADDRESS)).rejects.toThrow(
      "duplicate key value violates unique constraint",
    );
  });

  test("a genuinely-found existing user returns distinctly (isNewAccount=false, no creation)", async () => {
    const existing = { id: "u-existing", organization: { id: "o-existing" }, role: "owner" };
    getByWallet = async () => existing;

    const res = await walletSignup.findOrCreateUserByWalletAddress(EVM_ADDRESS);

    expect(res.isNewAccount).toBe(false);
    expect(res.user).toBe(existing as never);
  });
});
