/** Provides explicit database fixtures for deterministic sandbox orchestration tests. Importing this module installs no hooks, spies, or lifecycle simulation. */

import { mock, spyOn } from "bun:test";
import * as realEnsureSchemaNs from "../../../../db/ensure-agent-sandbox-schema";
import * as realHelpersNs from "../../../../db/helpers";
import { agentBillingRepository } from "../../../../db/repositories/agent-billing";
import { agentSandboxesRepository } from "../../../../db/repositories/agent-sandboxes";
import * as computeStop from "../../agent-compute-stop";

// `executeUpgrade()`'s blue/green swap runs inside `dbWrite.transaction(...)`.
// `dbWrite` is a Proxy whose `get` trap always re-resolves the live connection,
// so `spyOn(dbWrite, "transaction")` does NOT intercept — the call falls through
// to a real DB and throws. The only way to drive the real swap body offline is
// to replace the `dbWrite` binding at the module that defines it. We spread the
// REAL helpers and override ONLY `dbWrite` with a controllable transaction; the
// repositories used elsewhere in this file are all `spyOn`-stubbed, so they
// never touch this swapped `dbWrite`. The override is restored in `afterAll` so
// it cannot leak into other files in the shared single-process run.
export type UpgradeTx = { execute: (query: unknown) => Promise<{ rows: Array<{ id: string }> }> };

export type UpgradeTransactionOutcome =
  | { status: "resolved"; value: unknown }
  | { status: "rejected" }
  | null;

// VALUE snapshot taken at module evaluation, while no mock is installed:
// `db/helpers` re-exports `dbWrite` from `db/client`, so bun's module mocks
// patch the SHARED live binding — building the restore (or this override's
// spread) from the live namespace after a mock landed would capture the mock.
export const realHelpers = { ...realHelpersNs };

// Same VALUE-snapshot rule for the self-healing DDL guard: prepareAgentDelete
// awaits ensureAgentSandboxSchema() before its transaction, and this file's
// swapped `dbWrite` forwards `.execute` to the real connection — so the real
// guard would attempt live DDL here. This is a mocked-database suite; the
// guard itself is covered by the PGlite tests.
export const realEnsureSchema = { ...realEnsureSchemaNs };

export const sandboxTransactions: {
  implementation: (<T>(fn: (tx: UpgradeTx) => Promise<T>) => Promise<T>) | null;
  outcome: UpgradeTransactionOutcome;
} = { implementation: null, outcome: null };

export const realDbWrite = realHelpers.dbWrite as unknown as object;

export const upgradeDbWrite = new Proxy(realDbWrite, {
  get(target, property, receiver) {
    if (property === "transaction") {
      return async <T>(fn: (tx: UpgradeTx) => Promise<T>): Promise<T> => {
        if (!sandboxTransactions.implementation) {
          throw new Error(
            "dbWrite.transaction called without an active sandboxTransactions.implementation (test wiring bug)",
          );
        }
        try {
          const value = await sandboxTransactions.implementation(fn);
          sandboxTransactions.outcome = { status: "resolved", value };
          return value;
        } catch (error) {
          sandboxTransactions.outcome = { status: "rejected" };
          throw error;
        }
      };
    }
    const value = Reflect.get(target, property, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

export function installSandboxDatabaseSimulation(): () => void {
  // Existing orchestration fixtures simulate repository writes. The real
  // failure-generation CAS is exercised against PostgreSQL/PGlite separately.
  const failureSpy = spyOn(agentSandboxesRepository, "markProvisionFailed").mockImplementation(
    (expected, message) =>
      agentSandboxesRepository.update(expected.id, {
        status: "error",
        error_message: message,
        error_count: (expected.error_count ?? 0) + 1,
      }),
  );
  mock.module(import.meta.resolve("../../../../db/helpers.ts"), () => ({
    ...realHelpers,
    dbWrite: upgradeDbWrite,
  }));
  mock.module(import.meta.resolve("../../../../db/ensure-agent-sandbox-schema.ts"), () => ({
    ...realEnsureSchema,
    ensureAgentSandboxSchema: async () => {},
  }));

  return () => {
    failureSpy.mockRestore();
    mock.module(import.meta.resolve("../../../../db/helpers.ts"), () => realHelpers);
    mock.module(
      import.meta.resolve("../../../../db/ensure-agent-sandbox-schema.ts"),
      () => realEnsureSchema,
    );
  };
}

export function installSandboxBillingSimulation() {
  // Legacy orchestration fixtures have no prepaid windows; real prepaid
  // ownership and settlement are exercised by the PostgreSQL/SSH suite.
  const computeFundingSpy = spyOn(computeStop, "hasOpenAgentComputeFunding").mockResolvedValue(
    false,
  );
  const reactivateBillingSpy = spyOn(
    agentBillingRepository,
    "reactivateSandboxBillingAfterFunding",
  ).mockResolvedValue(undefined);
  const settleLifecycleBillingSpy = spyOn(
    agentBillingRepository,
    "settleAccruedBillingBeforeLifecycle",
  ).mockResolvedValue({ status: "already_billed_recently" });
  const settleLifecycleBillingInTransactionSpy = spyOn(
    agentBillingRepository,
    "settleAccruedBillingBeforeLifecycleInTransaction",
  ).mockResolvedValue({ status: "already_billed_recently" });
  return {
    reactivateBillingSpy,
    settleLifecycleBillingSpy,
    settleLifecycleBillingInTransactionSpy,
    restore() {
      computeFundingSpy.mockRestore();
      reactivateBillingSpy.mockRestore();
      settleLifecycleBillingSpy.mockRestore();
      settleLifecycleBillingInTransactionSpy.mockRestore();
    },
  };
}
