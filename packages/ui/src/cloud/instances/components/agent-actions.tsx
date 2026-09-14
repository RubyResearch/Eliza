/**
 * ElizaAgentActions — start/stop/deactivate/reactivate/upgrade/delete
 * controls on the agent detail page.
 *
 * **Upgrade to Dedicated** (shared-tier agents only, #15355) drives the whole
 * Shared→Dedicated activation from this page: GET loads the server-owned
 * price/balance/runway quote, a confirm dialog renders it without client math,
 * then POST carries that exact quote plus the explicit activation action and
 * mints + provisions the dedicated migration target
 * (identity copied server-side) and the handoff module moves the conversation
 * and — only on a confirmed switch — removes the shared bridge before this
 * page navigates to the new agent.
 *
 * **Deactivate** is the user-facing name for the `sleep` lifecycle action
 * (`POST /sleep`): a deep cold suspend that saves a durable encrypted backup,
 * removes the container, and frees the compute slot, so the agent stops
 * consuming hourly credits entirely (the billing cron skips `sleeping` rows).
 * It sits next to Delete as the non-destructive alternative and requires a
 * confirm dialog that spells out the billing consequences. **Reactivate**
 * (`POST /wake`) re-provisions compute and restores the backup — it can take a
 * few minutes, so the tracked-job progress line carries wake-specific copy.
 * Both ride the existing 202 + jobId poll path.
 */
"use client";

import type { AgentExecutionTier } from "@elizaos/cloud-sdk";
import {
  AGENT_PRICING,
  DEDICATED_COMPUTE_PRICE_HEADER,
  formatHourlyRate,
  formatUSD,
  getDedicatedComputePriceAcceptance,
} from "@elizaos/cloud-sdk/browser-contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@elizaos/ui/cloud-ui";
import { useQuery } from "@tanstack/react-query";
import {
  ExternalLink,
  Loader2,
  Moon,
  Pause,
  Play,
  Rocket,
  Sun,
  Trash2,
} from "lucide-react";
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { client, ElizaClient } from "../../../api";
import { toast } from "../../../bridge/toast";
import { Alert } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { getBootConfig } from "../../../config/boot-config";
import { dispatchCloudHandoffPhase } from "../../../events";
import { directCloudSharedAgentIdFromBase } from "../../../utils/cloud-agent-base";
import { silentlyRepointToDedicated } from "../../handoff/silent-repoint";
import { runSharedToDedicatedUpgradeHandoff } from "../../handoff/start-tier-upgrade";
import { apiWithStatus, readCloudBearerToken } from "../../lib/api-client";
import { useT } from "../lib/i18n";
import { openWebUIWithPairing } from "../lib/open-web-ui";
import { useJobPoller } from "../lib/use-job-poller";
import { DedicatedStartConfirmation } from "./dedicated-start-confirmation";

interface ElizaAgentActionsProps {
  agentId: string;
  executionTier: AgentExecutionTier;
  status: string;
  showWebUiAction?: boolean;
}

interface DedicatedActivationQuote {
  quoteId: string;
  sourceAgentId: string;
  hourlyRateUsd: number;
  minimumActivationChargeUsd: number;
  dailyRateUsd: number;
  minimumBalanceUsd: number;
  minimumRunwayDays: number;
  balanceUsd: number;
  deficitUsd: number;
  canActivate: boolean;
  requiresConfirmation: true;
  action: "activate_dedicated";
  unavailableReason?: string;
  activation:
    | { state: "available" }
    | {
        state: "in_progress";
        dedicatedAgentId: string;
        status: string;
      };
}

