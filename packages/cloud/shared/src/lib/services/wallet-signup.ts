/**
 * Shared wallet-based signup: find or create user + org by wallet address.
 * Used by SIWE verify, wallet header auth, and x402 topup so slug, credits, and race
 * handling are consistent. WHY one path: avoids drift between SIWE/topup/wallet-auth.
 */

import { eq } from "drizzle-orm";
import { getAddress } from "viem";
import type { DbTransaction } from "../../db/client";
import { writeTransaction } from "../../db/helpers";
import type { Organization } from "../../db/repositories/organizations";
import type { UserWithOrganization } from "../../db/repositories/users";
import { usersRepository } from "../../db/repositories/users";
import { organizations } from "../../db/schemas/organizations";
import { users } from "../../db/schemas/users";
import { SIGNUP_CREDIT_POLICY } from "../signup-credits";
import { usersService } from "./users";

export interface FindOrCreateWalletOptions {
  /**
   * Whether the caller VERIFIED control of this address — a SIWE/SIWS signature
   * or the signed wallet-auth header — rather than merely being handed it in a
   * request body. It lands in `users.wallet_verified`, which the OIDC layer reads
   * as proof of control and turns into a permanent no-reply identity at a
   * relying party (`lib/oidc/subject.ts`).
   *
   * Defaults to FALSE so a caller that proved nothing cannot assert it by
   * omission: this helper is shared by the two sign-ins that DO verify a
   * signature and by x402 topup / agent provisioning, which accept an address
   * from the request and could otherwise mark a stranger's wallet verified.
   */
  walletProven?: boolean;
}

type WalletSignupResult = {
  user: UserWithOrganization;
  isNewAccount: boolean;
  initialCreditsGranted: false;
  initialFreeCreditsUsd: 0;
};

/**
 * Unique-violation detection that survives driver wrapping: drizzle raises
 * `DrizzleQueryError` whose message is the failed SQL, with the Postgres error
 * underneath as `cause` — a top-level message check alone misses it. Walks the
 * cause chain for the SQLSTATE (23505) and the message shapes.
 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    if ((current as Error & { code?: unknown }).code === "23505") return true;
    if (current.message.includes("unique") || current.message.includes("duplicate")) return true;
    current = current.cause;
  }
  return false;
}

async function findOrgBySlugForWrite(
  tx: DbTransaction,
  slug: string,
): Promise<Organization | null> {
  return (
    (await tx.query.organizations.findFirst({
      where: eq(organizations.slug, slug),
    })) ?? null
  );
}

async function createOrFindWalletOrg(params: {
  tx: DbTransaction;
  slug: string;
  name: string;
}): Promise<Organization> {
  const [created] = await params.tx
    .insert(organizations)
    .values({
      name: params.name,
      slug: params.slug,
      credit_balance: SIGNUP_CREDIT_POLICY.openingBalanceUsd,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  // A pre-existing wallet organization may already carry purchased or historical
  // credits. Adopting its owner must neither add signup funds nor replace them.
  const org = await findOrgBySlugForWrite(params.tx, params.slug);
  if (!org) {
    throw new Error("Organization creation failed and could not find existing org");
  }
  return org;
}

async function findEvmUserForWrite(
  tx: DbTransaction,
  normalizedAddress: string,
): Promise<UserWithOrganization | null> {
  return (
    (await tx.query.users.findFirst({
      where: eq(users.wallet_address, normalizedAddress),
      with: { organization: true },
    })) ?? null
  );
}

async function findSolanaUserForWrite(
  tx: DbTransaction,
  address: string,
): Promise<UserWithOrganization | null> {
  return (
    (await tx.query.users.findFirst({
      where: eq(users.wallet_address, address),
      with: { organization: true },
    })) ?? null
  );
}

/**
 * Raises `wallet_verified` on a row this caller has just proved control of.
 *
 * Proof is monotonic and one-directional: an address can first reach this table
 * from a path that only NAMED it (x402 topup, agent provisioning), and without
 * this the account would stay unverified forever even after its owner signs a
 * SIWE/SIWS challenge — no wallet identity at any relying party. Nothing here
 * ever lowers the flag, because a later unproven mention is not evidence against
 * a signature that was already checked.
 *
 * Called only outside the signup transaction. A concurrent signup that loses the
 * insert race returns its winner's row without the upgrade, which the next
 * sign-in performs; writing to another transaction's just-inserted row from
 * inside this one is not worth that.
 */
async function raiseWalletProof(
  user: UserWithOrganization,
  walletProven: boolean,
): Promise<UserWithOrganization> {
  if (!walletProven || user.wallet_verified === true) return user;
  await usersService.update(user.id, { wallet_verified: true });
  return { ...user, wallet_verified: true };
}

/**
 * Find user by wallet, or create org + user and return.
 * Address can be any case; stored and slug use lowercase.
 * Used by SIWE, wallet header auth, and x402 topup. New personal organizations
 * start unfunded; top-ups and promotion codes stay separate.
 *
 * `walletProven` decides `users.wallet_verified` and defaults to false — see the
 * option's own note for why the caller must say so explicitly.
 */
