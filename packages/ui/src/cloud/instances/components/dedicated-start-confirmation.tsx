/** Discloses the new paid session before an existing Dedicated agent starts. */
import {
  AGENT_PRICING,
  formatHourlyRate,
  formatUSD,
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
import { useT } from "../lib/i18n";

export function DedicatedStartConfirmation({
  open,
  disabled = false,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  disabled?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const t = useT();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("cloud.containers.agentActions.startPaidTitle", {
              defaultValue: "Start this Dedicated agent?",
            })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            <span className="block">
              {t("cloud.containers.agentActions.startPaidRate", {
                defaultValue:
                  "Running costs {{rate}}. Starting requires at least {{balance}} in available funds.",
                rate: formatHourlyRate(AGENT_PRICING.RUNNING_HOURLY_RATE),
                balance: formatUSD(AGENT_PRICING.MINIMUM_DEPOSIT),
              })}
            </span>
            <span className="block mt-2">
              {t("cloud.join.dedicatedActivationMinimum", {
                defaultValue:
                  "Minimum charge per successful start: {{minimum}}. Applies again after stopping and restarting.",
                minimum: formatUSD(AGENT_PRICING.MINIMUM_ACTIVATION_CHARGE),
              })}
            </span>
            <span className="block mt-2">
              {t("cloud.containers.agentActions.startPaidMinimumIncluded", {
                defaultValue:
                  "Running charges count toward this minimum. Restoring your agent can take a few minutes.",
              })}
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            {t("cloud.containers.agentActions.cancel", {
              defaultValue: "Cancel",
            })}
          </AlertDialogCancel>
          <AlertDialogAction disabled={disabled} onClick={onConfirm}>
            {t("cloud.join.dedicatedActivationConfirm", {
              defaultValue: "Start Dedicated",
            })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
