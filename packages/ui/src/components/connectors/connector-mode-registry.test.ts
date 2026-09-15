/**
 * Seam test for the connector-mode registry (#12094 item 1): a connector plugin
 * whose id appears nowhere in this package can register its modes and get a
 * fully working mode selector. In-memory registry, no runtime.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { getBootConfig, setBootConfig } from "../../config/boot-config";
import {
  getConnectorModes,
  getDefaultConnectorModeId,
  modeToSetupPluginId,
} from "./ConnectorModeSelector.helpers";
import { hasConnectorSetupPanel } from "./ConnectorSetupPanel.helpers";
import {
  type ConnectorModeDeclaration,
  connectorDeclaresCloudGatewaySetup,
  getConnectorManagedGatewayProvider,
  getConnectorModeCloudGatewaySetup,
  getConnectorModeConfigFormHint,
  registerConnectorModes,
} from "./connector-mode-registry";
import { resolveConnectorSetupPanelToken } from "./connector-setup-panel-registry";

/**
 * Seam test for #12094 item 1: the connector setup mode list and copy must come
 * from plugin-declared metadata, not a per-connector switch in the ui package.
 * A connector plugin whose id appears nowhere in ui source can register its
 * modes and get a fully functioning mode selector.
 */
describe("connector mode registry seam", () => {
  it("renders a connector absent from ui source purely from its declared modes", () => {
    // "acmechat" is a fictional connector plugin — it is not referenced in any
    // switch or map in the ui package. It only exists via registration.
    const declared: ConnectorModeDeclaration[] = [
      {
        id: "cloud",
        label: "Acme Cloud",
        description: "Route Acme Chat through the Acme Cloud gateway.",
        managementMode: "cloud-managed",
        setupPluginId: "acmechat",
        cloudOnly: true,
        defaultPriority: 1,
      },
      {
        id: "token",
        label: "API Token",
        description: "Use an Acme Chat API token from the developer console.",
        managementMode: "local-config",
        setupPluginId: "acmechat",
        defaultPriority: 2,
      },
    ];
    registerConnectorModes("@elizaos/plugin-acmechat", declared);

    // Cloud disconnected: the cloud-only mode is filtered out, leaving the
    // declared token mode — no hardcoded branch required.
    const offline = getConnectorModes("acmechat", {
      elizaCloudConnected: false,
    });
    expect(offline.map((mode) => mode.id)).toEqual(["token"]);
    expect(offline[0]?.label).toBe("API Token");
    expect(offline[0]?.managementMode).toBe("local-config");

    // Cloud connected: both declared modes render in declared order.
    const online = getConnectorModes("acmechat", { elizaCloudConnected: true });
    expect(online.map((mode) => mode.id)).toEqual(["cloud", "token"]);

    // Setup routing and default selection derive from the declaration.
    expect(modeToSetupPluginId("acmechat", "token")).toBe("acmechat");
    expect(modeToSetupPluginId("acmechat", "cloud")).toBe("acmechat");
    expect(getDefaultConnectorModeId("acmechat", online)).toBe("cloud");
    expect(getDefaultConnectorModeId("acmechat", offline)).toBe("token");

    // The connector id is accepted in its raw namespaced form too.
    expect(
      getConnectorModes("@elizaos/plugin-acmechat", {}).map((mode) => mode.id),
    ).toEqual(["token"]);
  });

  it("preserves the built-in Discord modes (cloud gating + default)", () => {
    const offline = getConnectorModes("discord", {
      elizaCloudConnected: false,
    });
    expect(offline.map((mode) => mode.id)).toEqual(["local", "bot"]);
    expect(getDefaultConnectorModeId("discord", offline)).toBe("bot");

    const online = getConnectorModes("discord", { elizaCloudConnected: true });
    expect(online.map((mode) => mode.id)).toEqual(["managed", "local", "bot"]);
    expect(modeToSetupPluginId("discord", "local")).toBe("discordlocal");
    expect(modeToSetupPluginId("discord", "bot")).toBe("discord");
  });

  it("hides only co-located desktop modes in managed Cloud containers", () => {
    expect(
      getConnectorModes("discord", {
        elizaCloudConnected: true,
        cloudProvisioned: true,
      }).map((mode) => mode.id),
    ).toEqual(["managed", "bot"]);
    expect(
      getConnectorModes("imessage", {
        elizaCloudConnected: true,
        cloudProvisioned: true,
      }).map((mode) => mode.id),
    ).toEqual(["blooio"]);

    expect(
      getConnectorModes("telegram", {
        elizaCloudConnected: true,
        cloudProvisioned: true,
      }).map((mode) => mode.id),
    ).toContain("account");
    expect(getConnectorModes("signal", { cloudProvisioned: true })).toEqual([]);
    expect(
      getConnectorModes("whatsapp", { cloudProvisioned: true }).map(
        (mode) => mode.id,
      ),
    ).toContain("qr");
  });

  it("keeps co-located desktop modes outside managed Cloud containers", () => {
    expect(
      getConnectorModes("discord", {
        elizaCloudConnected: true,
        cloudProvisioned: false,
      }).map((mode) => mode.id),
    ).toContain("local");
    expect(
      getConnectorModes("imessage", {
        elizaCloudConnected: true,
        cloudProvisioned: false,
      }).map((mode) => mode.id),
    ).toContain("direct");
  });

  it("applies Cloud connectivity and managed-container filtering independently", () => {
    registerConnectorModes("cloud-filter-seam", [
      {
        id: "cloud",
        label: "Cloud",
        description: "Requires an Eliza Cloud connection.",
        setupPluginId: "cloud-filter-seam",
        cloudOnly: true,
      },
      {
        id: "desktop",
        label: "Desktop",
        description: "Requires a co-located desktop.",
        setupPluginId: "cloud-filter-seam",
        hideOnManagedCloud: true,
      },
      {
        id: "always",
        label: "Always",
        description: "Available in every hosting configuration.",
        setupPluginId: "cloud-filter-seam",
      },
    ]);

    expect(
      getConnectorModes("cloud-filter-seam", {
        elizaCloudConnected: false,
        cloudProvisioned: false,
      }).map((mode) => mode.id),
    ).toEqual(["desktop", "always"]);
    expect(
      getConnectorModes("cloud-filter-seam", {
        elizaCloudConnected: true,
        cloudProvisioned: true,
      }).map((mode) => mode.id),
    ).toEqual(["cloud", "always"]);
  });

  it("offers hosted and native iMessage with native as the local default", () => {
    const offline = getConnectorModes("imessage", {
      elizaCloudConnected: false,
    });
    expect(offline.map((mode) => mode.id)).toEqual(["blooio", "direct"]);
    expect(getDefaultConnectorModeId("imessage", offline)).toBe("direct");

    const online = getConnectorModes("imessage", {
      elizaCloudConnected: true,
    });
    expect(online.map((mode) => mode.id)).toEqual(["blooio", "direct"]);
    expect(getDefaultConnectorModeId("imessage", online)).toBe("direct");
  });

  it("treats twitter as an alias of x (dead case is gone, not the behavior)", () => {
    expect(getConnectorModes("twitter", {}).map((m) => m.id)).toEqual(
      getConnectorModes("x", {}).map((m) => m.id),
    );
    expect(modeToSetupPluginId("twitter", "developer")).toBe("x");
  });

  it("resolves the built-in setup panels for declared local-setup modes", () => {
    expect(hasConnectorSetupPanel("discordlocal")).toBe(true);
    expect(hasConnectorSetupPanel("telegramaccount")).toBe(true);
    // A namespaced telegram plugin id still resolves to the bot panel.
    expect(hasConnectorSetupPanel("@elizaos/plugin-telegram")).toBe(true);
    // A connector with no built-in panel and no declared modes stays false.
    expect(hasConnectorSetupPanel("acmechat")).toBe(false);
    expect(getConnectorModes("farcaster", {})).toHaveLength(0);
  });
});

