/**
 * The Release Center view: surfaces the agent runtime and desktop-app update
 * state — current versions, available updates, and check/apply actions — plus a
 * configurable release-notes link. Desktop update controls only appear under the
 * Electrobun runtime; elsewhere the view degrades to runtime-update status only.
 * State flows through the app store's update snapshots and the desktop updater
 * bridge.
 */
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useAgentElement } from "../../agent-surface";
import {
  invokeDesktopBridgeRequest,
  isElectrobunRuntime,
  subscribeDesktopBridgeEvent,
} from "../../bridge";
import { useBranding } from "../../config/branding";
import {
  type ApplicationUpdateSnapshot,
  getApplicationUpdateSnapshot,
  mapAgentUpdateStatusToSnapshot,
} from "../../services/app-updates/update-policy";
import { useAppSelectorShallow } from "../../state";
import { openExternalUrl } from "../../utils";
import { openDesktopSurfaceWindow } from "../../utils/desktop-workspace";
import {
  normalizeReleaseNotesUrl,
  summarizeError,
} from "../release-center/shared.helpers";
import type {
  AppReleaseStatus,
  DesktopUpdaterSnapshot,
} from "../release-center/types";
import { SettingsInputRow } from "../settings/settings-agent-rows";
import {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "../settings/settings-layout";
import { Button } from "../ui/button";

function CheckUpdateButton({
  label,
  disabled,
  onActivate,
}: {
  label: string;
  disabled: boolean;
  onActivate: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "updates-check",
    role: "button",
    label,
    group: "release-actions",
    description: "Check for and download a desktop update",
    onActivate,
  });
  return (
    <Button
      ref={ref}
      size="compact"
      disabled={disabled}
      onClick={onActivate}
      {...agentProps}
    >
      {label}
    </Button>
  );
}

function ApplyUpdateButton({
  label,
  disabled,
  onActivate,
}: {
  label: string;
  disabled: boolean;
  onActivate: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "updates-apply",
    role: "button",
    label,
    group: "release-actions",
    description: "Apply the downloaded desktop update",
    onActivate,
  });
  return (
    <Button
      ref={ref}
      size="compact"
      disabled={disabled}
      onClick={onActivate}
      {...agentProps}
    >
      {label}
    </Button>
  );
}

function DetachReleaseCenterButton({
  label,
  disabled,
  onActivate,
}: {
  label: string;
  disabled: boolean;
  onActivate: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "updates-open-detached",
    role: "button",
    label,
    group: "release-actions",
    description: "Open the release center in a detached window",
    onActivate,
  });
  return (
    <Button
      ref={ref}
      size="compact"
      variant="outline"
      disabled={disabled}
      onClick={onActivate}
      {...agentProps}
    >
      {label}
    </Button>
  );
}

