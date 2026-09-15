/**
 * Renderer for a single chat message body in the full ChatView. Parses the
 * message text into segments (`parseSegments`) — plain text with inline code,
 * fenced code blocks, `[CONFIG:…]` plugin cards, fenced UiSpec JSON, sensitive
 * secret requests, permission cards, account-connect blocks, and inline widget
 * markers (choice/form/followups/task) — and renders each with the matching
 * sub-component or registry entry, plus any attachments.
 *
 * This is the load-bearing chat surface: it shares the parser + inline-widget
 * registry with the overlay renderer (`InlineWidgetText`), so both stay in sync
 * (parser parity: parser-parity.contract.test.ts; tree parity:
 * render-parity.contract.test.tsx). The self-contained `InlinePluginConfig`,
 * `MessageUiSpecBlock`, `SensitiveRequestBlock`, and `MessagePermissionCard`
 * exports here drive their own mutations through the typed `ElizaClient`.
 */

import { stripUnclaimedInteractionMarkup } from "@elizaos/core";
import { isRetryableChatFailureKind } from "@elizaos/shared/contracts";
import { Check, ShieldCheck } from "lucide-react";
import {
  type FormEvent,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { client } from "../../api/client";
import type { ConversationMessage } from "../../api/client-types-chat";
import type { PluginInfo } from "../../api/client-types-config";
import { splitLeadingSlashCommand } from "../../chat/slash-menu";
import type { UiSpec } from "../../config/ui-spec";
import { dispatchConnectRequest } from "../../events";
import { normalizeRemoteAgentUrl } from "../../first-run/adopt-remote-first-run";
import { useRenderGuard } from "../../hooks/useRenderGuard";
import { cn } from "../../lib/utils";
import { isDesktopPlatform, isNative } from "../../platform";
import {
  createMobileSignalsPermissionsRegistry,
  openMobilePermissionSettings,
} from "../../platform/mobile-permissions-client";
import { useAppSelectorShallow } from "../../state";
import { useChatComposer } from "../../state/ChatComposerContext.hooks";
import { canNavigateSameTabForBlockedPopup } from "../../state/cloud-login-launch";
import {
  createClientPermissionsRegistry,
  type PermissionCardPayload,
} from "../composites/chat/permission-card.helpers";
import { renderPermissionCardFromPayload } from "../composites/chat/permission-card.render";
import { ConfigRenderer } from "../config-ui/config-renderer";
import { defaultRegistry } from "../config-ui/config-renderer.helpers";
import {
  type UiActionDispatchMetadata,
  UiRenderer,
} from "../config-ui/ui-renderer";
import { ToolCallEventLog } from "../tool-events/ToolCallEventLog";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { CodeBlock } from "../ui/code-block";
import { ErrorBoundary } from "../ui/error-boundary";
import { Input } from "../ui/input";
import { SemanticForm } from "../ui/semantic-form";
import { AccountConnectBlock } from "./AccountConnectBlock";
import { CapabilityHandoffBlock } from "./CapabilityHandoffBlock";
import {
  connectorWidgetModes,
  defaultConnectorWidgetModeId,
} from "./inline-connector-modes";
import { MessageAttachments } from "./MessageAttachments";
import {
  buildInlinePluginConfigModel,
  isSafeNormalizedPluginId,
  normalizePluginId,
  parseFormSubmitDisplay,
  sensitiveRequestStatusLabel,
  sensitiveRequestTitleLabel,
  splitInlineCode,
} from "./message-parser-helpers";
import { ThinkingBlock } from "./ThinkingBlock";
import { useParsedSegments } from "./use-parsed-segments";
import { ChatWidgetShell } from "./widgets/chat-widget-shell";
// Side effect: registers the built-in inline widgets (choice/followups/form/task).
import "./widgets/inline-builtins";
import { getInlineWidget } from "./widgets/inline-registry";
import { useInlineWidgetContext } from "./widgets/use-inline-widget-context";

interface MessageContentProps {
  message: ConversationMessage;
  analysisMode?: boolean;
}

/**
 * Render a text run, wrapping any inline `` `code` `` spans in the CodeBlock
 * inline primitive so they keep their place in the sentence. Returns the raw
 * string unchanged when there is no backticked span (the common case).
 */
/**
 * An OAuth authorizationUrl is an agent/cloud-supplied field that flows into
 * window.open(). A hosted consent screen is always https, so require https and
 * reject anything else — a `javascript:`/`data:` value would otherwise execute
 * in the opened window. `new URL()` also normalizes away control-char scheme
 * obfuscation (e.g. `java\tscript:`).
 */
function isHttpsAuthorizationUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length === 0) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    // error-policy:J3 untrusted URL from message content — fail closed
    return false;
  }
}

function renderInlineText(text: string): ReactNode {
  if (!text.includes("`")) return text;
  const parts = splitInlineCode(text);
  if (parts.length === 1 && parts[0].kind === "text") return text;
  // Key by the part's character offset in the source run (not the array index)
  // so keys stay stable across re-renders and don't trip noArrayIndexKey.
  let offset = 0;
  return parts.map((part) => {
    const content = part.kind === "code" ? part.code : part.text;
    const key = `${part.kind}:${offset}`;
    offset += content.length;
    return part.kind === "code" ? (
      <CodeBlock
        key={key}
        variant="inline"
        value={part.code}
        data-testid="inline-code"
      />
    ) : (
      <span key={key}>{part.text}</span>
    );
  });
}

/**
 * Render a plain-text message body. When the message is a user-typed slash
 * command (e.g. `/imagine a cat`), the leading `/command` token is rendered in
 * bold so it reads as a command in the transcript — matching the inline
 * autocomplete the composer shows while typing. Inline `` `code` `` spans render
 * in the inline code primitive while staying in the flow of the sentence.
 */
function MessageTextBody({
  text,
  boldSlashCommand,
}: {
  text: string;
  boldSlashCommand: boolean;
}) {
  const formSubmit = boldSlashCommand ? parseFormSubmitDisplay(text) : null;
  if (formSubmit) {
    return (
      <div className="whitespace-normal">
        <FormSubmitReceipt label={formSubmit.label} />
      </div>
    );
  }
  const slash = boldSlashCommand ? splitLeadingSlashCommand(text) : null;
  return (
    <div className="whitespace-pre-wrap">
      {slash ? (
        <>
          <span
            className="font-bold text-txt"
            data-testid="slash-command-token"
          >
            {slash.command}
          </span>
          {renderInlineText(slash.rest)}
        </>
      ) : (
        renderInlineText(text)
      )}
    </div>
  );
}

