/**
 * Registry of connector setup-mode declarations, keyed by connector id (#12094).
 *
 * A connector's setup UI (`ConnectorModeSelector`) renders its mode selector
 * generically from these declarations rather than a per-connector `switch`, so
 * a connector plugin whose id appears nowhere in this package still gets a
 * working mode selector by calling {@link registerConnectorModes} — the same
 * pattern `registerConnectorSetupPanel` uses for panels. Built-in connectors
 * are seeded at module load below; `ConnectorModeSelector.helpers.ts` reads
 * back through {@link getDeclaredConnectorModes}.
 */

import {
  type ConnectorManagementMode,
  getConnectorPluginManagedAccountOption,
  normalizeConnectorCatalogId,
} from "./connector-account-options";
import type { ConnectorChannelMode } from "./connector-channel-mode";

/**
 * Declarative description of a single connector setup mode: the metadata a
 * connector plugin declares (in its registry entry / manifest) so the setup UI
 * can render its mode selector without hardcoding the connector.
 */
/**
 * The kind of cloud-gateway setup affordance a connector mode declares. Read by
 * the connector page to render the correct gateway surface without hardcoding
 * connector ids. See {@link ConnectorModeDeclaration.cloudGatewaySetup}.
 */
export type ConnectorCloudGatewaySetup =
  | "managed-agent-picker"
  | "phone-registration"
  | "webhook-notice";

/**
 * The hosted-gateway provisioning flow backing a `"managed-agent-picker"` mode.
 * Each value maps to a bespoke provisioning handler + copy in the connector
 * page. Currently only the managed-Discord flow exists.
 */
export type ConnectorManagedGatewayProvider = "eliza-cloud-discord";

export interface ConnectorModeDeclaration {
  /** Mode id, unique within a connector. */
  id: string;
  label: string;
  description: string;
  labelKey?: string;
  descriptionKey?: string;
  managementMode?: ConnectorManagementMode;
  /**
   * Plugin id whose `ConnectorSetupPanel` renders this mode's setup surface.
   * When it equals the connector id the generic env-var config form is used.
   */
  setupPluginId: string;
  /** Mode is only offered when Eliza Cloud is connected. */
  cloudOnly?: boolean;
  /** Mode is unavailable inside a managed Eliza Cloud agent container. */
  hideOnManagedCloud?: boolean;
  /**
   * Which global channel-mode lens this setup mode belongs to: `"delegate"`
   * when the agent acts through the owner's own account on the platform, or
   * `"bot"` when the agent runs as its own bot identity the owner messages.
   * The Connectors surface filters modes (and connectors) by the active lens.
   * Omitted = the mode is identity-neutral and shown under both lenses.
   */
  channelMode?: ConnectorChannelMode;
  /**
   * UI affordance a cloud-managed gateway mode declares so the connector page
   * renders the right gateway setup surface generically, instead of matching
   * `plugin.id` + mode id string literals (#12090 item 28).
   *
   * - `"managed-agent-picker"`: this mode is backed by a hosted Eliza Cloud
   *   gateway the user provisions/picks an agent for (e.g. managed Discord).
   *   Treated as cloud-backed for the connector's Ready state.
   * - `"phone-registration"`: this mode registers a user-owned phone relay;
   *   each verified sender routes to that sender's own Cloud agent.
   * - `"webhook-notice"`: this mode still needs local credentials but Eliza
   *   Cloud can host its inbound webhook, so the page shows a gateway hint
   *   (e.g. Telegram cloud gateway) without picking a hosted agent.
   *
   * Omitted for modes that need no cloud-gateway affordance. The picker/notice
   * bodies themselves stay owned by the connector (their copy + handlers), but
   * *which* affordance to show is resolved from this declared capability.
   */
  cloudGatewaySetup?: ConnectorCloudGatewaySetup;
  /**
   * For a `"managed-agent-picker"` mode, the id of the hosted-gateway
   * provisioning flow that backs it. The connector page renders the matching
   * provider-specific picker (its bespoke provisioning handler + copy) keyed on
   * this declared value instead of the connector's plugin id (#12090 item 28).
   * Only `"eliza-cloud-discord"` exists today (managed Discord); a connector
   * declaring `managed-agent-picker` with an unknown/undeclared provider gets
   * no picker rather than being misrouted through the Discord flow.
   */
  cloudGatewayProvider?: ConnectorManagedGatewayProvider;
  /**
   * Optional owner-declared footnote rendered beneath this mode's env-config
   * form (e.g. Discord's "Application ID is optional, auto-resolved from the
   * bot token" hint). Declared here so the settings config form does not match
   * `plugin.id === "discord"` to decide whether to show it (#12090 item 28).
   * `configFormHintKey` is the i18n key; `configFormHint` is the default copy.
   */
  configFormHintKey?: string;
  configFormHint?: string;
  /** Config keys belonging to another setup mode and hidden for this mode. */
  hiddenConfigKeys?: readonly string[];
  /**
   * Preference rank when picking the default selected mode (lower wins). Ties
   * are broken by declaration order. Modes without a rank are never chosen as
   * the default unless no ranked mode is available.
   */
  defaultPriority?: number;
}

