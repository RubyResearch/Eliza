/** Verifies agent detail rendering rejects malformed API timestamps and avoids duplicate dates. */
// @vitest-environment jsdom

import type { NormalizedAgentDetailDto } from "@elizaos/cloud-sdk";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT:
    () => (_key: string, options?: { defaultValue?: string; n?: number }) =>
      (options?.defaultValue ?? _key).replace("{{n}}", String(options?.n)),
}));

vi.mock("../lib/use-session-auth", () => ({
  useSessionAuth: () => ({
    ready: true,
    authenticated: true,
    user: { id: "u1", email: "a@b.test" },
  }),
}));

vi.mock("../lib/use-document-title", () => ({
  useDocumentTitle: vi.fn(),
}));

const agentState: {
  data: NormalizedAgentDetailDto | undefined;
  isLoading: boolean;
  error: Error | null;
} = {
  data: {} as NormalizedAgentDetailDto,
  isLoading: false,
  error: null,
};

vi.mock("./lib/data/eliza-agents", () => ({
  useAgent: () => agentState,
}));

vi.mock("./components/agent-actions", () => ({
  ElizaAgentActions: () => <div>Lifecycle actions</div>,
}));
vi.mock("./components/eliza-connect-button", () => ({
  ElizaConnectButton: () => <button type="button">Open Web UI</button>,
}));

import { PageHeaderProvider } from "../../cloud-ui/components/layout";
import { ApiError } from "../lib/api-client";
import AgentDetailPage from "./AgentDetailPage";

const baseAgent: NormalizedAgentDetailDto = {
  id: "test-agent-1",
  agentName: "Timestamp Test Agent",
  status: "running",
  databaseStatus: "ready",
  lastBackupAt: null,
  lastHeartbeatAt: "2026-08-12T11:30:00.000Z",
  errorMessage: null,
  createdAt: "2026-08-11T09:15:00.000Z",
  updatedAt: "2026-08-12T11:30:00.000Z",
  token_address: null,
  token_chain: null,
  token_name: null,
  token_ticker: null,
  dockerImage: null,
  executionTier: "shared",
  webUiUrl: null,
  activeJob: null,
  errorCount: 0,
  meshAddressPresent: true,
  walletAddress: null,
  walletProvider: null,
  walletStatus: "none",
  adminDetails: null,
};

function renderPage(agent: NormalizedAgentDetailDto | undefined) {
  agentState.data = agent;
  return render(
    <MemoryRouter initialEntries={["/dashboard/agents/test-agent-1"]}>
      <PageHeaderProvider>
        <Routes>
          <Route path="/dashboard/agents/:id" element={<AgentDetailPage />} />
        </Routes>
      </PageHeaderProvider>
    </MemoryRouter>,
  );
}

describe("AgentDetailPage product detail", () => {
  afterEach(() => {
    cleanup();
    agentState.data = baseAgent;
    agentState.isLoading = false;
    agentState.error = null;
  });

  it("keeps a deleted agent visible as a distinct recoverable state", () => {
    agentState.error = new ApiError(404, "NOT_FOUND", "Agent not found");
    renderPage(undefined);

    expect(
      screen.getByRole("heading", { name: "Agent no longer available" }),
    ).toBeTruthy();
    expect(screen.getByText(/deleted or is no longer available/i)).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Return to Agents" })
        .getAttribute("href"),
    ).toBe("/cloud/agents");
  });

  it("does not disguise a successful response with missing data as deletion", () => {
    renderPage(undefined);

    expect(
      screen.getByText("The agent response did not include agent details."),
    ).toBeTruthy();
    expect(screen.queryByText("Agent no longer available")).toBeNull();
  });

  it("presents shared agents without infrastructure or admin panels", () => {
    const { container } = renderPage({
      ...baseAgent,
      adminDetails: {
        isDockerBacked: true,
        nodeId: "node-1",
        containerName: "container-1",
        internalBridgeUrl: "http://100.64.0.1:31337",
        dockerImage: "private-image",
        headscaleIp: "100.64.0.1",
        bridgePort: 31337,
        webUiPort: 5173,
        webUiUrl: "https://private-web-ui.example",
        sshCommand: "ssh private-host",
      },
    });

    expect(screen.getByRole("heading", { name: "Shared Agent" })).toBeTruthy();
    expect(screen.getAllByText("Shared Agent")).toHaveLength(1);
    expect(screen.getAllByText("running")).toHaveLength(1);
    expect(screen.getByText("Free")).toBeTruthy();
    expect(screen.getByText("Lifecycle actions")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Web UI" })).toBeNull();
    for (const rejected of [
      "Sandbox",
      "Managed runtime",
      "Infrastructure",
      "SSH Access",
      "Backups & History",
      "Agent Logs",
      "Docker Logs",
      "Save Snapshot",
      "$0.15/hr",
      "Wallet",
      "Transactions",
      "Policies",
      "Database",
      "Connected",
      "Created",
      "Last Heartbeat",
      "test-agent-1",
      "Timestamp Test Agent",
      "private-image",
      "private-host",
    ]) {
      expect(container.textContent).not.toContain(rejected);
    }
  });

  it("maps every non-shared hosted tier to Dedicated Agent", () => {
    renderPage({ ...baseAgent, executionTier: "dedicated-always" });

    expect(screen.getByText("Dedicated Agent")).toBeTruthy();
    expect(screen.getByText("$0.15/hr")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Web UI" })).toBeTruthy();
    expect(screen.queryByText("Shared Agent")).toBeNull();
    expect(screen.queryByText("Free")).toBeNull();
  });

  it("keeps backing-system failures out of the product error state", () => {
    renderPage({
      ...baseAgent,
      status: "error",
      errorCount: 2,
      errorMessage: "Container runtime image unavailable",
    });

    expect(screen.getByText("This agent needs attention")).toBeTruthy();
    expect(screen.getByText(/contact support/i)).toBeTruthy();
    expect(
      screen.queryByText("Container runtime image unavailable"),
    ).toBeNull();
    expect(document.body.textContent).not.toMatch(/container|runtime/i);
  });
});