/**
 * The LifeOps browser-bridge panel is host-provided (a boot-config slot), not a
 * statically bundled panel. Its presence gating must live in the setup-panel
 * registry — not as a per-connector branch in ConnectorSetupPanel.helpers.ts.
 * These tests drive the real getBootConfig/setBootConfig path.
 */
describe("browser-bridge panel availability gating", () => {
  const StubBrowserPanel: ComponentType<Record<string, never>> = () => null;

  afterEach(() => {
    const { lifeOpsBrowserSetupPanel: _drop, ...rest } = getBootConfig();
    void _drop;
    setBootConfig(rest);
  });

  it("hides the browser-bridge panel until the host supplies it", () => {
    // No host panel: the registry rule's `available` gate blocks the token, so
    // both id forms report no setup panel.
    expect(resolveConnectorSetupPanelToken("lifeopsbrowser")).toBeNull();
    expect(hasConnectorSetupPanel("lifeopsbrowser")).toBe(false);
    expect(hasConnectorSetupPanel("@elizaos/plugin-browser-bridge")).toBe(
      false,
    );
  });

  it("resolves the browser-bridge token once the host provides the panel", () => {
    setBootConfig({
      ...getBootConfig(),
      lifeOpsBrowserSetupPanel: StubBrowserPanel,
    });

    // Both the namespaced and short connector ids now resolve to the token,
    // and the boolean helper agrees — with zero connector-id code in the helper.
    expect(resolveConnectorSetupPanelToken("lifeopsbrowser")).toBe(
      "lifeops-browser",
    );
    expect(hasConnectorSetupPanel("lifeopsbrowser")).toBe(true);
    expect(hasConnectorSetupPanel("@elizaos/plugin-browser-bridge")).toBe(true);
  });
});

