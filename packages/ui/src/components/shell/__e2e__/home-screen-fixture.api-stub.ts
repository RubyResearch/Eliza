/**
 * Stubs `../../api` and `../../api/client` for the home-screen E2E while the
 * real WidgetHost and home widgets render. Widgets that fetch lifeops routes
 * use the fixture's raw `window.fetch`; typed client methods delegate to shared
 * home-widget mock data so the dashboard renders with injected data.
 */

import {
  homeWidgetNotificationsResponse,
  homeWidgetTodosResponse,
} from "../../../widgets/__fixtures__/home-widget-mock-data";

const walletBalancesResponse = () => ({ evm: null, solana: null });

const walletMarketOverviewResponse = () => ({
  prices: [
    { symbol: "BTC", priceUsd: 64000, change24hPct: 1.2 },
    { symbol: "SOL", priceUsd: 150, change24hPct: 2.1 },
    { symbol: "ETH", priceUsd: 3000, change24hPct: -0.5 },
  ],
  movers: [],
});

export const client = {
  // Empty base → widgets fetch `/api/lifeops/...` which the window.fetch mock
  // (installed in the fixture) intercepts.
  getBaseUrl: () => "",
  getRestAuthToken: () => null,
  // The LifeOps activity-signal capture (started by the shell's renderer
  // service after first paint) subscribes to base-URL authority changes and
  // compares revisions before re-probing. The fixture never rebinds its host,
  // so the revision is constant and the subscription is inert.
  getAuthorityRevision: () => 0,
  onAuthorityChange: (_listener: () => void) => () => {},
  // Typed widget requests still pass through the fixture's window.fetch mock;
  // mirror the production client's JSON boundary so constructor-based imports
  // and the shared singleton observe the same seeded responses.
  fetch: async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await window.fetch(path, init);
    if (!response.ok) {
      throw new Error(`Fixture request failed with status ${response.status}`);
    }
    return (await response.json()) as T;
  },
  // This fixture represents a local runtime whose text route is Cerebras. The
  // model-download widget must therefore skip the unrelated local text slot.
  getModelsConfig: async () => ({
    activeChat: {
      provider: "cerebras",
      family: "OPENAI",
      endpoint: "https://api.cerebras.ai/v1",
    },
  }),
  getRelationshipsPeople: async () => ({ data: [], stats: {} }),
  getRelationshipsCandidates: async () => [],
  getWalletBalances: async () => walletBalancesResponse(),
  getWalletMarketOverview: async () => walletMarketOverviewResponse(),
  // Today (todo) home card: attention mode seeds one open todo so the merged
  // card renders with a todo row alongside its flagged at-risk goal row
  // (spec §E item 5). Quiet mode returns zero work so the card self-hides.
  listWorkbenchTodos: async () => homeWidgetTodosResponse(),
  // Notification store hydrate + live subscription.
  listNotifications: async () => homeWidgetNotificationsResponse(),
  onWsEvent: () => {},
  markNotificationRead: async () => ({ ok: true }),
  markAllNotificationsRead: async () => ({ changed: 0 }),
  removeNotification: async () => ({ ok: true }),
  clearNotifications: async () => ({ ok: true }),
  // The inbox-chats client method the previous fixture exposed (unused by the
  // home widgets, kept harmless for any incidental caller).
  getInboxChats: async () => ({ chats: [], count: 0 }),
  // Agent-orchestrator home cards (Apps / Activity). No live runs/accounts in
  // the fixture → empty results so those cards self-hide cleanly rather than
  // surfacing a "not a function" error-boundary fallback.
  listAppRuns: async () => [],
  getOrchestratorAccounts: async () => ({ accounts: [] }),
  getOrchestratorRooms: async () => ({ rooms: [] }),
  listAccounts: async () => ({ accounts: [] }),
  // Unified-tasks home widget (useUnifiedTasks) - empty so it self-hides. These
  // prototype methods are bare side-effect patches in production, dropped from
  // this esbuild bundle, so stub them here explicitly.
  listAutomations: async () => ({ automations: [] }),
  listScheduledTasks: async () => ({ tasks: [] }),
  // CalendarUpcomingWidget probes Google connectivity through the typed client
  // before showing events; report a connected account so it renders the seeded
  // feed instead of the "Connect calendar" affordance.
  listConnectorAccounts: async () => ({
    accounts: [{ id: "google-owner", provider: "google", status: "connected" }],
  }),
  // Conversation stubs kept for any home surface that reads the conversation
  // list; the standalone Messages tile was removed (#10697), so nothing renders
  // a conversation list on the home grid now.
  listConversations: async () => ({ conversations: [] }),
  getConversationMessages: async () => ({ messages: [] }),
};

/** Supplies constructor imports while preserving the fixture's shared client. */
export function ElizaClient() {
  return client;
}
