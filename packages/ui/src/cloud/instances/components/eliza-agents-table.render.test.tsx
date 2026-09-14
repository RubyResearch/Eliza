/** Verifies ElizaAgentsTable per-row view model through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * ElizaAgentsTable per-row view model (#13916): the desktop table and mobile
 * card render one derived row, so the shared derivation owns runtime labels,
 * action availability, and Web UI reachability. Also covers the deactivate
 * (sleep) / reactivate (wake) affordances (#15603): availability derivation,
 * the sleeping row rendering as a designed non-error state with a Reactivate
 * action, and the deactivate confirm dialog's billing-transparency copy.
 */

import type { NormalizedAgentListItemDto } from "@elizaos/cloud-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentElizaAppOrigin } from "../../../utils/cloud-agent-base";
import { deriveAgentRow, ElizaAgentsTable } from "./eliza-agents-table";

vi.mock("../lib/i18n", () => ({
  useT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

function row(
  overrides: Partial<NormalizedAgentListItemDto>,
): NormalizedAgentListItemDto {
  return {
    activeJob: null,
    id: "00000000-1111-2222-3333-444444444444",
    agentName: "Ada",
    status: "running",
    databaseStatus: "ready",
    lastBackupAt: null,
    lastHeartbeatAt: null,
    errorMessage: null,
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
    token_address: null,
    token_chain: null,
    token_name: null,
    token_ticker: null,
    dockerImage: null,
    executionTier: "dedicated-lazy",
    webUiUrl: "https://agent.example",
    ...overrides,
  };
}

function derive(
  overrides: Partial<NormalizedAgentListItemDto>,
  {
    active = false,
    actionInProgress = null,
  }: { active?: boolean; actionInProgress?: string | null } = {},
) {
  const sb = row(overrides);
  return deriveAgentRow(
    sb,
    {
      getStatus: () =>
        active
          ? {
              jobId: "job-12345678",
              key: sb.id,
              status: "pending" as const,
              error: null,
              startedAt: 0,
            }
          : undefined,
      isActive: vi.fn(() => active),
    },
    actionInProgress,
  );
}

describe("ElizaAgentsTable per-row view model", () => {
  afterEach(() => {
    cleanup();
  });

  it("offers authenticated Web UI pairing for a running dedicated agent without a published URL", () => {
    const vm = derive({ status: "running", webUiUrl: null });

    expect(vm.displayStatus).toBe("running");
    expect(vm.runtimeKind).toBe("sandbox");
    expect(vm.isDocker).toBe(false);
    expect(vm.hasStandaloneWebUi).toBe(true);
    expect(vm.canStart).toBe(false);
    expect(vm.canStop).toBe(true);
  });

  it("resolves docker-backed, shared, sandbox, and unprovisioned runtime kinds", () => {
    expect(
      derive({ executionTier: "custom", dockerImage: "eliza:1" }).runtimeKind,
    ).toBe("managed");
    expect(derive({ executionTier: "shared" }).runtimeKind).toBe("shared");
    expect(derive({ status: "provisioning" }).runtimeKind).toBe("sandbox");
    // Stopped and disconnected are post-provision lifecycle states, not
    // evidence that a dedicated sandbox was never set up.
    expect(derive({ status: "stopped" }).runtimeKind).toBe("sandbox");
    expect(derive({ status: "disconnected" }).runtimeKind).toBe("sandbox");
    expect(
      derive({
        status: "pending",
        webUiUrl: null,
      }).runtimeKind,
    ).toBe("notProvisioned");
    // The backend status remains the authority after deactivation; the list
    // endpoint does not publish a sandbox id.
    expect(derive({ status: "sleeping" }).runtimeKind).toBe("sandbox");
  });

  it("hides standalone Web UI for shared rows even when the API returns a URL", () => {
    const vm = derive({
      status: "running",
      executionTier: "shared",
      webUiUrl: "https://agent.example",
    });

    expect(vm.hasStandaloneWebUi).toBe(false);
  });

  it("renders concise product cards without infrastructure metadata", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <ElizaAgentsTable
          agents={[
            row({
              executionTier: "shared",
              agentName: "Shared Eliza",
              lastHeartbeatAt: "2026-08-18T10:00:00.000Z",
            }),
            row({
              id: "00000000-1111-2222-3333-555555555555",
              executionTier: "custom",
              dockerImage: "private-image",
              agentName: "Dedicated Eliza",
              webUiUrl: null,
            }),
          ]}
        />
      </QueryClientProvider>,
    );

    expect(screen.getAllByText("Shared Agent").length).toBeGreaterThanOrEqual(
      2,
    );
    expect(screen.queryByText("Shared Eliza")).toBeNull();
    expect(screen.queryByText("Dedicated Agent")).toBeNull();
    expect(screen.queryByText("All statuses")).toBeNull();
    expect(screen.queryByText("Details")).toBeNull();
    expect(container.textContent).not.toContain("00000000");
    expect(container.textContent).not.toContain("Heartbeat");
    expect(screen.getAllByText("Free").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("$0.15/hr").length).toBeGreaterThanOrEqual(2);
    const sharedRow = screen.getAllByText("Shared Agent")[0]?.closest("tr");
    const dedicatedRow = screen
      .getAllByText("Dedicated Eliza")[0]
      ?.closest("tr");
    expect(sharedRow).toBeTruthy();
    expect(dedicatedRow).toBeTruthy();
    expect(
      (
        within(sharedRow as HTMLElement).getByRole(
          "checkbox",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      within(sharedRow as HTMLElement).queryByRole("button", {
        name: "Suspend agent",
      }),
    ).toBeNull();
    expect(
      within(sharedRow as HTMLElement).queryByRole("button", {
        name: "Delete agent",
      }),
    ).toBeNull();
    expect(
      within(dedicatedRow as HTMLElement).getByRole("button", {
        name: "Suspend agent",
      }),
    ).toBeTruthy();
    expect(
      within(dedicatedRow as HTMLElement).getAllByRole("button", {
        name: "Open Web UI",
      }),
    ).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "Dedicated Eliza" })).toBeNull();
    expect(screen.getAllByText("Dedicated Eliza")).toHaveLength(2);
    expect(screen.queryByRole("link", { name: "Open Eliza app" })).toBeNull();
    expect(
      within(dedicatedRow as HTMLElement).getByRole("button", {
        name: "Delete agent",
      }),
    ).toBeTruthy();
    for (const rejected of [
      "Sandbox",
      "Cloud sandbox",
      "Managed runtime",
      "Shared runtime",
      "Docker",
    ]) {
      expect(container.textContent).not.toContain(rejected);
    }
  });

  it("uses product copy instead of a deploy instruction when no rows exist", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <ElizaAgentsTable agents={[]} />
      </QueryClientProvider>,
    );

    expect(screen.getByText("No agents yet")).toBeTruthy();
    expect(
      screen.getByText(
        "Your Shared or Dedicated Agent will appear here when available.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/deploy your first agent/i)).toBeNull();
  });

  it("uses active poll jobs as the displayed status and busy state", () => {
    const vm = derive({ status: "pending" }, { active: true });

    expect(vm.displayStatus).toBe("provisioning");
    expect(vm.isProvisioningActive).toBe(true);
    expect(vm.busy).toBe(true);
    expect(vm.trackedJob?.jobId).toBe("job-12345678");
    expect(vm.canStart).toBe(false);
    expect(vm.canStop).toBe(false);
  });

  it("blocks row actions while a row-level action is in progress", () => {
    const vm = derive(
      { status: "stopped" },
      { actionInProgress: "00000000-1111-2222-3333-444444444444" },
    );

    expect(vm.busy).toBe(true);
    expect(vm.canStart).toBe(false);
    expect(vm.canStop).toBe(false);
  });

  it("offers Deactivate only for running dedicated rows and Reactivate only for sleeping rows", () => {
    const runningDedicated = derive({ status: "running" });
    expect(runningDedicated.canSleep).toBe(true);
    expect(runningDedicated.canWake).toBe(false);

    // Shared-runtime agents have no dedicated compute to free.
    const runningShared = derive({
      status: "running",
      executionTier: "shared",
    });
    expect(runningShared.canStop).toBe(false);
    expect(runningShared.canSleep).toBe(false);

    const sleeping = derive({ status: "sleeping" });
    expect(sleeping.canWake).toBe(true);
    expect(sleeping.canSleep).toBe(false);
    // A deactivated agent is a settled, designed state — not a resumable
    // stop and not startable through the provision path.
    expect(sleeping.canStart).toBe(false);
    expect(sleeping.canStop).toBe(false);

    // Both affordances yield to in-flight work.
    const busySleeping = derive({ status: "sleeping" }, { active: true });
    expect(busySleeping.canWake).toBe(false);
    const busyRunning = derive(
      { status: "running" },
      { actionInProgress: "00000000-1111-2222-3333-444444444444" },
    );
    expect(busyRunning.canSleep).toBe(false);
  });

  it("renders sleeping and idle rates without conflating deactivated and idle billing", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <ElizaAgentsTable
          agents={[
            row({ status: "sleeping", webUiUrl: null }),
            row({
              id: "00000000-1111-2222-3333-555555555555",
              status: "stopped",
            }),
          ]}
        />
      </QueryClientProvider>,
    );

    // The raw lifecycle state is shown (muted styling), never an error render.
    expect(screen.getAllByText("sleeping").length).toBeGreaterThanOrEqual(1);
    // Reactivate replaces the resume/suspend affordances for this state.
    expect(
      screen.getAllByRole("button", { name: "Reactivate agent" }).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByRole("button", { name: "Resume agent" }).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.queryByRole("button", { name: "Deactivate agent" }),
    ).toBeNull();
    // Billing transparency on the card itself: an explicit $0.00/hr.
    expect(screen.getAllByText("$0.00/hr").length).toBeGreaterThanOrEqual(1);
    // Idle agents still bill at a low hourly rate, so they must not visually
    // collapse to the deactivated zero-cost badge.
    expect(screen.getAllByText("<$0.01/hr").length).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ["stopped", "Resume agent"],
    ["sleeping", "Reactivate agent"],
  ] as const)(
    "discloses a paid start from both %s row layouts",
    async (status, label) => {
      const user = userEvent.setup();
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      render(
        <QueryClientProvider client={queryClient}>
          <ElizaAgentsTable agents={[row({ status })]} />
        </QueryClientProvider>,
      );
      const buttons = screen.getAllByRole("button", {
        name: label,
      });
      expect(buttons).toHaveLength(2);
      for (const button of buttons) {
        await user.click(button);
        const dialog = await screen.findByRole("alertdialog");
        expect(
          within(dialog).getByText(/Minimum charge per successful start/),
        ).toBeTruthy();
        expect(
          within(dialog).getByText(/Running charges count toward this minimum/),
        ).toBeTruthy();
        await user.click(
          within(dialog).getByRole("button", { name: "Cancel" }),
        );
        expect(screen.queryByRole("alertdialog")).toBeNull();
      }
    },
  );

  it("requires a billing-transparency confirm before deactivating", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <ElizaAgentsTable agents={[row({ status: "running" })]} />
      </QueryClientProvider>,
    );

    const [deactivate] = screen.getAllByRole("button", {
      name: "Deactivate agent",
    });
    await user.click(deactivate);

    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/stops consuming hourly credits/),
    ).toBeTruthy();
    expect(within(dialog).getByText(/retains your agent data/i)).toBeTruthy();
    expect(
      within(dialog).getByText(/if deactivation cannot complete/i),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(/requires available credits/i),
    ).toBeTruthy();
    expect(dialog.textContent).not.toMatch(
      /backup|snapshot|container|runtime|compute/i,
    );

    // Cancel is a real exit: no job fired, dialog gone.
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("reconciles same-id authoritative field updates for an inactive row", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const initial = row({ status: "stopped", agentName: "Ada" });
    const updated = row({
      status: "error",
      agentName: "Grace",
      errorMessage: "Runtime image unavailable",
      updatedAt: "2026-07-04T00:01:00.000Z",
    });

    const view = render(
      <QueryClientProvider client={queryClient}>
        <ElizaAgentsTable agents={[initial]} />
      </QueryClientProvider>,
    );
    expect(screen.getAllByText("Ada").length).toBeGreaterThanOrEqual(1);

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <ElizaAgentsTable agents={[updated]} />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.queryByText("Ada")).toBeNull();
      expect(screen.getAllByText("Grace").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("error").length).toBeGreaterThanOrEqual(1);
      expect(
        screen.getAllByText("Agent needs attention").length,
      ).toBeGreaterThanOrEqual(1);
      expect(screen.queryByText("Runtime image unavailable")).toBeNull();
    });
  });

  it("does not carry a previous failure message into provisioning", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <ElizaAgentsTable
          agents={[
            row({
              status: "provisioning",
              errorMessage: "A previous provisioning attempt failed",
            }),
          ]}
        />
      </QueryClientProvider>,
    );

    expect(screen.getAllByText("provisioning").length).toBeGreaterThanOrEqual(
      1,
    );
    expect(screen.queryByText("Agent needs attention")).toBeNull();
  });

  it("keeps the empty Agents page connected to the Eliza app create flow", () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <ElizaAgentsTable agents={[]} />
      </QueryClientProvider>,
    );

    const links = screen.getAllByRole("link", { name: "Open Eliza app" });
    expect(links.length).toBeGreaterThanOrEqual(1);
    for (const link of links) {
      expect(link.getAttribute("href")).toBe(currentElizaAppOrigin());
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noreferrer");
    }
  });
});