/**
 * Seam tests for the connector-mode UI-affordance metadata (#12090 item 28).
 * The connector page and settings config form used to decide which gateway
 * surface / config hint to render by matching `plugin.id` + mode id string
 * literals (`plugin.id === "discord" && selectedMode === "managed"`, etc.).
 * That branching now reads owner-declared metadata, so a connector plugin
 * absent from ui source gets the right affordance purely from its declaration.
 */
describe("connector-mode UI-affordance metadata (#12090 item 28)", () => {
  it("resolves the cloud-gateway setup affordance from the selected mode's declaration", () => {
    // Built-in connectors declare their gateway affordance, not a hardcoded id.
    expect(getConnectorModeCloudGatewaySetup("discord", "managed")).toBe(
      "managed-agent-picker",
    );
    expect(getConnectorModeCloudGatewaySetup("telegram", "cloud-bot")).toBe(
      "webhook-notice",
    );
    // Non-gateway modes and unknown modes declare nothing.
    expect(getConnectorModeCloudGatewaySetup("discord", "bot")).toBeNull();
    expect(getConnectorModeCloudGatewaySetup("discord", "nope")).toBeNull();
    expect(getConnectorModeCloudGatewaySetup("discord", null)).toBeNull();
  });

  it("resolves the managed-gateway provisioning provider a connector declares", () => {
    // The Discord managed picker is keyed on the declared provider, not the
    // plugin id, so the connector page renders the Discord-specific
    // provisioning flow only for the connector that declared it.
    expect(getConnectorManagedGatewayProvider("discord")).toBe(
      "eliza-cloud-discord",
    );
    // Telegram's gateway is a webhook-notice, not a managed-agent picker, so it
    // declares no provisioning provider.
    expect(getConnectorManagedGatewayProvider("telegram")).toBeNull();
    expect(getConnectorManagedGatewayProvider("x")).toBeNull();
  });

  it("reports whether a connector declares any mode of a gateway-setup kind", () => {
    expect(
      connectorDeclaresCloudGatewaySetup("telegram", "webhook-notice"),
    ).toBe(true);
    expect(
      connectorDeclaresCloudGatewaySetup("discord", "managed-agent-picker"),
    ).toBe(true);
    // Discord has no webhook-notice mode; telegram has no managed-agent picker.
    expect(
      connectorDeclaresCloudGatewaySetup("discord", "webhook-notice"),
    ).toBe(false);
    expect(
      connectorDeclaresCloudGatewaySetup("telegram", "managed-agent-picker"),
    ).toBe(false);
  });

  it("resolves the owner-declared config-form hint for a connector mode", () => {
    const hint = getConnectorModeConfigFormHint("discord", "bot");
    expect(hint?.key).toBe("settings.sections.connectors.discordAppIdHint");
    expect(hint?.fallback).toContain("Application ID is optional");
    // Falls back to the connector's declared hint when no mode id is given
    // (single-mode connectors have no selector), and is null for connectors
    // that declare none.
    expect(getConnectorModeConfigFormHint("discord", null)?.fallback).toContain(
      "Application ID is optional",
    );
    expect(getConnectorModeConfigFormHint("telegram", "bot")).toBeNull();
  });

  it("drives the affordance for a connector absent from ui source (no hardcoded id)", () => {
    // A fictional connector whose id appears in no switch/branch in the ui
    // package. It only exists via registration, yet resolves affordances.
    registerConnectorModes("acmegateway", [
      {
        id: "hosted",
        label: "Acme Hosted",
        description: "Route Acme through the Acme Cloud gateway agent.",
        managementMode: "cloud-managed",
        setupPluginId: "acmegateway",
        cloudOnly: true,
        cloudGatewaySetup: "managed-agent-picker",
      },
      {
        id: "webhook",
        label: "Acme Webhook",
        description: "Acme still needs a token; the cloud hosts its webhook.",
        managementMode: "cloud-managed",
        setupPluginId: "acmegateway",
        cloudOnly: true,
        cloudGatewaySetup: "webhook-notice",
      },
      {
        id: "token",
        label: "Acme Token",
        description: "Use an Acme API token.",
        managementMode: "local-config",
        setupPluginId: "acmegateway",
        configFormHintKey: "connectors.acme.tokenHint",
        configFormHint: "Acme token is scoped per workspace.",
      },
    ]);

    expect(getConnectorModeCloudGatewaySetup("acmegateway", "hosted")).toBe(
      "managed-agent-picker",
    );
    expect(getConnectorModeCloudGatewaySetup("acmegateway", "webhook")).toBe(
      "webhook-notice",
    );
    expect(
      connectorDeclaresCloudGatewaySetup("acmegateway", "webhook-notice"),
    ).toBe(true);
    // Acme declares a managed-agent picker but no provisioning provider, so it
    // is NOT routed through the Discord provisioning flow — the connector page
    // renders the Discord picker only for the declared eliza-cloud-discord
    // provider (regression guard for the generic-vs-Discord-provisioning gap).
    expect(getConnectorManagedGatewayProvider("acmegateway")).toBeNull();
    expect(
      getConnectorModeConfigFormHint("acmegateway", "token")?.fallback,
    ).toBe("Acme token is scoped per workspace.");
  });
});