const registry = new Map<string, readonly ConnectorModeDeclaration[]>();

/**
 * Register the setup modes a connector plugin declares. The connector id is
 * normalized (`@elizaos/plugin-x` / `twitter` → `x`, etc.) before storage, so
 * callers can pass raw plugin ids. Re-registering a connector replaces its
 * declared modes.
 */
export function registerConnectorModes(
  connectorId: string,
  modes: readonly ConnectorModeDeclaration[],
): void {
  registry.set(normalizeConnectorCatalogId(connectorId), modes);
}

/**
 * Returns the modes a connector has declared, or an empty list when the
 * connector is unknown to the registry (it then falls back to its generic
 * credential form, matching the pre-registry behavior for connectors with no
 * declared mode list).
 */
export function getDeclaredConnectorModes(
  connectorId: string,
): readonly ConnectorModeDeclaration[] {
  return registry.get(normalizeConnectorCatalogId(connectorId)) ?? [];
}

/**
 * Resolves the cloud-gateway setup affordance a connector's *selected* mode
 * declares, or `null` when the mode declares none (or is unknown). Lets the
 * connector page decide which gateway surface to render from owner-declared
 * metadata instead of matching `plugin.id` + mode id string literals
 * (#12090 item 28).
 */
export function getConnectorModeCloudGatewaySetup(
  connectorId: string,
  modeId: string | null | undefined,
): ConnectorCloudGatewaySetup | null {
  if (!modeId) return null;
  return (
    getDeclaredConnectorModes(connectorId).find((mode) => mode.id === modeId)
      ?.cloudGatewaySetup ?? null
  );
}

/**
 * Whether a connector declares *any* mode with the given cloud-gateway setup
 * affordance, regardless of which mode is currently selected. Lets the
 * connector page show a gateway hint (e.g. "connect Eliza Cloud for webhook
 * hosting") for connectors that support that gateway kind, without hardcoding
 * the connector id (#12090 item 28).
 */
export function connectorDeclaresCloudGatewaySetup(
  connectorId: string,
  setup: ConnectorCloudGatewaySetup,
): boolean {
  return getDeclaredConnectorModes(connectorId).some(
    (mode) => mode.cloudGatewaySetup === setup,
  );
}

/**
 * The managed-gateway provisioning provider a connector declares for its
 * `"managed-agent-picker"` mode, or `null` when the connector declares no such
 * mode or leaves the provider undeclared. The connector page renders the
 * matching provider-specific picker keyed on this value, so a connector cannot
 * be misrouted through a provider flow it did not declare (#12090 item 28).
 */
export function getConnectorManagedGatewayProvider(
  connectorId: string,
): ConnectorManagedGatewayProvider | null {
  return (
    getDeclaredConnectorModes(connectorId).find(
      (mode) => mode.cloudGatewaySetup === "managed-agent-picker",
    )?.cloudGatewayProvider ?? null
  );
}

