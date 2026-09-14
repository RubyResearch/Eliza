/**
 * Pricing banner shown at the top of the Instances page.
 * Displays current usage rates and estimated costs based on active agents.
 */

"use client";

import {
  AGENT_PRICING,
  estimateHoursRemaining,
  formatDuration,
  formatHourlyRate,
  formatMonthlyEstimate,
  formatUSD,
  MONTHLY_IDLE_COST,
  MONTHLY_RUNNING_COST,
} from "@elizaos/cloud-sdk/browser-contracts";
import { Card, CornerBrackets, StatusBadge } from "@elizaos/ui/cloud-ui";
import { Clock, DollarSign, TrendingDown, Zap } from "lucide-react";
import { useT } from "../lib/i18n";

interface ElizaAgentPricingBannerProps {
  sharedCount: number;
  runningCount: number;
  idleCount: number;
  /** null = balance unavailable (e.g. still loading); renders as "—". */
  creditBalance: number | null;
}

export function ElizaAgentPricingBanner({
  sharedCount,
  runningCount,
  idleCount,
  creditBalance,
}: ElizaAgentPricingBannerProps) {
  const t = useT();
  const totalMonthlyCost =
    runningCount * MONTHLY_RUNNING_COST + idleCount * MONTHLY_IDLE_COST;
  const hasBillableAgents = runningCount + idleCount > 0;
  const hasAgents = hasBillableAgents || sharedCount > 0;

  const hoursRemaining =
    creditBalance !== null && hasBillableAgents
      ? estimateHoursRemaining(creditBalance, runningCount, idleCount)
      : null;

  const isLowBalance =
    hasBillableAgents &&
    creditBalance !== null &&
    creditBalance < AGENT_PRICING.LOW_CREDIT_WARNING;

  return (
    <Card variant="brand" className="relative overflow-hidden">
      <CornerBrackets size="sm" className="opacity-30" />

      <div className="relative z-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center size-7 bg-white/5 border border-white/10">
              <DollarSign className="size-3.5 text-white/70" />
            </div>
            <p className="text-sm font-medium text-white">
              {t("cloud.containers.pricingBanner.usageRates", {
                defaultValue: "Usage & Rates",
              })}
            </p>
          </div>
          {isLowBalance && hasAgents && (
            <StatusBadge
              status="danger"
              label={t("cloud.containers.pricingBanner.lowBalance", {
                defaultValue: "Low balance",
              })}
            />
          )}
        </div>

        {/* Rate cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-white/5 border border-white/10">
          {/* Running rate */}
          <div className="bg-black/60 p-3.5 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Zap className="size-3 text-status-success" />
              <p className="text-2xs uppercase tracking-[0.2em] text-white/60">
                {t("cloud.containers.pricingBanner.running", {
                  defaultValue: "Running",
                })}
              </p>
            </div>
            <p className="text-base font-mono font-semibold text-white tabular-nums">
              {formatHourlyRate(AGENT_PRICING.RUNNING_HOURLY_RATE)}
            </p>
            <p className="text-2xs text-white/30 font-mono">
              {formatMonthlyEstimate(AGENT_PRICING.RUNNING_HOURLY_RATE)}
            </p>
            <p className="text-xs text-white/72">
              {t("cloud.containers.pricingBanner.activationMinimum", {
                defaultValue: "{{minimum}} minimum per successful start",
                minimum: formatUSD(AGENT_PRICING.MINIMUM_ACTIVATION_CHARGE),
              })}
            </p>
          </div>

          {/* Idle rate */}
          <div className="bg-black/60 p-3.5 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <TrendingDown className="size-3 text-white/60" />
              <p className="text-2xs uppercase tracking-[0.2em] text-white/60">
                {t("cloud.containers.pricingBanner.idle", {
                  defaultValue: "Idle",
                })}
              </p>
            </div>
            <p className="text-base font-mono font-semibold text-white tabular-nums">
              {formatHourlyRate(AGENT_PRICING.IDLE_HOURLY_RATE)}
            </p>
            <p className="text-2xs text-white/30 font-mono">
              {formatMonthlyEstimate(AGENT_PRICING.IDLE_HOURLY_RATE)}
            </p>
          </div>

          {/* Current burn */}
          <div className="bg-black/60 p-3.5 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <DollarSign className="size-3 text-white/70" />
              <p className="text-2xs uppercase tracking-[0.2em] text-white/60">
                {t("cloud.containers.pricingBanner.yourCost", {
                  defaultValue: "Your Cost",
                })}
              </p>
            </div>
            <p className="text-base font-mono font-semibold text-white tabular-nums">
              {hasAgents ? `${formatUSD(totalMonthlyCost)}/mo` : "—"}
            </p>
            <p className="text-2xs text-white/30 font-mono">
              {hasBillableAgents
                ? t("cloud.containers.pricingBanner.runningIdleSummary", {
                    defaultValue: "{{run}} running · {{idle}} idle",
                    run: runningCount,
                    idle: idleCount,
                  })
                : sharedCount > 0
                  ? t("cloud.containers.pricingBanner.sharedFree", {
                      defaultValue: "Shared message ingress is free",
                    })
                  : t("cloud.containers.pricingBanner.noAgents", {
                      defaultValue: "No agents",
                    })}
            </p>
          </div>

          {/* Time remaining */}
          <div className="bg-black/60 p-3.5 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Clock className="size-3 text-white/50" />
              <p className="text-2xs uppercase tracking-[0.2em] text-white/60">
                {t("cloud.containers.pricingBanner.remaining", {
                  defaultValue: "Remaining",
                })}
              </p>
            </div>
            <p
              className={`text-base font-mono font-semibold tabular-nums ${
                isLowBalance && hasAgents ? "text-destructive" : "text-white"
              }`}
            >
              {hoursRemaining !== null ? formatDuration(hoursRemaining) : "—"}
            </p>
            <p className="text-2xs text-white/30 font-mono">
              {t("cloud.containers.pricingBanner.balance", {
                defaultValue: "Balance",
              })}
              : {creditBalance !== null ? formatUSD(creditBalance) : "—"}
            </p>
          </div>
        </div>
      </div>
    </Card>
  );
}