export function FormSubmitReceipt({ label }: { label: string }) {
  return (
    <div
      className="inline-flex max-w-full items-center py-1 text-xs font-medium text-muted-strong"
      data-testid="form-submit-receipt"
    >
      Submitted {label}
    </div>
  );
}

// ── InlinePluginConfig ──────────────────────────────────────────────

// The in-chat connector/plugin setup card for `[CONFIG:pluginId]` markers
// (#14412). All state (fetch status, field edits, mutations) is internal and
// the only prop is a primitive, so `memo` makes a transcript-parent re-render
// (streaming ticks, unrelated store updates) bail out before this subtree —
// the widget repaints only when its own state changes. Connection status is
// fetched inside, never derived from props at render, so memo cannot pin a
// stale status (the NotificationRow lesson).
export const InlinePluginConfig = memo(function InlinePluginConfig({
  pluginId: rawPluginId,
}: {
  pluginId: string;
}) {
  const pluginId = normalizePluginId(rawPluginId);
  const [plugin, setPlugin] = useState<PluginInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modeChoice, setModeChoice] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const mountedRef = useRef(true);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { setActionNotice, loadPlugins, t, elizaCloudConnected } =
    useAppSelectorShallow((s) => ({
      setActionNotice: s.setActionNotice,
      loadPlugins: s.loadPlugins,
      t: s.t,
      elizaCloudConnected: s.elizaCloudConnected,
    }));

  // Track mount state — reset to true on each mount (needed for StrictMode
  // which unmounts/remounts and would leave the ref false otherwise).
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, []);

  // Self-contained: fetch plugin data directly from API
  const fetchPlugin = useCallback(async () => {
    try {
      const { plugins } = await client.getPlugins();
      if (!mountedRef.current) return;
      const found = plugins.find((p) => p.id === pluginId);
      setPlugin(found ?? null);
    } catch {
      // error-policy:J4 load failure renders the card's error state
      if (mountedRef.current) {
        setError(
          t("messagecontent.LoadPluginInfoFailed", {
            defaultValue: "Couldn't load plugin info.",
          }),
        );
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [pluginId, t]);

  useEffect(() => {
    void fetchPlugin();
  }, [fetchPlugin]);

  const { hasConfigurableParams, hints, mergedValues, schema, setKeys } =
    useMemo(
      () => buildInlinePluginConfigModel(plugin, values),
      [plugin, values],
    );

  // "Connected" is the server's own setup verdict: enabled AND configured.
  // Hoisted above the early returns so the OAuth polling effect below can
  // observe it; drives the shell's collapse-on-connect.
  const connected = Boolean(plugin?.enabled && plugin?.configured);

  // Auth-mode switch (OAuth / token form / local bridge), projected from the
  // same connector-mode registry the Settings connectors page renders.
  const modes = useMemo(
    () =>
      connectorWidgetModes(pluginId, {
        elizaCloudConnected: Boolean(elizaCloudConnected),
      }),
    [pluginId, elizaCloudConnected],
  );
  const selectedModeId =
    modeChoice ?? defaultConnectorWidgetModeId(pluginId, modes);
  const selectedMode = modes.find((m) => m.id === selectedModeId) ?? null;
  // The first non-OAuth mode powers the "use an API key / local setup instead"
  // fallback link under a sign-in button — the required visible toggle away
  // from OAuth. Undefined when the connector is OAuth-only.
  const apiKeyModeId = modes.find((m) => m.kind !== "oauth")?.id ?? undefined;

  // Bounded refetch loop after a sign-in hand-off: the authorization finishes
  // in another window/app, so the card polls the plugin status until the
  // server reports connected (or gives up after ~1 minute). Collapse-on-connect
  // then follows from the status flip — no fabricated success.
  const beginConnectPolling = useCallback(() => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    let remaining = 20;
    const tick = async () => {
      remaining -= 1;
      await fetchPlugin();
      if (!mountedRef.current) return;
      if (remaining <= 0) {
        setSigningIn(false);
        return;
      }
      pollTimerRef.current = setTimeout(() => void tick(), 3000);
    };
    pollTimerRef.current = setTimeout(() => void tick(), 3000);
  }, [fetchPlugin]);

  useEffect(() => {
    if (!connected) return;
    setSigningIn(false);
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
  }, [connected]);

  // OAuth sign-in: start the connector's OAuth flow through the agent API and
  // open the returned authorization URL. https-only (isHttpsAuthorizationUrl)
  // because the URL is server-supplied data flowing into window.open.
  const handleOAuthSignIn = useCallback(async () => {
    setSigningIn(true);
    setError(null);
    try {
      const result = await client.startConnectorAccountOAuth(
        pluginId,
        pluginId,
        {},
      );
      const authUrl = result.authUrl;
      if (!isHttpsAuthorizationUrl(authUrl)) {
        throw new Error(
          result.error ??
            t("messagecontent.OAuthNoAuthUrl", {
              defaultValue:
                "The connector did not return an authorization link.",
            }),
        );
      }
      window.open(authUrl, "_blank", "noopener,noreferrer");
      beginConnectPolling();
    } catch (e: unknown) {
      // error-policy:J4 sign-in failure renders the card's error state
      if (mountedRef.current) {
        setSigningIn(false);
        setError(
          e instanceof Error
            ? e.message
            : t("messagecontent.OAuthStartFailed", {
                defaultValue: "Couldn't start the sign-in flow.",
              }),
        );
      }
    }
  }, [pluginId, beginConnectPolling, t]);

  // Discord desktop pairing is the one local mode with a one-click authorize
  // (local IPC, same call the Settings panel makes); other local modes render
  // their env form + guidance instead.
  const localSignIn = selectedMode?.setupPluginId === "discordlocal";
  const handleLocalSignIn = useCallback(async () => {
    setSigningIn(true);
    setError(null);
    try {
      await client.authorizeDiscordLocal();
      beginConnectPolling();
    } catch (e: unknown) {
      // error-policy:J4 sign-in failure renders the card's error state
      if (mountedRef.current) {
        setSigningIn(false);
        setError(
          e instanceof Error
            ? e.message
            : t("messagecontent.LocalSignInFailed", {
                defaultValue: "Couldn't authorize the desktop app.",
              }),
        );
      }
    }
  }, [beginConnectPolling, t]);

  const handleChange = useCallback((key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
    setError(null);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const patch: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) {
        if (v != null && v !== "") patch[k] = String(v);
      }
      await client.updatePlugin(pluginId, { config: patch });
      if (mountedRef.current) setSaved(true);
      await fetchPlugin();
    } catch (e: unknown) {
      // error-policy:J4 save failure renders the card's error state
      if (mountedRef.current) {
        setError(
          e instanceof Error
            ? e.message
            : t("messagecontent.SaveFailed", {
                defaultValue: "Couldn't save changes.",
              }),
        );
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, [pluginId, values, fetchPlugin, t]);

  const handleToggle = useCallback(
    async (enable: boolean) => {
      setEnabling(true);
      setError(null);
      try {
        // Save pending config first, then toggle — same as the Plugins page
        if (enable) {
          const patch: Record<string, string> = {};
          for (const [k, v] of Object.entries(values)) {
            if (v != null && v !== "") patch[k] = String(v);
          }
          if (Object.keys(patch).length > 0) {
            await client.updatePlugin(pluginId, { config: patch });
          }
        }
        // Exact same call as the ON button in PluginsView
        await client.updatePlugin(pluginId, { enabled: enable });
        // Refresh shared plugin state so Plugins page shows updated status
        await loadPlugins();
        if (enable && mountedRef.current) {
          const tabLabel =
            plugin?.category === "feature"
              ? t("messagecontent.FeaturesTabLabel", {
                  defaultValue: "Plugins > Features",
                })
              : plugin?.category === "connector"
                ? t("messagecontent.ConnectorsTabLabel", {
                    defaultValue: "Plugins > Connectors",
                  })
                : t("messagecontent.SystemTabLabel", {
                    defaultValue: "Plugins > System",
                  });
          setActionNotice(
            t("messagecontent.PluginEnabledNotice", {
              defaultValue: "{{name}} is on. Find it in {{tabLabel}}.",
              name: plugin?.name ?? pluginId,
              tabLabel,
            }),
            "success",
            4000,
          );
          // Optimistic connect: flip the local status so the shell collapses
          // to its compact summary immediately. The delayed refetch below
          // reconciles with the server and re-expands the card if the plugin
          // actually still needs configuration.
          setPlugin((prev) =>
            prev ? { ...prev, enabled: true, configured: true } : prev,
          );
        }
        // Wait for agent restart then refresh (with cleanup on unmount)
        refreshTimerRef.current = setTimeout(() => void fetchPlugin(), 3000);
      } catch (e: unknown) {
        // error-policy:J4 toggle failure renders the card's error state
        if (mountedRef.current) {
          setError(
            e instanceof Error
              ? e.message
              : enable
                ? t("messagecontent.EnablePluginFailed", {
                    defaultValue: "Couldn't enable this plugin.",
                  })
                : t("messagecontent.DisablePluginFailed", {
                    defaultValue: "Couldn't disable this plugin.",
                  }),
          );
        }
      } finally {
        if (mountedRef.current) setEnabling(false);
      }
    },
    [pluginId, plugin, values, fetchPlugin, loadPlugins, setActionNotice, t],
  );

  if (loading) {
    return (
      <div className="my-2 py-2 text-xs text-muted italic">
        {t("messagecontent.LoadingConfiguration", {
          defaultValue: "Loading {{pluginId}} configuration...",
          pluginId,
        })}
      </div>
    );
  }

  if (!plugin) {
    return (
      <div className="my-2 py-2 text-xs text-muted italic">
        {t("messagecontent.PluginNotFound", {
          defaultValue: 'Plugin "{{pluginId}}" not found.',
          pluginId,
        })}
      </div>
    );
  }

  const isEnabled = plugin.enabled;
  const showConfigForm =
    schema && hasConfigurableParams && selectedMode?.kind !== "oauth";

  return (
    <ChatWidgetShell
      testId="inline-plugin-config"
      complete={connected}
      icon={
        plugin.icon ? (
          <span className="text-sm">{plugin.icon}</span>
        ) : (
          <span className="text-sm opacity-60">{"\u2699\uFE0F"}</span>
        )
      }
      title={t("messagecontent.PluginConfigurationTitle", {
        defaultValue: "{{name}} Configuration",
        name: plugin.name,
      })}
      status={
        <>
          {plugin.configured && (
            <span className="text-2xs text-ok font-medium">
              {t("config-field.Configured")}
            </span>
          )}
          <span
            className={`text-2xs font-medium ${isEnabled ? "text-ok" : "text-muted"}`}
          >
            {isEnabled
              ? t("common.active", {
                  defaultValue: "Active",
                })
              : t("common.inactive", {
                  defaultValue: "Inactive",
                })}
          </span>
        </>
      }
      summary={
        <span className="text-ok">
          {t("messagecontent.PluginEnabledInlineNotice", {
            defaultValue: "{{name}} is enabled.",
            name: plugin.name ?? pluginId,
          })}
        </span>
      }
    >
      {/* Auth-mode switch — OAuth / API-key / local-bridge, when the connector
          declares more than one setup mode. A single-mode connector shows no
          switch (nothing to choose). */}
      {modes.length > 1 && (
        // biome-ignore lint/a11y/useSemanticElements: a mode-switch button row is a grouped toolbar, not a form field set — <fieldset> would add form semantics and legacy layout quirks.
        <div
          className="flex flex-wrap items-center gap-1.5 px-3 pt-3"
          role="group"
          aria-label={t("messagecontent.SetupModeLabel", {
            defaultValue: "Setup method",
          })}
          data-testid="inline-plugin-config-modes"
        >
          {modes.map((mode) => {
            const active = mode.id === selectedModeId;
            return (
              <Button
                key={mode.id}
                type="button"
                aria-pressed={active}
                title={mode.description}
                data-testid={`inline-plugin-config-mode-${mode.id}`}
                variant="selection"
                size="tiny"
                data-state={active ? "on" : "off"}
                onClick={() => {
                  setModeChoice(mode.id);
                  setError(null);
                }}
              >
                {mode.label}
              </Button>
            );
          })}
        </div>
      )}

      {/* OAuth sign-in — shown for a cloud/OAuth-shaped mode instead of the env
          form. The API-key / local fallback is always one click away below. */}
      {selectedMode?.kind === "oauth" && (
        <div className="py-1.5" data-testid="inline-plugin-config-oauth">
          <Button
            variant="default"
            size="denseWide"
            onClick={() => void handleOAuthSignIn()}
            disabled={signingIn}
            data-testid="inline-plugin-config-oauth-btn"
          >
            {signingIn
              ? t("messagecontent.OAuthSigningIn", {
                  defaultValue: "Waiting for sign-in…",
                })
              : t("messagecontent.OAuthSignIn", {
                  defaultValue: "Sign in with {{name}}",
                  name: plugin.name ?? pluginId,
                })}
          </Button>
          {apiKeyModeId && (
            <Button
              type="button"
              onClick={() => {
                setModeChoice(apiKeyModeId);
                setError(null);
              }}
              data-testid="inline-plugin-config-use-apikey"
              variant="mutedLink"
              size="content"
              className="mt-2 block"
            >
              {t("messagecontent.OAuthUseApiKey", {
                defaultValue: "Use an API key / local setup instead",
              })}
            </Button>
          )}
        </div>
      )}

      {/* Local desktop pairing (Discord IPC): one-click authorize instead of an
          env form, plus the mode's guidance text. */}
      {selectedMode?.kind === "local" && localSignIn && (
        <div className="py-1.5" data-testid="inline-plugin-config-local">
          {selectedMode.description && (
            <p className="mb-2 text-2xs text-muted">
              {selectedMode.description}
            </p>
          )}
          <Button
            variant="default"
            size="denseWide"
            onClick={() => void handleLocalSignIn()}
            disabled={signingIn}
            data-testid="inline-plugin-config-local-btn"
          >
            {signingIn
              ? t("messagecontent.LocalSigningIn", {
                  defaultValue: "Pairing…",
                })
              : t("messagecontent.LocalSignIn", {
                  defaultValue: "Authorize the desktop app",
                })}
          </Button>
        </div>
      )}

      {/* Config form — the env-var / token form for local-config + local-setup
          modes (and connectors with no declared modes at all). Hidden while an
          OAuth or one-click-local mode owns the body. */}
      {showConfigForm ? (
        <div className="py-1.5">
          {selectedMode?.description &&
            selectedMode.kind === "local" &&
            !localSignIn && (
              <p className="mb-2 text-2xs text-muted">
                {selectedMode.description}
              </p>
            )}
          <ConfigRenderer
            schema={schema}
            hints={hints}
            values={mergedValues}
            setKeys={setKeys}
            registry={defaultRegistry}
            pluginId={plugin.id}
            onChange={handleChange}
          />
        </div>
      ) : selectedMode?.kind === "oauth" ||
        (selectedMode?.kind === "local" && localSignIn) ? null : (
        <div className="py-1.5 text-xs text-muted italic">
          {t("messagecontent.NoConfigurablePara")}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center gap-2 px-3 py-2 flex-wrap">
        {showConfigForm && (
          <Button
            variant="default"
            size="tinyWide"
            onClick={handleSave}
            disabled={saving || enabling || Object.keys(values).length === 0}
          >
            {saving
              ? t("common.saving", {
                  defaultValue: "Saving...",
                })
              : t("common.save")}
          </Button>
        )}

        {!isEnabled ? (
          <Button
            variant="outlineAccent"
            size="tinyWide"
            onClick={() => void handleToggle(true)}
            disabled={enabling || saving}
          >
            {enabling
              ? t("messagecontent.Enabling", {
                  defaultValue: "Turning on...",
                })
              : t("messagecontent.EnablePlugin", {
                  defaultValue: "Enable plugin",
                })}
          </Button>
        ) : (
          <Button
            variant="dangerOutline"
            size="tinyWide"
            onClick={() => void handleToggle(false)}
            disabled={enabling || saving}
          >
            {enabling
              ? t("messagecontent.Disabling", {
                  defaultValue: "Turning off...",
                })
              : t("common.disable", {
                  defaultValue: "Disable",
                })}
          </Button>
        )}

        {saved && <span className="text-xs text-ok">{t("common.saved")}</span>}
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    </ChatWidgetShell>
  );
});

// ── UiSpec block ────────────────────────────────────────────────────

export function MessageUiSpecBlock({
  spec,
  raw,
}: {
  spec: UiSpec;
  raw: string;
}) {
  const { t, sendActionMessage } = useAppSelectorShallow((s) => ({
    t: s.t,
    sendActionMessage: s.sendActionMessage,
  }));
  const [showRaw, setShowRaw] = useState(false);

  const handleAction = useCallback(
    (
      action: string,
      params?: Record<string, unknown>,
      metadata?: UiActionDispatchMetadata,
    ) => {
      // Plugin actions are handled directly via the API instead of
      // being sent back as chat messages.
      if (action === "plugin:save") {
        if (!params?.pluginId) {
          void sendActionMessage(
            "[Failed to save plugin config: pluginId is required]",
          );
          return;
        }
        const pluginId = String(params.pluginId);
        const config: Record<string, string> = {};
        // Collect all config.* state values
        if (params) {
          for (const [key, value] of Object.entries(params)) {
            if (
              key.startsWith("config.") &&
              typeof value === "string" &&
              value.trim()
            ) {
              config[key.slice(7)] = value.trim();
            }
          }
        }
        if (Object.keys(config).length === 0) {
          void sendActionMessage(
            "[Failed to save plugin config: no configuration values were provided]",
          );
          return;
        }
        void client
          .updatePlugin(pluginId, { config })
          .then(() =>
            sendActionMessage(
              `[Plugin ${pluginId} configuration saved successfully]`,
            ),
          )
          // error-policy:J4 the failure is surfaced as a chat action message
          .catch((err: unknown) =>
            sendActionMessage(
              `[Failed to save plugin config: ${err instanceof Error ? err.message : "unknown error"}]`,
            ),
          );
        return;
      }
      if (action === "plugin:enable" && params?.pluginId) {
        void client
          .updatePlugin(String(params.pluginId), { enabled: true })
          .then(() =>
            sendActionMessage(
              `[Plugin ${params.pluginId} enabled. Restart required.]`,
            ),
          )
          // error-policy:J4 the failure is surfaced as a chat action message
          .catch((err: unknown) =>
            sendActionMessage(
              `[Failed to enable plugin: ${err instanceof Error ? err.message : "unknown error"}]`,
            ),
          );
        return;
      }
      if (action === "plugin:test" && params?.pluginId) {
        void sendActionMessage(`[Testing ${params.pluginId} connection...]`);
        return;
      }
      if (action === "plugin:configure" && params?.pluginId) {
        void sendActionMessage(
          `Please show me the configuration form for the ${params.pluginId} plugin`,
        );
        return;
      }
      // Generic UiSpec actions remain planner-readable, including literal and
      // live non-secret params. The renderer supplies a history-safe copy when
      // a payload contains values sourced from password fields; direct
      // allowlisted handlers above still receive the complete resolved params.
      const historySafeParams = metadata?.historySafeParams ?? params;
      const paramsStr =
        historySafeParams && Object.keys(historySafeParams).length > 0
          ? ` ${JSON.stringify(historySafeParams)}`
          : "";
      void sendActionMessage(`[action:${action}]${paramsStr}`);
    },
    [sendActionMessage],
  );

  return (
    <div className="my-2 overflow-hidden">
      <div className="flex items-center justify-between py-1">
        <span className="text-2xs font-semibold text-muted uppercase tracking-wider">
          {t("messagecontent.InteractiveUI")}
        </span>
        <Button
          variant="mutedLink"
          size="content"
          onClick={() => setShowRaw((v) => !v)}
        >
          {showRaw
            ? t("messagecontent.HideJson", {
                defaultValue: "Hide JSON",
              })
            : t("messagecontent.ViewJson", {
                defaultValue: "View JSON",
              })}
        </Button>
      </div>
      {showRaw && (
        // The raw JSON pane keeps a code-block fill: it is code, and the fill
        // separates it from the rendered widget below.
        <Card
          variant="codePane"
          className="overflow-x-auto overscroll-x-contain"
        >
          <pre className="text-2xs text-muted font-mono whitespace-pre-wrap break-words m-0">
            {raw}
          </pre>
        </Card>
      )}
      <div className="py-1.5">
        {/*
          A model-emitted UiSpec can be malformed in ways the renderer can't
          fully normalize (wrong-typed array props, unknown shapes). Without a
          boundary here a single bad widget throws past every view boundary to
          the app ROOT error screen — and because the message re-hydrates from
          history, "Try Again"/restart re-crash it, bricking the app. Contain
          any render throw to this one message and offer the raw JSON instead.
        */}
        <ErrorBoundary
          fallback={() => (
            <Card
              surface="destructiveSubtle"
              border="destructive"
              padding="default"
              tone="muted"
              className="text-xs"
            >
              <span className="font-semibold text-destructive">
                Couldn't render this widget.
              </span>{" "}
              <Button
                type="button"
                className="underline underline-offset-2"
                onClick={() => setShowRaw((v) => !v)}
              >
                {showRaw ? "Hide JSON" : "View JSON"}
              </Button>
            </Card>
          )}
        >
          <UiRenderer spec={spec} onAction={handleAction} />
        </ErrorBoundary>
      </div>
    </div>
  );
}

export function SensitiveRequestBlock({
  request,
}: {
  request: NonNullable<ConversationMessage["secretRequest"]>;
}) {
  const [status, setStatus] = useState(request.status);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentRequest = useRef(request);
  currentRequest.current = request;

  useEffect(() => {
    setStatus(request.status);
    setValues({});
    setSaving(false);
    setAuthorizing(false);
    setError(null);
  }, [request]);

  const fields = request.form?.fields ?? [];
  const isRemoteConnect = request.form?.kind === "remote_connect";
  const canCollectSecret =
    status === "pending" &&
    (request.form?.kind === "secret" || isRemoteConnect) &&
    request.delivery?.canCollectValueInCurrentChannel === true &&
    fields.length > 0;
  const canStartOAuth =
    status === "pending" &&
    request.form?.kind === "oauth" &&
    isHttpsAuthorizationUrl(request.form.authorizationUrl);

  const canSubmit = fields.every((field) => {
    if (!field.required) return true;
    return (values[field.name] ?? "").trim().length > 0;
  });

  const tunnel = request.delivery?.tunnel;
  const requestLabel = sensitiveRequestTitleLabel(request.key);
  const isSaved =
    status === "saved" || status === "submitted" || status === "fulfilled";

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!canCollectSecret || !canSubmit) return;
      const submittedRequest = request;
      setSaving(true);
      setError(null);
      try {
        if (isRemoteConnect) {
          // Remote-connect path (first-run): validate the URL and dispatch the
          // hardened CONNECT_EVENT — the App handler connects to the remote
          // agent, adopts it as the active runtime, and finishes onboarding. The
          // values are NEVER written to the secret store. skipConfirm: the user
          // explicitly typed this URL in the trusted onboarding flow.
          let normalized: string;
          try {
            normalized = normalizeRemoteAgentUrl(values.url ?? "");
          } catch (caught) {
            // error-policy:J4 a typo'd URL must not flip the block to "failed"
            // (which unmounts
            // the form) — surface the message and keep the form editable.
            setError(
              caught instanceof Error
                ? caught.message
                : "Enter a valid remote agent URL.",
            );
            return;
          }
          const result = await dispatchConnectRequest({
            gatewayUrl: normalized,
            token: values.token?.trim() || undefined,
            completeFirstRun: true,
            skipConfirm: true,
          });
          if (currentRequest.current !== submittedRequest) return;
          if (result.status !== "connected") {
            setError(
              result.status === "failed"
                ? result.message
                : result.status === "cancelled"
                  ? "Connection request cancelled. You can edit the details and try again."
                  : "A newer connection request replaced this attempt. Try connecting again.",
            );
            return;
          }
          setValues({});
          setStatus("saved");
          return;
        }
        if (tunnel) {
          // Tunnel path (#10317): route each submitted value to the waiting
          // child via the one-shot CredentialTunnelService. MUTUALLY EXCLUSIVE
          // with updateSecrets — a tunnel-routed value is never written to the
          // long-term agent secret store.
          for (const field of fields) {
            const value = values[field.name];
            if (value != null && value !== "") {
              await client.tunnelCredential({
                credentialScopeId: tunnel.credentialScopeId,
                childSessionId: tunnel.childSessionId,
                key: field.name,
                value,
              });
            }
          }
        } else {
          const secrets: Record<string, string> = {};
          for (const field of fields) {
            const value = values[field.name];
            if (value != null && value !== "") {
              secrets[field.name] = value;
            }
          }
          await client.updateSecrets(secrets);
        }
        setValues({});
        setStatus("saved");
      } catch (caught) {
        if (currentRequest.current !== submittedRequest) return;
        // error-policy:J4 submit failure renders the form's error state
        setError(
          caught instanceof Error
            ? caught.message
            : tunnel
              ? "Could not submit credential."
              : "Could not save secret.",
        );
        setStatus("failed");
      } finally {
        if (currentRequest.current === submittedRequest) setSaving(false);
      }
    },
    [
      canCollectSecret,
      canSubmit,
      fields,
      isRemoteConnect,
      request,
      tunnel,
      values,
    ],
  );

  return (
    <Card
      variant="insetPadded"
      stack="compact"
      data-testid="sensitive-request"
      className="my-2"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="break-words font-medium">{requestLabel}</div>
          {canCollectSecret && !tunnel && !isRemoteConnect && (
            <div className="mt-0.5 text-xs text-muted">
              Masked input. It never lands in the transcript.
            </div>
          )}
        </div>
        <div
          data-testid="sensitive-request-status"
          className={cn(
            "flex shrink-0 items-center gap-1 text-xs",
            isSaved ? "text-ok" : "text-muted",
          )}
        >
          {isSaved && <Check className="size-3.5" aria-hidden />}
          {sensitiveRequestStatusLabel(status)}
        </div>
      </div>
      {request.reason && (
        <div className="text-xs text-muted">{request.reason}</div>
      )}
      {request.delivery?.instruction && (
        <div className="text-xs text-muted">{request.delivery.instruction}</div>
      )}
      {canCollectSecret && (
        <SemanticForm className="space-y-3" onSubmit={handleSubmit}>
          {fields.map((field) => {
            const label = field.label ?? field.name;
            const inputId = `sensitive-request-${field.name.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
            const isUpload = field.input === "image" || field.input === "file";
            if (isUpload) {
              const accept =
                field.mimeTypes && field.mimeTypes.length > 0
                  ? field.mimeTypes.join(",")
                  : field.input === "image"
                    ? "image/*"
                    : undefined;
              const hasValue = Boolean(values[field.name]);
              return (
                <label
                  key={field.name}
                  htmlFor={inputId}
                  className="block text-xs space-y-1"
                >
                  <span className="font-medium">{label}</span>
                  <Input
                    id={inputId}
                    aria-label={label}
                    data-testid={`sensitive-request-file-${field.name}`}
                    variant="secret"
                    density="short"
                    type="file"
                    accept={accept}
                    // Mobile: prefer the rear camera for image capture (2FA QR/seed).
                    capture={
                      field.input === "image" ? "environment" : undefined
                    }
                    required={field.required && !hasValue}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      if (!file) {
                        setValues((previous) => {
                          const next = { ...previous };
                          delete next[field.name];
                          return next;
                        });
                        return;
                      }
                      if (field.maxBytes && file.size > field.maxBytes) {
                        setError(
                          `${label} is too large (max ${Math.round(
                            field.maxBytes / 1024,
                          )} KB).`,
                        );
                        event.currentTarget.value = "";
                        return;
                      }
                      const reader = new FileReader();
                      reader.onload = () => {
                        setError(null);
                        setValues((previous) => ({
                          ...previous,
                          [field.name]: String(reader.result ?? ""),
                        }));
                      };
                      reader.onerror = () =>
                        setError(`Could not read ${label}.`);
                      reader.readAsDataURL(file);
                    }}
                  />
                </label>
              );
            }
            return (
              <label
                key={field.name}
                htmlFor={inputId}
                className="block text-xs space-y-1"
              >
                <span className="font-medium">{label}</span>
                <Input
                  id={inputId}
                  aria-label={label}
                  variant="secret"
                  density="short"
                  type={field.input === "secret" ? "password" : "text"}
                  value={values[field.name] ?? ""}
                  onChange={(event) => {
                    const nextValue = event.currentTarget.value;
                    setValues((previous) => ({
                      ...previous,
                      [field.name]: nextValue,
                    }));
                  }}
                  required={field.required}
                />
              </label>
            );
          })}
          <Button
            type="submit"
            size="sm"
            disabled={saving || !canSubmit}
            data-testid="sensitive-request-submit"
          >
            {saving
              ? "Saving…"
              : (request.form?.submitLabel ??
                (isRemoteConnect ? "Connect" : "Save securely"))}
          </Button>
          {!isRemoteConnect && (
            <div
              className="flex items-center gap-1.5 text-xs text-muted"
              data-testid="sensitive-request-security-note"
            >
              <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
              {tunnel
                ? "Sent once to the waiting session. Never stored, never posted to chat."
                : "Sent directly to the agent. Never posted to chat."}
            </div>
          )}
        </SemanticForm>
      )}
      {canStartOAuth && request.form?.kind === "oauth" && (
        <OAuthRequestPanel
          form={request.form}
          authorizing={authorizing}
          onStart={() => {
            const url = request.form?.authorizationUrl;
            // Re-validate at the sink (defense-in-depth): only an https consent
            // URL may reach window.open.
            if (!isHttpsAuthorizationUrl(url)) {
              setError("Invalid authorization URL.");
              return;
            }
            try {
              // SECURITY: we never embed the authorizationUrl in chat text.
              // It is only opened in a popup. We deliberately do NOT pass
              // `noopener` in the features string: per the HTML spec, when
              // `noopener` is set `window.open` always returns null, so we
              // would lose our popup-blocked signal and have to fall back to
              // a guess-and-check heuristic. The consent page is to a
              // trusted provider on a separate origin; `noreferrer` is kept,
              // and we set `popup.opener = null` ourselves immediately after
              // open as a belt-and-suspenders measure. If `window.open`
              // returns null after this, that genuinely is a blocked popup.
              if (typeof window === "undefined") return;
              const popup = window.open(
                url,
                "eliza-oauth",
                "width=520,height=720,noreferrer",
              );
              if (!popup) {
                // #15143: mobile browsers block windowed popups by default,
                // and "allow pop-ups" is a dead-end instruction in a consumer
                // flow. On plain web degrade to same-tab navigation — `url` is
                // https-validated above, the consent/login page returns via
                // its own redirect, and persisted app/first-run state survives
                // the round trip. Native/desktop keep the visible error state:
                // their external-open affordances are not popup-blocked, so a
                // null there is a real failure.
                if (canNavigateSameTabForBlockedPopup()) {
                  window.location.assign(url);
                  return;
                }
                setError(
                  "Pop-up blocked. Allow pop-ups for this site to continue.",
                );
                return;
              }
              try {
                popup.opener = null;
              } catch {
                // error-policy:J6 best-effort hardening — some browsers throw
                // when reassigning opener cross-origin; `noreferrer` already
                // mitigates this.
              }
              setAuthorizing(true);
              setError(null);
            } catch (caught) {
              // error-policy:J4 failure renders the block's error state
              setError(
                caught instanceof Error
                  ? caught.message
                  : "Could not start authorization.",
              );
            }
          }}
        />
      )}
      {error && <div className="text-xs text-danger">{error}</div>}
    </Card>
  );
}

export function MessagePermissionCard({
  payload,
}: {
  payload: PermissionCardPayload;
}) {
  const { sendActionMessage } = useAppSelectorShallow((s) => ({
    sendActionMessage: s.sendActionMessage,
  }));

  const permissionRegistry = useMemo(
    () =>
      isNative && !isDesktopPlatform()
        ? createMobileSignalsPermissionsRegistry(undefined, client)
        : createClientPermissionsRegistry(client),
    [],
  );

  const handlePermissionFallback = useCallback(
    (feature: string, permission: string) => {
      void sendActionMessage(
        `__permission_card__:use_fallback feature=${feature} permission=${permission}`,
      );
    },
    [sendActionMessage],
  );

  const handlePermissionGranted = useCallback(
    (feature: string, permission: string) => {
      void sendActionMessage(
        `__permission_card__:granted feature=${feature} permission=${permission}`,
      );
    },
    [sendActionMessage],
  );

  return renderPermissionCardFromPayload(payload, {
    registry: permissionRegistry,
    onOpenSettings: async (permission) => {
      if (isNative && !isDesktopPlatform()) {
        await openMobilePermissionSettings(permission);
        return;
      }
      await client.openPermissionSettings(permission);
    },
    onFallback: ({ feature, permission }) =>
      handlePermissionFallback(feature, permission),
    onGranted: () =>
      handlePermissionGranted(payload.feature, payload.permission),
  });
}

function OAuthRequestPanel({
  form,
  authorizing,
  onStart,
}: {
  form: NonNullable<NonNullable<ConversationMessage["secretRequest"]>["form"]>;
  authorizing: boolean;
  onStart: () => void;
}) {
  const provider = form.provider ?? "provider";
  const label = form.submitLabel ?? `Connect ${provider}`;
  return (
    <div data-testid="sensitive-request-oauth" className="space-y-2">
      {form.scopes && form.scopes.length > 0 && (
        <div className="text-xs text-muted">
          Scopes: {form.scopes.join(", ")}
        </div>
      )}
      <Button
        type="button"
        size="sm"
        onClick={onStart}
        disabled={authorizing}
        data-testid="sensitive-request-oauth-start"
      >
        {authorizing ? "Authorizing…" : label}
      </Button>
      <div className="flex items-center gap-1.5 text-xs text-muted">
        <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
        Authorization happens on the provider's secure page. The token is stored
        securely and is never shown in chat.
      </div>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────

export function MessageContent({
  message,
  analysisMode = false,
}: MessageContentProps) {
  useRenderGuard(`MessageContent:${message.id ?? "unknown"}`);
  const { sendActionMessage, setTab, handleChatRetry } = useAppSelectorShallow(
    (s) => ({
      sendActionMessage: s.sendActionMessage,
      setTab: s.setTab,
      handleChatRetry: s.handleChatRetry,
    }),
  );
  // Composer prefill for followup `prompt` chips. Outside the chat provider,
  // `useChatComposer` returns an inert setter, so this is safe everywhere.
  const { setChatInput } = useChatComposer();
  const [replyRecoveryPending, setReplyRecoveryPending] = useState(false);
  const [localDownloadState, setLocalDownloadState] = useState<
    "idle" | "busy" | "queued" | "failed"
  >("idle");
  const [localDownloadError, setLocalDownloadError] = useState<string | null>(
    null,
  );

  // Incremental prefix-cached parse: a streaming turn re-parses only its changed
  // tail instead of the whole buffer every rAF flush (#15280). Byte-identical to
  // parseSegments; falls back to raw text if the markup is malformed.
  const displayText =
    message.role === "assistant"
      ? stripUnclaimedInteractionMarkup(message.text)
      : message.text;
  const segments = useParsedSegments(displayText, analysisMode);

  // Handlers handed to every inline widget at render: the SAME shared contract
  // the overlay surface (InlineWidgetText) uses, so a CHOICE pick / FOLLOWUPS
  // chip / FORM submit behaves identically on both. Self-contained widgets (the
  // task card) ignore them; interactive ones drive the chat surface.
  const inlineWidgetCtx = useInlineWidgetContext(
    sendActionMessage,
    setChatInput,
  );

  const handleOpenSettings = useCallback(() => {
    setTab?.("settings");
  }, [setTab]);

  const handleDownloadDefaultLocalModel = useCallback(async () => {
    const modelId = message.localInference?.modelId;
    if (!modelId) {
      handleOpenSettings();
      return;
    }
    setLocalDownloadState("busy");
    setLocalDownloadError(null);
    try {
      await client.startLocalInferenceDownload(modelId);
      setLocalDownloadState("queued");
    } catch (error) {
      // error-policy:J4 failure renders the download card's error state
      setLocalDownloadError(
        error instanceof Error ? error.message : "Failed to start download",
      );
      setLocalDownloadState("failed");
    }
  }, [handleOpenSettings, message.localInference?.modelId]);

  if (message.secretRequest) {
    return <SensitiveRequestBlock request={message.secretRequest} />;
  }

  if (message.accountConnect) {
    return <AccountConnectBlock request={message.accountConnect} />;
  }

  if (message.capabilityHandoff) {
    return (
      <div className="space-y-2">
        {message.text.trim() ? (
          <MessageTextBody text={message.text} boldSlashCommand={false} />
        ) : null}
        <CapabilityHandoffBlock request={message.capabilityHandoff} />
      </div>
    );
  }

  if (
    message.localInference &&
    message.localInference.status !== "ready" &&
    message.localInference.status !== "routing"
  ) {
    const status = message.localInference.status;
    const downloading = status === "downloading" || status === "loading";
    const canStartDownload = Boolean(message.localInference.modelId);
    return (
      <Alert variant="warning">
        <AlertTitle>
          {downloading
            ? "Local model download in progress"
            : "Local model required"}
        </AlertTitle>
        <AlertDescription className="gap-2">
          <div className="whitespace-pre-wrap">{message.text}</div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              onClick={handleDownloadDefaultLocalModel}
              disabled={downloading || localDownloadState === "busy"}
            >
              {downloading
                ? "Downloading"
                : localDownloadState === "busy"
                  ? "Starting…"
                  : localDownloadState === "queued"
                    ? "Download queued"
                    : "Download default model"}
            </Button>
            {!canStartDownload ? (
              <Button type="button" size="sm" onClick={handleOpenSettings}>
                Open Local Models
              </Button>
            ) : null}
          </div>
          {localDownloadError ? (
            <div className="text-xs text-danger">{localDownloadError}</div>
          ) : null}
        </AlertDescription>
      </Alert>
    );
  }

  if (message.role === "assistant" && message.replyRecoveryAvailable === true) {
    return (
      <Alert variant="warning">
        <AlertDescription>
          <div className="whitespace-pre-wrap">{message.text}</div>
          <Button
            type="button"
            size="sm"
            disabled={replyRecoveryPending}
            onClick={async () => {
              if (!message.id || replyRecoveryPending) return;
              setReplyRecoveryPending(true);
              try {
                await handleChatRetry(message.id);
              } finally {
                setReplyRecoveryPending(false);
              }
            }}
          >
            {replyRecoveryPending ? "Regenerating reply…" : "Regenerate reply"}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  // The server flags failed assistant turns with `failureKind`. For
  // `no_provider` specifically the user can't make progress without
  // wiring up a provider, so render a structured gate (banner + CTA)
  // instead of the fallback text — clicking jumps to Settings where
  // ProviderSwitcher lives.
  if (message.failureKind === "no_provider") {
    return (
      <Alert variant="warning">
        <AlertTitle>Connect a provider to chat</AlertTitle>
        <AlertDescription>
          <div className="whitespace-pre-wrap">{message.text}</div>
          <Button type="button" size="sm" onClick={handleOpenSettings}>
            Open Settings
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  // A drained org returns a 402; retrying just re-hits the same empty balance,
  // so render a designed out-of-credits gate rather than the generic failure
  // text (which invites the retry loop). The CTA jumps to Settings where the
  // Cloud top-up/redeem flow lives — there is no separate billing tab.
  if (message.failureKind === "insufficient_credits") {
    return (
      <Alert variant="warning">
        <AlertTitle>Out of credits</AlertTitle>
        <AlertDescription>
          <div className="whitespace-pre-wrap">{message.text}</div>
          <Button type="button" size="sm" onClick={handleOpenSettings}>
            Add credits
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  // Transient / recoverable server failures render the graceful message plus a
  // one-tap Retry that resends the preceding user turn. Permanent gates
  // (`no_provider`, `insufficient_credits`, `missing_capability`) stay off the
  // shared retry contract in `@elizaos/shared`.
  if (
    message.failureKind &&
    (message.terminalFailure
      ? message.terminalFailure.transient
      : isRetryableChatFailureKind(message.failureKind))
  ) {
    return (
      <Alert variant="warning">
        <AlertDescription>
          <div className="whitespace-pre-wrap">{message.text}</div>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              if (message.id) handleChatRetry(message.id);
            }}
          >
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  // Fast path: single plain-text segment (most messages). Assistant turns
  // that carry reasoning or tool events must NOT take it — the thinking block
  // and the expandable action log render only on the full path below, and the
  // common reply shape IS a single text segment, so gating on segments alone
  // silently dropped both.
  const hasAssistantExtras =
    message.role === "assistant" &&
    Boolean(message.reasoning?.trim() || message.toolEvents?.length);
  if (
    !hasAssistantExtras &&
    segments.length === 1 &&
    segments[0].kind === "text"
  ) {
    return (
      <MessageTextBody
        text={segments[0].text}
        boldSlashCommand={message.role === "user"}
      />
    );
  }

  return (
    <div>
      {message.role === "assistant" && message.reasoning?.trim() ? (
        <ThinkingBlock reasoning={message.reasoning} />
      ) : null}
      {message.role === "assistant" && message.toolEvents?.length ? (
        <div className="mb-2 flex flex-col gap-1.5">
          {message.toolEvents.map((event) => (
            <ToolCallEventLog key={event.callId ?? event.id} event={event} />
          ))}
        </div>
      ) : null}
      {(() => {
        const keyCounts = new Map<string, number>();
        const nextKey = (base: string) => {
          const nextCount = (keyCounts.get(base) ?? 0) + 1;
          keyCounts.set(base, nextCount);
          return `${base}:${nextCount}`;
        };

        return segments.map((seg) => {
          const baseKey =
            seg.kind === "text"
              ? `text:${seg.text.slice(0, 80)}`
              : seg.kind === "code"
                ? `code:${seg.code.slice(0, 80)}`
                : seg.kind === "config"
                  ? `config:${seg.pluginId}`
                  : seg.kind === "widget"
                    ? (getInlineWidget(seg.widgetKind)?.keyFor?.(seg.data) ??
                      `widget:${seg.widgetKind}`)
                    : seg.kind === "permission"
                      ? `permission:${seg.payload.feature}`
                      : seg.kind === "analysis-xml"
                        ? `analysis:${seg.tag}`
                        : `ui:${seg.raw.slice(0, 80)}`;
          const segmentKey = nextKey(baseKey);

          switch (seg.kind) {
            case "text":
              return (
                <MessageTextBody
                  key={segmentKey}
                  text={seg.text}
                  boldSlashCommand={message.role === "user"}
                />
              );
            case "code":
              return (
                <CodeBlock
                  key={segmentKey}
                  className="my-2"
                  value={seg.code}
                  wrap
                  copyable
                  data-testid="code-block"
                  {...(seg.lang ? { "data-lang": seg.lang } : {})}
                />
              );
            case "analysis-xml":
              return (
                <Card
                  key={segmentKey}
                  variant="insetPadded"
                  stack="compact"
                  className="my-2"
                >
                  <div className="text-xs font-semibold text-accent">
                    &lt;{seg.tag}&gt;
                  </div>
                  <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-muted overscroll-x-contain">
                    {seg.content.trim()}
                  </pre>
                </Card>
              );
            case "config":
              if (!isSafeNormalizedPluginId(normalizePluginId(seg.pluginId))) {
                return null;
              }
              return (
                <InlinePluginConfig key={segmentKey} pluginId={seg.pluginId} />
              );
            case "ui-spec":
              return (
                <MessageUiSpecBlock
                  key={segmentKey}
                  spec={seg.spec}
                  raw={seg.raw}
                />
              );
            case "widget": {
              const widget = getInlineWidget(seg.widgetKind);
              return widget
                ? widget.render(seg.data, inlineWidgetCtx, segmentKey)
                : null;
            }
            case "permission":
              return (
                <MessagePermissionCard key={segmentKey} payload={seg.payload} />
              );
            default:
              return null;
          }
        });
      })()}
      {message.attachments?.length ? (
        <MessageAttachments attachments={message.attachments} />
      ) : null}
      {analysisMode && message.actionName && (
        <Card variant="insetPadded" stack="compact" className="my-2">
          <div className="text-xs font-semibold text-accent">Action taken</div>
          <div className="space-y-1 font-mono text-xs text-muted">
            {message.actionName}
          </div>
        </Card>
      )}
      {analysisMode &&
        message.actionCallbackHistory &&
        message.actionCallbackHistory.length > 0 && (
          <Card variant="insetPadded" stack="compact" className="my-2">
            <div className="text-xs font-semibold text-muted-strong">
              Action callback history
            </div>
            <div className="space-y-1 font-mono text-xs text-muted">
              {(() => {
                const occurrence = new Map<string, number>();
                return message.actionCallbackHistory.map((log) => {
                  const n = occurrence.get(log) ?? 0;
                  occurrence.set(log, n + 1);
                  return (
                    <div
                      key={`${message.id}:action-callback:${n}:${log}`}
                      className="break-words"
                    >
                      {log}
                    </div>
                  );
                });
              })()}
            </div>
          </Card>
        )}
    </div>
  );
}