/**
 * A connector-declared config-form footnote: its default copy plus an optional
 * i18n key. `key` is omitted when the declaration provides no translation key,
 * so the consumer renders `fallback` directly instead of calling `t("")`.
 */
export interface ConnectorConfigFormHint {
  key?: string;
  fallback: string;
}

/**
 * Resolves the config-form footnote a connector's *selected* mode declares, or
 * `null` when that mode declares none. Lets the settings config form render the
 * hint generically instead of matching `plugin.id` (#12090 item 28).
 *
 * When `modeId` is null/undefined (single-mode connectors have no mode
 * selector) the connector's first hint-bearing mode is used. When `modeId` is
 * given but that specific mode declares no hint, `null` is returned — the hint
 * is scoped to the modes that declare it, so it does not leak onto an unrelated
 * selected mode.
 */
export function getConnectorModeHiddenConfigKeys(
  connectorId: string,
  modeId: string | null | undefined,
): readonly string[] {
  if (!modeId) return [];
  return (
    getDeclaredConnectorModes(connectorId).find((mode) => mode.id === modeId)
      ?.hiddenConfigKeys ?? []
  );
}

export function getConnectorModeConfigFormHint(
  connectorId: string,
  modeId: string | null | undefined,
): ConnectorConfigFormHint | null {
  const modes = getDeclaredConnectorModes(connectorId);
  const declaration = modeId
    ? modes.find((mode) => mode.id === modeId)
    : modes.find((mode) => mode.configFormHint !== undefined);
  if (!declaration?.configFormHint) return null;
  return declaration.configFormHintKey
    ? {
        key: declaration.configFormHintKey,
        fallback: declaration.configFormHint,
      }
    : { fallback: declaration.configFormHint };
}

/**
 * Channel-mode classification for connectors with NO declared mode list —
 * the single-credential-form connectors (bluesky, matrix, msteams, …) whose
 * whole setup surface belongs to one lens. Keyed by normalized connector id;
 * a connector plugin can register its own via
 * {@link registerConnectorChannelModeFallback}. Connectors absent from both
 * this map and the mode registry stay lens-neutral (shown under both lenses),
 * the safe default for unknown third-party connectors.
 */
const fallbackChannelModes = new Map<string, ConnectorChannelMode>();

export function registerConnectorChannelModeFallback(
  connectorId: string,
  channelMode: ConnectorChannelMode,
): void {
  fallbackChannelModes.set(
    normalizeConnectorCatalogId(connectorId),
    channelMode,
  );
}

/**
 * Whether a connector belongs under the given global channel-mode lens.
 *
 * A connector with declared modes matches when any mode is classified into the
 * lens (a mode omitting `channelMode` is lens-neutral and always matches). A
 * connector with no declared modes uses its registered fallback classification;
 * with neither, it shows under both lenses. A connector whose every declared
 * mode is classified into the *other* lens (e.g. Slack under `"delegate"`)
 * is filtered out of that lens by the Connectors surface.
 */
export function connectorSupportsChannelMode(
  connectorId: string,
  channelMode: ConnectorChannelMode,
): boolean {
  const modes = getDeclaredConnectorModes(connectorId);
  if (modes.length === 0) {
    const fallback = fallbackChannelModes.get(
      normalizeConnectorCatalogId(connectorId),
    );
    return fallback === undefined || fallback === channelMode;
  }
  const declaredModeMatches = modes.some(
    (mode) =>
      mode.channelMode === undefined || mode.channelMode === channelMode,
  );
  const hasManagedMode =
    getConnectorPluginManagedAccountOption(connectorId) !== null;
  return declaredModeMatches || hasManagedMode;
}

// ---------------------------------------------------------------------------
// Built-in connector mode declarations.
//
// Declaration order is significant — it is the exact order modes are presented
// (cloud-only modes are filtered out when Eliza Cloud is not connected, keeping
// their declared position). The plugin-managed mode is injected separately by
// `withPluginManagedMode` from the connector-account catalog, so it is not
// declared here.
// ---------------------------------------------------------------------------

