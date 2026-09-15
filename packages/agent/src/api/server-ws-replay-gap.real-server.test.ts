/**
 * Real HTTP/WebSocket coverage for reconnect replay-gap signaling. The harness
 * publishes events through the authenticated agent route, then reconnects a
 * real socket with a stale cursor and inspects the ordered wire frames.
 */

import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { startApiServer } from "./server.ts";
import { DEFAULT_REPLAY_LIMIT } from "./ws-event-replay.ts";

const API_TOKEN = "ws-replay-gap-test-token";
const touchedEnv = [
  "ELIZA_API_AUTH_TOKEN",
  "ELIZA_API_BIND_HOST",
  "ELIZA_API_PORT",
  "ELIZA_API_TOKEN",
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZA_PORT",
  "ELIZA_REQUIRE_LOCAL_AUTH",
  "ELIZA_STATE_DIR",
] as const;

type ApiServer = Awaited<ReturnType<typeof startApiServer>>;
type WireFrame = Record<string, unknown>;

const originalEnv = new Map<string, string | undefined>();
let stateDir: string | null = null;
let api: ApiServer | null = null;
let socket: WebSocket | null = null;

beforeEach(async () => {
  for (const key of touchedEnv) originalEnv.set(key, process.env[key]);
  stateDir = await mkdtemp(path.join(tmpdir(), "eliza-ws-replay-gap-"));
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_CONFIG_PATH = path.join(stateDir, "eliza.json");
  process.env.ELIZA_PERSIST_CONFIG_PATH = process.env.ELIZA_CONFIG_PATH;
  process.env.ELIZA_API_BIND_HOST = "127.0.0.1";
  process.env.ELIZA_API_TOKEN = API_TOKEN;
  delete process.env.ELIZA_API_AUTH_TOKEN;
  delete process.env.ELIZA_CLOUD_PROVISIONED;
  delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
});

afterEach(async () => {
  socket?.terminate();
  socket = null;
  await api?.close();
  api = null;
  if (stateDir) {
    await rm(stateDir, { recursive: true, force: true });
    stateDir = null;
  }
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
});

async function publishEvents(baseUrl: string, count: number): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    const response = await fetch(`${baseUrl}/api/agent/event`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        stream: "system",
        data: { index },
      }),
    });
    expect(response.status).toBe(200);
  }
}

it("signals a capped stale-cursor replay before sending its retained tail", async () => {
  api = await startApiServer({ port: 0, skipDeferredStartupWork: true });
  const baseUrl = `http://127.0.0.1:${api.port}`;
  await publishEvents(baseUrl, DEFAULT_REPLAY_LIMIT + 5);

  const frames: WireFrame[] = [];
  socket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws?lastEventId=0`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  socket.on("message", (data) => {
    frames.push(JSON.parse(String(data)) as WireFrame);
  });
  await once(socket, "open", { signal: AbortSignal.timeout(5_000) });
  await vi.waitFor(
    () => {
      expect(
        frames.filter((frame) => frame.type === "agent_event"),
      ).toHaveLength(DEFAULT_REPLAY_LIMIT);
    },
    { timeout: 10_000 },
  );

  const gapIndex = frames.findIndex((frame) => frame.type === "replay-gap");
  const firstEventIndex = frames.findIndex(
    (frame) => frame.type === "agent_event",
  );
  expect(gapIndex).toBeGreaterThanOrEqual(0);
  expect(gapIndex).toBeLessThan(firstEventIndex);
  expect(frames[gapIndex]).toEqual({
    type: "replay-gap",
    version: 1,
    requestedAfter: 0,
    availableFrom: 1,
    availableThrough: DEFAULT_REPLAY_LIMIT + 5,
    replayedFrom: 6,
    replayedThrough: DEFAULT_REPLAY_LIMIT + 5,
    reasons: ["replay-limit"],
  });

  const replayed = frames.filter((frame) => frame.type === "agent_event");
  expect(replayed[0]?.eventId).toBe("evt-6");
  expect(replayed.at(-1)?.eventId).toBe(`evt-${DEFAULT_REPLAY_LIMIT + 5}`);
}, 60_000);
