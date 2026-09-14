/** Verifies that Dedicated activation renders and confirms only the server quote. */
// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaAgentActions } from "./agent-actions";
import { ElizaConnectButton } from "./eliza-connect-button";

const apiWithStatus = vi.hoisted(() => vi.fn());
const runSharedToDedicatedUpgradeHandoff = vi.hoisted(() => vi.fn());
const client = vi.hoisted(() => ({
  getBaseUrl: vi.fn(),
}));
const silentlyRepointToDedicated = vi.hoisted(() => vi.fn());
const directCloudSharedAgentIdFromBase = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  apiWithStatus,
  readCloudBearerToken: () => "cloud-token",
}));

vi.mock("sonner", () => ({ toast }));

vi.mock("../lib/i18n", () => ({
  useT: () => (_key: string, options?: Record<string, unknown>) => {
    let text = String(options?.defaultValue ?? _key);
    for (const [name, value] of Object.entries(options ?? {})) {
      text = text.replaceAll(`{{${name}}}`, String(value));
    }
    return text;
  },
}));

vi.mock("../lib/use-job-poller", () => ({
  useJobPoller: () => ({
    getStatus: () => null,
    isActive: () => false,
    track: vi.fn(),
  }),
}));

vi.mock("../lib/open-web-ui", () => ({
  openWebUIWithPairing: vi.fn(),
}));

vi.mock("../../handoff/start-tier-upgrade", () => ({
  runSharedToDedicatedUpgradeHandoff,
}));

vi.mock("../../handoff/silent-repoint", () => ({
  silentlyRepointToDedicated,
}));

vi.mock("../../../utils/cloud-agent-base", () => ({
  directCloudSharedAgentIdFromBase,
}));

vi.mock("../../../api", () => ({
  client,
  ElizaClient: class {},
}));

const PERSONAL_ID = "personal:00000000-0000-5000-8000-000000000001";
const QUOTE = {
  quoteId: "a".repeat(64),
  sourceAgentId: PERSONAL_ID,
  hourlyRateUsd: 0.15,
  dailyRateUsd: 3.6,
  minimumActivationChargeUsd: 0.3,
  minimumBalanceUsd: 10.8,
  minimumRunwayDays: 3,
  balanceUsd: 12.5,
  deficitUsd: 0,
  canActivate: true,
  requiresConfirmation: true as const,
  action: "activate_dedicated" as const,
  activation: { state: "available" as const },
};

function renderWithQueryClient(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  );
}