export function ReleaseCenterView() {
  const { appUrl } = useBranding();
  const defaultReleaseNotesUrl = `${appUrl}/releases/`;
  const desktopRuntime = isElectrobunRuntime();
  const { loadUpdateStatus, t, updateLoading, updateStatus } =
    useAppSelectorShallow((s) => ({
      loadUpdateStatus: s.loadUpdateStatus,
      t: s.t,
      updateLoading: s.updateLoading,
      updateStatus: s.updateStatus,
    }));

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [nativeUpdater, setNativeUpdater] =
    useState<DesktopUpdaterSnapshot | null>(null);
  const [applicationUpdate, setApplicationUpdate] =
    useState<ApplicationUpdateSnapshot | null>(null);
  const [releaseNotesUrl, setReleaseNotesUrl] = useState(
    defaultReleaseNotesUrl,
  );
  /**
   * Has the user edited the release-notes URL, so an updater snapshot must not
   * overwrite it?
   *
   * A ref rather than state, because every read happens *after* an `await` on
   * the desktop bridge. A closure read there sees the value captured when the
   * request was issued — always `false` if the user had not started typing yet
   * — so editing the field while a check was in flight got overwritten by the
   * snapshot when it landed. Nothing renders from this flag, so state bought a
   * re-render and a stale read and nothing else.
   */
  const releaseNotesUrlDirtyRef = useRef(false);

  const refreshNativeState = useCallback(async () => {
    if (!desktopRuntime) return;

    // A broken updater bridge on desktop must not read as "no native
    // updater" — surface it in the visible action-error banner.
    const snapshot = await invokeDesktopBridgeRequest<DesktopUpdaterSnapshot>({
      rpcMethod: "desktopGetUpdaterState",
      ipcChannel: "desktop:getUpdaterState",
    }).catch((err: unknown) => {
      setActionError(
        `Failed to read desktop updater state: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    });

    setNativeUpdater(snapshot);
    setReleaseNotesUrl((current) =>
      releaseNotesUrlDirtyRef.current
        ? current
        : normalizeReleaseNotesUrl(snapshot?.baseUrl ?? current),
    );
    // The dirty flag is intentionally absent from the dependencies: it is read
    // through the ref above, so this callback keeps a stable identity while the
    // user edits. Previously the first keystroke changed that identity and
    // re-ran both effects below, costing one redundant bridge refresh and a
    // listener re-subscribe.
  }, [desktopRuntime]);

  useEffect(() => {
    void loadUpdateStatus();
  }, [loadUpdateStatus]);

  useEffect(() => {
    void getApplicationUpdateSnapshot({
      desktop: desktopRuntime,
      version: desktopRuntime ? nativeUpdater?.currentVersion : undefined,
    }).then(setApplicationUpdate);
  }, [desktopRuntime, nativeUpdater?.currentVersion]);

  useEffect(() => {
    if (!desktopRuntime) return;
    void refreshNativeState();
  }, [desktopRuntime, refreshNativeState]);

  useEffect(() => {
    if (!desktopRuntime) return;

    const unsubscribers = [
      subscribeDesktopBridgeEvent({
        rpcMessage: "desktopUpdateAvailable",
        ipcChannel: "desktop:updateAvailable",
        listener: () => void refreshNativeState(),
      }),
      subscribeDesktopBridgeEvent({
        rpcMessage: "desktopUpdateReady",
        ipcChannel: "desktop:updateReady",
        listener: () => void refreshNativeState(),
      }),
    ];

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [desktopRuntime, refreshNativeState]);

  const runAction = useCallback(
    async <T,>(
      id: string,
      action: () => Promise<T>,
      successMessage?: string,
    ): Promise<T | null> => {
      setBusyAction(id);
      setActionError(null);
      setActionMessage(null);
      try {
        const result = await action();
        if (successMessage) setActionMessage(successMessage);
        return result;
      } catch (error) {
        setActionError(summarizeError(error));
        return null;
      } finally {
        setBusyAction(null);
      }
    },
    [],
  );

  const detachReleaseCenter = async () => {
    if (!desktopRuntime) return;
    await openDesktopSurfaceWindow("release");
  };

  const refreshReleaseState = async () => {
    if (desktopRuntime) {
      await Promise.all([loadUpdateStatus(true), refreshNativeState()]);
      return;
    }
    await loadUpdateStatus(true);
  };

  const checkForDesktopUpdate = async () => {
    if (!desktopRuntime) return;
    const snapshot = await invokeDesktopBridgeRequest<DesktopUpdaterSnapshot>({
      rpcMethod: "desktopCheckForUpdates",
      ipcChannel: "desktop:checkForUpdates",
    });
    setNativeUpdater(snapshot);
    if (!releaseNotesUrlDirtyRef.current && snapshot?.baseUrl) {
      setReleaseNotesUrl(normalizeReleaseNotesUrl(snapshot.baseUrl));
    }
  };

  const applyDesktopUpdate = async () => {
    if (!desktopRuntime) return;
    await invokeDesktopBridgeRequest<void>({
      rpcMethod: "desktopApplyUpdate",
      ipcChannel: "desktop:applyUpdate",
    });
  };

  const openReleaseNotesWindow = async () => {
    if (!desktopRuntime) {
      await openExternalUrl(releaseNotesUrl);
      return;
    }
    await invokeDesktopBridgeRequest({
      rpcMethod: "desktopOpenReleaseNotesWindow",
      ipcChannel: "desktop:openReleaseNotesWindow",
      params: {
        url: releaseNotesUrl,
        title: t("releasecenterview.ReleaseNotes", {
          defaultValue: "Release Notes",
        }),
      },
    });
  };

  const appStatus = updateStatus as AppReleaseStatus | null | undefined;
  const agentUpdate = mapAgentUpdateStatusToSnapshot(updateStatus ?? null);
  const appVersion =
    applicationUpdate?.version ??
    t("common.unknown", { defaultValue: "Unknown" });
  const desktopVersion = nativeUpdater?.currentVersion ?? "—";
  const channel = nativeUpdater?.channel ?? "—";
  const lastCheckAt = appStatus?.lastCheckAt;
  const lastChecked = lastCheckAt
    ? new Date(lastCheckAt).toLocaleString("en-US")
    : t("releasecenter.NotYet", { defaultValue: "Not yet" });
  const updaterStatus = nativeUpdater?.updateReady
    ? t("releasecenterview.UpdateReady", { defaultValue: "Update ready" })
    : nativeUpdater?.updateAvailable
      ? t("releasecenterview.UpdateAvailable", {
          defaultValue: "Update available",
        })
      : t("common.idle", { defaultValue: "Idle" });
  const updaterNeedsAttention = Boolean(
    nativeUpdater?.updateReady || nativeUpdater?.updateAvailable,
  );
  const autoUpdateDisabled =
    nativeUpdater != null && !nativeUpdater.canAutoUpdate;
  const canManualCheck =
    applicationUpdate?.canManualCheck ?? Boolean(desktopRuntime);
  const canAutoUpdate =
    applicationUpdate?.canAutoUpdate ?? Boolean(nativeUpdater?.canAutoUpdate);

  const versionRows: Array<{ label: string; value: ReactNode }> = [
    {
      label: t("releasecenterview.App", { defaultValue: "App" }),
      value: appVersion,
    },
    ...(applicationUpdate?.build
      ? [
          {
            label: t("releasecenterview.Build", { defaultValue: "Build" }),
            value: applicationUpdate.build,
          },
        ]
      : []),
    ...(applicationUpdate
      ? [
          {
            label: t("releasecenterview.Distribution", {
              defaultValue: "Distribution",
            }),
            value: applicationUpdate.statusLabel,
          },
        ]
      : []),
    ...(applicationUpdate
      ? [
          {
            label: t("releasecenterview.AutoUpdates", {
              defaultValue: "Auto updates",
            }),
            value: canAutoUpdate
              ? t("common.enabled", { defaultValue: "Enabled" })
              : t("common.disabled", { defaultValue: "Disabled" }),
          },
        ]
      : []),
    ...(desktopRuntime
      ? [
          {
            label: t("common.desktop", {
              defaultValue: "Desktop",
            }),
            value: desktopVersion,
          },
          {
            label: t("common.channel", {
              defaultValue: "Channel",
            }),
            value: channel,
          },
        ]
      : []),
    {
      label: t("common.status", { defaultValue: "Status" }),
      value: (
        <span className="inline-flex items-center gap-1.5">
          {updaterNeedsAttention ? (
            <AlertTriangle className="size-3.5 text-warn" aria-hidden />
          ) : (
            <CheckCircle2 className="size-3.5 text-ok" aria-hidden />
          )}
          {updaterStatus}
        </span>
      ),
    },
    ...(agentUpdate
      ? [
          {
            label: t("releasecenterview.Agent", {
              defaultValue: "Agent",
            }),
            value: agentUpdate.currentVersion,
          },
          {
            label: t("releasecenterview.AgentLatest", {
              defaultValue: "Agent latest",
            }),
            value:
              agentUpdate.latestVersion ??
              t("releasecenterview.Current", { defaultValue: "Current" }),
          },
          {
            label: t("releasecenterview.AgentAuthority", {
              defaultValue: "Agent authority",
            }),
            value: agentUpdate.authorityLabel,
          },
          {
            label: t("releasecenterview.AgentChannel", {
              defaultValue: "Agent channel",
            }),
            value: agentUpdate.channel,
          },
          {
            label: t("releasecenterview.AgentLastChecked", {
              defaultValue: "Agent last checked",
            }),
            value: lastChecked,
          },
          {
            label: t("releasecenterview.AgentStatus", {
              defaultValue: "Agent status",
            }),
            value: (
              <span className="inline-flex items-center gap-1.5">
                {agentUpdate.status === "error" ||
                agentUpdate.status === "update-available" ? (
                  <AlertTriangle className="size-3.5 text-warn" aria-hidden />
                ) : (
                  <CheckCircle2 className="size-3.5 text-ok" aria-hidden />
                )}
                {agentUpdate.statusLabel}
              </span>
            ),
          },
        ]
      : []),
  ];

  const refreshReleaseStateAction = () =>
    void runAction(
      "refresh",
      refreshReleaseState,
      t("releasecenterview.ReleaseStatusRefreshed", {
        defaultValue: "Release status refreshed.",
      }),
    );
  const openReleaseNotesAction = () =>
    void runAction(
      "open-release-notes",
      openReleaseNotesWindow,
      t("releasecenterview.ReleaseNotesOpened", {
        defaultValue: "Release notes opened.",
      }),
    );
  const resetReleaseNotesUrlAction = () =>
    void runAction(
      "reset-release-url",
      async () => {
        releaseNotesUrlDirtyRef.current = false;
        setReleaseNotesUrl(
          normalizeReleaseNotesUrl(
            nativeUpdater?.baseUrl ?? defaultReleaseNotesUrl,
          ),
        );
      },
      t("releasecenterview.ReleaseNotesReset", {
        defaultValue: "Release notes URL reset.",
      }),
    );
  const resetUrlLabel = t("releasecenter.ResetUrl", {
    defaultValue: "Reset URL",
  });
  // Surface only a live update error here; the per-channel prose `detail`
  // strings are explanatory copy, not functional state.
  const releaseDetail = agentUpdate?.error ?? null;

  const refreshAgent = useAgentElement<HTMLButtonElement>({
    id: "updates-refresh",
    role: "button",
    label: t("common.refresh"),
    group: "release-actions",
    description: "Refresh the release and update status",
    onActivate: refreshReleaseStateAction,
  });
  const openReleaseNotesAgent = useAgentElement<HTMLButtonElement>({
    id: "updates-open-release-notes",
    role: "button",
    label: t("common.open", { defaultValue: "Open" }),
    group: "release-notes",
    description: "Open the release notes URL",
    onActivate: openReleaseNotesAction,
  });
  const resetReleaseNotesUrlAgent = useAgentElement<HTMLButtonElement>({
    id: "updates-reset-release-url",
    role: "button",
    label: resetUrlLabel,
    group: "release-notes",
    description: "Reset the release notes URL to its default",
    onActivate: resetReleaseNotesUrlAction,
  });

  return (
    <SettingsStack>
      {actionError && (
        <div
          role="alert"
          className="rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {actionError}
        </div>
      )}
      {actionMessage && (
        <div
          role="status"
          className="rounded-sm border border-ok/30 bg-ok/10 px-3 py-2 text-sm text-ok"
        >
          {actionMessage}
        </div>
      )}
      {autoUpdateDisabled && nativeUpdater?.autoUpdateDisabledReason && (
        <div
          role="status"
          className="rounded-sm border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn"
        >
          {nativeUpdater.autoUpdateDisabledReason}
        </div>
      )}

      <SettingsGroup
        title={t("releasecenterview.Versions", { defaultValue: "Versions" })}
        footer={releaseDetail || undefined}
      >
        {versionRows.map((row) => (
          <SettingsRow
            key={row.label}
            label={row.label}
            control={
              <span className="break-all text-right text-sm font-medium text-txt">
                {row.value}
              </span>
            }
          />
        ))}
      </SettingsGroup>

      <SettingsGroup bare>
        <div className="flex flex-wrap gap-2">
          {desktopRuntime ? (
            <CheckUpdateButton
              label={t("releasecenter.CheckDownloadUpdate", {
                defaultValue: "Check / Download Update",
              })}
              disabled={
                busyAction === "check-updates" ||
                updateLoading ||
                autoUpdateDisabled ||
                !canManualCheck
              }
              onActivate={() =>
                void runAction(
                  "check-updates",
                  checkForDesktopUpdate,
                  t("releasecenterview.CheckStarted", {
                    defaultValue: "Desktop update check started.",
                  }),
                )
              }
            />
          ) : null}
          {desktopRuntime && nativeUpdater?.updateReady && (
            <ApplyUpdateButton
              label={t("releasecenter.ApplyDownloadedUpdate", {
                defaultValue: "Apply Downloaded Update",
              })}
              disabled={busyAction === "apply-update" || autoUpdateDisabled}
              onActivate={() =>
                void runAction(
                  "apply-update",
                  applyDesktopUpdate,
                  t("releasecenterview.ApplyStarted", {
                    defaultValue: "Applying downloaded update.",
                  }),
                )
              }
            />
          )}
          <Button
            ref={refreshAgent.ref}
            size="icon-sm"
            variant="outline"
            disabled={busyAction === "refresh" || updateLoading}
            aria-label={t("common.refresh")}
            title={t("common.refresh")}
            onClick={refreshReleaseStateAction}
            {...refreshAgent.agentProps}
          >
            <RefreshCw
              className={`size-4 ${busyAction === "refresh" || updateLoading ? "animate-spin" : ""}`}
              aria-hidden
            />
          </Button>
          {desktopRuntime ? (
            <DetachReleaseCenterButton
              label={t("releasecenter.OpenDetachedReleaseCenter", {
                defaultValue: "Open Detached Release Center",
              })}
              disabled={busyAction === "detach-release"}
              onActivate={() =>
                void runAction(
                  "detach-release",
                  detachReleaseCenter,
                  t("releasecenterview.DetachedOpened", {
                    defaultValue: "Detached release center opened.",
                  }),
                )
              }
            />
          ) : null}
        </div>
      </SettingsGroup>

      <SettingsGroup
        title={t("releasecenterview.ReleaseNotes", {
          defaultValue: "Release Notes",
        })}
      >
        <SettingsInputRow
          agentId="updates-release-notes-url"
          label={t("releasecenterview.ReleaseNotesUrl", {
            defaultValue: "Release notes URL",
          })}
          type="url"
          value={releaseNotesUrl}
          onValueChange={(value) => {
            releaseNotesUrlDirtyRef.current = true;
            setReleaseNotesUrl(value);
          }}
        />
        <SettingsRow
          label={t("releasecenterview.ReleaseNotes", {
            defaultValue: "Release Notes",
          })}
          stacked
        >
          <div className="flex flex-wrap gap-2">
            <Button
              ref={openReleaseNotesAgent.ref}
              size="compact"
              variant="outline"
              disabled={busyAction === "open-release-notes"}
              onClick={openReleaseNotesAction}
              {...openReleaseNotesAgent.agentProps}
            >
              <ExternalLink className="size-3.5" aria-hidden />
              {t("common.open", { defaultValue: "Open" })}
            </Button>
            <Button
              ref={resetReleaseNotesUrlAgent.ref}
              size="icon-sm"
              variant="ghostMuted"
              aria-label={resetUrlLabel}
              title={resetUrlLabel}
              onClick={resetReleaseNotesUrlAction}
              {...resetReleaseNotesUrlAgent.agentProps}
            >
              <RotateCcw className="size-4" aria-hidden />
            </Button>
          </div>
        </SettingsRow>
      </SettingsGroup>
    </SettingsStack>
  );
}