/**
 * Grep guard (#12090 item 28): the connector page and settings config form must
 * not reintroduce hardcoded connector-id branching for the gateway/notice/hint
 * affordances that are now declared in the connector-mode registry.
 */
describe("connector UI branching drift guard (#12090 item 28)", () => {
  const readSource = (relPath: string): string => {
    // Resolve against this test file so it works from any cwd/worktree.
    const url = new URL(relPath, import.meta.url);
    return readFileSync(fileURLToPath(url), "utf8");
  };

  it("plugin-view-connectors.tsx has no plugin-id/mode-literal gateway branches", () => {
    const src = readSource("../pages/plugin-view-connectors.tsx");
    // The old duck-typed capability branches must be gone from executable code.
    expect(src).not.toMatch(/plugin\.id\s*===\s*"discord"/);
    expect(src).not.toMatch(/plugin\.id\s*===\s*"telegram"/);
    expect(src).not.toMatch(/selectedMode\s*===\s*"managed"/);
    expect(src).not.toMatch(/selectedMode\s*===\s*"cloud-bot"/);
    // The twitter OAuth-initiation dispatch is registry-driven now.
    expect(src).not.toMatch(/\.platform\s*===\s*"twitter"/);
    // It reads the declared affordance helpers instead — including keying the
    // managed picker on the declared provisioning provider, not the plugin id.
    expect(src).toContain("getConnectorModeCloudGatewaySetup");
    expect(src).toContain("connectorDeclaresCloudGatewaySetup");
    expect(src).toContain("getConnectorManagedGatewayProvider");
  });

  it("ConnectorsSection.tsx resolves the config-form hint from the registry", () => {
    const src = readSource("../settings/ConnectorsSection.tsx");
    expect(src).not.toMatch(/plugin\.id\s*===\s*"discord"/);
    expect(src).toContain("getConnectorModeConfigFormHint");
  });
});
