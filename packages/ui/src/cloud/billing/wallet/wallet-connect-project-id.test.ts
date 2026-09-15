/**
 * Unit tests for WalletConnect project-id fail-closed resolution.
 *
 * Deterministic pure-function coverage for #18459: blank, placeholder, and
 * short sentinel values must never be treated as a configured project id.
 */

import { describe, expect, it } from "vitest";
import { buildStewardEvmConfig } from "./steward-wallet-providers";
import {
  isConfiguredWalletConnectProjectId,
  resolveWalletConnectProjectId,
  WALLETCONNECT_PROJECT_ID_PLACEHOLDER,
} from "./wallet-connect-project-id";

describe("isConfiguredWalletConnectProjectId", () => {
  it("accepts a realistic public project id", () => {
    expect(
      isConfiguredWalletConnectProjectId("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"),
    ).toBe(true);
    expect(isConfiguredWalletConnectProjectId("  abcd1234  ")).toBe(true);
  });

  it("rejects missing, blank, and nullish values", () => {
    expect(isConfiguredWalletConnectProjectId(undefined)).toBe(false);
    expect(isConfiguredWalletConnectProjectId(null)).toBe(false);
    expect(isConfiguredWalletConnectProjectId("")).toBe(false);
    expect(isConfiguredWalletConnectProjectId("   ")).toBe(false);
  });

  it("rejects the documented YOUR_WC_PROJECT_ID placeholder", () => {
    expect(
      isConfiguredWalletConnectProjectId(WALLETCONNECT_PROJECT_ID_PLACEHOLDER),
    ).toBe(false);
    expect(isConfiguredWalletConnectProjectId("your_wc_project_id")).toBe(
      false,
    );
    expect(isConfiguredWalletConnectProjectId("Your_WC_Project_Id")).toBe(
      false,
    );
  });

  it("rejects generic placeholder / replace-me sentinels", () => {
    expect(isConfiguredWalletConnectProjectId("replace_with_real_id")).toBe(
      false,
    );
    expect(isConfiguredWalletConnectProjectId("replace-me")).toBe(false);
    expect(isConfiguredWalletConnectProjectId("placeholder")).toBe(false);
    expect(isConfiguredWalletConnectProjectId("changeme")).toBe(false);
    expect(isConfiguredWalletConnectProjectId("todo")).toBe(false);
  });

  it("rejects values shorter than eight characters", () => {
    expect(isConfiguredWalletConnectProjectId("abc")).toBe(false);
    expect(isConfiguredWalletConnectProjectId("1234567")).toBe(false);
  });
});

describe("resolveWalletConnectProjectId", () => {
  it("returns the first configured candidate", () => {
    expect(
      resolveWalletConnectProjectId(
        undefined,
        "",
        WALLETCONNECT_PROJECT_ID_PLACEHOLDER,
        "  real-project-id-001  ",
        "second-valid-id",
      ),
    ).toBe("real-project-id-001");
  });

  it("returns null when every candidate is unusable", () => {
    expect(
      resolveWalletConnectProjectId(
        undefined,
        null,
        "",
        "   ",
        WALLETCONNECT_PROJECT_ID_PLACEHOLDER,
        "todo",
        "short",
      ),
    ).toBeNull();
  });

  it("never invents a fallback when called with no arguments", () => {
    expect(resolveWalletConnectProjectId()).toBeNull();
  });
});

describe("buildStewardEvmConfig fail-closed paths", () => {
  it("registers only the injected connector when project id is null", async () => {
    const config = buildStewardEvmConfig({
      appUrl: "https://elizacloud.ai",
      walletConnectProjectId: null,
      alchemyKey: undefined,
    });
    const connectors = config.connectors ?? [];
    // Injected-only: browser extensions still work; WalletConnect QR is not
    // mounted without a real project id (#18459).
    expect(connectors.map((c) => c.id)).toEqual(["injected"]);
    expect(connectors.map((c) => c.type)).toEqual(["injected"]);
  });

  it("registers only injected and WalletConnect when a real project id is provided", async () => {
    const withProjectId = buildStewardEvmConfig({
      appUrl: "https://elizacloud.ai",
      walletConnectProjectId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
      alchemyKey: undefined,
    });
    const withoutProjectId = buildStewardEvmConfig({
      appUrl: "https://elizacloud.ai",
      walletConnectProjectId: null,
      alchemyKey: undefined,
    });
    const withConnectors = withProjectId.connectors ?? [];
    const withoutConnectors = withoutProjectId.connectors ?? [];
    // Keep the configured path deliberately narrow. RainbowKit's default
    // wallet set pulls vendor SDKs with embedded public telemetry/provider
    // keys into the shipped app even when those wallets are never selected.
    // RainbowKit supplies deterministic mock connectors for its two requested
    // wallet definitions under Node/jsdom. In a browser they resolve to the
    // injected and WalletConnect connectors represented by those definitions.
    expect(withConnectors.map((c) => c.id)).toEqual([
      "injected",
      "mock",
      "mock",
    ]);
    expect(withConnectors).toHaveLength(3);
    expect(withoutConnectors.map((c) => c.id)).toEqual(["injected"]);
  });
});