export function ElizaAgentActions({
  agentId,
  executionTier,
  status,
  showWebUiAction = true,
}: ElizaAgentActionsProps) {
  const t = useT();
  const navigate = useNavigate();
  const [loading, setLoading] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showDeactivateConfirm, setShowDeactivateConfirm] = useState(false);
  const [startAction, setStartAction] = useState<"resume" | "wake" | null>(
    null,
  );
  const [showUpgradeConfirm, setShowUpgradeConfirm] = useState(false);
  const [upgradeQuote, setUpgradeQuote] =
    useState<DedicatedActivationQuote | null>(null);
  // Set for the whole shared→dedicated upgrade span (provision + transcript
  // move); the id is the dedicated migration target this page navigates to on
  // a confirmed switch.
  const [upgradeTargetId, setUpgradeTargetId] = useState<string | null>(null);
  const jobActionById = useRef(new Map<string, string>());

  const poller = useJobPoller({
    onComplete: (job) => {
      const action = jobActionById.current.get(job.jobId);
      jobActionById.current.delete(job.jobId);
      if (action === "delete") {
        toast.success(
          t("cloud.containers.agentActions.agentDeleted", {
            defaultValue: "Agent deleted",
          }),
        );
        navigate("/cloud/agents");
        return;
      }
      if (action === "sleep") {
        toast.success(
          t("cloud.containers.agentActions.deactivated", {
            defaultValue: "Agent deactivated — hourly billing stopped",
          }),
        );
        return;
      }
      if (action === "wake") {
        toast.success(
          t("cloud.containers.agentActions.reactivated", {
            defaultValue: "Agent reactivated",
          }),
        );
        return;
      }
      toast.success(
        t("cloud.containers.agentActions.jobCompleted", {
          defaultValue: "{action} completed",
          action: action ?? "Agent job",
        }),
      );
    },
    onFailed: (job) => {
      const action = jobActionById.current.get(job.jobId);
      jobActionById.current.delete(job.jobId);
      toast.error(
        job.error ??
          t("cloud.containers.agentActions.jobFailed", {
            defaultValue: "{action} failed",
            action: action ?? "Agent job",
          }),
      );
    },
  });

  // Progress display for the dedicated migration target's provision job. A
  // SEPARATE poller instance with the hard-reload disabled: the transcript
  // handoff keeps running in this page after the provision job completes, and
  // the default `window.location.reload()` would kill it mid-import.
  const upgradePoller = useJobPoller({ autoRefresh: false });

  const trackedJob = poller.getStatus(agentId);
  const trackedAction = trackedJob
    ? jobActionById.current.get(trackedJob.jobId)
    : undefined;
  const effectiveStatus = poller.isActive(agentId) ? "provisioning" : status;

  const isRunning = effectiveStatus === "running";
  const isSleeping = effectiveStatus === "sleeping";
  const isDedicated = executionTier !== "shared";
  // Do not infer reachability from the optional published URL. The pairing
  // endpoint is the authority and can return either the managed HTTPS route or
  // the explicitly loopback-bound local Docker handoff.
  const hasStandaloneWebUi = showWebUiAction && isRunning && isDedicated;
  // Sleep (deep cold suspend) only applies to dedicated agents with their own
  // compute slot — shared-runtime agents have nothing to free.
  const canSleep = isRunning && isDedicated;
  const canWake = isSleeping;
  // Tier upgrade is a shared-agent-only promotion (#15355); a dedicated agent
  // already runs on its own container.
  const canUpgrade = isRunning && !isDedicated && !upgradeTargetId;
  const upgradeQuoteQuery = useQuery({
    queryKey: ["agent-dedicated-upgrade-quote", agentId],
    queryFn: async () => {
      const { status: httpStatus, data } = await apiWithStatus<{
        success?: boolean;
        data?: DedicatedActivationQuote;
        error?: string;
      }>(`/api/v1/eliza/agents/${encodeURIComponent(agentId)}/upgrade-tier`, {
        method: "GET",
      });
      if (httpStatus < 200 || httpStatus >= 300 || !data?.data) {
        throw new Error(data?.error ?? `HTTP ${httpStatus}`);
      }
      if (
        !Number.isFinite(data.data.minimumActivationChargeUsd) ||
        data.data.minimumActivationChargeUsd < 0
      ) {
        throw new Error(
          "The current Dedicated charge could not be loaded. Refresh and try again.",
        );
      }
      return data.data;
    },
    enabled: canUpgrade,
    staleTime: 15_000,
    retry: false,
  });
  const upgradeJob = upgradePoller.getStatus(agentId);
  const isResumingDedicatedSetup =
    upgradeQuoteQuery.data?.activation.state === "in_progress";
  const quotedSetupIsResuming =
    upgradeQuote?.activation.state === "in_progress";
  const isStopped = ["stopped", "error", "pending", "disconnected"].includes(
    effectiveStatus,
  );
  const isBusy = effectiveStatus === "provisioning";

  async function doAction(action: string, method = "POST") {
    setLoading(action);
    try {
      let url = `/api/v1/eliza/agents/${agentId}`;
      let json: unknown;

      if (action === "resume") {
        url = `/api/v1/eliza/agents/${agentId}/resume`;
      } else if (action === "provision") {
        url = `/api/v1/eliza/agents/${agentId}/provision`;
      } else if (action === "sleep") {
        url = `/api/v1/eliza/agents/${agentId}/sleep`;
      } else if (action === "wake") {
        url = `/api/v1/eliza/agents/${agentId}/wake`;
      } else if (action === "delete") {
        method = "DELETE";
      } else if (action === "shutdown" || action === "suspend") {
        method = "PATCH";
        json = { action: "suspend" };
      }

      const { status: httpStatus, data } = await apiWithStatus<{
        data?: { jobId?: string };
        error?: string;
      }>(url, {
        method,
        json,
        ...(isDedicated && ["resume", "wake", "provision"].includes(action)
          ? {
              headers: {
                [DEDICATED_COMPUTE_PRICE_HEADER]:
                  getDedicatedComputePriceAcceptance(),
              },
            }
          : {}),
      });
      const jobId = data?.data?.jobId;

      // 409 — operation already in flight; attach to the existing job when the
      // backend returned one. Informational, not an error.
      if (httpStatus === 409) {
        if (jobId) {
          jobActionById.current.set(jobId, action);
          poller.track(agentId, jobId);
        }
        toast.info(
          t("cloud.containers.agentActions.actionAlreadyInProgress", {
            defaultValue: "{action} already in progress",
            action,
          }),
        );
        return;
      }

      if (httpStatus < 200 || httpStatus >= 300) {
        throw new Error(data?.error ?? `HTTP ${httpStatus}`);
      }

      // 202 + jobId — the backend enqueued a job; track it.
      if (httpStatus === 202 && jobId) {
        jobActionById.current.set(jobId, action);
        poller.track(agentId, jobId);
        const queuedMessages: Record<string, string> = {
          provision: t("cloud.containers.agentActions.provisioningQueued", {
            defaultValue: "Agent provisioning queued",
          }),
          resume: t("cloud.containers.agentActions.resumeQueued", {
            defaultValue: "Agent resume queued",
          }),
          suspend: t("cloud.containers.agentActions.suspendQueued", {
            defaultValue: "Suspend queued",
          }),
          shutdown: t("cloud.containers.agentActions.suspendQueued", {
            defaultValue: "Suspend queued",
          }),
          sleep: t("cloud.containers.agentActions.deactivateQueued", {
            defaultValue: "Deactivation queued — retaining your agent data",
          }),
          wake: t("cloud.containers.agentActions.reactivateQueued", {
            defaultValue:
              "Reactivation queued — restoring your agent data (this can take a few minutes)",
          }),
          delete: t("cloud.containers.agentActions.deleteQueued", {
            defaultValue: "Delete queued",
          }),
        };
        toast.success(
          queuedMessages[action] ??
            t("cloud.containers.agentActions.actionQueued", {
              defaultValue: "{action} queued",
              action,
            }),
        );
        return;
      }

      if (action === "delete") {
        toast.success(
          t("cloud.containers.agentActions.agentDeleted", {
            defaultValue: "Agent deleted",
          }),
        );
        navigate("/cloud/agents");
        return;
      }

      // Fallback: synchronous success (no jobId returned).
      const messages: Record<string, string> = {
        provision: t("cloud.containers.agentActions.provisioningStarted", {
          defaultValue: "Agent provisioning started",
        }),
        resume: t("cloud.containers.agentActions.resuming", {
          defaultValue: "Agent resuming",
        }),
        suspend: t("cloud.containers.agentActions.suspended", {
          defaultValue: "Agent suspended",
        }),
        sleep: t("cloud.containers.agentActions.deactivated", {
          defaultValue: "Agent deactivated — hourly billing stopped",
        }),
        wake: t("cloud.containers.agentActions.reactivated", {
          defaultValue: "Agent reactivated",
        }),
      };
      toast.success(
        messages[action] ??
          t("cloud.containers.agentActions.done", { defaultValue: "Done" }),
      );
      window.location.reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(
        `${t("cloud.containers.agentActions.actionFailed", { defaultValue: "Action failed" })}: ${msg}`,
      );
    } finally {
      setLoading(null);
      setShowDeleteConfirm(false);
      setShowDeactivateConfirm(false);
    }
  }

  async function reviewDedicatedQuote() {
    setLoading("upgrade-quote");
    try {
      const quote =
        upgradeQuoteQuery.data ?? (await upgradeQuoteQuery.refetch()).data;
      if (!quote) {
        throw (
          upgradeQuoteQuery.error ?? new Error("Dedicated quote unavailable")
        );
      }
      setUpgradeQuote(quote);
      setShowUpgradeConfirm(true);
    } catch (err) {
      toast.error(
        `${t("cloud.containers.agentActions.upgradeQuoteFailed", { defaultValue: "Could not load the current Dedicated quote" })}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setLoading(null);
    }
  }

  /**
   * Shared→dedicated tier upgrade (#15355), end to end from this page:
   * `POST /upgrade-tier` mints + provisions the dedicated migration target
   * (402 = the server's N-days-of-hosting credit gate; a retry reattaches to
   * the same in-flight target instead of minting another), then the handoff
   * module polls readiness, copies the conversation, and — only on a confirmed
   * switch — deletes the shared bridge, after which this page navigates to the
   * dedicated agent. On timeout/failure the shared agent is untouched and the
   * action can simply be retried.
   */
  async function doUpgrade() {
    if (!upgradeQuote) return;
    setLoading("upgrade-tier");
    setShowUpgradeConfirm(false);
    try {
      const { status: httpStatus, data } = await apiWithStatus<{
        data?:
          | { dedicatedAgentId?: string; jobId?: string }
          | DedicatedActivationQuote;
        code?: string;
        error?: string;
      }>(`/api/v1/eliza/agents/${encodeURIComponent(agentId)}/upgrade-tier`, {
        method: "POST",
        json: {
          action: "activate_dedicated",
          quoteId: upgradeQuote.quoteId,
          minimumActivationChargeUsd: upgradeQuote.minimumActivationChargeUsd,
        },
      });

      if (
        httpStatus === 409 &&
        data?.code === "dedicated_quote_changed" &&
        data.data &&
        "quoteId" in data.data
      ) {
        setUpgradeQuote(data.data);
        setShowUpgradeConfirm(true);
        toast.info(
          t("cloud.containers.agentActions.upgradeQuoteChanged", {
            defaultValue:
              "Your balance or Dedicated price changed. Review the updated quote before confirming.",
          }),
        );
        return;
      }

      if (httpStatus === 402) {
        // The canonical insufficient-credits body carries the real enforced
        // numbers — render the server's message, never client math.
        toast.error(
          data?.error ??
            t("cloud.containers.agentActions.upgradeInsufficientCredits", {
              defaultValue:
                "Not enough credits to upgrade. Add funds at /cloud/billing and try again.",
            }),
        );
        return;
      }
      if (httpStatus < 200 || httpStatus >= 300) {
        throw new Error(data?.error ?? `HTTP ${httpStatus}`);
      }

      const dedicatedAgentId =
        data?.data && "dedicatedAgentId" in data.data
          ? data.data.dedicatedAgentId
          : undefined;
      if (!dedicatedAgentId) {
        throw new Error("Upgrade did not return a dedicated agent id");
      }
      const jobId =
        data?.data && "jobId" in data.data ? data.data.jobId : undefined;
      if (jobId) {
        upgradePoller.track(agentId, jobId);
      }
      setUpgradeTargetId(dedicatedAgentId);
      toast.success(
        quotedSetupIsResuming
          ? t("cloud.containers.agentActions.upgradeResumed", {
              defaultValue:
                "Dedicated setup resumed — recovering your existing agent. Keep this page open.",
            })
          : t("cloud.containers.agentActions.upgradeStarted", {
              defaultValue:
                "Upgrade started — provisioning your dedicated agent. Keep this page open.",
            }),
      );

      const cloudApiBase =
        getBootConfig().cloudApiBase?.trim() || window.location.origin;
      const authToken = await readCloudBearerToken();
      if (!authToken) {
        throw new Error(
          "Cloud session token unavailable — reload the page and try again.",
        );
      }
      // The handoff's readiness probe doubles as the provisioning wait (a cold
      // dedicated boot is 30-120s); the visible job line above tracks the
      // provision job itself.
      let activeChatSwitched = false;
      const outcome = await runSharedToDedicatedUpgradeHandoff({
        sharedAgentId: agentId,
        dedicatedAgentId,
        cloudApiBase,
        authToken,
        client: new ElizaClient(cloudApiBase, authToken),
        intervalMs: 5_000,
        timeoutMs: 10 * 60_000,
        onSwitch: (containerBase) => {
          // A management page can upgrade any owned agent. Repoint only when
          // this is still the Shared agent serving the mounted chat; otherwise
          // completing an unrelated upgrade must not hijack the active runtime.
          if (
            directCloudSharedAgentIdFromBase(client.getBaseUrl()) !== agentId
          ) {
            return;
          }
          silentlyRepointToDedicated({
            containerBase,
            dedicatedAgentId,
            authToken,
            personalElizaId: agentId,
          });
          activeChatSwitched = true;
        },
      });

      if (
        outcome.status === "switched" ||
        outcome.status === "switched-empty"
      ) {
        if (activeChatSwitched) {
          dispatchCloudHandoffPhase({
            agentId,
            phase: outcome.status,
            imported: outcome.imported,
          });
        }
        toast.success(
          t("cloud.containers.agentActions.upgradeComplete", {
            defaultValue:
              "Upgrade complete — your conversation moved to the dedicated agent.",
          }),
        );
        if (outcome.sourceCleanup === "not-cleaned") {
          // The user is switched either way. Keep the still-authoritative row
          // visible and describe the cleanup failure without offering a Shared
          // delete control that the product intentionally does not expose.
          toast.info(
            t("cloud.containers.agentActions.upgradeSharedLeftBehind", {
              defaultValue:
                "The Shared Agent remains visible because automatic cleanup did not complete. Try again later or contact support.",
            }),
          );
        }
        navigate(`/cloud/agents/${dedicatedAgentId}`);
        return;
      }

      setUpgradeTargetId(null);
      toast.error(
        outcome.error ??
          t("cloud.containers.agentActions.upgradeNotReady", {
            defaultValue:
              "The dedicated agent did not become ready in time. Your shared agent keeps working — try the upgrade again to resume it.",
          }),
      );
    } catch (err) {
      setUpgradeTargetId(null);
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(
        `${t("cloud.containers.agentActions.upgradeFailed", { defaultValue: "Upgrade failed" })}: ${msg}`,
      );
    } finally {
      setLoading(null);
    }
  }

  return (
    <>
      <div className="space-y-4">
        {isSleeping && (
          <Alert
            variant="sidebar"
            className="flex items-start gap-3 p-3"
            data-testid="agent-deactivated-panel"
          >
            <Moon className="size-4 shrink-0 mt-0.5 text-white/50" />
            <p
              className="text-sm text-white/60"
              style={{ fontFamily: "var(--font-roboto-mono)" }}
            >
              {t("cloud.containers.agentActions.deactivatedPanel", {
                defaultValue:
                  "This agent is deactivated. It is not running and is not consuming hourly credits; its data is retained. Reactivation can take a few minutes and requires available credits.",
              })}
            </p>
          </Alert>
        )}

        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex flex-wrap gap-3">
            {hasStandaloneWebUi && (
              <Button
                variant="default"
                size="sm"
                className="min-h-touch"
                onClick={() => void openWebUIWithPairing(agentId)}
              >
                <ExternalLink className="size-4" />
                {t("cloud.containers.agentActions.openWebUi", {
                  defaultValue: "Open Web UI",
                })}
              </Button>
            )}

            {canUpgrade && (
              <Button
                variant="default"
                size="sm"
                className="min-h-touch"
                onClick={() => void reviewDedicatedQuote()}
                disabled={!!loading || isBusy}
                data-testid="agent-upgrade-tier-button"
                title={t("cloud.containers.agentActions.upgradeHint", {
                  defaultValue:
                    "Move to a private, always-on Dedicated Agent. Your conversation moves with it.",
                })}
              >
                {loading === "upgrade-tier" || loading === "upgrade-quote" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Rocket className="size-4" />
                )}
                {upgradeQuoteQuery.data?.canActivate === false
                  ? t("cloud.containers.agentActions.addCredits", {
                      defaultValue: "Add funds to upgrade",
                    })
                  : isResumingDedicatedSetup
                    ? t("cloud.containers.agentActions.upgradeResume", {
                        defaultValue: "Resume Dedicated setup",
                      })
                    : t("cloud.containers.agentActions.upgrade", {
                        defaultValue: "Upgrade to Dedicated",
                      })}
              </Button>
            )}

            {isStopped && (
              <Button
                variant="default"
                size="sm"
                className="min-h-touch"
                onClick={() =>
                  isDedicated ? setStartAction("resume") : doAction("resume")
                }
                disabled={!!loading || isBusy}
              >
                {loading === "resume" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Play className="size-4" />
                )}
                {t("cloud.containers.agentActions.resume", {
                  defaultValue: "Resume Agent",
                })}
              </Button>
            )}

            {canWake && (
              <Button
                variant="default"
                size="sm"
                className="min-h-touch"
                onClick={() =>
                  isDedicated ? setStartAction("wake") : doAction("wake")
                }
                disabled={!!loading || isBusy}
                title={t("cloud.containers.agentActions.reactivateHint", {
                  defaultValue:
                    "Restores the agent's retained data and starts it again. This can take a few minutes.",
                })}
              >
                {loading === "wake" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Sun className="size-4" />
                )}
                {t("cloud.containers.agentActions.reactivate", {
                  defaultValue: "Reactivate Agent",
                })}
              </Button>
            )}

            {isRunning && isDedicated && (
              <Button
                variant="outline"
                size="sm"
                className="min-h-touch"
                onClick={() => doAction("suspend", "PATCH")}
                disabled={!!loading || isBusy}
              >
                {loading === "suspend" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Pause className="size-4" />
                )}
                {t("cloud.containers.agentActions.suspend", {
                  defaultValue: "Suspend Agent",
                })}
              </Button>
            )}
          </div>

          <div className="flex flex-wrap gap-2 lg:justify-end">
            {canSleep && (
              <Button
                variant="outline"
                size="sm"
                className="min-h-touch"
                onClick={() => setShowDeactivateConfirm(true)}
                disabled={!!loading || isBusy}
                title={t("cloud.containers.agentActions.deactivateHint", {
                  defaultValue:
                    "Stops the agent and its hourly billing while retaining its data; reactivate anytime.",
                })}
              >
                {loading === "sleep" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Moon className="size-4" />
                )}
                {t("cloud.containers.agentActions.deactivate", {
                  defaultValue: "Deactivate Agent",
                })}
              </Button>
            )}

            {isDedicated && !showDeleteConfirm ? (
              <Button
                variant="dangerOutline"
                size="sm"
                onClick={() => setShowDeleteConfirm(true)}
                disabled={!!loading || isBusy}
                className="min-h-touch"
              >
                <Trash2 className="size-4" />
                {t("cloud.containers.agentActions.delete", {
                  defaultValue: "Delete Agent",
                })}
              </Button>
            ) : isDedicated ? (
              <Alert
                variant="dangerConfirm"
                className="flex flex-wrap items-center gap-2 p-3"
              >
                <span
                  className="text-sm text-destructive"
                  style={{ fontFamily: "var(--font-roboto-mono)" }}
                >
                  {t("cloud.containers.agentActions.confirmDelete", {
                    defaultValue: "Confirm delete?",
                  })}
                </span>
                <Button
                  variant="dangerOutline"
                  size="sm"
                  onClick={() => doAction("delete", "DELETE")}
                  disabled={!!loading}
                  className="min-h-touch"
                >
                  {loading === "delete" ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : null}
                  {t("cloud.containers.agentActions.yesDelete", {
                    defaultValue: "Yes, delete",
                  })}
                </Button>
                <Button
                  variant="outlineMuted"
                  size="sm"
                  onClick={() => setShowDeleteConfirm(false)}
                  className="min-h-touch"
                >
                  {t("cloud.containers.agentActions.cancel", {
                    defaultValue: "Cancel",
                  })}
                </Button>
              </Alert>
            ) : null}
          </div>
        </div>

        {upgradeTargetId && (
          <div className="space-y-1" data-testid="agent-upgrade-progress">
            <p
              className="text-sm text-status-warning flex items-center gap-2"
              style={{ fontFamily: "var(--font-roboto-mono)" }}
            >
              <Loader2 className="size-4 animate-spin" />
              {quotedSetupIsResuming
                ? t("cloud.containers.agentActions.upgradeResumeProgressHint", {
                    defaultValue:
                      "Recovering your existing Dedicated Agent and moving your conversation only after it is healthy. This can take a few minutes; keep this page open.",
                  })
                : t("cloud.containers.agentActions.upgradeProgressHint", {
                    defaultValue:
                      "Upgrading — provisioning a dedicated agent and moving your conversation onto it. This can take a few minutes; keep this page open.",
                  })}
            </p>
            {upgradeJob && (
              <p
                className="text-xs text-white/60"
                style={{ fontFamily: "var(--font-roboto-mono)" }}
              >
                {t("cloud.containers.agentActions.jobLabel", {
                  defaultValue: "Job",
                })}{" "}
                {upgradeJob.jobId.slice(0, 8)} • {upgradeJob.status}
              </p>
            )}
          </div>
        )}

        {poller.isActive(agentId) && (
          <div className="space-y-1">
            <p
              className="text-sm text-status-warning flex items-center gap-2"
              style={{ fontFamily: "var(--font-roboto-mono)" }}
            >
              <Loader2 className="size-4 animate-spin" />
              {trackedAction === "delete"
                ? t("cloud.containers.agentActions.deleteHint", {
                    defaultValue:
                      "Agent delete is running. This page will return to Instances when the job finishes.",
                  })
                : trackedAction === "sleep"
                  ? t("cloud.containers.agentActions.deactivateProgressHint", {
                      defaultValue:
                        "Deactivating — retaining your agent data and stopping dedicated hosting. This page will refresh when the job finishes.",
                    })
                  : trackedAction === "wake"
                    ? t(
                        "cloud.containers.agentActions.reactivateProgressHint",
                        {
                          defaultValue:
                            "Reactivating — restoring your agent data. This can take a few minutes; the page will refresh when it finishes.",
                        },
                      )
                    : t("cloud.containers.agentActions.provisioningHint", {
                        defaultValue:
                          "Agent job is running. This page will refresh when the job finishes.",
                      })}
            </p>
            {trackedJob && (
              <p
                className="text-xs text-white/60"
                style={{ fontFamily: "var(--font-roboto-mono)" }}
              >
                {t("cloud.containers.agentActions.jobLabel", {
                  defaultValue: "Job",
                })}{" "}
                {trackedJob.jobId.slice(0, 8)} • {trackedJob.status}
              </p>
            )}
          </div>
        )}

        {trackedJob?.status === "failed" && (
          <Alert variant="destructive" className="block p-3">
            <p
              className="text-sm text-destructive"
              style={{ fontFamily: "var(--font-roboto-mono)" }}
            >
              {trackedJob.error ??
                t("cloud.containers.agentActions.jobFailed", {
                  defaultValue: "Agent job failed",
                })}
            </p>
            <p className="mt-1 text-xs text-white/60">
              {t("cloud.containers.agentActions.failureRecovery", {
                defaultValue:
                  "Your agent was left in its previous state. Review the message, then retry the action when ready.",
              })}
            </p>
          </Alert>
        )}
      </div>

      <DedicatedStartConfirmation
        open={startAction !== null}
        disabled={!!loading || isBusy}
        onOpenChange={(open) => {
          if (!open) setStartAction(null);
        }}
        onConfirm={() => {
          const action = startAction;
          setStartAction(null);
          if (action) void doAction(action);
        }}
      />
      {/* Upgrade confirmation renders the immutable server quote. No compute
          starts until the user confirms that exact quote. */}
      <AlertDialog
        open={showUpgradeConfirm}
        onOpenChange={setShowUpgradeConfirm}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-txt-strong">
              {quotedSetupIsResuming
                ? t("cloud.containers.agentActions.upgradeResumeTitle", {
                    defaultValue: "Resume Dedicated setup?",
                  })
                : t("cloud.containers.agentActions.upgradeTitle", {
                    defaultValue: "Upgrade to a Dedicated Agent?",
                  })}
            </AlertDialogTitle>
            {upgradeQuote ? (
              <AlertDialogDescription className="text-muted">
                <span className="block">
                  {quotedSetupIsResuming
                    ? t("cloud.containers.agentActions.upgradeResumeBody1", {
                        defaultValue:
                          "A Dedicated Agent already exists for this upgrade, but setup did not finish. Resuming reuses that agent — it does not create another one. Hosting uses {{daily}} per day ({{rate}}) while running.",
                        daily: formatUSD(upgradeQuote.dailyRateUsd),
                        rate: formatHourlyRate(upgradeQuote.hourlyRateUsd),
                      })
                    : t("cloud.containers.agentActions.upgradeBody1", {
                        defaultValue:
                          "Your Shared Agent becomes a private, always-on Dedicated Agent. Dedicated hosting uses {{daily}} per day ({{rate}}) while running.",
                        daily: formatUSD(upgradeQuote.dailyRateUsd),
                        rate: formatHourlyRate(upgradeQuote.hourlyRateUsd),
                      })}
                </span>
                <span className="mt-3 block text-txt-strong">
                  {t("cloud.join.dedicatedActivationMinimum", {
                    defaultValue:
                      "Minimum charge per successful start: {{minimum}}. Applies again after stopping and restarting.",
                    minimum: formatUSD(upgradeQuote.minimumActivationChargeUsd),
                  })}
                </span>
                <span className="mt-3 block text-txt-strong">
                  {t("cloud.containers.agentActions.upgradeBalance", {
                    defaultValue:
                      "Current balance: {{balance}} · Required before activation: {{minimum}} ({{days}} days)",
                    balance: formatUSD(upgradeQuote.balanceUsd),
                    minimum: formatUSD(upgradeQuote.minimumBalanceUsd),
                    days: String(upgradeQuote.minimumRunwayDays),
                  })}
                </span>
                <span className="mt-3 block">
                  {quotedSetupIsResuming
                    ? t("cloud.containers.agentActions.upgradeResumeBody3", {
                        defaultValue:
                          "Shared keeps working while the existing Dedicated Agent recovers. Your conversation moves only after it is healthy; if recovery fails, nothing switches.",
                      })
                    : t("cloud.containers.agentActions.upgradeBody3", {
                        defaultValue:
                          "Shared keeps working while Dedicated starts. Your conversation moves only after the new Eliza is healthy; if setup fails, nothing switches.",
                      })}
                </span>
                {!upgradeQuote.canActivate ? (
                  <span className="mt-3 block text-destructive" role="alert">
                    {upgradeQuote.unavailableReason ??
                      t("cloud.containers.agentActions.upgradeNeedsCredits", {
                        defaultValue:
                          "Add {{deficit}} in credits before activating Dedicated.",
                        deficit: formatUSD(upgradeQuote.deficitUsd),
                      })}
                  </span>
                ) : null}
              </AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="outline">
                {t("cloud.containers.agentActions.cancel", {
                  defaultValue: "Cancel",
                })}
              </Button>
            </AlertDialogCancel>
            {upgradeQuote?.canActivate ? (
              <AlertDialogAction asChild>
                <Button
                  type="button"
                  disabled={!!loading || isBusy}
                  onClick={() => void doUpgrade()}
                  data-testid="agent-upgrade-tier-confirm"
                >
                  {loading === "upgrade-tier" ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Rocket className="size-4" />
                  )}
                  {quotedSetupIsResuming
                    ? t("cloud.containers.agentActions.upgradeContinue", {
                        defaultValue: "Resume setup",
                      })
                    : t("cloud.containers.agentActions.upgradeConfirm", {
                        defaultValue: "Activate Dedicated",
                      })}
                </Button>
              </AlertDialogAction>
            ) : (
              <AlertDialogAction asChild>
                <Button
                  type="button"
                  onClick={() => {
                    setShowUpgradeConfirm(false);
                    navigate("/cloud/billing");
                  }}
                >
                  {t("cloud.containers.agentActions.addCredits", {
                    defaultValue: "Add funds to upgrade",
                  })}
                </Button>
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Deactivate confirm — non-destructive counterpart to delete: spells
          out the billing consequence before the sleep job is enqueued. */}
      <AlertDialog
        open={showDeactivateConfirm}
        onOpenChange={setShowDeactivateConfirm}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-txt-strong">
              {t("cloud.containers.agentActions.deactivateTitle", {
                defaultValue: "Deactivate this agent?",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-muted">
              <span className="block">
                {t("cloud.containers.agentActions.deactivateBody1", {
                  defaultValue:
                    "Your agent stops running and stops consuming hourly credits (currently {{rate}} while running).",
                  rate: formatHourlyRate(AGENT_PRICING.RUNNING_HOURLY_RATE),
                })}
              </span>
              <span className="block mt-2">
                {t("cloud.containers.agentActions.deactivateBody2", {
                  defaultValue:
                    "Eliza retains your agent data during deactivation. If deactivation cannot complete, the agent stays running and billing continues.",
                })}
              </span>
              <span className="block mt-2">
                {t("cloud.containers.agentActions.deactivateMinimum", {
                  defaultValue:
                    "Any remaining activation minimum is charged when you stop.",
                })}
              </span>
              <span className="block mt-2">
                {t("cloud.containers.agentActions.deactivateBody3", {
                  defaultValue:
                    "Reactivation restores the agent's retained data and can take a few minutes; it requires available credits.",
                })}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="outline">
                {t("cloud.containers.agentActions.cancel", {
                  defaultValue: "Cancel",
                })}
              </Button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                type="button"
                disabled={!!loading || isBusy}
                onClick={() => doAction("sleep")}
              >
                {loading === "sleep" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Moon className="size-4" />
                )}
                {t("cloud.containers.agentActions.deactivateConfirm", {
                  defaultValue: "Yes, deactivate",
                })}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