function renderActions() {
  renderWithQueryClient(
    <MemoryRouter>
      <Routes>
        <Route
          path="/"
          element={
            <ElizaAgentActions
              agentId={PERSONAL_ID}
              executionTier="shared"
              status="running"
            />
          }
        />
        <Route
          path="/cloud/agents/:agentId"
          element={<p>Dedicated agent destination</p>}
        />
        <Route path="/cloud/billing" element={<p>Billing destination</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Dedicated activation quote", () => {
  beforeEach(() => {
    apiWithStatus.mockReset();
    runSharedToDedicatedUpgradeHandoff.mockReset();
    client.getBaseUrl.mockReset();
    silentlyRepointToDedicated.mockReset();
    directCloudSharedAgentIdFromBase.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it.each([
    ["stopped", "Resume Agent", "resume"],
    ["sleeping", "Reactivate Agent", "wake"],
  ] as const)(
    "requires paid-start confirmation for %s agents",
    async (status, label, action) => {
      apiWithStatus.mockResolvedValue({
        status: 202,
        data: { data: { jobId: "restart-job" } },
      });
      renderWithQueryClient(
        <MemoryRouter>
          <ElizaAgentActions
            agentId="existing-dedicated"
            executionTier="dedicated-always"
            status={status}
          />
        </MemoryRouter>,
      );
      await userEvent.click(screen.getByRole("button", { name: label }));
      expect(await screen.findByRole("alertdialog")).toBeTruthy();
      expect(
        screen.getByText(/Minimum charge per successful start: \$0.30/),
      ).toBeTruthy();
      expect(screen.getByText(/Running costs \$0.15/)).toBeTruthy();
      expect(apiWithStatus).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(apiWithStatus).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: label }));
      await userEvent.click(
        screen.getByRole("button", { name: "Start Dedicated" }),
      );
      await waitFor(() => expect(apiWithStatus).toHaveBeenCalledTimes(1));
      expect(apiWithStatus).toHaveBeenCalledWith(
        `/api/v1/eliza/agents/existing-dedicated/${action}`,
        {
          method: "POST",
          json: undefined,
          headers: {
            "X-Eliza-Dedicated-Price":
              "dedicated-compute-v1:USD:0.150000:0.300000",
          },
        },
      );
    },
  );

  it("shows a changed-price refusal without retrying or accepting new terms", async () => {
    const message =
      "Refresh the app and review the current Dedicated price before starting. No compute was started.";
    apiWithStatus.mockResolvedValue({ status: 428, data: { error: message } });
    renderWithQueryClient(
      <MemoryRouter>
        <ElizaAgentActions
          agentId="existing-dedicated"
          executionTier="dedicated-always"
          status="stopped"
        />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Resume Agent" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Start Dedicated" }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(`Action failed: ${message}`),
    );
    expect(apiWithStatus).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("loads and renders the server-owned quote before offering activation", async () => {
    apiWithStatus.mockResolvedValueOnce({
      status: 200,
      data: { success: true, data: QUOTE },
    });
    renderActions();

    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));

    expect(
      await screen.findByText(
        "Current balance: $12.50 · Required before activation: $10.80 (3 days)",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Your Shared Agent becomes a private, always-on Dedicated Agent. Dedicated hosting uses $3.60 per day ($0.15/hr) while running.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Activate Dedicated" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Minimum charge per successful start: $0.30. Applies again after stopping and restarting.",
      ),
    ).toBeTruthy();
    expect(apiWithStatus).toHaveBeenCalledWith(
      `/api/v1/eliza/agents/${encodeURIComponent(PERSONAL_ID)}/upgrade-tier`,
      { method: "GET" },
    );
  });

  it("names an existing migration target as recovery and promises reuse", async () => {
    apiWithStatus.mockResolvedValueOnce({
      status: 200,
      data: {
        success: true,
        data: {
          ...QUOTE,
          activation: {
            state: "in_progress" as const,
            dedicatedAgentId: "00000000-0000-4000-8000-000000000099",
            status: "error",
          },
        },
      },
    });
    renderActions();

    const resumeButton = await screen.findByRole("button", {
      name: "Resume Dedicated setup",
    });
    await userEvent.click(resumeButton);

    expect(
      await screen.findByRole("heading", { name: "Resume Dedicated setup?" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "A Dedicated Agent already exists for this upgrade, but setup did not finish. Resuming reuses that agent — it does not create another one. Hosting uses $3.60 per day ($0.15/hr) while running.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume setup" })).toBeTruthy();
  });

  it("keeps lifecycle controls while removing the manual snapshot action", () => {
    renderWithQueryClient(
      <MemoryRouter>
        <ElizaAgentActions
          agentId="dedicated-agent"
          executionTier="dedicated-always"
          status="running"
        />
      </MemoryRouter>,
    );

    for (const name of [
      "Open Web UI",
      "Suspend Agent",
      "Deactivate Agent",
      "Delete Agent",
    ]) {
      const control = screen.getByRole("button", { name });
      expect(control).toBeTruthy();
      expect(control.className).toContain("min-h-touch");
    }
    expect(screen.queryByText("Agent Actions")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save Snapshot" })).toBeNull();
    expect(document.body.textContent).not.toMatch(
      /backup|snapshot|container|runtime|compute/i,
    );
  });

  it("keeps the detail-header Web UI launch touch-sized", () => {
    render(<ElizaConnectButton agentId="dedicated-agent" />);

    expect(
      screen.getByRole("button", { name: "Open Web UI" }).className,
    ).toContain("min-h-touch");
  });

  it("keeps shared agents persistent while offering explicit Dedicated activation", () => {
    renderActions();

    expect(
      screen.getByRole("button", { name: "Upgrade to Dedicated" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Suspend Agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete Agent" })).toBeNull();
    expect(screen.queryByText("Agent Actions")).toBeNull();
  });

  it("posts the exact quote and explicit action instead of client-computed terms", async () => {
    apiWithStatus
      .mockResolvedValueOnce({
        status: 200,
        data: { success: true, data: QUOTE },
      })
      .mockResolvedValueOnce({
        status: 402,
        data: { error: "Add credits before activating Dedicated." },
      });
    renderActions();

    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    await userEvent.click(
      await screen.findByRole("button", { name: "Activate Dedicated" }),
    );

    await waitFor(() => expect(apiWithStatus).toHaveBeenCalledTimes(2));
    expect(apiWithStatus).toHaveBeenLastCalledWith(
      `/api/v1/eliza/agents/${encodeURIComponent(PERSONAL_ID)}/upgrade-tier`,
      {
        method: "POST",
        json: {
          minimumActivationChargeUsd: 0.3,
          action: "activate_dedicated",
          quoteId: QUOTE.quoteId,
        },
      },
    );
    expect(toast.error).toHaveBeenCalledWith(
      "Add credits before activating Dedicated.",
    );
  });

  it("repoints the active live chat and announces the switch before navigating", async () => {
    const dedicatedAgentId = "00000000-0000-4000-8000-000000000099";
    const dedicatedApiBase = `http://127.0.0.1:18787/api/v1/eliza/agents/${dedicatedAgentId}/api`;
    apiWithStatus
      .mockResolvedValueOnce({
        status: 200,
        data: { success: true, data: QUOTE },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { success: true, data: { dedicatedAgentId } },
      });
    client.getBaseUrl.mockReturnValue(
      `https://api.eliza.app/api/v1/eliza/agents/${encodeURIComponent(PERSONAL_ID)}`,
    );
    directCloudSharedAgentIdFromBase.mockReturnValue(PERSONAL_ID);
    runSharedToDedicatedUpgradeHandoff.mockImplementationOnce(
      async (params) => {
        await params.onSwitch(dedicatedApiBase);
        return {
          status: "switched-empty",
          imported: 0,
          sourceCleanup: "preserved-rowless",
        };
      },
    );
    const phases: Array<Record<string, unknown>> = [];
    const onPhase = (event: Event) =>
      phases.push((event as CustomEvent).detail as Record<string, unknown>);
    window.addEventListener("eliza:cloud-handoff-phase", onPhase);
    renderActions();

    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    await userEvent.click(
      await screen.findByRole("button", { name: "Activate Dedicated" }),
    );

    await waitFor(() =>
      expect(silentlyRepointToDedicated).toHaveBeenCalledWith({
        containerBase: dedicatedApiBase,
        authToken: "cloud-token",
        dedicatedAgentId,
        personalElizaId: PERSONAL_ID,
      }),
    );
    expect(phases).toContainEqual({
      agentId: PERSONAL_ID,
      phase: "switched-empty",
      imported: 0,
    });
    expect(toast.success).toHaveBeenCalledWith(
      "Upgrade complete — your conversation moved to the dedicated agent.",
    );
    window.removeEventListener("eliza:cloud-handoff-phase", onPhase);
  });

  it("does not hijack an unrelated active chat after a management upgrade", async () => {
    const dedicatedAgentId = "00000000-0000-4000-8000-000000000099";
    apiWithStatus
      .mockResolvedValueOnce({
        status: 200,
        data: { success: true, data: QUOTE },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { success: true, data: { dedicatedAgentId } },
      });
    client.getBaseUrl.mockReturnValue("https://another-agent.example.test");
    directCloudSharedAgentIdFromBase.mockReturnValue("another-agent");
    runSharedToDedicatedUpgradeHandoff.mockImplementationOnce(
      async (params) => {
        await params.onSwitch("https://dedicated-agent.example.test");
        return {
          status: "switched-empty",
          imported: 0,
          sourceCleanup: "preserved-rowless",
        };
      },
    );
    renderActions();

    await userEvent.click(screen.getByTestId("agent-upgrade-tier-button"));
    await userEvent.click(
      await screen.findByRole("button", { name: "Activate Dedicated" }),
    );

    await waitFor(() =>
      expect(runSharedToDedicatedUpgradeHandoff).toHaveBeenCalledTimes(1),
    );
    expect(silentlyRepointToDedicated).not.toHaveBeenCalled();
  });

  it("shows a credit action instead of an activation button when the server denies the quote", async () => {
    apiWithStatus.mockResolvedValueOnce({
      status: 200,
      data: {
        success: true,
        data: {
          ...QUOTE,
          balanceUsd: 0,
          deficitUsd: 10.8,
          canActivate: false,
          unavailableReason: "Add credits to activate Dedicated.",
        },
      },
    });
    renderActions();

    await userEvent.click(
      await screen.findByRole("button", { name: "Add funds to upgrade" }),
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Add credits to activate Dedicated.",
    );
    expect(
      screen.getByRole("button", { name: "Add funds to upgrade" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Activate Dedicated" }),
    ).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Add funds to upgrade" }),
    );
    expect(screen.getByText("Billing destination")).toBeTruthy();
  });
});