registerConnectorModes("discord", [
  {
    id: "managed",
    label: "OAuth Gateway",
    labelKey: "connectormode.discord.managed.label",
    description:
      "Invite the shared Eliza Cloud Discord gateway, nickname it to your agent, and route messages down to this app.",
    descriptionKey: "connectormode.discord.managed.description",
    managementMode: "cloud-managed",
    setupPluginId: "discord",
    channelMode: "bot",
    cloudOnly: true,
    cloudGatewaySetup: "managed-agent-picker",
    cloudGatewayProvider: "eliza-cloud-discord",
  },
  {
    id: "local",
    label: "Desktop App",
    labelKey: "connectormode.discord.local.label",
    description: "Connect via local Discord desktop app (IPC)",
    descriptionKey: "connectormode.discord.local.description",
    managementMode: "local-setup",
    setupPluginId: "discordlocal",
    channelMode: "delegate",
    hideOnManagedCloud: true,
  },
  {
    id: "bot",
    label: "Bot Token",
    labelKey: "connectormode.discord.bot.label",
    description:
      "Use your own Discord bot with a token from the Developer Portal",
    descriptionKey: "connectormode.discord.bot.description",
    managementMode: "local-config",
    setupPluginId: "discord",
    channelMode: "bot",
    defaultPriority: 1,
    configFormHintKey: "settings.sections.connectors.discordAppIdHint",
    configFormHint:
      "Application ID is optional; it is auto-resolved from the bot token when possible.",
  },
]);

registerConnectorModes("telegram", [
  {
    id: "cloud-bot",
    label: "Cloud Gateway",
    labelKey: "connectormode.telegram.cloudBot.label",
    description:
      "Telegram bot communication still starts with a BotFather token; Eliza Cloud can host the webhook and route it to this app.",
    descriptionKey: "connectormode.telegram.cloudBot.description",
    managementMode: "cloud-managed",
    setupPluginId: "telegram",
    channelMode: "bot",
    cloudOnly: true,
    cloudGatewaySetup: "webhook-notice",
  },
  {
    id: "bot",
    label: "Bot Token",
    labelKey: "connectormode.telegram.bot.label",
    description: "Create a bot via @BotFather and paste the token",
    descriptionKey: "connectormode.telegram.bot.description",
    managementMode: "local-config",
    setupPluginId: "telegram",
    channelMode: "bot",
    defaultPriority: 1,
  },
  {
    id: "account",
    label: "Personal Account",
    labelKey: "connectormode.telegram.account.label",
    description:
      "Use your own Telegram account (requires app credentials from my.telegram.org)",
    descriptionKey: "connectormode.telegram.account.description",
    managementMode: "local-setup",
    setupPluginId: "telegramaccount",
    channelMode: "delegate",
  },
]);

registerConnectorModes("slack", [
  {
    id: "oauth",
    label: "OAuth",
    labelKey: "connectormode.slack.oauth.label",
    description:
      "Connect Slack through Eliza Cloud OAuth for workspace-scoped bidirectional access.",
    descriptionKey: "connectormode.slack.oauth.description",
    managementMode: "cloud-managed",
    setupPluginId: "slack",
    channelMode: "bot",
    cloudOnly: true,
    defaultPriority: 1,
  },
  {
    id: "socket",
    label: "Socket Mode Tokens",
    labelKey: "connectormode.slack.socket.label",
    description:
      "Use your own Slack app token and bot token for the local connector runtime.",
    descriptionKey: "connectormode.slack.socket.description",
    managementMode: "local-config",
    setupPluginId: "slack",
    channelMode: "bot",
    defaultPriority: 2,
  },
]);

