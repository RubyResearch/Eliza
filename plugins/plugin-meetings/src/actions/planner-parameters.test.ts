/**
 * Planner-path coverage for the three meeting actions: runs the real core
 * `normalizeParamAliases` + `validateToolArgs` over each action's declared
 * parameters with the arguments its handler reads, then delivers the validated
 * bag through `options.parameters` exactly as the runtime does and asserts the
 * value reaches the handler. Scripted MeetingService stub; no browser.
 */

import type {
  Action,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
  UUID,
} from "@elizaos/core";
import { type MeetingSession, parseMeetingUrl } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { validateToolArgs } from "../../../../packages/core/src/actions/validate-tool-args.js";
import { normalizeParamAliases } from "../../../../packages/core/src/runtime/execute-planned-tool-call.js";
import type { MeetingService } from "../service.js";
import { getMeetingTranscriptAction } from "./get-meeting-transcript.js";
import { joinMeetingAction } from "./join-meeting.js";
import { leaveMeetingAction } from "./leave-meeting.js";

const MEET = "https://meet.google.com/abc-defg-hij";
const ZOOM = "https://zoom.us/j/84512339087";
const NO_STATE = undefined as unknown as State;

function msg(text: string): Memory {
  return { content: { text } } as Memory;
}

function session(over: Partial<MeetingSession>): MeetingSession {
  return {
    id: "sess-a",
    platform: "google_meet",
    meetingUrl: MEET,
    nativeMeetingId: "abc-defg-hij",
    botName: "Eliza Notetaker",
    status: "active",
    requestedAt: 1,
    roomId: "room-a",
    transcriptId: "trans-a",
    participants: [],
    ...over,
  } as MeetingSession;
}

/** The exact core planner path: alias remap, then schema validation. */
function plannerArgs(
  action: Action,
  args: Record<string, unknown>,
): ReturnType<typeof validateToolArgs> {
  return validateToolArgs(action, normalizeParamAliases(action, args));
}

function runtimeWith(
  service: Partial<MeetingService>,
  memories: Record<string, Memory> = {},
): IAgentRuntime {
  return {
    getService: (name: string) => (name === "meetings" ? service : null),
    getMemoryById: async (id: UUID) => memories[id] ?? null,
  } as unknown as IAgentRuntime;
}

const cb = (async () => []) as unknown as HandlerCallback;

describe("JOIN_MEETING planner parameters", () => {
  it("accepts meetingUrl, botName, and language and delivers them to requestJoin", async () => {
    const validation = plannerArgs(joinMeetingAction, {
      meetingUrl: ZOOM,
      botName: "Scribe",
      language: "de",
    });
    expect(validation).toMatchObject({ valid: true, errors: [] });
    expect(validation.args).toEqual({
      meetingUrl: ZOOM,
      botName: "Scribe",
      language: "de",
    });

    const calls: unknown[] = [];
    const runtime = runtimeWith({
      requestJoin: async (input) => {
        calls.push(input);
        return session({
          id: "sess-z",
          platform: "zoom",
          meetingUrl: ZOOM,
          nativeMeetingId: "84512339087",
          botName: "Scribe",
        });
      },
    });
    // The message carries no URL, so the handler can only succeed by reading
    // the planner bag under `options.parameters`.
    const result = await joinMeetingAction.handler(
      runtime,
      msg("join my call and take notes"),
      NO_STATE,
      { parameters: validation.args },
      cb,
    );
    expect(result).toMatchObject({
      success: true,
      data: { sessionId: "sess-z" },
    });
    // The service receives the canonical form of the planner-supplied link.
    expect(calls).toEqual([
      {
        platform: "zoom",
        meetingUrl: parseMeetingUrl(ZOOM)?.meetingUrl,
        botName: "Scribe",
        language: "de",
      },
    ]);
  });

  it("remaps the url alias onto meetingUrl", () => {
    const validation = plannerArgs(joinMeetingAction, { url: MEET });
    expect(validation).toMatchObject({ valid: true, errors: [] });
    expect(validation.args).toEqual({ meetingUrl: MEET });
  });

  it("still rejects an undeclared argument", () => {
    const validation = plannerArgs(joinMeetingAction, {
      meetingUrl: MEET,
      recordingMode: "cloud",
    });
    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual(["Unexpected argument 'recordingMode'"]);
  });
});

describe("LEAVE_MEETING planner parameters", () => {
  it("accepts sessionId and uses it to disambiguate several active meetings", async () => {
    const validation = plannerArgs(leaveMeetingAction, { sessionId: "sess-b" });
    expect(validation).toMatchObject({ valid: true, errors: [] });
    expect(validation.args).toEqual({ sessionId: "sess-b" });

    const stopped: string[] = [];
    const runtime = runtimeWith({
      listSessions: () => [
        session({ id: "sess-a" }),
        session({
          id: "sess-b",
          platform: "zoom",
          meetingUrl: ZOOM,
          nativeMeetingId: "84512339087",
          transcriptId: "trans-b",
        }),
      ],
      stopSession: (id: string) => {
        stopped.push(id);
      },
    });
    const result = await leaveMeetingAction.handler(
      runtime,
      msg("leave that one"),
      NO_STATE,
      { parameters: validation.args },
      cb,
    );
    expect(result).toMatchObject({
      success: true,
      data: { sessionId: "sess-b", transcriptId: "trans-b" },
    });
    expect(stopped).toEqual(["sess-b"]);
  });

  it("remaps the url alias onto meetingUrl for link-based targeting", () => {
    const validation = plannerArgs(leaveMeetingAction, { url: ZOOM });
    expect(validation).toMatchObject({ valid: true, errors: [] });
    expect(validation.args).toEqual({ meetingUrl: ZOOM });
  });

  it("still rejects an undeclared argument", () => {
    const validation = plannerArgs(leaveMeetingAction, { force: true });
    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual(["Unexpected argument 'force'"]);
  });
});

describe("GET_MEETING_TRANSCRIPT planner parameters", () => {
  it("accepts sessionId and reads that session's transcript, not the newest", async () => {
    const validation = plannerArgs(getMeetingTranscriptAction, {
      sessionId: "sess-b",
    });
    expect(validation).toMatchObject({ valid: true, errors: [] });
    expect(validation.args).toEqual({ sessionId: "sess-b" });

    const row = {
      id: "trans-b",
      content: {
        text: "",
        transcript: JSON.stringify({
          id: "trans-b",
          status: "ready",
          segments: [
            {
              id: "seg-1",
              speaker: "Ada",
              text: "Ship it on Friday.",
              startMs: 0,
              endMs: 1200,
            },
          ],
        }),
      },
      metadata: { type: "custom", source: "transcript" },
    } as unknown as Memory;
    const runtime = runtimeWith(
      {
        listSessions: () => [
          session({ id: "sess-a", transcriptId: "trans-a" }),
          session({
            id: "sess-b",
            platform: "zoom",
            meetingUrl: ZOOM,
            nativeMeetingId: "84512339087",
            transcriptId: "trans-b",
          }),
        ],
      },
      { "trans-b": row },
    );
    const result = await getMeetingTranscriptAction.handler(
      runtime,
      msg("show me the transcript"),
      NO_STATE,
      { parameters: validation.args },
      cb,
    );
    expect(result).toMatchObject({
      success: true,
      data: { sessionId: "sess-b", transcriptId: "trans-b" },
    });
    expect(result.text).toContain("Ship it on Friday.");
  });

  it("still rejects an undeclared argument", () => {
    const validation = plannerArgs(getMeetingTranscriptAction, {
      format: "markdown",
    });
    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual(["Unexpected argument 'format'"]);
  });
});
