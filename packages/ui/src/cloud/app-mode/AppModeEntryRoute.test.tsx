/** Verifies the AppModeEntryRoute gate — auth gating, the chat-floor routing table (any agents → the same-origin chat app with ZERO pairing traffic), and the rowless personal-entry path (zero sandbox rows → the authenticated personal identity completes Dedicated activation or reconciliation before chat mounts; /join is the resolution-failure fallback) — through the package's configured test harness (jsdom, real render, real ElizaClient, hand-rolled Cloud transport; no Steward provider mounted, sessions come from the persisted localStorage JWT). */
// @vitest-environment jsdom

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client } from "../../api";
import {
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "../../state/persistence";
import { LocalStewardAuthContext } from "../shell/StewardProviderShared";
import { AppModeEntryRoute } from "./AppModeEntryRoute";
import { type AppModeAgent, appModeNavigation } from "./app-mode";
import { publishPersonalEntryHandoff } from "./use-personal-entry";

function base64url(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// A minimally-valid Steward JWT: readStewardSessionFromStorage only
// base64-decodes the payload (userId + a future exp); no signature check.
function stewardToken(): string {
  return [
    base64url({ alg: "none", typ: "JWT" }),
    base64url({
      userId: "u1",
      email: "a@b.test",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    "sig",
  ].join(".");
}

function signIn(): string {
  const token = stewardToken();
  localStorage.setItem(STEWARD_TOKEN_KEY, token);
  return token;
}

function bindCloudAgent(id = "agent-1"): void {
  savePersistedActiveServer({
    id: `cloud:${id}`,
    kind: "cloud",
    label: "Eliza Cloud",
    apiBase: `https://api.eliza.app/api/v1/eliza/agents/${id}`,
  });
}

function agent(
  overrides: Partial<AppModeAgent> & { id: string },
): AppModeAgent {
  return {
    agentName: overrides.id,
    status: "running",
    executionTier: "dedicated-always",
    lastHeartbeatAt: null,
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

interface StubRoutes {
  /** Response for GET /api/v1/eliza/agents. */
  agents: () => Response | Promise<Response>;
  /** Response for GET <cloud>/api/v1/eliza/personal (rowless personal entry). */
  personal?: () => Response;
  /** Responses after Shared identity resolution enters the Dedicated contract. */
  personalDedicated?: (url: string, init?: RequestInit) => Response | undefined;
}

const realFetch = globalThis.fetch;
const realAssign = appModeNavigation.assign;
const realReplace = appModeNavigation.replace;
let fetchLog: string[];
let assignedUrls: string[];

function stubNetwork(routes: StubRoutes): void {
  fetchLog = [];
  if (!routes.personalDedicated)
    vi.spyOn(client, "ensurePersonalDedicatedEliza").mockImplementation(
      async ({ cloudApiBase }) => {
        if (!routes.personal) {
          throw new Error("personal identity endpoint unavailable");
        }
        fetchLog.push(`GET ${cloudApiBase}/api/v1/eliza/personal`);
        const response = routes.personal();
        if (!response.ok) {
          throw new Error(
            `personal identity endpoint returned ${response.status}`,
          );
        }
        const body = (await response.json()) as {
          data?: { identity?: { id?: unknown; displayName?: unknown } };
        };
        const id = body.data?.identity?.id;
        if (typeof id !== "string" || !id.startsWith("personal:")) {
          throw new Error("invalid personal Eliza identity");
        }
        return {
          personalElizaId: id,
          agentId: id,
          activeAgentId: "00000000-0000-4000-8000-000000000002",
          agentName:
            typeof body.data?.identity?.displayName === "string"
              ? body.data.identity.displayName
              : "Eliza",
          apiBase: "https://dedicated.eliza.test",
          runtime: "dedicated" as const,
        };
      },
    );
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetchLog.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "/api/v1/eliza/agents") {
      return Promise.resolve(routes.agents());
    }
    if (routes.personal && url.endsWith("/api/v1/eliza/personal")) {
      return Promise.resolve(routes.personal());
    }
    const personalDedicatedResponse = routes.personalDedicated?.(url, init);
    if (personalDedicatedResponse) {
      return Promise.resolve(personalDedicatedResponse);
    }
    return Promise.resolve(
      new Response(JSON.stringify({ error: `unstubbed ${url}` }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  assignedUrls = [];
  // Any full-page navigation (the old pairing redirect used these seams) is a
  // chat-floor violation at entry; the suite pins that the log stays empty.
  appModeNavigation.assign = (url: string) => {
    assignedUrls.push(url);
  };
  appModeNavigation.replace = (url: string) => {
    assignedUrls.push(url);
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function agentsOk(list: AppModeAgent[]): () => Response {
  return () => jsonResponse(200, { success: true, data: list });
}

function LoginProbe(): React.JSX.Element {
  const location = useLocation();
  return <div data-testid="login-page">{location.search}</div>;
}

function renderEntry(
  initialPath = "/",
  options?: { sessionLoading?: boolean },
): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // The management destination lives INSIDE appElement's route registry (the
  // real shape: AppModeEntryRoute mounts appElement, whose internal router
  // serves /cloud/*). Registering it as an outer sibling would let React
  // Router bypass the component entirely — a false guard (#20652 review).
  const appElement = (
    <Routes>
      <Route
        path="/cloud/agents"
        element={<div data-testid="instances-page" />}
      />
      <Route path="*" element={<div data-testid="agent-app" />} />
    </Routes>
  );
  const entry = (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/login" element={<LoginProbe />} />
          <Route path="/join" element={<div data-testid="join-page" />} />
          <Route
            path="*"
            element={<AppModeEntryRoute appElement={appElement} />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  if (options?.sessionLoading) {
    render(
      <LocalStewardAuthContext.Provider
        value={{
          isAuthenticated: false,
          isLoading: true,
          user: null,
          session: null,
          signOut: () => undefined,
          getToken: () => null,
          verifyEmailCallback: () => Promise.reject(new Error("not stubbed")),
        }}
      >
        {entry}
      </LocalStewardAuthContext.Provider>,
    );
    return;
  }
  render(entry);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  globalThis.fetch = realFetch;
  appModeNavigation.assign = realAssign;
  appModeNavigation.replace = realReplace;
});

describe("AppModeEntryRoute — auth gating", () => {
  it("unauthenticated → the existing login flow, returnTo pointing back at the entry", () => {
    stubNetwork({ agents: agentsOk([]) });
    renderEntry("/");

    expect(screen.getByTestId("login-page").textContent).toBe("?returnTo=%2F");
    expect(screen.queryByTestId("agent-app")).toBeNull();
    // Signed out, nothing to decide: no app-mode network calls at all.
    expect(fetchLog).toEqual([]);
  });

  it("unauthenticated on a deep non-app path → login preserves that path for the post-login re-run", () => {
    stubNetwork({ agents: agentsOk([]) });
    renderEntry("/pricing");

    expect(screen.getByTestId("login-page").textContent).toBe(
      "?returnTo=%2Fpricing",
    );
    expect(screen.queryByTestId("agent-app")).toBeNull();
  });
});

describe("AppModeEntryRoute — chat-floor routing table", () => {
  it("one running dedicated agent → the same-origin chat app; NO pairing token is minted, NO redirect fires", async () => {
    // The cold-start dead-end pin. `status: "running"` in the control plane
    // does not mean the container is warm: the previous gate POSTed
    // /pairing-token here (one-time, 60s TTL) and full-page-redirected into
    // `<agentId>.…/pair?token=…`; a cold-starting agent cannot consume the
    // token inside the TTL, so every cold start dead-ended on the agent's
    // "Sign-in link expired" page. Entry must render the chat app instead and
    // issue zero pairing traffic.
    signIn();
    bindCloudAgent();
    stubNetwork({ agents: agentsOk([agent({ id: "agent-1" })]) });
    renderEntry();

    expect(await screen.findByTestId("agent-app")).toBeTruthy();
    expect(fetchLog.filter((line) => line.includes("pairing-token"))).toEqual(
      [],
    );
    expect(assignedUrls).toEqual([]);
  });

  it("several running dedicated agents → still the chat app (no chooser interstitial at entry)", async () => {
    signIn();
    bindCloudAgent("fresh");
    stubNetwork({
      agents: agentsOk([
        agent({ id: "stale", lastHeartbeatAt: "2026-08-01T00:00:00.000Z" }),
        agent({ id: "fresh", lastHeartbeatAt: "2026-08-05T00:00:00.000Z" }),
      ]),
    });
    renderEntry();

    expect(await screen.findByTestId("agent-app")).toBeTruthy();
    expect(assignedUrls).toEqual([]);
    expect(fetchLog.filter((line) => line.includes("pairing-token"))).toEqual(
      [],
    );
  });

  it("dedicated agents exist but none running → the same-origin chat app (never the console)", async () => {
    signIn();
    bindCloudAgent();
    stubNetwork({
      agents: agentsOk([agent({ id: "agent-1", status: "stopped" })]),
    });
    renderEntry();

    expect(await screen.findByTestId("agent-app")).toBeTruthy();
    expect(assignedUrls).toEqual([]);
  });

  it("an errored dedicated agent (failed provision) → the same-origin chat app, not a dashboard bounce", async () => {
    signIn();
    bindCloudAgent();
    stubNetwork({
      agents: agentsOk([agent({ id: "agent-1", status: "error" })]),
    });
    renderEntry();

    expect(await screen.findByTestId("agent-app")).toBeTruthy();
    expect(assignedUrls).toEqual([]);
  });

  it("a provisioning (cold-starting) dedicated agent → the chat app, no doomed pairing hop", async () => {
    signIn();
    bindCloudAgent();
    stubNetwork({
      agents: agentsOk([agent({ id: "agent-1", status: "provisioning" })]),
    });
    renderEntry();

    expect(await screen.findByTestId("agent-app")).toBeTruthy();
    expect(fetchLog.filter((line) => line.includes("pairing-token"))).toEqual(
      [],
    );
    expect(assignedUrls).toEqual([]);
  });

  it("no agents and no resolvable personal identity → the /join fallback flow", async () => {
    signIn();
    // No `personal` stub: the identity endpoint answers 500, so the rowless
    // resolver errors and entry falls back to /join, which owns retry UI.
    stubNetwork({ agents: agentsOk([]) });
    renderEntry();

    expect(await screen.findByTestId("join-page")).toBeTruthy();
  });

  it("shared-tier-only org → the same-origin chat app, unchanged", async () => {
    signIn();
    bindCloudAgent("s1");
    stubNetwork({
      agents: agentsOk([agent({ id: "s1", executionTier: "shared" })]),
    });
    renderEntry();

    expect(await screen.findByTestId("agent-app")).toBeTruthy();
    expect(assignedUrls).toEqual([]);
  });

  it("agents fetch failure → graceful fallback to the same-origin chat app", async () => {
    signIn();
    bindCloudAgent();
    stubNetwork({
      agents: () => jsonResponse(500, { error: "backend down" }),
    });
    renderEntry();

    expect(await screen.findByTestId("agent-app")).toBeTruthy();
  });

  it("never renders the instances console from entry, in any state", async () => {
    signIn();
    bindCloudAgent("r1");
    stubNetwork({
      agents: agentsOk([
        agent({ id: "e1", status: "error" }),
        agent({ id: "r1", status: "running" }),
        agent({ id: "s1", status: "stopped" }),
      ]),
    });
    renderEntry();

    expect(await screen.findByTestId("agent-app")).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByTestId("instances-page")).toBeNull(),
    );
  });

  it("existing agents in a fresh browser enter /join to persist an active Cloud binding", async () => {
    signIn();
    stubNetwork({ agents: agentsOk([agent({ id: "agent-1" })]) });
    renderEntry();

    expect(await screen.findByTestId("join-page")).toBeTruthy();
    expect(screen.queryByTestId("agent-app")).toBeNull();
  });

  it("keeps Cloud management reachable before an active-agent binding exists", async () => {
    signIn();
    stubNetwork({ agents: agentsOk([agent({ id: "agent-1" })]) });
    renderEntry("/cloud/billing");

    expect(await screen.findByTestId("agent-app")).toBeTruthy();
  });

  it("mounts Cloud management while the app-mode agents query is still pending", () => {
    signIn();
    stubNetwork({
      agents: () => new Promise<Response>(() => undefined),
    });
    renderEntry("/cloud/billing");

    expect(screen.getByTestId("agent-app")).toBeTruthy();
  });

  // --- #20652 acceptance completion ------------------------------------
  // The landed reorder (develop 110111a12e) bypasses the agents gate on
  // management paths, but the deadlock's exact live shape — a REJECTED
  // credential, not a slow one — and the negative controls below were
  // unguarded. These pin them.

  it("keeps /cloud management mounted when the agents query REJECTS with a stale credential (the #20652 deadlock shape)", async () => {
    // The live incident: a stale dedicated-agent credential made
    // GET /api/v1/eliza/agents return 401; the gate then waited forever on
    // "Loading your agent" with the Cloud registry unmounted, locking the
    // user out of the very page that mints a fresh pairing token.
    signIn();
    stubNetwork({
      agents: () =>
        jsonResponse(401, { error: "stale dedicated-agent credential" }),
    });
    renderEntry("/cloud/agents");

    // The component was exercised (the query ran), the management surface
    // mounted, and its internal router serves the /cloud/agents destination.
    // The deadlock shape — a persistent loading notice with nothing mounted —
    // must be absent.
    expect(await screen.findByTestId("instances-page")).toBeTruthy();
    await waitFor(() =>
      expect(
        fetchLog.some((line) => line.includes("/api/v1/eliza/agents")),
      ).toBe(true),
    );
    expect(screen.queryByText("Loading your agent")).toBeNull();
  });

  it("holds the session gate before the management bypass: auth still resolving mounts nothing (#20652)", async () => {
    // Negative control from the acceptance: the bypass fires only AFTER
    // session resolution. With the auth provider still loading, even a
    // management path holds the loading notice — the bypass cannot surface
    // an app before the session is known.
    signIn();
    stubNetwork({
      agents: () => new Promise<Response>(() => undefined),
    });
    renderEntry("/cloud/agents", { sessionLoading: true });

    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText("Loading")).toBeTruthy();
    expect(screen.queryByTestId("instances-page")).toBeNull();
    expect(screen.queryByTestId("agent-app")).toBeNull();
  });

  it("ordinary entry keeps the existing query-error policy when the agents query rejects with 401", async () => {
    // Negative control: the management bypass must not leak into the ordinary
    // path. A cloud-bound session renders the chat app (existing fallback);
    // an unbound one routes to /join — either way, NOT the management bypass.
    signIn();
    bindCloudAgent();
    stubNetwork({
      agents: () =>
        jsonResponse(401, { error: "stale dedicated-agent credential" }),
    });
    renderEntry("/");

    expect(await screen.findByTestId("agent-app")).toBeTruthy();
    expect(screen.queryByText("Loading your agent")).toBeNull();
  });

  it("ordinary entry with the agents query unresolved still holds the loading notice (the bypass is management-only)", async () => {
    signIn();
    stubNetwork({
      agents: () => new Promise<Response>(() => undefined),
    });
    renderEntry("/");

    // Give the query a beat to settle into pending; the notice must persist
    // and the app element must NOT mount.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText("Loading your agent")).toBeTruthy();
    expect(screen.queryByTestId("agent-app")).toBeNull();
  });
});

describe("AppModeEntryRoute — rowless personal entry", () => {
  const PERSONAL_ID = "personal:00000000-0000-5000-8000-000000000001";
  const DEDICATED_ID = "00000000-0000-4000-8000-000000000002";
  const DEDICATED_BASE = `https://${DEDICATED_ID}.cloud.eliza.app`;
  const ACTIVATION_QUOTE_ID = "a".repeat(64);

  function personalSharedOk(id = PERSONAL_ID): () => Response {
    return () =>
      jsonResponse(200, {
        success: true,
        data: { identity: { id, displayName: "Eliza", runtime: "shared" } },
      });
  }

  function personalDedicatedOk(
    activation: "fresh" | "running",
  ): Pick<StubRoutes, "personal" | "personalDedicated"> {
    return {
      personal: personalSharedOk(),
      personalDedicated: (url, init) => {
        const method = init?.method ?? "GET";
        if (url.endsWith("/upgrade-tier") && method === "GET") {
          return jsonResponse(200, {
            success: true,
            data: {
              quoteId: ACTIVATION_QUOTE_ID,
              sourceAgentId: PERSONAL_ID,
              hourlyRateUsd: 0.01,
              dailyRateUsd: 0.24,
              minimumActivationChargeUsd: 0.3,
              minimumBalanceUsd: 0.72,
              minimumRunwayDays: 3,
              balanceUsd: 10,
              deficitUsd: 0,
              requiresConfirmation: true,
              action: "activate_dedicated",
              canActivate: true,
              activation:
                activation === "fresh"
                  ? { state: "available" }
                  : {
                      state: "in_progress",
                      dedicatedAgentId: DEDICATED_ID,
                      status: "running",
                    },
            },
          });
        }
        if (
          activation === "fresh" &&
          url.endsWith("/upgrade-tier") &&
          method === "POST"
        ) {
          const body = JSON.parse(String(init?.body));
          if (
            body.action !== "activate_dedicated" ||
            body.quoteId !== ACTIVATION_QUOTE_ID
          ) {
            return jsonResponse(400, { error: "activation quote mismatch" });
          }
          return jsonResponse(202, {
            success: true,
            data: {
              dedicatedAgentId: DEDICATED_ID,
              jobId: "provisioning-fixture",
            },
          });
        }
        if (
          url.endsWith("/api/v1/jobs/provisioning-fixture") &&
          method === "GET"
        ) {
          return jsonResponse(200, {
            success: true,
            data: { id: "provisioning-fixture", status: "completed" },
          });
        }
        if (url.endsWith("/upgrade-tier/cutover") && method === "POST") {
          const body = JSON.parse(String(init?.body));
          if (body.dedicatedAgentId !== DEDICATED_ID) {
            return jsonResponse(400, { error: "cutover target mismatch" });
          }
          return jsonResponse(200, {
            success: true,
            data: {
              personalElizaId: PERSONAL_ID,
              activeAgentId: DEDICATED_ID,
              runtime: "dedicated",
              apiBase: DEDICATED_BASE,
              importedMessages: 0,
            },
          });
        }
        return undefined;
      },
    };
  }

  function personalDedicatedRequests(): string[] {
    return fetchLog.filter((line) => line.includes("/upgrade-tier"));
  }

  function bindPersonal(id = PERSONAL_ID): void {
    savePersistedActiveServer({
      id: `cloud:${id}`,
      kind: "cloud",
      label: "Eliza",
      apiBase: `https://api.eliza.app/api/v1/eliza/agents/${encodeURIComponent(id)}`,
    });
  }

  it("consumes the session-bound /join result without resolving the same personal identity twice", async () => {
    const authToken = signIn();
    bindPersonal();
    publishPersonalEntryHandoff(authToken, {
      personalElizaId: PERSONAL_ID,
      agentId: PERSONAL_ID,
      activeAgentId: DEDICATED_ID,
      agentName: "Eliza",
      apiBase: DEDICATED_BASE,
      runtime: "dedicated",
    });
    stubNetwork({ agents: agentsOk([]), personal: personalSharedOk() });
    renderEntry();

    expect(await screen.findByTestId("agent-app")).toBeTruthy();
    expect(
      fetchLog.filter((line) => line.includes("/api/v1/eliza/personal")),
    ).toEqual([]);
    expect(assignedUrls).toEqual([]);
  });

  it("discards a /join handoff from a different Steward session", async () => {
    signIn();
    bindPersonal();
    publishPersonalEntryHandoff("different-session-token", {
      personalElizaId: PERSONAL_ID,
      agentId: PERSONAL_ID,
      activeAgentId: DEDICATED_ID,
      agentName: "Eliza",
      apiBase: DEDICATED_BASE,
      runtime: "dedicated",
    });
    stubNetwork({ agents: agentsOk([]), ...personalDedicatedOk("running") });
    renderEntry();

    expect(await screen.findByTestId("agent-app")).toBeTruthy();
    expect(
      fetchLog.filter((line) => line.includes("/api/v1/eliza/personal")),
    ).toHaveLength(1);
    expect(personalDedicatedRequests()).toHaveLength(2);
    expect(assignedUrls).toEqual([]);
  });

  it("clean account with a matching personal binding → chat, no /join bounce, no reload (the #19360 loop)", async () => {
    signIn();
    bindPersonal();
    stubNetwork({ agents: agentsOk([]), ...personalDedicatedOk("running") });
    renderEntry();

    expect(await screen.findByTestId("agent-app")).toBeTruthy();
    expect(screen.queryByTestId("join-page")).toBeNull();
    expect(
      personalDedicatedRequests().map((line) => line.split(" ")[0]),
    ).toEqual(["GET", "POST"]);
    expect(assignedUrls).toEqual([]);
  });

  it("fresh browser, clean account → quote review in /join without starting compute or completing onboarding", async () => {
    signIn();
    stubNetwork({ agents: agentsOk([]), ...personalDedicatedOk("fresh") });
    renderEntry();

    expect(await screen.findByTestId("join-page")).toBeTruthy();
    expect(loadPersistedActiveServer()).toBeNull();
    expect(
      personalDedicatedRequests().map((line) => line.split(" ")[0]),
    ).toEqual(["GET"]);
    expect(screen.queryByTestId("agent-app")).toBeNull();
    expect(assignedUrls).toEqual([]);
  });

  it("stale cross-account binding is repaired to the authenticated identity before any boot", async () => {
    signIn();
    bindPersonal("personal:00000000-0000-5000-8000-0000000000ff");
    stubNetwork({ agents: agentsOk([]), ...personalDedicatedOk("running") });
    renderEntry();

    expect(await screen.findByTestId("agent-app")).toBeTruthy();
    expect(loadPersistedActiveServer()).toMatchObject({
      id: `cloud:${PERSONAL_ID}`,
      apiBase: DEDICATED_BASE,
      cloudRuntimeAgentId: DEDICATED_ID,
      cloudRuntime: "dedicated",
    });
    expect(
      personalDedicatedRequests().map((line) => line.split(" ")[0]),
    ).toEqual(["GET", "POST"]);
    expect(assignedUrls).toEqual([]);
  });

  it("an invalid identity response → /join, never a wrong-runtime chat boot", async () => {
    signIn();
    bindPersonal();
    stubNetwork({
      agents: agentsOk([]),
      personal: () =>
        jsonResponse(200, {
          success: true,
          data: {
            identity: {
              id: "not-a-personal-id",
              displayName: "Eliza",
              runtime: "shared",
            },
          },
        }),
    });
    renderEntry();

    expect(await screen.findByTestId("join-page")).toBeTruthy();
    expect(screen.queryByTestId("agent-app")).toBeNull();
  });

  it("identity endpoint unavailable → /join (retryable there), no infinite entry loop", async () => {
    signIn();
    bindPersonal();
    stubNetwork({
      agents: agentsOk([]),
      personal: () => jsonResponse(503, { error: "down" }),
    });
    renderEntry();

    expect(await screen.findByTestId("join-page")).toBeTruthy();
    expect(assignedUrls).toEqual([]);
  });

  it("rowless Cloud management stays reachable without touching the personal identity endpoint", async () => {
    signIn();
    stubNetwork({ agents: agentsOk([]), personal: personalSharedOk() });
    renderEntry("/cloud/billing");

    expect(await screen.findByTestId("agent-app")).toBeTruthy();
    expect(
      fetchLog.filter((line) => line.includes("/api/v1/eliza/personal")),
    ).toEqual([]);
  });
});
