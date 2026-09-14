/**
 * Deployment-polling resilience for CloudContainerService. A transient cloud
 * API failure inside one poll must count as an attempt and re-arm the chain
 * with backoff, not kill it and escape as an unhandled rejection that freezes
 * the tracked container at its last observed status. Deterministic harness —
 * real service, fake timers, a stub auth client, core and shared mocked out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
  Service: class {
    protected runtime: unknown;
    constructor(runtime?: unknown) {
      this.runtime = runtime;
    }
  },
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@elizaos/shared", () => ({ CLOUD_CONTAINER_SERVICE_TYPE: "CLOUD_CONTAINER" }));

import { CloudContainerService } from "./cloud-container.ts";

type Tracked = {
  container: { id: string; status: string };
  pollingTimer: ReturnType<typeof setTimeout> | null;
  healthTimer: ReturnType<typeof setInterval> | null;
};
type Harness = {
  authService: unknown;
  tracked: Map<string, Tracked>;
  startPolling(id: string): void;
};

const ID = "container-1";
const BASE_INTERVAL_MS = 5_000;

function makeService(get: (path: string) => Promise<unknown>) {
  const service = new CloudContainerService({} as never) as unknown as Harness;
  service.authService = {
    isAuthenticated: () => true,
    getClient: () => ({ get }),
  };
  service.tracked.set(ID, {
    container: { id: ID, status: "deploying" },
    pollingTimer: null,
    healthTimer: null,
  });
  return service;
}

function sequence(outcomes: Array<"reject" | string>) {
  let calls = 0;
  const get = vi.fn(async () => {
    const outcome = outcomes[Math.min(calls, outcomes.length - 1)];
    calls += 1;
    if (outcome === "reject") throw new Error("transient 503 from cloud API");
    return { data: { id: ID, status: outcome } };
  });
  return get;
}

describe("CloudContainerService deployment polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps polling while the container is deploying (harness control)", async () => {
    const get = sequence(["deploying"]);
    const service = makeService(get);
    service.startPolling(ID);

    await vi.advanceTimersByTimeAsync(BASE_INTERVAL_MS); // poll #1
    await vi.advanceTimersByTimeAsync(BASE_INTERVAL_MS * 2); // poll #2 after 10s backoff

    expect(get).toHaveBeenCalledTimes(2);
  });

  it("re-arms the chain after a transient failure and still reaches running", async () => {
    const get = sequence(["reject", "running"]);
    const service = makeService(get);
    service.startPolling(ID);

    await vi.advanceTimersByTimeAsync(BASE_INTERVAL_MS); // poll #1 rejects
    await vi.advanceTimersByTimeAsync(BASE_INTERVAL_MS * 2); // poll #2 must still happen

    expect(get).toHaveBeenCalledTimes(2);
    expect(service.tracked.get(ID)?.container.status).toBe("running");
    expect(service.tracked.get(ID)?.healthTimer).not.toBeNull();
  });

  it("counts failed polls against the attempt budget and stops at the limit", async () => {
    const get = sequence(["reject"]);
    const service = makeService(get);
    service.startPolling(ID);

    // 120 attempts at ≤30s each is well under two fake hours.
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);

    expect(get).toHaveBeenCalledTimes(120);
    expect(vi.getTimerCount()).toBe(0);
  });
});
