/** Verifies the connector channel-mode lens through the package's configured test harness. */
// @vitest-environment jsdom
/**
 * Covers the localStorage-backed Delegate/Bot lens store and how the lens
 * filters the connector-mode registry: per-connector support, per-mode
 * filtering in `getConnectorModes`, and lens-neutrality of unclassified
 * connectors. In-memory registry + jsdom localStorage, no runtime.
 */

import { afterEach, describe, expect, it } from "vitest";
import { getConnectorModes } from "./ConnectorModeSelector.helpers";
import {
  getConnectorChannelMode,
  setConnectorChannelMode,
} from "./connector-channel-mode";
import {
  connectorSupportsChannelMode,
  getConnectorModeHiddenConfigKeys,
} from "./connector-mode-registry";

afterEach(() => {
  setConnectorChannelMode("delegate");
  window.localStorage.clear();
});

describe("connector channel-mode store", () => {
  it("defaults to delegate and persists an explicit choice", () => {
    expect(getConnectorChannelMode()).toBe("delegate");
    setConnectorChannelMode("bot");
    expect(getConnectorChannelMode()).toBe("bot");
    expect(window.localStorage.getItem("eliza:connectors:channelMode")).toBe(
      "bot",
    );
  });
});

describe("connectorSupportsChannelMode", () => {
  it("keeps mixed-role plugin-managed inventories in both lenses", () => {
    // Slack's declared app-token modes are bots, but stored plugin-managed
    // records can independently be OWNER, AGENT, or TEAM.
    expect(connectorSupportsChannelMode("slack", "bot")).toBe(true);
    expect(connectorSupportsChannelMode("slack", "delegate")).toBe(true);
  });

  it("keeps dual-identity connectors in both lenses", () => {
    for (const connector of ["discord", "telegram", "whatsapp"]) {
      expect(connectorSupportsChannelMode(connector, "delegate")).toBe(true);
      expect(connectorSupportsChannelMode(connector, "bot")).toBe(true);
    }
  });

  it("offers native and hosted iMessage in their respective lenses", () => {
    expect(connectorSupportsChannelMode("imessage", "delegate")).toBe(true);
    expect(connectorSupportsChannelMode("imessage", "bot")).toBe(true);
  });

  it("classifies single-form connectors through the registered fallback", () => {
    // Bluesky's credential form configures the agent's own account → bot only.
    expect(connectorSupportsChannelMode("bluesky", "bot")).toBe(true);
    expect(connectorSupportsChannelMode("bluesky", "delegate")).toBe(false);
    // Instagram credentials are the owner's own account → delegate only.
    expect(connectorSupportsChannelMode("instagram", "delegate")).toBe(true);
    expect(connectorSupportsChannelMode("instagram", "bot")).toBe(false);
  });

  it("treats unknown connectors with no declared modes as lens-neutral", () => {
    expect(connectorSupportsChannelMode("acmechat-unknown", "delegate")).toBe(
      true,
    );
    expect(connectorSupportsChannelMode("acmechat-unknown", "bot")).toBe(true);
  });
});

describe("getConnectorModes channel-mode filtering", () => {
  it("keeps only the lens's modes for a dual-identity connector", () => {
    const delegate = getConnectorModes("telegram", {
      elizaCloudConnected: true,
      channelMode: "delegate",
    }).map((mode) => mode.id);
    const bot = getConnectorModes("telegram", {
      elizaCloudConnected: true,
      channelMode: "bot",
    }).map((mode) => mode.id);

    expect(delegate).toContain("account");
    expect(delegate).not.toContain("bot");
    expect(delegate).not.toContain("cloud-bot");
    expect(bot).toContain("bot");
    expect(bot).toContain("cloud-bot");
    expect(bot).not.toContain("account");
  });

  it("keeps plugin-managed mode available for actual-role filtering", () => {
    for (const connector of ["telegram", "slack"]) {
      for (const channelMode of ["delegate", "bot"] as const) {
        const ids = getConnectorModes(connector, { channelMode }).map(
          (mode) => mode.id,
        );
        expect(ids).toContain("plugin-managed");
      }
    }
  });

  it("applies the same fallback lens policy to catalog-backed detail modes", () => {
    // Google is Delegate-only via fallback + catalog plugin-managed inventory.
    // Index classification and getConnectorModes must agree so a Bot deep link
    // cannot expose plugin-managed / AGENT inventory under the wrong lens.
    expect(connectorSupportsChannelMode("google", "delegate")).toBe(true);
    expect(connectorSupportsChannelMode("google", "bot")).toBe(false);

    const delegateIds = getConnectorModes("google", {
      channelMode: "delegate",
    }).map((mode) => mode.id);
    const botIds = getConnectorModes("google", { channelMode: "bot" }).map(
      (mode) => mode.id,
    );

    expect(delegateIds).toContain("plugin-managed");
    expect(botIds).not.toContain("plugin-managed");
    expect(botIds).toEqual([]);
  });

  it("hides delegate-only QR settings from WhatsApp Business mode", () => {
    expect(getConnectorModeHiddenConfigKeys("whatsapp", "business")).toEqual([
      "WHATSAPP_AUTH_METHOD",
      "WHATSAPP_AUTH_DIR",
      "WHATSAPP_PRINT_QR",
    ]);
    expect(getConnectorModeHiddenConfigKeys("whatsapp", "qr")).toEqual([]);
  });

  it("leaves the mode list unfiltered when no lens is given", () => {
    const ids = getConnectorModes("telegram", {
      elizaCloudConnected: true,
    }).map((mode) => mode.id);
    expect(ids).toEqual(
      expect.arrayContaining(["account", "bot", "cloud-bot"]),
    );
  });
});