registerConnectorModes("x", [
  {
    id: "oauth",
    label: "OAuth",
    labelKey: "connectormode.x.oauth.label",
    description:
      "Connect X/Twitter through Eliza Cloud OAuth so the agent can post, read mentions, and handle DMs through cloud-held tokens.",
    descriptionKey: "connectormode.x.oauth.description",
    managementMode: "cloud-managed",
    setupPluginId: "x",
    channelMode: "delegate",
    cloudOnly: true,
    defaultPriority: 1,
  },
  {
    id: "local-oauth",
    label: "Local OAuth2",
    labelKey: "connectormode.x.localOauth.label",
    description:
      "Use @elizaos/plugin-x with TWITTER_AUTH_MODE=oauth, a client ID, and a loopback redirect URI.",
    descriptionKey: "connectormode.x.localOauth.description",
    managementMode: "local-config",
    setupPluginId: "x",
    channelMode: "delegate",
    defaultPriority: 2,
  },
  {
    id: "developer",
    label: "Developer Tokens",
    labelKey: "connectormode.x.developer.label",
    description:
      "Use OAuth 1.0a API keys and access tokens from the X Developer Portal.",
    descriptionKey: "connectormode.x.developer.description",
    managementMode: "local-config",
    setupPluginId: "x",
    channelMode: "delegate",
  },
]);

registerConnectorModes("whatsapp", [
  {
    id: "qr",
    label: "QR Pair",
    labelKey: "connectormode.whatsapp.qr.label",
    description: "Scan a QR code from your WhatsApp mobile app",
    descriptionKey: "connectormode.whatsapp.qr.description",
    managementMode: "local-setup",
    setupPluginId: "whatsapp",
    channelMode: "delegate",
  },
  {
    id: "business",
    label: "Business Cloud API",
    labelKey: "connectormode.whatsapp.business.label",
    description:
      "Use WhatsApp Business API with access token and phone number ID",
    descriptionKey: "connectormode.whatsapp.business.description",
    managementMode: "local-config",
    setupPluginId: "whatsapp",
    channelMode: "bot",
    hiddenConfigKeys: [
      "WHATSAPP_AUTH_METHOD",
      "WHATSAPP_AUTH_DIR",
      "WHATSAPP_PRINT_QR",
    ],
  },
]);

registerConnectorModes("imessage", [
  {
    id: "blooio",
    label: "Hosted iMessage",
    description:
      "Connect a Blooio sender and signed webhook on this agent's server.",
    managementMode: "local-config",
    setupPluginId: "imessage",
    channelMode: "bot",
    configFormHint:
      "Choose blooio in Transport, enter the API key, webhook secret, sender number and channel ID, then save. Configure the provider's signed webhook for this agent before testing delivery.",
    hiddenConfigKeys: [
      "IMESSAGE_DB_PATH",
      "IMESSAGE_POLL_INTERVAL_MS",
      "IMESSAGE_HEARTBEAT_INTERVAL_MS",
      "IMESSAGE_BACKFILL",
    ],
    defaultPriority: 1,
  },
  {
    id: "direct",
    label: "Messages on this Mac",
    labelKey: "connectormode.imessage.direct.label",
    description:
      "Read iMessage database directly on this Mac. Requires Full Disk Access.",
    descriptionKey: "connectormode.imessage.direct.description",
    managementMode: "local-setup",
    setupPluginId: "imessage",
    channelMode: "delegate",
    hideOnManagedCloud: true,
    defaultPriority: 0,
  },
]);

// ---------------------------------------------------------------------------
// Channel-mode fallbacks for the single-form connectors (no declared mode
// list). "bot" = the connector configures the agent's own standalone account /
// bot app that the owner chats with; "delegate" = the credentials are the
// owner's own account, which the agent works inside. Connectors not listed
// here (and not in the mode registry) stay visible under both lenses.
// ---------------------------------------------------------------------------

for (const connectorId of [
  "bluesky",
  "farcaster",
  "nostr",
  "matrix",
  "msteams",
  "mattermost",
  "google-chat",
  "feishu",
  "line",
  "zalo",
  "tlon",
  "nextcloud-talk",
  "twitch",
]) {
  registerConnectorChannelModeFallback(connectorId, "bot");
}

for (const connectorId of ["instagram", "zalouser", "google"]) {
  registerConnectorChannelModeFallback(connectorId, "delegate");
}