export async function findOrCreateUserByWalletAddress(
  walletAddress: string,
  options?: FindOrCreateWalletOptions,
): Promise<WalletSignupResult> {
  const address = getAddress(walletAddress);
  const normalized = address.toLowerCase();
  const walletProven = options?.walletProven === true;

  const existing = await usersService.getByWalletAddressWithOrganization(address);
  if (existing) {
    return {
      user: await raiseWalletProof(existing, walletProven),
      isNewAccount: false,
      initialCreditsGranted: false,
      initialFreeCreditsUsd: 0,
    };
  }

  /* WHY slug wallet-${normalized}: consistent with topup and SIWE; lowercase for unique indexing. */
  const slug = `wallet-${normalized}`;
  try {
    return await writeTransaction(async (tx) => {
      const racedExisting = await findEvmUserForWrite(tx, normalized);
      if (racedExisting) {
        return {
          user: racedExisting,
          isNewAccount: false,
          initialCreditsGranted: false,
          initialFreeCreditsUsd: 0,
        };
      }

      const org = await createOrFindWalletOrg({
        tx,
        slug,
        name: `Wallet ${address.slice(0, 6)}...${address.slice(-4)}`,
      });
      const [created] = await tx
        .insert(users)
        .values({
          steward_user_id: `wallet:evm:${normalized}`,
          wallet_address: normalized,
          wallet_chain_type: "evm",
          wallet_verified: walletProven,
          organization_id: org.id,
          // The signup creates this org for the wallet — its creator manages it
          // (matches the anonymous-migration path in session.ts). Without this the
          // sole member of a fresh wallet org is a plain "member" and can never
          // invite teammates or manage the org they own.
          role: "owner",
        })
        .onConflictDoNothing()
        .returning();

      if (!created) {
        const raced = await findEvmUserForWrite(tx, normalized);
        if (!raced) {
          throw new Error("User creation conflicted but could not find existing wallet user");
        }
        return {
          user: raced,
          isNewAccount: false,
          initialCreditsGranted: false,
          initialFreeCreditsUsd: 0,
        };
      }

      const user: UserWithOrganization = { ...created, organization: org };
      return {
        user,
        isNewAccount: true,
        initialCreditsGranted: false,
        initialFreeCreditsUsd: 0,
      };
    });
  } catch (e) {
    // error-policy:J3 unique-violation race recovery — the losing concurrent
    // signup returns the winner's row; missing re-fetch rethrows the original.
    if (!isUniqueViolation(e)) throw e;
    const raced = await usersService.getByWalletAddressWithOrganization(address);
    if (!raced) throw e;
    return {
      user: await raiseWalletProof(raced, walletProven),
      isNewAccount: false,
      initialCreditsGranted: false,
      initialFreeCreditsUsd: 0,
    };
  }
}

/**
 * Find or create a user for a Solana wallet.
 * Solana base58 addresses are case-sensitive, so this path must not pass
 * through EVM checksum normalization or lowercase storage.
 */
export async function findOrCreateSolanaUserByWalletAddress(
  walletAddress: string,
  options?: FindOrCreateWalletOptions,
): Promise<WalletSignupResult> {
  const address = walletAddress.trim();
  if (!address) {
    throw new Error("Wallet address is required");
  }
  const walletProven = options?.walletProven === true;

  const existing = await usersRepository.findBySolanaWalletAddressWithOrganization(address);
  if (existing) {
    return {
      user: await raiseWalletProof(existing, walletProven),
      isNewAccount: false,
      initialCreditsGranted: false,
      initialFreeCreditsUsd: 0,
    };
  }

  const slug = `wallet-solana-${address}`;
  try {
    return await writeTransaction(async (tx) => {
      const racedExisting = await findSolanaUserForWrite(tx, address);
      if (racedExisting) {
        return {
          user: racedExisting,
          isNewAccount: false,
          initialCreditsGranted: false,
          initialFreeCreditsUsd: 0,
        };
      }

      const org = await createOrFindWalletOrg({
        tx,
        slug,
        name: `Solana Wallet ${address.slice(0, 6)}...${address.slice(-4)}`,
      });
      const [created] = await tx
        .insert(users)
        .values({
          steward_user_id: `wallet:solana:${address}`,
          wallet_address: address,
          wallet_chain_type: "solana",
          wallet_verified: walletProven,
          organization_id: org.id,
          // Creator of the fresh wallet org manages it — see the EVM path above.
          role: "owner",
        })
        .onConflictDoNothing()
        .returning();

      if (!created) {
        const raced = await findSolanaUserForWrite(tx, address);
        if (!raced) {
          throw new Error("User creation conflicted but could not find existing Solana user");
        }
        return {
          user: raced,
          isNewAccount: false,
          initialCreditsGranted: false,
          initialFreeCreditsUsd: 0,
        };
      }

      const user: UserWithOrganization = { ...created, organization: org };
      return {
        user,
        isNewAccount: true,
        initialCreditsGranted: false,
        initialFreeCreditsUsd: 0,
      };
    });
  } catch (e) {
    // error-policy:J3 unique-violation race recovery — the losing concurrent
    // signup returns the winner's row; missing re-fetch rethrows the original.
    if (!isUniqueViolation(e)) throw e;
    const raced = await usersRepository.findBySolanaWalletAddressWithOrganization(address);
    if (!raced) throw e;
    return {
      user: await raiseWalletProof(raced, walletProven),
      isNewAccount: false,
      initialCreditsGranted: false,
      initialFreeCreditsUsd: 0,
    };
  }
}
