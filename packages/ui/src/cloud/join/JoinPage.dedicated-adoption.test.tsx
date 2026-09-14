/** Verifies /join exposes the server-owned Dedicated adoption quote before any mutating confirmation. */
// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DedicatedAdoptionConfirmationQuote } from "../../api/client-cloud";
import type { DedicatedActivationConfirmationRequester } from "../../api/dedicated-activation-confirmation";

const runJoinFlowMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", () => ({
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate">{to}</div>,
}));
vi.mock("./lib/use-join-session", () => ({
  useJoinSessionAuth: () => ({ ready: true, authenticated: true }),
}));
vi.mock("./lib/run-join-flow", () => ({
  runJoinFlow: runJoinFlowMock,
}));
vi.mock("./lib/resolve-cloud-connection", () => ({
  resolveJoinAuthToken: () => "steward-token",
  resolveJoinCloudApiBase: () => "https://api.eliza.app",
}));
vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: Record<string, unknown>) => {
    let text = String(options?.defaultValue ?? _key);
    for (const [name, value] of Object.entries(options ?? {})) {
      text = text.replaceAll(`{{${name}}}`, String(value));
    }
    return text;
  },
}));
vi.mock("./lib/apex-app-handoff", () => ({
  resolveApexJoinHandoff: () => null,
}));

import JoinPage from "./JoinPage";

const QUOTE: DedicatedAdoptionConfirmationQuote = {
  quoteId: "a".repeat(64),
  dedicatedAgentId: "00000000-0000-4000-8000-000000000099",
  adoptionState: "available",
  status: "error",
  startsCompute: true,
  hourlyRateUsd: 0.01,
  dailyRateUsd: 0.24,
  minimumActivationChargeUsd: 0.3,
  minimumBalanceUsd: 0.72,
  minimumRunwayDays: 3,
  balanceUsd: 115.54059,
  deficitUsd: 0,
  stateDisposition: "verified_backup_present",
  canAdopt: true,
  requiresCatalogRestore: false,
  requiresConfirmation: true,
  action: "adopt_existing_dedicated",
};

const CONNECTED = {
  personalElizaId: "personal:00000000-0000-5000-8000-000000000001",
  agentId: "personal:00000000-0000-5000-8000-000000000001",
  activeAgentId: QUOTE.dedicatedAgentId,
  agentName: "Eliza",
  apiBase: `https://${QUOTE.dedicatedAgentId}.cloud.eliza.app`,
  runtime: "dedicated" as const,
};

describe("JoinPage Dedicated adoption consent", () => {
  beforeEach(() => {
    runJoinFlowMock.mockReset();
  });

  afterEach(cleanup);

  it.each(["Start Dedicated", "Not now"])(
    "reviews fresh hosting terms before %s",
    async (choice) => {
      let submitted:
        | Awaited<ReturnType<DedicatedActivationConfirmationRequester>>
        | undefined;
      runJoinFlowMock.mockImplementation(
        async ({ requestDedicatedActivationConfirmation, signal }) => {
          submitted = await requestDedicatedActivationConfirmation(
            {
              quoteId: "fresh-quote",
              sourceAgentId: "personal:account",
              hourlyRateUsd: 0.01,
              dailyRateUsd: 0.24,
              minimumActivationChargeUsd: 0.3,
              minimumBalanceUsd: 0.72,
              minimumRunwayDays: 3,
              balanceUsd: 10,
              deficitUsd: 0,
              canActivate: true,
              requiresConfirmation: true,
              action: "activate_dedicated",
            },
            { signal },
          );
          if (!submitted) throw new Error("Dedicated setup was not started.");
          return CONNECTED;
        },
      );
      render(<JoinPage />);
      expect(
        await screen.findByRole("heading", {
          name: "Start your Dedicated Eliza",
        }),
      ).toBeTruthy();
      expect(screen.getByText("$0.24/day ($0.01/hr)")).toBeTruthy();
      expect(
        screen.getByText("Balance: $10.00 · Minimum to start: $0.72"),
      ).toBeTruthy();
      expect(document.body.textContent).not.toContain("fresh-quote");
      expect(submitted).toBeUndefined();
      await userEvent.click(screen.getByRole("button", { name: choice }));
      if (choice === "Start Dedicated") {
        await waitFor(() =>
          expect(submitted).toEqual({
            action: "activate_dedicated",
            quoteId: "fresh-quote",
          }),
        );
        expect((await screen.findByTestId("navigate")).textContent).toBe("/");
      } else {
        expect(
          await screen.findByText("Dedicated setup was not started."),
        ).toBeTruthy();
        expect(submitted).toBeNull();
        expect(screen.queryByTestId("navigate")).toBeNull();
      }
    },
  );

  it("renders changed server terms without private ids and submits only the exact confirmed quote", async () => {
    let submitted:
      | { action: "adopt_existing_dedicated"; quoteId: string }
      | null
      | undefined;
    runJoinFlowMock.mockImplementation(
      async ({ requestDedicatedAdoptionConfirmation, signal }) => {
        submitted = await requestDedicatedAdoptionConfirmation(QUOTE, {
          reason: "quote_changed",
          signal,
        });
        if (!submitted)
          throw new Error("Dedicated adoption was not confirmed.");
        return CONNECTED;
      },
    );

    render(<JoinPage />);

    expect(
      await screen.findByRole("heading", {
        name: "Bring this Dedicated Eliza online?",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(
      "The Dedicated terms changed. Review the current quote before continuing.",
    );
    expect(
      screen.getByText(
        "This starts Dedicated hosting at $0.24/day ($0.01/hr).",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Balance: $115.54 · Required: $0.72 (3 days of runway)"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Cloud will restore its reviewed backup before switching.",
      ),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain(QUOTE.quoteId);
    expect(document.body.textContent).not.toContain(QUOTE.dedicatedAgentId);
    expect(submitted).toBeUndefined();

    await userEvent.click(
      screen.getByRole("button", { name: "Start Dedicated" }),
    );

    await waitFor(() =>
      expect(submitted).toEqual({
        action: "adopt_existing_dedicated",
        quoteId: QUOTE.quoteId,
      }),
    );
    expect((await screen.findByTestId("navigate")).textContent).toBe("/");
  });

  it("cancels fail closed and tells the user Shared remains unchanged", async () => {
    let submitted:
      | { action: "adopt_existing_dedicated"; quoteId: string }
      | null
      | undefined;
    runJoinFlowMock.mockImplementation(
      async ({ requestDedicatedAdoptionConfirmation, signal }) => {
        submitted = await requestDedicatedAdoptionConfirmation(QUOTE, {
          reason: "initial",
          signal,
        });
        if (!submitted)
          throw new Error("Dedicated adoption was not confirmed.");
        return CONNECTED;
      },
    );

    render(<JoinPage />);
    await screen.findByRole("button", { name: "Cancel setup" });

    await userEvent.click(screen.getByRole("button", { name: "Cancel setup" }));

    await waitFor(() => expect(submitted).toBeNull());
    expect(
      await screen.findByText(
        "Dedicated setup was not started. Your Shared Eliza is unchanged.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByTestId("navigate")).toBeNull();
  });
});
